// Pure data contract shared by the main process and renderer; no file or network access.
import { ROLES } from '../data/team.js'

export const TEAM_SCHEMA_VERSION = 1
export const TEAM_MAX_PROJECTS = 20
export const TEAM_MAX_FILE_BYTES = 512 * 1024
export const ROLE_LIMITS = Object.freeze({ name: 60, badge: 20, summary: 500, duty: 2000, provider: 80, model: 160 })
export const EDITABLE_ROLE_IDS = Object.freeze(ROLES.filter((role) => role.kind === 'agent').map((role) => role.id))
const SETTING_FIELDS = ['roleId', 'name', 'badge', 'summary', 'duty', 'modelRef']
const DRAFT_FIELDS = ['name', 'badge', 'summary', 'duty', 'provider', 'model']
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const FIELD_LABELS = { name: '角色名称', badge: '定位', summary: '职责摘要', duty: '详细职责', provider: '供应商标签', model: '模型标识' }

export class TeamSettingsError extends Error {
  constructor(code, message) { super(message); this.name = 'TeamSettingsError'; this.code = code }
}

function invalid(message) { throw new TeamSettingsError('INVALID_INPUT', message) }
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}必须是对象`)
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(`${label}含有未知字段`)
}
function text(value, field, required, singleLine = false) {
  const label = FIELD_LABELS[field]
  if (typeof value !== 'string' || FORBIDDEN_CONTROLS.test(value)) invalid(`${label}必须是合法文字`)
  if (required && !value.trim()) invalid(`${label}不能为空`)
  if (singleLine && /[\r\n\t]/.test(value)) invalid(`${label}不能包含换行或制表符`)
  if (value.length > ROLE_LIMITS[field]) invalid(`${label}不能超过${ROLE_LIMITS[field]}字符`)
  return value
}

export function validateTeamProjectId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) invalid('项目ID不合法')
  return value
}

export function validateRoleSetting(value) {
  object(value, SETTING_FIELDS, '角色设置')
  if (!EDITABLE_ROLE_IDS.includes(value.roleId)) invalid('只能设置现有AI角色，不能修改人类总控制')
  let modelRef = null
  if (value.modelRef !== null) {
    object(value.modelRef, ['provider', 'model'], '模型标签')
    modelRef = { provider: text(value.modelRef.provider, 'provider', true, true), model: text(value.modelRef.model, 'model', true, true) }
  }
  return {
    roleId: value.roleId,
    name: text(value.name, 'name', true, true),
    badge: text(value.badge, 'badge', true, true),
    summary: text(value.summary, 'summary', false),
    duty: text(value.duty, 'duty', false),
    modelRef,
  }
}

export function validateTeamDocument(value) {
  object(value, ['schemaVersion', 'projects'], '团队设置文件')
  if (value.schemaVersion !== TEAM_SCHEMA_VERSION) throw new TeamSettingsError('UNSUPPORTED_VERSION', '不支持的角色设置文件版本')
  if (!Array.isArray(value.projects) || value.projects.length > TEAM_MAX_PROJECTS) invalid('角色设置项目数超限或格式不符')
  const ids = new Set()
  const projects = value.projects.map((project) => {
    object(project, ['projectId', 'roles'], '项目角色设置')
    const projectId = validateTeamProjectId(project.projectId)
    if (ids.has(projectId)) invalid('角色设置项目ID重复')
    ids.add(projectId)
    if (!Array.isArray(project.roles) || project.roles.length > EDITABLE_ROLE_IDS.length) invalid('角色数量超限或格式不符')
    const roles = project.roles.map(validateRoleSetting)
    if (new Set(roles.map((role) => role.roleId)).size !== roles.length) invalid('同项目角色ID重复')
    return { projectId, roles }
  })
  return { schemaVersion: TEAM_SCHEMA_VERSION, projects }
}

export function mergeTeamRoles(settings = []) {
  const byId = new Map(settings.map((setting) => {
    const checked = validateRoleSetting(setting)
    return [checked.roleId, checked]
  }))
  return ROLES.map((template) => {
    const setting = byId.get(template.id)
    if (!setting) return { ...template, modelRef: null }
    const { roleId: _roleId, ...fields } = setting
    return { ...template, ...fields, model: '未连接' }
  })
}

export function roleToDraft(role) {
  return { roleId: role.id, name: role.name, badge: role.badge, summary: role.summary, duty: role.duty, provider: role.modelRef?.provider ?? '', model: role.modelRef?.model ?? '' }
}

export function draftToRoleSetting(draft) {
  const bothEmpty = draft.provider.trim() === '' && draft.model.trim() === ''
  return validateRoleSetting({ roleId: draft.roleId, name: draft.name, badge: draft.badge, summary: draft.summary, duty: draft.duty, modelRef: bothEmpty ? null : { provider: draft.provider, model: draft.model } })
}

export function isRoleDraftDirty(draft, original) {
  return DRAFT_FIELDS.some((field) => draft[field] !== original[field])
}

export const ROLE_DRAFT_FIELDS = Object.freeze(DRAFT_FIELDS)
