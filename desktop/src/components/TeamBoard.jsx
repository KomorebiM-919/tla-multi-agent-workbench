import { useState } from 'react'
import OrgChart from './OrgChart.jsx'
import RoleCard from './RoleCard.jsx'

export default function TeamBoard({ roles, activeRoleId, onSelect }) {
  const [view, setView] = useState('cards')

  return (
    <section className="team" aria-labelledby="team-title">
      <div className="team-head">
        <h2 id="team-title">项目团队</h2>
        <div className="team-view" role="group" aria-label="团队视图">
          <button
            type="button"
            className={view === 'cards' ? 'team-view-button is-active' : 'team-view-button'}
            aria-pressed={view === 'cards'}
            onClick={() => setView('cards')}
          >
            角色卡片
          </button>
          <button
            type="button"
            className={view === 'chart' ? 'team-view-button is-active' : 'team-view-button'}
            aria-pressed={view === 'chart'}
            onClick={() => setView('chart')}
          >
            管理关系
          </button>
        </div>
        <span className="team-count">{roles.length} 个角色位</span>
      </div>
      {view === 'cards' ? (
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
      ) : (
        <OrgChart roles={roles} activeRoleId={activeRoleId} onSelect={onSelect} />
      )}
    </section>
  )
}
