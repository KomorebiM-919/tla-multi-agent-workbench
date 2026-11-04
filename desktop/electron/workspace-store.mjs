// 本地工作区存储：只负责“一份 JSON 文件”的读取、校验与原子保存。
//
// 这里刻意不引入 Electron：主进程只把文件路径传进来，其余逻辑用普通 Node 文件
// API 完成，因此可以用真实文件在单元测试里验证。错误一律用 WorkspaceError 抛出，
// 并带稳定的 code，渲染层据此区分“输入不合法 / 文件损坏 / 拒绝覆盖 / 读写失败”。
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export const SCHEMA_VERSION = 1
export const MAX_PROJECTS = 20
export const MAX_NAME_LENGTH = 60
export const MAX_DESCRIPTION_LENGTH = 500
export const MAX_TASK_DRAFT_LENGTH = 5000
// 20 个项目 × 全中文 5000 字草稿的最坏情况约 340 KB，512 KiB 留出 JSON 转义余量。
export const MAX_FILE_BYTES = 512 * 1024
export const DEFAULT_PROJECT_ID = 'default-project'
export const DEFAULT_PROJECT_NAME = '我的第一个项目'
export const WORKSPACE_PATH_SEGMENTS = Object.freeze(['.local', 'tla-desktop', 'workspace.json'])

export const WORKSPACE_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  CORRUPT_FILE: 'CORRUPT_FILE',
  TOO_LARGE: 'TOO_LARGE',
  READ_FAILED: 'READ_FAILED',
  WRITE_FAILED: 'WRITE_FAILED',
  BLOCKED_BY_LOAD_ERROR: 'BLOCKED_BY_LOAD_ERROR',
})

export class WorkspaceError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

// 允许换行与制表符（草稿要保真中文与换行），其余控制字符一律拒绝。
const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

const TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'activeProjectId', 'projects'])
const PROJECT_KEYS = Object.freeze(['id', 'name', 'description', 'taskDraft'])

function invalid(message) {
  return new WorkspaceError(WORKSPACE_ERROR_CODES.INVALID_INPUT, message)
}

