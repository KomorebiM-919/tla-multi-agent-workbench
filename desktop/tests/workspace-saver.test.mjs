// 保存协调 + 真实文件往返：验证“同一时刻只有一份保存快照在途”。
//
// 桥接层用一个受控 Promise 模拟主进程：点击保存后请求先挂起，测试决定何时让它完成。
// 这样可以在“上一次保存还没返回”的真实时序里，尝试提交第二份快照。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { createWorkspaceStore } from '../electron/workspace-store.mjs'
import { isProjectDirty } from '../src/lib/workspace-editing.js'
import { createWorkspaceSaver } from '../src/lib/workspace-saver.js'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

// 给“本应同步返回 busy”的分支一个机会立刻兑现，避免测试卡在未决 Promise 上。
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function workspaceWith({ aDraft, bDraft, activeProjectId = 'a' }) {
  return {
    schemaVersion: 1,
    activeProjectId,
    projects: [
      { id: 'a', name: '项目 A', description: '', taskDraft: aDraft },
      { id: 'b', name: '项目 B', description: '', taskDraft: bDraft },
    ],
  }
}

function createBridge() {
  const calls = []
  function save(payload) {
    const call = { payload }
    call.promise = new Promise((resolve, reject) => {
      call.resolve = resolve
      call.reject = reject
    })
    calls.push(call)
    return call.promise
  }
  return { calls, save }
}

async function readDrafts(filePath) {
  const data = JSON.parse(await readFile(filePath, 'utf8'))
  return Object.fromEntries(data.projects.map((project) => [project.id, project.taskDraft]))
}

async function setup(t) {
  const directory = await makeTempDir()
  t.after(() => removeTempDir(directory))
  const filePath = path.join(directory, 'workspace.json')
  const store = createWorkspaceStore({ filePath })
  const initial = await store.save(workspaceWith({ aDraft: 'A-old', bDraft: 'B-old' }))
  const bridge = createBridge()
  const events = { start: [], saved: [], failed: [], finish: [] }
  const saver = createWorkspaceSaver({
    save: bridge.save,
    onStart: (id) => events.start.push(id),
    onSaved: (_result, id) => events.saved.push(id),
    onFailed: (_error, id) => events.failed.push(id),
    onFinish: (id) => events.finish.push(id),
  })
  saver.reset(initial.workspace)
  return { directory, filePath, store, bridge, saver, events }
}

/** 让挂起的桥接调用真正写入文件，再把结果交回 saver（形状与 IPC 成功返回值一致）。 */
async function completeWithStore(store, call) {
  const result = await store.save(call.payload)
  call.resolve({ ok: true, ...result })
  return result
}

test('A 在途时拒绝 B 的旧快照，A 完成后再存 B 得到 A-new/B-new', async (t) => {
  const { filePath, store, bridge, saver } = await setup(t)

  const saveA = saver.save(workspaceWith({ aDraft: 'A-new', bDraft: 'B-old' }), { id: 'a' })
  assert.equal(bridge.calls.length, 1, 'A 的保存请求已经发出')
  assert.equal(saver.isSaving(), true)

  // B 的会话仍是 A-old/B-new：如果此时放行，payload 会拿旧 baseline 覆盖 A 的新内容。
  const blocked = await Promise.race([
    saver.save(workspaceWith({ aDraft: 'A-old', bDraft: 'B-new', activeProjectId: 'b' }), {
      id: 'b',
    }),
    settle().then(() => ({ status: 'pending' })),
  ])
  assert.deepEqual(blocked, { status: 'busy' })
  assert.equal(bridge.calls.length, 1, 'B 没有提交第二份快照')
  assert.deepEqual(await readDrafts(filePath), { a: 'A-old', b: 'B-old' }, '文件仍是上一次成功的版本')

  await completeWithStore(store, bridge.calls[0])
  assert.equal((await saveA).status, 'saved')
  assert.deepEqual(await readDrafts(filePath), { a: 'A-new', b: 'B-old' })

  const saveB = saver.save(workspaceWith({ aDraft: 'A-old', bDraft: 'B-new', activeProjectId: 'b' }), {
    id: 'b',
  })
  assert.equal(bridge.calls.length, 2, 'A 完成后 B 可以保存')
  await completeWithStore(store, bridge.calls[1])
  assert.equal((await saveB).status, 'saved')
  assert.deepEqual(await readDrafts(filePath), { a: 'A-new', b: 'B-new' })
})

