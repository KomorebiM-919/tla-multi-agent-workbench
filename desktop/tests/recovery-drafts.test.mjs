// 恢复稿协调器的受控测试：用假定时器推进防抖、用手工 Promise 控制写入顺序，
// 不在生产代码里加任何测试延迟。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecoveryDrafts } from '../src/lib/recovery-drafts.js'

function project(overrides = {}) {
  return {
    id: 'project-a',
    name: '项目 A',
    description: '简介',
    taskDraft: '草稿',
    ...overrides,
  }
}

function fakeTimers() {
  let nextId = 1
  const scheduled = new Map()
  return {
    setTimeout(callback) {
      const id = nextId
      nextId += 1
      scheduled.set(id, callback)
      return id
    },
    clearTimeout(id) {
      scheduled.delete(id)
    },
    runAll() {
      const callbacks = [...scheduled.values()]
      scheduled.clear()
      for (const callback of callbacks) callback()
    },
    size() {
      return scheduled.size
    },
  }
}

function deferredWrites() {
  const calls = []
  return {
    calls,
    write: (snapshot) =>
      new Promise((resolve, reject) => {
        calls.push({ snapshot, resolve, reject })
      }),
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function setup({ discard } = {}) {
  const timers = fakeTimers()
  const writes = deferredWrites()
  const statuses = []
  const draft = createRecoveryDrafts({
    save: writes.write,
    discard: discard ?? (() => Promise.resolve({ ok: true, removed: true })),
    onStatus: (projectId, status) => statuses.push({ projectId, ...status }),
    debounceMs: 400,
    timers,
  })
  const lastStatus = () => statuses[statuses.length - 1] ?? null
  return { draft, timers, writes, statuses, lastStatus }
}

test('防抖只备份最新文本，保存成功后报告已备份', async (t) => {
  const { draft, timers, writes, lastStatus } = setup()
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '第一版' }))
  draft.noteEdit(project({ taskDraft: '第二版' }))
  draft.noteEdit(project({ taskDraft: '第三版' }))
  assert.equal(timers.size(), 1, '连续编辑只保留一个防抖定时器')
  assert.equal(lastStatus().kind, 'saving')

  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 1)
  assert.equal(writes.calls[0].snapshot.taskDraft, '第三版')
  assert.equal(writes.calls[0].snapshot.revision, 1)

  writes.calls[0].resolve({
    ok: true,
    entry: { ...writes.calls[0].snapshot, updatedAt: '2026-11-04T12:00:00.000Z' },
  })
  await settle()
  assert.equal(lastStatus().kind, 'saved')
  assert.equal(lastStatus().backedUpAt, '2026-11-04T12:00:00.000Z')
})

test('写入期间继续编辑：先写完旧稿，再补写新稿，不提前报告已备份', async (t) => {
  const { draft, timers, writes, lastStatus } = setup()
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '旧稿' }))
  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 1)

  draft.noteEdit(project({ taskDraft: '新稿' }))
  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 1, '在途写入未结束前不得并发写第二份')

  writes.calls[0].resolve({ ok: true, entry: { ...writes.calls[0].snapshot, updatedAt: 'T1' } })
  await settle()
  assert.equal(writes.calls.length, 2)
  assert.equal(writes.calls[1].snapshot.taskDraft, '新稿')
  assert.equal(writes.calls[1].snapshot.revision, 2)

  writes.calls[1].resolve({ ok: true, entry: { ...writes.calls[1].snapshot, updatedAt: 'T2' } })
  await settle()
  assert.equal(lastStatus().kind, 'saved')
  assert.equal(draft.hasPending(), false)
})

test('写入失败恢复待备份并报告失败，flush 会重试', async (t) => {
  const { draft, timers, writes, lastStatus } = setup()
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '会失败的稿' }))
  timers.runAll()
  await settle()
  writes.calls[0].resolve({ ok: false, error: { code: 'WRITE_FAILED', message: '磁盘不可写' } })
  await settle()

  assert.equal(lastStatus().kind, 'failed')
  assert.equal(lastStatus().message, '磁盘不可写')
  assert.equal(draft.hasPending(), true, '失败后仍保留待备份内容')

  const flushing = draft.flush()
  await settle()
  assert.equal(writes.calls.length, 2)
  writes.calls[1].resolve({ ok: true, entry: { ...writes.calls[1].snapshot, updatedAt: 'T3' } })
  const result = await flushing
  assert.equal(result.ok, true)
  assert.equal(lastStatus().kind, 'saved')
})

test('flush 立即写掉防抖中的最新编辑，不等待定时器', async (t) => {
  const { draft, timers, writes } = setup()
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '关闭前最后一笔' }))
  assert.equal(timers.size(), 1)

  const flushing = draft.flush()
  await settle()
  assert.equal(timers.size(), 0, 'flush 应取消防抖定时器')
  assert.equal(writes.calls.length, 1)
  assert.equal(writes.calls[0].snapshot.taskDraft, '关闭前最后一笔')

  writes.calls[0].resolve({ ok: true, entry: { ...writes.calls[0].snapshot, updatedAt: 'T4' } })
  const result = await flushing
  assert.equal(result.ok, true)
})

