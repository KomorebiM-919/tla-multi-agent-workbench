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
  mergeRecoveryEntry,
  needsCancelConfirmation,
  projectFieldErrors,
  removeProjectFromSession,
} from './lib/workspace-editing.js'
import { createWorkspaceSaver } from './lib/workspace-saver.js'
import { createRecoveryDrafts } from './lib/recovery-drafts.js'

const LIMITS = Object.freeze({
  name: MAX_NAME_LENGTH,
  description: MAX_DESCRIPTION_LENGTH,
  taskDraft: MAX_TASK_DRAFT_LENGTH,
})

const BRIDGE_UNAVAILABLE = Object.freeze({
  code: 'BRIDGE_UNAVAILABLE',
  message: '预加载接口不可用。',
})

function initialSaveStates(workspace, source) {
  const states = {}
  for (const project of workspace.projects) {
    states[project.id] = { kind: source === 'file' ? 'saved' : 'empty' }
  }
  return states
}

function formatClock(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

export default function App() {
  const [loadState, setLoadState] = useState({ status: 'loading', error: null })
  const [session, setSession] = useState(null)
  const sessionRef = useRef(null)
  const [baseline, setBaseline] = useState(null)
  const [saveStates, setSaveStates] = useState({})
  const [savedIds, setSavedIds] = useState(new Set())
  const savedIdsRef = useRef(new Set())
  const [backupStates, setBackupStates] = useState({})
  const [recoveryEntries, setRecoveryEntries] = useState([])
  const [recoveryDismissed, setRecoveryDismissed] = useState(new Set())
  const [recoveryHidden, setRecoveryHidden] = useState(false)
  const [recoveryError, setRecoveryError] = useState(null)
  const [recoveryActionError, setRecoveryActionError] = useState(null)
  const [cancelConfirmId, setCancelConfirmId] = useState(null)
  const [cancelBusyId, setCancelBusyId] = useState(null)
  const [cancelError, setCancelError] = useState(null)
  const [closeIssue, setCloseIssue] = useState(null)
  const [roleId, setRoleId] = useState(null)
  const [appInfo, setAppInfo] = useState(null)
  const [savingProjectId, setSavingProjectId] = useState(null)
  const savingProjectIdRef = useRef(null)
  const closeRequestIdRef = useRef(0)

  // 所有会话修改都走这里，确保“防抖备份拿到的是最新文本”，而不是某一次渲染的旧闭包。
  const applySession = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(sessionRef.current) : updater
    if (!next) return
    sessionRef.current = next
    setSession(next)
  }, [])

  const markSaved = useCallback((projectId) => {
    savedIdsRef.current.add(projectId)
    setSavedIds(new Set(savedIdsRef.current))
  }, [])

  const recoveryRef = useRef(null)
  if (!recoveryRef.current) {
    recoveryRef.current = createRecoveryDrafts({
      save: (snapshot) =>
        window.tla?.saveRecovery
          ? window.tla.saveRecovery(snapshot)
          : Promise.resolve({ ok: false, error: BRIDGE_UNAVAILABLE }),
      discard: (request) =>
        window.tla?.discardRecovery
          ? window.tla.discardRecovery(request)
          : Promise.resolve({ ok: false, error: BRIDGE_UNAVAILABLE }),
      onStatus: (projectId, status) => {
        setBackupStates((states) => ({ ...states, [projectId]: status }))
      },
    })
  }

  const saverRef = useRef(null)
  if (!saverRef.current) {
    saverRef.current = createWorkspaceSaver({
      save: (payload) => window.tla?.saveWorkspace?.(payload),
      onStart: (projectId) => {
        savingProjectIdRef.current = projectId
        setSavingProjectId(projectId)
        setSaveStates((states) => ({ ...states, [projectId]: { kind: 'saving' } }))
      },
      onSaved: (result, projectId) => {
        setBaseline(cloneSession(result.workspace))
        setSaveStates((states) => ({
          ...states,
          [projectId]: { kind: 'saved', savedAt: result.savedAt },
        }))
        markSaved(projectId)
        // 只清理“正好被这次保存覆盖”的恢复稿；保存期间的新编辑由控制器自己判断保留。
        const savedProject = result.workspace?.projects?.find((project) => project.id === projectId)
        if (savedProject) {
          void recoveryRef.current.clearCovered(projectId, savedProject).then((outcome) => {
            if (!outcome.ok) {
              setRecoveryActionError({
                id: projectId,
                message: `正式保存已成功，但恢复稿清理失败：${outcome.error.message}`,
              })
            }
          })
        }
      },
      onFailed: (error, projectId) => {
        setSaveStates((states) => ({
          ...states,
          [projectId]: { kind: 'failed', message: error.message },
        }))
      },
      onFinish: () => {
        savingProjectIdRef.current = null
        setSavingProjectId(null)
      },
    })
  }

  useEffect(() => {
    let cancelled = false
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
      setLoadState({ status: 'error', error: BRIDGE_UNAVAILABLE })
      return
    }

    const recoveryApi = window.tla?.loadRecovery
    const recoveryPromise =
      typeof recoveryApi === 'function'
        ? recoveryApi().catch((error) => ({
            ok: false,
            error: {
              code: 'RECOVERY_READ_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          }))
        : Promise.resolve(null)

    try {
      const [result, recovery] = await Promise.all([api(), recoveryPromise])
      if (!result?.ok) {
        setLoadState({
          status: 'error',
          error: result?.error ?? { code: 'UNKNOWN', message: '读取本地工作区失败。' },
        })
        return
      }

      const workspace = cloneSession(result.workspace)
      saverRef.current.reset(workspace)
      // 是否“已正式保存”以磁盘上是否有这份数据为准：缺文件时的默认项目不算。
      savedIdsRef.current = new Set(
        result.source === 'file' ? workspace.projects.map((project) => project.id) : [],
      )
      setSavedIds(new Set(savedIdsRef.current))
      sessionRef.current = workspace
      setSession(workspace)
      setBaseline(cloneSession(workspace))
      setSaveStates(initialSaveStates(workspace, result.source))
      setRecoveryDismissed(new Set())
      setRecoveryActionError(null)
      setLoadState({ status: 'ready', error: null })

      if (recovery?.ok) {
        const entries = Array.isArray(recovery.entries) ? recovery.entries : []
        // 只登记已有恢复稿，不在启动时写入或删除任何东西。
        recoveryRef.current.reset(entries)
        setRecoveryEntries(entries)
        setRecoveryError(null)
      } else if (recovery) {
        const error = recovery.error ?? {
          code: 'RECOVERY_READ_FAILED',
          message: '恢复稿读取失败。',
        }
        recoveryRef.current.markLoadFailure(error)
        setRecoveryEntries([])
        setRecoveryError(error)
      }
    } catch (error) {
      setLoadState({
        status: 'error',
        error: {
          code: 'READ_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }, [])

  useEffect(() => {
    loadWorkspace()
  }, [loadWorkspace])

  const handleCloseRequest = useCallback(async (payload) => {
    const requestId = payload?.requestId ?? 0
    closeRequestIdRef.current = requestId
    const result = await recoveryRef.current.flush()
    const api = window.tla
    if (result.ok) {
      try {
        await api?.confirmClose?.({ requestId, ok: true })
      } catch {
        // 主进程可能已随窗口关闭结束；这里只负责把结果交回去。
      }
      return
    }
    const first = result.errors?.[0]?.error ?? {
      code: 'CLOSE_FLUSH_FAILED',
      message: '恢复稿没有写完。',
    }
    // 已经超时提示过就不要用后到的失败结果覆盖超时说明。
    setCloseIssue((current) =>
      current?.timedOut
        ? current
        : { requestId, timedOut: false, message: first.message, errors: result.errors ?? [] },
    )
    try {
      await api?.confirmClose?.({ requestId, ok: false, error: first })
    } catch {
      // 同上：失败提示已经显示，不在关闭路径上抛错。
    }
  }, [])

  useEffect(() => {
    const subscribe = window.tla?.onCloseRequest
    if (typeof subscribe !== 'function') return undefined
    const unsubscribe = subscribe((payload) => {
      void handleCloseRequest(payload)
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [handleCloseRequest])

  useEffect(() => {
    const subscribe = window.tla?.onCloseTimeout
    if (typeof subscribe !== 'function') return undefined
    const unsubscribe = subscribe((payload) => {
      setCloseIssue({
        requestId: payload?.requestId ?? 0,
        timedOut: true,
        message: payload?.message ?? '恢复稿备份超时。',
        errors: [],
      })
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

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

  const recoveryRows = useMemo(() => {
    if (!session) return []
    // 恢复候选不要求正式文件里已有这个项目：新建但从未保存的项目同样可能留下恢复稿。
    return recoveryEntries.filter((entry) => !recoveryDismissed.has(entry.id))
  }, [session, recoveryEntries, recoveryDismissed])

  const projectIds = useMemo(
    () => new Set(session?.projects.map((project) => project.id) ?? []),
    [session],
  )

  const updateActiveProject = useCallback(
    (field, value) => {
      const current = sessionRef.current
      if (!current || !activeProject) return
      const updated = { ...activeProject, [field]: value }
      recoveryRef.current.noteEdit(updated)
      applySession({
        ...current,
        projects: current.projects.map((project) =>
          project.id === updated.id ? updated : project,
        ),
      })
      setSaveStates((states) => {
        if (states[updated.id]?.kind !== 'failed') return states
        return { ...states, [updated.id]: { kind: 'idle' } }
      })
    },
    [activeProject, applySession],
  )

  const selectProject = useCallback(
    (projectId) => {
      applySession((current) => (current ? { ...current, activeProjectId: projectId } : current))
      setRoleId(null)
      setCancelConfirmId(null)
      setCancelError(null)
    },
    [applySession],
  )

  const createProject = useCallback(() => {
    const current = sessionRef.current
    if (!current || current.projects.length >= MAX_PROJECTS) return
    const draft = createDraftProject(current.projects)
    setSaveStates((states) => ({ ...states, [draft.id]: { kind: 'empty' } }))
    applySession({
      ...current,
      activeProjectId: draft.id,
      projects: [...current.projects, draft],
    })
    setRoleId(null)
    setCancelConfirmId(null)
    setCancelError(null)
  }, [applySession])

  const saveActiveProject = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    const project = current.projects.find((item) => item.id === current.activeProjectId)
    if (!project) return
    // 同步防重入在 saver 内部：它在第一次 await 之前就把 inFlight 置位，
    // 因此连续点击、或还没轮到按钮重新渲染时再点，都拿不到第二份快照。
    await saverRef.current.save(current, project)
  }, [])

  const restoreRecovery = useCallback(
    (entry) => {
      setRecoveryActionError(null)
      const current = sessionRef.current
      if (!current) return
      const existed = current.projects.some((project) => project.id === entry.id)
      // 已有的项目只覆盖正文；从未正式保存的新项目会插入会话并被选中，仍保持“未保存”身份。
      const merged = mergeRecoveryEntry(current, entry)
      if (!merged) {
        // 已满 20 个项目：拒绝插入，但保留恢复候选，也不能把它标成已处理。
        setRecoveryActionError({
          id: entry.id,
          message: '正式文件最多 20 个项目，这次恢复没有改动会话或正式文件；请先处理现有项目再试，恢复候选会保留。',
        })
        return
      }
      applySession(merged)
      setSaveStates((states) => ({
        ...states,
        [entry.id]: existed ? { kind: 'idle' } : { kind: 'empty' },
      }))
      setRecoveryDismissed((dismissed) => new Set(dismissed).add(entry.id))
    },
    [applySession],
  )

  const discardRecoveryEntry = useCallback(async (entry) => {
    setRecoveryActionError(null)
    const result = await recoveryRef.current.discard(entry.id)
    if (!result.ok) {
      setRecoveryActionError({ id: entry.id, message: result.error.message })
      return
    }
    setRecoveryDismissed((dismissed) => new Set(dismissed).add(entry.id))
    setRecoveryEntries((entries) => entries.filter((item) => item.id !== entry.id))
    setBackupStates((states) => {
      const next = { ...states }
      delete next[entry.id]
      return next
    })
  }, [])

  const dismissRecovery = useCallback(() => {
    setRecoveryHidden(true)
  }, [])

  const performCancel = useCallback(
    async (projectId) => {
      const current = sessionRef.current
      if (!current) return
      if (savedIdsRef.current.has(projectId)) {
        setCancelConfirmId(null)
        return
      }
      // 正式保存正在途时不并发取消，避免“刚保存成功又被移出会话”。
      if (savingProjectIdRef.current === projectId) return
      setCancelError(null)
      setCancelBusyId(projectId)
      try {
        const result = await recoveryRef.current.discard(projectId)
        if (!result.ok) {
          setCancelError(result.error.message)
          return
        }
        if (savedIdsRef.current.has(projectId)) {
          // 取消期间该项目刚好保存成功：保留项目，不能把它当成未保存草稿移除。
          setCancelConfirmId(null)
          return
        }
        setCancelConfirmId(null)
        setBackupStates((states) => {
          const next = { ...states }
          delete next[projectId]
          return next
        })
        setSaveStates((states) => {
          const next = { ...states }
          delete next[projectId]
          return next
        })
        // 允许取消最后一个项目：会话进入空态，不自动创建替代项目，也不写正式文件。
        applySession((latest) =>
          latest ? { ...latest, ...removeProjectFromSession(latest, projectId) } : latest,
        )
      } finally {
        setCancelBusyId(null)
      }
    },
    [applySession],
  )

  const requestCancel = useCallback(
    (project) => {
      if (!project || savedIdsRef.current.has(project.id)) return
      if (savingProjectIdRef.current === project.id) return
      setCancelError(null)
      if (needsCancelConfirmation(project)) {
        setCancelConfirmId(project.id)
        return
      }
      void performCancel(project.id)
    },
    [performCancel],
  )

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
            <p>只读取本机工作区文件与恢复稿，不连接网络、仓库或模型。</p>
          </section>
        </main>
      </div>
    )
  }

  const canCancelActive = Boolean(
    activeProject && !savedIds.has(activeProject.id) && cancelBusyId !== activeProject.id,
  )

  return (
    <div className="shell">
      <ProjectNav
        projects={session.projects}
        activeId={session.activeProjectId}
        onSelect={selectProject}
        onCreate={createProject}
        canCreate={session.projects.length < MAX_PROJECTS}
        statusById={statusById}
        backupById={backupStates}
        appInfo={appInfo}
      />

      <main className="board" aria-labelledby="board-title">
        <header className="board-head">
          <div className="board-head-text">
            <h1 id="board-title">
              {activeProject?.name.trim() || (activeProject ? '未命名项目' : '还没有项目')}
            </h1>
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
            项目与任务草稿保存在本机工作区的 .local/tla-desktop/workspace.json，编辑中的内容会另外备份到
            recovery.json；两者都不入库、不联网。正式保存仍需点“保存草稿”，未保存的修改只在本次会话里保留。
            当前版本不连接任何模型。
          </p>
        </section>

        {recoveryError && (
          <section className="notice notice-warn" role="alert">
            <strong>恢复稿不可用</strong>
            <p>
              {recoveryError.code} · {recoveryError.message} 本窗口不会自动备份，正式保存不受影响；
              原恢复稿文件保持原样，不会被重置。
            </p>
          </section>
        )}

        {recoveryActionError &&
          !recoveryRows.some((entry) => entry.id === recoveryActionError.id) && (
            <section className="notice notice-warn" role="alert">
              <strong>恢复稿处理失败</strong>
              <p>{recoveryActionError.message} 正式数据未受影响，恢复稿会继续保留。</p>
            </section>
          )}

        {recoveryRows.length > 0 && recoveryHidden && (
          <button type="button" className="recovery-bar ghost" onClick={() => setRecoveryHidden(false)}>
            有 {recoveryRows.length} 条未处理的未保存内容，点击查看
          </button>
        )}

        {recoveryRows.length > 0 && !recoveryHidden && (
          <section className="recovery" aria-label="发现未保存内容">
            <div className="recovery-head">
              <h2>发现未保存内容</h2>
              <button type="button" className="ghost" onClick={dismissRecovery}>
                稍后处理
              </button>
            </div>
            <p className="recovery-lead">
              以下项目上次关闭时没有写进正式文件。恢复只装入本次编辑会话，不会自动覆盖正式数据；放弃则保留正式文件。
            </p>
            <ul className="recovery-list">
              {recoveryRows.map((entry) => (
                <li key={entry.id} className="recovery-item">
                  <div className="recovery-meta">
                    <strong>{entry.name.trim() || '未命名项目'}</strong>
                    {!projectIds.has(entry.id) && (
                      <span className="chip chip-empty">新建项目 · 尚未正式保存</span>
                    )}
                    <span>
                      {entry.taskDraft.length > 0
                        ? `任务草稿 ${entry.taskDraft.length} 字`
                        : '任务草稿为空'}
                      {' · '}
                      备份于 {formatClock(entry.updatedAt)}
                    </span>
                  </div>
                  <div className="recovery-actions">
                    <button type="button" className="primary" onClick={() => restoreRecovery(entry)}>
                      恢复
                    </button>
                    <button type="button" className="ghost" onClick={() => discardRecoveryEntry(entry)}>
                      放弃
                    </button>
                  </div>
                  {recoveryActionError?.id === entry.id && (
                    <p className="field-error" role="alert">
                      操作失败：{recoveryActionError.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {activeProject ? (
          <ProjectEditor
            project={activeProject}
            fieldErrors={fieldErrors}
            limits={LIMITS}
            dirty={dirtyIds.has(activeProject.id)}
            saveState={saveStates[activeProject.id]}
            backupState={backupStates[activeProject.id]}
            blockedByOtherSave={savingProjectId !== null && savingProjectId !== activeProject.id}
            canCancel={canCancelActive}
            cancelBusy={cancelBusyId === activeProject.id}
            cancelConfirm={cancelConfirmId === activeProject.id}
            cancelError={cancelConfirmId === activeProject.id ? cancelError : null}
            onChange={updateActiveProject}
            onSave={saveActiveProject}
            onCancel={() => requestCancel(activeProject)}
            onCancelConfirm={() => void performCancel(activeProject.id)}
            onCancelDismiss={() => {
              setCancelConfirmId(null)
              setCancelError(null)
            }}
          />
        ) : (
          <section className="empty-state" aria-label="没有项目">
            <h2>还没有项目</h2>
            <p>
              取消新建后可以停在这里。新建的项目只存在本次会话，点“保存草稿”才会写进正式文件；
              不会自动创建替代项目，也不会改动磁盘上的任何内容。
            </p>
            <button type="button" className="primary" onClick={createProject}>
              新建项目
            </button>
          </section>
        )}

        <TeamBoard roles={ROLES} activeRoleId={roleId} onSelect={setRoleId} />

        <footer className="board-foot">
          <span>点击任意角色卡，在右侧查看详情。</span>
          <span>模板数据来自 desktop/src/data/team.js，不包含真实运行记录。</span>
        </footer>
      </main>

      <RoleDetail role={role} onClear={() => setRoleId(null)} />

      {closeIssue && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="close-issue-title">
            <h2 id="close-issue-title">
              {closeIssue.timedOut ? '关闭前备份超时' : '恢复稿没有写完'}
            </h2>
            <p>
              {closeIssue.timedOut
                ? '主进程等待恢复稿备份超过 2 秒，这次关闭请求已经作废；之后才到的确认不会再关闭窗口。'
                : '关闭前需要把最新编辑备份到 recovery.json，但这次没有成功：'}
            </p>
            <p className="load-error-code">{closeIssue.message}</p>
            <p>仍然关闭会丢失尚未备份的编辑；返回后可以继续编辑或重试保存。</p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => setCloseIssue(null)}>
                返回继续编辑
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() => {
                  void window.tla?.forceClose?.()
                }}
              >
                仍然关闭
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
