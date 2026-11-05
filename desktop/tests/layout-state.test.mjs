import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DYNAMICS_STATES,
  isRoleDetailVisible,
  nextDynamicsMode,
  nextDynamicsOnToggle,
} from '../src/lib/layout-state.js'

test('角色详情只属于团队页，并在 docked 动态占用辅助列时隐藏', () => {
  assert.equal(isRoleDetailVisible({ page: 'chat', roleId: 'user', dynamics: 'hidden' }), false)
  assert.equal(isRoleDetailVisible({ page: 'workflow', roleId: 'user', dynamics: 'hidden' }), false)
  assert.equal(isRoleDetailVisible({ page: 'team', roleId: null, dynamics: 'hidden' }), false)
  assert.equal(isRoleDetailVisible({ page: 'team', roleId: 'user', dynamics: 'hidden' }), true)
  assert.equal(isRoleDetailVisible({ page: 'team', roleId: 'user', dynamics: 'floating' }), true)
  assert.equal(isRoleDetailVisible({ page: 'team', roleId: 'user', dynamics: 'docked' }), false)
})

test('切页不改变已选角色，但对话/流程页不再占用详情列', () => {
  const roleId = 'codex-supervisor'
  assert.equal(isRoleDetailVisible({ page: 'team', roleId, dynamics: 'hidden' }), true)
  assert.equal(isRoleDetailVisible({ page: 'chat', roleId, dynamics: 'hidden' }), false)
  assert.equal(isRoleDetailVisible({ page: 'workflow', roleId, dynamics: 'hidden' }), false)
  assert.equal(roleId, 'codex-supervisor')
})

test('打开动态只有在角色编辑器允许离开时才生效，脏表单不会被悄悄隐藏', () => {
  assert.equal(nextDynamicsOnToggle('hidden', true), 'docked')
  assert.equal(nextDynamicsOnToggle('hidden', false), 'hidden')
})

test('动态已展开时，点击始终只收起，不再触发离开检查', () => {
  assert.equal(nextDynamicsOnToggle('docked', true), 'hidden')
  assert.equal(nextDynamicsOnToggle('docked', false), 'hidden')
  assert.equal(nextDynamicsOnToggle('floating', false), 'hidden')
})

test('侧栏与浮窗双向切换，且不会进入第三种状态', () => {
  assert.deepEqual(DYNAMICS_STATES, ['hidden', 'docked', 'floating'])
  assert.equal(nextDynamicsMode('docked'), 'floating')
  assert.equal(nextDynamicsMode('floating'), 'docked')
})
