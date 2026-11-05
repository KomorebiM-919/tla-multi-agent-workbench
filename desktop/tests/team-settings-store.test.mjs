import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createWorkspaceStore } from '../electron/workspace-store.mjs'
import { createTeamSettingsStore, resolveTeamSettingsFilePath } from '../electron/team-settings-store.mjs'
import { TEAM_MAX_FILE_BYTES, validateTeamDocument, mergeTeamRoles, roleToDraft, draftToRoleSetting } from '../src/lib/team-settings.js'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'
import { ROLES } from '../src/data/team.js'

const setting = (roleId = 'deepseek-dev', name = '开发者') => draftToRoleSetting({ ...roleToDraft(ROLES.find((role) => role.id === roleId)), name })
async function setup(t, saved = true) {
  const directory = await makeTempDir()
  const workspaceFile = path.join(directory, 'workspace.json')
  const recoveryFile = path.join(directory, 'recovery.json')
  const teamFile = path.join(directory, 'team-settings.json')
  const workspace = createWorkspaceStore({ filePath: workspaceFile })
  if (saved) await workspace.save({ schemaVersion: 1, activeProjectId: 'project-a', projects: ['project-a', 'project-b'].map((id) => ({ id, name: id, description: '', taskDraft: '正式正文不变' })) })
  await writeFile(recoveryFile, '{"fixture":"恢复稿原样保留"}\n')
  const originalWorkspace = saved ? await readFile(workspaceFile) : null
  const originalRecovery = await readFile(recoveryFile)
  t.after(async () => {
    try {
      if (saved) assert.deepEqual(await readFile(workspaceFile), originalWorkspace)
      else assert.equal(existsSync(workspaceFile), false)
      assert.deepEqual(await readFile(recoveryFile), originalRecovery)
    } finally { await removeTempDir(directory) }
  })
  return { directory, teamFile, store: createTeamSettingsStore({ filePath: teamFile, loadWorkspace: () => workspace.load() }) }
}

test('团队设置缺文件时返回默认且不创建任何正式设置', async (t) => {
  const { teamFile, store } = await setup(t)
  assert.deepEqual(await store.load('project-a'), { settings: [], source: 'default', savedAt: null })
  assert.equal(existsSync(teamFile), false)
  assert.equal(mergeTeamRoles().length, 6)
})

test('未正式保存或未知项目不能读取/写入角色设置', async (t) => {
  const { teamFile, store } = await setup(t, false)
  for (const action of [() => store.load('default-project'), () => store.saveRole('default-project', setting())]) {
    await assert.rejects(action, (error) => error.code === 'PROJECT_NOT_SAVED')
  }
  assert.equal(existsSync(teamFile), false)
})

test('中文多行角色与模型标签真实保存重读，模板不变且状态仍未连接', async (t) => {
  const { teamFile, store } = await setup(t)
  const before = JSON.stringify(ROLES)
  const value = { ...setting(), summary: '第一行\n第二行\t中文', duty: '只做获批范围', modelRef: { provider: '供应商示例', model: 'planned-model' } }
  await store.saveRole('project-a', value)
  const loaded = await store.load('project-a')
  assert.deepEqual(loaded.settings, [value])
  const visible = mergeTeamRoles(loaded.settings)
  assert.equal(visible.find((role) => role.id === value.roleId).model, '未连接')
  assert.equal(visible.find((role) => role.id === 'user').kind, 'human')
  assert.equal(JSON.stringify(ROLES), before)
  assert.equal(JSON.parse(await readFile(teamFile, 'utf8')).schemaVersion, 1)
})

test('并发保存A/B和不同角色只合并目标项，临时文件无残留', async (t) => {
  const { directory, store } = await setup(t)
  await Promise.all([
    store.saveRole('project-a', setting('deepseek-dev', 'A开发')),
    store.saveRole('project-a', setting('mimo-frontend', 'A界面')),
    store.saveRole('project-b', setting('deepseek-dev', 'B开发')),
  ])
  await store.saveRole('project-a', setting('deepseek-dev', 'A更新'))
  const a = (await store.load('project-a')).settings
  assert.equal(a.length, 2)
  assert.equal(a.find((role) => role.roleId === 'mimo-frontend').name, 'A界面')
  assert.equal(a.find((role) => role.roleId === 'deepseek-dev').name, 'A更新')
  assert.equal((await store.load('project-b')).settings[0].name, 'B开发')
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false)
})

