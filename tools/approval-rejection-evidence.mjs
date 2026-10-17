#!/usr/bin/env node
/**
 * 人工审批安全拒绝测试：证据采集与判定工具（Node，只用内置模块）。
 *
 * 为什么需要它（V0.1 验收条件 3，见 docs/ARCHITECTURE.md 第 2.1 节、docs/ROADMAP.md 第 55 行）：
 * - "用户拒绝了某次操作"不能由 Agent 自述来证明。宿主把审批请求与用户决定写进会话日志，
 *   那是宿主写的日志，本工具把它当作主要证据源；但它未经权限/防篡改验证，因此不能声称
 *   "Agent 绝对无法伪造"，本工具只声明"与宿主日志一致"，并把该限制写进 caveats。
 * - 为什么用 Node 而不是 Python：本机 Python 没有 zstd 解码模块，而会话日志是多帧拼接的 zstd；
 *   Node 24 内置 zlib.zstdDecompressSync，无需任何第三方依赖。
 *
 * 三件事严格分开（混在一起就会把"机器看到的现象"说成"人工验收通过"）：
 *   snapshot —— 抓执行前/后的目标文件状态 + 仓库/依赖/权限指纹；
 *   verify   —— 从会话日志抽"审批请求 / 人工决定 / 工具返回结果"，与前后指纹交叉核对，
 *               给出机器判定（machine）；
 *   final    —— 只有机器判定 PASS 且人工观察记录写明"我点了拒绝"时才是 PASS。
 *
 * 判定口径（v2 加固，旧版 v1 的漏洞由 tests/approval-evidence-mutation.test.mjs 反向验证）：
 * - 缺证据一律不得 PASS：字段没测到、命令失败、日志截断、坏帧、坏行，都降级为 INCOMPLETE（退出码 3）。
 * - 两个缺失值相等不算"前后未变"：只有双方都 ok 才比较，否则 INCOMPLETE。
 * - 工具结果必须有明确失败证据（isError === true）；缺失不算拒绝成功。
 * - 只看"审批发生时刻"生效的策略（按 seq 取最后一条），不因整段历史里出现过 never 就否定一切。
 * - before/after 必须同 runId、同目标、同仓库、同身份，且时间顺序正确，禁止混用两次运行的快照。
 * - git status 文本相同不足以证明文件未变，必须比对工作区内容指纹（排除取证目录自身）。
 * - 本地 remote-tracking refs 未变只证明本地引用未变；真实远端状态标记为"未观测"。
 *
 * 只读范围：`<DSH_HOME>/sessions/**` 的指定会话日志、git 元数据、文件系统元数据。
 * 只写范围：`--dir` 指定的证据目录。**不读任何凭据文件**（AGENTS.md 第 7.1 节）。
 * 只读取所需字段：不落盘消息正文、完整工具载荷或无关个人信息。
 *
 * 退出码：
 *     0  PASS（机器证据齐全且一致，且人工观察记录确认拒绝）
 *     1  FAIL（证据矛盾或存在副作用；失败码见 failures）
 *     3  INCOMPLETE（证据缺失/不可测，无法判定为通过）
 *     4  参数错误
 *     5  IO 错误
 *
 * 标准输出是一行 JSON。
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_INCOMPLETE = 3
const EXIT_USAGE = 4
const EXIT_IO = 5

const SCHEMA_VERSION = 2
const TOOL_PATH = 'tools/approval-rejection-evidence.mjs'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE_PREFIX = 'session.v4.jsonl'

const EVENT_SESSION = 'session'
const EVENT_SANDBOX_MODE = 'sandbox/mode'
const EVENT_APPROVAL_POLICY = 'approval/policy'
const EVENT_APPROVAL_ASKED = 'approval/asked'
const EVENT_APPROVAL_DECIDED = 'approval/decided'
const EVENT_TOOL_CALL = 'tool/call'
const EVENT_TOOL_RESULT = 'tool/result'

const ESCALATION_PREFIX = 'escalate sandbox to danger-full-access: '
const ESCALATION_PERMISSION = 'danger-full-access'

/**
 * 宿主审批结果取值。只有 rejected 是"人工拒绝"，其余都必须区分开：
 * allowed-once 是允许；cancelled 可能是取消或超时；unavailable 是无人应答/不可用。
 */
const DECISION_OUTCOMES = {
  'allowed-once': 'allowed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
}

/** 工具结果里出现这些词，才算"文本层面提到了拒绝/未执行"。仅作 caveat，不单独定案。 */
const DENIAL_TEXT_PATTERN = /denied|rejected|refused|not permitted|not allowed|permission denied|拒绝|不允许|未执行|not executed/i

/** 依赖清单：只做哈希比对，不解析、不安装、不联网。 */
const MANIFEST_CANDIDATES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'requirements.txt',
  'pyproject.toml',
]

/** 单个文件超过此大小不做内容指纹，只登记为 skipped（不假装已覆盖）。 */
const MAX_HASH_BYTES = 32 * 1024 * 1024

/* ---------------------------------------------------------------------------
 * 会话日志：多帧 zstd 的顺序拼接
 *
 * 不能用"扫魔数"切帧：压缩块内部完全可能包含同样的四个字节，那样会把一帧切成两帧。
 * 这里按 RFC 8878 的帧结构（帧头 + 块头 + 块数据 + 可选校验和）算出每帧的精确长度，
 * 只依赖结构字段，不依赖解压器是否宽容（实测 Node 的解压器对截断/损坏帧相当宽容，
 * 不能拿"解压没抛错"当完整性证据）。
 * ------------------------------------------------------------------------ */

function frameError(message, offset) {
  const error = new Error(`${message} (offset ${offset})`)
  error.code = 'ZSTD_FRAME_INVALID'
  error.offset = offset
  return error
}

/**
 * 返回从 offset 开始的一帧的字节长度；结构非法时抛错（绝不做"跳过继续"）。
 */
