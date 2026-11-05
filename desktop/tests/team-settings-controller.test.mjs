import test from 'node:test'
import assert from 'node:assert/strict'
import { createTeamSettingsController, abortRoleCloseIfNeeded } from '../src/lib/team-settings-controller.js'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const result = (setting) => ({ ok: true, setting, savedAt: '2026-11-05T04:00:00.000Z' })
const setup = (options = {}) => createTeamSettingsController({ load: async () => ({ ok: true, settings: [] }), save: async (_id, setting) => result(setting), ...options })

test('未保存项目不请求设置，人类总控制不可编辑', async () => {
  let calls = 0
  const team = setup({ load: async () => { calls++; return { ok: true, settings: [] } } })
  await team.selectProject('draft-project', false)
  assert.equal(calls, 0)
  assert.equal(team.edit('deepseek-dev'), false)
  await team.selectProject('project-a', true)
  assert.equal(team.edit('user'), false)
})

test('A迟到读取不会覆盖当前B或其错误状态', async () => {
  const a = deferred(), b = deferred()
  const team = setup({ load: (id) => id === 'project-a' ? a.promise : b.promise })
  const pendingA = team.selectProject('project-a', true)
  const pendingB = team.selectProject('project-b', true)
  b.resolve({ ok: false, error: { code: 'CORRUPT_FILE', message: 'B不可读' } })
  await pendingB
  a.resolve({ ok: true, settings: [] })
  assert.equal((await pendingA).status, 'stale')
  assert.equal(team.getState().projectId, 'project-b')
  assert.equal(team.getState().status, 'error')
  assert.equal(team.edit('deepseek-dev'), false)
})

test('保存仅更新目标角色，模型标签保留且永远不是连接状态', async () => {
  const team = setup()
  await team.selectProject('project-a', true)
  const originalMimo = structuredClone(team.getState().roles.find((role) => role.id === 'mimo-frontend'))
  team.edit('deepseek-dev')
  team.update('name', '项目A开发')
  team.update('provider', '示例供应商')
  team.update('model', 'planned-model')
  assert.equal((await team.save()).status, 'saved')
  const saved = team.getState().roles.find((role) => role.id === 'deepseek-dev')
  assert.equal(saved.name, '项目A开发')
  assert.deepEqual(saved.modelRef, { provider: '示例供应商', model: 'planned-model' })
  assert.equal(saved.model, '未连接')
  assert.deepEqual(team.getState().roles.find((role) => role.id === 'mimo-frontend'), originalMimo)
})

test('只有一个模型标签时不提交，错误保留表单；清空两个可保存null', async () => {
  let calls = 0
  const team = setup({ save: async (_id, setting) => { calls++; return result(setting) } })
  await team.selectProject('project-a', true)
  team.edit('deepseek-dev')
  team.update('provider', '供应商')
  assert.equal((await team.save()).status, 'invalid')
  assert.equal(calls, 0)
  assert.equal(team.getState().editor.draft.provider, '供应商')
  team.update('provider', '')
  assert.equal((await team.save()).status, 'saved')
  assert.equal(team.getState().roles.find((role) => role.id === 'deepseek-dev').modelRef, null)
})

test('角色脏编辑阻止切换，取消后才能离开且不会自动保存', async () => {
  const team = setup()
  await team.selectProject('project-a', true)
  team.edit('deepseek-dev')
  team.update('duty', '尚未保存')
  assert.equal(team.mayLeave(), false)
  assert.equal((await team.selectProject('project-b', true)).status, 'blocked')
  assert.equal(team.edit('mimo-frontend'), false)
  assert.equal(team.getState().editor.draft.duty, '尚未保存')
  team.cancel()
  assert.equal((await team.selectProject('project-b', true)).status, 'ready')
})

test('双击保存只提交一次，保存中禁止取消/编辑/切换，关闭立即中止', async () => {
  const gate = deferred()
  let calls = 0, captured
  const team = setup({ save: async (_id, setting) => { calls++; captured = setting; return gate.promise } })
  await team.selectProject('project-a', true)
  team.edit('deepseek-dev')
  team.update('name', '已捕获的名称')
  const saving = team.save()
  assert.equal((await team.save()).status, 'busy')
  assert.equal(calls, 1)
  team.update('name', '不应进入保存快照')
  assert.equal(team.cancel(), false)
  assert.equal((await team.selectProject('project-b', true)).status, 'blocked')
  const confirmations = [], issues = []
  const blocked = await abortRoleCloseIfNeeded({ controller: team, requestId: 7, confirmClose: async (value) => confirmations.push(value), onBlocked: (issue) => issues.push(issue) })
  assert.equal(blocked, true, '不能等待尚未返回的保存才中止关闭')
  assert.equal(confirmations[0].requestId, 7)
  assert.equal(confirmations[0].ok, false)
  assert.equal(issues[0].code, 'ROLE_SAVE_PENDING')
  assert.equal(team.getState().editor.draft.name, '已捕获的名称')
  gate.resolve(result(captured))
  assert.equal((await saving).status, 'saved')
  assert.equal(team.closeBlocker(), null)
})

