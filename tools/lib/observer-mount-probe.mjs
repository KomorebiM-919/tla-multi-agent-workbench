import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { joinReceipts, validateGateReceipt, validateRunnerReceipt } from './launch-receipts.mjs'
import { inspectTraceBytes, validateFooter, validateHeader, validateObservation } from './tool-trace-contracts.mjs'
import { readLifecycle } from '../../orchestration/tool-observer/lifecycle.mjs'

export const MOUNT_PROBE_SCHEMA = 'tla.observer-mount-probe/v1'
export const MOUNT_PROBE_INPUT_SCHEMA = 'tla.observer-mount-probe-input/v1'
export const MOUNT_PROBE_SCOPE = 'mount-probe'
export const MOUNT_PROBE_STATUSES = Object.freeze(['probe-passed', 'incomplete', 'failed'])

const MATERIAL_KEYS = Object.freeze([
  'journal', 'trace', 'runnerReceipt', 'gateReceipt',
  'runnerSummary', 'gateSummary', 'budgetEvents', 'ledger'
])
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024
const SAFE_TRACE_KEYS = new Set(['kind', 'receiptSeq', 'source', 'event', 'sessionId', 'callId', 'rootCallId', 'toolName', 'sourceSeq', 'outcome', 'valueState', 'process'])

class ProbeError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'ProbeError'
    this.code = code
  }
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function check (checks, code, ok, detail) {
  checks.push({ code, ok: ok === true, detail: String(detail) })
  return ok === true
}

function issue (issues, code, detail) {
  issues.push({ code, detail: String(detail) })
}

function exact (value, keys, label) {
  if (!isObject(value)) throw new ProbeError('INPUT_SCHEMA', label + ' must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ProbeError('INPUT_SCHEMA', label + ' must contain exactly ' + expected.join(', '))
  }
}

function readMaterial (path) {
  let info
  try { info = statSync(path) } catch (error) { throw new ProbeError('MATERIAL_MISSING', path + ': ' + error.message) }
  if (!info.isFile()) throw new ProbeError('MATERIAL_MISSING', path + ' is not a regular file')
  if (info.size > MAX_MATERIAL_BYTES) throw new ProbeError('MATERIAL_TOO_LARGE', path + ' exceeds 8 MiB')
  try { return readFileSync(path) } catch (error) { throw new ProbeError('MATERIAL_UNREADABLE', path + ': ' + error.message) }
}

function parseJson (bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) { throw new ProbeError('MATERIAL_INVALID', label + ' is not JSON: ' + error.message) }
}

function parseJsonLines (bytes, label) {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new ProbeError('MATERIAL_EMPTY', label + ' has no records')
  return lines.map((line, index) => {
    if (line.length === 0) throw new ProbeError('MATERIAL_INVALID', label + ' has a blank line at ' + String(index + 1))
    try { return JSON.parse(line) } catch (error) { throw new ProbeError('MATERIAL_INVALID', label + ' line ' + String(index + 1) + ' is not JSON') }
  })
}

function traceParts (bytes) {
  // inspectTraceBytes is the frozen strict parser: footer, sequence, pairing,
  // limits and degradation are all decided there, not by this report.
  const inspected = inspectTraceBytes(bytes)
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const header = validateHeader(JSON.parse(lines[0]))
  const observations = []
  for (let index = 1; index < lines.length - 1; index += 1) {
    observations.push(validateObservation(JSON.parse(lines[index]), { expectedSeq: index }))
  }
  const footer = validateFooter(JSON.parse(lines[lines.length - 1]), { traceId: header.traceId })
  return { inspected, header, observations, footer }
}

function idFrom (value, keys, label, issues) {
  const present = []
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      issue(issues, 'IDENTITY_INVALID', label + '.' + key + ' is not a non-empty string')
      return { id: null, conflict: false }
    }
    present.push(value[key])
  }
  if (present.length === 0) return { id: null, conflict: false }
  if (new Set(present).size > 1) {
    issue(issues, 'IDENTITY_CONFLICT', label + ' has conflicting values')
    return { id: null, conflict: true }
  }
  return { id: present[0], conflict: false }
}

