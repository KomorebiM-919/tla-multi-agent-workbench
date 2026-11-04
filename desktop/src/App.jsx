import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ProjectNav from './components/ProjectNav.jsx'
import ProjectEditor from './components/ProjectEditor.jsx'
import TeamBoard from './components/TeamBoard.jsx'
import RoleDetail from './components/RoleDetail.jsx'
import { ROLES, TEAM_TEMPLATE_STATE } from './data/team.js'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PROJECTS,
  MAX_TASK_DRAFT_LENGTH,
  cloneSession,
  createDraftProject,
  describeProjectStatus,
  dirtyProjectIds,
  projectFieldErrors,
} from './lib/workspace-editing.js'
import { createWorkspaceSaver } from './lib/workspace-saver.js'

const LIMITS = Object.freeze({
  name: MAX_NAME_LENGTH,
  description: MAX_DESCRIPTION_LENGTH,
  taskDraft: MAX_TASK_DRAFT_LENGTH,
})

function initialSaveStates(workspace, source) {
  const states = {}
  for (const project of workspace.projects) {
    states[project.id] = { kind: source === 'file' ? 'saved' : 'empty' }
  }
  return states
}

export default function App() {
  const [loadState, setLoadState] = useState({ status: 'loading', error: null })
  const [session, setSession] = useState(null)
  const [baseline, setBaseline] = useState(null)
  const [saveStates, setSaveStates] = useState({})
  const [roleId, setRoleId] = useState(null)
  const [appInfo, setAppInfo] = useState(null)
  const [savingProjectId, setSavingProjectId] = useState(null)
  const saverRef = useRef(null)
  if (!saverRef.current) {
    saverRef.current = createWorkspaceSaver({
      save: (payload) => window.tla?.saveWorkspace?.(payload),
      onStart: (projectId) => {
        setSavingProjectId(projectId)
        setSaveStates((states) => ({ ...states, [projectId]: { kind: 'saving' } }))
      },
      onSaved: (result, projectId) => {
        setBaseline(cloneSession(result.workspace))
        setSaveStates((states) => ({
          ...states,
          [projectId]: { kind: 'saved', savedAt: result.savedAt },
        }))
      },
      onFailed: (error, projectId) => {
        setSaveStates((states) => ({
          ...states,
          [projectId]: { kind: 'failed', message: error.message },
        }))
      },
      onFinish: () => setSavingProjectId(null),
    })
  }

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

  const loadWorkspace = useCallback(async () => {
    setLoadState({ status: 'loading', error: null })
    const api = window.tla?.loadWorkspace
    if (typeof api !== 'function') {
      setLoadState({
        status: 'error',
        error: { code: 'BRIDGE_UNAVAILABLE', message: '预加载接口不可用，无法读取本地工作区。' },
      })
      return
    }
    try {
      const result = await api()
      if (result?.ok) {
        const workspace = cloneSession(result.workspace)
        saverRef.current.reset(workspace)
        setSession(workspace)
        setBaseline(cloneSession(workspace))
        setSaveStates(initialSaveStates(workspace, result.source))
        setLoadState({ status: 'ready', error: null })
        return
      }
      setLoadState({
        status: 'error',
        error: result?.error ?? { code: 'UNKNOWN', message: '读取本地工作区失败。' },
      })
    } catch (error) {
      setLoadState({
        status: 'error',
        error: { code: 'READ_FAILED', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }, [])

  useEffect(() => {
    loadWorkspace()
  }, [loadWorkspace])

  const activeProject = useMemo(() => {
    if (!session) return null
    return session.projects.find((project) => project.id === session.activeProjectId) ?? null
  }, [session])

  const dirtyIds = useMemo(
    () => (session && baseline ? new Set(dirtyProjectIds(session, baseline.projects)) : new Set()),
    [session, baseline],
  )

  const statusById = useMemo(() => {
    if (!session) return new Map()
    return new Map(
      session.projects.map((project) => [
        project.id,
        describeProjectStatus({ dirty: dirtyIds.has(project.id), saveState: saveStates[project.id] }),
      ]),
    )
  }, [session, dirtyIds, saveStates])

  const fieldErrors = useMemo(
    () => (activeProject ? projectFieldErrors(activeProject) : {}),
    [activeProject],
  )

  const role = useMemo(() => ROLES.find((item) => item.id === roleId) ?? null, [roleId])

  const updateActiveProject = useCallback((field, value) => {
    setSession((current) => {
      if (!current) return current
      return {
        ...current,
        projects: current.projects.map((project) =>
          project.id === current.activeProjectId ? { ...project, [field]: value } : project,
        ),
      }
    })
    setSaveStates((states) => {
      const id = session?.activeProjectId
      if (!id || states[id]?.kind !== 'failed') return states
      return { ...states, [id]: { kind: 'idle' } }
    })
  }, [session?.activeProjectId])

  const selectProject = useCallback((projectId) => {
    setSession((current) => (current ? { ...current, activeProjectId: projectId } : current))
    setRoleId(null)
  }, [])

  const createProject = useCallback(() => {
    if (!session || session.projects.length >= MAX_PROJECTS) return
    const draft = createDraftProject(session.projects)
    setSaveStates((states) => ({ ...states, [draft.id]: { kind: 'empty' } }))
    setSession({ activeProjectId: draft.id, projects: [...session.projects, draft] })
    setRoleId(null)
  }, [session])

  const saveActiveProject = useCallback(async () => {
    if (!session || !activeProject) return
    // 同步防重入在 saver 内部：它在第一次 await 之前就把 inFlight 置位，
    // 因此连续点击、或还没轮到按钮重新渲染时再点，都拿不到第二份快照。
    await saverRef.current.save(session, activeProject)
  }, [session, activeProject])

  if (loadState.status === 'error') {
    return (
      <div className="shell shell-error">
        <main className="board" aria-labelledby="load-error-title">
          <section className="load-error" role="alert">
            <h1 id="load-error-title">本地工作区读取失败</h1>
            <p className="load-error-code">
              {loadState.error.code} · {loadState.error.message}
            </p>
            <p>
              为避免覆盖原文件，本窗口不会写入任何内容。请检查工作区文件后重新读取；文件会被原样保留。
            </p>
            <button type="button" className="primary" onClick={loadWorkspace}>
              重新读取
            </button>
          </section>
        </main>
      </div>
    )
  }

  if (loadState.status === 'loading' || !session) {
    return (
      <div className="shell shell-loading">
        <main className="board" aria-labelledby="loading-title">
          <section className="loading" role="status">
            <h1 id="loading-title">正在读取本地项目…</h1>
            <p>只读取本机工作区文件，不连接网络、仓库或模型。</p>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="shell">
      <ProjectNav
        projects={session.projects}
        activeId={session.activeProjectId}
        onSelect={selectProject}
        onCreate={createProject}
        canCreate={session.projects.length < MAX_PROJECTS}
        statusById={statusById}
        appInfo={appInfo}
      />

      <main className="board" aria-labelledby="board-title">
        <header className="board-head">
          <div className="board-head-text">
            <h1 id="board-title">{activeProject?.name.trim() || '未命名项目'}</h1>
            <p className="board-sub">
              本地项目与任务草稿只保存在本机，所有角色均未接入模型。
            </p>
          </div>
          <span className="badge badge-template">
            {TEAM_TEMPLATE_STATE.label} · {TEAM_TEMPLATE_STATE.detail}
          </span>
        </header>

        <section className="notice" aria-label="当前状态说明">
          <strong>状态说明</strong>
          <p>
            项目与任务草稿保存在本机工作区的 .local/tla-desktop/workspace.json，不入库、不联网；
            未保存的修改只在本次会话里保留。当前版本不连接任何模型，卡片上的职责、输入与输出都是模板占位。
          </p>
        </section>

        {activeProject && (
          <ProjectEditor
            project={activeProject}
            fieldErrors={fieldErrors}
            limits={LIMITS}
            dirty={dirtyIds.has(activeProject.id)}
            saveState={saveStates[activeProject.id]}
            blockedByOtherSave={savingProjectId !== null && savingProjectId !== activeProject.id}
            onChange={updateActiveProject}
            onSave={saveActiveProject}
          />
        )}

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
