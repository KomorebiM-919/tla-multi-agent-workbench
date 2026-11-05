// 未发送对话文字的本地存储：与正式 workspace.json、项目恢复稿分开的 conversation-drafts.json。
//
// 每个项目只保留一份最新未发送文字，靠单调递增的 revision 做身份检查：
// 旧请求即使晚到，也不会覆盖更新的文字，更不会让已取消的新建项目“复活”。
// 空字符串是合法值：用户清空输入框后，重开不得恢复旧文字。
// 这里不依赖 Electron，只用真实文件，便于单元测试。
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export const CONVERSATION_SCHEMA_VERSION = 1
export const MAX_CONVERSATION_DRAFTS = 20
export const MAX_CONVERSATION_TEXT_LENGTH = 5000
export const MAX_CONVERSATION_FILE_BYTES = 512 * 1024
export const CONVERSATION_PATH_SEGMENTS = Object.freeze([
  '.local',
  'tla-desktop',
  'conversation-drafts.json',
])

export const CONVERSATION_ERROR_CODES = Object.freeze({
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

export class ConversationError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'ConversationError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
const DOCUMENT_KEYS = Object.freeze(['schemaVersion', 'drafts'])
const ENTRY_KEYS = Object.freeze(['projectId', 'text', 'revision', 'updatedAt'])

function invalid(message) {
  return new ConversationError(CONVERSATION_ERROR_CODES.INVALID_INPUT, message)
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

function validateText(value, field) {
  if (typeof value !== 'string') throw invalid(`${field}必须是字符串`)
  if (FORBIDDEN_CONTROL_CHARACTERS.test(value)) throw invalid(`${field}包含不允许的控制字符`)
  if (value.length > MAX_CONVERSATION_TEXT_LENGTH) {
    throw invalid(
      `${field}不能超过 ${MAX_CONVERSATION_TEXT_LENGTH} 个字符（当前 ${value.length} 个）`,
    )
  }
  return value
}

function validateProjectId(value) {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw invalid(`项目 ID 不合法：${String(value)}（只允许小写字母、数字和连字符，最长 40 字符）`)
  }
  return value
}

function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid('revision 必须是大于 0 的整数')
  }
  return value
}

function validateEntry(value, field) {
  assertPlainObject(value, field)
  assertKnownKeys(value, ENTRY_KEYS, field)
  if (typeof value.updatedAt !== 'string' || value.updatedAt === '') {
    throw invalid(`${field}的 updatedAt 必须是字符串`)
  }
  return {
    projectId: validateProjectId(value.projectId),
    text: validateText(value.text, `${field}的未发送文字`),
    revision: validateRevision(value.revision),
    updatedAt: value.updatedAt,
  }
}

function validateDocument(value) {
  assertPlainObject(value, '未发送文字文件')
  assertKnownKeys(value, DOCUMENT_KEYS, '未发送文字文件')
  if (value.schemaVersion !== CONVERSATION_SCHEMA_VERSION) {
    throw new ConversationError(
      CONVERSATION_ERROR_CODES.UNSUPPORTED_VERSION,
      `不支持的未发送文字版本：${String(value.schemaVersion)}（本版本只接受 ${CONVERSATION_SCHEMA_VERSION}）`,
    )
  }
  if (!Array.isArray(value.drafts)) throw invalid('drafts 必须是数组')
  if (value.drafts.length > MAX_CONVERSATION_DRAFTS) {
    throw invalid(
      `未发送文字条目不能超过 ${MAX_CONVERSATION_DRAFTS} 个（当前 ${value.drafts.length} 个）`,
    )
  }
  const seen = new Set()
  const drafts = value.drafts.map((entry, index) => {
    const validated = validateEntry(entry, `第 ${index + 1} 条未发送文字`)
    if (seen.has(validated.projectId)) {
      throw invalid(`未发送文字的项目 ID 重复：${validated.projectId}`)
    }
    seen.add(validated.projectId)
    return validated
  })
  return { schemaVersion: CONVERSATION_SCHEMA_VERSION, drafts }
}

export function parseConversationText(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new ConversationError(
      CONVERSATION_ERROR_CODES.CORRUPT_FILE,
      '未发送文字文件不是合法的 JSON',
      error,
    )
  }
  return validateDocument(data)
}

/** 源码位置 → conversation-drafts.json：与 workspace.json、recovery.json 同一目录。 */
export function resolveConversationFilePath(desktopRoot) {
  return path.resolve(desktopRoot, '..', ...CONVERSATION_PATH_SEGMENTS)
}

function describeFsError(error) {
  return error?.code ?? error?.message ?? '未知错误'
}

function asReadError(error) {
  return new ConversationError(
    CONVERSATION_ERROR_CODES.READ_FAILED,
    `无法读取未发送文字文件：${describeFsError(error)}`,
    error,
  )
}

/**
 * @param {{filePath: string}} options
 */
