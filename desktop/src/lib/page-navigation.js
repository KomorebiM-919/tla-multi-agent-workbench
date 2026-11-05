// Page switching shares the role-editor leave guard, so a tab click cannot skip an unsaved form.
// The guard is evaluated for every real page change, not only when leaving the team page.
export function attemptPageChange({ currentPage, nextPage, teamController }) {
  if (!nextPage || nextPage === currentPage) return { changed: false, blocked: false }
  if (teamController && !teamController.mayLeave()) {
    return { changed: false, blocked: true }
  }
  return { changed: true, blocked: false }
}
