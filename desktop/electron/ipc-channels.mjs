// 主进程与预加载脚本共用的 IPC 白名单。
// 只允许这些通道存在；新增通道必须同时更新 tests/ipc-channels.test.mjs，
// 避免渲染层靠拼字符串拿到未审查的通道。
export const IPC_CHANNELS = Object.freeze({
  APP_INFO: 'tla:app-info',
  WORKSPACE_LOAD: 'tla:workspace-load',
  WORKSPACE_SAVE: 'tla:workspace-save',
  RECOVERY_LOAD: 'tla:recovery-load',
  RECOVERY_SAVE: 'tla:recovery-save',
  RECOVERY_DISCARD: 'tla:recovery-discard',
  TEAM_LOAD: 'tla:team-load',
  TEAM_SAVE_ROLE: 'tla:team-save-role',
  CLOSE_CONFIRM: 'tla:close-confirm',
  CLOSE_FORCE: 'tla:close-force',
  // 主进程 → 渲染层的关闭请求与超时提示；不注册 handler，只作为事件通道。
  CLOSE_REQUEST: 'tla:close-request',
  CLOSE_TIMEOUT: 'tla:close-timeout',
})

/** 主进程实际注册 handler 的通道（不含事件通道）。 */
const EVENT_CHANNELS = new Set([IPC_CHANNELS.CLOSE_REQUEST, IPC_CHANNELS.CLOSE_TIMEOUT])

export const IPC_CHANNEL_LIST = Object.freeze(
  Object.values(IPC_CHANNELS).filter((channel) => !EVENT_CHANNELS.has(channel)),
)

/** 允许由主进程主动发送到渲染层的事件通道。 */
export const IPC_EVENT_CHANNELS = Object.freeze([...EVENT_CHANNELS])
