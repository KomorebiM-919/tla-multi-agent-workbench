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
  ['traversal implementation path', x => x.writes.forEach(e => { e.path = 'src/../sum.mjs' }), 'IMPLEMENTATION_FILE_CHANGED'],
  ['later write hidden by array order', x => {
    x.writes.unshift({ kind: 'write', path: 'src/sum.mjs', index: 10, sha256: 'b'.repeat(64) })
  }, 'READ_BACK_AFTER_WRITE'],
  ['string indices', x => x.writes.forEach(e => { e.index = String(e.index) }), 'READ_BACK_AFTER_WRITE'],
  ['missing index', x => { delete x.writes[0].index }, 'READ_BACK_AFTER_WRITE'],
  ['fractional index', x => { x.writes[1].index = 2.5 }, 'READ_BACK_AFTER_WRITE'],
  ['negative index', x => { x.writes[0].index = -1 }, 'READ_BACK_AFTER_WRITE'],
  ['unsafe integer index', x => { x.writes[1].index = Number.MAX_SAFE_INTEGER + 1 }, 'READ_BACK_AFTER_WRITE'],
  ['infinite index', x => { x.writes[1].index = Infinity }, 'READ_BACK_AFTER_WRITE'],
  ['NaN index', x => { x.writes[1].index = NaN }, 'READ_BACK_AFTER_WRITE'],
  ['duplicate write/read index', x => { x.writes[1].index = 1 }, 'READ_BACK_AFTER_WRITE'],
  ['duplicate write indices', x => {
    x.writes.push({ ...x.writes[0], sha256: 'b'.repeat(64) })
  }, 'READ_BACK_AFTER_WRITE'],
  ['latest read disagrees despite earlier matching read', x => {
    x.writes.unshift({ kind: 'read', path: 'src/sum.mjs', index: 3, sha256: 'b'.repeat(64) })
  }, 'READ_BACK_AFTER_WRITE'],
  ['null file event', x => { x.writes.push(null) }, 'READ_BACK_AFTER_WRITE'],
  ['duplicate index across files', x => {
    x.writes.push({ kind: 'write', path: 'src/other.mjs', index: 1, sha256: 'b'.repeat(64) })
  }, 'READ_BACK_AFTER_WRITE'],
  ['BigInt hashes', x => x.writes.forEach(e => { e.sha256 = BigInt('1'.repeat(64)) }), 'READ_BACK_AFTER_WRITE'],
  ['numeric hashes', x => x.writes.forEach(e => { e.sha256 = 1e63 }), 'READ_BACK_AFTER_WRITE'],
  ['array hashes', x => x.writes.forEach(e => { e.sha256 = ['a'.repeat(64)] }), 'READ_BACK_AFTER_WRITE'],
  ['object hashes', x => x.writes.forEach(e => { e.sha256 = { toString: () => 'a'.repeat(64) } }), 'READ_BACK_AFTER_WRITE']
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

// Shuffled storage order is harmless when explicit indices prove one order.
const shuffled = valid()
shuffled.writes = [
  { kind: 'read', path: 'src/sum.mjs', index: 4, sha256: 'b'.repeat(64) },
  { kind: 'write', path: 'src/sum.mjs', index: 3, sha256: 'b'.repeat(64) },
  ...shuffled.writes
]
const before = structuredClone(shuffled)
assert.equal(deriveAcceptance(shuffled).verdict, 'closed')
assert.deepEqual(shuffled, before, 'verdict must not mutate evidence order')

const zeroBased = valid()
zeroBased.writes.forEach(e => { e.index -= 1 })
assert.equal(deriveAcceptance(zeroBased).verdict, 'closed', 'zero-based indices are valid')

const onlyNote = valid()
onlyNote.writes.forEach(e => { e.path = 'src/note.txt' })
assert.equal(deriveAcceptance(onlyNote).conditions.find(e => e.code === 'IMPLEMENTATION_FILE_CHANGED').detail,
  '0 implementation write(s)', 'detail must count implementation writes only')
console.log(`core acceptance: ${cases.length + 5} passed`)