test('flush 失败时如实返回错误，不冒充写完', async (t) => {
  const { draft, writes } = setup()
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '写不进去' }))
  const flushing = draft.flush()
  await settle()
  writes.calls[0].resolve({ ok: false, error: { code: 'WRITE_FAILED', message: '磁盘满' } })
  const result = await flushing

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    { projectId: 'project-a', error: { code: 'WRITE_FAILED', message: '磁盘满' } },
  ])
})

test('放弃先等在途写入，再用更高 revision 删除；迟到备份被墓碑挡住', async (t) => {
  const discardCalls = []
  const { draft, timers, writes, lastStatus } = setup({
    discard: (request) => {
      discardCalls.push(request)
      return Promise.resolve({ ok: true, removed: true })
    },
  })
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '还在写' }))
  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 1)

  const discarding = draft.discard('project-a')
  await settle()
  assert.equal(discardCalls.length, 0, '删除必须等在途写入落定')

  writes.calls[0].resolve({ ok: true, entry: { ...writes.calls[0].snapshot, updatedAt: 'T5' } })
  const result = await discarding
  assert.equal(result.ok, true)
  assert.deepEqual(discardCalls, [{ projectId: 'project-a', revision: 2 }])
  assert.equal(lastStatus().kind, 'idle')
  assert.equal(draft.hasPending(), false)
})

test('删除失败不伪装成功，恢复待备份并保留错误', async (t) => {
  let attempts = 0
  const { draft, timers, writes, lastStatus } = setup({
    discard: () => {
      attempts += 1
      if (attempts === 1) {
        return Promise.resolve({ ok: false, error: { code: 'WRITE_FAILED', message: '删除失败' } })
      }
      return Promise.resolve({ ok: true, removed: true })
    },
  })
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '待删除' }))
  timers.runAll()
  await settle()
  writes.calls[0].resolve({ ok: true, entry: { ...writes.calls[0].snapshot, updatedAt: 'T6' } })
  await settle()

  const failed = await draft.discard('project-a')
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'WRITE_FAILED')
  assert.equal(lastStatus().kind, 'failed')
  assert.equal(draft.hasPending(), true, '删除失败必须保留恢复能力')

  const retried = await draft.discard('project-a')
  assert.equal(retried.ok, true)
})

test('正式保存成功后只清理“正好被覆盖”的恢复稿', async (t) => {
  const discardCalls = []
  const saveCalls = []
  const timers = fakeTimers()
  const draft = createRecoveryDrafts({
    save: (snapshot) => {
      saveCalls.push(snapshot)
      return Promise.resolve({ ok: true, entry: { ...snapshot, updatedAt: 'T7' } })
    },
    discard: (request) => {
      discardCalls.push(request)
      return Promise.resolve({ ok: true, removed: true })
    },
    timers,
    debounceMs: 400,
  })
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '已保存内容' }))
  timers.runAll()
  await settle()
  assert.equal(saveCalls.length, 1)

  const cleared = await draft.clearCovered('project-a', project({ taskDraft: '已保存内容' }))
  assert.equal(cleared.cleared, true)
  assert.deepEqual(discardCalls, [{ projectId: 'project-a', revision: 2 }])

  draft.noteEdit(project({ taskDraft: '保存后又改了' }))
  const kept = await draft.clearCovered('project-a', project({ taskDraft: '已保存内容' }))
  assert.equal(kept.cleared, false)
  assert.equal(kept.reason, 'newer-edits')
  assert.equal(discardCalls.length, 1, '有更新编辑时不得清理恢复稿')
})

test('恢复稿读取失败后停止备份，但不影响正式保存', async (t) => {
  const { draft, timers, writes, statuses } = setup()
  t.after(() => draft.dispose())

  draft.markLoadFailure({ code: 'CORRUPT_FILE', message: '恢复稿损坏' })
  draft.noteEdit(project({ taskDraft: '不应备份' }))
  assert.equal(timers.size(), 0)
  assert.equal(statuses.length, 0)

  const result = await draft.flush()
  assert.equal(result.ok, true)
  assert.equal(writes.calls.length, 0)
  assert.equal(draft.hasPending(), false)
})

test('载入已有恢复稿后，新编辑从磁盘 revision 继续递增', async (t) => {
  const { draft, timers, writes, statuses } = setup()
  t.after(() => draft.dispose())

  draft.reset([
    {
      id: 'project-a',
      name: '项目 A',
      description: '',
      taskDraft: '旧恢复稿',
      revision: 7,
      updatedAt: '2026-11-04T10:00:00.000Z',
    },
  ])
  assert.equal(statuses[0].kind, 'saved')

  draft.noteEdit(project({ taskDraft: '新恢复稿' }))
  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 1)
  assert.equal(writes.calls[0].snapshot.revision, 8)
})
