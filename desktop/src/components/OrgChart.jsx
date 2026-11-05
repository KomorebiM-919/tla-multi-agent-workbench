import { buildOrgChart, ORG_TEMPLATE_NOTE } from '../lib/org-chart.js'

function roleMeta(role) {
  return role.kind === 'human' ? '人类 · 最终审批' : `模型：${role.model}`
}

function OrgNode({ role, active, onSelect, tier }) {
  return (
    <button
      type="button"
      className={active ? 'org-node is-active' : 'org-node'}
      aria-pressed={active}
      onClick={() => onSelect(role.id)}
    >
      <span className="org-node-tier">{tier}</span>
      <span className="org-node-name">{role.name}</span>
      <span className="org-node-meta">{role.badge} · {roleMeta(role)}</span>
    </button>
  )
}

export default function OrgChart({ roles, activeRoleId, onSelect }) {
  let chart = null
  let error = null
  try {
    chart = buildOrgChart(roles)
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error('组织关系模板不可用')
  }

  if (error) {
    return (
      <div className="org-chart">
        <p className="field-error" role="alert">组织关系模板不可用：{error.message}</p>
      </div>
    )
  }

  return (
    <div className="org-chart">
      <p className="org-chart-note">
        <strong>{ORG_TEMPLATE_NOTE.label}</strong>
        <span> · {ORG_TEMPLATE_NOTE.detail}</span>
        <span className="org-chart-explain">{ORG_TEMPLATE_NOTE.explanation}</span>
      </p>
      <div className="org-tier">
        <OrgNode role={chart.root} tier="用户总控制" active={chart.root.id === activeRoleId} onSelect={onSelect} />
      </div>
      <div className="org-link" aria-hidden="true" />
      <div className="org-tier">
        <OrgNode role={chart.supervisor} tier="主管位" active={chart.supervisor.id === activeRoleId} onSelect={onSelect} />
      </div>
      <div className="org-link" aria-hidden="true" />
      <p className="org-tier-label">其它四个 AI 角色位</p>
      <ul className="org-members">
        {chart.members.map((role) => (
          <li key={role.id}>
            <OrgNode role={role} tier="AI 角色位" active={role.id === activeRoleId} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </div>
  )
}
