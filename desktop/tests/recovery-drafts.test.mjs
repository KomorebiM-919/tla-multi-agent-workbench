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

test('清理恢复稿之后再次编辑：revision 继续递增，不会被墓碑当成迟到写入', async (t) => {
  const timers = fakeTimers()
  const saves = []
  let highWater = 0
  const draft = createRecoveryDrafts({
    save: async (snapshot) => {
      // 主进程墓碑：撤销水位之后只接受更高 revision，和 recovery-store 的规则一致。
      if (snapshot.revision <= highWater) {
        return { ok: false, error: { code: 'DISCARDED', message: '已放弃' } }
      }
      highWater = snapshot.revision
      saves.push(snapshot)
      return { ok: true, entry: { ...snapshot, updatedAt: `T${snapshot.revision}` } }
    },
    discard: async ({ revision }) => {
      highWater = Math.max(highWater, revision)
      return { ok: true, removed: true }
    },
    timers,
    debounceMs: 400,
  })
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '已保存内容' }))
  timers.runAll()
  await settle()
  assert.equal(saves.length, 1)

  const cleared = await draft.clearCovered('project-a', project({ taskDraft: '已保存内容' }))
  assert.equal(cleared.cleared, true)

  draft.noteEdit(project({ taskDraft: '保存后又改了一笔' }))
  timers.runAll()
  await settle()

  assert.equal(saves.length, 2, '清理后的新编辑必须还能写入')
  assert.equal(saves[1].revision, 3, '版本号必须继续高于墓碑水位')
  assert.equal(saves[1].taskDraft, '保存后又改了一笔')
  assert.equal(draft.hasPending(), false)
})

test('清理期间的新输入不被删除：保留新稿并继续备份', async (t) => {
  const timers = fakeTimers()
  const writes = deferredWrites()
  let releaseDiscard
  const discardCalls = []
  const draft = createRecoveryDrafts({
    save: writes.write,
    discard: ({ projectId, revision }) => {
      discardCalls.push({ projectId, revision })
      return new Promise((resolve) => {
        releaseDiscard = resolve
      })
    },
    timers,
    debounceMs: 400,
  })
  t.after(() => draft.dispose())

  draft.noteEdit(project({ taskDraft: '已保存内容' }))
  timers.runAll()
  await settle()
  writes.calls[0].resolve({ ok: true, entry: { ...writes.calls[0].snapshot, updatedAt: 'T1' } })
  await settle()

  // 正式保存成功，开始清理正好被覆盖的恢复稿；清理请求先挂起。
  const clearing = draft.clearCovered('project-a', project({ taskDraft: '已保存内容' }))
  await settle()
  assert.equal(discardCalls.length, 1)
  assert.equal(discardCalls[0].revision, 2)

  // 清理还没返回时用户继续输入：这份新稿必须保留，不能被清理逻辑一起删掉。
  draft.noteEdit(project({ taskDraft: '清理期间的新稿' }))
  assert.equal(draft.hasPending(), true)

  releaseDiscard({ ok: true, removed: true })
  const cleared = await clearing
  assert.equal(cleared.ok, true)
  assert.equal(cleared.cleared, false)
  assert.equal(cleared.reason, 'newer-edits')

  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 2, '新稿应重新提交备份')
  assert.equal(writes.calls[1].snapshot.taskDraft, '清理期间的新稿')
  assert.equal(writes.calls[1].snapshot.revision, 3)

  writes.calls[1].resolve({ ok: true, entry: { ...writes.calls[1].snapshot, updatedAt: 'T2' } })
  await settle()
  assert.equal(draft.hasPending(), false)
})

test('从未编辑过的项目也能取消；删除按 revision 1 发起', async (t) => {
  const calls = []
  const timers = fakeTimers()
  const draft = createRecoveryDrafts({
    save: () => Promise.resolve({ ok: true, entry: { updatedAt: 'T' } }),
    discard: async (request) => {
      calls.push(request)
      return { ok: true, removed: false }
    },
    timers,
    debounceMs: 400,
  })
  t.after(() => draft.dispose())

  const result = await draft.discard('never-edited')
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{ projectId: 'never-edited', revision: 1 }])
  assert.equal(draft.hasPending(), false)
})
