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

const closedInput = () => ({
  supervisor: { status: 'completed', hostStarted: true },
  ledger: { completeness: 'COMPLETE', ledgerConsistent: true },
  tests: { exitCode: 0, passed: 3, failed: 0 },
  tasks: [{ id: 't1', status: 'completed' }],
  usage: [{ rule: 'worker-implements' }, { rule: 'reviewer-passes' }],
  writes: [{ rule: 'worker-implements', path: 'src/sum.mjs', outcome: 'updated' }]
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

check('supervisor completed with red tests is partial, not closed', () => {
  const input = closedInput()
  input.tests = { exitCode: 1, passed: 0, failed: 3 }
  const summary = deriveAcceptance(input)
  assert.equal(summary.verdict, 'partial')
  assert.deepEqual(summary.unmet, ['TESTS_GREEN'])
})

check('a member write is required even when tests are green', () => {
  const input = closedInput()
  input.writes = []
  const summary = deriveAcceptance(input)
  assert.equal(summary.verdict, 'partial')
  assert.deepEqual(summary.unmet, ['MEMBER_WROTE_A_FILE'])
})

check('unfinished tasks and a missing review block closure', () => {
  const input = closedInput()
  input.tasks = [{ id: 't1', status: 'in_progress' }]
  input.usage = [{ rule: 'worker-claims-task' }]
  const summary = deriveAcceptance(input)
  assert.deepEqual(summary.unmet, ['TASKS_COMPLETED', 'REVIEW_RAN'])
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
