import { readFileSync } from 'node:fs'

export const MOUNT_PROBE_SCHEMA = 'tla.observer-mount-probe/v1'
export const MOUNT_PROBE_INPUT_SCHEMA = 'tla.observer-mount-probe-input/v1'
export const MOUNT_PROBE_SCOPE = 'mount-probe'
export const MOUNT_PROBE_STATUSES = Object.freeze(['probe-passed', 'incomplete', 'failed'])

const REQUIRED_PHASES = Object.freeze(['preparing', 'attached', 'stopping', 'stopped'])
const SAFE_TRACE_KEYS = new Set(['schema', 'seq', 'at', 'event', 'sessionId', 'callId', 'toolName', 'outcome', 'valueState', 'process', 'receiptSeq'])

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

function journalRecords (journal) {
  if (!isObject(journal) || !Array.isArray(journal.records)) return []
  return journal.records
}

function traceObservations (trace) {
  if (!isObject(trace) || !Array.isArray(trace.observations)) return []
  return trace.observations
}

function hasForbiddenText (value) {
  if (typeof value !== 'string') return false
  return /(?:[A-Za-z]:\\|sk-[A-Za-z0-9]|BEGIN PRIVATE|api[_-]?key|password|token)/iu.test(value)
}

function traceKeySafe (observation) {
  if (!isObject(observation)) return false
  return Object.keys(observation).every((key) => SAFE_TRACE_KEYS.has(key))
}

/**
 * Evaluate synthetic mount evidence. This never reads a real profile, host or
 * model service; it is an offline consistency check for the probe report.
 */
export function evaluateMountProbe (input) {
  const checks = []
  if (!isObject(input) || input.schema !== MOUNT_PROBE_INPUT_SCHEMA) {
    return report([], [{ code: 'INPUT_SCHEMA', detail: 'input schema must be ' + MOUNT_PROBE_INPUT_SCHEMA }], 'incomplete')
  }
  let contradicted = false
  const records = journalRecords(input.journal)
  const phases = records.map((record) => record?.phase)
  check(checks, 'journal-present', records.length > 0, 'lifecycle journal records=' + String(records.length))
  const attached = phases.includes('attached')
  const stopped = phases.includes('stopped')
  check(checks, 'journal-attached', attached, 'attached phase is required')
  check(checks, 'journal-stopped', stopped, 'stopped phase is required')
  if (phases.includes('failed')) contradicted = true
  check(checks, 'journal-no-failed', !phases.includes('failed'), 'failed lifecycle phase blocks the probe')
  const order = REQUIRED_PHASES.every((phase, index) => phases.indexOf(phase) >= 0 && (index === 0 || phases.indexOf(phase) > phases.indexOf(REQUIRED_PHASES[index - 1])))
  check(checks, 'journal-order', order, 'preparing < attached < stopping < stopped')

  const trace = input.trace
  check(checks, 'trace-present', isObject(trace), 'trace object is required')
  check(checks, 'trace-header', isObject(trace?.header) && trace.header.schema === 'tla.tool-metadata-trace/v1', 'trace header schema is required')
  const origin = trace?.header?.origin
  check(checks, 'trace-origin', origin === 'host-notification', 'non-degraded host-notification origin is required; got ' + String(origin))
  if (origin !== 'host-notification') contradicted = true
  const observations = traceObservations(trace)
  const read = observations.filter((entry) => entry?.event === 'tool/result' && entry.toolName === 'read')
  const pwsh = observations.filter((entry) => entry?.event === 'tool/result' && entry.toolName === 'pwsh')
  check(checks, 'trace-read', read.length >= 1, 'a read result is required')
  check(checks, 'trace-pwsh', pwsh.length >= 1, 'a foreground pwsh result is required')
  const unexpected = observations.filter((entry) => entry?.event === 'tool/result' && !['read', 'pwsh'].includes(entry.toolName))
  check(checks, 'trace-tools', unexpected.length === 0, 'only read and pwsh results are allowed; unexpected=' + String(unexpected.length))

  const receipts = input.receipts
  check(checks, 'receipts-present', isObject(receipts?.runner) && isObject(receipts?.gate), 'both runner and gate receipts are required')
  const binding = input.binding
  check(checks, 'binding-consistent', binding === 'consistent', 'B0 binding must be consistent; got ' + String(binding))
  if (binding === 'inconsistent') contradicted = true

  const ledger = input.ledger
  check(checks, 'ledger-complete', ledger?.completeness === 'complete', 'ledger completeness must be complete')
  if (ledger?.completeness === 'incomplete' || ledger?.completeness === 'invalid') contradicted = true
  const runnerId = input.runner?.runId
  const gateId = input.gate?.runId
  check(checks, 'ledger-identity', typeof runnerId === 'string' && typeof gateId === 'string' && input.ledger?.runnerRunId === runnerId && input.ledger?.gateRunId === gateId, 'ledger must bind the runner and gate run identities')

  check(checks, 'cleanup-empty', input.cleanup?.residual === false, 'observer cleanup must report no residual files')
  if (input.cleanup?.residual === true) contradicted = true
  const unsafe = observations.filter((entry) => hasForbiddenText(JSON.stringify(entry)) || !traceKeySafe(entry))
  check(checks, 'dto-safe', unsafe.length === 0, 'trace entries must contain only safe fields and no absolute/private text')
  if (unsafe.length > 0) contradicted = true

  const missing = checks.filter((entry) => !entry.ok).map((entry) => entry.code)
  const status = contradicted ? 'failed' : (missing.length > 0 ? 'incomplete' : 'probe-passed')
  return report(checks, [], status, input.binding === 'consistent' ? { status: 'consistent', source: 'b0' } : { status: 'unproven' })
}

function report (checks, issues, status, binding = { status: 'unproven' }) {
  return {
    schema: MOUNT_PROBE_SCHEMA,
    scope: MOUNT_PROBE_SCOPE,
    status,
    hostVerified: false,
    coverage: 'unknown',
    binding,
    checks,
    issues,
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
