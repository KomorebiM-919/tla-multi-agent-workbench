// Offline adapter for versioned, synthetic observer records. No host, network,
// filesystem snapshot, command execution or legacy-log inference happens here.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { posix, win32, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual, TextDecoder } from 'node:util'
import { deriveAcceptance, IMPLEMENTATION_PATH, parseTestLine } from './acceptance-summary.mjs'

export const PROTOCOL_SCHEMA = 'tla.observation-protocol/v1'
export const COLLECTION_SCHEMA = 'tla.collected-evidence/v2'
export const LIMITS = Object.freeze({ inputBytes: 1024 * 1024, operations: 128, snapshotBytes: 64 * 1024, idLength: 128, pathLength: 1024 })
const MAX_JSON_DEPTH = 32

class EvidenceError extends Error {
  constructor(code) { super(code); this.code = code }
}
function requireThat(ok, code) { if (!ok) throw new EvidenceError(code) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fields(value, names) {
  const keys = names.split(' ')
  requireThat(object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'FIELDS_INVALID')
}
function id(value) {
  requireThat(typeof value === 'string' && value.length <= LIMITS.idLength && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value), 'ID_INVALID')
}
function text(value) { requireThat(typeof value === 'string' && value.trim() !== '' && value.length <= LIMITS.pathLength, 'TEXT_INVALID') }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function jsonValue(value, seen = new Set(), depth = 0) {
  requireThat(depth <= MAX_JSON_DEPTH, 'JSON_DEPTH_LIMIT')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { requireThat(Number.isFinite(value), 'JSON_INPUT_REQUIRED'); return }
  requireThat(object(value) || Array.isArray(value), 'JSON_INPUT_REQUIRED')
  const prototype = Object.getPrototypeOf(value)
  requireThat(!seen.has(value) && (Array.isArray(value) ? prototype === Array.prototype :
    prototype === Object.prototype || prototype === null), 'JSON_INPUT_REQUIRED')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  requireThat(Object.getOwnPropertySymbols(value).length === 0 &&
    Object.entries(descriptors).every(([key, d]) => Object.hasOwn(d, 'value') &&
      (d.enumerable || (Array.isArray(value) && key === 'length'))), 'JSON_INPUT_REQUIRED')
  if (Array.isArray(value)) requireThat(Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index)), 'JSON_INPUT_REQUIRED')
  seen.add(value)
  for (const key of Object.keys(value)) jsonValue(descriptors[key].value, seen, depth + 1)
  seen.delete(value)
}
function bytes(value) {
  requireThat(typeof value === 'string' && value.length <= Math.ceil(LIMITS.snapshotBytes / 3) * 4, 'BYTES_MISSING_OR_TOO_LARGE')
  const decoded = Buffer.from(value, 'base64')
  requireThat(decoded.length <= LIMITS.snapshotBytes && decoded.toString('base64') === value, 'BASE64_INVALID')
  return decoded
}
function utf8(value) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value) }
  catch { throw new EvidenceError('UTF8_INVALID') }
}

