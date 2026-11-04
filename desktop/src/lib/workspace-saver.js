// 保存协调：把“构造 payload、调用保存、更新 baseline”收在一处，界面只负责展示状态。
//
// baseline 是最近一次成功读取或保存的工作区。它必须随保存完成同步更新：
// 如果只等 React 重新渲染后再取 baseline，用户在上一次保存返回后立刻保存另一个项目，
// 就可能拿着过期快照把旧内容写回去。

import { buildSavePayload, cloneSession } from './workspace-editing.js'

/**
 * @param {object} options
 * @param {(payload: object) => Promise<object|undefined>} options.save
 * @param {(projectId: string) => void} [options.onStart]
 * @param {(result: object, projectId: string) => void} [options.onSaved]
 * @param {(error: {code: string, message: string}, projectId: string) => void} [options.onFailed]
 * @param {(projectId: string) => void} [options.onFinish]
 */
export function createWorkspaceSaver({ save, onStart, onSaved, onFailed, onFinish } = {}) {
  let baseline = null
  let inFlight = false

  function reset(workspace) {
    baseline = workspace ? cloneSession(workspace) : null
    inFlight = false
  }

  async function persist(session, project) {
    // 同步防重入：这一行在第一次 await 之前执行，因此连续点击或切换项目后立刻保存，
    // 都不会拿到第二份快照；不能只依赖按钮重新渲染后的 disabled。
    if (inFlight) return { status: 'busy' }
    if (!baseline || !session || !project) return { status: 'unavailable' }

    const payload = buildSavePayload(session, baseline)
    inFlight = true
    onStart?.(project.id)
    try {
      const result = await save(payload)
      if (result?.ok) {
        baseline = cloneSession(result.workspace)
        onSaved?.(result, project.id)
        return { status: 'saved', result }
      }
      const error = result?.error ?? {
        code: 'SAVE_REJECTED',
        message: '保存请求被拒绝。',
      }
      onFailed?.(error, project.id)
      return { status: 'failed', error }
    } catch (error) {
      const info = {
        code: error?.code ?? 'SAVE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }
      onFailed?.(info, project.id)
      return { status: 'failed', error: info }
    } finally {
      inFlight = false
      onFinish?.(project.id)
    }
  }

  return {
    getBaseline: () => baseline,
    isSaving: () => inFlight,
    reset,
    save: persist,
  }
}
