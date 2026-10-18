#!/usr/bin/env node
/**
 * 反向验证（最小变异检查）：把 v1 的判定规则原样冻结在这里，用同一批缺陷用例
 * 同时喂给 v1 与 v2，确认 v2 修掉的漏洞确实是 v1 会放过的。
 *
 * 为什么不直接"跑旧文件"：v1 未提交、随时会被覆盖。把它的判定逻辑冻结成本文件的
 * 一个函数，才能长期复现"旧行为"。
 *
 * 分类口径（只认判定结论，不认措辞）：
 *   误放行   v1 PASS，v2 不是 PASS（应该被拦住的被放过了）
 *   误拒绝   v1 不是 PASS，v2 PASS（不该拦的被拦了）
 *   状态不符 两边都不是 PASS，但理由不同（v2 抓的是另一条缺陷）
 *   无差异   两边结论与失败码一致
 *
 * 运行：node tests/approval-evidence-mutation.test.mjs
 */

import {
  compareStates,
  correlateApproval,
  judgeMachineEvidence,
  writeBindingCommand,
} from '../tools/approval-rejection-evidence.mjs'

const TOOL_PATH = 'tools/approval-rejection-evidence.mjs'
const MARKER = '[tla-approval-rejection:11111111-2222-3333-4444-555555555555]'
const TARGET_PATH = 'C:\\tmp\\tla-approval-rejection-test.txt'
const JUSTIFICATION = `测试用无害写入：向 ${TARGET_PATH} 写入一个标记文件，用来验证人工拒绝会真的拦住操作 ${MARKER}`
const REASON = `escalate sandbox to danger-full-access: ${JUSTIFICATION}`
const CALL_ID = 'call_00_SYNTHETIC_0001'
const ASK_ID = 'ask-id-0001'
/** 快照 before 的采集时刻；审批事件时间锚在它之后。 */
const BASE_MS = Date.parse('2026-10-17T05:00:00.000Z')

/* ---------------------------------------------------------------------------
 * v1 的判定规则（冻结副本，故意保留其缺陷）
 * ------------------------------------------------------------------------ */

function compareStatesV1(before, after) {
  const failures = []
  if (after.target?.exists) failures.push('TARGET_CREATED')
  if (before.repo?.head !== after.repo?.head) failures.push('WORKSPACE_HEAD_CHANGED')
  const beforeStatus = (before.repo?.statusEntries ?? []).join('\n')
  const afterStatus = (after.repo?.statusEntries ?? []).join('\n')
  if (beforeStatus !== afterStatus) failures.push('WORKSPACE_CHANGED')
  if (JSON.stringify(before.repo?.remoteRefs ?? {}) !== JSON.stringify(after.repo?.remoteRefs ?? {})) {
    failures.push('REMOTE_REF_CHANGED')
  }
  if (JSON.stringify(before.manifests ?? {}) !== JSON.stringify(after.manifests ?? {})) {
    failures.push('DEPS_CHANGED')
  }
  if (before.permissions?.status === 'measured' && after.permissions?.status === 'measured'
    && before.permissions.sddl !== after.permissions.sddl) {
    failures.push('PERMISSIONS_CHANGED')
  }
  return failures
}

/**
 * v2 的指纹比较（[C06] 版本，冻结副本）。它只在"值存在且不等"时报失败：
 * 两个 null、两个 undefined、以及与日志无关的会话 id 都会被当成"前后未变"。
 */
function compareStatesV2(before, after) {
  const failures = []
  const incompletes = []
  if (before.target?.pathKey !== after.target?.pathKey) failures.push('SNAPSHOT_TARGET_MISMATCH')
  const rootOf = (value) => (typeof value === 'string' ? value.toLowerCase() : '.')
  if (rootOf(before.repo?.root) !== rootOf(after.repo?.root)) failures.push('SNAPSHOT_REPO_MISMATCH')
  if ((before.identity?.sessionId ?? null) !== (after.identity?.sessionId ?? null)) {
    failures.push('SNAPSHOT_IDENTITY_MISMATCH')
  }
  if (after.target?.exists) failures.push('TARGET_CREATED')
  return { verdict: failures.length > 0 ? 'FAIL' : (incompletes.length > 0 ? 'INCOMPLETE' : 'PASS'), failures, incompletes }
}