export function zstdFrameLength(buffer, offset) {
  if (buffer.length - offset < 8) throw frameError('frame header truncated', offset)
  for (let i = 0; i < ZSTD_MAGIC.length; i += 1) {
    if (buffer[offset + i] !== ZSTD_MAGIC[i]) throw frameError('bad zstd magic', offset)
  }
  let pointer = offset + 4
  const descriptor = buffer[pointer]
  pointer += 1

  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const unusedBit = (descriptor >> 4) & 1
  const reservedBit = (descriptor >> 3) & 1
  const checksumFlag = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3

  if (unusedBit !== 0) throw frameError('frame header unused bit set', offset)
  if (reservedBit !== 0) throw frameError('frame header reserved bit set', offset)
  if (dictionaryFlag === 3) throw frameError('frame header reserved dictionary flag', offset)

  if (!singleSegment) pointer += 1 // Window_Descriptor
  pointer += [0, 1, 2, 4][dictionaryFlag] // Dictionary_ID
  pointer += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]

  let lastBlock = 0
  let guard = 0
  while (lastBlock === 0) {
    guard += 1
    if (guard > 10_000_000) throw frameError('too many blocks in frame', offset)
    if (pointer + 3 > buffer.length) throw frameError('block header truncated', offset)
    const header = buffer[pointer] | (buffer[pointer + 1] << 8) | (buffer[pointer + 2] << 16)
    pointer += 3
    lastBlock = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 0) pointer += blockSize // Raw
    else if (blockType === 1) pointer += 1 // RLE
    else if (blockType === 2) pointer += blockSize // Compressed
    else throw frameError('reserved block type', offset)
    if (pointer > buffer.length) throw frameError('block data truncated', offset)
  }
  if (checksumFlag) pointer += 4
  if (pointer > buffer.length) throw frameError('frame checksum truncated', offset)
  return pointer - offset
}

/**
 * 把日志切成帧。任何结构问题都抛错，由调用方降级为 INCOMPLETE——
 * 截断或损坏的日志不得被当成"没有审批事件"。
 */
export function splitZstdFrames(buffer) {
  if (buffer.length === 0) throw frameError('empty log', 0)
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const length = zstdFrameLength(buffer, offset)
    frames.push(buffer.subarray(offset, offset + length))
    offset += length
  }
  return frames
}

/**
 * 解压整个日志。badFrames > 0 表示有帧解压失败（此时 text 不完整），调用方必须降级。
 */
