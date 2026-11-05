/**
 * 布局切换的纯规则：让“右侧辅助列归谁”和“动态侧栏如何开合”可独立回归，
 * 不依赖 DOM 或窗口尺寸。
 */

export const DYNAMICS_STATES = Object.freeze(['hidden', 'docked', 'floating'])

/** 团队页且有选中角色时，角色详情占用辅助列；docked 动态复用同一列。 */
export function isRoleDetailVisible({ page, roleId, dynamics }) {
  return page === 'team' && Boolean(roleId) && dynamics !== 'docked'
}

/** 侧栏与浮窗是同一个面板的两种投影，切换不改变任何任务状态。 */
export function nextDynamicsMode(current) {
  return current === 'docked' ? 'floating' : 'docked'
}

/**
 * 点“团队动态”：收起始终允许；打开 docked 会暂时取代角色详情，
 * 因此必须先通过角色编辑器的离开保护（editable 为 mayLeave 的结果）。
 */
export function nextDynamicsOnToggle(current, editable) {
  if (current !== 'hidden') return 'hidden'
  return editable ? 'docked' : 'hidden'
}
