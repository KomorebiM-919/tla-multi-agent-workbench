export default function ProjectNav({
  projects,
  activeId,
  onSelect,
  onCreate,
  canCreate,
  statusById,
  backupById,
  appInfo,
}) {
  return (
    <aside className="nav" aria-label="项目导航">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          TLA
        </span>
        <div className="brand-text">
          <strong>多智能体工作台</strong>
          <span>本地项目 · V0.3</span>
        </div>
      </div>

      <nav className="nav-group" aria-label="本地项目列表">
        <h2 className="nav-title">项目</h2>
        <ul className="nav-list">
          {projects.map((project) => {
            const active = project.id === activeId
            const status = statusById.get(project.id) ?? { tone: 'saved', label: '已保存' }
            const backup = backupById?.[project.id]
            const backupText =
              backup?.kind === 'saving'
                ? '备份中'
                : backup?.kind === 'failed'
                  ? '备份失败'
                  : backup?.kind === 'saved'
                    ? '已备份'
                    : ''
            return (
              <li key={project.id}>
                <button
                  type="button"
                  className={active ? 'nav-item is-active' : 'nav-item'}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(project.id)}
                >
                  <span className="nav-item-name">{project.name.trim() || '未命名项目'}</span>
                  <span className="nav-item-meta">
                    <span className={`chip chip-${status.tone}`}>{status.label}</span>
                    {status.tone === 'dirty' && <span className="nav-item-note">尚未写入正式文件</span>}
                    {backupText && (
                      <span className={`backup backup-${backup.kind}`} title="恢复稿备份状态">
                        {backupText}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <button
          type="button"
          className="nav-add"
          onClick={onCreate}
          disabled={!canCreate}
          title={canCreate ? '在本次会话中新建一个本地项目' : '已达到项目数量上限'}
        >
          ＋ 新建项目
        </button>
      </nav>

      <p className="nav-note">
        正式保存写入本机工作区文件，编辑中的内容会自动备份到恢复稿。未连接仓库或模型；备份不保证断电或强制退出时零丢失。
      </p>

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
