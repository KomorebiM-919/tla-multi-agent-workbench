// Minimal synthetic inputs for the round-4 P2 diagnostic regression.
// No process, host, model or filesystem observation is involved.
// The schema string is intentionally local to this package so the runner can
// point at any independent copy of the reviewed core without a Git checkout.

export const ROOT = 'C:/fixture/project'
export const BINDING = Object.freeze({
  runnerRunId: 'exp-fixture',
  gateRunId: 'tla-fixture',
  budgetRunId: 'tla-fixture',
})
export const PROTOCOL_SCHEMA = 'tla.observation-protocol/v1'

export const b64 = text => Buffer.from(text, 'utf8').toString('base64')
export const ORIGINAL = 'export const sum = null;\r\n'
export const BROKEN = 'export const sum = () => 4;\n'
export const FIXED = 'export const sum = xs => xs.reduce((a, b) => a + b, 0);\n'
export const FIXED2 = 'export const sum = xs => xs.reduce((a, b) => a + b, 0) + 0;\n'
export const EXTRA0 = 'export const extra = null;\r\n'
export const EXTRA1 = 'export const extra = 1;\n'
export const OTHER0 = 'export const other = null;\r\n'
export const OTHER1 = 'export const other = 1;\n'

function newDocument() {
  return {
    schema: PROTOCOL_SCHEMA,
    origin: 'synthetic',
    binding: { ...BINDING },
    projectRoot: ROOT,
    observer: { id: 'fixture-observer', ordering: 'serial-total', complete: true },
    sessions: [
      { id: 'captain', role: 'captain' },
      { id: 'worker', role: 'worker' },
      { id: 'reviewer', role: 'reviewer' },
    ],
    runner: { runId: BINDING.runnerRunId, status: 'completed', hostStarted: true },
    ledger: {
      gateRunId: BINDING.gateRunId,
      budgetRunId: BINDING.budgetRunId,
      completeness: 'COMPLETE',
      ledgerConsistent: true,
    },
    operations: [],
  }
}

function resequence(doc) {
  doc.operations.forEach((op, index) => {
    op.order.call = index * 2
    op.order.result = index * 2 + 1
  })
  return doc
}

