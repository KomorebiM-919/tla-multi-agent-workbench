import { PROJECT_NAV_NOTE } from '../data/projects.js'

export default function ProjectNav({ projects, activeId, onSelect, appInfo }) {
  return (
    <aside className="nav" aria-label="项目导航">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          TLA
        </span>
        <div className="brand-text">
          <strong>多智能体工作台</strong>
          <span>桌面预览 · V0.3</span>
        </div>
      </div>

      <nav className="nav-group" aria-label="项目列表">
        <h2 className="nav-title">项目</h2>
        <ul className="nav-list">
          {projects.map((project) => {
            const active = project.id === activeId
            return (
              <li key={project.id}>
                <button
                  type="button"
                  className={active ? 'nav-item is-active' : 'nav-item'}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(project.id)}
                >
                  <span className="nav-item-name">{project.name}</span>
                  <span className="nav-item-meta">
                    <span className="chip chip-quiet">{project.status}</span>
                    <span className="nav-item-note">{project.note}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <p className="nav-note">{PROJECT_NAV_NOTE}</p>

      <div className="nav-foot">
        {appInfo ? (
          <>
            <span>产品版本 {appInfo.productVersion}</span>
            <span>运行环境 Electron {appInfo.electronVersion}</span>
          </>
        ) : (
          <span>版本信息读取中</span>
        )}
      </div>
    </aside>
  )
}
