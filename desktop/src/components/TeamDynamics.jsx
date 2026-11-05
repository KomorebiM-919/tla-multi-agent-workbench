import { useCallback } from 'react'

const MODE_LABEL = {
  sidebar: '浮动面板',
  floating: '收回侧栏',
}

export default function TeamDynamics({ mode, roles, onCollapse, onToggleMode, panelRef }) {
  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCollapse()
      }
    },
    [onCollapse],
  )

  return (
    <aside
      className={`dynamics dynamics-${mode}`}
      aria-label="团队动态"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <header className="dynamics-head">
        <div>
          <h2>团队动态</h2>
          <p className="dynamics-sub">未接入执行 · 不会产生任务或消息</p>
        </div>
        <div className="dynamics-controls">
          <button type="button" className="ghost" onClick={onToggleMode}>
            {MODE_LABEL[mode]}
          </button>
          <button type="button" className="ghost" onClick={onCollapse}>
            收起
          </button>
        </div>
      </header>

      <p className="dynamics-note">
        这里只反映当前项目的角色位；展开或收起都不会启动、暂停或取消任何工作。
      </p>

      <ul className="dynamics-list">
        {roles.map((role) => (
          <li key={role.id} className="dynamics-row">
            <span className="dynamics-name">{role.name}</span>
            <span className="chip chip-quiet">空闲 · 未连接</span>
          </li>
        ))}
      </ul>

      <p className="dynamics-empty" role="status">
        尚无运行中的任务。当前版本没有执行引擎，也不会伪造活动记录。
      </p>
    </aside>
  )
}