function makeFlow({ prefix = '', path = 'src/sum.mjs', withRepair = true } = {}) {
  const doc = newDocument()
  const task = suffix => prefix + suffix

  function add(sessionId, name, input, observation, isError = false) {
    const n = doc.operations.length
    const id = `${prefix}c${n}`
    doc.operations.push({
      runId: BINDING.gateRunId,
      sessionId,
      call: { id, name, input },
      result: { toolUseId: id, isError, complete: true },
      order: { authority: 'fixture-observer', call: n * 2, result: n * 2 + 1 },
      observation,
    })
  }

  function create(taskId, kind, assignee, sourceTaskId = null, reviewedTaskId = null) {
    const subject = `${kind} sum`
    add('captain', 'agent_teams_create_task',
      { subject, kind, assignee, sourceTaskId, reviewedTaskId },
      { type: 'task-create', taskId, subject, taskKind: kind, assignee, sourceTaskId, reviewedTaskId })
  }

  function claim(taskId, sessionId) {
    add(sessionId, 'agent_teams_claim_task', { task_id: taskId },
      { type: 'task-claim', taskId, attemptId: `a-${taskId}` })
  }

  function update(taskId, sessionId, status) {
    add(sessionId, 'agent_teams_update_task', { task_id: taskId, attempt_id: `a-${taskId}`, status },
      { type: 'task-update', taskId, attemptId: `a-${taskId}`, status })
  }

  function start(taskId, sessionId) {
    claim(taskId, sessionId)
    update(taskId, sessionId, 'in_progress')
  }

  function file(taskId, kind, filePath, text, before, sessionId = 'worker') {
    const observation = {
      type: `file-${kind}`,
      taskId,
      attemptId: `a-${taskId}`,
      path: filePath.replaceAll('/', '\\'),
      fileKind: 'regular',
      links: 'none',
      coverage: 'full',
      bytesBase64: b64(text),
    }
    const input = { file_path: filePath }
    if (kind === 'write') {
      observation.beforeBase64 = b64(before)
      input.content = text
    }
    add(sessionId, kind === 'write' ? 'write' : 'read', input, observation)
  }

  function test(taskId, red) {
    const command = 'node test/sum.test.mjs'
    add('worker', 'pwsh', { command, description: 'Run the synthetic test suite' }, {
      type: 'test',
      taskId,
      attemptId: `a-${taskId}`,
      command,
      cwd: '.',
      exitCode: red ? 1 : 0,
      stdoutBase64: b64(`sum tests: ${red ? 2 : 3} passed, ${red ? 1 : 0} failed\n`),
      suitePath: 'test/sum.test.mjs',
      suiteBase64: b64('// invented stable suite bytes\r\n'),
    }, red)
  }

  function review(taskId, reviewedTaskId, verdict, { readPath = path, readText = verdict === 'needs_revision' ? BROKEN : FIXED } = {}) {
    file(taskId, 'read', readPath, readText, undefined, 'reviewer')
    add('reviewer', 'agent_teams_update_task',
      { task_id: taskId, attempt_id: `a-${taskId}`, status: 'completed', verdict },
      { type: 'review', taskId, attemptId: `a-${taskId}`, reviewedTaskId, verdict })
  }

  const t1 = task('t1')
  const t2 = task('t2')
  const t3 = task('t3')
  const t4 = task('t4')

  create(t1, 'work', 'worker')
  start(t1, 'worker')
  file(t1, 'read', path, ORIGINAL)
  file(t1, 'write', path, BROKEN, ORIGINAL)
  file(t1, 'read', path, BROKEN)
  test(t1, true)
  update(t1, 'worker', 'completed')

  create(t2, 'review', 'reviewer', null, t1)
  start(t2, 'reviewer')
  review(t2, t1, 'needs_revision', { readText: BROKEN })

  if (withRepair) {
    create(t3, 'repair', 'worker', t1)
    start(t3, 'worker')
    file(t3, 'read', path, BROKEN)
    file(t3, 'write', path, FIXED, BROKEN)
    file(t3, 'read', path, FIXED)
    test(t3, false)
    update(t3, 'worker', 'completed')

    create(t4, 'review', 'reviewer', null, t3)
    start(t4, 'reviewer')
    review(t4, t3, 'passed', { readText: FIXED })
  }

  return {
    doc,
    task,
    create,
    claim,
    update,
    start,
    file,
    test,
    review,
  }
}

function baseWithoutRepair(options = {}) {
  return makeFlow({ ...options, withRepair: false })
}

function addExtraRepair(api, taskId, sourceTaskId) {
  api.create(taskId, 'repair', 'worker', sourceTaskId)
  api.start(taskId, 'worker')
  api.file(taskId, 'read', 'src/extra.mjs', EXTRA0)
  api.file(taskId, 'write', 'src/extra.mjs', EXTRA1, EXTRA0)
  api.file(taskId, 'read', 'src/extra.mjs', EXTRA1)
}

function closeWithRepair(api, taskId, sourceTaskId, reviewTaskId, path = 'src/sum.mjs', baseText = BROKEN, nextText = FIXED) {
  api.create(taskId, 'repair', 'worker', sourceTaskId)
  api.start(taskId, 'worker')
  api.file(taskId, 'read', path, baseText)
  api.file(taskId, 'write', path, nextText, baseText)
  api.file(taskId, 'read', path, nextText)
  api.test(taskId, false)
  api.update(taskId, 'worker', 'completed')

  api.create(reviewTaskId, 'review', 'reviewer', null, taskId)
  api.start(reviewTaskId, 'reviewer')
  api.review(reviewTaskId, taskId, 'passed', { readPath: path, readText: nextText })
}

function makeIncompleteRepairScenario() {
  const flow = baseWithoutRepair()
  addExtraRepair(flow, flow.task('t3'), flow.task('t1'))
  // The newer repair closes the chain; the older repair keeps its extra write
  // but never completes and is therefore outside every closure chain.
  closeWithRepair(flow, flow.task('t5'), flow.task('t1'), flow.task('t4'))
  return resequence(flow.doc)
}

