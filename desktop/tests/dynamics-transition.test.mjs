import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createTeamSettingsController } from '../src/lib/team-settings-controller.js'
import { requestDynamicsChange } from '../src/lib/dynamics-transition.js'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const setup = async ({ save } = {}) => {
  const controller = createTeamSettingsController({
    load: async () => ({ ok: true, settings: [] }),
    save: save ?? (async (_id, setting) => ({ ok: true, setting, savedAt: '2026-11-05T04:00:00.000Z' })),
  })
  await controller.selectProject('project-a', true)
  return controller
}

const makeDirty = (controller, duty = '尚未保存的职责') => {
  assert.equal(controller.edit('deepseek-dev'), true)
  controller.update('duty', duty)
}

test('未保存角色时从隐藏展开 docked 仍被拦下', async () => {
  const team = await setup()
  makeDirty(team)
  const result = requestDynamicsChange({ current: 'hidden', intent: 'toggle', teamController: team })
  assert.equal(result.blocked, true)
  assert.equal(result.dynamics, 'hidden')
  assert.equal(team.getState().editor.draft.duty, '尚未保存的职责')
  assert.match(team.getState().notice ?? '', /保存|取消/)
})

test('未保存角色时浮窗收进侧栏被拦下，浮窗与表单保持可见', async () => {
  const team = await setup()
  makeDirty(team)
  const result = requestDynamicsChange({ current: 'floating', intent: 'mode', teamController: team })
  assert.equal(result.blocked, true)
  assert.equal(result.dynamics, 'floating')
  assert.ok(team.getState().editor)
  assert.match(team.getState().notice ?? '', /保存|取消/)
})

test('保存仍在途时浮窗收进侧栏被拦下', async () => {
  const gate = deferred()
  const team = await setup({ save: async () => gate.promise })
  makeDirty(team)
  const saving = team.save()
  assert.equal(team.getState().editor.busy, true)
  const result = requestDynamicsChange({ current: 'floating', intent: 'mode', teamController: team })
  assert.equal(result.blocked, true)
  assert.equal(result.dynamics, 'floating')
  assert.equal(team.getState().editor.busy, true)
  gate.resolve({ ok: true, setting: team.getState().editor.draft, savedAt: '2026-11-05T04:00:00.000Z' })
  await saving
})

test('保存完成或取消编辑后，浮窗收进侧栏正常放行', async () => {
  const team = await setup()
  makeDirty(team)
  assert.equal((await team.save()).status, 'saved')
  const afterSave = requestDynamicsChange({ current: 'floating', intent: 'mode', teamController: team })
  assert.equal(afterSave.blocked, false)
  assert.equal(afterSave.dynamics, 'docked')

  makeDirty(team, '取消前再次修改')
  const blocked = requestDynamicsChange({ current: 'floating', intent: 'mode', teamController: team })
  assert.equal(blocked.blocked, true)
  team.cancel()
  const afterCancel = requestDynamicsChange({ current: 'floating', intent: 'mode', teamController: team })
  assert.equal(afterCancel.blocked, false)
  assert.equal(afterCancel.dynamics, 'docked')
})

test('没有阻塞时双向转换与收起都正常', async () => {
  const team = await setup()
  assert.deepEqual(
    requestDynamicsChange({ current: 'docked', intent: 'mode', teamController: team }),
    { dynamics: 'floating', blocked: false },
  )
  assert.deepEqual(
    requestDynamicsChange({ current: 'floating', intent: 'mode', teamController: team }),
    { dynamics: 'docked', blocked: false },
  )
  assert.deepEqual(
    requestDynamicsChange({ current: 'docked', intent: 'toggle', teamController: team }),
    { dynamics: 'hidden', blocked: false },
  )
  assert.deepEqual(
    requestDynamicsChange({ current: 'hidden', intent: 'toggle', teamController: team }),
    { dynamics: 'docked', blocked: false },
  )
})

test('App 的两个动态入口共用同一个转换函数', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(source, /requestDynamicsChange\(\{/)
  assert.match(source, /const toggleDynamics = useCallback\(\(\) => changeDynamics\('toggle'\)/)
  assert.match(source, /const toggleDynamicsMode = useCallback\(\(\) => changeDynamics\('mode'\)/)
  assert.doesNotMatch(source, /nextDynamicsMode|nextDynamicsOnToggle/)
})
