import assert from 'node:assert/strict'

import {
  ACCEPTANCE_SCHEMA,
  deriveAcceptance,
  parseTestLine,
  readRuleUsage
} from '../tools/acceptance-summary.mjs'

const checks = []

function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message })
  }
}

const TEST_CMD = 'node test/sum.test.mjs'
const SHA_READ = 'a'.repeat(64)
const SHA_WRITE = 'b'.repeat(64)

const closedInput = () => ({
  supervisor: { status: 'completed', hostStarted: true },
  ledger: { completeness: 'COMPLETE', ledgerConsistent: true },
  tests: { exitCode: 0, passed: 3, failed: 0, history: [{ command: TEST_CMD, exitCode: 1, failed: 3 }, { command: TEST_CMD, exitCode: 0, failed: 0 }] },
  tasks: [
    { id: 't0', subject: 'implement sum', status: 'completed' },
    { id: 't1', subject: 'review sum', status: 'completed' },
    { id: 't2', subject: 'repair sum', status: 'completed' },
    { id: 't3', subject: 're-review sum', status: 'completed' }
  ],
  usage: [{ rule: 'worker-implements' }, { rule: 'reviewer-rejects' }, { rule: 'worker-repairs' }, { rule: 'reviewer-passes' }],
  writes: [
    { index: 1, kind: 'read', path: 'src/sum.mjs', sha256: SHA_READ },
    { index: 2, kind: 'write', path: 'src/sum.mjs', sha256: SHA_WRITE, outcome: 'updated' },
    { index: 3, kind: 'read', path: 'src/sum.mjs', sha256: SHA_WRITE }
  ]
})

check('schema is versioned', () => assert.equal(ACCEPTANCE_SCHEMA, 'tla.acceptance-summary/v1'))

check('parses the fixture summary line', () => {
  assert.deepEqual(parseTestLine('sum tests: 1 passed, 2 failed'), { passed: 1, failed: 2 })
  assert.deepEqual(parseTestLine('sum tests: 3 passed, 0 failed'), { passed: 3, failed: 0 })
})

check('an unparseable test line is unknown, not zero', () => {
  assert.deepEqual(parseTestLine('boom'), { passed: null, failed: null })
})

check('reads rules, writes and reads out of the upstream log', () => {
  const lines = [
    JSON.stringify({ event: 'arrived', accepted: true, policyRule: 'worker-reads', policyFacts: { filePath: 'a.txt', fileOutcome: 'read' } }),
    JSON.stringify({ event: 'responded', stopReason: 'tool_use' }),
    JSON.stringify({ event: 'arrived', accepted: false, policyRule: 'x', policyFacts: {} }),
    JSON.stringify({ event: 'arrived', accepted: true, policyRule: 'worker-writes', policyFacts: { filePath: 'b.txt', fileOutcome: 'updated' } })
  ]
  const usage = readRuleUsage(lines)
  assert.deepEqual(usage.usage.map((entry) => entry.rule), ['worker-reads', 'worker-writes'])
  assert.equal(usage.reads.length, 1)
  assert.deepEqual(usage.writes.map((write) => write.path), ['b.txt'])
})

check('ignores malformed lines instead of throwing', () => {
  const usage = readRuleUsage(['not json', '', JSON.stringify({ event: 'listening' })])
  assert.deepEqual(usage.usage, [])
  assert.deepEqual(usage.writes, [])
})

check('every condition met is closed', () => {
  const summary = deriveAcceptance(closedInput())
  assert.equal(summary.verdict, 'closed')
  assert.deepEqual(summary.unmet, [])
})

check('green tests without a red run first is partial', () => {
  const input = closedInput()
  input.tests.history = [{ command: TEST_CMD, exitCode: 0, failed: 0 }]
  const summary = deriveAcceptance(input)
  assert.equal(summary.verdict, 'partial')
  assert.deepEqual(summary.unmet, ['TESTS_RED_THEN_GREEN'])
})

check('red tests are partial, never closed', () => {
  const input = closedInput()
  input.tests = { exitCode: 1, passed: 0, failed: 3, history: [{ command: TEST_CMD, exitCode: 1, failed: 3 }] }
  const summary = deriveAcceptance(input)
  assert.equal(summary.verdict, 'partial')
  assert.deepEqual(summary.unmet, ['TESTS_RED_THEN_GREEN', 'TESTS_GREEN'])
})

