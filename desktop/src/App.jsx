import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ProjectNav from './components/ProjectNav.jsx'
import ChatWorkspace from './components/ChatWorkspace.jsx'
import ProjectEditor from './components/ProjectEditor.jsx'
import TeamDynamics from './components/TeamDynamics.jsx'
import TeamBoard from './components/TeamBoard.jsx'
import WorkflowTemplate from './components/WorkflowTemplate.jsx'
import RoleDetail from './components/RoleDetail.jsx'
import { ROLES } from './data/team.js'
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
import {
  MAX_CONVERSATION_TEXT_LENGTH,
  createConversationDrafts,
} from './lib/conversation-drafts.js'
import { createTeamSettingsController, abortRoleCloseIfNeeded } from './lib/team-settings-controller.js'
import {
  flushBeforeClose,
  indexCandidates,
  initialConversationTexts,
  recordConversationEdit,
  restoreConversationCandidate,
  unretainedMessage,
} from './lib/conversation-session.js'
import { attemptPageChange } from './lib/page-navigation.js'
import { isRoleDetailVisible } from './lib/layout-state.js'
import { requestDynamicsChange } from './lib/dynamics-transition.js'

const LIMITS = Object.freeze({
  name: MAX_NAME_LENGTH,
  description: MAX_DESCRIPTION_LENGTH,
  taskDraft: MAX_TASK_DRAFT_LENGTH,
})

