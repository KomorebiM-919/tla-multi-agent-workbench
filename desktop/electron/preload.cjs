// 预加载脚本：沙箱模式下运行，只允许 require('electron')。
// 对外只暴露一个冻结的窄接口：版本信息 + 本地工作区的读取/保存，
// 渲染层拿不到 ipcRenderer 本体，也不能自己拼路径或指定文件。
const { contextBridge, ipcRenderer } = require('electron')

// 与 electron/ipc-channels.mjs 保持一致（沙箱预加载不能引用 ESM 模块）。
const APP_INFO_CHANNEL = 'tla:app-info'
const WORKSPACE_LOAD_CHANNEL = 'tla:workspace-load'
const WORKSPACE_SAVE_CHANNEL = 'tla:workspace-save'

const api = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  loadWorkspace: () => ipcRenderer.invoke(WORKSPACE_LOAD_CHANNEL),
  saveWorkspace: (workspace) => ipcRenderer.invoke(WORKSPACE_SAVE_CHANNEL, workspace),
})

contextBridge.exposeInMainWorld('tla', api)
