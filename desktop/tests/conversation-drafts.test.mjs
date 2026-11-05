// 未发送文字协调器的受控测试：假定时器推进防抖，手工 Promise 控制写入顺序，
// 生产代码不包含任何测试延迟。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONVERSATION_DEBOUNCE_MS,
  createConversationDrafts,
} from '../src/lib/conversation-drafts.js'

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
    write: (draft) =>
      new Promise((resolve, reject) => {
        calls.push({ draft, resolve, reject })
      }),
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function setup({ discard } = {}) {
  const timers = fakeTimers()
  const writes = deferredWrites()
  const statuses = []
  const conversation = createConversationDrafts({
    save: writes.write,
    discard: discard ?? (() => Promise.resolve({ ok: true, removed: true })),
    onStatus: (projectId, status) => statuses.push({ projectId, ...status }),
    debounceMs: CONVERSATION_DEBOUNCE_MS,
    timers,
  })
  const lastStatus = () => statuses[statuses.length - 1] ?? null
  return { conversation, timers, writes, statuses, lastStatus }
}

test('防抖只保留最新未发送文字，成功后报告已保留', async (t) => {
  const { conversation, timers, writes, lastStatus } = setup()
  t.after(() => conversation.dispose())

  conversation.noteEdit('project-a', '第一版')
  conversation.noteEdit('project-a', '第二版')
  conversation.noteEdit('project-a', '第三版')
  assert.equal(timers.size(), 1, '连续输入只保留一个防抖定时器')
  assert.equal(lastStatus().kind, 'saving')

  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 1)
  assert.equal(writes.calls[0].draft.text, '第三版')
  assert.equal(writes.calls[0].draft.revision, 1)

  writes.calls[0].resolve({
    ok: true,
    entry: { ...writes.calls[0].draft, updatedAt: '2026-11-05T12:00:00.000Z' },
  })
  await settle()
  assert.equal(lastStatus().kind, 'saved')
  assert.equal(lastStatus().backedUpAt, '2026-11-05T12:00:00.000Z')
})

test('在途时继续输入不会并发写，旧稿完成后补写新稿', async (t) => {
  const { conversation, timers, writes, lastStatus } = setup()
  t.after(() => conversation.dispose())

  conversation.noteEdit('project-a', '第一版')
  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 1)

  conversation.noteEdit('project-a', '第二版')
  assert.equal(timers.size(), 1)
  writes.calls[0].resolve({
    ok: true,
    entry: { ...writes.calls[0].draft, updatedAt: '2026-11-05T12:00:00.000Z' },
  })
  await settle()
  // 第一版落盘时不能提前报告最新文字已经保留。
  assert.notEqual(lastStatus().kind, 'saved')

  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 2)
  assert.equal(writes.calls[1].draft.text, '第二版')
  assert.equal(writes.calls[1].draft.revision, 2)
  writes.calls[1].resolve({
    ok: true,
    entry: { ...writes.calls[1].draft, updatedAt: '2026-11-05T12:00:01.000Z' },
  })
  await settle()
  assert.equal(lastStatus().kind, 'saved')
})

test('写入失败保留待写状态，flush 重试成功后报告已保留', async (t) => {
  const { conversation, timers, writes, lastStatus } = setup()
  t.after(() => conversation.dispose())

  conversation.noteEdit('project-a', '会失败的文字')
  timers.runAll()
  await settle()
  writes.calls[0].resolve({ ok: false, error: { code: 'WRITE_FAILED', message: '磁盘满' } })
  await settle()
  assert.equal(lastStatus().kind, 'failed')
  assert.match(lastStatus().message, /磁盘满/)

  const flushed = conversation.flush()
  await settle()
  assert.equal(writes.calls.length, 2)
  writes.calls[1].resolve({
    ok: true,
    entry: { ...writes.calls[1].draft, updatedAt: '2026-11-05T12:00:02.000Z' },
  })
  const result = await flushed
  assert.equal(result.ok, true)
  assert.equal(lastStatus().kind, 'saved')
})

