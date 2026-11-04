import { useEffect, useMemo, useState } from 'react'
import ProjectNav from './components/ProjectNav.jsx'
import TeamBoard from './components/TeamBoard.jsx'
import RoleDetail from './components/RoleDetail.jsx'
import { PROJECTS } from './data/projects.js'
import { ROLES, TEAM_TEMPLATE_STATE } from './data/team.js'

export default function App() {
  const [projectId, setProjectId] = useState(PROJECTS[0].id)
  const [roleId, setRoleId] = useState(null)
  const [appInfo, setAppInfo] = useState(null)

  useEffect(() => {
    let cancelled = false
    // 预加载层可能因安全策略调整而不存在，这里按缺省处理，不影响界面。
    window.tla?.getAppInfo?.()
      ?.then((info) => {
        if (!cancelled) setAppInfo(info)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const project = useMemo(() => PROJECTS.find((item) => item.id === projectId) ?? null, [projectId])
  const role = useMemo(() => ROLES.find((item) => item.id === roleId) ?? null, [roleId])

  return (
    <div className="shell">
      <ProjectNav
        projects={PROJECTS}
        activeId={projectId}
        onSelect={setProjectId}
        appInfo={appInfo}
      />

      <main className="board" aria-labelledby="board-title">
        <header className="board-head">
          <div className="board-head-text">
            <h1 id="board-title">{project ? project.name : '团队模板'}</h1>
            <p className="board-sub">
              首批桌面壳只呈现团队模板与角色职责，所有角色均未接入模型。
            </p>
          </div>
          <span className="badge badge-template">
            {TEAM_TEMPLATE_STATE.label} · {TEAM_TEMPLATE_STATE.detail}
          </span>
        </header>

        <section className="notice" aria-label="当前状态说明">
          <strong>状态说明</strong>
          <p>
            当前版本不连接任何模型，不产生真实回复、余额或运行状态。卡片上的职责、输入与输出都是模板占位，
            需要在后续批次另行接入与验证。
          </p>
        </section>

        <TeamBoard roles={ROLES} activeRoleId={roleId} onSelect={setRoleId} />

        <footer className="board-foot">
          <span>点击任意角色卡，在右侧查看详情。</span>
          <span>模板数据来自 desktop/src/data/team.js，不包含真实运行记录。</span>
        </footer>
      </main>

      <RoleDetail role={role} onClear={() => setRoleId(null)} />
    </div>
  )
}
