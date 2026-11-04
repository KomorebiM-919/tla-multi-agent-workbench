function DetailRow({ label, children }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export default function RoleDetail({ role, onClear }) {
  if (!role) {
    return (
      <aside className="detail" aria-label="角色详情">
        <div className="detail-empty">
          <h2>角色详情</h2>
          <p>从左侧团队模板中选择一个角色，查看它的职责与边界。</p>
          <span className="detail-empty-hint">当前没有选中角色</span>
        </div>
      </aside>
    )
  }

  const isHuman = role.kind === 'human'

  return (
    <aside className="detail" aria-label={`角色详情：${role.name}`}>
      <header className="detail-head">
        <div>
          <span className="detail-kicker">角色详情</span>
          <h2>{role.name}</h2>
        </div>
        <button type="button" className="detail-close" onClick={onClear} aria-label="关闭角色详情">
          关闭
        </button>
      </header>

      <div className="detail-badges">
        <span className={isHuman ? 'chip chip-human' : 'chip chip-quiet'}>
          {isHuman ? '人类角色' : '模板角色'}
        </span>
        <span className="chip chip-model">{role.model}</span>
      </div>

      <p className="detail-summary">{role.summary}</p>

      <dl className="detail-list">
        <DetailRow label="定位">{role.badge}</DetailRow>
        <DetailRow label="职责">{role.duty}</DetailRow>
        <DetailRow label="输入">{role.inputs}</DetailRow>
        <DetailRow label="输出">{role.outputs}</DetailRow>
        <DetailRow label="边界">{role.boundary}</DetailRow>
      </dl>

      <p className="detail-note">
        以上内容为初始团队模板中的职责说明，未接入任何模型，也不代表当前有任务在运行。
      </p>
    </aside>
  )
}
