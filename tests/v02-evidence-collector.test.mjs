import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { collectEvidence, main } from '../tools/collect-run-evidence.mjs'

import { ROOT, BINDING, options, b64, ORIGINAL, BROKEN, FIXED, fixture } from './lib/evidence-protocol-fixture.mjs'

const first = (d, type) => d.operations.find(o => o.observation.type === type)
const last = (d, type) => d.operations.filter(o => o.observation.type === type).at(-1)
let passed = 0
function check(name, fn) { fn(); passed++; console.log('ok ' + name) }

check('paired protocol collects and derives a synthetic closed loop', () => {
  const result = collectEvidence(fixture(), options)
  assert.deepEqual(result.issues, [])
  assert.equal(result.verdict, 'synthetic-closed')
  assert.equal(result.syntheticAcceptance.verdict, 'closed')
  assert.equal(result.hostVerified, false)
  assert.equal(result.scope, 'synthetic-protocol')
  assert.deepEqual(result.binding, BINDING)
  assert.equal(result.evidence.tasks.length, 4)
  assert.equal(result.evidence.tests.history.length, 2)
  assert.ok(result.evidence.files.every(e => e.path === 'src/sum.mjs'))
})

check('input order and exact conversation replay do not change evidence', () => {
  const d = fixture()
  const expected = collectEvidence(d, options)
  d.operations.push(structuredClone(d.operations[3]))
  d.operations.reverse()
  const snapshot = structuredClone(d)
  assert.deepEqual(collectEvidence(d, options), expected)
  assert.deepEqual(d, snapshot)
})

check('raw snapshots, command text and task subjects are not emitted', () => {
  const text = JSON.stringify(collectEvidence(fixture(), options))
  for (const secret of [b64(FIXED), FIXED, 'node test/sum.test.mjs', 'work sum']) assert.ok(!text.includes(secret))
})

