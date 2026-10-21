// tla.observer-lifecycle/v1: bounded, exclusive JSONL journal for the offline
// observer entry. Importing this module has no side effects. It deliberately
// records local lifecycle facts only; it is not a business verdict, budget
// lease, authentication token or proof of host coverage.
import { closeSync, openSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  TRACE_ORIGINS, TraceError
} from '../../tools/lib/tool-trace-contracts.mjs';
import { isId, isUuid } from '../../tools/lib/launch-receipts.mjs';

export const LIFECYCLE_SCHEMA = 'tla.observer-lifecycle/v1';
export const LIFECYCLE_PHASES = Object.freeze(['preparing', 'attached', 'stopping', 'stopped', 'failed']);
export const LIFECYCLE_CODES = Object.freeze([
  'CONFIG_INVALID', 'PATH_BLOCKED', 'ATTACH_FAILED', 'WRITE_FAILED',
  'CLEANUP_FAILED', 'CLEANUP_TIMEOUT', 'CLOSE_FAILED'
]);
export const CLEANUP_STATES = Object.freeze(['not-started', 'pending', 'settled', 'failed', 'timeout']);
export const LIFECYCLE_LIMITS = Object.freeze({
  maxRecords: 16,
  maxBytes: 64 * 1024,
  maxRecordBytes: 4 * 1024
});

function fail(code, detail) { throw new TraceError(code, detail); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) {
  if (!plain(value)) fail('JOURNAL_INVALID', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('JOURNAL_INVALID', `${label} has an invalid field set`);
  }
}
function safeInt(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}
function validCode(value) { return value === null || LIFECYCLE_CODES.includes(value); }
function validHealth(value) {
  if (value === null) return true;
  if (!plain(value)) return false;
  try {
    exact(value, ['writerOk', 'cleanupState', 'ownershipUncertain'], 'health');
    return (value.writerOk === null || typeof value.writerOk === 'boolean')
      && CLEANUP_STATES.includes(value.cleanupState)
      && typeof value.ownershipUncertain === 'boolean';
  } catch { return false; }
}

function validateIdentity(identity) {
  exact(identity, ['traceId', 'origin', 'runnerRunId', 'launchId', 'gateRunId', 'budgetRunId'], 'identity');
  if (typeof identity.traceId !== 'string' || !isUuid(identity.traceId)) fail('CONFIG_INVALID', 'traceId must be UUID v4');
  if (!TRACE_ORIGINS.includes(identity.origin)) fail('CONFIG_INVALID', 'origin is invalid');
  for (const key of ['runnerRunId', 'gateRunId', 'budgetRunId']) {
    if (!isId(identity[key])) fail('CONFIG_INVALID', `${key} is invalid`);
  }
  if (!isUuid(identity.launchId)) fail('CONFIG_INVALID', 'launchId must be UUID v4');
  if (identity.gateRunId !== identity.budgetRunId) fail('CONFIG_INVALID', 'gateRunId and budgetRunId must agree');
  return identity;
}

function recordValue({ seq, phase, identity, observerPid, code, health }) {
  if (!LIFECYCLE_PHASES.includes(phase)) fail('JOURNAL_INVALID', 'phase is invalid');
  if (!safeInt(seq, 1)) fail('JOURNAL_INVALID', 'seq must be a positive safe integer');
  if (!isPid(observerPid)) fail('JOURNAL_INVALID', 'observerPid is invalid');
  if (!validCode(code)) fail('JOURNAL_INVALID', 'code is invalid');
  if (!validHealth(health)) fail('JOURNAL_INVALID', 'health is invalid');
  return {
    schema: LIFECYCLE_SCHEMA,
    seq,
    phase,
    traceId: identity.traceId,
    origin: identity.origin,
    runnerRunId: identity.runnerRunId,
    launchId: identity.launchId,
    gateRunId: identity.gateRunId,
    budgetRunId: identity.budgetRunId,
    observerPid,
    code,
    health
  };
}

function isPid(value) { return Number.isSafeInteger(value) && value > 0 && value <= 0xFFFFFFFF; }

