#!/usr/bin/env node
/**
 * tools/approval-rejection-evidence.mjs 的离线回归。
 *
 * 全部用合成事件流与合成指纹，不触发任何真实审批、不读真实会话日志、不联网。
 * 覆盖三类行为：
 *   A. 会话日志解码：多帧、载荷里出现 zstd 魔数、截断、损坏、保留位/保留块类型；
 *   B. 机器判定：缺失/重复/歧义/错配/顺序错误/策略作用域/工具结果语义；
 *   C. 前后指纹：缺失测量、内容指纹、runId/目标/时间顺序对应、副作用范围。
 * 每个用例只断言"哪一条判定结果"出现，不比较整段 JSON，避免脆弱。
 *
 * 运行：node tests/approval-rejection-evidence.test.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  compareStates,
  composeFinalVerdict,
  correlateApproval,
  decodeSessionLog,
  judgeMachineEvidence,
  main,
  parseEvents,
  pathKeyOf,
  readHumanObservation,
  splitZstdFrames,
  writeBindingCommand,
  zstdFrameLength,
} from '../tools/approval-rejection-evidence.mjs'

const TOOL_PATH = 'tools/approval-rejection-evidence.mjs'
const MARKER = '[tla-approval-rejection:11111111-2222-3333-4444-555555555555]'
const TARGET_PATH = 'C:\\tmp\\tla-approval-rejection-test.txt'
const JUSTIFICATION = `测试用无害写入：向 ${TARGET_PATH} 写入一个标记文件，用来验证人工拒绝会真的拦住操作 ${MARKER}`
const REASON = `escalate sandbox to danger-full-access: ${JUSTIFICATION}`
const CALL_ID = 'call_00_SYNTHETIC_0001'
const ASK_ID = 'ask-id-0001'
/** 快照夹具的 before 采集时刻；审批事件时间都锚在它之后，用来验证"快照区间围住审批"。 */
const BASE_MS = Date.parse('2026-10-17T05:00:00.000Z')

