// M1B 观察者运行期监视的单元测试。
//
// 这些用例在缺口存在时先失败：tools/lib/observer-journal.mjs 是 supervisor 侧
// 的日志前缀读取器，用来在宿主仍在运行时校验 journal 身份并判定 attached。
// 它们只读内存中的字节，不启动宿主、不写 run 目录、不调用模型。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  OBSERVER_ATTACH_WINDOW_MS,
  awaitObserverAttachment,
  awaitObserverStop,
  evaluateFinalObserverJournal,
  evaluateObserverJournal,
  observerRuntimeFailure,
  readJournalPrefix
} from '../tools/lib/observer-journal.mjs'
import { readLifecycle } from '../orchestration/tool-observer/lifecycle.mjs'

function identity (overrides = {}) {
  return {
    traceId: randomUUID(),
    runnerRunId: 'tla-run-runner',
    launchId: randomUUID(),
    gateRunId: 'tla-run-gate',
    budgetRunId: 'tla-run-gate',
    ...overrides
  }
}

function record (seq, phase, id, overrides = {}) {
  return {
    schema: 'tla.observer-lifecycle/v1',
    seq,
    phase,
    traceId: id.traceId,
    origin: 'host-notification',
    runnerRunId: id.runnerRunId,
    launchId: id.launchId,
    gateRunId: id.gateRunId,
    budgetRunId: id.budgetRunId,
    observerPid: 4242,
    code: phase === 'failed' ? 'WRITE_FAILED' : null,
    health: phase === 'stopped' ? { writerOk: true, cleanupState: 'settled', ownershipUncertain: false } : null,
    ...overrides
  }
}

function bytes (records) {
  return Buffer.from(records.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8')
}

function expectedOf (id) {
  return {
    runnerRunId: id.runnerRunId,
    launchId: id.launchId,
    gateRunId: id.gateRunId,
    budgetRunId: id.budgetRunId
  }
}

test('attached window constant matches the approved ten second bound', () => {
  assert.equal(OBSERVER_ATTACH_WINDOW_MS, 10_000)
})

test('a journal that has not reached attached is pending, not a failure', () => {
  const id = identity()
  const state = evaluateObserverJournal(bytes([record(1, 'preparing', id)]), expectedOf(id))
  assert.equal(state.state, 'pending')
})

test('an incomplete trailing line is not treated as a record', () => {
  const id = identity()
  const first = JSON.stringify(record(1, 'preparing', id))
  const second = JSON.stringify(record(2, 'attached', id))
  const state = evaluateObserverJournal(Buffer.from(first + '\n' + second, 'utf8'), expectedOf(id))
  assert.equal(state.state, 'pending')
  assert.match(state.detail, /incomplete|partial|line/)
})

test('missing journal bytes are pending', () => {
  const id = identity()
  assert.equal(evaluateObserverJournal(null, expectedOf(id)).state, 'pending')
  assert.equal(evaluateObserverJournal(Buffer.alloc(0), expectedOf(id)).state, 'pending')
})

test('attached with the expected identity is accepted', () => {
  const id = identity()
  const state = evaluateObserverJournal(bytes([record(1, 'preparing', id), record(2, 'attached', id)]), expectedOf(id))
  assert.equal(state.state, 'attached')
})

test('a journal written for another launch is a contradiction', () => {
  const id = identity()
  const other = identity({ launchId: randomUUID() })
  const state = evaluateObserverJournal(bytes([record(1, 'preparing', other), record(2, 'attached', other)]), expectedOf(id))
  assert.equal(state.state, 'mismatch')
})

test('a journal whose gate id differs from the budget id is a contradiction', () => {
  const id = identity()
  const bad = identity({ budgetRunId: 'tla-run-other' })
  const state = evaluateObserverJournal(bytes([record(1, 'preparing', bad)]), expectedOf(id))
  // gate/budget 身份不一致本身就是记录级矛盾，归 invalid；对调用方同样是立刻停止。
  assert.equal(state.state, 'invalid')
})

test('a sequence gap is invalid', () => {
  const id = identity()
  const state = evaluateObserverJournal(bytes([record(1, 'preparing', id), record(3, 'attached', id)]), expectedOf(id))
  assert.equal(state.state, 'invalid')
})

test('a journal that changes identity mid-run is invalid', () => {
  const id = identity()
  const swapped = identity({ runnerRunId: 'tla-run-other' })
  const state = evaluateObserverJournal(
    bytes([record(1, 'preparing', id), record(2, 'attached', swapped)]),
    expectedOf(id)
  )
  assert.equal(state.state, 'invalid')
})

test('a failed phase after attached is a failure', () => {
  const id = identity()
  const state = evaluateObserverJournal(
    bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'failed', id)]),
    expectedOf(id)
  )
  assert.equal(state.state, 'failed')
})

