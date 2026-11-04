// 恢复稿协调：只负责“什么时候备份、按什么顺序写、什么时候清”，不直接碰文件。
//
// 文件读写由主进程的 recovery-store 完成；这里用 per-project revision 与 generation
// 挡住迟到写入，并把“备份中 / 已备份 / 备份失败”反馈给界面。定时器可注入，
// 测试里能同步推进防抖，不需要在生产代码里加延迟。
export const RECOVERY_DEBOUNCE_MS = 400
const MAX_FLUSH_PASSES = 3
const MAX_PERSIST_ATTEMPTS = 4

function normalizeError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return { code: error.code ?? 'RECOVERY_FAILED', message: String(error.message) }
  }
  return { code: 'RECOVERY_FAILED', message: String(error ?? '未知错误') }
}

function pick(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    taskDraft: project.taskDraft,
  }
}

function sameFields(left, right) {
  if (!left || !right) return false
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.description === right.description &&
    left.taskDraft === right.taskDraft
  )
}

/**
 * @param {{
 *   save: (snapshot: object) => Promise<{ok: boolean, entry?: object, error?: object}>,
 *   discard: (request: {projectId: string, revision: number}) => Promise<{ok: boolean, removed?: boolean, error?: object}>,
 *   onStatus?: (projectId: string, status: object) => void,
 *   debounceMs?: number,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 * }} options
 */