const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`)
}

function has(list, code) {
  return Array.isArray(list) && list.includes(code)
}

/* ---------------------------------------------------------------------------
 * 合成 zstd 帧
 * ------------------------------------------------------------------------ */

function compressedFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

/**
 * 手工构造一个"单段 + 原始块"的 zstd 帧：块内容是明文，因此可以让载荷里
 * 出现 28 B5 2F FD 这四个字节——正是"扫魔数切帧"会切错的情形。
 */
function rawBlockFrame(payload) {
  const descriptor = 0x20 // FCS_flag=0, Single_Segment=1, 无校验和, 无字典
  const header = Buffer.concat([
    ZSTD_MAGIC_BYTES,
    Buffer.from([descriptor, payload.length & 0xff]),
  ])
  const blockHeaderValue = 1 | (0 << 1) | (payload.length << 3) // Last_Block=1, Raw, size
  const blockHeader = Buffer.from([
    blockHeaderValue & 0xff,
    (blockHeaderValue >> 8) & 0xff,
    (blockHeaderValue >> 16) & 0xff,
  ])
  return Buffer.concat([header, blockHeader, payload])
}

function sessionFrame(events) {
  return compressedFrame(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

/**
 * 带内容校验和的原始块帧。校验和是假的，用来验证"结构能解析、但解压必须失败"
 * 这条路径（badFrames > 0），以及切帧时确实把校验和 4 字节算进了帧长。
 */
function rawBlockFrameWithBadChecksum(payload) {
  const descriptor = 0x20 | 0x04 // 单段 + 有内容校验和
  const header = Buffer.concat([
    ZSTD_MAGIC_BYTES,
    Buffer.from([descriptor, payload.length & 0xff]),
  ])
  const blockHeaderValue = 1 | (0 << 1) | (payload.length << 3)
  const blockHeader = Buffer.from([
    blockHeaderValue & 0xff,
    (blockHeaderValue >> 8) & 0xff,
    (blockHeaderValue >> 16) & 0xff,
  ])
  return Buffer.concat([header, blockHeader, payload, Buffer.from([0xde, 0xad, 0xbe, 0xef])])
}

/* ---------------------------------------------------------------------------
 * 合成事件流与指纹
 * ------------------------------------------------------------------------ */

function baseEvents() {
  return [
    { type: 'session', seq: 0, id: 'session-synthetic', cwd: 'C:\\repo', parentSession: null, delegationDepth: 0 },
    { type: 'sandbox/mode', seq: 1, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, data: { policy: 'ask' } },
    {
      type: 'tool/call',
      seq: 10,
      time: BASE_MS + 1000,
      data: {
        turn: 1,
        step: 1,
        callId: CALL_ID,
        name: 'pwsh',
        arguments: JSON.stringify({
          command: writeBindingCommand(TARGET_PATH, MARKER),
          sandbox_permissions: 'danger-full-access',
          justification: JUSTIFICATION,
        }),
      },
    },
    {
      type: 'approval/asked',
      seq: 11,
      time: BASE_MS + 2000,
      data: { id: ASK_ID, toolName: 'pwsh', callId: CALL_ID, reason: REASON },
    },
    { type: 'approval/decided', seq: 12, time: BASE_MS + 3000, data: { id: ASK_ID, outcome: 'rejected' } },
    {
      type: 'tool/result',
      seq: 13,
      time: BASE_MS + 4000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: CALL_ID },
          toolCallId: CALL_ID,
          content: [{ type: 'text', text: 'Denied by user. The operation was not executed.' }],
          isError: true,
          id: 'msg-1',
        },
      },
    },
  ]
}

function findEvent(events, type) {
  const found = events.find((event) => event.type === type)
  if (!found) throw new Error(`synthetic stream is missing ${type}`)
  return found
}

function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const output = { ...base }
  for (const key of Object.keys(patch)) {
    output[key] = key in base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])
      ? deepMerge(base[key], patch[key])
      : patch[key]
  }
  return output
}

function stateFixture(phase, patch = {}) {
  const capturedAt = phase === 'before' ? '2026-10-17T05:00:00.000Z' : '2026-10-17T05:01:00.000Z'
  const base = {
    schemaVersion: 3,
    tool: TOOL_PATH,
    phase,
    runId: 'run-1',
    marker: MARKER,
    capturedAt,
    capturedAtMs: Date.parse(capturedAt),
    target: {
      path: TARGET_PATH,
      pathKey: 'c:\\tmp\\tla-approval-rejection-test.txt',
      exists: false,
      parent: 'C:\\tmp',
      parentMeasured: true,
      siblingMatches: [],
      insideRepo: false,
      nameMatchesContract: true,
    },
    repo: {
      root: 'C:\\repo',
      head: { ok: true, status: 0, error: null, value: 'abc123' },
      branch: { ok: true, status: 0, error: null, value: 'main' },
      statusEntries: { ok: true, status: 0, error: null, value: [] },
      contentScope: {
        ok: true,
        aggregate: 'sha256:aaaa',
        files: { 'a.txt': 'sha256:1111' },
        fileCount: 1,
        skipped: [],
        excluded: ['docs/evidence/run-1'],
      },
      localRemoteTrackingRefs: { ok: true, status: 0, error: null, value: { 'refs/remotes/origin/main': 'abc123' } },
      remoteObserved: false,
    },
    manifests: { ok: true, value: { 'package.json': 'sha256:9999' } },
    permissions: { status: 'measured', parent: 'C:\\tmp', sddl: 'O:SYG:SYD:(A;;FA;;;WD)' },
    identity: { sessionId: 'session-synthetic', platform: 'win32', nodeVersion: '24.21.0' },
  }
  return deepMerge(base, patch)
}

function judge({ events = baseEvents(), beforePatch, afterPatch, marker = MARKER } = {}) {
  const correlation = correlateApproval(events, { marker })
  const before = stateFixture('before', beforePatch)
  const after = stateFixture('after', afterPatch)
  const machine = judgeMachineEvidence({ correlation, before, after, marker })
  const humanOk = { present: true, confirmedRejection: true, file: 'human-observation.md', issues: [] }
  const final = composeFinalVerdict({ machine, human: humanOk })
  return { correlation, machine, final }
}

/* ---------------------------------------------------------------------------
 * A. 日志解码
 * ------------------------------------------------------------------------ */

function testDecoding() {
  const single = compressedFrame('{"type":"a"}\n')
  check('decode: single frame', decodeSessionLog(single).frames === 1
    && decodeSessionLog(single).text === '{"type":"a"}\n')

  const multi = Buffer.concat([compressedFrame('one\n'), compressedFrame('two\n'), compressedFrame('three\n')])
  const decoded = decodeSessionLog(multi)
  check('decode: three frames', decoded.frames === 3, `frames=${decoded.frames}`)
  check('decode: three frames text', decoded.text === 'one\ntwo\nthree\n', JSON.stringify(decoded.text))

  // 关键回归：载荷里出现 zstd 魔数时，按魔数切帧会切成 3 段，按结构切只有 2 帧。
  const payloadWithMagic = Buffer.concat([Buffer.from('A'), ZSTD_MAGIC_BYTES, Buffer.from('B')])
  check('decode: synthetic raw frame round-trips', zstdDecompressSync(rawBlockFrame(payloadWithMagic)).equals(payloadWithMagic))
  const twoFrames = Buffer.concat([rawBlockFrame(payloadWithMagic), rawBlockFrame(Buffer.from('C'))])
  let magicSplitCount = 0
  for (let i = 0; i + 4 <= twoFrames.length; i += 1) {
    if (twoFrames.subarray(i, i + 4).equals(ZSTD_MAGIC_BYTES)) magicSplitCount += 1
  }
  check('decode: magic bytes appear inside a payload', magicSplitCount === 3, `magic occurrences=${magicSplitCount}`)
  check('decode: structural split ignores inner magic', splitZstdFrames(twoFrames).length === 2)

  // 截断：结构上不允许被"跳过"
  const truncated = Buffer.concat([compressedFrame('a\n'), compressedFrame('b\n')]).subarray(0, 20)
  const truncatedDecoded = decodeSessionLog(truncated)
  check('decode: truncated tail is structural error', typeof truncatedDecoded.structuralError === 'string',
    JSON.stringify(truncatedDecoded.structuralError))

  // 保留块类型 3
  const badBlock = Buffer.from(rawBlockFrame(Buffer.from('x')))
  badBlock[badBlock.length - 1] = 0
  const blockHeaderOffset = 6
  badBlock[blockHeaderOffset] = 1 | (3 << 1)
  let blockTypeError = null
  try {
    zstdFrameLength(badBlock, 0)
  } catch (error) {
    blockTypeError = String(error.message)
  }
  check('decode: reserved block type rejected', /reserved block type/.test(blockTypeError ?? ''), String(blockTypeError))

  // 帧头保留位
  const reservedBitFrame = Buffer.from(rawBlockFrame(Buffer.from('x')))
  reservedBitFrame[4] |= 0x08
  let reservedError = null
  try {
    zstdFrameLength(reservedBitFrame, 0)
  } catch (error) {
    reservedError = String(error.message)
  }
  check('decode: reserved header bit rejected', /reserved bit/.test(reservedError ?? ''), String(reservedError))

  // 压缩数据损坏：分两种情况，必须分别说清楚
  // (a) 帧带校验和 -> 解压失败，badFrames > 0，调用方降级为 INCOMPLETE
  const badChecksum = decodeSessionLog(rawBlockFrameWithBadChecksum(Buffer.from('{"type":"a"}\n')))
  check('decode: bad checksum frame counted as bad frame', badChecksum.badFrames === 1,
    `badFrames=${badChecksum.badFrames} err=${badChecksum.structuralError}`)
  // (b) 帧不带校验和 -> zstd 本身发现不了位翻转（这是已知限制，写进文档，不当成 PASS 依据）。
  //     实际兜底是"解出来的行不是 JSON"：下面证明这种损坏在实践中确实会被 JSON 层抓到。
  const cleanFrames = Buffer.from(compressedFrame('{"type":"a"}\n'.repeat(200)))
  let corruptionDetected = false
  for (let i = 0; i < 16 && !corruptionDetected; i += 1) {
    const candidate = Buffer.from(cleanFrames)
    candidate[Math.floor(candidate.length / 2) + i] ^= 0xff
    const decoded = decodeSessionLog(candidate)
    const parsed = parseEvents(decoded.text)
    if (decoded.badFrames > 0 || parsed.badLines > 0) corruptionDetected = true
  }
  check('decode: checksum-less corruption surfaces at the JSON layer', corruptionDetected)

  check('decode: empty buffer is an error', typeof decodeSessionLog(Buffer.alloc(0)).structuralError === 'string')

  const parsed = parseEvents('{"a":1}\nnot json\n{"b":2}\n')
  check('parse: bad line counted', parsed.badLines === 1 && parsed.events.length === 2)
}

/* ---------------------------------------------------------------------------
 * B. 机器判定
 * ------------------------------------------------------------------------ */

function testJudgeBaseline() {
  const { machine, final } = judge()
  check('judge: clean rejection is PASS', machine.verdict === 'PASS',
    `verdict=${machine.verdict} f=${JSON.stringify(machine.failures)} i=${JSON.stringify(machine.incompletes)}`)
  check('judge: final PASS with human confirmation', final.verdict === 'PASS', JSON.stringify(final))

  const humanMissing = composeFinalVerdict({ machine, human: { present: false, confirmedRejection: null, issues: ['HUMAN_OBSERVATION_MISSING'] } })
  check('judge: no human observation => INCOMPLETE', humanMissing.verdict === 'INCOMPLETE', JSON.stringify(humanMissing))

  const humanNo = composeFinalVerdict({ machine, human: { present: true, confirmedRejection: false, issues: [] } })
  check('judge: human says no => FAIL', humanNo.verdict === 'FAIL' && humanNo.failures.includes('HUMAN_CONTRADICTS_MACHINE'))
}

function testJudgeDecisionVariants() {
  const variants = [
    ['allowed-once', 'DECISION_NOT_REJECTED'],
    ['cancelled', 'DECISION_CANCELLED'],
    ['unavailable', 'DECISION_UNAVAILABLE'],
    ['timeout', 'DECISION_UNKNOWN_OUTCOME:timeout'],
  ]
  for (const [outcome, code] of variants) {
    const events = baseEvents()
    findEvent(events, 'approval/decided').data.outcome = outcome
    const { machine } = judge({ events })
    check(`judge: outcome ${outcome} => ${code}`, machine.verdict === 'FAIL' && has(machine.failures, code),
      `verdict=${machine.verdict} failures=${JSON.stringify(machine.failures)}`)
  }

  const missingDecision = baseEvents().filter((event) => event.type !== 'approval/decided')
  const result = judge({ events: missingDecision })
  check('judge: missing decision', result.machine.verdict === 'FAIL' && has(result.machine.failures, 'DECISION_MISSING'),
    JSON.stringify(result.machine.failures))

  const duplicateDecision = baseEvents()
  duplicateDecision.push({ type: 'approval/decided', seq: 14, data: { id: ASK_ID, outcome: 'rejected' } })
  const duplicate = judge({ events: duplicateDecision })
  check('judge: duplicate decision', has(duplicate.machine.failures, 'DUPLICATE_DECISION'),
    JSON.stringify(duplicate.machine.failures))
}

function testJudgeAskVariants() {
  const noAsk = baseEvents().filter((event) => event.type !== 'approval/asked')
  const noAskResult = judge({ events: noAsk })
  check('judge: no ask', has(noAskResult.machine.failures, 'NO_APPROVAL_REQUESTED'),
    JSON.stringify(noAskResult.machine.failures))

  const twoAsks = baseEvents()
  twoAsks.push({
    type: 'approval/asked',
    seq: 14,
    data: { id: 'ask-id-0002', toolName: 'pwsh', callId: CALL_ID, reason: REASON },
  })
  const ambiguous = judge({ events: twoAsks })
  check('judge: ambiguous ask', has(ambiguous.machine.failures, 'AMBIGUOUS_APPROVAL_REQUEST'),
    JSON.stringify(ambiguous.machine.failures))

  const markerMismatch = baseEvents()
  findEvent(markerMismatch, 'approval/asked').data.reason = 'escalate sandbox to danger-full-access: other test [tla-approval-rejection:99999999-0000-0000-0000-000000000000]'
  // marker 不在 reason 里 -> 关联阶段就找不到
  const mismatch = judge({ events: markerMismatch })
  check('judge: marker mismatch found no ask', has(mismatch.machine.failures, 'NO_APPROVAL_REQUESTED'),
    JSON.stringify(mismatch.machine.failures))

  const wrongTool = baseEvents()
  findEvent(wrongTool, 'approval/asked').data.toolName = 'write'
  check('judge: non-pwsh tool', has(judge({ events: wrongTool }).machine.failures, 'APPROVAL_TOOL_MISMATCH'))

  const noPrefix = baseEvents()
  const ask = findEvent(noPrefix, 'approval/asked')
  ask.data.reason = `manual approval ${MARKER}`
  const noPrefixResult = judge({ events: noPrefix })
  check('judge: reason without escalation prefix', has(noPrefixResult.machine.failures, 'REASON_PREFIX_MISSING'),
    JSON.stringify(noPrefixResult.machine.failures))
}

function testJudgeToolCallVariants() {
  const noCall = baseEvents().filter((event) => event.type !== 'tool/call')
  const noCallResult = judge({ events: noCall })
  check('judge: missing tool/call', has(noCallResult.machine.failures, 'TOOL_CALL_MISSING'),
    JSON.stringify(noCallResult.machine.failures))

  const duplicateCall = baseEvents()
  duplicateCall.push({ ...findEvent(duplicateCall, 'tool/call'), seq: 14 })
  check('judge: duplicate tool/call', has(judge({ events: duplicateCall }).machine.failures, 'DUPLICATE_TOOL_CALL'))

  const noEscalation = baseEvents()
  const call = findEvent(noEscalation, 'tool/call')
  const args = JSON.parse(call.data.arguments)
  delete args.sandbox_permissions
  call.data.arguments = JSON.stringify(args)
  check('judge: no escalation permission', has(judge({ events: noEscalation }).machine.failures, 'ESCALATION_NOT_REQUESTED'))

  const badArguments = baseEvents()
  findEvent(badArguments, 'tool/call').data.arguments = '{not json'
  check('judge: unparsable arguments', has(judge({ events: badArguments }).machine.failures, 'ARGUMENTS_UNPARSABLE'))

  // marker 只在 reason 里、不在 justification 里：只查 reason 的实现会放过
  const markerOnlyInReason = baseEvents()
  const callForMarker = findEvent(markerOnlyInReason, 'tool/call')
  const argsForMarker = JSON.parse(callForMarker.data.arguments)
  argsForMarker.justification = '写入一个测试文件，用来验证人工拒绝会真的拦住操作'
  callForMarker.data.arguments = JSON.stringify(argsForMarker)
  const markerResult = judge({ events: markerOnlyInReason })
  check('judge: marker not in justification', has(markerResult.machine.failures, 'MARKER_NOT_IN_JUSTIFICATION'),
    JSON.stringify(markerResult.machine.failures))
  check('judge: reason/justification mismatch', has(markerResult.machine.failures, 'REASON_JUSTIFICATION_MISMATCH'),
    JSON.stringify(markerResult.machine.failures))

  const callIdMismatch = baseEvents()
  findEvent(callIdMismatch, 'approval/asked').data.callId = 'call_00_OTHER'
  // 关联阶段按 marker 找到该 ask，但它的 callId 指向另一次调用 -> 找不到 tool/call
  const callIdResult = judge({ events: callIdMismatch })
  check('judge: ask callId points elsewhere', has(callIdResult.machine.failures, 'TOOL_CALL_MISSING'),
    JSON.stringify(callIdResult.machine.failures))
}

function testJudgeToolResultVariants() {
  const missingResult = baseEvents().filter((event) => event.type !== 'tool/result')
  const missing = judge({ events: missingResult })
  check('judge: missing tool result => INCOMPLETE', missing.machine.verdict === 'INCOMPLETE'
    && has(missing.machine.incompletes, 'TOOL_RESULT_MISSING'),
  `verdict=${missing.machine.verdict} i=${JSON.stringify(missing.machine.incompletes)}`)
  check('judge: missing tool result => final INCOMPLETE', missing.final.verdict === 'INCOMPLETE')

  const successResult = baseEvents()
  findEvent(successResult, 'tool/result').data.message.isError = false
  const success = judge({ events: successResult })
  check('judge: tool succeeded', has(success.machine.failures, 'TOOL_SUCCEEDED_WITHOUT_DENIAL'),
    JSON.stringify(success.machine.failures))

  // isError 缺失：旧版把 undefined 当成"不是 false"从而放过
  const noIsError = baseEvents()
  delete findEvent(noIsError, 'tool/result').data.message.isError
  const noIsErrorResult = judge({ events: noIsError })
  check('judge: isError missing => INCOMPLETE', noIsErrorResult.machine.verdict === 'INCOMPLETE'
    && has(noIsErrorResult.machine.incompletes, 'TOOL_RESULT_ISERROR_MISSING'),
  `verdict=${noIsErrorResult.machine.verdict} i=${JSON.stringify(noIsErrorResult.machine.incompletes)}`)

  const emptyText = baseEvents()
  findEvent(emptyText, 'tool/result').data.message.content = [{ type: 'text', text: '' }]
  const emptyTextResult = judge({ events: emptyText })
  check('judge: empty denial text => INCOMPLETE', has(emptyTextResult.machine.incompletes, 'TOOL_RESULT_TEXT_EMPTY'),
    JSON.stringify(emptyTextResult.machine.incompletes))

  const noDenialWording = baseEvents()
  findEvent(noDenialWording, 'tool/result').data.message.content = [{ type: 'text', text: 'Command failed with exit code 1' }]
  const wording = judge({ events: noDenialWording })
  check('judge: denial wording only a caveat', wording.machine.verdict === 'PASS'
    && wording.machine.caveats.some((text) => /denial wording/.test(text)),
  `verdict=${wording.machine.verdict} caveats=${JSON.stringify(wording.machine.caveats)}`)
}

function testJudgeOrdering() {
  const decisionBeforeAsk = baseEvents()
  const decided = findEvent(decisionBeforeAsk, 'approval/decided')
  const asked = findEvent(decisionBeforeAsk, 'approval/asked')
  decided.seq = asked.seq - 0.5
  const reversed = judge({ events: decisionBeforeAsk })
  check('judge: decision before ask', has(reversed.machine.failures, 'ORDER_DECISION_BEFORE_ASK'),
    JSON.stringify(reversed.machine.failures))

  const resultBeforeDecision = baseEvents()
  findEvent(resultBeforeDecision, 'tool/result').seq = 11.5
  const early = judge({ events: resultBeforeDecision })
  check('judge: result before decision', has(early.machine.failures, 'ORDER_RESULT_BEFORE_DECISION'),
    JSON.stringify(early.machine.failures))

  const callAfterAsk = baseEvents()
  findEvent(callAfterAsk, 'tool/call').seq = 11.5
  const late = judge({ events: callAfterAsk })
  check('judge: call after ask', has(late.machine.failures, 'ORDER_CALL_AFTER_ASK'),
    JSON.stringify(late.machine.failures))

  const noSeq = baseEvents()
  delete findEvent(noSeq, 'approval/asked').seq
  const noSeqResult = judge({ events: noSeq })
  check('judge: missing ask seq => INCOMPLETE', noSeqResult.machine.verdict === 'INCOMPLETE'
    && has(noSeqResult.machine.incompletes, 'ASK_SEQ_MISSING'),
  `verdict=${noSeqResult.machine.verdict} i=${JSON.stringify(noSeqResult.machine.incompletes)}`)
}

function testJudgePolicyScope() {
  // 审批时刻的策略是 never -> 自动拒绝，不是人工拒绝
  const neverAtCall = [
    { type: 'session', seq: 0, id: 's', cwd: 'C:\\repo', parentSession: null, delegationDepth: 0 },
    { type: 'sandbox/mode', seq: 1, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, data: { policy: 'never' } },
    ...baseEvents().filter((event) => !['session', 'sandbox/mode', 'approval/policy'].includes(event.type)),
  ]
  check('judge: policy never at call', has(judge({ events: neverAtCall }).machine.failures, 'POLICY_NEVER_AT_CALL'))

  // 历史上出现过 never（在本次审批之后），不得因此否定本次人工拒绝
  const neverLater = baseEvents()
  neverLater.push({ type: 'approval/policy', seq: 100, data: { policy: 'never' } })
  const later = judge({ events: neverLater })
  check('judge: later policy never does not taint the call', later.machine.verdict === 'PASS',
    `verdict=${later.machine.verdict} f=${JSON.stringify(later.machine.failures)}`)

  const noPolicy = baseEvents().filter((event) => event.type !== 'approval/policy')
  const noPolicyResult = judge({ events: noPolicy })
  check('judge: policy unmeasured => INCOMPLETE', noPolicyResult.machine.verdict === 'INCOMPLETE'
    && has(noPolicyResult.machine.incompletes, 'POLICY_UNMEASURED'),
  `verdict=${noPolicyResult.machine.verdict} i=${JSON.stringify(noPolicyResult.machine.incompletes)}`)

  const subagent = baseEvents()
  subagent[0] = { type: 'session', seq: 0, id: 'child', cwd: 'C:\\repo', parentSession: 'parent-1', delegationDepth: 1 }
  check('judge: subagent session', has(judge({ events: subagent }).machine.failures, 'SUBAGENT_SESSION'))

  const noMeta = baseEvents().filter((event) => event.type !== 'session')
  const noMetaResult = judge({ events: noMeta })
  check('judge: session meta missing => INCOMPLETE', has(noMetaResult.machine.incompletes, 'SESSION_META_MISSING'),
    JSON.stringify(noMetaResult.machine.incompletes))
}

/* ---------------------------------------------------------------------------
 * C. 前后指纹
 * ------------------------------------------------------------------------ */

function testStateComparison() {
  const before = stateFixture('before')
  const after = stateFixture('after')
  const clean = compareStates(before, after)
  check('state: identical snapshots', clean.failures.length === 0 && clean.incompletes.length === 0,
    JSON.stringify(clean))

  check('state: target created', has(compareStates(before, stateFixture('after', { target: { exists: true } })).failures,
    'TARGET_CREATED'))

  // 缺失测量不得当成"未变"
  const unmeasuredHead = compareStates(before, stateFixture('after', { repo: { head: { ok: false, status: 128, error: 'not a repo', value: null } } }))
  check('state: head unmeasured => INCOMPLETE', unmeasuredHead.failures.length === 0
    && has(unmeasuredHead.incompletes, 'HEAD_UNMEASURED'), JSON.stringify(unmeasuredHead))

  const unmeasuredBoth = compareStates(
    stateFixture('before', { permissions: { status: 'unmeasured', parent: 'C:\\tmp', reason: 'x' } }),
    stateFixture('after', { permissions: { status: 'unmeasured', parent: 'C:\\tmp', reason: 'x' } }),
  )
  check('state: permissions unmeasured => INCOMPLETE', unmeasuredBoth.failures.length === 0
    && has(unmeasuredBoth.incompletes, 'PERMISSIONS_UNMEASURED'), JSON.stringify(unmeasuredBoth))

  const permissionsChanged = compareStates(before, stateFixture('after', { permissions: { sddl: 'O:SYG:SYD:(A;;FA;;;BA)' } }))
  check('state: permissions changed', has(permissionsChanged.failures, 'PERMISSIONS_CHANGED'))

  // status 文本相同、内容不同
  const contentChanged = compareStates(before, stateFixture('after', {
    repo: { contentScope: { aggregate: 'sha256:bbbb', files: { 'a.txt': 'sha256:2222' } } },
  }))
  check('state: content changed with same status', has(contentChanged.failures, 'WORKSPACE_CONTENT_CHANGED')
    && contentChanged.details.changedFileCount === 1, JSON.stringify(contentChanged))

  // 内容相同、路径不同（改名）
  const renamed = compareStates(before, stateFixture('after', {
    repo: { contentScope: { aggregate: 'sha256:cccc', files: { 'b.txt': 'sha256:1111' } } },
  }))
  check('state: rename detected', has(renamed.failures, 'WORKSPACE_CONTENT_CHANGED'), JSON.stringify(renamed))

  check('state: head changed', has(compareStates(before, stateFixture('after', { repo: { head: { value: 'def456' } } })).failures,
    'WORKSPACE_HEAD_CHANGED'))
  check('state: status changed', has(compareStates(before, stateFixture('after', { repo: { statusEntries: { value: ['?? x.txt'] } } })).failures,
    'WORKSPACE_STATUS_CHANGED'))
  check('state: local remote ref changed', has(compareStates(before, stateFixture('after', {
    repo: { localRemoteTrackingRefs: { value: { 'refs/remotes/origin/main': 'def' } } },
  })).failures, 'LOCAL_REMOTE_REF_CHANGED'))
  check('state: deps changed', has(compareStates(before, stateFixture('after', {
    manifests: { value: { 'package.json': 'sha256:8888' } },
  })).failures, 'DEPS_CHANGED'))

  // runId / 目标 / 身份 / 时间顺序 必须对应
  check('state: runId mismatch', has(compareStates(before, stateFixture('after', { runId: 'run-2' })).failures,
    'SNAPSHOT_RUN_MISMATCH'))
  check('state: target mismatch', has(compareStates(before, stateFixture('after', {
    target: { path: 'C:\\tmp\\other.txt', pathKey: 'c:\\tmp\\other.txt' },
  })).failures, 'SNAPSHOT_TARGET_MISMATCH'))
  check('state: identity mismatch', has(compareStates(before, stateFixture('after', {
    identity: { sessionId: 'session-other' },
  })).failures, 'SNAPSHOT_IDENTITY_MISMATCH'))
  check('state: order invalid', has(compareStates(before, stateFixture('after', {
    capturedAt: '2026-10-17T04:59:59.999Z',
    capturedAtMs: Date.parse('2026-10-17T04:59:59.999Z'),
  })).failures, 'SNAPSHOT_ORDER_INVALID'))
  check('state: marker mismatch', has(compareStates(before, stateFixture('after', { marker: '[other]' })).failures,
    'SNAPSHOT_MARKER_MISMATCH'))
  check('state: schema mismatch => INCOMPLETE', has(compareStates(before, stateFixture('after', { schemaVersion: 1 })).incompletes,
    'SNAPSHOT_SCHEMA_MISMATCH'))

  // 未观测远端：只保留意见，不谎称"远端未变"
  check('state: remote unobserved caveat', clean.caveats.some((text) => /remote refs NOT observed/.test(text)))

  // 目标同前缀文件在快照前就存在 -> 前提不成立
  check('state: sibling preexists', has(compareStates(
    stateFixture('before', { target: { siblingMatches: ['tla-approval-rejection-old.txt'] } }),
    after,
  ).failures, 'TARGET_SIBLING_PREEXISTS'))
  check('state: sibling created', has(compareStates(before, stateFixture('after', {
    target: { siblingMatches: ['tla-approval-rejection-old.txt'] },
  })).failures, 'TARGET_SIBLING_CREATED'))
}

/* ---------------------------------------------------------------------------
 * C2. 复审点一：缺失/身份错配的指纹不得 PASS
 * ------------------------------------------------------------------------ */

function testStrictSnapshotValidation() {
  const baseline = judge()
  check('strict: baseline is PASS', baseline.machine.verdict === 'PASS' && baseline.final.verdict === 'PASS',
    JSON.stringify(baseline.machine))

  // 1) target 两边都是 null：绝不能因为"相等"就当作前后未变
  const noTarget = judge({ beforePatch: { target: null }, afterPatch: { target: null } })
  check('strict: target null => INCOMPLETE', noTarget.machine.verdict === 'INCOMPLETE',
    JSON.stringify(noTarget.machine))
  check('strict: target null => TARGET_UNMEASURED', has(noTarget.machine.incompletes, 'TARGET_UNMEASURED'))

  // 2) exists 两边都是 null
  const noExists = judge({ beforePatch: { target: { exists: null } }, afterPatch: { target: { exists: null } } })
  check('strict: exists null => TARGET_EXISTS_UNMEASURED', has(noExists.machine.incompletes, 'TARGET_EXISTS_UNMEASURED'))
  check('strict: exists null => not PASS', noExists.machine.verdict !== 'PASS')

  // 3) sessionId 两边都是 null
  const noId = judge({
    beforePatch: { identity: { sessionId: null } },
    afterPatch: { identity: { sessionId: null } },
  })
  check('strict: sessionId null => SNAPSHOT_IDENTITY_UNMEASURED',
    has(noId.machine.incompletes, 'SNAPSHOT_IDENTITY_UNMEASURED'))
  check('strict: sessionId null => not PASS', noId.machine.verdict !== 'PASS')

  // 4) 两份快照 sessionId 相同，但不是日志里那个会话
  const wrongSession = judge({
    beforePatch: { identity: { sessionId: 'session-other' } },
    afterPatch: { identity: { sessionId: 'session-other' } },
  })
  check('strict: foreign session => SNAPSHOT_SESSION_MISMATCH', has(wrongSession.machine.failures, 'SNAPSHOT_SESSION_MISMATCH'))
  check('strict: foreign session => FAIL', wrongSession.machine.verdict === 'FAIL')

  // 5) repo.root 两边都是 null
  const noRoot = judge({ beforePatch: { repo: { root: null } }, afterPatch: { repo: { root: null } } })
  check('strict: repo root null => REPO_ROOT_UNMEASURED', has(noRoot.machine.incompletes, 'REPO_ROOT_UNMEASURED'))
  check('strict: repo root null => not PASS', noRoot.machine.verdict !== 'PASS')

  // 6) 执行前目标已存在：前提不成立（不是"未变"）
  const existedBefore = judge({ beforePatch: { target: { exists: true } } })
  check('strict: target existed before => TARGET_EXISTED_BEFORE', has(existedBefore.machine.failures, 'TARGET_EXISTED_BEFORE'))
  check('strict: target existed before => FAIL', existedBefore.machine.verdict === 'FAIL')

  // 7) 仓库根与会话工作区不一致
  const wrongRepo = judge({ beforePatch: { repo: { root: 'C:\\other' } } })
  check('strict: repo != session cwd => REPO_NOT_SESSION_WORKSPACE', has(wrongRepo.machine.failures, 'REPO_NOT_SESSION_WORKSPACE'))

  // 8) 目标确实落在被测工作区内 / 名字不符合契约（约束由工具按路径重算）
  const insidePath = {
    path: 'C:\\repo\\tla-approval-rejection-test.txt',
    pathKey: 'c:\\repo\\tla-approval-rejection-test.txt',
    parent: 'C:\\repo',
    insideRepo: true,
  }
  const inside = judge({ beforePatch: { target: insidePath } })
  check('strict: target inside workspace => TARGET_INSIDE_WORKSPACE', has(inside.machine.failures, 'TARGET_INSIDE_WORKSPACE'))
  const badNamePath = { path: 'C:\\tmp\\notes.txt', pathKey: 'c:\\tmp\\notes.txt' }
  const badName = judge({ beforePatch: { target: badNamePath } })
  check('strict: target name off-contract => TARGET_NAME_NOT_IN_CONTRACT',
    has(badName.machine.failures, 'TARGET_NAME_NOT_IN_CONTRACT'))

  // 9) 目标范围本身没测到
  const noScope = judge({ beforePatch: { target: { insideRepo: null } }, afterPatch: { target: { insideRepo: null } } })
  check('strict: target scope unmeasured => TARGET_SCOPE_UNMEASURED', has(noScope.machine.incompletes, 'TARGET_SCOPE_UNMEASURED'))

  // 10) 前后快照时间倒序
  const reversed = judge({ afterPatch: { capturedAtMs: 500, capturedAt: '2026-10-17T05:00:01.000Z' } })
  check('strict: reversed time => not PASS', reversed.machine.verdict !== 'PASS')

  // 11) 快照里写好的约束被改过：路径在工作区内却写 insideRepo:false
  const tamperedScope = judge({ beforePatch: { target: { ...insidePath, insideRepo: false } } })
  check('strict: tampered insideRepo => TARGET_CONSTRAINT_TAMPERED',
    has(tamperedScope.machine.failures, 'TARGET_CONSTRAINT_TAMPERED'))
  check('strict: tampered insideRepo => still TARGET_INSIDE_WORKSPACE',
    has(tamperedScope.machine.failures, 'TARGET_INSIDE_WORKSPACE'))
  // 12) 名字不符合契约却写 nameMatchesContract:true
  const tamperedName = judge({ beforePatch: { target: { ...badNamePath, nameMatchesContract: true } } })
  check('strict: tampered nameMatchesContract => TARGET_CONSTRAINT_TAMPERED',
    has(tamperedName.machine.failures, 'TARGET_CONSTRAINT_TAMPERED'))

  // 13) 快照的 marker 不是本次审批的 marker（两份快照互相一致也不行）
  const foreignMarker = judge({
    beforePatch: { marker: '[tla-approval-rejection:9999]' },
    afterPatch: { marker: '[tla-approval-rejection:9999]' },
  })
  check('strict: foreign snapshot marker => SNAPSHOT_MARKER_NOT_BOUND',
    has(foreignMarker.machine.failures, 'SNAPSHOT_MARKER_NOT_BOUND'))
  check('strict: foreign snapshot marker => FAIL', foreignMarker.machine.verdict === 'FAIL')

  // 14) 内容指纹有文件被跳过：只能算部分证明
  const skippedScope = {
    repo: { contentScope: { skipped: [{ path: 'big.bin', reason: 'larger than 33554432 bytes' }] } },
  }
  const skipped = judge({ beforePatch: skippedScope, afterPatch: skippedScope })
  check('strict: skipped content => CONTENT_SCOPE_INCOMPLETE', has(skipped.machine.incompletes, 'CONTENT_SCOPE_INCOMPLETE'))
  check('strict: skipped content => INCOMPLETE not PASS', skipped.machine.verdict === 'INCOMPLETE')

  // 15) 快照采集区间没有围住审批：before 在 approval/asked 之后
  const lateBefore = judge({
    beforePatch: { capturedAtMs: BASE_MS + 30000, capturedAt: '2026-10-17T05:00:30.000Z' },
  })
  check('strict: before snapshot after the ask => SNAPSHOT_BEFORE_AFTER_APPROVAL',
    has(lateBefore.machine.failures, 'SNAPSHOT_BEFORE_AFTER_APPROVAL'))
  // 16) after 在 tool/result 之前
  const earlyAfterEvents = baseEvents()
  findEvent(earlyAfterEvents, 'tool/result').time = BASE_MS + 30000
  const earlyAfter = judge({
    events: earlyAfterEvents,
    afterPatch: { capturedAtMs: BASE_MS + 1500, capturedAt: '2026-10-17T05:00:01.500Z' },
  })
  check('strict: after snapshot before the result => SNAPSHOT_AFTER_BEFORE_RESULT',
    has(earlyAfter.machine.failures, 'SNAPSHOT_AFTER_BEFORE_RESULT'))

  // 17) 事件没有时间：区间无法对应，只能 INCOMPLETE
  const noEventTime = baseEvents()
  delete findEvent(noEventTime, 'approval/asked').time
  const noTime = judge({ events: noEventTime })
  check('strict: event time missing => EVENT_TIME_UNMEASURED', has(noTime.machine.incompletes, 'EVENT_TIME_UNMEASURED'))
  check('strict: event time missing => not PASS', noTime.machine.verdict !== 'PASS')
}

/* ---------------------------------------------------------------------------
 * C3. 复审点二：审批操作必须绑定到被观察的目标
 * ------------------------------------------------------------------------ */

function withCommand(command) {
  const events = baseEvents()
  const call = findEvent(events, 'tool/call')
  const args = JSON.parse(call.data.arguments)
  call.data.arguments = JSON.stringify({ ...args, command })
  return events
}

function testCommandBinding() {
  // 命令本身必须是排他创建：目标已存在时失败，而不是覆盖别人的证据文件。
  const canonical = writeBindingCommand(TARGET_PATH, MARKER)
  check('bind: canonical uses exclusive New-Item', /^New-Item -ItemType File -Path /.test(canonical), canonical)
  check('bind: canonical stops on error', canonical.includes('-ErrorAction Stop'), canonical)
  check('bind: canonical carries the marker', canonical.includes(MARKER), canonical)
  check('bind: canonical no longer overwrites', !canonical.includes('Set-Content'), canonical)

  const bound = judge({ events: withCommand(writeBindingCommand(TARGET_PATH, MARKER)) })
  check('bind: canonical command passes', bound.machine.verdict === 'PASS', JSON.stringify(bound.machine))

  // 审批指向 A、快照检查 B：命令里写的是另一个文件
  const otherTarget = 'C:\\tmp\\tla-approval-rejection-other.txt'
  const mismatch = judge({ events: withCommand(writeBindingCommand(otherTarget, MARKER)) })
  check('bind: command targets another file => APPROVAL_COMMAND_UNBOUND',
    has(mismatch.machine.failures, 'APPROVAL_COMMAND_UNBOUND'))
  check('bind: command mismatch => FAIL', mismatch.machine.verdict === 'FAIL')

  // 同一个 marker、操作内容不同（追加了别的动作）
  const padded = judge({
    events: withCommand(`${writeBindingCommand(TARGET_PATH, MARKER)}; Remove-Item -LiteralPath 'C:\\tmp\\x.txt'`),
  })
  check('bind: extra operation => APPROVAL_COMMAND_UNBOUND', has(padded.machine.failures, 'APPROVAL_COMMAND_UNBOUND'))

  // 缺命令字段：信息不足，只能 INCOMPLETE
  const noCommandEvents = baseEvents()
  const call = findEvent(noCommandEvents, 'tool/call')
  const args = JSON.parse(call.data.arguments)
  delete args.command
  call.data.arguments = JSON.stringify(args)
  const noCommand = judge({ events: noCommandEvents })
  check('bind: command missing => APPROVAL_COMMAND_UNMEASURED', has(noCommand.machine.incompletes, 'APPROVAL_COMMAND_UNMEASURED'))
  check('bind: command missing => INCOMPLETE not PASS', noCommand.machine.verdict === 'INCOMPLETE')

  // justification 里没有目标路径：人工在弹窗里看到的不是被检查的那个文件
  const noTargetInJustification = baseEvents()
  const call2 = findEvent(noTargetInJustification, 'tool/call')
  const args2 = JSON.parse(call2.data.arguments)
  args2.justification = `只写了 marker，没有写目标路径 ${MARKER}`
  call2.data.arguments = JSON.stringify(args2)
  const ask2 = findEvent(noTargetInJustification, 'approval/asked')
  ask2.data.reason = `escalate sandbox to danger-full-access: ${args2.justification}`
  const unstated = judge({ events: noTargetInJustification })
  check('bind: target absent from justification => TARGET_NOT_IN_JUSTIFICATION',
    has(unstated.machine.failures, 'TARGET_NOT_IN_JUSTIFICATION'))
}

/* ---------------------------------------------------------------------------
 * D. 真文件系统：内容指纹、取证目录排除、排他写入
 * ------------------------------------------------------------------------ */

const scratchDirs = []

/**
 * 临时目录放在仓库内唯一命名的 tests/.scratch/ 下（已被 .gitignore 忽略）。
 * 审查环境里系统临时目录可能不可写或不可初始化；放在这里能把"环境失败"变成
 * 一行清楚的前置失败，而不是后面五项莫名其妙的断言失败。
 */
function makeScratch(label) {
  const base = join(process.cwd(), 'tests', '.scratch')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `approval-${label}-`))
  scratchDirs.push(dir)
  return dir
}

function runGit(cwd, args) {
  const out = join(cwd, '.git-capture.txt')
  const fd = openSync(out, 'w')
  try {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    return { status: result.status, text: existsSync(out) ? readFileSync(out, 'utf8') : '' }
  } finally {
    closeSync(fd)
  }
}

function testFilesystemSnapshot() {
  const repo = makeScratch('repo')
  writeFileSync(join(repo, 'a.txt'), 'base\n', 'utf8')
  writeFileSync(join(repo, '.gitignore'), '.git-capture.txt\n', 'utf8')
  const init = runGit(repo, ['init', '-q'])
  // 前置失败要单独报清楚：否则后面的 HEAD/内容范围断言会级联成看不懂的失败。
  check('fs: git init exit 0', init.status === 0, `status=${init.status} stderr=${init.text}`)
  if (init.status !== 0) return
  runGit(repo, ['add', 'a.txt', '.gitignore'])
  const commit = runGit(repo, ['commit', '-q', '-m', 'base'])
  check('fs: temp git repo usable', commit.status === 0, `status=${commit.status} ${commit.text}`)
  if (commit.status !== 0) return
  const sessionArgs = ['--session-id', 'session-fs']

  const evidenceDir = join(repo, '.evidence')
  const target = join(makeScratch('target'), 'tla-approval-rejection-x.txt')

  // status 文本在两次快照里相同（都是 " M a.txt"），但字节不同
  writeFileSync(join(repo, 'a.txt'), 'variant-one\n', 'utf8')
  const before = callMain(['snapshot', '--target', target, '--dir', evidenceDir, '--run-id', 'run-fs',
    '--marker', MARKER, '--phase', 'before', '--repo', repo, ...sessionArgs])
  check('fs: snapshot before exit 0', before === 0, `exit=${before}`)

  // 取证目录排除
  const beforeState = JSON.parse(readFileSync(join(evidenceDir, 'state-before.json'), 'utf8'))
  check('fs: content scope measured', beforeState.repo.contentScope.ok === true)
  const excludedPaths = beforeState.repo.contentScope.excluded
  check('fs: evidence dir files excluded from content scope',
    excludedPaths.length > 0 && excludedPaths.every((rel) => rel === '.evidence' || rel.startsWith('.evidence/')),
    JSON.stringify(excludedPaths))
  check('fs: no evidence file leaks into the hashed set',
    Object.keys(beforeState.repo.contentScope.files).every((rel) => !rel.startsWith('.evidence/')),
    JSON.stringify(Object.keys(beforeState.repo.contentScope.files)))
  check('fs: content scope hashes tracked file', typeof beforeState.repo.contentScope.files['a.txt'] === 'string')

  // 排他写入：同一个 phase 再写一次必须被拒绝
  const duplicateSnapshot = callMain(['snapshot', '--target', target, '--dir', evidenceDir, '--run-id', 'run-fs',
    '--marker', MARKER, '--phase', 'before', '--repo', repo, ...sessionArgs])
  check('fs: snapshot refuses overwrite', duplicateSnapshot === 4, `exit=${duplicateSnapshot}`)

  writeFileSync(join(repo, 'a.txt'), 'variant-two\n', 'utf8')
  const after = callMain(['snapshot', '--target', target, '--dir', evidenceDir, '--run-id', 'run-fs',
    '--marker', MARKER, '--phase', 'after', '--repo', repo, ...sessionArgs])
  check('fs: snapshot after exit 0', after === 0, `exit=${after}`)

  const beforeState2 = JSON.parse(readFileSync(join(evidenceDir, 'state-before.json'), 'utf8'))
  const afterState = JSON.parse(readFileSync(join(evidenceDir, 'state-after.json'), 'utf8'))
  const compared = compareStates(beforeState2, afterState)
  check('fs: same status text', JSON.stringify(beforeState2.repo.statusEntries.value)
    === JSON.stringify(afterState.repo.statusEntries.value),
  `${JSON.stringify(beforeState2.repo.statusEntries.value)} vs ${JSON.stringify(afterState.repo.statusEntries.value)}`)
  check('fs: content change detected despite same status', has(compared.failures, 'WORKSPACE_CONTENT_CHANGED'),
    JSON.stringify(compared))

  // 路径大小写：Windows 上应归一
  check('fs: pathKey normalises case on win32',
    process.platform !== 'win32' || pathKeyOf('C:\\TMP\\A.TXT') === pathKeyOf('c:\\tmp\\a.txt'))
}

/* ---------------------------------------------------------------------------
 * E. CLI：verify 的三种最终结论
 * ------------------------------------------------------------------------ */

function writeEvidenceDir({ outcome = 'rejected', isError = true, human = 'yes' } = {}) {
  const dir = makeScratch('verify')
  const before = stateFixture('before')
  const after = stateFixture('after')
  writeFileSync(join(dir, 'state-before.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'state-after.json'), `${JSON.stringify(after, null, 2)}\n`, 'utf8')

  const events = baseEvents()
  findEvent(events, 'approval/decided').data.outcome = outcome
  findEvent(events, 'tool/result').data.message.isError = isError
  const correlation = correlateApproval(events, { marker: MARKER })
  writeFileSync(join(dir, 'approval-evidence.json'), `${JSON.stringify({
    schemaVersion: 3,
    sessionFile: '(synthetic)',
    decode: { frames: 1, badFrames: 0, badLines: 0 },
    correlation,
  }, null, 2)}\n`, 'utf8')

  if (human !== null) {
    writeFileSync(join(dir, 'human-observation.md'), `# 人工观察\n\nconfirmed_rejection: ${human}\n`, 'utf8')
  }
  return dir
}

