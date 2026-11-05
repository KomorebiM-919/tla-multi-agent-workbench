export default function RoleCard({ role, active, onSelect }) {
  const isHuman = role.kind === 'human'
  return (
    <button
      type="button"
      className={`role-card${active ? ' is-active' : ''}${isHuman ? ' is-human' : ''}`}
      aria-pressed={active}
      onClick={() => onSelect(role.id)}
    >
      <span className="role-card-top">
        <span className="role-avatar" aria-hidden="true">
          {role.name.slice(0, 1)}
        </span>
        <span className="role-id">
          <strong>{role.name}</strong>
          <span className="role-badge">{role.badge}</span>
        </span>
      </span>
      <span className="role-card-summary">{role.summary}</span>
      <span className="role-card-foot">
        <span className={isHuman ? 'chip chip-human' : 'chip chip-quiet'}>
          {isHuman ? '人类角色' : 'AI角色'}
        </span>
        <span className="role-card-model">{role.model}</span>
      </span>
    </button>
  )
}