function makeFailedRepairScenario() {
  const flow = baseWithoutRepair()
  addExtraRepair(flow, flow.task('t3'), flow.task('t1'))
  flow.update(flow.task('t3'), 'worker', 'failed')
  closeWithRepair(flow, flow.task('t5'), flow.task('t1'), flow.task('t4'))
  return resequence(flow.doc)
}

function makeSupersededRejectionScenario() {
  const flow = baseWithoutRepair()
  addExtraRepair(flow, flow.task('t3'), flow.task('t1'))

  const t6 = flow.task('t6')
  flow.create(t6, 'review', 'reviewer', null, flow.task('t1'))
  flow.start(t6, 'reviewer')
  flow.review(t6, flow.task('t1'), 'needs_revision', { readText: BROKEN })

  closeWithRepair(flow, flow.task('t7'), flow.task('t1'), flow.task('t8'))
  return resequence(flow.doc)
}

function makeMultiPathScenario() {
  const flow = baseWithoutRepair()
  const t3 = flow.task('t3')
  flow.create(t3, 'repair', 'worker', flow.task('t1'))
  flow.start(t3, 'worker')
  flow.file(t3, 'read', 'src/sum.mjs', BROKEN)
  flow.file(t3, 'read', 'src/extra.mjs', EXTRA0)
  flow.file(t3, 'write', 'src/extra.mjs', EXTRA1, EXTRA0)
  flow.file(t3, 'read', 'src/extra.mjs', EXTRA1)
  flow.file(t3, 'write', 'src/sum.mjs', FIXED, BROKEN)
  flow.file(t3, 'read', 'src/sum.mjs', FIXED)
  // t3 stays in_progress. t5 rewrites the same sum path, so only the extra
  // path is uncovered; this is the multi-path variant of the same gap.
  closeWithRepair(flow, flow.task('t5'), flow.task('t1'), flow.task('t4'), 'src/sum.mjs', FIXED, FIXED2)
  return resequence(flow.doc)
}

function makeSingleChain() {
  return makeFlow({ withRepair: true }).doc
}

function makeTwoChains() {
  const first = makeFlow({ prefix: 'A-', path: 'src/a.mjs', withRepair: true }).doc
  const second = makeFlow({ prefix: 'B-', path: 'src/b.mjs', withRepair: true }).doc
  first.operations.push(...second.operations)
  return resequence(first)
}

export function buildScenarios() {
  return [
    {
      id: 'incomplete-repair-extra-write',
      description: 'older repair writes src/extra.mjs, stays in_progress; newer repair closes the chain',
      taskId: 't3',
      attemptId: 'a-t3',
      writePath: 'src/extra.mjs',
      input: makeIncompleteRepairScenario(),
    },
    {
      id: 'failed-repair-extra-write',
      description: 'the extra-writing repair ends failed; newer repair closes the chain',
      taskId: 't3',
      attemptId: 'a-t3',
      writePath: 'src/extra.mjs',
      input: makeFailedRepairScenario(),
    },
    {
      id: 'superseded-rejection-extra-write',
      description: 'the extra-writing repair belongs to a rejection later superseded by another rejection',
      taskId: 't3',
      attemptId: 'a-t3',
      writePath: 'src/extra.mjs',
      input: makeSupersededRejectionScenario(),
    },
    {
      id: 'multi-path-uncovered-extra-write',
      description: 'one repair writes two implementation paths; only one path is covered by the closing chain',
      taskId: 't3',
      attemptId: 'a-t3',
      writePath: 'src/extra.mjs',
      input: makeMultiPathScenario(),
    },
    {
      id: 'single-legal-chain',
      description: 'positive control: one complete reject -> repair -> pass chain',
      positive: true,
      input: makeSingleChain(),
    },
    {
      id: 'two-independent-legal-chains',
      description: 'positive control: two independent complete chains',
      positive: true,
      input: makeTwoChains(),
    },
  ]
}
