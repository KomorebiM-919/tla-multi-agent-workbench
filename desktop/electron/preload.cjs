// 预加载脚本：沙箱模式下运行，只允许 require('electron')。
// 对外只暴露一个冻结的只读接口，渲染层拿不到 ipcRenderer 本体。
const { contextBridge, ipcRenderer } = require('electron')

// 与 electron/ipc-channels.mjs 的 APP_INFO 保持一致（沙箱预加载不能引用 ESM 模块）。
const APP_INFO_CHANNEL = 'tla:app-info'

const api = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
})

contextBridge.exposeInMainWorld('tla', api)