export function createRecoveryDrafts({
  save,
  discard,
  onStatus = () => {},
  debounceMs = RECOVERY_DEBOUNCE_MS,
  timers,
} = {}) {
  if (typeof save !== 'function' || typeof discard !== 'function') {
    throw new TypeError('save 与 discard 必须是函数')
  }
  const clock = timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  }
  if (typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
    throw new TypeError('timers 必须提供 setTimeout 与 clearTimeout')
  }

  const projects = new Map()
  let loadFailure = null
  let disposed = false

  function ensure(projectId) {
    let state = projects.get(projectId)
    if (!state) {
      state = {
        revision: 0,
        snapshot: null,
        timer: null,
        pending: false,
        inFlight: null,
        abandoned: false,
        generation: 0,
        lastError: null,
      }
      projects.set(projectId, state)
    }
    return state
  }

  function emit(projectId, value) {
    onStatus(projectId, value)
  }

  function clearTimer(state) {
    if (state.timer) {
      clock.clearTimeout(state.timer)
      state.timer = null
    }
  }

  /** 载入磁盘上已有的恢复稿：只建立基线，不触发任何写入。 */
  function reset(entries = []) {
    projects.clear()
    for (const entry of entries) {
      projects.set(entry.id, {
        revision: entry.revision,
        snapshot: pick(entry),
        timer: null,
        pending: false,
        inFlight: null,
        abandoned: false,
        generation: 0,
        lastError: null,
      })
      emit(entry.id, { kind: 'saved', backedUpAt: entry.updatedAt })
    }
  }

  /** 恢复稿文件损坏或读不出来：停止备份，但正式保存仍按自己的规则继续。 */
  function markLoadFailure(error) {
    loadFailure = normalizeError(error)
    for (const state of projects.values()) clearTimer(state)
  }

  function noteEdit(project) {
    if (disposed || loadFailure || !project?.id) return
    const state = ensure(project.id)
    state.snapshot = pick(project)
    state.pending = true
    state.generation += 1
    emit(project.id, { kind: 'saving' })
    clearTimer(state)
    state.timer = clock.setTimeout(() => {
      state.timer = null
      void persistLoop(project.id)
    }, debounceMs)
  }

  async function persistOnce(projectId) {
    const state = projects.get(projectId)
    if (!state || !state.pending || state.abandoned) return { ok: true, skipped: true }
    const revision = state.revision + 1
    const snapshot = { ...state.snapshot, revision }
    const generation = state.generation
    state.pending = false
    emit(projectId, { kind: 'saving' })

    let result
    try {
      result = await save(snapshot)
    } catch (error) {
      result = { ok: false, error: normalizeError(error) }
    }

    if (!result?.ok) {
      state.pending = true
      state.lastError = result?.error ?? normalizeError('恢复稿写入失败')
      emit(projectId, {
        kind: 'failed',
        message: state.lastError.message,
        code: state.lastError.code,
      })
      return { ok: false, error: state.lastError }
    }

    state.revision = revision
    state.lastError = null
    // 写入期间又有新编辑：保持待备份，等下一轮写入，不要把“已备份”说早了。
    if (state.generation === generation) {
      state.pending = false
      emit(projectId, { kind: 'saved', backedUpAt: result.entry?.updatedAt ?? null })
    }
    return { ok: true }
  }

  function persist(projectId) {
    const state = projects.get(projectId)
    if (!state || state.abandoned) return Promise.resolve({ ok: true, skipped: true })
    if (state.inFlight) return state.inFlight
    const run = persistOnce(projectId)
    state.inFlight = run
    run
      .finally(() => {
        if (state.inFlight === run) state.inFlight = null
      })
      .catch(() => {})
    return run
  }

  async function persistLoop(projectId) {
    for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt += 1) {
      const state = projects.get(projectId)
      if (!state || state.abandoned) return { ok: true }
      if (state.inFlight) {
        await state.inFlight.catch(() => {})
        continue
      }
      if (!state.pending) return { ok: true }
      const result = await persist(projectId)
      if (!result.ok) return result
    }
    return {
      ok: false,
      error: { code: 'RECOVERY_BUSY', message: '恢复稿仍在写入，请稍后再试' },
    }
  }

  /** 关闭窗口前调用：取消防抖，写完所有待备份内容；失败如实返回。 */
  async function flush() {
    for (const state of projects.values()) clearTimer(state)
    const errors = new Map()
    // 每个项目只在本轮 flush 里尝试一次：失败就如实返回，不在关闭路径上无限重试。
    const attempted = new Set()
    for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
      let busy = false
      for (const [projectId, state] of projects) {
        if (state.inFlight) {
          busy = true
          const result = await state.inFlight.catch(() => null)
          if (result && !result.ok) errors.set(projectId, result.error)
        }
        if (state.pending && !state.abandoned && !attempted.has(projectId)) {
          attempted.add(projectId)
          const result = await persistLoop(projectId)
          if (!result.ok) errors.set(projectId, result.error)
        }
      }
      if (!busy) break
    }
    return {
      ok: errors.size === 0,
      errors: [...errors].map(([projectId, error]) => ({ projectId, error })),
    }
  }

  /** 放弃 / 取消：先等在途写入落定，再用更高的 revision 删除，迟到写入会被墓碑挡住。 */
  async function discardProject(projectId) {
    const state = projects.get(projectId)
    if (state) {
      clearTimer(state)
      state.pending = false
      state.abandoned = true
    }
    if (state?.inFlight) await state.inFlight.catch(() => {})

    const revision = (state?.revision ?? 0) + 1
    let result
    try {
      result = await discard({ projectId, revision })
    } catch (error) {
      result = { ok: false, error: normalizeError(error) }
    }

    if (!result?.ok) {
      const error = result?.error ?? normalizeError('无法删除恢复稿')
      if (state) {
        state.abandoned = false
        state.pending = true
        state.lastError = error
        emit(projectId, { kind: 'failed', message: error.message, code: error.code })
      }
      return { ok: false, error }
    }

    projects.delete(projectId)
    emit(projectId, { kind: 'idle' })
    return { ok: true, removed: Boolean(result.removed) }
  }

  /**
   * 正式保存成功后调用：只有“恢复稿内容正好等于刚保存的内容，且没有更新的编辑”
   * 才删除；保存期间继续输入的内容必须保留恢复能力。
   */
  function clearCovered(projectId, savedProject) {
    const state = projects.get(projectId)
    if (!state) return Promise.resolve({ ok: true, cleared: false })
    if (state.pending || state.inFlight) {
      return Promise.resolve({ ok: true, cleared: false, reason: 'newer-edits' })
    }
    if (!state.snapshot || !sameFields(state.snapshot, savedProject)) {
      return Promise.resolve({ ok: true, cleared: false, reason: 'newer-edits' })
    }
    return discardProject(projectId).then((result) => ({
      ...result,
      cleared: result.ok,
    }))
  }

  function hasPending() {
    return [...projects.values()].some((state) => state.pending || Boolean(state.inFlight))
  }

  function dispose() {
    disposed = true
    for (const state of projects.values()) clearTimer(state)
  }

  return Object.freeze({
    reset,
    markLoadFailure,
    noteEdit,
    flush,
    discard: discardProject,
    clearCovered,
    hasPending,
    dispose,
  })
}
