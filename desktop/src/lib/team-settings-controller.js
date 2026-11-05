// Small state owner for one visible project's role form; async replies are bound to project/request identity.
import { mergeTeamRoles, roleToDraft, draftToRoleSetting, isRoleDraftDirty, validateRoleSetting, TeamSettingsError, ROLE_DRAFT_FIELDS } from './team-settings.js'

const errorInfo = (error) => ({ code: error?.code ?? 'TEAM_SETTINGS_FAILED', message: error?.message ?? '角色设置操作失败' })

// Used by the real close-request handler both before and after the project-draft flush.
// It must abort promptly instead of waiting for a role save or the user's decision.
export async function abortRoleCloseIfNeeded({ controller, requestId, confirmClose, onBlocked }) {
  const problem = controller.closeBlocker()
  if (!problem) return false
  onBlocked(problem)
  try { await confirmClose({ requestId, ok: false, error: problem }) } catch { /* Keep the visible prompt if the bridge is unavailable. */ }
  return true
}

export function createTeamSettingsController({ load, save, onChange = () => {} }) {
  let request = 0
  let inFlight = false
  let state = { projectId: null, status: 'unsaved', roles: mergeTeamRoles(), editor: null, error: null, notice: '', savedAt: null }
  function emit(patch) { state = { ...state, ...patch }; onChange(state) }
  function closeBlocker() {
    if (inFlight) return { code: 'ROLE_SAVE_PENDING', message: '角色设置正在保存，请等待保存完成后再关闭窗口' }
    if (state.editor && isRoleDraftDirty(state.editor.draft, state.editor.original)) return { code: 'ROLE_UNSAVED', message: '角色设置尚未保存，请先保存角色设置或取消编辑' }
    return null
  }
  function mayLeave() {
    const blocked = closeBlocker()
    if (blocked) { emit({ notice: blocked.message }); return false }
    return true
  }
  async function selectProject(projectId, saved) {
    if (!mayLeave()) return { status: 'blocked' }
    const identity = ++request
    emit({ projectId, status: saved ? 'loading' : 'unsaved', roles: mergeTeamRoles(), editor: null, error: null, notice: '', savedAt: null })
    if (!saved || !projectId) return { status: 'unsaved' }
    let result
    try { result = await load(projectId) } catch (error) { result = { ok: false, error: errorInfo(error) } }
    if (identity !== request || state.projectId !== projectId) return { status: 'stale' }
    if (!result?.ok) { emit({ status: 'error', error: errorInfo(result?.error) }); return { status: 'error' } }
    try { emit({ status: 'ready', roles: mergeTeamRoles(result.settings), savedAt: result.savedAt ?? null }) }
    catch (error) { emit({ status: 'error', error: errorInfo(error) }); return { status: 'error' } }
    return { status: 'ready' }
  }
  function edit(roleId) {
    if (!mayLeave()) return false
    const role = state.roles.find((entry) => entry.id === roleId)
    if (state.status !== 'ready' || role?.kind !== 'agent') return false
    const original = roleToDraft(role)
    emit({ editor: { projectId: state.projectId, draft: { ...original }, original, busy: false, error: null }, notice: '' })
    return true
  }
  function update(field, value) {
    if (!state.editor || inFlight || !ROLE_DRAFT_FIELDS.includes(field) || typeof value !== 'string') return
    emit({ editor: { ...state.editor, draft: { ...state.editor.draft, [field]: value }, error: null }, notice: '' })
  }
  function cancel() {
    if (inFlight) return false
    emit({ editor: null, notice: '' })
    return true
  }
  async function persist() {
    if (inFlight) return { status: 'busy' }
    if (!state.editor) return { status: 'idle' }
    let setting
    try { setting = draftToRoleSetting(state.editor.draft) }
    catch (error) { emit({ editor: { ...state.editor, error: errorInfo(error) } }); return { status: 'invalid' } }
    const projectId = state.editor.projectId
    const roleId = setting.roleId
    inFlight = true
    emit({ editor: { ...state.editor, busy: true, error: null } })
    try {
      const result = await save(projectId, setting)
      if (!result?.ok) throw result?.error ?? new Error('角色设置没有保存成功')
      if (state.projectId !== projectId || state.editor?.draft.roleId !== roleId) return { status: 'stale' }
      let savedSetting
      try { savedSetting = validateRoleSetting(result.setting) } catch (error) {
        throw new TeamSettingsError('INVALID_RESPONSE', `保存返回的角色设置不完整：${error?.message ?? '格式不符'}。表单已保留，请重试。`)
      }
      if (savedSetting.roleId !== roleId) {
        throw new TeamSettingsError('ROLE_RESPONSE_MISMATCH', '保存返回的角色与请求不一致，表单已保留，请重试。')
      }
      // Merge only the saved role; do not replace another role with a form's older baseline.
      const overrides = state.roles.filter((role) => role.kind === 'agent').map((role) => role.id === roleId ? savedSetting : draftToRoleSetting(roleToDraft(role)))
      emit({ roles: mergeTeamRoles(overrides), editor: null, notice: '角色设置已保存；模型仍未连接', savedAt: result.savedAt ?? null })
      return { status: 'saved' }
    } catch (error) {
      if (state.projectId === projectId && state.editor?.draft.roleId === roleId) emit({ editor: { ...state.editor, busy: false, error: errorInfo(error) } })
      return { status: 'failed' }
    } finally { inFlight = false }
  }
  return Object.freeze({ getState: () => state, selectProject, edit, update, cancel, save: persist, mayLeave, closeBlocker })
}
