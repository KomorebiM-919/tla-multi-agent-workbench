import test from 'node:test'
import assert from 'node:assert/strict'
import { ROLES } from '../src/data/team.js'
import {
  buildOrgChart,
  ORG_MEMBER_IDS,
  ORG_ROOT_ID,
  ORG_SUPERVISOR_ID,
  ORG_TEMPLATE_NOTE,
} from '../src/lib/org-chart.js'

function roleClone(overrides = {}) {
  return ROLES.map((role) => ({ ...role, ...(overrides[role.id] ?? {}) }))
}

test('组织关系图使用固定层级：用户总控制 → 主管位 → 其它四个 AI 角色位', () => {
  const chart = buildOrgChart(ROLES)
  assert.equal(chart.root.id, ORG_ROOT_ID)
  assert.equal(chart.root.kind, 'human')
  assert.equal(chart.supervisor.id, ORG_SUPERVISOR_ID)
  assert.equal(chart.supervisor.kind, 'agent')
  assert.deepEqual(chart.members.map((role) => role.id), [...ORG_MEMBER_IDS])
  assert.equal(chart.members.length, 4)
  for (const member of chart.members) assert.equal(member.kind, 'agent')
})

test('六个角色位全部出现且没有孤立或丢失节点', () => {
  const chart = buildOrgChart(ROLES)
  const renderedIds = [
    chart.root.id,
    chart.supervisor.id,
    ...chart.members.map((role) => role.id),
  ]
  assert.equal(renderedIds.length, ROLES.length)
  assert.equal(new Set(renderedIds).size, ROLES.length)
  assert.deepEqual(new Set(renderedIds), new Set(ROLES.map((role) => role.id)))
})

test('每条关系都指向已渲染的角色位', () => {
  const chart = buildOrgChart(ROLES)
  const renderedIds = new Set([
    chart.root.id,
    chart.supervisor.id,
    ...chart.members.map((role) => role.id),
  ])
  assert.equal(chart.edges.length, 5)
  for (const edge of chart.edges) {
    assert.ok(renderedIds.has(edge.from), `未知起点：${edge.from}`)
    assert.ok(renderedIds.has(edge.to), `未知终点：${edge.to}`)
  }
  assert.deepEqual(
    chart.edges.filter((edge) => edge.from === ORG_SUPERVISOR_ID).map((edge) => edge.to),
    [...ORG_MEMBER_IDS],
  )
})

test('名称与职责来自同一份角色数据，重命名后图形同步', () => {
  const renamed = roleClone({
    [ORG_SUPERVISOR_ID]: { name: '项目主管（自定义）', badge: '编排（自定义）' },
    [ORG_MEMBER_IDS[0]]: { name: '需求位（自定义）' },
  })
  const chart = buildOrgChart(renamed)
  assert.equal(chart.supervisor.name, '项目主管（自定义）')
  assert.equal(chart.supervisor.badge, '编排（自定义）')
  assert.equal(chart.members[0].name, '需求位（自定义）')
  assert.equal(chart.supervisor.model, '未连接')
})

test('缺少角色或 ID 重复时明确报错，不悄悄丢节点', () => {
  assert.throws(
    () => buildOrgChart(ROLES.filter((role) => role.id !== ORG_SUPERVISOR_ID)),
    /缺少角色：codex-supervisor/,
  )
  assert.throws(() => buildOrgChart([...ROLES, { ...ROLES[1], name: '重复主管' }]), /角色 ID 重复/)
  assert.throws(() => buildOrgChart([...ROLES, { ...ROLES[2], id: 'extra-agent' }]), /未知角色/)
  assert.throws(() => buildOrgChart(null), /必须是数组/)
})

test('模板说明明确只读、非真实调度', () => {
  assert.match(ORG_TEMPLATE_NOTE.label, /模板/)
  assert.match(ORG_TEMPLATE_NOTE.detail, /只读/)
  assert.match(ORG_TEMPLATE_NOTE.detail, /非真实调度/)
  assert.match(ORG_TEMPLATE_NOTE.explanation, /不代表权限、依赖或真实调用/)
})
