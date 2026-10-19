import assert from 'node:assert/strict'
import { deriveAcceptance } from '../tools/acceptance-summary.mjs'

function valid() {
  const hash = 'a'.repeat(64)
  return {
    supervisor: { status: 'completed', hostStarted: true },
    ledger: { completeness: 'COMPLETE', ledgerConsistent: true },
    tests: { exitCode: 0, passed: 3, failed: 0, history: [
      { command: 'node test/sum.test.mjs', exitCode: 1, failed: 1 },
      { command: 'node test/sum.test.mjs', exitCode: 0, failed: 0 }
    ] },
    tasks: ['implement', 'review', 'repair', 'review again'].map((subject, i) => ({ id: `t${i}`, subject, status: 'completed' })),
    usage: [{ rule: 'reviewer-rejects' }, { rule: 'worker-repairs' }, { rule: 'reviewer-passes' }],
    writes: [{ kind: 'write', path: 'src/sum.mjs', index: 1, sha256: hash },
      { kind: 'read', path: 'src/sum.mjs', index: 2, sha256: hash }]
  }
}

const cases = [
  ['missing hashes', x => x.writes.forEach(e => delete e.sha256), 'READ_BACK_AFTER_WRITE'],
  ['malformed hashes', x => x.writes.forEach(e => { e.sha256 = 'unknown' }), 'READ_BACK_AFTER_WRITE'],
  ['review passed before rejection', x => x.usage.reverse(), 'REVIEW_REJECTED_THEN_PASSED'],
  ['unknown test exit', x => { x.tests.history[0].exitCode = null }, 'TESTS_RED_THEN_GREEN'],
  ['missing test command', x => x.tests.history.forEach(e => delete e.command), 'TESTS_RED_THEN_GREEN'],
  ['zero tests', x => { x.tests.passed = 0 }, 'TESTS_GREEN'],
  ['duplicate task ids', x => x.tasks.forEach(e => { e.id = 't1' }), 'TASKS_COMPLETED'],
  ['traversal implementation path', x => x.writes.forEach(e => { e.path = 'src/../sum.mjs' }), 'IMPLEMENTATION_FILE_CHANGED']
]
assert.equal(deriveAcceptance(valid()).verdict, 'closed')
const failures = []
for (const [name, mutate, condition] of cases) {
  const input = valid()
  mutate(input)
  try {
    assert.ok(deriveAcceptance(input).unmet.includes(condition), name)
    console.log('ok ' + name)
  } catch (error) { failures.push(error.message) }
}
assert.deepEqual(failures, [])
console.log(`core acceptance: ${cases.length + 1} passed`)