test('排队的保存捕获输入快照，不受调用后修改影响', async (t) => {
  const { store } = await setup(t)
  const value = setting()
  const pending = store.saveRole('project-a', value)
  value.name = '调用之后才改的内容'
  await pending
  assert.equal((await store.load('project-a')).settings[0].name, '开发者')
})

test('非法角色、额外字段、超限和不完整模型标签拒绝且不覆盖旧文件', async (t) => {
  const { store, teamFile } = await setup(t)
  const valid = setting()
  await store.saveRole('project-a', valid)
  const before = await readFile(teamFile)
  const invalid = [
    { ...valid, roleId: 'user' }, { ...valid, roleId: 'unknown' },
    { ...valid, unexpected: true }, { ...valid, name: ' ' }, { ...valid, badge: '' },
    { ...valid, name: 'x'.repeat(61) }, { ...valid, duty: 'x'.repeat(2001) },
    { ...valid, summary: '\u0000' }, { ...valid, modelRef: { provider: 'only-one' } },
    { ...valid, modelRef: { provider: '', model: 'm' } },
    { ...valid, modelRef: { provider: 'p', model: 'm', unexpected: 'value' } },
  ]
  for (const value of invalid) {
    await assert.rejects(() => store.saveRole('project-a', value), (error) => error.code === 'INVALID_INPUT')
    assert.deepEqual(await readFile(teamFile), before)
  }
  await assert.rejects(() => store.saveRole('../outside', valid), (error) => error.code === 'INVALID_INPUT')
  await assert.rejects(() => store.saveRole('missing-project', valid), (error) => error.code === 'PROJECT_NOT_SAVED')
  assert.deepEqual(await readFile(teamFile), before)
})

test('坏JSON、未知版本与重复角色均保留原文件并阻止覆盖', async (t) => {
  const { store, teamFile } = await setup(t)
  const fixtures = [
    '{broken',
    JSON.stringify({ schemaVersion: 2, projects: [] }),
    JSON.stringify({ schemaVersion: 1, projects: [{ projectId: 'project-a', roles: [setting(), setting()] }] }),
  ]
  for (const raw of fixtures) {
    await writeFile(teamFile, raw)
    await assert.rejects(() => store.load('project-a'))
    await assert.rejects(() => store.saveRole('project-a', setting()))
    assert.equal(await readFile(teamFile, 'utf8'), raw)
  }
})

test('大于512KiB的团队文件不读取、不覆盖', async (t) => {
  const { store, teamFile } = await setup(t)
  const oversized = Buffer.alloc(TEAM_MAX_FILE_BYTES + 1, 32)
  await writeFile(teamFile, oversized)
  await assert.rejects(() => store.load('project-a'), (error) => error.code === 'TOO_LARGE')
  await assert.rejects(() => store.saveRole('project-a', setting()), (error) => error.code === 'TOO_LARGE')
  assert.deepEqual(await readFile(teamFile), oversized)
})

test('文档结构的白名单、重复项目与数量上限严格校验', () => {
  const project = { projectId: 'project-a', roles: [setting()] }
  for (const value of [
    { schemaVersion: 1, projects: [project, project] },
    { schemaVersion: 1, projects: [], unexpected: true },
    { schemaVersion: 1, projects: [{ ...project, unexpected: true }] },
    { schemaVersion: 1, projects: Array.from({ length: 21 }, (_, i) => ({ projectId: `p-${i}`, roles: [] })) },
  ]) assert.throws(() => validateTeamDocument(value))
})

test('团队文件位置固定，打包仅包含主进程需要的纯数据模块', async () => {
  const desktop = path.resolve('desktop-fixture')
  assert.equal(resolveTeamSettingsFilePath(desktop), path.resolve(desktop, '..', '.local/tla-desktop/team-settings.json'))
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(metadata.build.files.includes('src/data/team.js'))
  assert.ok(metadata.build.files.includes('src/lib/team-settings.js'))
  assert.equal(metadata.build.files.includes('src/**/*'), false)
})