test('stopping then stopped is the clean terminal state', () => {
  const id = identity()
  const state = evaluateObserverJournal(
    bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id), record(4, 'stopped', id)]),
    expectedOf(id)
  )
  assert.equal(state.state, 'stopped')
})

test('the prefix reader agrees with the envelope reader on complete journals', () => {
  const id = identity()
  const complete = bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id), record(4, 'stopped', id)])
  assert.equal(readJournalPrefix(complete).phase, 'stopped')
  assert.equal(readLifecycle(complete).phase, 'stopped')
  const open = bytes([record(1, 'preparing', id), record(2, 'attached', id)])
  assert.equal(readJournalPrefix(open).phase, 'attached')
  assert.throws(() => readLifecycle(open))
})

test('a bounded wait returns attached when the record lands on the window boundary', async () => {
  const id = identity()
  let clock = 1_000
  const landed = clock + OBSERVER_ATTACH_WINDOW_MS
  const view = await awaitObserverAttachment({
    read: () => (clock >= landed ? bytes([record(1, 'preparing', id), record(2, 'attached', id)]) : bytes([record(1, 'preparing', id)])),
    expected: expectedOf(id),
    windowMs: OBSERVER_ATTACH_WINDOW_MS,
    now: () => clock,
    pause: async (ms) => { clock += ms },
    stillRunning: () => true
  })
  assert.equal(view.state, 'attached')
  assert.equal(view.waitedMs, OBSERVER_ATTACH_WINDOW_MS)
})

test('a bounded wait reports timeout instead of failing on a just-spawned host', async () => {
  const id = identity()
  let clock = 0
  const view = await awaitObserverAttachment({
    read: () => bytes([record(1, 'preparing', id)]),
    expected: expectedOf(id),
    windowMs: 250,
    now: () => clock,
    pause: async (ms) => { clock += ms },
    stillRunning: () => true
  })
  assert.equal(view.state, 'timeout')
  assert.equal(view.waitedMs, 250)
})

test('a bounded wait stops early once the host has exited', async () => {
  const id = identity()
  let clock = 0
  let running = true
  const view = await awaitObserverAttachment({
    read: () => bytes([record(1, 'preparing', id)]),
    expected: expectedOf(id),
    windowMs: 5_000,
    now: () => clock,
    pause: async (ms) => { clock += ms; if (clock >= 100) running = false },
    stillRunning: () => running
  })
  assert.equal(view.state, 'host-exited')
  assert.ok(clock < 5_000)
})

test('a bounded wait aborts on a contradiction without spending the window', async () => {
  const id = identity()
  const other = identity({ launchId: randomUUID() })
  let clock = 0
  const view = await awaitObserverAttachment({
    read: () => bytes([record(1, 'preparing', other), record(2, 'attached', other)]),
    expected: expectedOf(id),
    windowMs: 5_000,
    now: () => clock,
    pause: async (ms) => { clock += ms },
    stillRunning: () => true
  })
  assert.equal(view.state, 'mismatch')
  assert.equal(clock, 0)
})

test('the attach window never exceeds the overall host timeout', async () => {
  const id = identity()
  let clock = 0
  const view = await awaitObserverAttachment({
    read: () => bytes([record(1, 'preparing', id)]),
    expected: expectedOf(id),
    windowMs: OBSERVER_ATTACH_WINDOW_MS,
    deadline: 1_500,
    now: () => clock,
    pause: async (ms) => { clock += ms },
    stillRunning: () => true
  })
  assert.equal(view.state, 'timeout')
  assert.equal(view.waitedMs, 1_500)
})

// 以下用例针对 Codex 审查指出的运行期缺口：attached 之后 journal 消失/回退、
// 观察器提前停止、读取异常，以及"尾部半行/终态后记录仍被记为成功"的最终判定。

test('the runtime watch classifies the loss of an attached journal', () => {
  assert.equal(observerRuntimeFailure('attached'), null)
  assert.equal(observerRuntimeFailure('stopped'), 'OBSERVER_STOPPED_EARLY')
  assert.equal(observerRuntimeFailure('pending'), 'OBSERVER_REGRESSED')
  assert.equal(observerRuntimeFailure('failed'), 'OBSERVER_FAILED')
  assert.equal(observerRuntimeFailure('mismatch'), 'OBSERVER_IDENTITY_MISMATCH')
  assert.equal(observerRuntimeFailure('invalid'), 'OBSERVER_INVALID')
})

test('a complete lifecycle journal passes the final evaluation', () => {
  const id = identity()
  const view = evaluateFinalObserverJournal(
    bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id), record(4, 'stopped', id)]),
    expectedOf(id)
  )
  assert.equal(view.ok, true)
  assert.equal(view.state, 'stopped')
})

test('a trailing half line after stopped cannot be recorded as success', () => {
  const id = identity()
  const complete = bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id), record(4, 'stopped', id)])
  const view = evaluateFinalObserverJournal(Buffer.concat([complete, Buffer.from('{"schema":"tla.observer-', 'utf8')]), expectedOf(id))
  assert.equal(view.ok, false)
  assert.equal(view.state, 'invalid')
})

