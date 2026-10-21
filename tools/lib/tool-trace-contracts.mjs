// Strict contracts and side-effect-free inspection for the B1 passive tool trace.
// This module never imports a host module, writes a file, or calls acceptance.
import { isId, isUuid } from './launch-receipts.mjs';

export const TRACE_SCHEMA = 'tla.tool-metadata-trace/v1';
export const REPORT_SCHEMA = 'tla.tool-metadata-report/v1';
export const TRACE_ORIGINS = Object.freeze(['simulated-dispatcher', 'host-notification']);
export const SOURCES = Object.freeze(['tools/result', 'session/event']);
export const EVENTS = Object.freeze(['call', 'result']);
export const OUTCOMES = Object.freeze(['success', 'error', 'unknown']);
export const VALUE_STATES = Object.freeze(['absent', 'present', 'unknown']);
export const TRACE_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxObservations: 10_000,
  maxPending: 1_000,
  maxRecordBytes: 16 * 1024,
  maxDiagnostics: 128,
  footerReserveBytes: 64 * 1024,
  minMaxBytes: 128 * 1024
});
export const DIAGNOSTIC_CODES = Object.freeze([
  'FIELD_UNAVAILABLE', 'FIELD_INVALID', 'CALL_UNPAIRED', 'RESULT_UNPAIRED',
  'CALL_IDENTITY_MISSING', 'CALL_CONFLICT', 'RESULT_CONFLICT',
  'SOURCE_LINK_AMBIGUOUS', 'LIMIT_REACHED', 'WRITE_FAILED',
  'SUBSCRIBE_FAILED', 'UNSUBSCRIBE_FAILED', 'NORMALIZATION_FAILED'
]);
export const REPORT_DIAGNOSTIC_CODES = Object.freeze([
  ...DIAGNOSTIC_CODES, 'INPUT_INVALID', 'INPUT_IO_FAILED', 'HEADER_INVALID',
  'RECORD_INVALID', 'FOOTER_MISSING', 'FOOTER_INVALID', 'SEQUENCE_INVALID',
  'TRAILING_DATA', 'EXACT_REPLAY'
]);
const DEGRADING = new Set(['FIELD_INVALID', 'CALL_UNPAIRED', 'RESULT_UNPAIRED',
  'CALL_IDENTITY_MISSING', 'CALL_CONFLICT', 'RESULT_CONFLICT',
  'SOURCE_LINK_AMBIGUOUS', 'LIMIT_REACHED', 'WRITE_FAILED', 'SUBSCRIBE_FAILED',
  'UNSUBSCRIBE_FAILED', 'NORMALIZATION_FAILED', 'SEQUENCE_INVALID',
  'TRAILING_DATA', 'FOOTER_MISSING', 'FOOTER_INVALID', 'RECORD_INVALID']);
const HEADER_KEYS = ['schema', 'kind', 'traceId', 'origin', 'scope', 'bindingClaim', 'order', 'coverage'];
const BINDING_KEYS = ['runnerRunId', 'launchId', 'gateRunId', 'budgetRunId'];
const OBS_KEYS = ['kind', 'receiptSeq', 'source', 'event', 'sessionId', 'callId', 'rootCallId', 'toolName', 'sourceSeq', 'outcome', 'valueState', 'process'];
const PROCESS_KEYS = ['exitCode', 'signal', 'timedOut', 'aborted', 'stdoutTruncated', 'stderrTruncated'];
const FOOTER_KEYS = ['kind', 'traceId', 'observationsWritten', 'captureState', 'diagnostics', 'diagnosticsDropped'];
const DIAG_KEYS = ['code', 'receiptSeq', 'count'];