test('连点两次保存只提交一次请求', async (t) => {
  const { bridge, saver } = await setup(t)
  const session = workspaceWith({ aDraft: 'A-new', bDraft: 'B-old' })

  const first = saver.save(session, { id: 'a' })
  const second = await Promise.race([
    saver.save(session, { id: 'a' }),
    settle().then(() => ({ status: 'pending' })),
  ])
  assert.deepEqual(second, { status: 'busy' })
  assert.equal(bridge.calls.length, 1)

  bridge.calls[0].resolve({ ok: false, error: { code: 'SAVE_REJECTED', message: '保存请求被拒绝。' } })
  assert.equal((await first).status, 'failed')
})

test('保存失败后释放保护，可以正常重试并写入新内容', async (t) => {
  const { filePath, store, bridge, saver, events } = await setup(t)

  const first = saver.save(workspaceWith({ aDraft: 'A-new', bDraft: 'B-old' }), { id: 'a' })
  bridge.calls[0].resolve({ ok: false, error: { code: 'WRITE_FAILED', message: '磁盘不可写' } })
  const failed = await first
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'WRITE_FAILED')
  assert.equal(saver.isSaving(), false)
  assert.deepEqual(events.failed, ['a'])
  assert.deepEqual(await readDrafts(filePath), { a: 'A-old', b: 'B-old' }, '失败不写坏文件')

  const retry = saver.save(workspaceWith({ aDraft: 'A-new', bDraft: 'B-old' }), { id: 'a' })
  assert.equal(bridge.calls.length, 2, '失败后下一次保存可以提交')
  await completeWithStore(store, bridge.calls[1])
  assert.equal((await retry).status, 'saved')
  assert.deepEqual(await readDrafts(filePath), { a: 'A-new', b: 'B-old' })
})

test('保存期间继续编辑，完成后仍显示为未保存', async (t) => {
  const { store, bridge, saver } = await setup(t)
  const session = workspaceWith({ aDraft: 'A-new', bDraft: 'B-old' })
  const pending = saver.save(session, session.projects[0])

  // 用户在请求在途时继续输入：会话内容比正在写入的快照更新。
  session.projects[0] = { ...session.projects[0], taskDraft: 'A-newer' }

  await completeWithStore(store, bridge.calls[0])
  assert.equal((await pending).status, 'saved')

  const baselineProject = saver.getBaseline().projects.find((project) => project.id === 'a')
  assert.equal(baselineProject.taskDraft, 'A-new')
  assert.equal(isProjectDirty(session.projects[0], baselineProject), true, '新输入仍算未保存')
})

test('保存 A 不会顺带写入 B 的未保存草稿，也不丢弃它', async (t) => {
  const { filePath, store, bridge, saver } = await setup(t)
  const session = workspaceWith({ aDraft: 'A-new', bDraft: 'B-未保存' })

  const pending = saver.save(session, session.projects[0])
  assert.deepEqual(
    bridge.calls[0].payload.projects.map((project) => [project.id, project.taskDraft]),
    [
      ['a', 'A-new'],
      ['b', 'B-old'],
    ],
    'B 在 payload 中仍是上次成功保存的版本',
  )

  await completeWithStore(store, bridge.calls[0])
  assert.equal((await pending).status, 'saved')
  assert.deepEqual(await readDrafts(filePath), { a: 'A-new', b: 'B-old' })
  assert.equal(session.projects[1].taskDraft, 'B-未保存', '会话里的 B 草稿仍在')
})