const negatives = [
  ['old schema', d => { d.schema = 'tla.observation-protocol/v0' }],
  ['live-origin claim', d => { d.origin = 'host-observer' }],
  ['unknown field', d => { d.extra = true }],
  ['wrong expected runner mapping', d => { d.binding.runnerRunId = 'another' }],
  ['wrong gate mapping', d => { d.binding.gateRunId = 'another' }],
  ['wrong budget mapping', d => { d.binding.budgetRunId = 'another' }],
  ['cross-run tool result', d => { d.operations[3].runId = 'another' }],
  ['missing member session', d => { d.sessions = d.sessions.filter(s => s.id !== 'worker') }],
  ['wrong member role', d => { d.sessions.find(s => s.id === 'worker').role = 'reviewer' }],
  ['unknown order', d => { d.observer.ordering = 'unknown' }],
  ['incomplete observer stream', d => { d.observer.complete = false }],
  ['untrusted order authority', d => { d.operations[3].order.authority = 'wall-clock' }],
  ['duplicate sequence', d => { d.operations[3].order.call = d.operations[2].order.call }],
  ['string operation sequence', d => { d.operations[3].order.call = String(d.operations[3].order.call) }],
  ['overlapping operation', d => { d.operations[2].order.result = d.operations[3].order.call + 1 }],
  ['orphan result', d => { d.operations[3].result.toolUseId = 'absent' }],
  ['missing result', d => { delete d.operations[3].result }],
  ['partial result', d => { d.operations[3].result.complete = false }],
  ['failed write', d => { first(d, 'file-write').result.isError = true }],
  ['missing read-back', d => {
    const read = d.operations.filter(o => o.observation.type === 'file-read' && o.sessionId === 'worker').at(-1)
    d.operations = d.operations.filter(o => o !== read)
  }],
  ['missing bytes', d => { delete last(d, 'file-read').observation.bytesBase64 }],
  ['partial bytes', d => { last(d, 'file-read').observation.coverage = 'partial' }],
  ['forged after-write byte snapshot', d => { last(d, 'file-write').observation.bytesBase64 = b64('other') }],
  ['stale prior bytes', d => { last(d, 'file-write').observation.beforeBase64 = b64(ORIGINAL) }],
  ['CRLF differs from LF', d => { last(d, 'file-read').observation.bytesBase64 = b64(FIXED.replaceAll('\n', '\r\n')) }],
  ['invalid base64', d => { last(d, 'file-read').observation.bytesBase64 = 'not base64' }],
  ['oversized snapshot', d => { last(d, 'file-read').observation.bytesBase64 = Buffer.alloc(65537).toString('base64') }],
  ['outside root', d => { first(d, 'file-read').observation.path = 'C:/outside/sum.mjs' }],
  ['parent traversal', d => { first(d, 'file-read').observation.path = 'src/../sum.mjs' }],
  ['UNC path', d => { first(d, 'file-read').observation.path = '\\\\server\\share\\sum.mjs' }],
  ['device path', d => { first(d, 'file-read').observation.path = '\\\\?\\C:\\fixture\\project\\src\\sum.mjs' }],
  ['alternate stream', d => { first(d, 'file-read').observation.path = 'src/sum.mjs:stream' }],
  ['reserved filename', d => { first(d, 'file-read').observation.path = 'src/NUL.mjs' }],
  ['symlink observation', d => { first(d, 'file-read').observation.links = 'symlink' }],
  ['file path mismatch', d => { first(d, 'file-read').call.input.file_path = 'src/other.mjs' }],
  ['unknown process exit', d => { first(d, 'test').observation.exitCode = null }],
  ['tool error disagrees with process status', d => { last(d, 'test').result.isError = true }],
  ['fake green output with red exit', d => { first(d, 'test').observation.stdoutBase64 = b64('sum tests: 3 passed, 0 failed\n') }],
  ['missing structured summary', d => { last(d, 'test').observation.stdoutBase64 = b64('all good') }],
  ['multiple summaries', d => { last(d, 'test').observation.stdoutBase64 = b64('sum tests: 3 passed, 0 failed\nsum tests: 2 passed, 1 failed') }],
  ['changed test suite', d => { last(d, 'test').observation.suiteBase64 = b64('// changed tests') }],
  ['wrong cwd', d => { last(d, 'test').observation.cwd = '..' }],
  ['missing attempt id', d => { delete last(d, 'task-update').call.input.attempt_id }],
  ['wrong task attempt', d => { last(d, 'file-write').observation.attemptId = 'other' }],
  ['repair not sourced from rejected work', d => { first(d, 'task-create').observation.taskKind = 'repair' }],
  ['review target mismatch', d => { last(d, 'review').observation.reviewedTaskId = 't1' }],
  ['review rejected again', d => { last(d, 'review').observation.verdict = 'needs_revision'; last(d, 'review').call.input.verdict = 'needs_revision' }],
  ['task completion missing', d => { d.operations = d.operations.filter(o => o !== last(d, 'task-update')) }],
  ['incomplete ledger', d => { d.ledger.completeness = 'INCOMPLETE' }],
  ['ledger ID mismatch', d => { d.ledger.gateRunId = 'another' }],
  ['runner ID mismatch', d => { d.runner.runId = 'another' }],
  ['conflicting replay', d => { const duplicate = structuredClone(d.operations[3]); duplicate.result.isError = true; d.operations.push(duplicate) }]
]
for (const [name, mutate] of negatives) check(name, () => {
  const d = fixture(); mutate(d)
  const result = collectEvidence(d, options)
  assert.notEqual(result.verdict, 'synthetic-closed')
  assert.notEqual(result.syntheticAcceptance.verdict, 'closed')
  assert.equal(result.hostVerified, false)
})

check('missing independent binding is rejected', () => {
  assert.equal(collectEvidence(fixture(), { projectRoot: ROOT }).status, 'INCOMPLETE')
})
check('wrong expected project root is rejected', () => {
  assert.equal(collectEvidence(fixture(), { ...options, projectRoot: 'C:/elsewhere' }).status, 'INCOMPLETE')
})
check('non-JSON input is rejected without throwing', () => {
  const d = fixture(); d.operations[0].extra = 1n
  assert.equal(collectEvidence(d, options).status, 'INCOMPLETE')
})
check('invalid expected context is rejected without throwing', () => {
  assert.equal(collectEvidence(fixture(), null).status, 'INCOMPLETE')
})
check('operation count limit is enforced before replay deduplication', () => {
  const d = fixture(); d.operations = Array.from({ length: 129 }, () => d.operations[0])
  assert.equal(collectEvidence(d, options).issues[0].code, 'OPERATIONS_LIMIT')
})
check('whole-document size limit is independent of snapshot limits', () => {
  const d = fixture(); d.extra = 'x'.repeat(1024 * 1024)
  assert.equal(collectEvidence(d, options).issues[0].code, 'INPUT_LIMIT')
})
check('CLI missing arguments returns usage error without executing anything', () => {
  assert.equal(main([]), 1)
})