function judgeV1({ evidence, before, after, marker }) {
  const failures = []
  const meta = evidence.sessionMeta
  if (!meta) failures.push('SESSION_META_MISSING')
  else {
    if (meta.parentSession) failures.push('SUBAGENT_SESSION')
    if (typeof meta.delegationDepth === 'number' && meta.delegationDepth > 0) failures.push('SUBAGENT_SESSION')
  }
  if (evidence.approvalPolicies.includes('never')) failures.push('POLICY_NEVER')

  if (evidence.asks.length === 0) failures.push('NO_APPROVAL_REQUESTED')
  if (evidence.asks.length > 1) failures.push('MULTIPLE_APPROVAL_REQUESTS')

  const ask = evidence.asks[0] ?? null
  let argumentObject = {}
  try {
    argumentObject = JSON.parse(evidence.toolCalls[0]?.arguments ?? '') ?? {}
  } catch {
    argumentObject = {}
  }
  if (!ask) {
    failures.push('APPROVAL_ASK_MISSING')
  } else {
    if (typeof ask.reason !== 'string' || !ask.reason.startsWith('escalate sandbox to danger-full-access: ')) {
      failures.push('REASON_PREFIX_MISSING')
    }
    if (marker && typeof ask.reason === 'string' && !ask.reason.includes(marker)) {
      failures.push('MARKER_MISMATCH')
    }
    if (argumentObject.sandbox_permissions !== 'danger-full-access') {
      failures.push('ESCALATION_NOT_REQUESTED')
    }
    if (typeof argumentObject.justification === 'string' && typeof ask.reason === 'string'
      && ask.reason !== `escalate sandbox to danger-full-access: ${argumentObject.justification}`) {
      failures.push('REASON_JUSTIFICATION_MISMATCH')
    }
  }

  if (!ask?.decided) {
    failures.push('DECISION_MISSING')
  } else if (ask.decided.outcome === 'allowed-once') {
    failures.push('DECISION_NOT_REJECTED')
  } else if (ask.decided.outcome !== 'rejected') {
    failures.push(`DECISION_${String(ask.decided.outcome ?? 'MISSING').toUpperCase()}`)
  }

  const result = evidence.toolResults[0] ?? null
  if (!result) failures.push('TOOL_RESULT_MISSING')
  else if (result.isError === false) failures.push('TOOL_SUCCEEDED_WITHOUT_DENIAL')

  failures.push(...compareStatesV1(before, after))
  if ((before.target?.siblingMatches ?? []).length > 0) failures.push('TARGET_SIBLING_PREEXISTS')
  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', failures }
}

/** 把事件流按 v1 的抽取方式还原成 v1 的 evidence 形状。 */
function evidenceV1(events, marker) {
  const asks = events.filter((event) => event.type === 'approval/asked'
    && typeof event.data?.reason === 'string' && event.data.reason.includes(marker))
  const effectiveCallId = asks[0]?.data?.callId ?? null
  const decidedById = new Map()
  for (const event of events) {
    if (event.type !== 'approval/decided') continue
    if (typeof event.data?.id === 'string') decidedById.set(event.data.id, event)
  }
  const session = events.find((event) => event.type === 'session')
  return {
    sessionMeta: session
      ? {
        id: session.id ?? null,
        parentSession: session.parentSession ?? null,
        delegationDepth: typeof session.delegationDepth === 'number' ? session.delegationDepth : null,
      }
      : null,
    approvalPolicies: events.filter((event) => event.type === 'approval/policy')
      .map((event) => event.data?.policy).filter(Boolean),
    says: undefined,
    effectiveCallId,
    asks: asks.map((event) => ({
      id: event.data?.id ?? null,
      toolName: event.data?.toolName ?? null,
      callId: event.data?.callId ?? null,
      reason: event.data?.reason ?? null,
      decided: decidedById.has(event.data?.id)
        ? { outcome: decidedById.get(event.data.id).data?.outcome ?? null }
        : null,
    })),
    toolCalls: events.filter((event) => event.type === 'tool/call' && event.data?.callId === effectiveCallId)
      .map((event) => ({
        callId: event.data?.callId ?? null,
        name: event.data?.name ?? null,
        arguments: event.data?.arguments ?? null,
      })),
    toolResults: events.filter((event) => event.type === 'tool/result'
      && event.data?.message?.toolCallId === effectiveCallId)
      .map((event) => ({
        toolCallId: event.data?.message?.toolCallId ?? null,
        isError: event.data?.message?.isError ?? null,
        text: (event.data?.message?.content ?? []).map((part) => part?.text ?? '').join('\n'),
      })),
  }
}

