const PAGE_ICONS = {
  chat: (
    <path d="M3.2 4.6h9.6v6.2H7.1L4.4 13v-2.2H3.2z" />
  ),
  team: (
    <>
      <circle cx="5.8" cy="5.4" r="1.9" />
      <circle cx="10.6" cy="6.4" r="1.5" />
      <path d="M2.6 12.2c.4-2 1.7-3 3.2-3s2.8 1 3.2 3" />
      <path d="M9.4 9.8c1.5-.2 3.1.6 3.6 2.2" />
    </>
  ),
  workflow: (
    <>
      <circle cx="4" cy="4" r="1.4" />
      <circle cx="10.6" cy="8" r="1.4" />
      <circle cx="4" cy="12" r="1.4" />
      <path d="M5.4 4.6 9.2 7.2M5.4 11.4 9.2 8.8" />
    </>
  ),
}

function PageIcon({ page }) {
  return (
    <svg
      className="nav-page-icon"
      viewBox="0 0 14 16"
      width="15"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PAGE_ICONS[page]}
    </svg>
  )
}

export default function ProjectNav({
  projects,
  activeId,
  onSelect,
  onCreate,
  canCreate,
  statusById,
  backupById,
  appInfo,
  pages = [],
  page,
  onChangePage,
}) {
  return (
    <aside className="nav" aria-label="项目导航">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          tla
        </span>
        <p className="brand-line">一起，把事情做好。</p>
      </div>

      <nav className="nav-pages" aria-label="工作区页面">
        {pages.map((item) => (
          <button
            key={item.id}
            type="button"
            className={page === item.id ? 'nav-page is-active' : 'nav-page'}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => onChangePage(item.id)}
          >
            <PageIcon page={item.id} />
            <span className="nav-page-label">{item.label}</span>
          </button>
        ))}
        <span className="nav-page nav-page-static" title="当前版本没有模型连接能力">
          <svg
            className="nav-page-icon"
            viewBox="0 0 14 16"
            width="15"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4.4 5.2V3.8a2.6 2.6 0 0 1 5.2 0v1.4" />
            <path d="M3.4 5.2h7.2v6.4H3.4z" />
          </svg>
          <span className="nav-page-label">模型连接</span>
          <span className="nav-page-state">未接入</span>
        </span>
      </nav>

      <div className="nav-projects">
        <h2 className="nav-title">当前项目</h2>
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
      </div>

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
