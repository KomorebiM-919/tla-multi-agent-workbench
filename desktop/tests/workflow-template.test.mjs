import test from 'node:test'
import assert from 'node:assert/strict'
import { WORKFLOW_STAGES, WORKFLOW_TEMPLATE_STATE } from '../src/data/workflow-template.js'

const EXPECTED_IDS = ['preflight', 'requirement', 'coding', 'verify', 'review']
const EXPECTED_ROLES = ['Verifier', 'Requirement Agent', 'Coding Agent', 'Verifier', 'Review Agent']

test('阶段顺序固定为预检 → 需求 → 编码 → 验证 → 审核', () => {
  assert.deepEqual(WORKFLOW_STAGES.map((stage) => stage.id), EXPECTED_IDS)
  assert.deepEqual(WORKFLOW_STAGES.map((stage) => stage.order), [1, 2, 3, 4, 5])
  assert.deepEqual(WORKFLOW_STAGES.map((stage) => stage.role), EXPECTED_ROLES)
})

test('每个阶段都有可查看的职责与输入输出说明', () => {
  for (const stage of WORKFLOW_STAGES) {
    assert.deepEqual(
      Object.keys(stage).sort(),
      ['duty', 'id', 'inputs', 'order', 'outputs', 'role', 'title'],
      `${stage.id} 不应携带状态、耗时、费用或进度字段`,
    )
    for (const field of ['title', 'role', 'duty', 'inputs', 'outputs']) {
      assert.equal(typeof stage[field], 'string', `${stage.id}.${field} 应为字符串`)
      assert.ok(stage[field].trim().length > 0, `${stage.id}.${field} 不能为空`)
    }
  }
})

test('模板明确标记未运行，且不硬绑定任何品牌模型', () => {
  assert.equal(WORKFLOW_TEMPLATE_STATE.status, '未运行')
  assert.match(WORKFLOW_TEMPLATE_STATE.title, /工作流阶段顺序模板/)
  assert.match(WORKFLOW_TEMPLATE_STATE.note, /参考/)
  const text = WORKFLOW_STAGES.map((stage) => [
    stage.title,
    stage.role,
    stage.duty,
    stage.inputs,
    stage.outputs,
  ].join(' ')).join(' ').toLowerCase()
  for (const brand of ['deepseek', 'kimi', 'glm', 'mimo', 'codex']) {
    assert.equal(text.includes(brand), false, `阶段模板不应绑定品牌：${brand}`)
  }
})

test('阶段 id 与顺序唯一', () => {
  const ids = WORKFLOW_STAGES.map((stage) => stage.id)
  assert.equal(new Set(ids).size, ids.length)
  const orders = WORKFLOW_STAGES.map((stage) => stage.order)
  assert.equal(new Set(orders).size, orders.length)
})
