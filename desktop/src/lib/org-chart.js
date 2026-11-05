// 只读组织关系模板：固定“用户总控制 → 主管位 → 其它四个 AI 角色位”。
// 关系只按稳定 roleId 引用，不按名称或品牌推断；本模块不产生任何调度或权限语义。

export const ORG_ROOT_ID = 'user'
export const ORG_SUPERVISOR_ID = 'codex-supervisor'
export const ORG_MEMBER_IDS = Object.freeze([
  'kimi-requirements',
  'deepseek-dev',
  'glm-assist',
  'mimo-frontend',
])

export const ORG_TEMPLATE_NOTE = Object.freeze({
  label: '初始组织关系模板',
  detail: '只读 · 非真实调度',
  explanation: '箭头只表示职责汇报关系，不代表权限、依赖或真实调用。',
})

const REQUIRED_IDS = Object.freeze([ORG_ROOT_ID, ORG_SUPERVISOR_ID, ...ORG_MEMBER_IDS])

function requireRole(byId, id) {
  const role = byId.get(id)
  if (!role) throw new Error(`组织关系模板缺少角色：${id}`)
  return role
}

/**
 * 把当前项目的角色数据映射成固定层级；同一份数据同时供角色卡与详情使用。
 * 数据不完整时抛错，由调用方显示错误而不是悄悄丢节点。
 */
export function buildOrgChart(roles) {
  if (!Array.isArray(roles)) throw new Error('角色数据必须是数组')
  const byId = new Map()
  for (const role of roles) {
    if (!role || typeof role.id !== 'string' || role.id.length === 0) {
      throw new Error('角色数据包含无效条目')
    }
    if (byId.has(role.id)) throw new Error(`角色 ID 重复：${role.id}`)
    byId.set(role.id, role)
  }

  const root = requireRole(byId, ORG_ROOT_ID)
  const supervisor = requireRole(byId, ORG_SUPERVISOR_ID)
  const members = ORG_MEMBER_IDS.map((id) => requireRole(byId, id))
  const present = new Set(REQUIRED_IDS)
  const extra = roles.filter((role) => !present.has(role.id)).map((role) => role.id)
  if (extra.length > 0) throw new Error(`组织关系模板出现未知角色：${extra.join(', ')}`)

  return {
    root,
    supervisor,
    members,
    edges: [
      { from: ORG_ROOT_ID, to: ORG_SUPERVISOR_ID },
      ...ORG_MEMBER_IDS.map((id) => ({ from: ORG_SUPERVISOR_ID, to: id })),
    ],
  }
}