export function createConversationStore({ filePath }) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('filePath 必须是非空字符串')
  }
  const resolvedPath = path.resolve(filePath)

  let loadError = null
  let loadedOnce = false
  let queue = Promise.resolve()
  // 已取消项目的水位线：只活在本次进程内。进程重启后文件条目本身已删除，
  // 迟到的旧请求也随旧进程一起消失。
  const discardedRevisions = new Map()

  async function readDocument() {
    let stats
    try {
      stats = await stat(resolvedPath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          document: { schemaVersion: CONVERSATION_SCHEMA_VERSION, drafts: [] },
          savedAt: null,
        }
      }
      throw asReadError(error)
    }
    if (!stats.isFile()) {
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.READ_FAILED,
        '未发送文字路径不是普通文件',
      )
    }
    if (stats.size > MAX_CONVERSATION_FILE_BYTES) {
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.TOO_LARGE,
        `未发送文字文件超过 ${MAX_CONVERSATION_FILE_BYTES} 字节上限（当前 ${stats.size} 字节）`,
      )
    }
    let text
    try {
      text = await readFile(resolvedPath, 'utf8')
    } catch (error) {
      throw asReadError(error)
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CONVERSATION_FILE_BYTES) {
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.TOO_LARGE,
        `未发送文字文件超过 ${MAX_CONVERSATION_FILE_BYTES} 字节上限`,
      )
    }
    return { document: parseConversationText(text), savedAt: stats.mtime.toISOString() }
  }

  async function load() {
    try {
      const { document, savedAt } = await readDocument()
      loadError = null
      loadedOnce = true
      return { drafts: document.drafts, source: savedAt ? 'file' : 'empty', savedAt }
    } catch (error) {
      loadError = error instanceof ConversationError ? error : asReadError(error)
      loadedOnce = true
      throw loadError
    }
  }

  function assertUsable() {
    if (!loadError) return
    throw new ConversationError(
      CONVERSATION_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
      `未发送文字文件读取失败（${loadError.code}），已停止写入以免覆盖原文件`,
      loadError,
    )
  }

  async function writeDocument(document) {
    const payload = `${JSON.stringify(document, null, 2)}\n`
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (payloadBytes > MAX_CONVERSATION_FILE_BYTES) {
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.TOO_LARGE,
        `未发送文字内容超过 ${MAX_CONVERSATION_FILE_BYTES} 字节上限（当前 ${payloadBytes} 字节）`,
      )
    }
    const directory = path.dirname(resolvedPath)
    try {
      await mkdir(directory, { recursive: true })
    } catch (error) {
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.WRITE_FAILED,
        `无法创建未发送文字目录：${describeFsError(error)}`,
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
      if (error instanceof ConversationError) throw error
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.WRITE_FAILED,
        `保存未发送文字失败：${describeFsError(error)}`,
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
      loadError = error instanceof ConversationError ? error : asReadError(error)
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
        '磁盘上的未发送文字已损坏或版本不符，已停止写入以免覆盖；请检查该文件后重试',
        loadError,
      )
    }
  }

  async function saveOnce(input) {
    assertPlainObject(input, '未发送文字')
    assertKnownKeys(input, ['projectId', 'text', 'revision'], '未发送文字')
    const projectId = validateProjectId(input.projectId)
    const text = validateText(input.text, '未发送文字')
    const revision = validateRevision(input.revision)

    const blocked = discardedRevisions.get(projectId)
    if (blocked !== undefined && revision <= blocked) {
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.DISCARDED,
        '该项目已取消，迟到的未发送文字不再写入',
      )
    }

    await assertExistingFileIntact()
    const { document } = await readDocument()
    const existing = document.drafts.find((entry) => entry.projectId === projectId)
    if (existing && existing.revision >= revision) {
      throw new ConversationError(
        CONVERSATION_ERROR_CODES.STALE_SNAPSHOT,
        `未发送文字版本过期（磁盘 ${existing.revision}，请求 ${revision}）`,
      )
    }
    if (!existing && document.drafts.length >= MAX_CONVERSATION_DRAFTS) {
      throw invalid(
        `未发送文字已满 ${MAX_CONVERSATION_DRAFTS} 个项目，不能静默挤掉旧内容；请先处理已有条目`,
      )
    }

    const entry = { projectId, text, revision, updatedAt: new Date().toISOString() }
    const drafts = existing
      ? document.drafts.map((item) => (item.projectId === projectId ? entry : item))
      : [...document.drafts, entry]
    await writeDocument({ schemaVersion: CONVERSATION_SCHEMA_VERSION, drafts })
    return { entry }
  }

  async function discardOnce(input) {
    assertPlainObject(input, '放弃请求')
    assertKnownKeys(input, ['projectId', 'revision'], '放弃请求')
    const projectId = validateProjectId(input.projectId)
    const revision = validateRevision(input.revision)

    await assertExistingFileIntact()
    const { document } = await readDocument()
    const existing = document.drafts.find((entry) => entry.projectId === projectId)
    const watermark = Math.max(
      discardedRevisions.get(projectId) ?? 0,
      revision,
      existing?.revision ?? 0,
    )
    discardedRevisions.set(projectId, watermark)
    if (!existing) return { removed: false }

    await writeDocument({
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      drafts: document.drafts.filter((entry) => entry.projectId !== projectId),
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
      return Promise.reject(invalid('未发送文字无法读取'))
    }
    return enqueue(() => saveOnce(snapshot))
  }

  function discard(input) {
    return enqueue(() => discardOnce(input))
  }

  return Object.freeze({ filePath: resolvedPath, load, save, discard })
}