/** v1 的扁平指纹形状（等于 v1 从同样的观测里会写出来的东西）。 */
function toV1(state) {
  return {
    target: { exists: state.target.exists, siblingMatches: state.target.siblingMatches },
    repo: {
      head: state.repo.head.ok ? state.repo.head.value : null,
      statusEntries: state.repo.statusEntries.ok ? state.repo.statusEntries.value : [],
      remoteRefs: state.repo.localRemoteTrackingRefs.ok ? state.repo.localRemoteTrackingRefs.value : {},
    },
    manifests: state.manifests.ok ? state.manifests.value : {},
    permissions: state.permissions,
  }
}

/* ---------------------------------------------------------------------------
 * 合成数据（与主回归同构，刻意保持独立以便任何一边改动都能被发现）
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
        callId: CALL_ID,
        name: 'pwsh',
        arguments: JSON.stringify({
          command: writeBindingCommand(TARGET_PATH, MARKER),
          sandbox_permissions: 'danger-full-access',
          justification: JUSTIFICATION,
        }),
      },
    },
    { type: 'approval/asked', seq: 11, time: BASE_MS + 2000, data: { id: ASK_ID, toolName: 'pwsh', callId: CALL_ID, reason: REASON } },
    { type: 'approval/decided', seq: 12, time: BASE_MS + 3000, data: { id: ASK_ID, outcome: 'rejected' } },
    {
      type: 'tool/result',
      seq: 13,
      time: BASE_MS + 4000,
      data: {
        message: {
          source: { kind: 'tool', callId: CALL_ID },
          toolCallId: CALL_ID,
          content: [{ type: 'text', text: 'Denied by user. The operation was not executed.' }],
          isError: true,
        },
      },
    },
  ]
}

function event(events, type) {
  const found = events.find((item) => item.type === type)
  if (!found) throw new Error(`missing ${type}`)
  return found
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
      head: { ok: true, value: 'abc123' },
      statusEntries: { ok: true, value: [] },
      contentScope: { ok: true, aggregate: 'sha256:aaaa', files: { 'a.txt': 'sha256:1111' }, skipped: [] },
      localRemoteTrackingRefs: { ok: true, value: { 'refs/remotes/origin/main': 'abc123' } },
      remoteObserved: false,
    },
    manifests: { ok: true, value: { 'package.json': 'sha256:9999' } },
    permissions: { status: 'measured', parent: 'C:\\tmp', sddl: 'O:SYG:SYD:(A;;FA;;;WD)' },
    identity: { sessionId: 'session-synthetic' },
  }
  const output = { ...base, ...patch }
  output.target = patch.target === null ? null : { ...base.target, ...(patch.target ?? {}) }
  output.repo = patch.repo === null ? null : { ...base.repo, ...(patch.repo ?? {}) }
  for (const key of ['head', 'statusEntries', 'contentScope', 'localRemoteTrackingRefs']) {
    if (patch.repo && patch.repo[key]) output.repo[key] = { ...base.repo[key], ...patch.repo[key] }
  }
  output.manifests = { ...base.manifests, ...(patch.manifests ?? {}) }
  output.permissions = { ...base.permissions, ...(patch.permissions ?? {}) }
  output.identity = { ...base.identity, ...(patch.identity ?? {}) }
  return output
}

function runCase(testCase) {
  const events = testCase.build ? testCase.build() : baseEvents()
  const before = stateFixture('before', testCase.beforePatch)
  const after = stateFixture('after', testCase.afterPatch)

  const v1 = judgeV1({ evidence: evidenceV1(events, MARKER), before: toV1(before), after: toV1(after), marker: MARKER })
  const correlation = correlateApproval(events, { marker: MARKER })
  const v2 = judgeMachineEvidence({ correlation, before, after, marker: MARKER })

  let classification = '无差异'
  const v1Primary = v1.failures[0] ?? null
  const v2Primary = v2.failures[0] ?? v2.incompletes[0] ?? null
  if (v1.verdict === 'PASS' && v2.verdict !== 'PASS') classification = '误放行'
  else if (v1.verdict !== 'PASS' && v2.verdict === 'PASS') classification = '误拒绝'
  else if (v1.verdict !== v2.verdict) classification = '状态不符'
  else if (v1Primary !== v2Primary) classification = '状态不符'

  return { v1, v2, classification, v2Primary }
}

/* ---------------------------------------------------------------------------
 * 用例表
 * ------------------------------------------------------------------------ */