function sameIdentity (a, b) {
  return a !== null && b !== null && a === b
}

function hasForbiddenText (value) {
  return typeof value === 'string' && /(?:[A-Za-z]:\\|sk-[A-Za-z0-9]|BEGIN PRIVATE|api[_-]?key|password|token)/iu.test(value)
}

function traceKeySafe (observation) {
  return Object.keys(observation).every((key) => SAFE_TRACE_KEYS.has(key))
}

function resultFor (observations, toolName) {
  return observations.filter((entry) => entry.event === 'result' && entry.toolName === toolName)
}

function callFor (observations, result) {
  return observations.find((entry) => entry.event === 'call'
    && entry.sessionId === result.sessionId
    && entry.callId === result.callId
    && entry.rootCallId === result.rootCallId
    && entry.toolName === result.toolName)
}

/**
 * Evaluate real-format synthetic mount materials. The input contains paths, not
 * caller-supplied verdicts: journal bytes, trace bytes, both receipts, runner /
 * gate summaries, budget events and the recomputed ledger are parsed by the
 * existing strict readers. No host, profile or model service is read.
 */
export function evaluateMountProbe (input, { readFile = readMaterial } = {}) {
  const checks = []
  const issues = []
  let contradicted = false
  let bindingStatus = 'unproven'
  let journal = null
  let trace = null
  const limitations = []

  if (!isObject(input) || input.schema !== MOUNT_PROBE_INPUT_SCHEMA) {
    return report([{ code: 'INPUT_SCHEMA', ok: false, detail: 'input schema must be ' + MOUNT_PROBE_INPUT_SCHEMA }], [{ code: 'INPUT_SCHEMA', detail: 'invalid input schema' }], 'incomplete', 'unproven', limitations)
  }
  try {
    exact(input, ['schema', 'materials'], 'input')
    exact(input.materials, MATERIAL_KEYS, 'materials')
  } catch (error) {
    return report([{ code: 'INPUT_SCHEMA', ok: false, detail: error.message }], [{ code: 'INPUT_SCHEMA', detail: error.message }], 'incomplete', 'unproven', limitations)
  }

  const materials = {}
  for (const key of MATERIAL_KEYS) {
    const path = input.materials[key]
    if (typeof path !== 'string' || path.trim() === '') {
      issue(issues, 'MATERIAL_MISSING', 'materials.' + key + ' is required')
      continue
    }
    try { materials[key] = readFile(resolve(path)) } catch (error) {
      issue(issues, error.code ?? 'MATERIAL_UNREADABLE', error.message)
    }
  }
  if (Object.keys(materials).length !== MATERIAL_KEYS.length) {
    return report(checks, issues, 'incomplete', 'unproven', limitations)
  }

  // 1. Lifecycle journal: strict bytes, terminal phase semantics, and its own
  // identity. A merely present phase list is not enough.
  try {
    journal = readLifecycle(materials.journal)
    check(checks, 'journal-terminal', ['stopped', 'failed'].includes(journal.phase), 'journal terminal phase=' + journal.phase)
    check(checks, 'journal-attached', journal.records.some((record) => record.phase === 'attached'), 'attached is required')
    check(checks, 'journal-stopped', journal.phase === 'stopped', 'clean stopped phase is required; got ' + journal.phase)
    check(checks, 'journal-no-failed', !journal.records.some((record) => record.phase === 'failed'), 'failed lifecycle phase blocks the probe')
    if (journal.phase === 'failed') contradicted = true
    const terminal = journal.records.at(-1)
    check(checks, 'journal-cleanup', terminal?.phase === 'stopped' && terminal.health?.cleanupState === 'settled' && terminal.health?.ownershipUncertain === false && terminal.health?.writerOk === true, 'stopped health must report settled, writerOk and known ownership')
    if (terminal?.phase === 'stopped' && (terminal.health?.cleanupState !== 'settled' || terminal.health?.ownershipUncertain !== false || terminal.health?.writerOk !== true)) contradicted = true
  } catch (error) {
    issue(issues, 'JOURNAL_INVALID', String(error.message))
    journal = null
  }

  // 2. Trace: frozen format, footer, no degradation, real result events, call
  // pairing, tool success and foreground pwsh process facts.
  try {
    const parsed = traceParts(materials.trace)
    trace = parsed
    check(checks, 'trace-status', parsed.inspected.status === 'VALID_METADATA', 'trace status=' + parsed.inspected.status)
    if (parsed.inspected.status !== 'VALID_METADATA') contradicted = true
    check(checks, 'trace-footer', parsed.footer !== null && parsed.footer.captureState === 'finalized' && parsed.footer.diagnosticsDropped === 0 && parsed.footer.diagnostics.length === 0, 'finalized footer with no diagnostics is required')
    if (parsed.footer.captureState !== 'finalized' || parsed.footer.diagnosticsDropped !== 0 || parsed.footer.diagnostics.length !== 0) contradicted = true
    check(checks, 'trace-origin', parsed.header.origin === 'host-notification', 'origin=' + parsed.header.origin)
    if (parsed.header.origin !== 'host-notification') contradicted = true
    const read = resultFor(parsed.observations, 'read')
    const pwsh = resultFor(parsed.observations, 'pwsh')
    check(checks, 'trace-read', read.length >= 1, 'a read result is required')
    check(checks, 'trace-pwsh', pwsh.length >= 1, 'a pwsh result is required')
    const unexpected = parsed.observations.filter((entry) => entry.event === 'result' && !['read', 'pwsh'].includes(entry.toolName))
    check(checks, 'trace-tools', unexpected.length === 0, 'only read and pwsh results are allowed; unexpected=' + String(unexpected.length))
    if (unexpected.length > 0) contradicted = true
    const unsuccessful = parsed.observations.filter((entry) => entry.event === 'result' && entry.outcome !== 'success')
    check(checks, 'trace-tool-success', unsuccessful.length === 0, 'every tool result must be success; unsuccessful=' + String(unsuccessful.length))
    if (unsuccessful.length > 0) contradicted = true
    const unpaired = [...read, ...pwsh].filter((entry) => callFor(parsed.observations, entry) === undefined)
    check(checks, 'trace-pairing', unpaired.length === 0, 'each read/pwsh result must have a call with the same identity; unpaired=' + String(unpaired.length))
    if (unpaired.length > 0) contradicted = true
    const pwshForeground = pwsh.filter((entry) => entry.process !== null && entry.process.exitCode === 0
      && entry.process.timedOut === false && entry.process.aborted === false
      && entry.process.stdoutTruncated === false && entry.process.stderrTruncated === false)
    check(checks, 'trace-pwsh-foreground', pwsh.length > 0 && pwshForeground.length === pwsh.length, 'pwsh must have foreground exit 0 and untruncated, non-aborted facts')
    if (pwsh.some((entry) => entry.process === null || entry.process.exitCode !== 0 || entry.process.timedOut !== false || entry.process.aborted !== false || entry.process.stdoutTruncated !== false || entry.process.stderrTruncated !== false)) contradicted = true
    const unsafe = parsed.observations.filter((entry) => !traceKeySafe(entry) || hasForbiddenText(JSON.stringify(entry)))
    check(checks, 'dto-safe', unsafe.length === 0, 'trace entries must use safe fields and contain no absolute/private text')
    if (unsafe.length > 0) contradicted = true
  } catch (error) {
    issue(issues, 'TRACE_INVALID', String(error.message))
    trace = null
  }

  // 3. Receipts: strict schemas and the B0 join. A simulated pair is allowed
  // only as unproven; malformed or conflicting receipts are not.
  let runnerReceipt = null
  let gateReceipt = null
  try {
    runnerReceipt = validateRunnerReceipt(parseJson(materials.runnerReceipt, 'runner receipt'))
    gateReceipt = validateGateReceipt(parseJson(materials.gateReceipt, 'gate receipt'))
    const joined = joinReceipts(runnerReceipt, gateReceipt)
    check(checks, 'receipts-spawned', runnerReceipt.state === 'spawned', 'runner receipt state=' + runnerReceipt.state)
    check(checks, 'receipts-join', joined.problems.every((problem) => problem === 'RECEIPT_SIMULATED'), 'receipt join problems=' + (joined.problems.join(',') || 'none'))
    if (!joined.problems.every((problem) => problem === 'RECEIPT_SIMULATED')) contradicted = true
    if (joined.problems.length === 0) bindingStatus = 'consistent'
    else {
      limitations.push('B0 receipts are simulated or do not authenticate the run; binding stays unproven')
    }
  } catch (error) {
    issue(issues, 'RECEIPT_INVALID', String(error.message))
    runnerReceipt = null
    gateReceipt = null
  }

  // 4. Independent runner/gate/budget sources. The ledger has no run IDs in its
  // schema, so it can only be checked for completeness; that limit is explicit.
  let runnerId = null
  let gateId = null
  let budgetId = null
  try {
    const runnerSummary = parseJson(materials.runnerSummary, 'runner summary')
    const gateSummary = parseJson(materials.gateSummary, 'gate summary')
    const budgetEvents = parseJsonLines(materials.budgetEvents, 'budget events')
    const runner = idFrom(runnerSummary, ['runId', 'runnerRunId'], 'runnerSummary', issues)
    const gate = idFrom(gateSummary, ['runId', 'gateRunId'], 'gateSummary', issues)
    const budget = idFrom(gateSummary, ['runId', 'budgetRunId'], 'gateSummary', issues)
    check(checks, 'runner-completed', runnerSummary.status === 'completed', 'runner status must be completed; got ' + String(runnerSummary.status))
    if (runnerSummary.status !== undefined && runnerSummary.status !== 'completed') contradicted = true
    check(checks, 'gate-host-started', gateSummary.hostStarted === true, 'gate summary hostStarted=' + String(gateSummary.hostStarted))
    if (gateSummary.hostStarted === false) contradicted = true
    if (runnerSummary.hostStarted !== undefined) {
      check(checks, 'runner-host-started', runnerSummary.hostStarted === true, 'runner summary hostStarted=' + String(runnerSummary.hostStarted))
      if (runnerSummary.hostStarted === false) contradicted = true
    }
    const eventIds = []
    for (const [index, event] of budgetEvents.entries()) {
      const eventId = idFrom(event, ['runId', 'budgetRunId'], 'budgetEvents[' + String(index) + ']', issues)
      if (eventId.conflict) contradicted = true
      if (eventId.id === null) issue(issues, 'BUDGET_IDENTITY_MISSING', 'budget event ' + String(index) + ' has no run identity')
      else eventIds.push(eventId.id)
    }
    const budgetIds = [...new Set(eventIds)]
    if (budgetIds.length > 1) {
      issue(issues, 'BUDGET_IDENTITY_CONFLICT', 'budget events disagree on run identity')
      contradicted = true
    }
    if (budgetIds.length !== 1 || typeof budgetIds[0] !== 'string' || budgetIds[0].trim() === '') {
      issue(issues, 'BUDGET_IDENTITY_INVALID', 'budget events must carry exactly one non-empty run identity')
    }
    const budgetEventsId = budgetIds.length === 1 ? budgetIds[0] : null
    runnerId = runner.id; gateId = gate.id; budgetId = budget.id
    check(checks, 'independent-runner-id', runnerId !== null, 'runner summary runId is required')
    check(checks, 'independent-gate-id', gateId !== null, 'gate summary runId is required')
    check(checks, 'independent-budget-id', budgetId !== null && budgetEventsId !== null, 'gate summary and budget events runId are required')
    check(checks, 'independent-id-agreement', runnerId !== null && gateId !== null && budgetId !== null && budgetEventsId !== null && runnerId === runnerReceipt?.runnerRunId && gateId === gateReceipt?.gateRunId && budgetId === gateReceipt?.budgetRunId && budgetId === budgetEventsId, 'runner/gate/budget sources and receipts must agree')
    if (runnerId !== null && gateId !== null && budgetId !== null && budgetEventsId !== null && (runnerId !== runnerReceipt?.runnerRunId || gateId !== gateReceipt?.gateRunId || budgetId !== gateReceipt?.budgetRunId || budgetId !== budgetEventsId)) contradicted = true
    if (gateId !== null && budgetId !== null && gateId === budgetId) {
      // The gate summary may carry the same runId for both roles; that is not a conflict.
    }
  } catch (error) {
    issue(issues, 'INDEPENDENT_MATERIAL_INVALID', String(error.message))
  }

  // 5. Ledger completeness and the protocol-level identity join.
  try {
    const ledger = parseJson(materials.ledger, 'ledger')
    check(checks, 'ledger-schema', ledger.schema === 'tla.run-ledger/v2', 'ledger schema=' + String(ledger.schema))
    check(checks, 'ledger-complete', ledger.complete === true && Array.isArray(ledger.incompleteRuns) && ledger.incompleteRuns.length === 0 && Array.isArray(ledger.inconsistent) && ledger.inconsistent.length === 0, 'ledger must be complete with no incomplete/inconsistent runs')
    if (ledger.complete !== true || (Array.isArray(ledger.incompleteRuns) && ledger.incompleteRuns.length > 0)) contradicted = true
    check(checks, 'ledger-upstream-over-gate', Array.isArray(ledger.upstreamOverGate) && ledger.upstreamOverGate.length === 0, 'ledger upstreamOverGate must be an empty array')
    if (Array.isArray(ledger.upstreamOverGate) && ledger.upstreamOverGate.length > 0) contradicted = true
    if (Array.isArray(ledger.inconsistent) && ledger.inconsistent.length > 0) contradicted = true
    limitations.push('tla.run-ledger/v2 has no runner/gate run IDs; ledger completeness is checked, but ledger-to-receipt identity is structural, not independently bound')
  } catch (error) {
    issue(issues, 'LEDGER_INVALID', String(error.message))
  }

  // 6. Journal / trace / receipt identity must all describe one launch.
  if (journal && trace && runnerReceipt && gateReceipt) {
    const claim = trace.header.bindingClaim
    const identityChecks = [
      ['journal-runner', journal.identity?.runnerRunId, runnerReceipt.runnerRunId, runnerId],
      ['journal-launch', journal.identity?.launchId, runnerReceipt.launchId, runnerReceipt.launchId],
      ['journal-gate', journal.identity?.gateRunId, gateReceipt.gateRunId, gateId],
      ['journal-budget', journal.identity?.budgetRunId, gateReceipt.budgetRunId, budgetId],
      ['trace-runner', claim.runnerRunId, runnerReceipt.runnerRunId, runnerId],
      ['trace-gate', claim.gateRunId, gateReceipt.gateRunId, gateId],
      ['trace-budget', claim.budgetRunId, gateReceipt.budgetRunId, budgetId],
      ['trace-launch', claim.launchId, runnerReceipt.launchId, runnerReceipt.launchId]
    ]
    for (const [name, left, right, independent] of identityChecks) {
      const ok = left !== null && left !== undefined && right !== null && right !== undefined && independent !== null && left === right && left === independent
      check(checks, 'identity-' + name, ok, name + ' does not join the journal, trace, receipt and independent source')
      if (!ok && left !== null && left !== undefined && right !== null && right !== undefined && independent !== null) contradicted = true
    }
    check(checks, 'trace-journal-id', trace.header.traceId === journal.identity?.traceId, 'traceId must match the journal')
    if (trace.header.traceId !== journal.identity?.traceId) contradicted = true
    check(checks, 'journal-origin', journal.identity?.origin === 'host-notification', 'journal origin=' + String(journal.identity?.origin))
    if (journal.identity?.origin !== 'host-notification') contradicted = true
  }

  const missing = checks.filter((entry) => !entry.ok)
  const status = contradicted ? 'failed' : (issues.length > 0 || missing.length > 0 ? 'incomplete' : 'probe-passed')
  return report(checks, issues, status, bindingStatus, limitations)
}

function report (checks, issues, status, binding, limitations) {
  return {
    schema: MOUNT_PROBE_SCHEMA,
    scope: MOUNT_PROBE_SCOPE,
    status,
    hostVerified: false,
    coverage: 'unknown',
    binding: { status: binding, source: binding === 'consistent' ? 'b0' : null },
    checks,
    issues,
    limitations,
    closed: false
  }
}

export function readMountProbeInput (path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ProbeError('INPUT_UNREADABLE', 'mount probe input could not be read: ' + String(error.message))
  }
  return parsed
}