check('writing only the note file cannot close, even with green tests', () => {
  const input = closedInput()
  input.writes = [
    { index: 1, kind: 'read', path: 'src/note.txt', sha256: SHA_READ },
    { index: 2, kind: 'write', path: 'src/note.txt', sha256: SHA_WRITE, outcome: 'updated' }
  ]
  const summary = deriveAcceptance(input)
  assert.equal(summary.verdict, 'partial')
  assert.deepEqual(summary.unmet, ['IMPLEMENTATION_FILE_CHANGED', 'READ_BACK_AFTER_WRITE'])
})

check('a write with no read-back after it is partial', () => {
  const input = closedInput()
  input.writes = [
    { index: 1, kind: 'read', path: 'src/sum.mjs', sha256: SHA_READ },
    { index: 2, kind: 'write', path: 'src/sum.mjs', sha256: SHA_WRITE, outcome: 'updated' }
  ]
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['READ_BACK_AFTER_WRITE'])
})

check('a read-back of stale bytes does not count', () => {
  const input = closedInput()
  input.writes[2] = { index: 3, kind: 'read', path: 'src/sum.mjs', sha256: SHA_READ }
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['READ_BACK_AFTER_WRITE'])
})

check('a read before the write is not a read-back', () => {
  const input = closedInput()
  input.writes = [
    { index: 1, kind: 'read', path: 'src/sum.mjs', sha256: SHA_READ },
    { index: 2, kind: 'read', path: 'src/sum.mjs', sha256: SHA_WRITE },
    { index: 3, kind: 'write', path: 'src/sum.mjs', sha256: SHA_WRITE, outcome: 'updated' }
  ]
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['READ_BACK_AFTER_WRITE'])
})

check('a review that only rejected never closes', () => {
  const input = closedInput()
  input.usage = [{ rule: 'worker-implements' }, { rule: 'reviewer-rejects' }, { rule: 'worker-repairs' }]
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['REVIEW_REJECTED_THEN_PASSED'])
})

check('a repair decision without a completed repair task never closes', () => {
  const input = closedInput()
  input.tasks = input.tasks.map((task) => (task.id === 't2' ? { ...task, status: 'failed' } : task))
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['REPAIR_COMPLETED', 'TASKS_COMPLETED'])
})

check('three completed tasks are not the whole loop', () => {
  const input = closedInput()
  input.tasks = input.tasks.slice(0, 3)
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['TASKS_COMPLETED'])
})

check('unfinished tasks and a missing review block closure', () => {
  const input = closedInput()
  input.tasks = [{ id: 't1', subject: 'review sum', status: 'in_progress' }]
  input.usage = [{ rule: 'worker-claims-task' }]
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['REVIEW_REJECTED_THEN_PASSED', 'REPAIR_COMPLETED', 'TASKS_COMPLETED'])
})

check('a host that never started is not-started', () => {
  const input = closedInput()
  input.supervisor = { status: 'spec-invalid', hostStarted: false }
  input.writes = []
  input.tests = null
  const summary = deriveAcceptance(input)
  assert.equal(summary.verdict, 'not-started')
  assert.ok(summary.unmet.includes('HOST_STARTED'))
})

check('an incomplete ledger can never close', () => {
  const input = closedInput()
  input.ledger = { completeness: 'INCOMPLETE', ledgerConsistent: false }
  const summary = deriveAcceptance(input)
  assert.equal(summary.verdict, 'partial')
  assert.ok(summary.unmet.includes('LEDGER_COMPLETE'))
})

check('the note keeps the three claims apart', () => {
  const summary = deriveAcceptance(closedInput())
  assert.match(summary.note, /three different claims/u)
})

const failed = checks.filter((entry) => entry.ok === false)
for (const entry of checks) console.log(`${entry.ok ? 'ok' : 'FAIL'} ${entry.name}${entry.ok ? '' : ' — ' + entry.detail}`)
console.log(`acceptance-summary tests: ${checks.length - failed.length} passed, ${failed.length} failed`)
assert.equal(failed.length, 0)
