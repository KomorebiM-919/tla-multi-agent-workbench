// 恢复稿与正式文件的联动：真实 store + 真实孤立目录，验证“只装入会话、不覆盖正式文件”。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createRecoveryStore } from '../electron/recovery-store.mjs'
import { createWorkspaceStore } from '../electron/workspace-store.mjs'
import { createRecoveryDrafts } from '../src/lib/recovery-drafts.js'
import { cloneSession, mergeRecoveryEntry } from '../src/lib/workspace-editing.js'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

const settle = () => new Promise((resolve) => setImmediate(resolve))

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

async function setup(t) {
  const directory = await makeTempDir()
  t.after(() => removeTempDir(directory))
  const workspacePath = path.join(directory, 'workspace.json')
  const recoveryPath = path.join(directory, 'recovery.json')
  return {
    workspacePath,
    recoveryPath,
    workspaceStore: createWorkspaceStore({ filePath: workspacePath }),
    recoveryStore: createRecoveryStore({ filePath: recoveryPath }),
  }
}

test('新建但未正式保存的项目：重开后能从恢复稿完整装入会话，且不创建正式文件', async (t) => {
  const { workspacePath, recoveryStore, workspaceStore } = await setup(t)

  await recoveryStore.save({
    id: 'draft-project',
    name: '还没保存的新项目',
    description: '简介也能恢复',
    taskDraft: '第一行\n第二行 中文',
    revision: 1,
  })

  const { workspace } = await workspaceStore.load()
  assert.equal(existsSync(workspacePath), false, '读取正式数据不应创建文件')

  const { entries } = await recoveryStore.load()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'draft-project')

  const restored = mergeRecoveryEntry(cloneSession(workspace), entries[0])
  assert.equal(restored.activeProjectId, 'draft-project')
  assert.deepEqual(
    restored.projects.map((project) => project.id),
    ['default-project', 'draft-project'],
  )
  const restoredProject = restored.projects[1]
  assert.equal(restoredProject.taskDraft, '第一行\n第二行 中文')
  assert.equal(existsSync(workspacePath), false, '恢复只进入会话，不自动写正式文件')
})

test('已有项目的恢复稿不会自动改写正式文件内容', async (t) => {
  const { workspacePath, workspaceStore, recoveryStore } = await setup(t)
  const base = await workspaceStore.load()
  const saved = await workspaceStore.save({
    schemaVersion: 1,
    activeProjectId: 'default-project',
    projects: [{ ...base.workspace.projects[0], taskDraft: '正式文件里的草稿' }],
  })

  await recoveryStore.save({
    id: 'default-project',
    name: saved.workspace.projects[0].name,
    description: '',
    taskDraft: '恢复稿里的新草稿',
    revision: 1,
  })

  const { entries } = await recoveryStore.load()
  const restored = mergeRecoveryEntry(cloneSession(saved.workspace), entries[0])
  assert.equal(restored.projects[0].taskDraft, '恢复稿里的新草稿')

  const onDisk = JSON.parse(readFileSync(workspacePath, 'utf8'))
  assert.equal(onDisk.projects[0].taskDraft, '正式文件里的草稿', '正式文件保持原样')
})

test('放弃后再编辑：更高 revision 能重新备份，旧版本仍被墓碑拒绝', async (t) => {
  const { recoveryStore } = await setup(t)
  const base = { id: 'project-a', name: 'A', description: '', taskDraft: '第一版' }

  await recoveryStore.save({ ...base, revision: 1 })
  const discarded = await recoveryStore.discard({ projectId: 'project-a', revision: 2 })
  assert.equal(discarded.removed, true)

  await assert.rejects(
    () => recoveryStore.save({ ...base, taskDraft: '迟到旧稿', revision: 2 }),
    (error) => error.code === 'DISCARDED',
  )

  await recoveryStore.save({ ...base, taskDraft: '重新编辑', revision: 3 })
  const { entries } = await recoveryStore.load()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].taskDraft, '重新编辑')
  assert.equal(entries[0].revision, 3)
})

test('清理未返回时编辑并立即关闭：flush 必须等清理结束，且最新稿仍可恢复', async (t) => {
  const { recoveryStore } = await setup(t)
  const base = { id: 'project-a', name: '项目 A', description: '', taskDraft: 'v1 已备份' }
  await recoveryStore.save({ ...base, revision: 1 })

  const timers = fakeTimers()
  const discardCalls = []
  let releaseDiscard = null
  const draft = createRecoveryDrafts({
    save: async (snapshot) => {
      const { entry } = await recoveryStore.save(snapshot)
      return { ok: true, entry }
    },
    // 清理请求先挂起，模拟“discard 还没返回”的窗口。
    discard: ({ projectId, revision }) => {
      discardCalls.push({ projectId, revision })
      return new Promise((resolve) => {
        releaseDiscard = async () => resolve({ ok: true, ...(await recoveryStore.discard({ projectId, revision })) })
      })
    },
    timers,
    debounceMs: 400,
  })
  t.after(() => draft.dispose())

  draft.reset((await recoveryStore.load()).entries)
  const clearing = draft.clearCovered('project-a', { ...base })
  await settle()
  assert.equal(discardCalls.length, 1, '清理应先发出一次删除请求')
  assert.equal(discardCalls[0].revision, 2)

  // 清理还没有返回时用户输入 v2，并立即关闭窗口。
  draft.noteEdit({ ...base, taskDraft: 'v2 清理期间的新稿' })
  let flushSettled = false
  const flushing = draft.flush().then((result) => {
    flushSettled = true
    return result
  })

  await settle()
  await settle()
  const returnedBeforeClear = flushSettled
  assert.ok(releaseDiscard, '清理请求应处于挂起状态')
  await releaseDiscard()

  const result = await flushing
  await clearing.catch(() => {})

  const { entries } = await recoveryStore.load()
  assert.equal(returnedBeforeClear, false, 'flush 不能早于清理结束就报告成功')
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(entries.length, 1, 'flush 成功后最新恢复稿必须还在')
  assert.equal(entries[0].taskDraft, 'v2 清理期间的新稿')
  assert.ok(entries[0].revision > 2, '重新写入必须高于墓碑水位')
})