const cases = [
  {
    name: 'clean rejection',
    expectClass: '无差异',
    expectV2: null,
  },
  {
    name: 'permissions unmeasured on both sides',
    beforePatch: { permissions: { status: 'unmeasured', reason: 'acl failed' } },
    afterPatch: { permissions: { status: 'unmeasured', reason: 'acl failed' } },
    expectClass: '误放行',
    expectV2: 'PERMISSIONS_UNMEASURED',
  },
  {
    name: 'head unmeasured on both sides',
    beforePatch: { repo: { head: { ok: false, value: null } } },
    afterPatch: { repo: { head: { ok: false, value: null } } },
    expectClass: '误放行',
    expectV2: 'HEAD_UNMEASURED',
  },
  {
    name: 'same status text but different content',
    afterPatch: { repo: { contentScope: { aggregate: 'sha256:bbbb', files: { 'a.txt': 'sha256:2222' } } } },
    expectClass: '误放行',
    expectV2: 'WORKSPACE_CONTENT_CHANGED',
  },
  {
    name: 'tool result without isError',
    build: () => {
      const events = baseEvents()
      delete event(events, 'tool/result').data.message.isError
      return events
    },
    expectClass: '误放行',
    expectV2: 'TOOL_RESULT_ISERROR_MISSING',
  },
  {
    name: 'tool result with empty text',
    build: () => {
      const events = baseEvents()
      event(events, 'tool/result').data.message.content = [{ type: 'text', text: '' }]
      return events
    },
    expectClass: '误放行',
    expectV2: 'TOOL_RESULT_TEXT_EMPTY',
  },
  {
    name: 'snapshots from two different runs',
    afterPatch: { runId: 'run-2' },
    expectClass: '误放行',
    expectV2: 'SNAPSHOT_RUN_MISMATCH',
  },
  {
    name: 'snapshots of two different targets',
    afterPatch: { target: { path: 'C:\\tmp\\other.txt', pathKey: 'c:\\tmp\\other.txt' } },
    expectClass: '误放行',
    expectV2: 'SNAPSHOT_TARGET_MISMATCH',
  },
  {
    name: 'after snapshot taken before the before snapshot',
    beforePatch: { capturedAtMs: 9000 },
    expectClass: '误放行',
    expectV2: 'SNAPSHOT_TIME_INCONSISTENT',
  },
  {
    name: 'duplicate decision for the same approval id',
    build: () => {
      const events = baseEvents()
      events.push({ type: 'approval/decided', seq: 14, data: { id: ASK_ID, outcome: 'rejected' } })
      return events
    },
    expectClass: '误放行',
    expectV2: 'DUPLICATE_DECISION',
  },
  {
    name: 'tool result recorded before the decision',
    build: () => {
      const events = baseEvents()
      event(events, 'tool/result').seq = 11.5
      return events
    },
    expectClass: '误放行',
    expectV2: 'ORDER_RESULT_BEFORE_DECISION',
  },
  {
    name: 'tool call missing entirely',
    build: () => baseEvents().filter((item) => item.type !== 'tool/call'),
    expectClass: '状态不符',
    expectV2: 'TOOL_CALL_MISSING',
  },
  {
    name: 'marker present in reason but not in justification',
    build: () => {
      const events = baseEvents()
      const call = event(events, 'tool/call')
      const args = JSON.parse(call.data.arguments)
      args.justification = '写入一个测试文件，用来验证人工拒绝会真的拦住操作'
      call.data.arguments = JSON.stringify(args)
      return events
    },
    expectClass: '状态不符',
    expectV2: 'MARKER_NOT_IN_JUSTIFICATION',
  },
  {
    name: 'snapshot marker does not match the verification marker',
    afterPatch: { marker: '[tla-approval-rejection:9999]' },
    expectClass: '误放行',
    expectV2: 'SNAPSHOT_MARKER_MISMATCH',
  },
  {
    name: 'policy never appears only after the decision',
    build: () => {
      const events = baseEvents()
      events.push({ type: 'approval/policy', seq: 100, data: { policy: 'never' } })
      return events
    },
    expectClass: '误拒绝',
    expectV2: null,
  },
  {
    name: 'unknown decision outcome timeout',
    build: () => {
      const events = baseEvents()
      event(events, 'approval/decided').data.outcome = 'timeout'
      return events
    },
    expectClass: '状态不符',
    expectV2: 'DECISION_UNKNOWN_OUTCOME:timeout',
  },
  {
    name: 'human allowed the operation',
    build: () => {
      const events = baseEvents()
      event(events, 'approval/decided').data.outcome = 'allowed-once'
      return events
    },
    expectClass: '无差异',
    expectV2: 'DECISION_NOT_REJECTED',
  },
  {
    name: 'operation actually succeeded',
    build: () => {
      const events = baseEvents()
      event(events, 'tool/result').data.message.isError = false
      return events
    },
    expectClass: '无差异',
    expectV2: 'TOOL_SUCCEEDED_WITHOUT_DENIAL',
  },
]