test('flush 立即写入防抖中的文字，不等定时器', async (t) => {
  const { conversation, timers, writes } = setup()
  t.after(() => conversation.dispose())

  conversation.noteEdit('project-a', '关闭前的文字')
  assert.equal(timers.size(), 1)
  const flushed = conversation.flush()
  await settle()
  assert.equal(timers.size(), 0, 'flush 必须取消防抖定时器')
  assert.equal(writes.calls.length, 1)
  assert.equal(writes.calls[0].draft.text, '关闭前的文字')
  writes.calls[0].resolve({
    ok: true,
    entry: { ...writes.calls[0].draft, updatedAt: '2026-11-05T12:00:03.000Z' },
  })
  assert.deepEqual(await flushed, { ok: true, errors: [] })
})

test('清空输入以空字符串保留，而不是被当成没有内容跳过', async (t) => {
  const { conversation, timers, writes } = setup()
  t.after(() => conversation.dispose())

  conversation.noteEdit('project-a', '先有内容')
  timers.runAll()
  await settle()
  writes.calls[0].resolve({ ok: true, entry: { ...writes.calls[0].draft, updatedAt: '2026-11-05T12:00:04.000Z' } })
  await settle()

  conversation.noteEdit('project-a', '')
  timers.runAll()
  await settle()
  assert.equal(writes.calls.length, 2)
  assert.equal(writes.calls[1].draft.text, '')
  assert.equal(writes.calls[1].draft.revision, 2)
})

test('放弃先等在途写入，再用更高 revision 删除', async (t) => {
  const discardCalls = []
  const { conversation, timers, writes } = setup({
    discard: (request) => {
      discardCalls.push(request)
      return Promise.resolve({ ok: true, removed: true })
    },
  })
  t.after(() => conversation.dispose())

  conversation.noteEdit('project-a', '待删除的文字')
  timers.runAll()
  await settle()

  const discarding = conversation.discard('project-a')
  await settle()
  assert.equal(discardCalls.length, 0, '在途写入未完成前不得删除')
  writes.calls[0].resolve({
    ok: true,
    entry: { ...writes.calls[0].draft, updatedAt: '2026-11-05T12:00:05.000Z' },
  })
  const result = await discarding
  assert.equal(result.ok, true)
  assert.equal(discardCalls.length, 1)
  assert.equal(discardCalls[0].projectId, 'project-a')
  assert.ok(discardCalls[0].revision > 1)
})

test('放弃失败不伪装成功，保留待写状态并可重试', async (t) => {
  let attempts = 0
  const { conversation, lastStatus } = setup({
    discard: () => {
      attempts += 1
      return attempts === 1
        ? Promise.resolve({ ok: false, error: { code: 'WRITE_FAILED', message: '删除失败' } })
        : Promise.resolve({ ok: true, removed: true })
    },
  })
  t.after(() => conversation.dispose())

  conversation.noteEdit('project-a', '取消前的文字')
  const first = await conversation.discard('project-a')
  assert.equal(first.ok, false)
  assert.match(first.error.message, /删除失败/)
  assert.equal(lastStatus().kind, 'failed')

  const second = await conversation.discard('project-a')
  assert.equal(second.ok, true)
})

test('reset 保留磁盘 revision，下一次编辑继续递增', async (t) => {
  const { conversation, timers, writes } = setup()
  t.after(() => conversation.dispose())

  conversation.reset([
    { projectId: 'project-a', text: '磁盘上的文字', revision: 7, updatedAt: '2026-11-05T12:00:06.000Z' },
  ])
  conversation.noteEdit('project-a', '继续编辑')
  timers.runAll()
  await settle()
  assert.equal(writes.calls[0].draft.revision, 8)
})

test('文件读取失败后停止写入，flush 直接返回成功但不冒险覆盖', async (t) => {
  const { conversation, timers, writes, lastStatus } = setup()
  t.after(() => conversation.dispose())

  conversation.markLoadFailure({ code: 'CORRUPT_FILE', message: '坏文件' })
  conversation.noteEdit('project-a', '不应写入')
  assert.equal(timers.size(), 0)
  const result = await conversation.flush()
  assert.equal(result.ok, true)
  assert.equal(writes.calls.length, 0)
  assert.equal(lastStatus(), null)
})