const PAGES = Object.freeze([
  { id: 'chat', label: '对话' },
  { id: 'team', label: '团队' },
  { id: 'workflow', label: '流程' },
])

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
  const [conversationTexts, setConversationTexts] = useState({})
  const conversationTextsRef = useRef({})
  const [conversationCandidates, setConversationCandidates] = useState({})
  const [conversationUnretained, setConversationUnretained] = useState({})
  const conversationUnretainedRef = useRef({})
  const [conversationStates, setConversationStates] = useState({})
  const [conversationError, setConversationError] = useState(null)
  const [orphanDrafts, setOrphanDrafts] = useState([])
  const [closeIssue, setCloseIssue] = useState(null)
  const [roleId, setRoleId] = useState(null)
  const [page, setPage] = useState('chat')
  const [dynamics, setDynamics] = useState('hidden')
  const dynamicsButtonRef = useRef(null)
  const dynamicsPanelRef = useRef(null)
  const dynamicsWasOpenRef = useRef(false)
  const [appInfo, setAppInfo] = useState(null)
  const [savingProjectId, setSavingProjectId] = useState(null)
  const savingProjectIdRef = useRef(null)
  const closeRequestIdRef = useRef(0)
  const closeDialogRef = useRef(null)
  const closeSafeActionRef = useRef(null)
  const closePreviousFocusRef = useRef(null)
  const closeDialogOpen = closeIssue !== null
  const [teamState, setTeamState] = useState(null)
  const teamControllerRef = useRef(null)
  if (!teamControllerRef.current) {
    teamControllerRef.current = createTeamSettingsController({
      load: (projectId) => window.tla?.loadTeamSettings?.(projectId) ?? Promise.resolve({ ok: false, error: BRIDGE_UNAVAILABLE }),
      save: (projectId, setting) => window.tla?.saveRoleSettings?.(projectId, setting) ?? Promise.resolve({ ok: false, error: BRIDGE_UNAVAILABLE }),
      onChange: setTeamState,
    })
  }
  const teamProjectId = session?.activeProjectId ?? null
  const teamProjectSaved = savedIds.has(teamProjectId)
  useEffect(() => {
    void teamControllerRef.current.selectProject(teamProjectId, teamProjectSaved)
  }, [teamProjectId, teamProjectSaved])

  useEffect(() => {
    if (!closeDialogOpen) return undefined
    const previous = document.activeElement
    closePreviousFocusRef.current = previous instanceof HTMLElement ? previous : null
    // 关闭被拦下时把焦点放到安全选项，避免用户一路 Tab 直接落到“仍然关闭”。
    const frame = requestAnimationFrame(() => closeSafeActionRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      const target = closePreviousFocusRef.current
      closePreviousFocusRef.current = null
      if (target?.isConnected) target.focus()
      else document.querySelector('.board')?.focus()
    }
  }, [closeDialogOpen])

  // Escape 只收起提示回到编辑；强制关闭只能通过“仍然关闭”按钮显式触发。
  const handleDialogKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setCloseIssue(null)
      return
    }
    if (event.key !== 'Tab') return
    const dialog = closeDialogRef.current
    if (!dialog) return
    const focusable = [
      ...dialog.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

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

  const conversationRef = useRef(null)
  if (!conversationRef.current) {
    conversationRef.current = createConversationDrafts({
      save: (draft) =>
        window.tla?.saveConversationDraft
          ? window.tla.saveConversationDraft(draft)
          : Promise.resolve({ ok: false, error: BRIDGE_UNAVAILABLE }),
      discard: (request) =>
        window.tla?.discardConversationDraft
          ? window.tla.discardConversationDraft(request)
          : Promise.resolve({ ok: false, error: BRIDGE_UNAVAILABLE }),
      onStatus: (projectId, status) => {
        setConversationStates((states) => ({ ...states, [projectId]: status }))
      },
    })
  }

  const setConversationText = useCallback((projectId, text) => {
    if (!projectId) return
    const next = { ...conversationTextsRef.current, [projectId]: text }
    conversationTextsRef.current = next
    setConversationTexts(next)
  }, [])

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

    const conversationApi = window.tla?.loadConversationDrafts
    const conversationPromise =
      typeof conversationApi === 'function'
        ? conversationApi().catch((error) => ({
            ok: false,
            error: {
              code: 'CONVERSATION_READ_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          }))
        : Promise.resolve(null)

    try {
      const [result, recovery, conversation] = await Promise.all([
        api(),
        recoveryPromise,
        conversationPromise,
      ])
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

      if (conversation?.ok) {
        const drafts = Array.isArray(conversation.drafts) ? conversation.drafts : []
        // 输入框默认空白：已保留的文字只作为候选，等用户点击才恢复。
        const texts = initialConversationTexts(drafts)
        conversationTextsRef.current = texts
        setConversationTexts(texts)
        setConversationCandidates(indexCandidates(drafts))
        setConversationUnretained({})
        conversationUnretainedRef.current = {}
        // 只登记已存在的未发送文字，不在启动时写入或删除任何东西。
        conversationRef.current.reset(drafts)
        setConversationError(null)
        // 项目身份已不在会话、也没有可恢复的项目恢复稿：文字原样保留并提示，
        // 不静默删除，也不挂到别的项目上。
        const knownProjects = new Set(workspace.projects.map((project) => project.id))
        const restorableProjects = new Set(
          (recovery?.ok ? recovery.entries : []).map((entry) => entry.id),
        )
        setOrphanDrafts(
          drafts.filter(
            (draft) =>
              !knownProjects.has(draft.projectId) && !restorableProjects.has(draft.projectId),
          ),
        )
      } else {
        const error = conversation?.error ?? BRIDGE_UNAVAILABLE
        conversationRef.current.markLoadFailure(error)
        conversationTextsRef.current = {}
        setConversationTexts({})
        setConversationCandidates({})
        setConversationUnretained({})
        conversationUnretainedRef.current = {}
        setConversationError(error)
        setOrphanDrafts([])
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
    const api = window.tla
    const roleCloseGuard = () => abortRoleCloseIfNeeded({
      controller: teamControllerRef.current,
      requestId,
      confirmClose: (result) => api?.confirmClose?.(result),
      onBlocked: (problem) => setCloseIssue({ requestId, roleIssue: true, timedOut: false, message: problem.message, errors: [] }),
    })
    if (await roleCloseGuard()) return
    // 两类最新编辑一起做一致性屏障：任何一类在等待另一类期间又变脏，
    // 都会再走一轮，只有两边都不再 pending 才允许确认关闭。
    const result = await flushBeforeClose({
      recovery: recoveryRef.current,
      conversation: conversationRef.current,
      unretained: conversationUnretainedRef.current,
    })
    if (await roleCloseGuard()) return
    if (result.ok) {
      try {
        await api?.confirmClose?.({ requestId, ok: true })
      } catch {
        // 主进程可能已随窗口关闭结束；这里只负责把结果交回去。
      }
      return
    }
    const combined = result.errors ?? []
    const first = combined[0]?.error ?? {
      code: 'CLOSE_FLUSH_FAILED',
      message: '恢复稿或未发送文字没有写完。',
    }
    // 已经超时提示过就不要用后到的失败结果覆盖超时说明。
    setCloseIssue((current) =>
      current?.timedOut
        ? current
        : {
            requestId,
            timedOut: false,
            message:
              combined.length > 1
                ? `${first.message}（另有 ${combined.length - 1} 项尚未完成）`
                : first.message,
            errors: combined,
          },
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

  const visibleTeam = teamState?.projectId === teamProjectId ? teamState.roles : ROLES
  const role = visibleTeam.find((item) => item.id === roleId) ?? null
  const selectRole = useCallback((nextRoleId) => {
    if (!teamControllerRef.current.mayLeave()) return
    teamControllerRef.current.cancel()
    setRoleId(nextRoleId)
  }, [])

  const changePage = useCallback(
    (nextPage) => {
      const result = attemptPageChange({
        currentPage: page,
        nextPage,
        teamController: teamControllerRef.current,
      })
      if (result.changed) setPage(nextPage)
    },
    [page],
  )

  const changeDynamics = useCallback(
    (intent) => {
      // Entering docked can replace the role detail, so every entry point shares
      // the same unsaved-role guard. The guard runs outside the state updater
      // because it publishes a notice; blocked transitions leave state untouched.
      const result = requestDynamicsChange({
        current: dynamics,
        intent,
        teamController: teamControllerRef.current,
      })
      if (!result.blocked) setDynamics(result.dynamics)
    },
    [dynamics],
  )

  const toggleDynamics = useCallback(() => changeDynamics('toggle'), [changeDynamics])

  const toggleDynamicsMode = useCallback(() => changeDynamics('mode'), [changeDynamics])

  useEffect(() => {
    if (dynamics !== 'hidden') {
      dynamicsWasOpenRef.current = true
      const frame = requestAnimationFrame(() => dynamicsPanelRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
    if (dynamicsWasOpenRef.current) {
      dynamicsWasOpenRef.current = false
      dynamicsButtonRef.current?.focus()
    }
    return undefined
  }, [dynamics])

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

  const updateConversationText = useCallback(
    (value) => {
      const current = sessionRef.current
      const projectId = current?.activeProjectId
      if (!projectId) return
      const project = current.projects.find((item) => item.id === projectId)
      if (!project) return
      const result = recordConversationEdit({
        conversation: conversationRef.current,
        recovery: recoveryRef.current,
        project,
        saved: savedIdsRef.current.has(projectId),
        text: value,
        limit: MAX_CONVERSATION_TEXT_LENGTH,
      })
      // 读取失败等不可写状态不接受新输入，避免“看得到但没人负责保留”的文字。
      if (!result.accepted) return
      setConversationText(projectId, value)
      const nextUnretained = { ...conversationUnretainedRef.current }
      if (result.retained) delete nextUnretained[projectId]
      else nextUnretained[projectId] = { text: value, reason: result.reason }
      conversationUnretainedRef.current = nextUnretained
      setConversationUnretained(nextUnretained)
    },
    [setConversationText],
  )

  const restoreConversation = useCallback(
    (projectId, confirmed = false) => {
      const candidate = conversationCandidates[projectId]
      if (!candidate || !candidate.text) return { applied: false }
      const decision = restoreConversationCandidate({
        currentText: conversationTextsRef.current[projectId] ?? '',
        candidateText: candidate.text,
        confirmed,
      })
      if (!decision.apply) return { applied: false, needsConfirmation: true }
      setConversationText(projectId, decision.text)
      setConversationStates((states) => ({
        ...states,
        [projectId]: {
          kind: 'saved',
          backedUpAt: candidate.updatedAt ?? null,
          restored: true,
        },
      }))
      return { applied: true }
    },
    [conversationCandidates, setConversationText],
  )

  const selectProject = useCallback(
    (projectId) => {
      if (!teamControllerRef.current.mayLeave()) return
      applySession((current) => (current ? { ...current, activeProjectId: projectId } : current))
      setRoleId(null)
      setCancelConfirmId(null)
      setCancelError(null)
    },
    [applySession],
  )

  const createProject = useCallback(() => {
    if (!teamControllerRef.current.mayLeave()) return
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
    // 新建后直接进入设置页，命名、保存与取消入口都不会被对话输入挤掉。
    setPage('settings')
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
      if (!teamControllerRef.current.mayLeave()) return
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
        const recoveryResult = await recoveryRef.current.discard(projectId)
        if (!recoveryResult.ok) {
          setCancelError(recoveryResult.error.message)
          return
        }
        // 取消新建必须同时清掉未发送文字；任一步失败都保留项目，方便重试。
        const conversationResult = await conversationRef.current.discard(projectId)
        if (!conversationResult.ok) {
          setCancelError(conversationResult.error.message)
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
        setConversationStates((states) => {
          const next = { ...states }
          delete next[projectId]
          return next
        })
        const remainingTexts = { ...conversationTextsRef.current }
        delete remainingTexts[projectId]
        conversationTextsRef.current = remainingTexts
        setConversationTexts(remainingTexts)
        setConversationCandidates((candidates) => {
          const next = { ...candidates }
          delete next[projectId]
          return next
        })
        const remainingUnretained = { ...conversationUnretainedRef.current }
        delete remainingUnretained[projectId]
        conversationUnretainedRef.current = remainingUnretained
        setConversationUnretained(remainingUnretained)
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
      // 未恢复的候选文字也算“有内容”，不能因为输入框为空就跳过确认。
      const hasConversationText =
        (conversationTextsRef.current[project.id] ?? '').length > 0 ||
        (conversationCandidates[project.id]?.text ?? '').length > 0 ||
        Boolean(conversationUnretained[project.id])
      if (needsCancelConfirmation(project) || hasConversationText) {
        setCancelConfirmId(project.id)
        return
      }
      void performCancel(project.id)
    },
    [conversationCandidates, conversationUnretained, performCancel],
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
  const conversationText = activeProject
    ? (conversationTexts[activeProject.id] ?? '')
    : ''
  const conversationState = activeProject ? conversationStates[activeProject.id] : null
  const conversationCandidate = activeProject
    ? conversationCandidates[activeProject.id] ?? null
    : null
  const conversationUnretainedEntry = activeProject
    ? conversationUnretained[activeProject.id] ?? null
    : null
  const conversationDisabledReason = conversationError
    ? `未发送文字文件不可用（${conversationError.code}）：${conversationError.message} 为避免覆盖原文件，本窗口已停止写入并暂不接受新输入；项目设置仍可正常使用。`
    : null
  const openSettings = () => changePage('settings')
  // 角色详情只属于团队页；对话/流程页释放右侧列。动态侧栏复用同一列，不额外开第四栏。
  const dockedDynamics = dynamics === 'docked'
  const showRoleDetail = isRoleDetailVisible({ page, roleId, dynamics })
  const hasAux = dockedDynamics || showRoleDetail

  return (
    <>
      <div
        className={hasAux ? 'shell' : 'shell shell-no-aux'}
        inert={closeIssue ? true : undefined}
        aria-hidden={closeIssue ? 'true' : undefined}
      >
      <ProjectNav
        projects={session.projects}
        activeId={session.activeProjectId}
        onSelect={selectProject}
        onCreate={createProject}
        canCreate={session.projects.length < MAX_PROJECTS}
        statusById={statusById}
        backupById={backupStates}
        appInfo={appInfo}
        pages={PAGES}
        page={page}
        onChangePage={changePage}
      />

      <main className="board" aria-labelledby="board-title" tabIndex={-1}>
        <header className="board-head">
          <div className="board-head-text">
            <p className="board-eyebrow">{activeProject ? '当前项目' : '本地工作区'}</p>
            <h1 id="board-title">
              {activeProject?.name.trim() || (activeProject ? '未命名项目' : '还没有项目')}
            </h1>
            <p className="board-sub">
              {page === 'team'
                ? '团队角色只作为本地配置与只读组织模板，不产生调度或运行记录。'
                : page === 'workflow'
                  ? '阶段顺序模板整体未运行；没有真实执行记录、耗时或费用。'
                  : '任务草稿只保存在本机；当前版本未接入执行，也不会生成回复。'}
            </p>
          </div>
          <div className="board-head-tools">
            <button
              type="button"
              className={dynamics === 'hidden' ? 'ghost dynamics-toggle' : 'ghost dynamics-toggle is-open'}
              aria-expanded={dynamics !== 'hidden'}
              onClick={toggleDynamics}
              ref={dynamicsButtonRef}
            >
              团队动态 <span aria-hidden="true">{dynamics === 'hidden' ? '↗' : '×'}</span>
            </button>
            <span className="badge badge-template">未接入执行</span>
          </div>
        </header>

        <div className="board-notices">
        {conversationError && (
          <section className="notice notice-warn" role="alert">
            <strong>未发送文字不可用</strong>
            <p>
              {conversationError.code} · {conversationError.message} 为避免覆盖原文件，本窗口已停止写入
              conversation-drafts.json；项目设置与正式保存不受影响。
            </p>
          </section>
        )}

        {orphanDrafts.length > 0 && (
          <section className="notice notice-warn" role="status">
            <strong>有 {orphanDrafts.length} 条未发送文字暂时找不到对应项目</strong>
            <p>
              这些文字仍原样保留在 conversation-drafts.json 里，不会删除，也不会挂到别的项目上；
              恢复或重建对应项目（同一项目 ID）后才能重新显示。
            </p>
          </section>
        )}

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
                        ? `项目计划 ${entry.taskDraft.length} 字`
                        : '项目计划为空'}
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
        </div>

        {page === 'chat' && (
          activeProject ? (
            <ChatWorkspace
              project={activeProject}
              text={conversationText}
              limit={MAX_CONVERSATION_TEXT_LENGTH}
              conversationState={conversationState}
              onChangeText={updateConversationText}
              disabledReason={conversationDisabledReason}
              recoveryState={backupStates[activeProject.id]}
              candidate={conversationCandidate}
              onRestore={() => restoreConversation(activeProject.id)}
              onRestoreConfirm={() => restoreConversation(activeProject.id, true)}
              unretained={conversationUnretainedEntry}
              unretainedMessage={conversationUnretainedEntry ? unretainedMessage(conversationUnretainedEntry.reason) : ''}
            />
          ) : (
            <section className="empty-state" aria-label="没有项目">
              <h2>还没有项目</h2>
              <p>
                新建项目后可以写下给团队的未发送文字；当前版本未接入模型，不能发送。
                项目名称、简介与计划在左侧“项目设置”里编辑。
              </p>
              <button type="button" className="primary" onClick={createProject}>
                新建项目
              </button>
            </section>
          )
        )}

        {page === 'settings' && (
          activeProject ? (
            <div className="page-scroll settings-page">
              <p className="page-lead">
                项目设置承载名称、简介与项目计划；对话输入与未发送文字不在这里，
                保存设置不会提交或清空对话文字。
              </p>
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
            </div>
          ) : (
            <section className="empty-state" aria-label="没有项目">
              <h2>还没有项目</h2>
              <p>
                取消新建后可以停在这里，再新建一个项目并从这里命名、保存或取消。
                不会自动创建替代项目，也不会改动磁盘上的其他内容。
              </p>
              <button type="button" className="primary" onClick={createProject}>
                新建项目
              </button>
            </section>
          )
        )}

        {page === 'team' && (
          <div className="page-scroll">
            {teamState?.status === 'unsaved' && <p className="role-settings-hint">先保存当前项目信息，即可编辑本项目的角色设置。</p>}
            {teamState?.status === 'loading' && <p className="role-settings-hint" role="status">正在读取本项目角色设置…</p>}
            {teamState?.status === 'error' && <p className="save-error" role="alert">角色设置读取失败：{teamState.error.message}。目前仅显示初始模板参考，已停止角色写入；项目计划仍可使用。</p>}
            {teamState?.notice && <p className="role-settings-hint" role="status">{teamState.notice}</p>}
            <p className="page-lead">
              团队页展示当前项目的角色位、只读组织关系与手动角色设置；这里不产生调度或运行记录。
            </p>
            <TeamBoard roles={visibleTeam} activeRoleId={roleId} onSelect={selectRole} />
          </div>
        )}

        {page === 'workflow' && (
          <div className="page-scroll">
            <p className="page-lead">
              流程页只展示冻结的阶段顺序模板，整体“未运行”；没有真实执行记录、耗时或费用。
            </p>
            <WorkflowTemplate />
          </div>
        )}

        <footer className="board-foot">
          <span>
            {page === 'team'
              ? dockedDynamics
                ? '团队动态暂用右侧辅助区；收起后回到角色详情。'
                : '点击任意角色卡，在右侧查看详情。'
              : page === 'workflow'
                ? '阶段卡片只展开说明，不代表任何执行。'
                : page === 'settings'
                  ? '项目设置只写正式工作区文件；对话输入独立保留，不会随设置保存。'
                  : '对话输入只保留本机未发送文字，不发送、不生成回复。'}
          </span>
          <span>初始模板来自 desktop/src/data/team.js；角色设置仅影响当前项目，不包含真实运行记录。</span>
        </footer>
      </main>

      {showRoleDetail && (
        <RoleDetail
          role={role}
          onClear={() => selectRole(null)}
          canEdit={teamProjectSaved && teamState?.projectId === teamProjectId && teamState?.status === 'ready'}
          editor={teamState?.editor}
          notice={teamState?.editor ? teamState.notice : null}
          noticeSeq={teamState?.noticeSeq ?? 0}
          onEdit={() => teamControllerRef.current.edit(roleId)}
          onFieldChange={(field, value) => teamControllerRef.current.update(field, value)}
          onSave={() => teamControllerRef.current.save()}
          onCancel={() => teamControllerRef.current.cancel()}
        />
      )}

      {dockedDynamics && (
        <TeamDynamics
          mode="docked"
          roles={visibleTeam}
          onCollapse={() => setDynamics('hidden')}
          onToggleMode={toggleDynamicsMode}
          panelRef={dynamicsPanelRef}
        />
      )}

      {dynamics === 'floating' && (
        <TeamDynamics
          mode="floating"
          roles={visibleTeam}
          onCollapse={() => setDynamics('hidden')}
          onToggleMode={toggleDynamicsMode}
          panelRef={dynamicsPanelRef}
        />
      )}
      </div>

      {closeIssue && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal close-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="close-issue-title"
            aria-describedby="close-issue-detail"
            ref={closeDialogRef}
            onKeyDown={handleDialogKeyDown}
          >
            <div className="modal-head">
              <h2 id="close-issue-title">
                {closeIssue.roleIssue
                  ? '先处理角色设置'
                  : closeIssue.timedOut
                    ? '关闭请求已超时'
                    : '备份没有完成'}
              </h2>
              <button
                type="button"
                className="modal-close"
                aria-label="返回继续编辑"
                onClick={() => setCloseIssue(null)}
              >
                ×
              </button>
            </div>
            <p id="close-issue-detail" className="modal-lead">
              {closeIssue.roleIssue
                ? '角色设置还没有保存。返回后可以保存，或取消编辑，再关闭窗口。'
                : closeIssue.timedOut
                  ? '备份超过 2 秒仍未完成，这次关闭请求已经作废；迟到的确认不会再关闭窗口。'
                  : '关闭前需要把最新编辑写进 recovery.json，这次没有成功。'}
            </p>
            {!closeIssue.roleIssue && closeIssue.message && (
              <details className="modal-diagnostics">
                <summary>查看备份诊断</summary>
                <p className="load-error-code">{closeIssue.message}</p>
              </details>
            )}
            <p className="modal-warning">
              {closeIssue.roleIssue
                ? '仍然关闭会放弃未保存的角色改动，也可能丢失尚未备份的项目草稿。'
                : '仍然关闭会丢失尚未备份的编辑。'}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="primary"
                ref={closeSafeActionRef}
                onClick={() => setCloseIssue(null)}
              >
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
            <p className="modal-hint">Esc 或 × 只返回编辑，不会关闭窗口。</p>
          </section>
        </div>
      )}
    </>
  )
}
