// 未发送文字的协调：只负责“什么时候写、按什么顺序写、什么时候取消”，不直接碰文件。
//
// 文件读写由主进程的 conversation-drafts-store 完成；这里用 per-project revision
// 与 generation 挡住迟到写入，并把“保留中 / 已保留 / 保留失败”反馈给界面。
// 定时器可注入，测试里能同步推进防抖，不需要在生产代码里加延迟。
export const CONVERSATION_DEBOUNCE_MS = 400
export const MAX_CONVERSATION_TEXT_LENGTH = 5000
const MAX_PERSIST_ATTEMPTS = 4

function normalizeError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return { code: error.code ?? 'CONVERSATION_FAILED', message: String(error.message) }
  }
  return { code: 'CONVERSATION_FAILED', message: String(error ?? '未知错误') }
}

/**
 * @param {{
 *   save: (draft: {projectId: string, text: string, revision: number}) => Promise<{ok: boolean, entry?: object, error?: object}>,
 *   discard: (request: {projectId: string, revision: number}) => Promise<{ok: boolean, removed?: boolean, error?: object}>,
 *   onStatus?: (projectId: string, status: object) => void,
 *   debounceMs?: number,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 * }} options
 */
export function createConversationDrafts({
  save,
  discard,
  onStatus = () => {},
  debounceMs = CONVERSATION_DEBOUNCE_MS,
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
        text: '',
        timer: null,
        pending: false,
        inFlight: null,
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

  /** 载入磁盘上已有的未发送文字：只建立基线，不触发任何写入。 */
  function reset(entries = []) {
    projects.clear()
    for (const entry of entries) {
      projects.set(entry.projectId, {
        revision: entry.revision,
        text: entry.text,
        timer: null,
        pending: false,
        inFlight: null,
        generation: 0,
        lastError: null,
      })
      emit(entry.projectId, { kind: 'saved', backedUpAt: entry.updatedAt })
    }
  }

  /** 文件损坏或读不出来：停止写入，避免用空集合覆盖原文件；其余页面仍可用。 */
  function markLoadFailure(error) {
    loadFailure = normalizeError(error)
    for (const state of projects.values()) clearTimer(state)
  }

  function scheduleBackup(projectId, state) {
    clearTimer(state)
    state.pending = true
    state.generation += 1
    emit(projectId, { kind: 'saving' })
    state.timer = clock.setTimeout(() => {
      state.timer = null
      void persistLoop(projectId)
    }, debounceMs)
  }

  function noteEdit(projectId, text) {
    if (disposed || loadFailure || typeof projectId !== 'string' || typeof text !== 'string') return
    const state = ensure(projectId)
    state.text = text
    scheduleBackup(projectId, state)
  }

  async function persistOnce(projectId) {
    const state = projects.get(projectId)
    if (!state || !state.pending) return { ok: true, skipped: true }
    const revision = state.revision + 1
    const draft = { projectId, text: state.text, revision }
    const generation = state.generation
    state.pending = false
    emit(projectId, { kind: 'saving' })

    let result
    try {
      result = await save(draft)
    } catch (error) {
      result = { ok: false, error: normalizeError(error) }
    }

    if (!result?.ok) {
      state.pending = true
      state.lastError = result?.error ?? normalizeError('未发送文字保留失败')
      emit(projectId, {
        kind: 'failed',
        message: state.lastError.message,
        code: state.lastError.code,
      })
      return { ok: false, error: state.lastError }
    }

    state.revision = revision
    state.lastError = null
    // 写入期间又有新输入：保持待写入，等下一轮，不要把“已保留”说早了。
    if (state.generation === generation) {
      state.pending = false
      emit(projectId, { kind: 'saved', backedUpAt: result.entry?.updatedAt ?? null })
    }
    return { ok: true }
  }

  function persist(projectId) {
    const state = projects.get(projectId)
    if (!state) return Promise.resolve({ ok: true, skipped: true })
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
      if (!state) return { ok: true }
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
      error: { code: 'CONVERSATION_BUSY', message: '未发送文字仍在保留，请稍后再试' },
    }
  }

  /** 关闭窗口前调用：取消防抖，写完所有待保留文字；失败如实返回。 */
  async function flush() {
    for (const state of projects.values()) clearTimer(state)
    const errors = new Map()
    for (const [projectId, state] of projects) {
      // 每个项目在本次 flush 内只串行尝试；失败立即记录并停止，
      // 也只有“写入成功后又有新输入”才继续下一轮。
      for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt += 1) {
        if (state.inFlight) await state.inFlight.catch(() => {})
        if (!state.pending) break
        const result = await persistLoop(projectId)
        if (!result.ok) {
          errors.set(projectId, result.error)
          break
        }
      }
    }
    for (const [projectId, state] of projects) {
      if ((state.pending || state.inFlight) && !errors.has(projectId)) {
        // 只有最新文字确实落盘，flush 才能报告成功。
        errors.set(projectId, {
          code: 'CONVERSATION_PENDING',
          message: '最新未发送文字还没有保留完成。',
        })
      }
    }
    return {
      ok: errors.size === 0,
      errors: [...errors].map(([projectId, error]) => ({ projectId, error })),
    }
  }

  /** 取消新建：先等在途写入落定，再用更高的 revision 删除，迟到写入会被墓碑挡住。 */
  async function discardProject(projectId) {
    const state = projects.get(projectId)
    if (state) {
      clearTimer(state)
      state.pending = false
    }
    if (state?.inFlight) await state.inFlight.catch(() => {})

    // 从来没有输入过的项目没有协调状态，也要能取消；版本从 0 起算，同样高于墓碑水位。
    const revision = (state?.revision ?? 0) + 1
    let result
    try {
      result = await discard({ projectId, revision })
    } catch (error) {
      result = { ok: false, error: normalizeError(error) }
    }

    if (!result?.ok) {
      const error = result?.error ?? normalizeError('无法取消未发送文字')
      if (state) {
        state.pending = true
        state.lastError = error
        emit(projectId, { kind: 'failed', message: error.message, code: error.code })
      }
      return { ok: false, error }
    }

    // 保留 revision 连续性：主进程的墓碑水位不会后退，下一次输入必须用更高的版本号，
    // 否则会被当成迟到写入拒绝。
    if (state) {
      state.revision = Math.max(state.revision, revision)
      state.pending = false
      state.lastError = null
      emit(projectId, { kind: 'idle' })
    }
    return { ok: true, removed: Boolean(result.removed) }
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
    hasPending,
    dispose,
  })
}
