import { nextDynamicsMode, nextDynamicsOnToggle } from './layout-state.js'

/**
 * Resolve a team-dynamics transition before React state is updated.
 *
 * Entering `docked` can replace the role detail panel, so it must pass the
 * same unsaved-role guard as page navigation. The guard runs here rather than
 * inside a state updater because `mayLeave` publishes a notice.
 */
export function requestDynamicsChange({ current, intent, teamController }) {
  const next =
    intent === 'toggle' ? nextDynamicsOnToggle(current, true) : nextDynamicsMode(current)

  if (next === 'docked' && current !== 'docked') {
    const allowed = teamController ? teamController.mayLeave() : true
    if (!allowed) return { dynamics: current, blocked: true }
  }

  return { dynamics: next, blocked: false }
}
