// 恢复稿与正式文件的联动：真实 store + 真实孤立目录，验证“只装入会话、不覆盖正式文件”。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createRecoveryStore } from '../electron/recovery-store.mjs'
import { createWorkspaceStore } from '../electron/workspace-store.mjs'
import { cloneSession, mergeRecoveryEntry } from '../src/lib/workspace-editing.js'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

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