test('a record after the terminal phase cannot be recorded as success', () => {
  const id = identity()
  const view = evaluateFinalObserverJournal(
    bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id), record(4, 'stopped', id), record(5, 'stopping', id)]),
    expectedOf(id)
  )
  assert.equal(view.ok, false)
  assert.equal(view.state, 'invalid')
})

test('invalid UTF-8 in the final journal cannot be recorded as success', () => {
  const id = identity()
  const complete = bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id), record(4, 'stopped', id)])
  const view = evaluateFinalObserverJournal(Buffer.concat([complete, Buffer.from([0xff])]), expectedOf(id))
  assert.equal(view.ok, false)
  assert.equal(view.state, 'invalid')
})

test('a missing final journal is reported as missing, not as success', () => {
  const id = identity()
  assert.equal(evaluateFinalObserverJournal(null, expectedOf(id)).state, 'missing')
  assert.equal(evaluateFinalObserverJournal(null, expectedOf(id)).ok, false)
})

test('a foreign final journal is a mismatch', () => {
  const id = identity()
  const other = identity({ launchId: randomUUID() })
  const view = evaluateFinalObserverJournal(
    bytes([record(1, 'preparing', other), record(2, 'attached', other), record(3, 'stopping', other), record(4, 'stopped', other)]),
    expectedOf(id)
  )
  assert.equal(view.ok, false)
  assert.equal(view.state, 'mismatch')
})

test('a journal that never reached a terminal phase is incomplete', () => {
  const id = identity()
  const view = evaluateFinalObserverJournal(bytes([record(1, 'preparing', id), record(2, 'attached', id)]), expectedOf(id))
  assert.equal(view.ok, false)
  assert.equal(view.state, 'incomplete')
})

test('a failed phase is never a successful final state', () => {
  const id = identity()
  const view = evaluateFinalObserverJournal(bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'failed', id)]), expectedOf(id))
  assert.equal(view.ok, false)
  assert.equal(view.state, 'failed')
})

test('the bounded stop wait retries while the journal is still writing', async () => {
  const id = identity()
  let clock = 0
  const complete = bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id), record(4, 'stopped', id)])
  const view = await awaitObserverStop({
    read: () => (clock < 120 ? bytes([record(1, 'preparing', id), record(2, 'attached', id)]) : complete),
    expected: expectedOf(id),
    budgetMs: 1_000,
    now: () => clock,
    pause: async (ms) => { clock += ms }
  })
  assert.equal(view.ok, true)
  assert.ok(clock >= 120)
})

test('the bounded stop wait gives up instead of hanging', async () => {
  const id = identity()
  let clock = 0
  const view = await awaitObserverStop({
    read: () => bytes([record(1, 'preparing', id), record(2, 'attached', id)]),
    expected: expectedOf(id),
    budgetMs: 300,
    now: () => clock,
    pause: async (ms) => { clock += ms }
  })
  assert.equal(view.ok, false)
  assert.equal(view.state, 'incomplete')
  assert.ok(clock >= 300)
})

test('a read error during the bounded stop wait is reported, not thrown', async () => {
  const id = identity()
  const view = await awaitObserverStop({
    read: () => { const error = new Error('EISDIR: illegal operation on a directory'); error.code = 'EISDIR'; throw error },
    expected: expectedOf(id),
    budgetMs: 100,
    now: () => 0,
    pause: async () => {}
  })
  assert.equal(view.ok, false)
  assert.equal(view.state, 'unreadable')
})

test('a stopping journal is reported as stopping, not as attached', () => {
  const id = identity()
  const view = evaluateObserverJournal(bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id)]), expectedOf(id))
  assert.equal(view.state, 'stopping')
})

test('stopping is a stop signal, not a runtime failure by itself', () => {
  assert.equal(observerRuntimeFailure('stopping'), null)
  assert.equal(observerRuntimeFailure('attached'), null)
  assert.equal(observerRuntimeFailure('stopped'), 'OBSERVER_STOPPED_EARLY')
})

test('the attach wait stops at a stopping journal instead of reporting attached', async () => {
  const id = identity()
  let clock = 0
  const view = await awaitObserverAttachment({
    read: () => bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id)]),
    expected: expectedOf(id),
    windowMs: 5000,
    now: () => clock,
    pause: async (ms) => { clock += ms }
  })
  assert.equal(view.state, 'stopping')
  assert.ok(clock < 5000)
})

test('a journal that only reached stopping is not a clean final state', () => {
  const id = identity()
  const view = evaluateFinalObserverJournal(bytes([record(1, 'preparing', id), record(2, 'attached', id), record(3, 'stopping', id)]), expectedOf(id))
  assert.equal(view.ok, false)
  assert.equal(view.state, 'incomplete')
})