export class TraceError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'TraceError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) { throw new TraceError(code, detail); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) {
  if (!plain(value)) fail('RECORD_INVALID', `${label} must be an object`);
  const actual = Object.keys(value);
  for (const key of actual) if (!keys.includes(key)) fail('RECORD_INVALID', `${label} has unknown field ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail('RECORD_INVALID', `${label} is missing ${key}`);
}
function utf8Length(value) { return Buffer.byteLength(value, 'utf8'); }
function safeInt(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function identifier(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || value.length === 0) fail('FIELD_INVALID', `${label} must be a nonempty string`);
  if (utf8Length(value) > 128) fail('FIELD_INVALID', `${label} exceeds 128 UTF-8 bytes`);
  if (value !== value.trim()) fail('FIELD_INVALID', `${label} has leading or trailing whitespace`);
  if (/[\u0000-\u001F\u007F]/u.test(value)) fail('FIELD_INVALID', `${label} has control characters`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    fail('FIELD_INVALID', `${label} has an unpaired surrogate`);
  }
}
function optionalId(value, label) {
  if (value === null) return;
  identifier(value, label);
}
function processValue(value) {
  if (value === null) return;
  exact(value, PROCESS_KEYS, 'process');
  if (!(value.exitCode === null || safeInt(value.exitCode, Number.MIN_SAFE_INTEGER))) fail('FIELD_INVALID', 'process.exitCode');
  if (value.signal !== null) identifier(value.signal, 'process.signal');
  for (const key of ['timedOut', 'aborted', 'stdoutTruncated', 'stderrTruncated']) {
    if (!(value[key] === null || typeof value[key] === 'boolean')) fail('FIELD_INVALID', `process.${key}`);
  }
}
function processKey(value) {
  if (value === null) return 'null';
  return PROCESS_KEYS.map((key) => JSON.stringify(value[key])).join(',');
}

export function validateBindingClaim(value) {
  exact(value, BINDING_KEYS, 'bindingClaim');
  for (const key of BINDING_KEYS) {
    if (value[key] !== null) {
      if (!isId(value[key])) fail('FIELD_INVALID', `bindingClaim.${key}`);
      if (key === 'launchId' && !isUuid(value[key])) fail('FIELD_INVALID', 'bindingClaim.launchId');
    }
  }
  return value;
}

export function validateHeader(value) {
  exact(value, HEADER_KEYS, 'header');
  if (value.schema !== TRACE_SCHEMA || value.kind !== 'header') fail('HEADER_INVALID', 'schema/kind');
  if (!isUuid(value.traceId)) fail('HEADER_INVALID', 'traceId must be a canonical UUID v4');
  if (!TRACE_ORIGINS.includes(value.origin)) fail('HEADER_INVALID', 'origin');
  if (value.scope !== 'tool-metadata-only') fail('HEADER_INVALID', 'scope');
  validateBindingClaim(value.bindingClaim);
  if (value.order !== 'observer-delivery-only') fail('HEADER_INVALID', 'order');
  if (value.coverage !== 'unknown') fail('HEADER_INVALID', 'coverage');
  return value;
}

export function validateObservation(value, { expectedSeq = null } = {}) {
  exact(value, OBS_KEYS, 'observation');
  if (value.kind !== 'observation') fail('RECORD_INVALID', 'kind');
  if (!safeInt(value.receiptSeq, 1)) fail('SEQUENCE_INVALID', 'receiptSeq');
  if (expectedSeq !== null && value.receiptSeq !== expectedSeq) fail('SEQUENCE_INVALID', `expected ${expectedSeq}, got ${value.receiptSeq}`);
  if (!SOURCES.includes(value.source) || !EVENTS.includes(value.event)) fail('FIELD_INVALID', 'source/event');
  if (value.source === 'tools/result' && value.event !== 'result') fail('FIELD_INVALID', 'tools/result only permits result');
  optionalId(value.sessionId, 'sessionId');
  optionalId(value.callId, 'callId');
  optionalId(value.rootCallId, 'rootCallId');
  optionalId(value.toolName, 'toolName');
  if (!(value.sourceSeq === null || safeInt(value.sourceSeq, 0))) fail('FIELD_INVALID', 'sourceSeq');
  if (!OUTCOMES.includes(value.outcome) || !VALUE_STATES.includes(value.valueState)) fail('FIELD_INVALID', 'outcome/valueState');
  if (value.event === 'call' && (value.outcome !== 'unknown' || value.valueState !== 'absent')) {
    fail('FIELD_INVALID', 'call requires outcome=unknown and valueState=absent');
  }
  processValue(value.process);
  return value;
}

export function validateDiagnostic(value) {
  exact(value, DIAG_KEYS, 'diagnostic');
  if (!DIAGNOSTIC_CODES.includes(value.code)) fail('FOOTER_INVALID', 'diagnostic code');
  if (!(value.receiptSeq === null || safeInt(value.receiptSeq, 1))) fail('FOOTER_INVALID', 'diagnostic receiptSeq');
  if (!safeInt(value.count, 1)) fail('FOOTER_INVALID', 'diagnostic count');
  return value;
}

export function validateFooter(value, { traceId = null } = {}) {
  exact(value, FOOTER_KEYS, 'footer');
  if (value.kind !== 'footer') fail('FOOTER_INVALID', 'kind');
  if (traceId !== null && value.traceId !== traceId) fail('FOOTER_INVALID', 'footer identity');
  if (!safeInt(value.observationsWritten, 0)) fail('FOOTER_INVALID', 'observationsWritten');
  if (!['finalized', 'degraded'].includes(value.captureState)) fail('FOOTER_INVALID', 'captureState');
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > TRACE_LIMITS.maxDiagnostics) fail('FOOTER_INVALID', 'diagnostics count');
  for (const item of value.diagnostics) validateDiagnostic(item);
  if (!safeInt(value.diagnosticsDropped, 0)) fail('FOOTER_INVALID', 'diagnosticsDropped');
  return value;
}

function decodeLines(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('INPUT_INVALID', 'trace must be bytes');
  if (bytes.length > TRACE_LIMITS.maxBytes) fail('INPUT_INVALID', 'trace exceeds byte limit');
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) fail('INPUT_INVALID', 'BOM is not allowed');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('INPUT_INVALID', 'trace is not valid UTF-8'); }
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.some((line) => line.length === 0)) fail('INPUT_INVALID', 'blank line is not allowed');
  return lines;
}

function record(line, expectedSeq) {
  let value;
  try { value = JSON.parse(line); }
  catch { fail('RECORD_INVALID', 'line is not JSON'); }
  if (!plain(value)) fail('RECORD_INVALID', 'record is not an object');
  if (value.kind === 'header') return { kind: 'header', value: validateHeader(value) };
  if (value.kind === 'footer') return { kind: 'footer', value: validateFooter(value) };
  if (value.kind === 'observation') return { kind: 'observation', value: validateObservation(value, { expectedSeq }) };
  fail('RECORD_INVALID', 'unknown record kind');
}

function diag(code, receiptSeq, count = 1) { return { code, receiptSeq, count }; }
function addDiag(list, code, receiptSeq, count = 1) {
  const found = list.find((item) => item.code === code && item.receiptSeq === receiptSeq);
  if (found) found.count += count;
  else list.push(diag(code, receiptSeq, count));
}

function recordBytes(line) { return Buffer.byteLength(line, 'utf8') + 1; }

export function inspectTraceBytes(bytes, { maxPending = TRACE_LIMITS.maxPending } = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > TRACE_LIMITS.maxPending) {
    fail('INPUT_INVALID', 'maxPending is invalid');
  }
  const lines = decodeLines(bytes);
  if (lines.length === 0) fail('INPUT_INVALID', 'trace is empty');
  const first = record(lines[0], null);
  if (first.kind !== 'header') fail('HEADER_INVALID', 'first record is not a header');
  if (lines.length === 1) fail('FOOTER_MISSING', 'trace has no footer');
  const earlierFooter = lines.slice(0, -1).some((line) => {
    try { return JSON.parse(line).kind === 'footer'; } catch { return false; }
  });
  if (earlierFooter) fail('TRAILING_DATA', 'records exist after the footer');
  let last;
  try {
    last = record(lines[lines.length - 1], null);
  } catch (error) {
    if (lines[lines.length - 1].includes('"kind":"footer"')) fail('FOOTER_INVALID', 'footer is malformed');
    throw error;
  }
  if (last.kind !== 'footer') fail('FOOTER_MISSING', 'last record is not a footer');
  if (recordBytes(lines[0]) > TRACE_LIMITS.maxRecordBytes) fail('HEADER_INVALID', 'header exceeds 16 KiB');
  if (recordBytes(lines[lines.length - 1]) > TRACE_LIMITS.maxRecordBytes) fail('FOOTER_INVALID', 'footer exceeds 16 KiB');
  validateFooter(last.value, { traceId: first.value.traceId });
  if (last.value.observationsWritten !== lines.length - 2) fail('FOOTER_INVALID', 'observationsWritten does not match');
  if (lines.length - 2 > TRACE_LIMITS.maxObservations) fail('INPUT_INVALID', 'observation limit exceeded');
  let total = recordBytes(lines[0]) + recordBytes(lines[lines.length - 1]);
  const observations = [];
  for (let index = 1; index < lines.length - 1; index += 1) {
    total += recordBytes(lines[index]);
    if (total > TRACE_LIMITS.maxBytes) fail('INPUT_INVALID', 'trace exceeds byte limit');
    if (Buffer.byteLength(lines[index], 'utf8') > TRACE_LIMITS.maxRecordBytes) fail('RECORD_INVALID', 'record exceeds 16 KiB');
    const parsed = record(lines[index], index);
    if (parsed.kind !== 'observation') fail('RECORD_INVALID', 'interior record is not an observation');
    observations.push(parsed.value);
  }
  const diagnostics = last.value.diagnostics.map((item) => ({ ...item }));
  const counts = { observations: observations.length, calls: 0, results: 0, pairedCalls: 0, exactReplays: 0 };
  const calls = new Map();
  const results = new Map();
  const pending = new Set();
  const seen = new Map();
  for (const obs of observations) {
    if (obs.event === 'call') counts.calls += 1;
    else counts.results += 1;
    const identity = [obs.source, obs.sessionId, obs.callId, obs.rootCallId, obs.event, obs.toolName, obs.sourceSeq,
      obs.outcome, obs.valueState, processKey(obs.process)].join('\u0000');
    const previous = seen.get(identity);
    if (previous !== undefined) {
      counts.exactReplays += 1;
      addDiag(diagnostics, 'EXACT_REPLAY', obs.receiptSeq);
      continue;
    }
    seen.set(identity, obs.receiptSeq);
    if (obs.callId === null || obs.sessionId === null) {
      addDiag(diagnostics, 'CALL_IDENTITY_MISSING', obs.receiptSeq);
      continue;
    }
    const key = `${obs.sessionId}\u0000${obs.callId}`;
    if (!pending.has(key)) {
      if (pending.size >= maxPending) {
        addDiag(diagnostics, 'LIMIT_REACHED', obs.receiptSeq);
        continue;
      }
      pending.add(key);
    }
    if (obs.event === 'call') {
      if (calls.has(key)) {
        addDiag(diagnostics, calls.get(key).source === obs.source ? 'CALL_CONFLICT' : 'SOURCE_LINK_AMBIGUOUS', obs.receiptSeq);
      } else {
        calls.set(key, obs);
      }
    } else if (results.has(key)) {
      addDiag(diagnostics, results.get(key).source === obs.source ? 'RESULT_CONFLICT' : 'SOURCE_LINK_AMBIGUOUS', obs.receiptSeq);
    } else {
      results.set(key, obs);
    }
    if (calls.has(key) && results.has(key)) pending.delete(key);
  }
  for (const key of calls.keys()) if (!results.has(key)) addDiag(diagnostics, 'CALL_UNPAIRED', calls.get(key).receiptSeq);
  for (const key of results.keys()) if (!calls.has(key)) addDiag(diagnostics, 'RESULT_UNPAIRED', results.get(key).receiptSeq);
  for (const [key, call] of calls) {
    const result = results.get(key);
    if (result === undefined) continue;
    if (call.toolName !== null && result.toolName !== null && call.toolName !== result.toolName) {
      addDiag(diagnostics, 'CALL_CONFLICT', result.receiptSeq);
    }
    if (call.rootCallId !== null && result.rootCallId !== null && call.rootCallId !== result.rootCallId) {
      addDiag(diagnostics, 'CALL_CONFLICT', result.receiptSeq);
    }
  }
  counts.pairedCalls = [...calls.keys()].filter((key) => results.has(key)).length;
  if (last.value.diagnosticsDropped > 0) {
    addDiag(diagnostics, 'LIMIT_REACHED', null);
  }
  if (diagnostics.length > TRACE_LIMITS.maxDiagnostics) fail('FOOTER_INVALID', 'diagnostics exceed limit');
  const degraded = last.value.captureState === 'degraded' || last.value.diagnosticsDropped > 0
    || diagnostics.some((item) => DEGRADING.has(item.code));
  return {
    status: degraded ? 'INCOMPLETE' : 'VALID_METADATA',
    hostVerified: false,
    coverage: 'unknown',
    origin: first.value.origin,
    traceId: first.value.traceId,
    binding: { status: 'unproven', claim: first.value.bindingClaim },
    counts,
    diagnostics
  };
}

export function makeReport(base) {
  return {
    schema: REPORT_SCHEMA,
    scope: 'tool-metadata-only',
    status: base.status,
    hostVerified: false,
    coverage: 'unknown',
    origin: base.origin ?? null,
    traceId: base.traceId ?? null,
    binding: base.binding ?? { status: 'unproven', claim: null },
    counts: base.counts,
    diagnostics: base.diagnostics
  };
}

export function emptyCounts() { return { observations: 0, calls: 0, results: 0, pairedCalls: 0, exactReplays: 0 }; }
