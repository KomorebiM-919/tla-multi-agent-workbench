// Conversation session helpers shared by App and the integration tests.
//
// The user's rule is explicit: reopening the window leaves the composer empty,
// and stored unsent text is only filled in after the user asks for it. On the
// close path both classes of edits (project recovery drafts and unsent text)
// have to be reconciled together; two local ok flags are not enough.

export const CLOSE_BARRIER_ROUNDS = 3

export function indexCandidates(entries) {
  const candidates = {}
  for (const entry of entries ?? []) {
    if (entry && typeof entry.projectId === 'string') {
      candidates[entry.projectId] = {
        projectId: entry.projectId,
        text: typeof entry.text === 'string' ? entry.text : '',
        revision: entry.revision,
        updatedAt: entry.updatedAt,
      }
    }
  }
  return candidates
}

/**
 * Startup must not copy stored text into the composer: returning an empty map
 * keeps the candidate intact on disk and makes the user's restore explicit.
 */
export function initialConversationTexts() {
  return {}
}

export function restoreConversationCandidate({ currentText, candidateText, confirmed = false }) {
  const next = typeof candidateText === 'string' ? candidateText : ''
  const hasNewInput = typeof currentText === 'string' && currentText.length > 0
  if (hasNewInput && !confirmed) {
    // Never replace or concatenate silently; the UI asks before applying.
    return { apply: false, needsConfirmation: true, text: currentText }
  }
  return { apply: true, needsConfirmation: false, text: next }
}

/**
 * Only text that is actually registered with the conversation controller may
 * be described as retained. Over-limit text stays visible but is tracked as
 * unretained so the close handshake returns a failure instead of success.
 */
export function classifyConversationEdit({ text, limit, loadFailed = false }) {
  if (loadFailed) {
    return { accept: false, retain: false, reason: 'READ_FAILED', text }
  }
  if (text.length > limit) {
    return { accept: true, retain: false, reason: 'TOO_LONG', text }
  }
  return { accept: true, retain: true, reason: null, text }
}

/**
 * Record an edit for an unsaved project: the project identity has to be kept
 * through the existing recovery draft, otherwise reopening only has an orphan
 * conversation entry with no project to attach it to.
 */
export function recordConversationEdit({
  conversation,
  recovery,
  project,
  saved,
  text,
  limit,
}) {
  const decision = classifyConversationEdit({ text, limit })
  if (!decision.accept) return { accepted: false, retained: false, reason: decision.reason }
  if (!decision.retain) return { accepted: true, retained: false, reason: decision.reason }
  if (!saved) recovery.noteEdit(project)
  conversation.noteEdit(project.id, text)
  return { accepted: true, retained: true, reason: null }
}

export function unretainedMessage(reason) {
  if (reason === 'READ_FAILED') {
    return '未发送文字文件读取失败，新输入没有保留。'
  }
  return '未发送文字超出长度上限，没有保留。'
}

/**
 * Applies an explicit restore through the same retention path as typing.
 * The restored text has to become the newest retained revision; only changing
 * the composer would leave the old candidate on disk and label it as saved.
 */
export function applyConversationRestore({
  conversation,
  recovery,
  project,
  saved,
  candidate,
  currentText,
  confirmed = false,
  limit,
}) {
  const decision = restoreConversationCandidate({
    currentText,
    candidateText: candidate?.text,
    confirmed,
  })
  if (!decision.apply) return { applied: false, needsConfirmation: true }
  const recorded = recordConversationEdit({
    conversation,
    recovery,
    project,
    saved,
    text: decision.text,
    limit,
  })
  return {
    applied: true,
    retained: recorded.retained,
    reason: recorded.reason,
    text: decision.text,
  }
}

/**
 * A partially completed cancel deletes the project's recovery identity first.
 * If the conversation discard then fails, the project stays on screen but its
 * identity must be re-registered (or the close must be blocked), otherwise the
 * text becomes an orphan on the next launch. Discard keeps its revision
 * watermark, so this new draft is written above the deleted revision.
 */
export function restoreProjectIdentity({ recovery, project }) {
  if (!recovery || !project) return false
  recovery.noteEdit(project)
  return true
}


/**
 * Close barrier: keep flushing both classes until neither has pending work, or
 * return the unfinished state. Bounded — never retries forever, never treats a
 * local ok as a promise that nothing changed while waiting for the other one.
 */
export async function flushBeforeClose({
  recovery,
  conversation,
  unretained = {},
  getUnretained,
  maxRounds = CLOSE_BARRIER_ROUNDS,
}) {
  const errors = []
  let rounds = 0
  while (rounds < maxRounds) {
    rounds += 1
    const recoveryResult = await recovery.flush()
    const conversationResult = await conversation.flush()
    errors.push(...(recoveryResult.errors ?? []), ...(conversationResult.errors ?? []))
    if (errors.length > 0) break
    if (!recovery.hasPending?.() && !conversation.hasPending?.()) break
  }

  if (errors.length === 0) {
    if (recovery.hasPending?.() || conversation.hasPending?.()) {
      errors.push({
        error: {
          code: 'RECOVERY_PENDING',
          message: '最新编辑还没有完成保留。',
        },
      })
    } else {
      // Read the live state after the barrier: text can become unretained while
      // we were waiting for the other store, and a pre-wait snapshot would hide it.
      const latestUnretained = typeof getUnretained === 'function' ? getUnretained() : unretained
      for (const [projectId, item] of Object.entries(latestUnretained ?? {})) {
        if (!item) continue
        errors.push({
          projectId,
          error: {
            code: 'CONVERSATION_UNRETAINED',
            message: unretainedMessage(item.reason),
          },
        })
      }
    }
  }

  return { ok: errors.length === 0, errors }
}
