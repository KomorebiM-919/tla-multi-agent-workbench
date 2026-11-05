// 未发送文字的端到端回归：真实隔离文件 + 真实协调器，覆盖新项目、关闭刷新、
// 清空、放弃与迟到写入；不读取真实 .local 数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createConversationStore } from '../electron/conversation-drafts-store.mjs'
import { createConversationDrafts } from '../src/lib/conversation-drafts.js'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

const FILE_NAME = 'conversation-drafts.json'

async function openStore(dir) {
  const filePath = path.join(dir, FILE_NAME)
  const store = createConversationStore({ filePath })
  return { filePath, store }
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
  }
}

function controllerFor(store, timers) {
  return createConversationDrafts({
    // 主进程 IPC 返回 {ok, entry}；测试里把 store 的结果包成同样的形状。
    save: async (draft) => ({ ok: true, entry: await store.save(draft).then((result) => result.entry) }),
    discard: async (request) => ({ ok: true, ...(await store.discard(request)) }),
    debounceMs: 400,
    timers,
  })
}

test('新建未保存项目的文字正常关闭后重开可恢复，放弃后不再出现', async (t) => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))

  const { store } = await openStore(dir)
  const timers = fakeTimers()
  const conversation = controllerFor(store, timers)
  conversation.noteEdit('project-new', '新建项目的未发送文字\n第二行，含中文。')
  // 正常关闭：不等 400ms 防抖，直接刷新。
  const flushed = await conversation.flush()
  assert.equal(flushed.ok, true)
  conversation.dispose()

  const reopened = createConversationStore({ filePath: path.join(dir, FILE_NAME) })
  const loaded = await reopened.load()
  assert.equal(loaded.source, 'file')
  assert.equal(loaded.drafts.length, 1)
  assert.equal(loaded.drafts[0].projectId, 'project-new')
  assert.equal(loaded.drafts[0].text, '新建项目的未发送文字\n第二行，含中文。')

  const discarded = await reopened.discard({ projectId: 'project-new', revision: 2 })
  assert.equal(discarded.removed, true)
  assert.equal((await reopened.load()).drafts.length, 0)
})

test('关闭刷新失败时不报告成功，原文件保持不变', async (t) => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))

  const { filePath, store } = await openStore(dir)
  const timers = fakeTimers()
  let failure = null
  const conversation = createConversationDrafts({
    save: async (draft) => {
      if (failure) return { ok: false, error: failure }
      const { entry } = await store.save(draft)
      return { ok: true, entry }
    },
    discard: async (request) => ({ ok: true, ...(await store.discard(request)) }),
    debounceMs: 400,
    timers,
  })
  conversation.noteEdit('project-a', '第一版正常文字')
  assert.equal((await conversation.flush()).ok, true)
  const before = await readFile(filePath, 'utf8')

  failure = { code: 'WRITE_FAILED', message: '磁盘不可写' }
  conversation.noteEdit('project-a', '第二版没能保存')
  const flushed = await conversation.flush()
  assert.equal(flushed.ok, false)
  assert.equal(flushed.errors.length, 1)
  assert.match(flushed.errors[0].error.message, /磁盘不可写/)
  assert.equal(await readFile(filePath, 'utf8'), before, '刷新失败不得改动原文件')
})

test('放弃与迟到写入交错：旧稿不能复活，之后的新文字仍可保留', async (t) => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))

  const { store } = await openStore(dir)
  await store.save({ projectId: 'project-a', text: '旧文字', revision: 1 })

  const release = []
  const timers = fakeTimers()
  const conversation = createConversationDrafts({
    save: (draft) =>
      new Promise((resolve) => {
        release.push(() =>
          store.save(draft).then(
            (result) => resolve({ ok: true, entry: result.entry }),
            () => resolve({ ok: false, error: { code: 'WRITE_FAILED', message: '写失败' } }),
          ),
        )
      }),
    discard: async (request) => ({ ok: true, ...(await store.discard(request)) }),
    debounceMs: 400,
    timers,
  })
  conversation.reset([{ projectId: 'project-a', text: '旧文字', revision: 1, updatedAt: new Date().toISOString() }])
  conversation.noteEdit('project-a', '取消前的新文字')
  timers.runAll()
  // 在途写入尚未返回时发起放弃：协调器必须先等在途结束。
  const discarding = conversation.discard('project-a')
  assert.equal(release.length, 1)
  release[0]()
  const result = await discarding
  assert.equal(result.ok, true)
  conversation.dispose()

  await assert.rejects(
    store.save({ projectId: 'project-a', text: '迟到的旧稿', revision: 2 }),
    (error) => error.code === 'DISCARDED',
  )
  assert.equal((await store.load()).drafts.length, 0, '迟到写入不得让已放弃的项目重开复活')
})
