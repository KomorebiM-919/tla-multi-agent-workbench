// 恢复稿存储：与正式 workspace.json 分开的 recovery.json。
//
// 每个项目只保留一份最新快照，靠单调递增的 revision 做身份检查：
// 旧请求即使晚到，也不会覆盖更新的草稿，更不会让已放弃 / 已取消的项目“复活”。
// 这里同样不依赖 Electron，只用真实文件，便于单元测试。
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export const RECOVERY_SCHEMA_VERSION = 1
export const MAX_RECOVERY_ENTRIES = 20
export const MAX_NAME_LENGTH = 60
export const MAX_DESCRIPTION_LENGTH = 500
export const MAX_TASK_DRAFT_LENGTH = 5000
export const MAX_FILE_BYTES = 512 * 1024
export const RECOVERY_PATH_SEGMENTS = Object.freeze(['.local', 'tla-desktop', 'recovery.json'])

export const RECOVERY_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  CORRUPT_FILE: 'CORRUPT_FILE',
  TOO_LARGE: 'TOO_LARGE',
  READ_FAILED: 'READ_FAILED',
  WRITE_FAILED: 'WRITE_FAILED',
  BLOCKED_BY_LOAD_ERROR: 'BLOCKED_BY_LOAD_ERROR',
  STALE_SNAPSHOT: 'STALE_SNAPSHOT',
  DISCARDED: 'DISCARDED',
})

export class RecoveryError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'RecoveryError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
const DOCUMENT_KEYS = Object.freeze(['schemaVersion', 'projects'])
const ENTRY_KEYS = Object.freeze(['id', 'name', 'description', 'taskDraft', 'revision', 'updatedAt'])

