import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { collectEvidence } from '../tools/collect-run-evidence.mjs'
import { fixture, options, twoChains, resequence, b64, BROKEN, FIXED } from './lib/evidence-protocol-fixture.mjs'

const failures = []
let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log('ok ' + name) }
  catch (error) { failures.push(name + ': ' + error.message) }
}
check('one passed chain cannot close another unreviewed repair', () => {
  const report = collectEvidence(twoChains({ firstClosed: false }), options)
  assert.notEqual(report.verdict, 'synthetic-closed')
  assert.equal(report.status, 'INCOMPLETE')
  assert.ok(report.issues.some(e => e.code === 'REJECTED_WORK_CHAIN_INCOMPLETE'))
})
check('two independently closed chains are accepted', () => {
  const report = collectEvidence(twoChains(), options)
  assert.equal(report.verdict, 'synthetic-closed')
  assert.equal(report.evidence.chains.length, 2)
  for (const chain of report.evidence.chains) {
    assert.equal(chain.closed, true)
    assert.equal(chain.workTaskId.slice(0, 2), chain.repairTaskId.slice(0, 2))
    assert.equal(chain.workTaskId.slice(0, 2), chain.reviewTaskId.slice(0, 2))
  }
})
check('reviewer cannot approve without its own reads', () => {
  const report = collectEvidence(fixture({ reviewerReads: false }), options)
  assert.equal(report.status, 'INCOMPLETE')
  assert.ok(report.issues.some(e => e.code === 'REVIEWER_READ_UNPROVEN'))
})
check('a new output version removes the generic nested acceptance alias', () => {
  const report = collectEvidence(fixture(), options)
  assert.equal(report.schema, 'tla.collected-evidence/v2')
  assert.equal(Object.hasOwn(report, 'acceptance'), false)
  assert.equal(report.syntheticAcceptance.verdict, 'closed')
  assert.equal(report.hostVerified, false)
})
check('subject hash preserves exact UTF-8 bytes without exposing the subject', () => {
  const doc = fixture(), op = doc.operations.find(o => o.observation.type === 'task-create')
  const subject = ' 实现加总 🧪\r\n'
  op.observation.subject = subject; op.call.input.subject = subject
  const report = collectEvidence(doc, options), task = report.evidence.tasks.find(t => t.id === 't1')
  assert.equal(report.verdict, 'synthetic-closed')
  assert.equal(task.subjectSha256, createHash('sha256').update(Buffer.from(subject, 'utf8')).digest('hex'))
  assert.equal(task.subjectBytes, Buffer.byteLength(subject, 'utf8'))
  assert.ok(!JSON.stringify(report).includes(subject))
})
check('missing final reviewer read is not replaced by its earlier rejected-review read', () => {
  const doc = fixture()
  doc.operations = doc.operations.filter(op => !(op.observation.type === 'file-read' && op.observation.taskId === 't4'))
  const report = collectEvidence(doc, options)
  assert.equal(report.issues[0].code, 'REVIEWER_READ_UNPROVEN')
  assert.equal(report.syntheticAcceptance.verdict, 'partial')
})
check('a different reviewer session cannot lend a read to the assigned reviewer', () => {
  const doc = fixture()
  doc.sessions.push({ id: 'other-reviewer', role: 'reviewer' })
  const read = doc.operations.find(op => op.observation.type === 'file-read' && op.observation.taskId === 't4')
  read.sessionId = 'other-reviewer'
  assert.notEqual(collectEvidence(doc, options).verdict, 'synthetic-closed')
})
check('a previous attempt cannot supply the current review read', () => {
  const doc = fixture()
  const read = doc.operations.find(op => op.observation.type === 'file-read' && op.observation.taskId === 't4')
  read.observation.attemptId = 'a-t2'
  assert.equal(collectEvidence(doc, options).issues[0].code, 'ACTIVE_TASK_UNPROVEN')
})
check('passing review exposes its own read provenance, not worker evidence', () => {
  const report = collectEvidence(fixture(), options), chain = report.evidence.chains[0]
  assert.equal(chain.workTaskId, 't1')
  assert.equal(chain.repairTaskId, 't3')
  assert.equal(chain.reviewTaskId, 't4')
  assert.equal(chain.reviewerSessionId, 'reviewer')
  assert.ok(chain.reads.length > 0)
  assert.ok(chain.reads.every(read => read.sessionId === 'reviewer' && read.taskId === 't4' && read.attemptId === 'a-t4'))
})
check('a completed later repair cannot borrow an earlier repair approval', () => {
  const doc = fixture()
  const repairOps = structuredClone(doc.operations.filter(op => op.observation.taskId === 't3'))
  const after = FIXED + '// second repair\n'
  for (const op of repairOps) {
    op.call.id += '-second'; op.result.toolUseId = op.call.id
    op.observation.taskId = 't5'
    if (Object.hasOwn(op.observation, 'attemptId')) op.observation.attemptId = 'a-t5'
    if (Object.hasOwn(op.call.input, 'task_id')) op.call.input.task_id = 't5'
    if (Object.hasOwn(op.call.input, 'attempt_id')) op.call.input.attempt_id = 'a-t5'
    if (op.observation.type === 'file-read') {
      op.observation.bytesBase64 = op.observation.bytesBase64 === b64(BROKEN) ? b64(FIXED) : b64(after)
    }
    if (op.observation.type === 'file-write') {
      op.observation.beforeBase64 = b64(FIXED); op.observation.bytesBase64 = b64(after); op.call.input.content = after
    }
  }
  doc.operations.push(...repairOps)
  const report = collectEvidence(resequence(doc), options)
  assert.equal(report.issues[0].code, 'REJECTED_WORK_CHAIN_INCOMPLETE')
  assert.equal(report.evidence.chains[0].repairTaskId, 't5')
  assert.equal(report.evidence.chains[0].closed, false)
})
check('unreviewed earlier repair cannot hide behind a newer approved repair', () => {
  const doc = fixture()
  // Clone the first repair as a new one, then let the existing re-review target
  // the new repair. The original completed t3 has no corresponding approval.
  const repairOps = structuredClone(doc.operations.filter(op => op.observation.taskId === 't3'))
  const after = FIXED + '// replacement repair\n'
  for (const op of repairOps) {
    op.call.id += '-replacement'; op.result.toolUseId = op.call.id
    op.observation.taskId = 't5'
    if (Object.hasOwn(op.observation, 'attemptId')) op.observation.attemptId = 'a-t5'
    if (Object.hasOwn(op.call.input, 'task_id')) op.call.input.task_id = 't5'
    if (Object.hasOwn(op.call.input, 'attempt_id')) op.call.input.attempt_id = 'a-t5'
    if (op.observation.type === 'file-read') op.observation.bytesBase64 = op.observation.bytesBase64 === b64(BROKEN) ? b64(FIXED) : b64(after)
    if (op.observation.type === 'file-write') {
      op.observation.beforeBase64 = b64(FIXED); op.observation.bytesBase64 = b64(after); op.call.input.content = after
    }
  }
  const reviewStart = doc.operations.findIndex(op => op.observation.type === 'task-create' && op.observation.taskId === 't4')
  doc.operations.splice(reviewStart, 0, ...repairOps)
  for (const op of doc.operations.filter(op => op.observation.taskId === 't4')) {
    if (Object.hasOwn(op.observation, 'reviewedTaskId')) op.observation.reviewedTaskId = 't5'
    if (Object.hasOwn(op.call.input, 'reviewedTaskId')) op.call.input.reviewedTaskId = 't5'
    if (op.observation.type === 'file-read') op.observation.bytesBase64 = b64(after)
  }
  assert.equal(collectEvidence(resequence(doc), options).issues[0].code, 'REPAIR_REVIEW_INCOMPLETE')
})
check('a later overlapping chain invalidates an earlier approval snapshot', () => {
  const report = collectEvidence(twoChains({ sharedPath: true }), options)
  assert.equal(report.status, 'INCOMPLETE')
  assert.equal(report.issues[0].code, 'REVIEW_STALE_AFTER_WRITE')
  assert.equal(report.evidence.chains.find(c => c.workTaskId === 'A-t1').closed, false)
})
check('review must read every implementation path changed by its target', () => {
  const doc = fixture()
  const ops = structuredClone(doc.operations.filter(op => ['file-read', 'file-write'].includes(op.observation.type) && op.observation.taskId === 't3'))
  for (const op of ops) {
    op.call.id += '-other'; op.result.toolUseId = op.call.id
    op.observation.path = 'src/other.mjs'; op.call.input.file_path = 'src/other.mjs'
  }
  const index = doc.operations.findIndex(op => op.observation.type === 'test' && op.observation.taskId === 't3')
  doc.operations.splice(index, 0, ...ops)
  const incomplete = collectEvidence(resequence(doc), options)
  assert.equal(incomplete.issues[0].code, 'REVIEWER_READ_UNPROVEN')
  const read = structuredClone(doc.operations.find(op => op.observation.type === 'file-read' && op.observation.taskId === 't4'))
  read.call.id += '-other'; read.result.toolUseId = read.call.id
  read.observation.path = 'src/other.mjs'; read.call.input.file_path = 'src/other.mjs'
  const passIndex = doc.operations.findIndex(op => op.observation.type === 'review' && op.observation.verdict === 'passed')
  doc.operations.splice(passIndex, 0, read)
  assert.equal(collectEvidence(resequence(doc), options).verdict, 'synthetic-closed')
})
check('replay and array order do not mutate or cross-bind the two closures', () => {
  const doc = twoChains(), expected = collectEvidence(doc, options)
  doc.operations.push(structuredClone(doc.operations[0]))
  doc.operations.reverse()
  const snapshot = structuredClone(doc)
  assert.deepEqual(collectEvidence(doc, options), expected)
  assert.deepEqual(doc, snapshot)
})
check('invalid collections also omit the old nested alias', () => {
  const report = collectEvidence({ schema: 'legacy' }, options)
  assert.equal(report.schema, 'tla.collected-evidence/v2')
  assert.equal(Object.hasOwn(report, 'acceptance'), false)
  assert.notEqual(report.syntheticAcceptance.verdict, 'closed')
})
check('a newer rejection cannot borrow a repair tied to the earlier rejection', () => {
  const doc = fixture()
  const reviewOps = structuredClone(doc.operations.filter(op => op.observation.taskId === 't2'))
  for (const op of reviewOps) {
    op.call.id += '-new-rejection'; op.result.toolUseId = op.call.id
    op.observation.taskId = 't5'
    if (Object.hasOwn(op.observation, 'attemptId')) op.observation.attemptId = 'a-t5'
    if (Object.hasOwn(op.call.input, 'task_id')) op.call.input.task_id = 't5'
    if (Object.hasOwn(op.call.input, 'attempt_id')) op.call.input.attempt_id = 'a-t5'
  }
  const beforeWrite = doc.operations.findIndex(op => op.observation.taskId === 't3' && op.observation.type === 'file-read')
  doc.operations.splice(beforeWrite, 0, ...reviewOps)
  assert.equal(collectEvidence(resequence(doc), options).issues[0].code, 'PASS_LINEAGE_UNPROVEN')
})
check('an implementation-changing work without any review cannot hide behind another chain', () => {
  const doc = fixture({ prefix: 'A-', path: 'src/a.mjs' })
  const other = fixture({ prefix: 'B-', path: 'src/b.mjs' })
  doc.operations.unshift(...other.operations.filter(op => op.observation.taskId === 'B-t1'))
  const report = collectEvidence(resequence(doc), options)
  assert.equal(report.issues[0]?.code, 'WORK_REVIEW_CHAIN_INCOMPLETE')
  assert.notEqual(report.verdict, 'synthetic-closed')
})
check('subject digest must not silently replace an unpaired UTF-16 surrogate', () => {
  const doc = fixture(), op = doc.operations.find(o => o.observation.type === 'task-create')
  op.observation.subject = 'work ' + String.fromCharCode(0xd800)
  op.call.input.subject = op.observation.subject
  assert.equal(collectEvidence(doc, options).issues[0]?.code, 'SUBJECT_UTF8_INVALID')
})
assert.deepEqual(failures, [])
console.log(`evidence lineage: ${passed} checks passed`)