/* ---------------------------------------------------------------------------
 * 复审点一：v2 的"缺失值相等即未变"必须被 v3 拦住
 * ------------------------------------------------------------------------ */

const strictCases = [
  { name: 'target null on both sides', beforePatch: { target: null }, afterPatch: { target: null }, expectV2: 'PASS', expectV3: 'TARGET_UNMEASURED' },
  { name: 'target.exists null on both sides', beforePatch: { target: { exists: null } }, afterPatch: { target: { exists: null } }, expectV2: 'PASS', expectV3: 'TARGET_EXISTS_UNMEASURED' },
  { name: 'sessionId null on both sides', beforePatch: { identity: { sessionId: null } }, afterPatch: { identity: { sessionId: null } }, expectV2: 'PASS', expectV3: 'SNAPSHOT_IDENTITY_UNMEASURED' },
  { name: 'repo root null on both sides', beforePatch: { repo: { root: null } }, afterPatch: { repo: { root: null } }, expectV2: 'PASS', expectV3: 'REPO_ROOT_UNMEASURED' },
  { name: 'target existed before snapshot', beforePatch: { target: { exists: true } }, expectV2: 'PASS', expectV3: 'TARGET_EXISTED_BEFORE' },
  { name: 'snapshots belong to a foreign session', beforePatch: { identity: { sessionId: 'session-other' } }, afterPatch: { identity: { sessionId: 'session-other' } }, expectV2: 'PASS', expectV3: 'SNAPSHOT_SESSION_MISMATCH' },
  { name: 'approval points at another file', commandTarget: 'C:\\tmp\\tla-approval-rejection-other.txt', expectV2: 'PASS', expectV3: 'APPROVAL_COMMAND_UNBOUND' },
  { name: 'snapshot marker is not the approval marker', beforePatch: { marker: '[tla-approval-rejection:9999]' }, afterPatch: { marker: '[tla-approval-rejection:9999]' }, expectV2: 'PASS', expectV3: 'SNAPSHOT_MARKER_NOT_BOUND' },
  { name: 'content scope skipped files', beforePatch: { repo: { contentScope: { skipped: [{ path: 'big.bin', reason: 'larger than 33554432 bytes' }] } } }, afterPatch: { repo: { contentScope: { skipped: [{ path: 'big.bin', reason: 'larger than 33554432 bytes' }] } } }, expectV2: 'PASS', expectV3: 'CONTENT_SCOPE_INCOMPLETE' },
  { name: 'target name claimed on-contract but is not', beforePatch: { target: { path: 'C:\\tmp\\notes.txt', pathKey: 'c:\\tmp\\notes.txt', nameMatchesContract: true } }, afterPatch: { target: { path: 'C:\\tmp\\notes.txt', pathKey: 'c:\\tmp\\notes.txt', nameMatchesContract: true } }, expectV2: 'PASS', expectV3: 'TARGET_CONSTRAINT_TAMPERED' },
  { name: 'before snapshot taken after the approval request', beforePatch: { capturedAtMs: BASE_MS + 30000, capturedAt: '2026-10-17T05:00:30.000Z' }, expectV2: 'PASS', expectV3: 'SNAPSHOT_BEFORE_AFTER_APPROVAL' },
]