function invalid(message) {
  return new RecoveryError(RECOVERY_ERROR_CODES.INVALID_INPUT, message)
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

function validateText(value, { field, maxLength, singleLine = false }) {
  if (typeof value !== 'string') throw invalid(`${field}必须是字符串`)
  if (FORBIDDEN_CONTROL_CHARACTERS.test(value)) throw invalid(`${field}包含不允许的控制字符`)
  if (singleLine && /[\r\n\t]/.test(value)) throw invalid(`${field}不能包含换行或制表符`)
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

function validateRevision(value, field = 'revision') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${field} 必须是大于 0 的整数`)
  }
  return value
}

/** 恢复稿允许暂时空名称（用户正在清空重填），但长度与控制字符仍按正式规则校验。 */
function validateSnapshotFields(project, field) {
  assertPlainObject(project, field)
  return {
    id: validateProjectId(project.id),
    name: validateText(project.name, {
      field: `${field}的项目名称`,
      maxLength: MAX_NAME_LENGTH,
      singleLine: true,
    }),
    description: validateText(project.description, {
      field: `${field}的项目简介`,
      maxLength: MAX_DESCRIPTION_LENGTH,
    }),
    taskDraft: validateText(project.taskDraft, {
      field: `${field}的任务草稿`,
      maxLength: MAX_TASK_DRAFT_LENGTH,
    }),
  }
}

function validateEntry(value, field) {
  assertPlainObject(value, field)
  assertKnownKeys(value, ENTRY_KEYS, field)
  const fields = validateSnapshotFields(value, field)
  if (typeof value.updatedAt !== 'string' || value.updatedAt === '') {
    throw invalid(`${field}的 updatedAt 必须是字符串`)
  }
  return { ...fields, revision: validateRevision(value.revision), updatedAt: value.updatedAt }
}

function validateDocument(value) {
  assertPlainObject(value, '恢复稿文件')
  assertKnownKeys(value, DOCUMENT_KEYS, '恢复稿文件')
  if (value.schemaVersion !== RECOVERY_SCHEMA_VERSION) {
    throw new RecoveryError(
      RECOVERY_ERROR_CODES.UNSUPPORTED_VERSION,
      `不支持的恢复稿版本：${String(value.schemaVersion)}（本版本只接受 ${RECOVERY_SCHEMA_VERSION}）`,
    )
  }
  if (!Array.isArray(value.projects)) throw invalid('projects 必须是数组')
  if (value.projects.length > MAX_RECOVERY_ENTRIES) {
    throw invalid(`恢复稿条目不能超过 ${MAX_RECOVERY_ENTRIES} 个（当前 ${value.projects.length} 个）`)
  }
  const seen = new Set()
  const projects = value.projects.map((entry, index) => {
    const validated = validateEntry(entry, `第 ${index + 1} 个恢复稿`)
    if (seen.has(validated.id)) throw invalid(`恢复稿项目 ID 重复：${validated.id}`)
    seen.add(validated.id)
    return validated
  })
  return { schemaVersion: RECOVERY_SCHEMA_VERSION, projects }
}

export function parseRecoveryText(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new RecoveryError(RECOVERY_ERROR_CODES.CORRUPT_FILE, '恢复稿文件不是合法的 JSON', error)
  }
  return validateDocument(data)
}

/** 源码位置 → recovery.json：与 workspace.json 同一目录。 */
export function resolveRecoveryFilePath(desktopRoot) {
  return path.resolve(desktopRoot, '..', ...RECOVERY_PATH_SEGMENTS)
}

function describeFsError(error) {
  return error?.code ?? error?.message ?? '未知错误'
}

function asReadError(error) {
  return new RecoveryError(
    RECOVERY_ERROR_CODES.READ_FAILED,
    `无法读取恢复稿文件：${describeFsError(error)}`,
    error,
  )
}

function pickSnapshot(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    taskDraft: project.taskDraft,
  }
}

/**
 * @param {{filePath: string}} options
 */
export function createRecoveryStore({ filePath }) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('filePath 必须是非空字符串')
  }
  const resolvedPath = path.resolve(filePath)

  let loadError = null
  let loadedOnce = false
  let queue = Promise.resolve()
  // 已放弃 / 已取消项目的水位线：只活在本次进程内。进程重启后恢复稿文件本身已删除，
  // 迟到的旧请求也随旧进程一起消失。
  const discardedRevisions = new Map()

  async function readDocument() {
    let stats
    try {
      stats = await stat(resolvedPath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { document: { schemaVersion: RECOVERY_SCHEMA_VERSION, projects: [] }, savedAt: null }
      }
      throw asReadError(error)
    }
    if (!stats.isFile()) {
      throw new RecoveryError(RECOVERY_ERROR_CODES.READ_FAILED, '恢复稿路径不是普通文件')
    }
    if (stats.size > MAX_FILE_BYTES) {
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.TOO_LARGE,
        `恢复稿文件超过 ${MAX_FILE_BYTES} 字节上限（当前 ${stats.size} 字节）`,
      )
    }
    let text
    try {
      text = await readFile(resolvedPath, 'utf8')
    } catch (error) {
      throw asReadError(error)
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.TOO_LARGE,
        `恢复稿文件超过 ${MAX_FILE_BYTES} 字节上限`,
      )
    }
    return { document: parseRecoveryText(text), savedAt: stats.mtime.toISOString() }
  }

  async function load() {
    try {
      const { document, savedAt } = await readDocument()
      loadError = null
      loadedOnce = true
      return { entries: document.projects, source: savedAt ? 'file' : 'empty', savedAt }
    } catch (error) {
      loadError = error instanceof RecoveryError ? error : asReadError(error)
      loadedOnce = true
      throw loadError
    }
  }

  function assertUsable() {
    if (!loadError) return
    throw new RecoveryError(
      RECOVERY_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
      `恢复稿文件读取失败（${loadError.code}），已停止写入以免覆盖原文件`,
      loadError,
    )
  }

  async function writeDocument(document) {
    const payload = `${JSON.stringify(document, null, 2)}\n`
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (payloadBytes > MAX_FILE_BYTES) {
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.TOO_LARGE,
        `恢复稿内容超过 ${MAX_FILE_BYTES} 字节上限（当前 ${payloadBytes} 字节）`,
      )
    }
    const directory = path.dirname(resolvedPath)
    try {
      await mkdir(directory, { recursive: true })
    } catch (error) {
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.WRITE_FAILED,
        `无法创建恢复稿目录：${describeFsError(error)}`,
        error,
      )
    }

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
      if (error instanceof RecoveryError) throw error
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.WRITE_FAILED,
        `保存恢复稿失败：${describeFsError(error)}`,
        error,
      )
    } finally {
      if (handle) await handle.close().catch(() => {})
      await rm(tempPath, { force: true }).catch(() => {})
    }
    loadError = null
    loadedOnce = true
  }

  // 覆盖前复验旧文件：外部把文件改坏时宁可拒绝写入，也不静默重置。
  async function assertExistingFileIntact() {
    if (!loadedOnce) await load().catch(() => {})
    assertUsable()
    try {
      await readDocument()
    } catch (error) {
      loadError = error instanceof RecoveryError ? error : asReadError(error)
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
        '磁盘上的恢复稿已损坏或版本不符，已停止写入以免覆盖；请检查该文件后重试',
        loadError,
      )
    }
  }

  async function saveOnce(input) {
    assertPlainObject(input, '恢复稿快照')
    assertKnownKeys(input, ['id', 'name', 'description', 'taskDraft', 'revision'], '恢复稿快照')
    const fields = validateSnapshotFields(input, '恢复稿')
    const revision = validateRevision(input.revision)

    const blocked = discardedRevisions.get(fields.id)
    if (blocked !== undefined && revision <= blocked) {
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.DISCARDED,
        '该项目已放弃或取消，迟到的恢复稿不再写入',
      )
    }

    await assertExistingFileIntact()
    const { document } = await readDocument()
    const existing = document.projects.find((entry) => entry.id === fields.id)
    if (existing && existing.revision >= revision) {
      throw new RecoveryError(
        RECOVERY_ERROR_CODES.STALE_SNAPSHOT,
        `恢复稿版本过期（磁盘 ${existing.revision}，请求 ${revision}）`,
      )
    }

    const entry = { ...fields, revision, updatedAt: new Date().toISOString() }
    const projects = existing
      ? document.projects.map((item) => (item.id === fields.id ? entry : item))
      : [...document.projects, entry]
    await writeDocument({ schemaVersion: RECOVERY_SCHEMA_VERSION, projects })
    return { entry }
  }

  async function discardOnce(input) {
    assertPlainObject(input, '放弃请求')
    assertKnownKeys(input, ['projectId', 'revision'], '放弃请求')
    const projectId = validateProjectId(input.projectId)
    const revision = validateRevision(input.revision)

    await assertExistingFileIntact()
    const { document } = await readDocument()
    const existing = document.projects.find((entry) => entry.id === projectId)
    const watermark = Math.max(discardedRevisions.get(projectId) ?? 0, revision, existing?.revision ?? 0)
    discardedRevisions.set(projectId, watermark)
    if (!existing) return { removed: false }

    await writeDocument({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      projects: document.projects.filter((entry) => entry.id !== projectId),
    })
    return { removed: true }
  }

  function enqueue(run) {
    const result = queue.then(run, run)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function save(input) {
    let snapshot
    try {
      snapshot = structuredClone(input)
    } catch {
      return Promise.reject(invalid('恢复稿快照无法读取'))
    }
    return enqueue(() => saveOnce(snapshot))
  }

  function discard(input) {
    return enqueue(() => discardOnce(input))
  }

  return Object.freeze({ filePath: resolvedPath, load, save, discard })
}
