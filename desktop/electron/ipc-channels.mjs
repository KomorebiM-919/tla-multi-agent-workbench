// 主进程与预加载脚本共用的 IPC 白名单。
// 只允许这些通道存在；新增通道必须同时更新 tests/ipc-channels.test.mjs，
// 避免渲染层靠拼字符串拿到未审查的通道。
export const IPC_CHANNELS = Object.freeze({
  APP_INFO: 'tla:app-info',
  WORKSPACE_LOAD: 'tla:workspace-load',
  WORKSPACE_SAVE: 'tla:workspace-save',
})

export const IPC_CHANNEL_LIST = Object.freeze(Object.values(IPC_CHANNELS))
