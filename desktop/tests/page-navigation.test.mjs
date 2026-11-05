import test from 'node:test'
import assert from 'node:assert/strict'
import { attemptPageChange } from '../src/lib/page-navigation.js'
import { createTeamSettingsController } from '../src/lib/team-settings-controller.js'

const PAGES = ['chat', 'team', 'workflow']

function makeController() {
  return createTeamSettingsController({
    load: async () => ({ ok: true, settings: [], savedAt: null }),
    save: async () => ({ ok: true, setting: null }),
  })
}

async function dirtyController() {
  const controller = makeController()
  await controller.selectProject('project-a', true)
  assert.equal(controller.edit('deepseek-dev'), true)
  controller.update('name', '改过但没保存')
  return controller
}

async function savingController() {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const controller = createTeamSettingsController({
    load: async () => ({ ok: true, settings: [], savedAt: null }),
    save: async () => {
      await gate
      return { ok: false, error: { code: 'SAVE_FAILED', message: '测试失败' } }
    },
  })
  await controller.selectProject('project-a', true)
  assert.equal(controller.edit('deepseek-dev'), true)
  controller.update('duty', '正在保存时的职责')
  const pending = controller.save()
  return { controller, pending, release }
}

test('同一页点击不触发离开保护', async () => {
  const controller = await dirtyController()
  const before = controller.getState().noticeSeq
  for (const page of PAGES) {
    const result = attemptPageChange({ currentPage: page, nextPage: page, teamController: controller })
    assert.deepEqual(result, { changed: false, blocked: false })
  }
  assert.equal(controller.getState().noticeSeq, before)
})

test('脏角色编辑阻止所有页面切换，包括离开对话页与流程页', async () => {
  const controller = await dirtyController()
  let seq = controller.getState().noticeSeq
  for (const from of PAGES) {
    for (const to of PAGES) {
      if (from === to) continue
      const result = attemptPageChange({ currentPage: from, nextPage: to, teamController: controller })
      assert.deepEqual(result, { changed: false, blocked: true }, `${from} → ${to} 必须被拦下`)
      seq += 1
      assert.equal(controller.getState().noticeSeq, seq)
      assert.match(controller.getState().notice, /角色设置尚未保存/)
    }
  }
})

test('保存中的角色设置阻止所有页面切换', async () => {
  const { controller, pending, release } = await savingController()
  for (const from of PAGES) {
    for (const to of PAGES) {
      if (from === to) continue
      const result = attemptPageChange({ currentPage: from, nextPage: to, teamController: controller })
      assert.deepEqual(result, { changed: false, blocked: true }, `${from} → ${to} 必须被保存中保护拦下`)
      assert.match(controller.getState().notice, /正在保存/)
    }
  }
  release()
  await pending
})

test('没有脏编辑或保存中状态时允许任意页面切换', async () => {
  const controller = makeController()
  await controller.selectProject('project-a', true)
  for (const from of PAGES) {
    for (const to of PAGES) {
      if (from === to) continue
      const result = attemptPageChange({ currentPage: from, nextPage: to, teamController: controller })
      assert.deepEqual(result, { changed: true, blocked: false }, `${from} → ${to} 应允许切换`)
    }
  }
})

test('对话页到流程页的旧缺口被覆盖', async () => {
  const controller = await dirtyController()
  const result = attemptPageChange({ currentPage: 'chat', nextPage: 'workflow', teamController: controller })
  assert.deepEqual(result, { changed: false, blocked: true })
  assert.ok(controller.getState().editor, '编辑器与表单必须保留')
})