check('missing earlier file read-back cannot hide behind the latest file', () => {
  const d = fixture()
  const read = structuredClone(d.operations.filter(o => o.observation.type === 'file-read' && o.sessionId === 'worker').at(-1))
  const write = structuredClone(last(d, 'file-write'))
  for (const op of [read, write]) {
    op.observation.path = 'src/other.mjs'; op.call.input.file_path = 'src/other.mjs'
    op.call.id += '-other'; op.result.toolUseId = op.call.id
  }
  read.observation.bytesBase64 = b64(BROKEN)
  const start = d.operations.findIndex(o => o.observation.type === 'file-read' && o.observation.taskId === 't3')
  d.operations.splice(start, 0, read, write)
  d.operations.forEach((op, i) => { op.order.call = i * 2; op.order.result = i * 2 + 1 })
  const report = collectEvidence(d, options)
  assert.equal(report.status, 'INCOMPLETE')
  assert.notEqual(report.syntheticAcceptance.verdict, 'closed')
})

check('Windows paths are case-insensitive within the expected root', () => {
  const d = fixture()
  first(d, 'file-read').observation.path = 'c:/FIXTURE/PROJECT/SRC/SUM.MJS'
  assert.equal(collectEvidence(d, options).verdict, 'synthetic-closed')
})
check('POSIX paths retain their case and support the same protocol', () => {
  const d = fixture(); d.projectRoot = '/fixture/project'
  assert.equal(collectEvidence(d, { ...options, projectRoot: d.projectRoot }).verdict, 'synthetic-closed')
})

check('missing producer observation cannot be replaced by a policy fact', () => {
  const d = fixture()
  first(d, 'file-write').observation = { policyFacts: { filePath: 'src/sum.mjs', fileOutcome: 'updated' } }
  assert.equal(collectEvidence(d, options).status, 'INCOMPLETE')
})

check('undefined values and functions are not silently JSON-normalized', () => {
  for (const extra of [undefined, () => true, new Date(), NaN]) {
    const d = fixture(); d.extra = extra
    assert.equal(collectEvidence(d, options).status, 'INCOMPLETE')
  }
})

check('complete CLI path reads a protocol and never reports a live closed verdict', () => {
  const folder = mkdtempSync(join(tmpdir(), 'tla-evidence-'))
  const path = join(folder, 'protocol.json')
  const stdout = process.stdout.write, stderr = process.stderr.write
  const cli = ['--protocol', path, '--project-root', ROOT, '--runner-run-id', BINDING.runnerRunId,
    '--gate-run-id', BINDING.gateRunId, '--budget-run-id', BINDING.budgetRunId]
  let output = ''
  try {
    process.stdout.write = chunk => { output += chunk; return true }
    process.stderr.write = () => true
    writeFileSync(path, JSON.stringify(fixture()))
    assert.equal(main(cli), 0)
    assert.equal(JSON.parse(output).verdict, 'synthetic-closed')
    assert.equal(JSON.parse(output).hostVerified, false)
    assert.equal(JSON.parse(output).schema, 'tla.collected-evidence/v2')
    assert.equal(Object.hasOwn(JSON.parse(output), 'acceptance'), false)
    assert.equal(JSON.parse(output).syntheticAcceptance.verdict, 'closed')
    const broken = fixture(); broken.origin = 'legacy-log'
    writeFileSync(path, JSON.stringify(broken)); output = ''
    assert.equal(main(cli), 2)
    assert.equal(JSON.parse(output).status, 'INCOMPLETE')
    writeFileSync(path, '{truncated')
    assert.equal(main(cli), 1)
  } finally {
    process.stdout.write = stdout; process.stderr.write = stderr
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()))
    assert.ok(basename(folder).startsWith('tla-evidence-'))
    rmSync(folder, { recursive: true, force: true })
  }
})
console.log(`evidence collector: ${passed} checks passed`)
