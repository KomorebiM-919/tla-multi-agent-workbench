// Invented protocol records only; no process or model is executed here.
import { PROTOCOL_SCHEMA } from '../../tools/collect-run-evidence.mjs'

export const ROOT = 'C:/fixture/project'
export const BINDING = { runnerRunId: 'exp-fixture', gateRunId: 'tla-fixture', budgetRunId: 'tla-fixture' }
export const options = { binding: BINDING, projectRoot: ROOT }
export const b64 = text => Buffer.from(text, 'utf8').toString('base64')
export const ORIGINAL = 'export const sum = null;\r\n'
export const BROKEN = 'export const sum = () => 4;\n'
export const FIXED = 'export const sum = xs => xs.reduce((a, b) => a + b, 0);\n'

export function fixture({ prefix = '', path = 'src/sum.mjs', reviewerReads = true, finalReview = true, original = ORIGINAL } = {}) {
  const doc = {
    schema: PROTOCOL_SCHEMA, origin: 'synthetic', binding: { ...BINDING }, projectRoot: ROOT,
    observer: { id: 'fixture-observer', ordering: 'serial-total', complete: true },
    sessions: [{ id: 'captain', role: 'captain' }, { id: 'worker', role: 'worker' }, { id: 'reviewer', role: 'reviewer' }],
    runner: { runId: BINDING.runnerRunId, status: 'completed', hostStarted: true },
    ledger: { gateRunId: BINDING.gateRunId, budgetRunId: BINDING.budgetRunId, completeness: 'COMPLETE', ledgerConsistent: true },
    operations: []
  }
  function add(sessionId, name, input, observation, isError = false) {
    const n = doc.operations.length, id = `${prefix}c${n}`
    doc.operations.push({ runId: BINDING.gateRunId, sessionId,
      call: { id, name, input }, result: { toolUseId: id, isError, complete: true },
      order: { authority: 'fixture-observer', call: n * 2, result: n * 2 + 1 }, observation })
  }
  function create(taskId, taskKind, assignee, sourceTaskId = null, reviewedTaskId = null) {
    const subject = taskKind + ' sum'
    add('captain', 'agent_teams_create_task', { subject, kind: taskKind, assignee, sourceTaskId, reviewedTaskId },
      { type: 'task-create', taskId, subject, taskKind, assignee, sourceTaskId, reviewedTaskId })
  }
  function update(taskId, sessionId, status) {
    add(sessionId, 'agent_teams_update_task', { task_id: taskId, attempt_id: 'a-' + taskId, status },
      { type: 'task-update', taskId, attemptId: 'a-' + taskId, status })
  }
  function start(taskId, sessionId) {
    add(sessionId, 'agent_teams_claim_task', { task_id: taskId }, { type: 'task-claim', taskId, attemptId: 'a-' + taskId })
    update(taskId, sessionId, 'in_progress')
  }
  function file(taskId, type, text, before, sessionId = 'worker') {
    const observation = { type: 'file-' + type, taskId, attemptId: 'a-' + taskId, path: path.replaceAll('/', '\\'),
      fileKind: 'regular', links: 'none', coverage: 'full', bytesBase64: b64(text) }
    const input = { file_path: path }
    if (type === 'write') { observation.beforeBase64 = b64(before); input.content = text }
    add(sessionId, type, input, observation)
  }
  function test(taskId, red) {
    const command = 'node test/sum.test.mjs'
    add('worker', 'pwsh', { command, description: 'Run the synthetic test suite' }, {
      type: 'test', taskId, attemptId: 'a-' + taskId, command, cwd: '.', exitCode: red ? 1 : 0,
      stdoutBase64: b64(`sum tests: ${red ? 2 : 3} passed, ${red ? 1 : 0} failed\n`),
      suitePath: 'test/sum.test.mjs', suiteBase64: b64('// invented stable suite bytes\r\n')
    }, red)
  }
  function review(taskId, reviewedTaskId, verdict) {
    if (reviewerReads) file(taskId, 'read', verdict === 'needs_revision' ? BROKEN : FIXED, undefined, 'reviewer')
    add('reviewer', 'agent_teams_update_task', { task_id: taskId, attempt_id: 'a-' + taskId, status: 'completed', verdict },
      { type: 'review', taskId, attemptId: 'a-' + taskId, reviewedTaskId, verdict })
  }
  const [t1, t2, t3, t4] = [1, 2, 3, 4].map(i => prefix + 't' + i)
  create(t1, 'work', 'worker'); start(t1, 'worker')
  file(t1, 'read', original); file(t1, 'write', BROKEN, original); file(t1, 'read', BROKEN)
  test(t1, true); update(t1, 'worker', 'completed')
  create(t2, 'review', 'reviewer', null, t1); start(t2, 'reviewer'); review(t2, t1, 'needs_revision')
  create(t3, 'repair', 'worker', t1); start(t3, 'worker')
  file(t3, 'read', BROKEN); file(t3, 'write', FIXED, BROKEN); file(t3, 'read', FIXED)
  test(t3, false); update(t3, 'worker', 'completed')
  if (finalReview) { create(t4, 'review', 'reviewer', null, t3); start(t4, 'reviewer'); review(t4, t3, 'passed') }
  return doc
}

export function resequence(doc) {
  doc.operations.forEach((op, i) => { op.order.call = i * 2; op.order.result = i * 2 + 1 })
  return doc
}

export function twoChains({ firstClosed = true, sharedPath = false } = {}) {
  const first = fixture({ prefix: 'A-', path: sharedPath ? 'src/sum.mjs' : 'src/a.mjs', finalReview: firstClosed })
  const second = fixture({ prefix: 'B-', path: sharedPath ? 'src/sum.mjs' : 'src/b.mjs', original: sharedPath ? FIXED : ORIGINAL })
  first.operations.push(...second.operations)
  return resequence(first)
}
