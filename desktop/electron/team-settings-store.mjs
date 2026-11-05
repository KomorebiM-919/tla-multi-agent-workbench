// Per-project role overrides. Writes only this file, never workspace/recovery or provider settings.
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { TEAM_SCHEMA_VERSION, TEAM_MAX_FILE_BYTES, TeamSettingsError, validateRoleSetting, validateTeamDocument, validateTeamProjectId } from '../src/lib/team-settings.js'

export function resolveTeamSettingsFilePath(desktopRoot) {
  return path.resolve(desktopRoot, '..', '.local', 'tla-desktop', 'team-settings.json')
}

export function createTeamSettingsStore({ filePath, loadWorkspace }) {
  if (typeof filePath !== 'string' || !filePath || typeof loadWorkspace !== 'function') throw new TypeError('角色存储需要固定路径和正式工作区读取接口')
  const fixedPath = path.resolve(filePath)
  let queue = Promise.resolve()
  const failure = (code, message) => new TeamSettingsError(code, message)

  async function assertSavedProject(projectId) {
    validateTeamProjectId(projectId)
    const loaded = await loadWorkspace()
    if (loaded.source !== 'file' || !loaded.workspace.projects.some((project) => project.id === projectId)) {
      throw failure('PROJECT_NOT_SAVED', '请先正式保存项目信息，再配置角色')
    }
  }

  async function readDocument() {
    let info
    try { info = await stat(fixedPath) }
    catch (error) {
      if (error.code === 'ENOENT') return { document: { schemaVersion: TEAM_SCHEMA_VERSION, projects: [] }, source: 'default', savedAt: null }
      throw failure('READ_FAILED', '无法读取角色设置文件')
    }
    if (!info.isFile()) throw failure('READ_FAILED', '角色设置路径不是普通文件')
    if (info.size > TEAM_MAX_FILE_BYTES) throw failure('TOO_LARGE', '角色设置文件超过512KiB上限')
    let raw
    try { raw = await readFile(fixedPath) }
    catch { throw failure('READ_FAILED', '无法读取角色设置文件') }
    if (raw.length > TEAM_MAX_FILE_BYTES) throw failure('TOO_LARGE', '角色设置文件超过512KiB上限')
    let value
    try { value = JSON.parse(raw.toString('utf8')) }
    catch { throw failure('CORRUPT_FILE', '角色设置不是合法JSON；已停止角色写入，原文件保留') }
    return { document: validateTeamDocument(value), source: 'file', savedAt: info.mtime.toISOString() }
  }

  async function load(projectId) {
    await assertSavedProject(projectId)
    const { document, source, savedAt } = await readDocument()
    const settings = document.projects.find((project) => project.projectId === projectId)?.roles ?? []
    return { settings, source, savedAt }
  }

  async function saveOnce(projectId, input) {
    const setting = validateRoleSetting(input)
    await assertSavedProject(projectId)
    // Read the latest document inside the queue; a renderer cannot overwrite another role with a stale whole-file snapshot.
    const { document } = await readDocument()
    const existing = document.projects.find((project) => project.projectId === projectId)
    const roles = existing ? existing.roles.filter((role) => role.roleId !== setting.roleId) : []
    roles.push(setting)
    const updated = { projectId, roles }
    const projects = existing ? document.projects.map((project) => project.projectId === projectId ? updated : project) : [...document.projects, updated]
    const payload = Buffer.from(`${JSON.stringify(validateTeamDocument({ schemaVersion: TEAM_SCHEMA_VERSION, projects }), null, 2)}\n`, 'utf8')
    if (payload.length > TEAM_MAX_FILE_BYTES) throw failure('TOO_LARGE', '角色设置总大小超过512KiB；未覆盖原文件')
    const directory = path.dirname(fixedPath)
    const temporary = path.join(directory, `.${path.basename(fixedPath)}.${randomUUID()}.tmp`)
    let handle
    try {
      await mkdir(directory, { recursive: true })
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(payload)
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporary, fixedPath)
    } catch { throw failure('WRITE_FAILED', '角色设置保存失败，原设置保留；可以重试') }
    finally {
      if (handle) await handle.close().catch(() => {})
      await rm(temporary, { force: true }).catch(() => {})
    }
    return { setting, savedAt: new Date().toISOString() }
  }

  function saveRole(projectId, input) {
    let snapshot
    try { snapshot = structuredClone(input) }
    catch { return Promise.reject(failure('INVALID_INPUT', '角色设置不是可读取的数据')) }
    const run = () => saveOnce(projectId, snapshot)
    const result = queue.then(run, run)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  return Object.freeze({ filePath: fixedPath, load, saveRole })
}
