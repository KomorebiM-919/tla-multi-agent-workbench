// 渲染层的工作区编辑模型：只处理普通对象，不碰 React 与 Electron，便于直接单测。
//
// 会话（session）= 当前窗口里正在编辑的副本；基线（baseline）= 最近一次成功读取或
// 保存的内容。切换项目只改 session.activeProjectId，因此未保存草稿会留在会话里，
// 直到用户点保存或重新打开应用。

export const SCHEMA_VERSION = 1
export const MAX_PROJECTS = 20
export const MAX_NAME_LENGTH = 60
export const MAX_DESCRIPTION_LENGTH = 500
export const MAX_TASK_DRAFT_LENGTH = 5000

const PROJECT_FIELDS = Object.freeze(['id', 'name', 'description', 'taskDraft'])

let idFallbackCounter = 0

function randomUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  idFallbackCounter += 1
  return `local-${Date.now().toString(36)}-${idFallbackCounter}`
}

/** 生成新的项目 ID：优先 UUID，字符集满足主进程的 ID 校验。 */
export function newProjectId() {
  return randomUuid()
}

function pickFields(project) {
  const picked = {}
  for (const field of PROJECT_FIELDS) picked[field] = project[field]
  return picked
}

/** 深拷贝一份工作区作为可编辑会话（只保留契约里的字段）。 */
export function cloneSession(workspace) {
  return {
    activeProjectId: workspace.activeProjectId,
    projects: workspace.projects.map((project) => pickFields(project)),
  }
}

/** 会话 → 提交给主进程的 payload（字段顺序固定，便于比较与日志）。 */
export function toWorkspacePayload(projects, activeProjectId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProjectId,
    projects: projects.map((project) => pickFields(project)),
  }
}

/** 新建一个只在本次会话里存在的草稿项目；默认名称在会话内保持可区分。 */
export function createDraftProject(existingProjects) {
  const usedNames = new Set(existingProjects.map((project) => project.name))
  let name = '新建项目'
  let index = 2
  while (usedNames.has(name)) {
    name = `新建项目 ${index}`
    index += 1
  }
  return { id: newProjectId(), name, description: '', taskDraft: '' }
}

/** 与基线逐字段比较；基线里没有这个项目（尚未保存过）时视为有未保存更改。 */
export function isProjectDirty(project, baselineProject) {
  if (!baselineProject) return true
  return PROJECT_FIELDS.every((field) => project[field] === baselineProject[field])
    ? false
    : true
}

export function dirtyProjectIds(session, baselineProjects) {
  const baselineById = new Map(baselineProjects.map((project) => [project.id, project]))
  return session.projects
    .filter((project) => isProjectDirty(project, baselineById.get(project.id)))
    .map((project) => project.id)
}

/** 状态优先级：保存中 > 保存失败 > 有未保存更改 > 尚未保存 > 已保存。 */
export function describeProjectStatus({ dirty, saveState }) {
  if (saveState?.kind === 'saving') return { tone: 'saving', label: '保存中' }
  if (saveState?.kind === 'failed') return { tone: 'failed', label: '保存失败' }
  if (dirty) return { tone: 'dirty', label: '未保存' }
  if (saveState?.kind === 'empty') return { tone: 'empty', label: '尚未保存' }
  return { tone: 'saved', label: '已保存' }
}

/** 与主进程一致的字段限制；用于输入框旁的计数与提示，不做静默截断。 */
export function projectFieldErrors(project) {
  const errors = {}
  if (project.name.trim() === '') {
    errors.name = '项目名称不能为空'
  } else if (project.name.length > MAX_NAME_LENGTH) {
    errors.name = `项目名称不能超过 ${MAX_NAME_LENGTH} 个字符（当前 ${project.name.length} 个）`
  }
  if (project.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `项目简介不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符（当前 ${project.description.length} 个）`
  }
  if (project.taskDraft.length > MAX_TASK_DRAFT_LENGTH) {
    errors.taskDraft = `任务草稿不能超过 ${MAX_TASK_DRAFT_LENGTH} 个字符（当前 ${project.taskDraft.length} 个）`
  }
  return errors
}