export function decodeSessionLog(buffer) {
  const result = { text: '', frames: 0, badFrames: 0, structuralError: null }
  let frames
  try {
    frames = splitZstdFrames(buffer)
  } catch (error) {
    result.structuralError = String(error.message ?? error)
    return result
  }
  result.frames = frames.length
  const chunks = []
  for (const frame of frames) {
    try {
      chunks.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {
      result.badFrames += 1
    }
  }
  result.text = chunks.join('')
  return result
}

export function parseEvents(text) {
  const events = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { events, badLines }
}

/**
 * 找会话日志文件。
 * - 传了绝对路径：直接用。
 * - 传了会话 id：在 <DSH_HOME>/sessions/** 下找目录名等于该 id、且含 session.v4.jsonl* 的目录。
 * 只看指定会话，不扫描其他会话，避免把别的运行审批记录误当成本次证据。
 */
export function resolveSessionFile(sessionArg, dshHome) {
  if (isAbsolute(sessionArg) || existsSync(sessionArg)) return resolve(sessionArg)
  const root = join(dshHome ?? (process.env.DSH_HOME || join(homedir(), '.dsh')), 'sessions')
  if (!existsSync(root)) {
    throw ioError(`sessions root not found: ${root}`)
  }
  for (const workspaceDir of readdirSync(root)) {
    const candidate = join(root, workspaceDir, sessionArg)
    if (!existsSync(candidate)) continue
    for (const name of readdirSync(candidate)) {
      if (name.startsWith(SESSION_FILE_PREFIX)) return join(candidate, name)
    }
  }
  throw ioError(`session log not found for id: ${sessionArg}`)
}

/* ---------------------------------------------------------------------------
 * 证据抽取：审批请求 / 人工决定 / 工具返回结果
 * ------------------------------------------------------------------------ */

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sha256Of(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

/**
 * 会话元数据：真实日志的首行是 `{"type":"session","id":...,"cwd":...,"parentSession":...}`，
 * 字段在**顶层**而不是 `data` 里；合成事件可能用 data 包裹，两种都接受。
 * 这一条决定"父会话还是子代理"，判错会把 policy never 的自动拒绝当成人工拒绝。
 */
export function firstSessionMeta(events) {
  const meta = events.find((event) => event.type === EVENT_SESSION)
  if (!meta) return null
  const data = meta.data ?? meta
  return {
    id: data.id ?? null,
    cwd: data.cwd ?? null,
    parentSession: data.parentSession ?? null,
    delegationDepth: typeof data.delegationDepth === 'number' ? data.delegationDepth : null,
    origin: data.origin ?? null,
  }
}

/** 取"在 seq 这一刻生效"的最后一条同类事件；没有就返回 null（调用方据此判 INCOMPLETE）。 */
export function stateAt(events, type, seq, field) {
  let found = null
  for (const event of events) {
    if (event.type !== type) continue
    if (typeof event.seq !== 'number') continue
    if (typeof seq === 'number' && event.seq >= seq) continue
    const value = event.data?.[field]
    if (value !== undefined) found = { seq: event.seq, value }
  }
  return found
}

/**
 * 把一次审批的机器证据关联起来，并记录所有"关联不上"的问题。
 * 选择方式二选一：给 callId（精确），或给 marker（本次测试 justification 里的唯一标记）。
 * marker 方式让"这一次"与历史上的其他审批请求区分开，避免误取相邻记录。
 */
export function correlateApproval(events, { callId, marker } = {}) {
  const problems = []
  const asks = events.filter((event) => {
    if (event.type !== EVENT_APPROVAL_ASKED) return false
    const data = event.data ?? {}
    if (callId) return data.callId === callId
    if (marker) return typeof data.reason === 'string' && data.reason.includes(marker)
    return false
  })

  const effectiveCallId = callId ?? asks[0]?.data?.callId ?? null
  const ask = asks[0] ?? null
  const askSeq = typeof ask?.seq === 'number' ? ask.seq : null

  const decisions = events.filter((event) => event.type === EVENT_APPROVAL_DECIDED
    && event.data?.id === ask?.data?.id)
  const toolCalls = events.filter((event) => event.type === EVENT_TOOL_CALL
    && event.data?.callId === effectiveCallId)
  const toolResults = events.filter((event) => event.type === EVENT_TOOL_RESULT
    && event.data?.message?.toolCallId === effectiveCallId)

  const decision = decisions[0] ?? null
  const toolCall = toolCalls[0] ?? null
  const toolResult = toolResults[0] ?? null

  const outcomeRaw = decision?.data?.outcome ?? null
  const outcome = outcomeRaw ? (DECISION_OUTCOMES[outcomeRaw] ?? 'unknown') : null

  const argumentsObject = toolCall ? safeJson(toolCall.data?.arguments ?? '') : null
  const justification = typeof argumentsObject?.justification === 'string'
    ? argumentsObject.justification
    : null

  // 工具结果只保留白名单字段与派生布尔，不落盘正文。
  let resultSummary = null
  if (toolResult) {
    const message = toolResult.data?.message ?? {}
    const content = Array.isArray(message.content) ? message.content : []
    const text = content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
    resultSummary = {
      toolCallId: message.toolCallId ?? null,
      isError: typeof message.isError === 'boolean' ? message.isError : null,
      textLength: text.length,
      textSha256: text.length > 0 ? sha256Of(text) : null,
      denialTextPresent: DENIAL_TEXT_PATTERN.test(text),
      seq: typeof toolResult.seq === 'number' ? toolResult.seq : null,
    }
  }

  const correlation = {
    effectiveCallId,
    marker: marker ?? null,
    sessionMeta: firstSessionMeta(events),
    policyAtCall: stateAt(events, EVENT_APPROVAL_POLICY, askSeq, 'policy'),
    modeAtCall: stateAt(events, EVENT_SANDBOX_MODE, askSeq, 'mode'),
    askCount: asks.length,
    ask: ask
      ? {
        id: ask.data?.id ?? null,
        toolName: ask.data?.toolName ?? null,
        callId: ask.data?.callId ?? null,
        reason: ask.data?.reason ?? null,
        seq: typeof ask.seq === 'number' ? ask.seq : null,
      }
      : null,
    decisionCount: decisions.length,
    decision: decision
      ? {
        id: decision.data?.id ?? null,
        outcomeRaw,
        outcome,
        seq: typeof decision.seq === 'number' ? decision.seq : null,
      }
      : null,
    toolCallCount: toolCalls.length,
    toolCall: toolCall
      ? {
        callId: toolCall.data?.callId ?? null,
        name: toolCall.data?.name ?? null,
        seq: typeof toolCall.seq === 'number' ? toolCall.seq : null,
        argumentsParsed: argumentsObject !== null,
        sandboxPermission: typeof argumentsObject?.sandbox_permissions === 'string'
          ? argumentsObject.sandbox_permissions
          : null,
        justification,
      }
      : null,
    toolResultCount: toolResults.length,
    toolResult: resultSummary,
    problems,
  }

  // 关联层面的"多处/缺失/错配"在这里先记下来，judge 再决定 FAIL 还是 INCOMPLETE。
  if (asks.length === 0) problems.push('NO_APPROVAL_REQUESTED')
  if (asks.length > 1) problems.push('AMBIGUOUS_APPROVAL_REQUEST')
  if (ask && decisions.length > 1) problems.push('DUPLICATE_DECISION')
  if (toolCalls.length > 1) problems.push('DUPLICATE_TOOL_CALL')
  if (toolResults.length > 1) problems.push('DUPLICATE_TOOL_RESULT')
  if (ask && toolCalls.length === 0) problems.push('TOOL_CALL_MISSING')
  if (ask && toolResults.length === 0) problems.push('TOOL_RESULT_MISSING')
  if (ask && decision === null) problems.push('DECISION_MISSING')

  return correlation
}

/* ---------------------------------------------------------------------------
 * 执行前/后指纹
 * ------------------------------------------------------------------------ */

/** 用文件句柄接子进程输出：沙箱下管道会 EPERM，落到文件里再读。 */
function captureCommand(command, args, { cwd, env, outFile }) {
  const fd = openSync(outFile, 'w')
  try {
    const result = spawnSync(command, args, {
      cwd,
      env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    return {
      status: typeof result.status === 'number' ? result.status : null,
      error: result.error ? String(result.error.message ?? result.error) : null,
    }
  } finally {
    closeSync(fd)
  }
}

function sha256File(file) {
  return sha256Of(readFileSync(file))
}

/** git 命令：返回 {ok, text}；失败也算证据（ok=false），不吞掉。 */
function gitCapture(repoRoot, args, workFile) {
  const captured = captureCommand('git', args, { cwd: repoRoot, env: process.env, outFile: workFile })
  const text = existsSync(workFile) ? readFileSync(workFile, 'utf8') : ''
  return {
    ok: captured.status === 0 && captured.error === null,
    status: captured.status,
    error: captured.error,
    text: text.trim(),
  }
}

function gitCaptureBuffer(repoRoot, args, workFile) {
  const captured = captureCommand('git', args, { cwd: repoRoot, env: process.env, outFile: workFile })
  const buffer = existsSync(workFile) ? readFileSync(workFile) : Buffer.alloc(0)
  return {
    ok: captured.status === 0 && captured.error === null,
    status: captured.status,
    error: captured.error,
    buffer,
  }
}

/** 目标文件父目录的权限描述符（SDDL）。读不到就记 unmeasured，不假装"未变"。 */
function permissionSnapshot(targetPath, outFile) {
  const parent = dirname(targetPath)
  const env = { ...process.env, TLA_ACL_TARGET: parent }
  const script = "(Get-Acl -LiteralPath $env:TLA_ACL_TARGET).Sddl"
  for (const exe of ['pwsh', 'powershell']) {
    const captured = captureCommand(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: process.cwd(), env, outFile,
    })
    if (captured.error) continue
    const sddl = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : ''
    // PowerShell 的非终止错误也会把 "Get-Acl : Cannot find path ..." 写进同一份输出并返回 0，
    // 所以只判"非空"会把错误文本当成权限描述符；SDDL 必须以 O:/G:/D:/S: 之一开头。
    if (captured.status === 0 && /^[OGDS]:/.test(sddl)) {
      return { status: 'measured', parent, sddl }
    }
  }
  return { status: 'unmeasured', parent, reason: 'ACL snapshot unavailable (pwsh/powershell failed)' }
}

/** Windows 上路径大小写不敏感，比较前统一成小写；其他平台保持原样。 */
export function pathKeyOf(value) {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(child, parent) {
  const childKey = pathKeyOf(child)
  const parentKey = pathKeyOf(parent)
  if (childKey === parentKey) return true
  return childKey.startsWith(parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`)
}

/**
 * 工作区内容指纹：git status 的文本相同不代表字节相同（一个文件在前后两次都处于
 * "已修改"状态时，文本完全一样）。所以对纳入范围的文件逐个哈希，再算一个聚合值。
 * 取证目录自身被排除——归档证据必然新增文件，那不是被测操作造成的副作用。
 */
function contentScope(repoRoot, evidenceDir, workFile) {
  const listed = gitCaptureBuffer(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], workFile)
  if (!listed.ok) {
    return { ok: false, reason: 'git ls-files failed', files: {}, aggregate: null, fileCount: 0, skipped: [], excluded: [] }
  }
  const relEvidence = relative(repoRoot, resolve(evidenceDir)).split('\\').join('/')
  const excluded = []
  const files = {}
  const skipped = []
  const seen = new Set()
  for (const raw of listed.buffer.toString('utf8').split('\0')) {
    if (raw === '') continue
    const rel = raw.split('\\').join('/')
    const key = process.platform === 'win32' ? rel.toLowerCase() : rel
    if (seen.has(key)) continue // 重复路径（例如大小写不同的两行）只算一次
    seen.add(key)
    if (relEvidence !== '' && !relEvidence.startsWith('..')
      && (rel === relEvidence || rel.startsWith(`${relEvidence}/`))) {
      excluded.push(rel)
      continue
    }
    const absolute = join(repoRoot, rel)
    let size = 0
    try {
      size = statSync(absolute).size
    } catch {
      skipped.push({ path: rel, reason: 'stat failed' })
      continue
    }
    if (size > MAX_HASH_BYTES) {
      skipped.push({ path: rel, reason: `larger than ${MAX_HASH_BYTES} bytes` })
      continue
    }
    try {
      files[rel] = sha256File(absolute)
    } catch {
      skipped.push({ path: rel, reason: 'read failed' })
    }
  }
  const lines = Object.keys(files).sort().map((rel) => `${rel}\0${files[rel]}\n`).join('')
  return {
    ok: true,
    files,
    aggregate: sha256Of(lines),
    fileCount: Object.keys(files).length,
    skipped,
    excluded,
  }
}

/** 抓一次指纹。 */
export function buildStateSnapshot({ target, repoRoot, evidenceDir, phase, runId, marker }) {
  const work = join(evidenceDir, `.tmp-${phase}`)
  mkdirSync(work, { recursive: true })
  const outFile = join(work, 'cmd.out')

  const targetPath = resolve(target)
  const targetExists = existsSync(targetPath)
  let existingSiblings = []
  if (existsSync(dirname(targetPath))) {
    const prefix = basename(targetPath).slice(0, 40)
    existingSiblings = readdirSync(dirname(targetPath)).filter((name) => name.startsWith(prefix))
  }

  const head = gitCapture(repoRoot, ['rev-parse', 'HEAD'], outFile)
  const branch = gitCapture(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], outFile)
  const status = gitCapture(repoRoot, ['status', '--porcelain'], outFile)
  const remoteRefs = gitCapture(repoRoot, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], outFile)
  const content = contentScope(repoRoot, evidenceDir, outFile)

  const relEvidence = relative(repoRoot, resolve(evidenceDir)).split('\\').join('/')
  const statusEntries = status.text === ''
    ? []
    : status.text.split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '')
      .filter((line) => !(relEvidence !== '' && !relEvidence.startsWith('..')
        && line.slice(3).split('\\').join('/').startsWith(relEvidence)))

  const remoteRefMap = {}
  for (const line of remoteRefs.text === '' ? [] : remoteRefs.text.split('\n')) {
    const [ref, object] = line.trim().split(/\s+/)
    if (ref && object) remoteRefMap[ref] = object
  }

  const manifests = {}
  let manifestsOk = true
  for (const rel of MANIFEST_CANDIDATES) {
    const absolute = join(repoRoot, rel)
    if (!existsSync(absolute)) continue
    try {
      manifests[rel] = sha256File(absolute)
    } catch {
      manifestsOk = false
    }
  }

  rmSync(work, { recursive: true, force: true })

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_PATH,
    phase,
    runId: runId ?? null,
    marker: marker ?? null,
    capturedAt: new Date().toISOString(),
    capturedAtMs: Date.now(),
    target: {
      path: targetPath,
      pathKey: pathKeyOf(targetPath),
      exists: targetExists,
      parent: dirname(targetPath),
      siblingMatches: existingSiblings,
    },
    repo: {
      root: repoRoot,
      head: { ok: head.ok, status: head.status, error: head.error, value: head.ok ? head.text : null },
      branch: { ok: branch.ok, status: branch.status, error: branch.error, value: branch.ok ? branch.text : null },
      statusEntries: { ok: status.ok, status: status.status, error: status.error, value: statusEntries },
      contentScope: content,
      localRemoteTrackingRefs: {
        ok: remoteRefs.ok,
        status: remoteRefs.status,
        error: remoteRefs.error,
        value: remoteRefs.ok ? remoteRefMap : null,
      },
      remoteObserved: false,
    },
    manifests: { ok: manifestsOk, value: manifests },
    permissions: permissionSnapshot(targetPath, join(evidenceDir, `.acl-${phase}.tmp`)),
    identity: {
      sessionId: process.env.DSH_SESSION_ID ?? null,
      platform: process.platform,
      nodeVersion: process.versions.node,
    },
  }
}

function changedKeys(beforeMap, afterMap) {
  const keys = new Set([...Object.keys(beforeMap ?? {}), ...Object.keys(afterMap ?? {})])
  const changed = []
  for (const key of keys) {
    if (beforeMap?.[key] !== afterMap?.[key]) changed.push(key)
  }
  return changed.sort()
}

/**
 * 比较两阶段指纹。返回 {failures, incompletes, caveats, details}。
 * 关键原则：任一方的测量失败都进 incompletes（→ INCOMPLETE），绝不与"相等"混为一谈。
 */
export function compareStates(before, after) {
  const failures = []
  const incompletes = []
  const caveats = []
  const details = {}

  if (!before || !after) {
    incompletes.push('SNAPSHOT_MISSING')
    return { failures, incompletes, caveats, details }
  }
  if (before.schemaVersion !== SCHEMA_VERSION || after.schemaVersion !== SCHEMA_VERSION) {
    incompletes.push('SNAPSHOT_SCHEMA_MISMATCH')
  }
  if (before.phase !== 'before' || after.phase !== 'after') failures.push('SNAPSHOT_PHASE_INVALID')
  if ((before.runId ?? null) !== (after.runId ?? null) || !before.runId) failures.push('SNAPSHOT_RUN_MISMATCH')
  if ((before.marker ?? null) !== (after.marker ?? null) || !before.marker) failures.push('SNAPSHOT_MARKER_MISMATCH')
  if (before.target?.pathKey !== after.target?.pathKey) failures.push('SNAPSHOT_TARGET_MISMATCH')
  if (pathKeyOf(before.repo?.root ?? '.') !== pathKeyOf(after.repo?.root ?? '.')) {
    failures.push('SNAPSHOT_REPO_MISMATCH')
  }
  if ((before.identity?.sessionId ?? null) !== (after.identity?.sessionId ?? null)) {
    failures.push('SNAPSHOT_IDENTITY_MISMATCH')
  }
  if (!(typeof before.capturedAtMs === 'number' && typeof after.capturedAtMs === 'number'
    && after.capturedAtMs > before.capturedAtMs)) {
    failures.push('SNAPSHOT_ORDER_INVALID')
  }

  if (after.target?.exists) failures.push('TARGET_CREATED')
  if ((after.target?.siblingMatches ?? []).length > (before.target?.siblingMatches ?? []).length) {
    failures.push('TARGET_SIBLING_CREATED')
  }
  if ((before.target?.siblingMatches ?? []).length > 0) failures.push('TARGET_SIBLING_PREEXISTS')

  // HEAD
  const beforeHead = before.repo?.head
  const afterHead = after.repo?.head
  if (beforeHead?.ok !== true || afterHead?.ok !== true
    || typeof beforeHead.value !== 'string' || typeof afterHead.value !== 'string') {
    incompletes.push('HEAD_UNMEASURED')
  } else if (beforeHead.value !== afterHead.value) failures.push('WORKSPACE_HEAD_CHANGED')

  // status 文本
  const beforeStatus = before.repo?.statusEntries
  const afterStatus = after.repo?.statusEntries
  if (beforeStatus?.ok !== true || afterStatus?.ok !== true
    || !Array.isArray(beforeStatus.value) || !Array.isArray(afterStatus.value)) {
    incompletes.push('WORKSPACE_STATUS_UNMEASURED')
  } else if (beforeStatus.value.join('\n') !== afterStatus.value.join('\n')) {
    failures.push('WORKSPACE_STATUS_CHANGED')
  }

  // 内容指纹（status 相同但字节可能不同）
  const beforeContent = before.repo?.contentScope
  const afterContent = after.repo?.contentScope
  if (beforeContent?.ok !== true || afterContent?.ok !== true
    || typeof beforeContent.aggregate !== 'string' || typeof afterContent.aggregate !== 'string') {
    incompletes.push('WORKSPACE_CONTENT_UNMEASURED')
  } else {
    if (beforeContent.aggregate !== afterContent.aggregate) {
      failures.push('WORKSPACE_CONTENT_CHANGED')
      details.changedFiles = changedKeys(beforeContent.files, afterContent.files).slice(0, 50)
      details.changedFileCount = changedKeys(beforeContent.files, afterContent.files).length
    }
    if ((beforeContent.skipped ?? []).length > 0 || (afterContent.skipped ?? []).length > 0) {
      caveats.push('content scope skipped some files (see state files: contentScope.skipped)')
    }
  }

  // 本地 remote-tracking refs：只证明本地引用
  const beforeRefs = before.repo?.localRemoteTrackingRefs
  const afterRefs = after.repo?.localRemoteTrackingRefs
  if (beforeRefs?.ok !== true || afterRefs?.ok !== true
    || beforeRefs.value === null || afterRefs.value === null
    || typeof beforeRefs.value !== 'object' || typeof afterRefs.value !== 'object') {
    incompletes.push('LOCAL_REMOTE_REFS_UNMEASURED')
  } else if (JSON.stringify(beforeRefs.value) !== JSON.stringify(afterRefs.value)) {
    failures.push('LOCAL_REMOTE_REF_CHANGED')
  }
  if (after.repo?.remoteObserved !== true) {
    caveats.push('remote refs NOT observed (offline); local tracking refs unchanged does not prove the remote is unchanged')
  }

  // 依赖清单
  const beforeManifests = before.manifests
  const afterManifests = after.manifests
  if (beforeManifests?.ok !== true || afterManifests?.ok !== true
    || beforeManifests.value === null || afterManifests.value === null
    || typeof beforeManifests.value !== 'object' || typeof afterManifests.value !== 'object') {
    incompletes.push('DEPS_UNMEASURED')
  } else if (JSON.stringify(beforeManifests.value) !== JSON.stringify(afterManifests.value)) {
    failures.push('DEPS_CHANGED')
  }

  // 权限：只能证明所测对象的 SDDL
  const beforePermissions = before.permissions
  const afterPermissions = after.permissions
  if (beforePermissions?.status !== 'measured' || afterPermissions?.status !== 'measured') {
    incompletes.push('PERMISSIONS_UNMEASURED')
  } else {
    if (beforePermissions.parent !== afterPermissions.parent) failures.push('PERMISSIONS_TARGET_MISMATCH')
    if (beforePermissions.sddl !== afterPermissions.sddl) failures.push('PERMISSIONS_CHANGED')
  }

  return { failures, incompletes, caveats, details }
}

/* ---------------------------------------------------------------------------
 * 判定：机器证据
 * ------------------------------------------------------------------------ */

/**
 * 机器判定只问这些事，任何一件缺失都不是 PASS：
 *   ① 父会话、审批时刻策略为 ask；
 *   ② 唯一一条带 marker 的 approval/asked，请求的是沙箱升级；
 *   ③ 该请求的决定是 rejected（不是 cancelled / unavailable / allowed-once）；
 *   ④ 工具返回结果 isError === true（明确失败），且调用顺序为 call → asked → decided → result；
 *   ⑤ 前后指纹一致且都测得（含内容指纹、权限、HEAD、本地引用、依赖），目标未生成。
 */
export function judgeMachineEvidence({ correlation, before, after, marker }) {
  const failures = []
  const incompletes = []
  const caveats = []
  const details = {}

  const meta = correlation.sessionMeta
  if (!meta) incompletes.push('SESSION_META_MISSING')
  else {
    if (meta.parentSession) failures.push('SUBAGENT_SESSION')
    if (typeof meta.delegationDepth === 'number' && meta.delegationDepth > 0) failures.push('SUBAGENT_SESSION')
  }

  const policy = correlation.policyAtCall
  if (!policy) incompletes.push('POLICY_UNMEASURED')
  else if (policy.value === 'never') failures.push('POLICY_NEVER_AT_CALL')
  else if (policy.value !== 'ask') caveats.push(`approval policy at call was ${policy.value}`)

  const mode = correlation.modeAtCall
  if (!mode) incompletes.push('SANDBOX_MODE_UNMEASURED')
  else if (mode.value !== 'workspace-write') caveats.push(`sandbox mode at call was ${mode.value}`)

  for (const problem of correlation.problems ?? []) {
    if (problem === 'NO_APPROVAL_REQUESTED' || problem === 'AMBIGUOUS_APPROVAL_REQUEST'
      || problem === 'DUPLICATE_DECISION' || problem === 'DUPLICATE_TOOL_CALL'
      || problem === 'DUPLICATE_TOOL_RESULT') {
      failures.push(problem)
    } else if (problem === 'DECISION_MISSING') {
      failures.push(problem)
    } else if (problem === 'TOOL_CALL_MISSING') {
      failures.push(problem)
    } else if (problem === 'TOOL_RESULT_MISSING') {
      incompletes.push(problem)
    }
  }

  const ask = correlation.ask
  if (ask) {
    if (typeof ask.id !== 'string' || ask.id === '') failures.push('APPROVAL_ID_MISSING')
    if (ask.toolName !== 'pwsh') failures.push('APPROVAL_TOOL_MISMATCH')
    if (typeof ask.callId !== 'string' || ask.callId === '') failures.push('APPROVAL_CALLID_MISSING')
    if (typeof ask.seq !== 'number') incompletes.push('ASK_SEQ_MISSING')
    if (typeof ask.reason !== 'string' || !ask.reason.startsWith(ESCALATION_PREFIX)) {
      failures.push('REASON_PREFIX_MISSING')
    }
    if (marker && typeof ask.reason === 'string' && !ask.reason.includes(marker)) {
      failures.push('MARKER_MISMATCH')
    }
  }

  const decision = correlation.decision
  if (decision) {
    if (typeof decision.seq !== 'number') incompletes.push('DECISION_SEQ_MISSING')
    if (decision.outcome === 'rejected') {
      // 期望值
    } else if (decision.outcome === 'allowed') {
      failures.push('DECISION_NOT_REJECTED')
    } else if (decision.outcome === 'unknown') {
      failures.push(`DECISION_UNKNOWN_OUTCOME:${String(decision.outcomeRaw)}`)
    } else {
      failures.push(`DECISION_${String(decision.outcome ?? 'MISSING').toUpperCase()}`)
    }
  }

  const toolCall = correlation.toolCall
  if (toolCall) {
    if (typeof toolCall.seq !== 'number') incompletes.push('TOOL_CALL_SEQ_MISSING')
    if (!toolCall.argumentsParsed) failures.push('ARGUMENTS_UNPARSABLE')
    if (toolCall.sandboxPermission !== ESCALATION_PERMISSION) failures.push('ESCALATION_NOT_REQUESTED')
    if (!toolCall.justification) failures.push('JUSTIFICATION_MISSING')
    else if (marker && !toolCall.justification.includes(marker)) failures.push('MARKER_NOT_IN_JUSTIFICATION')
    if (ask && typeof ask.reason === 'string' && toolCall.justification
      && ask.reason !== `${ESCALATION_PREFIX}${toolCall.justification}`) {
      failures.push('REASON_JUSTIFICATION_MISMATCH')
    }
    if (ask && typeof ask.callId === 'string' && ask.callId !== toolCall.callId) {
      failures.push('CALLID_MISMATCH')
    }
  }

  const result = correlation.toolResult
  if (result) {
    if (result.isError === true) {
      if (result.textLength === 0) incompletes.push('TOOL_RESULT_TEXT_EMPTY')
      else if (!result.denialTextPresent) {
        caveats.push('tool result does not mention denial wording; human observation must confirm what the popup said')
      }
    } else if (result.isError === false) {
      failures.push('TOOL_SUCCEEDED_WITHOUT_DENIAL')
    } else {
      incompletes.push('TOOL_RESULT_ISERROR_MISSING')
    }
  }

  // 顺序：call → asked → decided → result
  if (ask && decision && toolCall && typeof ask.seq === 'number' && typeof decision.seq === 'number'
    && typeof toolCall.seq === 'number') {
    if (!(toolCall.seq < ask.seq)) failures.push('ORDER_CALL_AFTER_ASK')
    if (!(decision.seq > ask.seq)) failures.push('ORDER_DECISION_BEFORE_ASK')
    if (result && typeof result.seq === 'number' && !(result.seq > decision.seq)) {
      failures.push('ORDER_RESULT_BEFORE_DECISION')
    }
  }

  const state = compareStates(before, after)
  failures.push(...state.failures)
  incompletes.push(...state.incompletes)
  caveats.push(...state.caveats)
  Object.assign(details, state.details)

  if ((before?.target?.siblingMatches ?? []).length > 0) failures.push('TARGET_SIBLING_PREEXISTS')

  const verdict = failures.length > 0 ? 'FAIL' : (incompletes.length > 0 ? 'INCOMPLETE' : 'PASS')
  return {
    verdict,
    failures: [...new Set(failures)],
    incompletes: [...new Set(incompletes)],
    caveats: [...new Set(caveats)],
    details,
  }
}

/* ---------------------------------------------------------------------------
 * 判定：人工观察 + 最终结论
 * ------------------------------------------------------------------------ */

/**
 * 读人工观察记录。只读，不写：Agent 不得代用户填写"我点击了拒绝"。
 * 约定格式（见证据模板）：正文里有一行 `confirmed_rejection: yes` / `no`。
 */
export function readHumanObservation(dir) {
  const file = join(dir, 'human-observation.md')
  if (!existsSync(file)) {
    return { present: false, confirmedRejection: null, file: null, issues: ['HUMAN_OBSERVATION_MISSING'] }
  }
  const text = readFileSync(file, 'utf8')
  const match = /^confirmed_rejection:\s*(yes|no)\s*$/im.exec(text)
  if (!match) {
    return { present: true, confirmedRejection: null, file, issues: ['HUMAN_OBSERVATION_INCOMPLETE'] }
  }
  const value = match[1].toLowerCase()
  return {
    present: true,
    confirmedRejection: value === 'yes',
    file,
    issues: [],
  }
}

/**
 * 最终结论 = 机器判定 + 人工确认。两者分开记录；缺人工确认最多到 INCOMPLETE，
 * 绝不因为"机器看起来都对"就宣布人工验收通过。
 */
export function composeFinalVerdict({ machine, human }) {
  if (machine.verdict === 'FAIL') {
    return { verdict: 'FAIL', reason: 'machine evidence contradicts the claim', failures: machine.failures }
  }
  if (human.confirmedRejection === false) {
    return { verdict: 'FAIL', reason: 'human observation contradicts the machine evidence', failures: ['HUMAN_CONTRADICTS_MACHINE'] }
  }
  if (!human.present || human.confirmedRejection !== true) {
    return {
      verdict: 'INCOMPLETE',
      reason: 'machine evidence does not contradict, but human observation is missing',
      failures: [],
    }
  }
  if (machine.verdict === 'INCOMPLETE') {
    return { verdict: 'INCOMPLETE', reason: 'machine evidence incomplete', failures: [] }
  }
  return { verdict: 'PASS', reason: 'machine evidence + human confirmation', failures: [] }
}

/* ---------------------------------------------------------------------------
 * 输出
 * ------------------------------------------------------------------------ */

function renderVerdictMarkdown({ result, correlation, generatedAt }) {
  const lines = []
  lines.push('# 人工审批安全拒绝测试：判定结果')
  lines.push('')
  lines.push(`- 生成时间：${generatedAt}`)
  lines.push(`- 测试标记：\`${correlation.marker ?? '(未提供)'}\``)
  lines.push(`- 机器判定：**${result.machine.verdict}**`)
  lines.push(`- 人工确认：${result.human.confirmedRejection === true ? '已确认拒绝' : '(未确认)'}`)
  lines.push(`- 最终结论：**${result.final.verdict}**（${result.final.reason}）`)
  lines.push('')
  lines.push('## 失败码')
  lines.push(result.machine.failures.length === 0 ? '无。' : result.machine.failures.map((code) => `- \`${code}\``).join('\n'))
  lines.push('')
  lines.push('## 证据缺失（无法判定为通过）')
  lines.push(result.machine.incompletes.length === 0 ? '无。' : result.machine.incompletes.map((code) => `- \`${code}\``).join('\n'))
  lines.push('')
  lines.push('## 保留意见')
  lines.push(result.machine.caveats.length === 0 ? '无。' : result.machine.caveats.map((text) => `- ${text}`).join('\n'))
  lines.push('')
  lines.push('## 证据摘要（白名单字段；不含消息正文）')
  lines.push('')
  lines.push('| 类别 | 结果 |')
  lines.push('| --- | --- |')
  lines.push(`| 审批请求 | ${correlation.askCount === 1 ? 'present (1)' : `count=${correlation.askCount}`} |`)
  lines.push(`| 审批时刻策略 | ${correlation.policyAtCall ? `${correlation.policyAtCall.value} @seq ${correlation.policyAtCall.seq}` : 'unmeasured'} |`)
  lines.push(`| 用户决定 | ${correlation.decision ? `${correlation.decision.outcome} (${correlation.decision.outcomeRaw})` : 'missing'} |`)
  lines.push(`| 工具返回结果 | ${correlation.toolResult ? `isError=${String(correlation.toolResult.isError)} textLength=${correlation.toolResult.textLength}` : 'missing'} |`)
  lines.push('')
  return lines.join('\n')
}

function ioError(message) {
  const error = new Error(message)
  error.exitCode = EXIT_IO
  return error
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------ */

const USAGE = `Usage:
  node ${TOOL_PATH} snapshot --target <path> --dir <evidence-dir> --run-id <id> --marker <text>
                             [--phase before|after] [--repo <root>] [--overwrite]
  node ${TOOL_PATH} verify   --dir <evidence-dir> --run-id <id> --marker <text>
                             (--session <session-id|log-path> | --from-files) [--call-id <id>] [--overwrite]

Exit codes: 0 PASS / 1 FAIL / 3 INCOMPLETE / 4 usage / 5 IO.`

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command, fromFiles: false, overwrite: false }
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) throw usageError(`unexpected argument: ${token}`)
    const key = token.slice(2)
    if (key === 'from-files') {
      options.fromFiles = true
      continue
    }
    if (key === 'overwrite') {
      options.overwrite = true
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw usageError(`missing value for --${key}`)
    options[key] = value
    i += 1
  }
  return options
}

function usageError(message) {
  const error = new Error(message)
  error.exitCode = EXIT_USAGE
  return error
}

function requireOption(options, key) {
  if (typeof options[key] !== 'string' || options[key] === '') {
    throw usageError(`missing required option --${key}`)
  }
  return options[key]
}

function readJsonFile(file) {
  if (!existsSync(file)) throw ioError(`missing file: ${file}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw ioError(`invalid JSON in ${file}: ${error.message}`)
  }
}

/** 排他写入：默认不覆盖已有产物，避免静默抹掉上一次运行的证据。 */
function writeExclusive(file, content, overwrite) {
  try {
    writeFileSync(file, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw usageError(`refusing to overwrite existing file (pass --overwrite to replace): ${file}`)
    }
    throw ioError(`cannot write ${file}: ${error.message}`)
  }
}

function runSnapshot(options, repoRoot) {
  const target = requireOption(options, 'target')
  const dir = resolve(requireOption(options, 'dir'))
  const runId = requireOption(options, 'run-id')
  const marker = requireOption(options, 'marker')
  const phase = options.phase ?? 'before'
  if (phase !== 'before' && phase !== 'after') throw usageError('--phase must be before|after')
  // --repo 必须真的生效：否则指纹会抓成调用者当前所在的仓库，与被测目标对不上。
  const effectiveRepoRoot = typeof options.repo === 'string' && options.repo !== ''
    ? resolve(options.repo)
    : repoRoot
  mkdirSync(dir, { recursive: true })
  const snapshot = buildStateSnapshot({ target, repoRoot: effectiveRepoRoot, evidenceDir: dir, phase, runId, marker })
  const file = join(dir, `state-${phase}.json`)
  writeExclusive(file, `${JSON.stringify(snapshot, null, 2)}\n`, options.overwrite)
  appendFileSync(join(dir, 'commands.log'), `[${new Date().toISOString()}] snapshot ${phase} -> ${file}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    command: 'snapshot',
    phase,
    file,
    target: snapshot.target.path,
    exists: snapshot.target.exists,
    contentScope: {
      ok: snapshot.repo.contentScope.ok,
      fileCount: snapshot.repo.contentScope.fileCount,
      skipped: snapshot.repo.contentScope.skipped.length,
    },
  })}\n`)
  return EXIT_PASS
}

function runVerify(options, repoRoot) {
  const dir = resolve(requireOption(options, 'dir'))
  const runId = requireOption(options, 'run-id')
  const marker = requireOption(options, 'marker')
  const callId = options['call-id'] ?? null

  const before = readJsonFile(join(dir, 'state-before.json'))
  const after = readJsonFile(join(dir, 'state-after.json'))

  let correlation
  let decode = null
  if (options.fromFiles) {
    const stored = readJsonFile(join(dir, 'approval-evidence.json'))
    if (stored.schemaVersion !== SCHEMA_VERSION) {
      throw usageError(`approval-evidence.json schemaVersion ${stored.schemaVersion} != ${SCHEMA_VERSION}; re-extract from the log`)
    }
    correlation = stored.correlation
    decode = stored.decode ?? null
  } else {
    const sessionArg = requireOption(options, 'session')
    const sessionFile = resolveSessionFile(sessionArg, options['dsh-home'])
    const decoded = decodeSessionLog(readFileSync(sessionFile))
    if (decoded.structuralError) {
      throw ioError(`session log is structurally invalid: ${decoded.structuralError}`)
    }
    const parsed = parseEvents(decoded.text)
    decode = { frames: decoded.frames, badFrames: decoded.badFrames, badLines: parsed.badLines }
    correlation = correlateApproval(parsed.events, { callId, marker })
    if (correlation.askCount === 0 && !callId) {
      throw usageError('no approval request matched --marker; pass --marker or --call-id')
    }
    writeExclusive(join(dir, 'approval-evidence.json'), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      sessionFile,
      decode,
      correlation,
    }, null, 2)}\n`, options.overwrite)
  }

  if (correlation.marker !== marker) {
    correlation.problems = [...(correlation.problems ?? []), 'MARKER_ARGUMENT_MISMATCH']
  }

  const machine = judgeMachineEvidence({ correlation, before, after, marker })

  // 日志自身不完整（坏帧/坏行）时，任何"没看到审批事件"的结论都不可靠。
  if (decode) {
    if (decode.badFrames > 0) machine.incompletes.push('LOG_BAD_FRAMES')
    if (decode.badLines > 0) machine.incompletes.push('LOG_BAD_LINES')
    if (decode.frames === 0) machine.incompletes.push('LOG_EMPTY')
  }
  machine.verdict = machine.failures.length > 0
    ? 'FAIL'
    : (machine.incompletes.length > 0 ? 'INCOMPLETE' : 'PASS')

  const human = readHumanObservation(dir)
  const final = composeFinalVerdict({ machine, human })

  const generatedAt = new Date().toISOString()
  const output = {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_PATH,
    generatedAt,
    runId,
    marker,
    callId: correlation.effectiveCallId,
    decode,
    machine: {
      verdict: machine.verdict,
      failures: machine.failures,
      incompletes: machine.incompletes,
      caveats: machine.caveats,
      details: machine.details,
    },
    human,
    final,
  }
  writeExclusive(join(dir, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`, options.overwrite)
  writeExclusive(join(dir, 'VERDICT.md'), renderVerdictMarkdown({ result: output, correlation, generatedAt }), options.overwrite)
  process.stdout.write(`${JSON.stringify({
    machine: output.machine.verdict,
    final: output.final.verdict,
    failures: output.machine.failures,
    incompletes: output.machine.incompletes,
  })}\n`)

  if (final.verdict === 'PASS') return EXIT_PASS
  if (final.verdict === 'FAIL') return EXIT_FAIL
  return EXIT_INCOMPLETE
}

export function main(argv = process.argv.slice(2), { repoRoot = process.cwd() } = {}) {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      process.stdout.write(`${USAGE}\n`)
      return EXIT_PASS
    }
    const options = parseArgs(argv)
    if (options.command === 'snapshot') return runSnapshot(options, resolve(repoRoot))
    if (options.command === 'verify') return runVerify(options, resolve(repoRoot))
    throw usageError(`unknown command: ${options.command}`)
  } catch (error) {
    const code = error.exitCode ?? EXIT_IO
    process.stderr.write(`error: ${error.message}\n`)
    if (code === EXIT_USAGE) process.stderr.write(`${USAGE}\n`)
    return code
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.exitCode = main()
}
