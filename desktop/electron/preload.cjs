// 预加载脚本：沙箱模式下运行，只允许 require('electron')。
// 对外只暴露一个冻结的窄接口：版本信息、本地工作区的读取/保存、恢复稿读写，
// 以及一个受控的关闭请求监听。渲染层拿不到 ipcRenderer 本体，也不能自己拼路径。
const { contextBridge, ipcRenderer } = require('electron')

// 与 electron/ipc-channels.mjs 保持一致（沙箱预加载不能引用 ESM 模块）。
const APP_INFO_CHANNEL = 'tla:app-info'
const WORKSPACE_LOAD_CHANNEL = 'tla:workspace-load'
const WORKSPACE_SAVE_CHANNEL = 'tla:workspace-save'
const RECOVERY_LOAD_CHANNEL = 'tla:recovery-load'
const RECOVERY_SAVE_CHANNEL = 'tla:recovery-save'
const RECOVERY_DISCARD_CHANNEL = 'tla:recovery-discard'
const TEAM_LOAD_CHANNEL = 'tla:team-load'
const TEAM_SAVE_ROLE_CHANNEL = 'tla:team-save-role'
const CLOSE_REQUEST_CHANNEL = 'tla:close-request'
const CLOSE_TIMEOUT_CHANNEL = 'tla:close-timeout'
const CLOSE_CONFIRM_CHANNEL = 'tla:close-confirm'
const CLOSE_FORCE_CHANNEL = 'tla:close-force'

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  loadWorkspace: () => ipcRenderer.invoke(WORKSPACE_LOAD_CHANNEL),
  saveWorkspace: (workspace) => ipcRenderer.invoke(WORKSPACE_SAVE_CHANNEL, workspace),
  loadRecovery: () => ipcRenderer.invoke(RECOVERY_LOAD_CHANNEL),
  saveRecovery: (snapshot) => ipcRenderer.invoke(RECOVERY_SAVE_CHANNEL, snapshot),
  discardRecovery: (request) => ipcRenderer.invoke(RECOVERY_DISCARD_CHANNEL, request),
  loadTeamSettings: (projectId) => ipcRenderer.invoke(TEAM_LOAD_CHANNEL, projectId),
  saveRoleSettings: (projectId, setting) => ipcRenderer.invoke(TEAM_SAVE_ROLE_CHANNEL, projectId, setting),
  // 只订阅关闭请求与超时这两个事件，不暴露通用 on/send。
  onCloseRequest: (callback) => subscribe(CLOSE_REQUEST_CHANNEL, callback),
  onCloseTimeout: (callback) => subscribe(CLOSE_TIMEOUT_CHANNEL, callback),
  confirmClose: (result) => ipcRenderer.invoke(CLOSE_CONFIRM_CHANNEL, result),
  forceClose: () => ipcRenderer.invoke(CLOSE_FORCE_CHANNEL),
})

contextBridge.exposeInMainWorld('tla', api)