function rootPath(value) {
  text(value)
  requireThat(!/[\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('\\') && !value.startsWith('//'), 'ROOT_INVALID')
  const windows = /^[A-Za-z]:[\\/]/u.test(value)
  const path = windows ? win32 : posix
  requireThat(path.isAbsolute(value) && !value.replaceAll('\\', '/').split('/').some(p => p === '.' || p === '..'), 'ROOT_INVALID')
  const root = path.resolve(value)
  requireThat(root !== path.parse(root).root, 'ROOT_TOO_BROAD')
  return { root, windows, path, key: windows ? root.toLowerCase() : root }
}

function projectPath(value, project) {
  text(value)
  requireThat(!/[\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('\\\\') && !value.startsWith('//'), 'PATH_INVALID')
  const slash = value.replaceAll('\\', '/')
  const drive = /^[A-Za-z]:\//u.test(slash)
  requireThat(!drive || project.windows, 'PATH_INVALID')
  const components = (drive ? slash.slice(3) : slash.startsWith('/') ? slash.slice(1) : slash).split('/')
  requireThat(components.every(p => p !== '' && p !== '.' && p !== '..' && !p.includes(':') &&
    !/[. ]$/u.test(p) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p)), 'PATH_INVALID')
  requireThat(!project.windows || drive || !slash.startsWith('/'), 'PATH_INVALID')
  const absolute = project.path.resolve(project.root, slash)
  const relative = project.path.relative(project.root, absolute).replaceAll('\\', '/')
  requireThat(relative !== '' && relative !== '..' && !relative.startsWith('../') && !project.path.isAbsolute(relative), 'PATH_OUTSIDE_PROJECT')
  return project.windows ? relative.toLowerCase() : relative
}

function validateBinding(binding) {
  fields(binding, 'runnerRunId gateRunId budgetRunId')
  Object.values(binding).forEach(id)
  requireThat(binding.gateRunId === binding.budgetRunId, 'GATE_BUDGET_MAPPING_INVALID')
}

function orderedOperations(doc, sessions) {
  requireThat(Array.isArray(doc.operations) && doc.operations.length <= LIMITS.operations, 'OPERATIONS_LIMIT')
  const calls = new Map()
  for (const operation of doc.operations) {
    fields(operation, 'runId sessionId call result order observation')
    requireThat(operation.runId === doc.binding.gateRunId && sessions.has(operation.sessionId), 'OPERATION_BINDING_INVALID')
    fields(operation.call, 'id name input'); id(operation.call.id)
    requireThat(object(operation.call.input), 'CALL_INPUT_INVALID')
    fields(operation.result, 'toolUseId isError complete')
    requireThat(operation.result.toolUseId === operation.call.id, 'ORPHAN_RESULT')
    requireThat(typeof operation.result.isError === 'boolean' && operation.result.complete === true, 'RESULT_INCOMPLETE')
    fields(operation.order, 'authority call result')
    requireThat(operation.order.authority === doc.observer.id, 'ORDER_AUTHORITY_INVALID')
    requireThat([operation.order.call, operation.order.result].every(n => Number.isSafeInteger(n) && n >= 0) &&
      operation.order.result > operation.order.call, 'ORDER_INVALID')
    const key = JSON.stringify([operation.sessionId, operation.call.id])
    const prior = calls.get(key)
    if (prior !== undefined) requireThat(isDeepStrictEqual(prior, operation), 'REPLAY_CONFLICT')
    else calls.set(key, operation)
  }
  const ordered = [...calls.values()].sort((a, b) => a.order.call - b.order.call)
  let previous = -1
  for (const operation of ordered) {
    requireThat(operation.order.call > previous, 'OVERLAP_OR_DUPLICATE_ORDER')
    previous = operation.order.result
  }
  return ordered
}

function activeTask(state, observation, operation) {
  const task = state.tasks.get(observation.taskId)
  requireThat(task !== undefined && task.attemptId === observation.attemptId && task.assignee === operation.sessionId &&
    task.status === 'in_progress', 'ACTIVE_TASK_UNPROVEN')
  return task
}
function sameTaskInput(input, observation) {
  requireThat(input.task_id === observation.taskId && input.attempt_id === observation.attemptId, 'TASK_ATTEMPT_MISMATCH')
}
function latestWrites(writes) {
  const latest = new Map()
  for (const write of writes) latest.set(write.path, write)
  return [...latest.values()]
}
function readBackFor(files, writes) {
  const latest = latestWrites(writes)
  return latest.length > 0 && latest.every(write => {
    const read = files.filter(e => e.kind === 'read' && e.path === write.path && e.index > write.index).at(-1)
    return read !== undefined && read.sha256 === write.sha256
  })
}
function changedBy(state, task) {
  return state.files.filter(e => e.kind === 'write' && e.taskId === task.id && e.attemptId === task.attemptId && IMPLEMENTATION_PATH.test(e.path))
}
function greenFor(state, task) {
  return state.tests.filter(t => t.taskId === task.id && t.attemptId === task.attemptId && t.exitCode === 0).at(-1)
}
function redFor(state, task) {
  return state.tests.filter(t => t.taskId === task.id && t.attemptId === task.attemptId && t.failed > 0).at(-1)
}

function reviewerReadsFor(state, target, review) {
  const writes = latestWrites(changedBy(state, target))
  if (writes.length === 0) return null
  const reads = writes.map(write => state.files.filter(event => event.kind === 'read' && event.path === write.path &&
    event.taskId === review.id && event.attemptId === review.attemptId && event.sessionId === review.assignee &&
    event.index > target.index && event.index > write.index).at(-1))
  return reads.every((read, i) => read !== undefined && read.sha256 === writes[i].sha256) ? reads : null
}

// Global rule counts are insufficient: every rejected work must close its own
// latest rejection through its own latest repair and corresponding review.
function closureChains(state) {
  return [...state.rejected.values()].map(rejection => {
    const repair = [...state.tasks.values()].filter(task => task.taskKind === 'repair' &&
      task.sourceTaskId === rejection.workTaskId && task.rejectionIndex === rejection.index)
      .sort((a, b) => a.createdIndex - b.createdIndex).at(-1)
    const pass = repair === undefined ? undefined : state.passes.get(repair.id)
    const bound = repair?.status === 'completed' && pass !== undefined &&
      pass.workTaskId === rejection.workTaskId && pass.workAttemptId === rejection.workAttemptId &&
      pass.rejectionIndex === rejection.index && pass.repairAttemptId === repair.attemptId &&
      state.tasks.get(pass.reviewTaskId)?.status === 'completed'
    // A later write to an approved path invalidates the earlier snapshot, even
    // if another chain ends with identical bytes. No silent cross-chain credit.
    const fresh = bound && pass.reads.every(read => {
      const write = state.files.filter(event => event.kind === 'write' && event.path === read.path).at(-1)
      return write !== undefined && write.index < read.index
    })
    return { workTaskId: rejection.workTaskId, workAttemptId: rejection.workAttemptId,
      rejectionIndex: rejection.index, rejectedReviewTaskId: rejection.reviewTaskId,
      repairTaskId: repair?.id ?? null, repairAttemptId: repair?.attemptId ?? null,
      reviewTaskId: pass?.reviewTaskId ?? null, reviewAttemptId: pass?.reviewAttemptId ?? null,
      reviewerSessionId: pass?.reviewerSessionId ?? null, passIndex: pass?.index ?? null,
      reads: pass?.reads ?? [], closed: Boolean(fresh),
      problem: !bound ? 'REJECTED_WORK_CHAIN_INCOMPLETE' : !fresh ? 'REVIEW_STALE_AFTER_WRITE' : null }
  })
}

function collectTask(state, op, role) {
  const o = op.observation, input = op.call.input, index = op.order.result
  if (o.type === 'task-create') {
    fields(o, 'type taskId subject taskKind assignee sourceTaskId reviewedTaskId')
    fields(input, 'subject kind assignee sourceTaskId reviewedTaskId')
    id(o.taskId); text(o.subject)
    requireThat(Buffer.from(o.subject, 'utf8').toString('utf8') === o.subject, 'SUBJECT_UTF8_INVALID')
    requireThat(role === 'captain' && op.call.name === 'agent_teams_create_task' && !state.tasks.has(o.taskId), 'TASK_CREATE_INVALID')
    requireThat(['work', 'repair', 'review'].includes(o.taskKind) && input.kind === o.taskKind && input.subject === o.subject &&
      input.assignee === o.assignee && input.sourceTaskId === o.sourceTaskId && input.reviewedTaskId === o.reviewedTaskId, 'TASK_METADATA_MISMATCH')
    requireThat(state.sessions.get(o.assignee) === (o.taskKind === 'review' ? 'reviewer' : 'worker'), 'TASK_OWNER_INVALID')
    if (o.taskKind === 'work') requireThat(o.sourceTaskId === null && o.reviewedTaskId === null, 'TASK_LINEAGE_INVALID')
    if (o.taskKind === 'repair') requireThat(o.reviewedTaskId === null && state.tasks.get(o.sourceTaskId)?.taskKind === 'work' &&
      state.rejected.has(o.sourceTaskId), 'REPAIR_SOURCE_UNPROVEN')
    if (o.taskKind === 'review') requireThat(o.sourceTaskId === null && state.tasks.get(o.reviewedTaskId)?.status === 'completed' &&
      state.tasks.get(o.reviewedTaskId)?.taskKind !== 'review', 'REVIEW_TARGET_UNPROVEN')
    state.tasks.set(o.taskId, { ...o, id: o.taskId, attemptId: null, status: 'pending', index, createdIndex: index,
      rejectionIndex: o.taskKind === 'repair' ? state.rejected.get(o.sourceTaskId).index : null })
    return
  }
  if (o.type === 'task-claim') {
    fields(o, 'type taskId attemptId'); fields(input, 'task_id')
    id(o.attemptId)
    const task = state.tasks.get(o.taskId)
    requireThat(op.call.name === 'agent_teams_claim_task' && input.task_id === o.taskId && task?.status === 'pending' &&
      task.assignee === op.sessionId && !state.attempts.has(o.attemptId), 'TASK_CLAIM_INVALID')
    state.attempts.add(o.attemptId); task.attemptId = o.attemptId; task.status = 'claimed'
    return
  }
  fields(o, 'type taskId attemptId status'); fields(input, 'task_id attempt_id status')
  const task = state.tasks.get(o.taskId)
  sameTaskInput(input, o)
  requireThat(op.call.name === 'agent_teams_update_task' && task !== undefined && task.assignee === op.sessionId &&
    task.attemptId === o.attemptId && input.status === o.status, 'TASK_UPDATE_INVALID')
  requireThat((task.status === 'claimed' && o.status === 'in_progress') ||
    (task.status === 'in_progress' && ['completed', 'failed'].includes(o.status)), 'TASK_TRANSITION_INVALID')
  requireThat(task.taskKind !== 'review' || o.status !== 'completed', 'REVIEW_RESULT_REQUIRED')
  if (task.taskKind === 'repair' && o.status === 'completed') {
    const source = state.tasks.get(task.sourceTaskId), red = redFor(state, source), green = greenFor(state, task)
    requireThat(red !== undefined && green !== undefined && red.command === green.command && red.suiteSha256 === green.suiteSha256 &&
      readBackFor(state.files, changedBy(state, task)) && changedBy(state, task).every(w => w.index < green.index), 'REPAIR_EXECUTION_UNPROVEN')
    state.usage.push({ rule: 'repair-completed', index })
  }
  task.status = o.status; task.index = index
}

function collectFile(state, op, project, role) {
  const o = op.observation, input = op.call.input
  const write = o.type === 'file-write'
  fields(o, 'type taskId attemptId path fileKind links coverage bytesBase64' + (write ? ' beforeBase64' : ''))
  fields(input, write ? 'file_path content' : 'file_path')
  const task = activeTask(state, o, op)
  requireThat(op.call.name === (write ? 'write' : 'read') && (!write || role === 'worker'), 'FILE_TOOL_INVALID')
  requireThat(o.fileKind === 'regular' && o.links === 'none' && o.coverage === 'full', 'FULL_REGULAR_BYTES_REQUIRED')
  const path = projectPath(o.path, project)
  requireThat(path === projectPath(input.file_path, project), 'FILE_PATH_MISMATCH')
  const content = bytes(o.bytesBase64), sha256 = hash(content)
  const previous = state.fileState.get(path)
  const sessionPath = JSON.stringify([op.sessionId, path])
  if (write) {
    const before = hash(bytes(o.beforeBase64))
    requireThat(typeof input.content === 'string' && Buffer.from(input.content, 'utf8').equals(content), 'WRITE_BYTES_MISMATCH')
    requireThat(before === previous && before === state.sessionReads.get(sessionPath) && before !== sha256, 'WRITE_PRIOR_READ_UNPROVEN')
  } else {
    requireThat(previous === undefined || previous === sha256, 'FILE_STATE_MISMATCH')
    state.sessionReads.set(sessionPath, sha256)
  }
  state.fileState.set(path, sha256)
  state.files.push({ kind: write ? 'write' : 'read', path, sha256, bytes: content.length,
    index: op.order.result, taskId: task.id, attemptId: task.attemptId, sessionId: op.sessionId })
}

function collectTest(state, op, project) {
  const o = op.observation, input = op.call.input
  fields(o, 'type taskId attemptId command cwd exitCode stdoutBase64 suitePath suiteBase64')
  fields(input, 'command description'); text(input.description)
  const task = activeTask(state, o, op), suite = projectPath(o.suitePath, project)
  requireThat(op.call.name === 'pwsh' && suite.startsWith('test/') && o.cwd === '.' &&
    o.command === 'node ' + suite && input.command === o.command, 'TEST_INVOCATION_INVALID')
  requireThat(Number.isSafeInteger(o.exitCode) && o.exitCode >= 0 && o.exitCode <= 255 &&
    op.result.isError === (o.exitCode !== 0), 'PROCESS_EXIT_UNPROVEN')
  const output = utf8(bytes(o.stdoutBase64))
  const lines = output.split(/\r?\n/u).filter(line => /^(?:[A-Za-z][A-Za-z0-9_-]* )?tests: \d+ passed, \d+ failed$/u.test(line))
  requireThat(lines.length === 1, 'TEST_COUNTS_UNPROVEN')
  const counts = parseTestLine(lines[0])
  requireThat(Number.isSafeInteger(counts.passed) && Number.isSafeInteger(counts.failed) && Number.isSafeInteger(counts.passed + counts.failed) && counts.passed + counts.failed > 0 &&
    (o.exitCode === 0 ? counts.failed === 0 : counts.failed > 0), 'TEST_EXIT_COUNTS_MISMATCH')
  const suiteSha256 = hash(bytes(o.suiteBase64))
  requireThat(state.tests.every(t => t.command === o.command && t.suiteSha256 === suiteSha256), 'TEST_SUITE_CHANGED')
  state.tests.push({ ...counts, command: o.command, suiteSha256, exitCode: o.exitCode,
    index: op.order.result, taskId: task.id, attemptId: task.attemptId })
}

function collectReview(state, op) {
  const o = op.observation, input = op.call.input
  fields(o, 'type taskId attemptId reviewedTaskId verdict'); fields(input, 'task_id attempt_id status verdict')
  const task = activeTask(state, o, op), target = state.tasks.get(o.reviewedTaskId)
  sameTaskInput(input, o)
  requireThat(op.call.name === 'agent_teams_update_task' && task.taskKind === 'review' && task.reviewedTaskId === o.reviewedTaskId &&
    target?.status === 'completed' && input.status === 'completed' && input.verdict === o.verdict, 'REVIEW_BINDING_INVALID')
  const reads = reviewerReadsFor(state, target, task)
  requireThat(reads !== null, 'REVIEWER_READ_UNPROVEN')
  if (o.verdict === 'needs_revision') {
    requireThat(target.taskKind === 'work' && redFor(state, target) !== undefined, 'REJECTION_UNPROVEN')
    state.rejected.set(target.id, { workTaskId: target.id, workAttemptId: target.attemptId,
      reviewTaskId: task.id, index: op.order.result })
    state.usage.push({ rule: 'review-reject', index: op.order.result })
  } else {
    requireThat(o.verdict === 'passed' && target.taskKind === 'repair' && state.rejected.has(target.sourceTaskId) &&
      state.rejected.get(target.sourceTaskId).index === target.rejectionIndex &&
      greenFor(state, target) !== undefined && readBackFor(state.files, changedBy(state, target)), 'PASS_LINEAGE_UNPROVEN')
    state.passes.set(target.id, { workTaskId: target.sourceTaskId,
      workAttemptId: state.tasks.get(target.sourceTaskId).attemptId, rejectionIndex: target.rejectionIndex,
      repairAttemptId: target.attemptId, reviewTaskId: task.id, reviewAttemptId: task.attemptId,
      reviewerSessionId: op.sessionId, index: op.order.result,
      reads: reads.map(({ path, sha256, index, taskId, attemptId, sessionId }) => ({ path, sha256, index, taskId, attemptId, sessionId })) })
    state.usage.push({ rule: 'review-pass', index: op.order.result })
  }
  task.status = 'completed'; task.index = op.order.result
}

/** Collect only synthetic normalized records. Expected bindings are mandatory. */
export function collectEvidence(input, options = {}) {
  let supervisor = { status: 'unknown', hostStarted: false }, ledger = null
  let binding = null
  const issues = []
  const state = { tasks: new Map(), attempts: new Set(), sessions: new Map(), rejected: new Map(), passes: new Map(), chains: [],
    files: [], fileState: new Map(), sessionReads: new Map(), tests: [], usage: [] }
  let operationId = null
  try {
    jsonValue(input)
    const encoded = JSON.stringify(input)
    requireThat(typeof encoded === 'string' && Buffer.byteLength(encoded) <= LIMITS.inputBytes, 'INPUT_LIMIT')
    const doc = JSON.parse(encoded)
    fields(doc, 'schema origin binding projectRoot observer sessions runner ledger operations')
    requireThat(doc.schema === PROTOCOL_SCHEMA && doc.origin === 'synthetic', 'SCHEMA_OR_ORIGIN_UNSUPPORTED')
    requireThat(object(options), 'EXPECTED_CONTEXT_REQUIRED')
    validateBinding(options.binding); validateBinding(doc.binding)
    requireThat(isDeepStrictEqual(doc.binding, options.binding), 'RUN_MAPPING_MISMATCH')
    binding = { ...doc.binding }
    const project = rootPath(options.projectRoot)
    requireThat(rootPath(doc.projectRoot).key === project.key, 'PROJECT_ROOT_MISMATCH')
    fields(doc.observer, 'id ordering complete'); id(doc.observer.id)
    requireThat(doc.observer.ordering === 'serial-total' && doc.observer.complete === true, 'ORDER_OR_COVERAGE_UNKNOWN')
    requireThat(Array.isArray(doc.sessions) && doc.sessions.length > 0 && doc.sessions.length <= LIMITS.operations, 'SESSIONS_INVALID')
    for (const session of doc.sessions) {
      fields(session, 'id role'); id(session.id)
      requireThat(['captain', 'worker', 'reviewer'].includes(session.role) && !state.sessions.has(session.id), 'SESSION_INVALID')
      state.sessions.set(session.id, session.role)
    }
    fields(doc.runner, 'runId status hostStarted')
    requireThat(doc.runner.runId === doc.binding.runnerRunId && typeof doc.runner.status === 'string' && typeof doc.runner.hostStarted === 'boolean', 'RUNNER_BINDING_INVALID')
    fields(doc.ledger, 'gateRunId budgetRunId completeness ledgerConsistent')
    requireThat(doc.ledger.gateRunId === doc.binding.gateRunId && doc.ledger.budgetRunId === doc.binding.budgetRunId &&
      ['COMPLETE', 'INCOMPLETE'].includes(doc.ledger.completeness) && typeof doc.ledger.ledgerConsistent === 'boolean', 'LEDGER_BINDING_INVALID')
    supervisor = doc.runner; ledger = doc.ledger
    requireThat(ledger.completeness === 'COMPLETE' && ledger.ledgerConsistent, 'LEDGER_INCOMPLETE')
    for (const op of orderedOperations(doc, state.sessions)) {
      operationId = op.call.id
      requireThat(object(op.observation), 'OBSERVATION_MISSING')
      const type = op.observation.type, role = state.sessions.get(op.sessionId)
      requireThat(!op.result.isError || type === 'test', 'TOOL_FAILED')
      if (['task-create', 'task-claim', 'task-update'].includes(type)) collectTask(state, op, role)
      else if (type === 'file-read' || type === 'file-write') collectFile(state, op, project, role)
      else if (type === 'test') collectTest(state, op, project)
      else if (type === 'review') collectReview(state, op)
      else throw new EvidenceError('OBSERVATION_TYPE_UNSUPPORTED')
    }
    operationId = null
    const changed = state.files.filter(e => e.kind === 'write' && IMPLEMENTATION_PATH.test(e.path))
    requireThat(readBackFor(state.files, changed), 'IMPLEMENTATION_READ_BACK_INCOMPLETE')
    state.chains = closureChains(state)
    for (const task of state.tasks.values()) {
      requireThat(task.taskKind !== 'work' || changedBy(state, task).length === 0 ||
        state.rejected.has(task.id), 'WORK_REVIEW_CHAIN_INCOMPLETE')
    }
    const openChain = state.chains.find(chain => !chain.closed)
    requireThat(openChain === undefined, openChain?.problem)
    for (const task of state.tasks.values()) {
      if (task.taskKind === 'repair' && task.status === 'completed') {
        const pass = state.passes.get(task.id)
        requireThat(pass !== undefined && pass.repairAttemptId === task.attemptId &&
          pass.rejectionIndex === task.rejectionIndex, 'REPAIR_REVIEW_INCOMPLETE')
      }
    }
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error
    issues.push({ code: error.code, callId: operationId })
  }
  const tasks = [...state.tasks.values()]
  const tests = state.tests.length === 0 ? null : { ...state.tests.at(-1), history: state.tests }
  const valid = issues.length === 0
  const acceptance = deriveAcceptance({ supervisor, ledger,
    tests: valid ? tests : null, writes: valid ? state.files : [], usage: valid ? state.usage : [],
    tasks: valid ? tasks.map(t => ({ id: t.id, subject: t.taskKind, status: t.status })) : [] })
  return {
    schema: COLLECTION_SCHEMA, scope: 'synthetic-protocol', hostVerified: false, binding,
    status: valid ? 'COMPLETE' : 'INCOMPLETE',
    verdict: valid && acceptance.verdict === 'closed' ? 'synthetic-closed' : acceptance.verdict === 'not-started' ? 'not-started' : 'partial',
    issues, syntheticAcceptance: acceptance,
    evidence: { files: state.files, tasks: tasks.map(t => ({ id: t.id, kind: t.taskKind, status: t.status,
      attemptId: t.attemptId, sourceTaskId: t.sourceTaskId, reviewedTaskId: t.reviewedTaskId,
      subjectSha256: hash(Buffer.from(t.subject, 'utf8')), subjectBytes: Buffer.byteLength(t.subject, 'utf8') })),
    chains: state.chains,
    tests: { history: state.tests.map(({ command, ...test }) => ({ ...test, commandSha256: hash(Buffer.from(command)) })) } }
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const allowed = new Set(['--protocol', '--runner-run-id', '--gate-run-id', '--budget-run-id', '--project-root'])
    const args = new Map()
    for (let i = 0; i < argv.length; i += 2) {
      requireThat(allowed.has(argv[i]) && !args.has(argv[i]) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'CLI_ARGUMENT_INVALID')
      args.set(argv[i], argv[i + 1])
    }
    requireThat(args.size === allowed.size, 'CLI_ARGUMENT_MISSING')
    const path = args.get('--protocol'), stat = statSync(path)
    requireThat(stat.isFile() && stat.size <= LIMITS.inputBytes, 'INPUT_LIMIT')
    const input = JSON.parse(readFileSync(path, 'utf8'))
    const report = collectEvidence(input, { projectRoot: args.get('--project-root'), binding: {
      runnerRunId: args.get('--runner-run-id'), gateRunId: args.get('--gate-run-id'), budgetRunId: args.get('--budget-run-id') } })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return report.verdict === 'synthetic-closed' ? 0 : 2
  } catch (error) {
    process.stderr.write('collect-run-evidence: ' + (error instanceof EvidenceError ? error.code : 'INPUT_READ_OR_PARSE_FAILED') + '\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main()
