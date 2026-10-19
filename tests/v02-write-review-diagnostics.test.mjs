// Synthetic protocol regression only: no host, network, model or filesystem writes.
import assert from 'node:assert/strict'
import { collectEvidence, COLLECTION_SCHEMA } from '../tools/collect-run-evidence.mjs'
import { fixture, options, twoChains, resequence, b64, BROKEN, FIXED } from './lib/evidence-protocol-fixture.mjs'

const CODE = 'IMPLEMENTATION_WRITE_REVIEW_UNPROVEN'
const failures = []
let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log('ok ' + name) }
  catch (error) { failures.push(name + ': ' + error.message) }
}
function renamed(operations, from, to, filePath) {
  const copy = structuredClone(operations)
  for (const op of copy) {
    op.call.id += '-' + to; op.result.toolUseId = op.call.id
    for (const [record, taskField] of [[op.observation, 'taskId'], [op.call.input, 'task_id']]) {
      if (record[taskField] === from) record[taskField] = to
    }
    for (const record of [op.observation, op.call.input]) {
      for (const field of ['attemptId', 'attempt_id']) if (record[field] === 'a-' + from) record[field] = 'a-' + to
    }
    if (filePath && op.observation.type.startsWith('file-')) {
      op.observation.path = filePath; op.call.input.file_path = filePath
    }
  }
  return copy
}
function orphan({ status = 'in_progress', superseded = false, multi = false, reviewed = false, repeatWrite = false } = {}) {
  const doc = fixture()
  let ops = renamed(doc.operations.filter(op => op.observation.taskId === 't3'), 't3', 'orphan', 'src/orphan.mjs')
  if (status !== 'completed') {
    ops = ops.filter(op => op.observation.type !== 'test' && op.observation.status !== 'completed')
    if (status === 'failed') {
      const failed = renamed(doc.operations.filter(op => op.observation.type === 'task-update' && op.observation.taskId === 't3' && op.observation.status === 'completed'), 't3', 'orphan')[0]
      failed.observation.status = 'failed'; failed.call.input.status = 'failed'; ops.push(failed)
    }
  }
  if (multi || repeatWrite) {
    const files = renamed(ops.filter(op => op.observation.type.startsWith('file-')), 'unused', 'additional', multi ? 'src/second.mjs' : 'src/orphan.mjs')
    if (repeatWrite) for (const op of files) {
      if (op.observation.type === 'file-read') op.observation.bytesBase64 = op.observation.bytesBase64 === b64(BROKEN) ? b64(FIXED) : b64(FIXED + '// next\n')
      else {
        op.observation.beforeBase64 = b64(FIXED); op.observation.bytesBase64 = b64(FIXED + '// next\n'); op.call.input.content = FIXED + '// next\n'
      }
    }
    const at = ops.findIndex(op => op.observation.type === 'test' || ['completed', 'failed'].includes(op.observation.status))
    ops.splice(at === -1 ? ops.length : at, 0, ...files)
  }
  if (reviewed) {
    const review = renamed(doc.operations.filter(op => op.observation.taskId === 't4'), 't4', 'orphan-review', 'src/orphan.mjs')
    for (const op of review) for (const record of [op.observation, op.call.input]) {
      if (record.reviewedTaskId === 't3') record.reviewedTaskId = 'orphan'
    }
    ops.push(...review)
  }
  if (superseded) ops.push(...renamed(doc.operations.filter(op => op.observation.taskId === 't2'), 't2', 'new-rejection'))
  const at = doc.operations.findIndex(op => op.observation.type === 'task-create' && op.observation.taskId === 't3')
  doc.operations.splice(at, 0, ...ops)
  return resequence(doc)
}
function diagnostics(doc) {
  const report = collectEvidence(doc, options)
  assert.equal(report.status, 'INCOMPLETE')
  assert.equal(report.verdict, 'partial')
  assert.notEqual(report.syntheticAcceptance.verdict, 'closed')
  return report
}
function assertLocations(report, doc, taskId = 'orphan') {
  const writes = doc.operations.filter(op => op.observation.type === 'file-write' && op.observation.taskId === taskId)
  const issues = report.issues.filter(issue => issue.code === CODE && issue.taskId === taskId)
  assert.equal(issues.length, writes.length)
  for (const op of writes) {
    const issue = issues.find(item => item.writeIndex === op.order.result)
    assert.ok(issue)
    assert.equal(issue.callId, op.call.id)
    assert.equal(issue.attemptId, 'a-' + taskId)
    assert.equal(issue.path, op.call.input.file_path.replaceAll('\\', '/').toLowerCase())
    assert.equal(issue.sessionId, op.sessionId)
    assert.equal(issue.taskKind, 'repair')
  }
}
for (const status of ['in_progress', 'failed', 'completed']) check(status + ' repair writes cannot hide behind a newer approved repair', () => {
  const doc = orphan({ status }), report = diagnostics(doc)
  assertLocations(report, doc)
  assert.equal(report.issues.find(i => i.code === CODE).taskStatus, status)
  assert.equal(report.evidence.chains[0].closed, true)
})
check('a repair from a superseded rejection still has locatable write diagnostics', () => {
  const doc = orphan({ superseded: true }), report = diagnostics(doc)
  assertLocations(report, doc)
})
check('all implementation paths of an unreviewed repair are diagnosed', () => {
  const doc = orphan({ multi: true }), report = diagnostics(doc)
  assertLocations(report, doc)
  assert.deepEqual(report.issues.filter(i => i.code === CODE).map(i => i.path), ['src/orphan.mjs', 'src/second.mjs'])
})
check('each intermediate write is diagnosed, not just the latest write per path', () => {
  const doc = orphan({ repeatWrite: true }), report = diagnostics(doc)
  assertLocations(report, doc)
  assert.equal(new Set(report.issues.filter(i => i.code === CODE).map(i => i.writeIndex)).size, 2)
})
check('a later rewrite of the same path cannot retroactively review an abandoned repair', () => {
  const doc = orphan()
  for (const op of doc.operations.filter(op => op.observation.taskId === 'orphan' && op.observation.type.startsWith('file-'))) {
    op.observation.path = 'src/sum.mjs'; op.call.input.file_path = 'src/sum.mjs'
    if (op.observation.type === 'file-write') { op.call.input.content = BROKEN + '// abandoned\n'; op.observation.bytesBase64 = b64(op.call.input.content) }
    else if (op.observation.bytesBase64 === b64(FIXED)) op.observation.bytesBase64 = b64(BROKEN + '// abandoned\n')
  }
  for (const op of doc.operations.filter(op => op.observation.taskId === 't3')) {
    if (op.observation.type === 'file-read' && op.observation.bytesBase64 === b64(BROKEN)) op.observation.bytesBase64 = b64(BROKEN + '// abandoned\n')
    if (op.observation.type === 'file-write') op.observation.beforeBase64 = b64(BROKEN + '// abandoned\n')
  }
  assertLocations(diagnostics(doc), doc)
})
check('fully reviewed historical repairs retain their own approval when superseded', () => {
  const report = collectEvidence(orphan({ status: 'completed', reviewed: true }), options)
  assert.equal(report.verdict, 'synthetic-closed')
  assert.deepEqual(report.issues, [])
  assert.equal(report.evidence.chains[0].repairTaskId, 't3')
})
check('a historically reviewed repair also survives a new rejection epoch', () => {
  const report = collectEvidence(orphan({ status: 'completed', reviewed: true, superseded: true }), options)
  assert.equal(report.verdict, 'synthetic-closed')
  assert.deepEqual(report.issues, [])
})
check('single legal chain and two independent legal chains remain closed', () => {
  for (const doc of [fixture(), twoChains()]) {
    const report = collectEvidence(doc, options)
    assert.equal(report.schema, COLLECTION_SCHEMA)
    assert.equal(report.verdict, 'synthetic-closed')
    assert.deepEqual(report.issues, [])
    assert.equal(report.hostVerified, false)
  }
})
check('no-write abandoned repair does not invent a file diagnostic', () => {
  const doc = orphan()
  doc.operations = doc.operations.filter(op => !(op.observation.taskId === 'orphan' && op.observation.type.startsWith('file-')))
  const report = collectEvidence(resequence(doc), options)
  assert.equal(report.status, 'COMPLETE')
  assert.equal(report.verdict, 'partial')
  assert.deepEqual(report.issues, [])
})
check('replay and input-array order do not duplicate or reorder write issues', () => {
  const doc = orphan({ repeatWrite: true }), expected = collectEvidence(doc, options)
  doc.operations.push(structuredClone(doc.operations.find(op => op.observation.type === 'file-write' && op.observation.taskId === 'orphan')))
  doc.operations.reverse()
  const before = structuredClone(doc)
  assert.deepEqual(collectEvidence(doc, options), expected)
  assert.deepEqual(doc, before)
})
check('primary validation failure stays first while complete observations expose unreviewed writes', () => {
  const doc = orphan({ status: 'completed' }), report = diagnostics(doc)
  assert.equal(report.issues[0].code, 'REPAIR_REVIEW_INCOMPLETE')
  assertLocations(report, doc)
})
check('partial malformed collection does not claim exhaustive write coverage', () => {
  const doc = orphan()
  doc.operations.find(op => op.observation.type === 'file-write' && op.observation.taskId === 't3').result.isError = true
  const report = collectEvidence(doc, options)
  assert.equal(report.issues[0].code, 'TOOL_FAILED')
  assert.ok(!report.issues.some(issue => issue.code === CODE))
  assert.equal(report.status, 'INCOMPLETE')
})
check('an unreviewed work also exposes its own write location', () => {
  const doc = twoChains()
  doc.operations = doc.operations.filter(op => !String(op.observation.taskId).startsWith('B-') || op.observation.taskId === 'B-t1')
  const report = diagnostics(resequence(doc))
  assert.equal(report.issues[0].code, 'WORK_REVIEW_CHAIN_INCOMPLETE')
  const issue = report.issues.find(item => item.code === CODE && item.taskId === 'B-t1')
  const write = doc.operations.find(op => op.observation.type === 'file-write' && op.observation.taskId === 'B-t1')
  assert.equal(issue.callId, write.call.id)
  assert.equal(issue.writeIndex, write.order.result)
  assert.equal(issue.attemptId, 'a-B-t1')
  assert.equal(issue.path, 'src/b.mjs')
  assert.equal(issue.taskKind, 'work')
})
check('an unfinished note-only repair does not invent an implementation-write issue', () => {
  const doc = orphan()
  for (const op of doc.operations.filter(op => op.observation.taskId === 'orphan' && op.observation.type.startsWith('file-'))) {
    op.observation.path = 'src/note.txt'; op.call.input.file_path = 'src/note.txt'
  }
  const report = collectEvidence(doc, options)
  assert.equal(report.status, 'COMPLETE')
  assert.equal(report.verdict, 'partial')
  assert.deepEqual(report.issues, [])
})
check('write issue paths use the same Windows normalization as file evidence', () => {
  const doc = orphan()
  for (const op of doc.operations.filter(op => op.observation.taskId === 'orphan' && op.observation.type.startsWith('file-'))) {
    op.observation.path = 'SRC\\Orphan.MJS'; op.call.input.file_path = 'src/ORPHAN.mjs'
  }
  const report = diagnostics(doc)
  assert.equal(report.issues.find(item => item.code === CODE).path, 'src/orphan.mjs')
})
check('reviewed repair covers final bytes per path, not every historical intermediate write', () => {
  const doc = fixture(), next = FIXED + '// final revision\n'
  const write = structuredClone(doc.operations.find(op => op.observation.type === 'file-write' && op.observation.taskId === 't3'))
  write.call.id += '-final'; write.result.toolUseId = write.call.id
  write.call.input.content = next; write.observation.beforeBase64 = b64(FIXED); write.observation.bytesBase64 = b64(next)
  const at = doc.operations.findIndex(op => op.observation.type === 'file-read' && op.observation.taskId === 't3' && op.observation.bytesBase64 === b64(FIXED))
  const read = structuredClone(doc.operations[at])
  read.call.id += '-final'; read.result.toolUseId = read.call.id
  read.observation.bytesBase64 = b64(next)
  doc.operations.splice(at + 1, 0, write, read)
  for (const op of doc.operations.filter(op => op.observation.type === 'file-read' && op.observation.taskId === 't4' && op.observation.bytesBase64 === b64(FIXED))) op.observation.bytesBase64 = b64(next)
  const report = collectEvidence(resequence(doc), options)
  assert.equal(report.verdict, 'synthetic-closed')
  assert.deepEqual(report.issues, [])
  assert.equal(report.hostVerified, false)
})
assert.deepEqual(failures, [])
console.log(`write review diagnostics: ${passed} scenarios passed`)
