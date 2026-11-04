import test from 'node:test'
import assert from 'node:assert/strict'
import { ROLES, TEAM_TEMPLATE_STATE } from '../src/data/team.js'

const EXPECTED_NAMES = [
  '用户总控制',
  'Codex 主管',
  'Kimi 需求理解',
  'DeepSeek 开发',
  'GLM 辅助',
  'MiMo 前端',
]

// 首批团队模板的固定清单：谁被加进来或删掉都必须显式改测试。
test('团队模板包含批准的首批六个角色，顺序固定', () => {
  assert.deepEqual(
    ROLES.map((role) => role.name),
    EXPECTED_NAMES,
  )
  assert.equal(TEAM_TEMPLATE_STATE.label, '初始团队模板')
  assert.equal(TEAM_TEMPLATE_STATE.detail, '尚未连接模型')
})

test('角色 id 唯一且非空', () => {
  const ids = ROLES.map((role) => role.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z-]+$/)
  }
})

test('每个角色的职责字段都非空', () => {
  for (const role of ROLES) {
    for (const field of ['badge', 'summary', 'duty', 'inputs', 'outputs', 'boundary', 'model']) {
      assert.equal(typeof role[field], 'string', `${role.id}.${field} 应为字符串`)
      assert.ok(role[field].trim().length > 0, `${role.id}.${field} 不能为空`)
    }
  }
})

test('用户总控制是人类角色，其余角色都是未连接模型的模板角色', () => {
  const [user, ...agents] = ROLES
  assert.equal(user.kind, 'human')
  assert.match(user.model, /不适用/)
  for (const agent of agents) {
    assert.equal(agent.kind, 'agent')
    assert.equal(agent.model, '未连接', `${agent.id} 必须标记为未连接`)
  }
})

test('角色数据不携带伪造的回复、余额或运行状态字段', () => {
  const forbidden = [
    'balance',
    'credit',
    'quota',
    'reply',
    'replies',
    'messages',
    'online',
    'running',
    'status',
    'tokenUsage',
  ]
  for (const role of ROLES) {
    for (const key of forbidden) {
      assert.equal(key in role, false, `${role.id} 不应包含字段 ${key}`)
    }
  }
})