function testCliVerify() {
  const human = makeScratch('human')
  writeFileSync(join(human, 'human-observation.md'), 'confirmed_rejection: yes\n', 'utf8')
  const observed = readHumanObservation(human)
  check('cli: reads human observation', observed.present && observed.confirmedRejection === true, JSON.stringify(observed))

  const blank = makeScratch('blank')
  writeFileSync(join(blank, 'human-observation.md'), 'confirmed_rejection: \n', 'utf8')
  check('cli: blank human observation incomplete', readHumanObservation(blank).issues.includes('HUMAN_OBSERVATION_INCOMPLETE'))

  const passDir = writeEvidenceDir()
  check('cli: verify rejected+human => exit 0',
    callMain(['verify', '--dir', passDir, '--run-id', 'run-1', '--marker', MARKER, '--from-files']) === 0)

  const failDir = writeEvidenceDir({ outcome: 'allowed-once', isError: false })
  check('cli: verify allowed => exit 1',
    callMain(['verify', '--dir', failDir, '--run-id', 'run-1', '--marker', MARKER, '--from-files']) === 1)

  const incompleteDir = writeEvidenceDir({ human: null })
  check('cli: verify without human => exit 3',
    callMain(['verify', '--dir', incompleteDir, '--run-id', 'run-1', '--marker', MARKER, '--from-files']) === 3)

  const noHumanNo = writeEvidenceDir({ human: 'no' })
  check('cli: verify human says no => exit 1',
    callMain(['verify', '--dir', noHumanNo, '--run-id', 'run-1', '--marker', MARKER, '--from-files']) === 1)

  const schemaDir = writeEvidenceDir()
  const stored = JSON.parse(readFileSync(join(schemaDir, 'approval-evidence.json'), 'utf8'))
  stored.schemaVersion = 1
  writeFileSync(join(schemaDir, 'approval-evidence.json'), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  check('cli: stale evidence schema => exit 4',
    callMain(['verify', '--dir', schemaDir, '--run-id', 'run-1', '--marker', MARKER, '--from-files']) === 4)

  check('cli: usage error exit 4', callMain(['verify', '--dir', passDir]) === 4)
  check('cli: unknown command exit 4', callMain(['frobnicate']) === 4)
}

/** 直接调用 main()，避免在沙箱里用管道捕获子进程输出（会 EPERM）。 */
function callMain(argv) {
  const originalWrite = process.stdout.write
  const originalError = process.stderr.write
  process.stdout.write = () => true
  process.stderr.write = () => true
  try {
    return main(argv, { repoRoot: process.cwd() })
  } finally {
    process.stdout.write = originalWrite
    process.stderr.write = originalError
  }
}

/* ---------------------------------------------------------------------------
 * 运行
 * ------------------------------------------------------------------------ */

testDecoding()
testJudgeBaseline()
testJudgeDecisionVariants()
testJudgeAskVariants()
testJudgeToolCallVariants()
testJudgeToolResultVariants()
testJudgeOrdering()
testJudgePolicyScope()
testStateComparison()
testStrictSnapshotValidation()
testCommandBinding()
testFilesystemSnapshot()
testCliVerify()

for (const dir of scratchDirs) {
  rmSync(dir, { recursive: true, force: true })
}

const total = passed + failures.length
process.stdout.write(`approval-rejection-evidence: ${passed}/${total} assertions passed\n`)
if (failures.length > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((text) => `  - ${text}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.exitCode = 0
}