export function createLifecycleJournal({
  file,
  identity,
  observerPid = process.pid,
  io = { openSync, writeSync, closeSync }
} = {}) {
  if (typeof file !== 'string' || file.length === 0) fail('CONFIG_INVALID', 'lifecycle file is required');
  validateIdentity(identity);
  let fd = null;
  let seq = 0;
  let bytes = 0;
  let stopped = false;
  let failed = false;
  let attached = false;
  let stoppingSeen = false;
  let final = false;

  function encode(value) {
    const line = JSON.stringify(value);
    const size = Buffer.byteLength(line, 'utf8');
    if (size > LIFECYCLE_LIMITS.maxRecordBytes) fail('JOURNAL_INVALID', 'record exceeds 4 KiB');
    if (bytes + size + 1 > LIFECYCLE_LIMITS.maxBytes) fail('JOURNAL_INVALID', 'journal exceeds 64 KiB');
    return `${line}\n`;
  }

  function writeRecord(phase, code = null, health = null) {
    if (fd === null) fail('WRITE_FAILED', 'journal is not open');
    if (final) fail('WRITE_FAILED', 'journal already has a final record');
    if (phase === 'preparing') {
      if (seq !== 0) fail('WRITE_FAILED', 'preparing must be first');
    } else if (phase === 'attached') {
      if (seq === 0 || attached || failed) fail('WRITE_FAILED', 'attached transition is invalid');
      if (code !== null || health !== null) fail('WRITE_FAILED', 'attached record must not carry failure');
    } else if (phase === 'stopping') {
      if (!attached || stopped || failed) fail('WRITE_FAILED', 'stopping transition is invalid');
      if (code !== null || health !== null) fail('WRITE_FAILED', 'stopping record must not carry failure');
    } else if (phase === 'stopped') {
      if (!attached || stopped || failed) fail('WRITE_FAILED', 'stopped transition is invalid');
      if (!stoppingSeen) fail('WRITE_FAILED', 'stopping must precede stopped');
      if (code !== null || health === null || health.writerOk !== true
        || health.cleanupState !== 'settled' || health.ownershipUncertain !== false) {
        fail('WRITE_FAILED', 'stopped requires successful terminal health');
      }
    } else if (phase === 'failed') {
      if (final) fail('WRITE_FAILED', 'failed transition is invalid');
    }
    if (seq + 1 > LIFECYCLE_LIMITS.maxRecords) fail('JOURNAL_INVALID', 'journal exceeds 16 records');
    const value = recordValue({ seq: seq + 1, phase, identity, observerPid, code, health });
    const line = encode(value);
    try { io.writeSync(fd, line); } catch { fail('WRITE_FAILED', 'journal write failed'); }
    seq += 1;
    bytes += Buffer.byteLength(line, 'utf8');
    if (phase === 'attached') attached = true;
    if (phase === 'stopping') stoppingSeen = true;
    if (phase === 'stopped') { stopped = true; final = true; }
    if (phase === 'failed') { failed = true; final = true; }
    return { seq, phase };
  }

  function open() {
    if (fd !== null) fail('WRITE_FAILED', 'journal is already open');
    try { fd = io.openSync(file, 'wx'); } catch { fail('WRITE_FAILED', 'journal open failed'); }
    try { writeRecord('preparing'); } catch (error) {
      try { io.closeSync(fd); } catch { /* close is secondary */ }
      fd = null;
      throw error;
    }
    return { seq };
  }

  function close() {
    if (fd === null) return { ok: true, closeFailed: null };
    try { io.closeSync(fd); fd = null; return { ok: true, closeFailed: null }; }
    catch { fd = null; return { ok: false, closeFailed: 'CLOSE_FAILED' }; }
  }

  return {
    open,
    writeRecord,
    close,
    get seq() { return seq; },
    get attached() { return attached; },
    get stopped() { return stopped; },
    get failed() { return failed; }
  };
}