test('角色保存失败保留表单并释放在途保护，可重试', async () => {
  let fail = true
  const team = setup({ save: async (_id, setting) => fail ? { ok: false, error: { code: 'WRITE_FAILED', message: '测试失败' } } : result(setting) })
  await team.selectProject('project-a', true)
  team.edit('deepseek-dev')
  team.update('summary', '保留的正文')
  assert.equal((await team.save()).status, 'failed')
  assert.equal(team.getState().editor.draft.summary, '保留的正文')
  assert.equal(team.getState().editor.busy, false)
  assert.equal(team.closeBlocker().code, 'ROLE_UNSAVED')
  fail = false
  assert.equal((await team.save()).status, 'saved')
})

test('保存响应返回其他角色时拒绝应用，保留表单并可重试', async () => {
  let responseRole = 'mimo-frontend'
  const team = setup({ save: async (_id, setting) => result(responseRole === setting.roleId ? setting : { ...setting, roleId: responseRole }) })
  await team.selectProject('project-a', true)
  const before = structuredClone(team.getState().roles)
  team.edit('deepseek-dev')
  team.update('name', '项目A开发')
  assert.equal((await team.save()).status, 'failed')
  assert.equal(team.getState().editor.busy, false)
  assert.equal(team.getState().editor.draft.name, '项目A开发')
  assert.match(team.getState().editor.error.message, /不一致/)
  assert.deepEqual(team.getState().roles, before, '异常响应不能改动任何角色')
  assert.equal(team.closeBlocker().code, 'ROLE_UNSAVED', '在途保护必须释放')
  responseRole = 'deepseek-dev'
  assert.equal((await team.save()).status, 'saved')
  assert.equal(team.getState().roles.find((role) => role.id === 'deepseek-dev').name, '项目A开发')
})

test('保存响应结构非法时拒绝应用，状态不被污染且可重试', async () => {
  let malformed = true
  const team = setup({
    save: async (_id, setting) => malformed
      ? { ok: true, setting: { ...setting, extra: '不应存在' }, savedAt: '2026-11-05T04:00:00.000Z' }
      : result(setting),
  })
  await team.selectProject('project-a', true)
  const before = structuredClone(team.getState().roles)
  team.edit('mimo-frontend')
  team.update('badge', '前端接口')
  assert.equal((await team.save()).status, 'failed')
  assert.equal(team.getState().editor.busy, false)
  assert.equal(team.getState().editor.draft.badge, '前端接口')
  assert.match(team.getState().editor.error.message, /不完整/)
  assert.deepEqual(team.getState().roles, before, '非法载荷不能改动任何角色')
  assert.equal(team.closeBlocker().code, 'ROLE_UNSAVED')
  malformed = false
  assert.equal((await team.save()).status, 'saved')
  assert.equal(team.getState().roles.find((role) => role.id === 'mimo-frontend').badge, '前端接口')
})

test('脏角色关闭提示明确中止，取消编辑后原关闭流程可继续', async () => {
  const team = setup()
  await team.selectProject('project-a', true)
  team.edit('deepseek-dev')
  team.update('summary', '未保存的角色')
  const confirmations = []
  let issue
  const options = { controller: team, requestId: 11, confirmClose: async (value) => confirmations.push(value), onBlocked: (value) => { issue = value } }
  assert.equal(await abortRoleCloseIfNeeded(options), true)
  assert.equal(issue.code, 'ROLE_UNSAVED')
  assert.match(issue.message, /角色设置/)
  assert.equal(team.getState().editor.draft.summary, '未保存的角色')
  team.cancel()
  assert.equal(await abortRoleCloseIfNeeded(options), false)
  assert.equal(confirmations.length, 1, '不阻拦时由原项目草稿关闭流程处理')
})

test('每次真正被拦截才推进 noticeSeq，打字与解除不重启动画', async () => {
  const team = setup()
  await team.selectProject('project-a', true)
  team.edit('deepseek-dev')
  team.update('summary', '有未保存内容')
  const startSeq = team.getState().noticeSeq
  assert.equal(team.mayLeave(), false)
  const firstBlock = team.getState().noticeSeq
  assert.equal(firstBlock, startSeq + 1)
  team.update('summary', '继续打字')
  assert.equal(team.getState().noticeSeq, firstBlock, '打字只清空提示，不重新触发脉冲')
  assert.equal(team.mayLeave(), false)
  assert.equal(team.getState().noticeSeq, firstBlock + 1, '再次被拦截时允许重新提醒')
  team.cancel()
  assert.equal(team.mayLeave(), true)
  assert.equal(team.getState().noticeSeq, firstBlock + 1, '解除拦截不改动序号')
})
