// 恢复稿协调：只负责“什么时候备份、按什么顺序写、什么时候清”，不直接碰文件。
//
// 文件读写由主进程的 recovery-store 完成；这里用 per-project revision 与 generation
// 挡住迟到写入，并把“备份中 / 已备份 / 备份失败”反馈给界面。定时器可注入，
// 测试里能同步推进防抖，不需要在生产代码里加延迟。
export const RECOVERY_DEBOUNCE_MS = 400
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

  function noteEdit(project) {
    if (disposed || loadFailure || !project?.id) return
    const state = ensure(project.id)
    state.snapshot = pick(project)
    scheduleBackup(project.id, state)
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
    for (const [projectId, state] of projects) {
      if (state.abandoned) continue
      // 每个项目在本次 flush 内只串行尝试；失败立即记录并停止，绝不把失败当成可重试的挂起，
      // 也只有“写入成功后又有新编辑”才继续下一轮。
      for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt += 1) {
        if (state.abandoned) break
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
      if (state.abandoned) continue
      if (state.pending || state.inFlight) {
        // 只有最新内容确实落盘，flush 才能报告成功；否则关闭提示必须如实失败。
        if (!errors.has(projectId)) {
          errors.set(projectId, {
            code: 'RECOVERY_PENDING',
            message: '最新编辑还没有备份完成。',
          })
        }
      }
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

    // 从来没有编辑过的项目没有协调状态，也要能取消；版本从 0 起算，同样高于墓碑水位。
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

    // 保留 revision 连续性：主进程的墓碑水位不会后退，下一次备份必须用更高的版本号，
    // 否则新编辑会被当成迟到写入拒绝。这里只结束本次快照，不销毁项目状态。
    if (state) {
      state.revision = Math.max(state.revision, revision)
      state.pending = false
      state.abandoned = false
      state.lastError = null
      emit(projectId, { kind: 'idle' })
    }
    return { ok: true, removed: Boolean(result.removed) }
  }

  /**
   * 正式保存成功后调用：只有“恢复稿内容正好等于刚保存的内容”才清理。
   * 清理前取消尚未触发的防抖；清理期间用户继续输入的内容必须保留并重新备份，
   * 不能因为一次成功的清理就把新稿一起删掉。
   */
  async function clearCovered(projectId, savedProject) {
    const state = projects.get(projectId)
    if (!state || !state.snapshot || !sameFields(state.snapshot, savedProject)) {
      return { ok: true, cleared: false, reason: 'newer-edits' }
    }

    const captured = pick(state.snapshot)
    clearTimer(state)
    if (state.inFlight) await state.inFlight.catch(() => {})

    const revision = state.revision + 1
    let result
    try {
      result = await discard({ projectId, revision })
    } catch (error) {
      result = { ok: false, error: normalizeError(error) }
    }

    if (!result?.ok) {
      const error = result?.error ?? normalizeError('无法清理恢复稿')
      state.lastError = error
      state.pending = true
      emit(projectId, { kind: 'failed', message: error.message, code: error.code })
      return { ok: false, error }
    }

    state.revision = revision
    state.lastError = null

    if (sameFields(state.snapshot, captured)) {
      // 清理期间没有新输入：恢复稿已被正式文件覆盖，可以停在“无待备份”。
      state.pending = false
      state.snapshot = captured
      emit(projectId, { kind: 'idle' })
      return { ok: true, cleared: true }
    }

    // 清理期间又编辑了：新内容还没进正式文件，必须继续备份。
    scheduleBackup(projectId, state)
    return { ok: true, cleared: false, reason: 'newer-edits' }
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