function assertPlainObject(value, field) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${field}必须是对象`)
  }
}

function assertKnownKeys(value, allowedKeys, field) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw invalid(`${field}包含未知字段：${key}`)
  }
}

function validateText(value, { field, maxLength, allowEmpty = false, singleLine = false }) {
  if (typeof value !== 'string') throw invalid(`${field}必须是字符串`)
  if (FORBIDDEN_CONTROL_CHARACTERS.test(value)) throw invalid(`${field}包含不允许的控制字符`)
  if (singleLine && /[\r\n\t]/.test(value)) throw invalid(`${field}不能包含换行或制表符`)
  if (!allowEmpty && value.trim() === '') throw invalid(`${field}不能为空`)
  if (value.length > maxLength) {
    throw invalid(`${field}不能超过 ${maxLength} 个字符（当前 ${value.length} 个）`)
  }
  return value
}

function validateProjectId(value) {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw invalid(`项目 ID 不合法：${String(value)}（只允许小写字母、数字和连字符，最长 40 字符）`)
  }
  return value
}

/** 文件不存在时使用的默认工作区；只返回内存对象，不写盘。 */
export function createDefaultWorkspace() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProjectId: DEFAULT_PROJECT_ID,
    projects: [
      {
        id: DEFAULT_PROJECT_ID,
        name: DEFAULT_PROJECT_NAME,
        description: '',
        taskDraft: '',
      },
    ],
  }
}

/** 校验整份工作区对象；不合法直接抛出，不做截断、补默认值或字段重排以外的修改。 */
export function validateWorkspace(value) {
  assertPlainObject(value, '工作区')
  assertKnownKeys(value, TOP_LEVEL_KEYS, '工作区')

  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new WorkspaceError(
      WORKSPACE_ERROR_CODES.UNSUPPORTED_VERSION,
      `不支持的工作区版本：${String(value.schemaVersion)}（本版本只接受 ${SCHEMA_VERSION}）`,
    )
  }

  if (!Array.isArray(value.projects)) throw invalid('projects 必须是数组')
  if (value.projects.length === 0) throw invalid('至少需要一个项目')
  if (value.projects.length > MAX_PROJECTS) {
    throw invalid(`项目数量不能超过 ${MAX_PROJECTS} 个（当前 ${value.projects.length} 个）`)
  }

  const seenIds = new Set()
  const projects = value.projects.map((project, index) => {
    const field = `第 ${index + 1} 个项目`
    assertPlainObject(project, field)
    assertKnownKeys(project, PROJECT_KEYS, field)

    const id = validateProjectId(project.id)
    if (seenIds.has(id)) throw invalid(`项目 ID 重复：${id}`)
    seenIds.add(id)

    return {
      id,
      name: validateText(project.name, {
        field: '项目名称',
        maxLength: MAX_NAME_LENGTH,
        singleLine: true,
      }),
      description: validateText(project.description, {
        field: '项目简介',
        maxLength: MAX_DESCRIPTION_LENGTH,
        allowEmpty: true,
      }),
      taskDraft: validateText(project.taskDraft, {
        field: '任务草稿',
        maxLength: MAX_TASK_DRAFT_LENGTH,
        allowEmpty: true,
      }),
    }
  })

  const activeProjectId = validateProjectId(value.activeProjectId)
  if (!seenIds.has(activeProjectId)) {
    throw invalid('activeProjectId 必须指向现有项目')
  }

  return { schemaVersion: SCHEMA_VERSION, activeProjectId, projects }
}

/** 解析文件文本：JSON 坏了算 CORRUPT_FILE，结构不对按具体校验错误抛出。 */
export function parseWorkspaceText(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new WorkspaceError(WORKSPACE_ERROR_CODES.CORRUPT_FILE, '工作区文件不是合法的 JSON', error)
  }
  return validateWorkspace(data)
}

/** 源码位置 → 存储文件路径：<workspace>/.local/tla-desktop/workspace.json。 */
export function resolveWorkspaceFilePath(desktopRoot) {
  return path.resolve(desktopRoot, '..', ...WORKSPACE_PATH_SEGMENTS)
}

function describeFsError(error) {
  return error?.code ?? error?.message ?? '未知错误'
}

function asReadError(error) {
  return new WorkspaceError(
    WORKSPACE_ERROR_CODES.READ_FAILED,
    `无法读取工作区文件：${describeFsError(error)}`,
    error,
  )
}

/**
 * 创建存储实例。同一个实例内的保存请求串行执行；失败不会留下半成品文件。
 */
export function createWorkspaceStore({ filePath }) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('filePath 必须是非空字符串')
  }
  const resolvedPath = path.resolve(filePath)

  // 本次进程里最近一次读取失败的原因；存在时拒绝一切保存，避免覆盖损坏文件。
  let loadError = null
  let loadedOnce = false
  let queue = Promise.resolve()

  async function readWorkspaceFile() {
    let stats
    try {
      stats = await stat(resolvedPath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { workspace: createDefaultWorkspace(), source: 'default', savedAt: null }
      }
      throw asReadError(error)
    }
    if (!stats.isFile()) {
      throw new WorkspaceError(WORKSPACE_ERROR_CODES.READ_FAILED, '工作区路径不是普通文件')
    }
    if (stats.size > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.TOO_LARGE,
        `工作区文件超过 ${MAX_FILE_BYTES} 字节上限（当前 ${stats.size} 字节）`,
      )
    }

    let text
    try {
      text = await readFile(resolvedPath, 'utf8')
    } catch (error) {
      throw asReadError(error)
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.TOO_LARGE,
        `工作区文件超过 ${MAX_FILE_BYTES} 字节上限`,
      )
    }

    const workspace = parseWorkspaceText(text)
    return { workspace, source: 'file', savedAt: stats.mtime.toISOString() }
  }

  async function load() {
    try {
      const result = await readWorkspaceFile()
      loadError = null
      loadedOnce = true
      return result
    } catch (error) {
      loadError = error instanceof WorkspaceError ? error : asReadError(error)
      loadedOnce = true
      throw loadError
    }
  }

  // 覆盖之前再确认一次磁盘上的旧文件仍可解析：即使加载后文件被外部改坏，
  // 也宁可拒绝保存，也不把损坏内容静默替换掉。
  async function assertExistingFileIntact() {
    if (loadError) {
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
        `工作区文件读取失败（${loadError.code}），已停止保存以免覆盖原文件`,
        loadError,
      )
    }

    let stats
    try {
      stats = await stat(resolvedPath)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw asReadError(error)
    }
    if (!stats.isFile()) {
      throw new WorkspaceError(WORKSPACE_ERROR_CODES.READ_FAILED, '工作区路径不是普通文件')
    }
    if (stats.size > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.TOO_LARGE,
        `现有工作区文件超过 ${MAX_FILE_BYTES} 字节上限，已停止保存`,
      )
    }

    let text
    try {
      text = await readFile(resolvedPath, 'utf8')
    } catch (error) {
      throw asReadError(error)
    }
    try {
      parseWorkspaceText(text)
    } catch (error) {
      loadError = error instanceof WorkspaceError ? error : asReadError(error)
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
        '磁盘上的工作区文件已损坏或版本不符，已停止保存以免覆盖；请修复或移走该文件后重试',
        loadError,
      )
    }
  }

  async function saveOnce(input) {
    const workspace = validateWorkspace(input)

    // 没有先读就写：先读一次，让“文件损坏时禁止覆盖”的规则同样生效。
    if (!loadedOnce) await load().catch(() => {})
    await assertExistingFileIntact()

    const payload = `${JSON.stringify(workspace, null, 2)}\n`
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (payloadBytes > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.TOO_LARGE,
        `保存内容超过 ${MAX_FILE_BYTES} 字节上限（当前 ${payloadBytes} 字节）`,
      )
    }

    const directory = path.dirname(resolvedPath)
    try {
      await mkdir(directory, { recursive: true })
    } catch (error) {
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.WRITE_FAILED,
        `无法创建工作区目录：${describeFsError(error)}`,
        error,
      )
    }

    // 临时文件与目标同目录、名字唯一；最后用 rename 替换，绝不先删除旧文件。
    const tempPath = path.join(
      directory,
      `.${path.basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let handle = null
    try {
      handle = await open(tempPath, 'wx', 0o600)
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(tempPath, resolvedPath)
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      throw new WorkspaceError(
        WORKSPACE_ERROR_CODES.WRITE_FAILED,
        `保存工作区失败：${describeFsError(error)}`,
        error,
      )
    } finally {
      if (handle) {
        await handle.close().catch(() => {})
      }
      // rename 成功后临时文件已经不在了；失败时只清理本次的临时文件。
      await rm(tempPath, { force: true }).catch(() => {})
    }

    loadError = null
    loadedOnce = true
    return { workspace, savedAt: new Date().toISOString() }
  }

  function save(input) {
    let snapshot
    try {
      snapshot = structuredClone(input)
    } catch (error) {
      return Promise.reject(invalid('保存内容无法读取'))
    }
    const run = () => saveOnce(snapshot)
    const result = queue.then(run, run)
    // 队列本身不继承失败，否则一次保存失败会让后续保存永远拿不到执行机会。
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return Object.freeze({ filePath: resolvedPath, load, save })
}
