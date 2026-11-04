import RoleCard from './RoleCard.jsx'

export default function TeamBoard({ roles, activeRoleId, onSelect }) {
  return (
    <section className="team" aria-labelledby="team-title">
      <div className="team-head">
        <h2 id="team-title">初始团队模板</h2>
        <span className="team-count">{roles.length} 个角色位</span>
      </div>
      <div className="team-grid">
        {roles.map((role) => (
          <RoleCard
            key={role.id}
            role={role}
            active={role.id === activeRoleId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  )
}