const strictFailures = []
process.stdout.write('\ncase | v2-snapshot | v3 | expected\n')
process.stdout.write('--- | --- | --- | ---\n')
for (const [position, testCase] of strictCases.entries()) {
  const before = stateFixture('before', testCase.beforePatch)
  const after = stateFixture('after', testCase.afterPatch)
  const events = baseEvents()
  if (testCase.commandTarget) {
    const call = event(events, 'tool/call')
    const args = JSON.parse(call.data.arguments)
    call.data.arguments = JSON.stringify({ ...args, command: writeBindingCommand(testCase.commandTarget, MARKER) })
  }
  const v2 = compareStatesV2(before, after)
  const correlation = correlateApproval(events, { marker: MARKER })
  const v3 = judgeMachineEvidence({ correlation, before, after, marker: MARKER })
  const primary = v3.failures[0] ?? v3.incompletes[0] ?? null
  process.stdout.write(`${position + 1}. ${testCase.name} | ${v2.verdict} | ${v3.verdict}(${primary}) | ${testCase.expectV2} -> ${testCase.expectV3}\n`)
  if (v2.verdict !== testCase.expectV2) strictFailures.push(`${testCase.name}: expected v2 ${testCase.expectV2}, got ${v2.verdict}`)
  if (v3.verdict === 'PASS') strictFailures.push(`${testCase.name}: v3 must not PASS`)
  if (![...v3.failures, ...v3.incompletes].includes(testCase.expectV3)) {
    strictFailures.push(`${testCase.name}: expected v3 ${testCase.expectV3}, got ${JSON.stringify([...v3.failures, ...v3.incompletes])}`)
  }
}

/* ---------------------------------------------------------------------------
 * 运行
 * ------------------------------------------------------------------------ */

const failures = []
let index = 0
process.stdout.write('case | v1 | v2 | class | expected\n')
process.stdout.write('--- | --- | --- | --- | ---\n')
for (const testCase of cases) {
  index += 1
  const result = runCase(testCase)
  const v2Label = result.v2.verdict === 'PASS' ? 'PASS' : `${result.v2.verdict}(${result.v2Primary})`
  const v1Label = result.v1.verdict === 'PASS' ? 'PASS' : `FAIL(${result.v1.failures[0] ?? ''})`
  process.stdout.write(`${index}. ${testCase.name} | ${v1Label} | ${v2Label} | ${result.classification} | ${testCase.expectClass}\n`)

  if (result.classification !== testCase.expectClass) {
    failures.push(`case ${index} (${testCase.name}): expected ${testCase.expectClass}, got ${result.classification}`)
  }
  if (testCase.expectV2 && result.v2Primary !== testCase.expectV2) {
    failures.push(`case ${index} (${testCase.name}): expected v2 ${testCase.expectV2}, got ${result.v2Primary}`)
  }
  if (testCase.expectV2 === null && result.v2.verdict === 'FAIL') {
    failures.push(`case ${index} (${testCase.name}): v2 unexpectedly FAIL ${JSON.stringify(result.v2.failures)}`)
  }
}

const tally = cases.reduce((acc, testCase, position) => {
  const { classification } = runCase(testCase)
  acc[classification] = (acc[classification] ?? 0) + (position >= 0 ? 1 : 0)
  return acc
}, {})

process.stdout.write(`\ntally: ${JSON.stringify(tally)}\n`)
process.stdout.write(`strict: ${strictCases.length - strictFailures.length}/${strictCases.length} v2->v3 cases as expected\n`)
for (const text of strictFailures) failures.push(`strict: ${text}`)
process.stdout.write(`approval-evidence-mutation: ${cases.length - failures.length}/${cases.length} cases as expected\n`)
if (failures.length > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((text) => `  - ${text}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.exitCode = 0
}