export function readLifecycle(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('JOURNAL_INVALID', 'journal must be bytes');
  if (bytes.length > LIFECYCLE_LIMITS.maxBytes) fail('JOURNAL_INVALID', 'journal exceeds 64 KiB');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('JOURNAL_INVALID', 'journal is not UTF-8'); }
  if (text.startsWith('\uFEFF')) fail('JOURNAL_INVALID', 'BOM is not allowed');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.length > LIFECYCLE_LIMITS.maxRecords) fail('JOURNAL_INVALID', 'record count is invalid');
  if (lines.some((line) => line.length === 0)) fail('JOURNAL_INVALID', 'blank line is not allowed');
  const records = [];
  let identity = null;
  let phaseState = { attached: false, stopping: false, stopped: false, failed: false, final: false };
  for (let index = 0; index < lines.length; index += 1) {
    if (Buffer.byteLength(lines[index], 'utf8') > LIFECYCLE_LIMITS.maxRecordBytes) fail('JOURNAL_INVALID', 'record exceeds 4 KiB');
    let value;
    try { value = JSON.parse(lines[index]); } catch { fail('JOURNAL_INVALID', 'record is not JSON'); }
    exact(value, ['schema', 'seq', 'phase', 'traceId', 'origin', 'runnerRunId', 'launchId', 'gateRunId', 'budgetRunId', 'observerPid', 'code', 'health'], 'record');
    if (value.schema !== LIFECYCLE_SCHEMA) fail('JOURNAL_INVALID', 'schema is invalid');
    if (value.seq !== index + 1) fail('JOURNAL_INVALID', 'sequence is not consecutive');
    if (!LIFECYCLE_PHASES.includes(value.phase)) fail('JOURNAL_INVALID', 'phase is invalid');
    if (!validCode(value.code) || !validHealth(value.health)) fail('JOURNAL_INVALID', 'code or health is invalid');
    if (!isPid(value.observerPid)) fail('JOURNAL_INVALID', 'observerPid is invalid');
    if (!isUuid(value.traceId)) fail('JOURNAL_INVALID', 'traceId is invalid');
    if (!TRACE_ORIGINS.includes(value.origin)) fail('JOURNAL_INVALID', 'origin is invalid');
    if (!isId(value.runnerRunId) || !isUuid(value.launchId) || !isId(value.gateRunId) || !isId(value.budgetRunId)) fail('JOURNAL_INVALID', 'identity is invalid');
    if (value.gateRunId !== value.budgetRunId) fail('JOURNAL_INVALID', 'gate/budget identity mismatch');
    if (identity === null) identity = { traceId: value.traceId, origin: value.origin, runnerRunId: value.runnerRunId, launchId: value.launchId, gateRunId: value.gateRunId, budgetRunId: value.budgetRunId };
    else if (identity.traceId !== value.traceId || identity.origin !== value.origin
      || identity.runnerRunId !== value.runnerRunId || identity.launchId !== value.launchId
      || identity.gateRunId !== value.gateRunId || identity.budgetRunId !== value.budgetRunId) fail('JOURNAL_INVALID', 'identity changes between records');
    if (index === 0) {
      if (value.phase !== 'preparing' || value.code !== null || value.health !== null) fail('JOURNAL_INVALID', 'first record must be preparing');
    } else if (value.phase === 'preparing') fail('JOURNAL_INVALID', 'preparing appears again');
    if (phaseState.final) fail('JOURNAL_INVALID', 'record after final phase');
    if (value.phase === 'attached') {
      if (phaseState.attached || phaseState.failed) fail('JOURNAL_INVALID', 'attached transition is invalid');
      if (value.code !== null || value.health !== null) fail('JOURNAL_INVALID', 'attached record has failure fields');
      phaseState.attached = true;
    } else if (value.phase === 'stopping') {
      if (!phaseState.attached || phaseState.stopped || phaseState.failed) fail('JOURNAL_INVALID', 'stopping transition is invalid');
      if (value.code !== null || value.health !== null) fail('JOURNAL_INVALID', 'stopping record has failure fields');
      phaseState.stopping = true;
    } else if (value.phase === 'stopped') {
      if (!phaseState.attached || !phaseState.stopping || phaseState.stopped || phaseState.failed) fail('JOURNAL_INVALID', 'stopped transition is invalid');
      if (value.code !== null || value.health === null || value.health.writerOk !== true
        || value.health.cleanupState !== 'settled' || value.health.ownershipUncertain !== false) fail('JOURNAL_INVALID', 'stopped health is invalid');
      phaseState.stopped = true; phaseState.final = true;
    } else if (value.phase === 'failed') {
      phaseState.failed = true; phaseState.final = true;
    }
    records.push({ ...value, health: value.health === null ? null : { ...value.health } });
  }
  if (!phaseState.final) fail('JOURNAL_INVALID', 'journal has no terminal phase');
  return { schema: LIFECYCLE_SCHEMA, records, identity, phase: records.at(-1).phase };
}
