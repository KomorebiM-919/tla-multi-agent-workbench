// B1 host-shaped adapter. This module is deliberately separate from the
// generic dispatcher adapter: the host seam uses positional (exec, result) and
// (session, event) callbacks. It never imports DSH, discovers a dispatcher or
// subscribes at import time. All fields are projections of the audited seam;
// unknown or malformed values stay null/unknown with a safe diagnostic.
import { TraceError } from '../../tools/lib/tool-trace-contracts.mjs';

const TOOLS_EVENT = 'tools/result';
const SESSION_EVENT = 'session/event';
const SUPPORTED_EVENTS = Object.freeze([TOOLS_EVENT, SESSION_EVENT]);
const ORIGIN = 'simulated-dispatcher';

function fail(code, detail) { throw new TraceError(code, detail); }

function read(value, key) {
  try { return value === null || value === undefined ? undefined : value[key]; }
  catch { return undefined; }
}

function own(value, key) {
  try { return Object.prototype.hasOwnProperty.call(value, key); }
  catch { return undefined; }
}

function add(set, code) { set.add(code); }

function identifierValue(value, diagnostics) {
  if (value === undefined || value === null) {
    add(diagnostics, 'FIELD_UNAVAILABLE');
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 128
    || value !== value.trim()
    || /[\u0000-\u001F\u007F]/u.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    || Buffer.byteLength(value, 'utf8') > 128) {
    add(diagnostics, 'FIELD_INVALID');
    return null;
  }
  return value;
}

function identity(value, label, diagnostics) {
  return identifierValue(value, diagnostics);
}

function optionalIdentity(value, label, diagnostics) {
  if (value === null || value === undefined) return null;
  return identifierValue(value, diagnostics);
}

function boolLeaf(value, diagnostics) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  add(diagnostics, 'FIELD_INVALID');
  return null;
}

function integerLeaf(value, diagnostics) {
  if (value === null || value === undefined) return null;
  if (Number.isSafeInteger(value)) return value;
  add(diagnostics, 'FIELD_INVALID');
  return null;
}

function sessionIdOf(exec, diagnostics) {
  const agent = read(exec, 'agent');
  const session = read(agent, 'session');
  const id = read(session, 'id');
  if (id === undefined || id === null) {
    add(diagnostics, 'FIELD_UNAVAILABLE');
    return null;
  }
  return identity(id, 'exec.agent.session.id', diagnostics);
}

function projectedProcess(result, toolName, outcome, diagnostics) {
  if (toolName !== 'pwsh' || outcome !== 'success') return null;
  const value = read(result, 'value');
  if (value === null || value === undefined) {
    add(diagnostics, 'FIELD_UNAVAILABLE');
    return null;
  }
  if (read(value, 'kind') !== 'foreground') return null;

  const signal = read(value, 'signal');
  const stdout = read(value, 'stdout');
  const stderr = read(value, 'stderr');
  if (stdout === null || stdout === undefined) add(diagnostics, 'FIELD_UNAVAILABLE');
  if (stderr === null || stderr === undefined) add(diagnostics, 'FIELD_UNAVAILABLE');

  return {
    exitCode: integerLeaf(read(value, 'exitCode'), diagnostics),
    signal: signal === null || signal === undefined ? null : identity(signal, 'process.signal', diagnostics),
    timedOut: boolLeaf(read(value, 'timedOut'), diagnostics),
    aborted: boolLeaf(read(value, 'aborted'), diagnostics),
    stdoutTruncated: boolLeaf(read(stdout, 'truncated'), diagnostics),
    stderrTruncated: boolLeaf(read(stderr, 'truncated'), diagnostics)
  };
}

export function projectHostToolsResultDetailed(exec, result) {
  const diagnostics = new Set();
  const toolName = identity(read(exec, 'name'), 'exec.name', diagnostics);
  const isError = read(result, 'isError');
  let outcome = 'unknown';
  if (isError === true) outcome = 'error';
  else if (isError === false) outcome = 'success';
  else if (isError !== undefined && isError !== null) add(diagnostics, 'FIELD_INVALID');

  const present = own(result, 'value');
  let valueState = 'unknown';
  if (present === true) valueState = 'present';
  else if (present === false) valueState = 'absent';
  else add(diagnostics, 'FIELD_UNAVAILABLE');

  const observation = {
    source: 'tools/result',
    event: 'result',
    sessionId: sessionIdOf(exec, diagnostics),
    callId: identity(read(exec, 'callId'), 'exec.callId', diagnostics),
    rootCallId: optionalIdentity(read(exec, 'rootCallId'), 'exec.rootCallId', diagnostics),
    toolName,
    sourceSeq: null,
    outcome,
    valueState,
    process: projectedProcess(result, toolName, outcome, diagnostics)
  };
  return { observation, diagnosticCodes: [...diagnostics] };
}

export function projectHostToolsResult(exec, result) {
  return projectHostToolsResultDetailed(exec, result).observation;
}

export function projectHostSessionEventDetailed(session, event) {
  const eventType = read(event, 'type');
  if (eventType !== 'tool/call' && eventType !== 'tool/result') return null;
  const diagnostics = new Set();
  const sessionId = identity(read(session, 'id'), 'session.id', diagnostics);
  const seq = read(event, 'seq');
  const sourceSeq = Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
  if (seq !== undefined && seq !== null && sourceSeq === null) add(diagnostics, 'FIELD_INVALID');
  const data = read(event, 'data');

  let observation;
  if (eventType === 'tool/call') {
    observation = {
      source: SESSION_EVENT,
      event: 'call',
      sessionId,
      callId: identity(read(data, 'callId'), 'event.data.callId', diagnostics),
      rootCallId: null,
      toolName: identity(read(data, 'name'), 'event.data.name', diagnostics),
      sourceSeq,
      outcome: 'unknown',
      valueState: 'absent',
      process: null
    };
  } else {
    const message = read(data, 'message');
    const source = read(message, 'source');
    observation = {
      source: SESSION_EVENT,
      event: 'result',
      sessionId,
      callId: identity(read(source, 'callId'), 'event.data.message.source.callId', diagnostics),
      rootCallId: null,
      toolName: null,
      sourceSeq,
      outcome: 'unknown',
      valueState: 'unknown',
      process: null
    };
  }
  return { observation, diagnosticCodes: [...diagnostics] };
}

export function projectHostSessionEvent(session, event) {
  const projected = projectHostSessionEventDetailed(session, event);
  return projected === null ? null : projected.observation;
}

function safeDiagnostic(writer, code) {
  try { writer.addDiagnostic(code); } catch { /* diagnostics must not escape a callback */ }
}

function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

// A disposer may return a promise (Cordis fibers can unwind asynchronously).
// stop() must stay synchronous, so it records the pending transition instead of
// claiming cleanup. A rejection is observed here to avoid an unhandled promise;
// health is updated when the transition settles.
function settleDisposer(dispose, state) {
  let result;
  try {
    result = dispose();
  } catch {
    state.failed = true;
    return;
  }
  let thenable;
  try { thenable = isThenable(result); } catch { state.failed = true; return; }
  if (!thenable) return;
  state.asyncPending = true;
  try {
    Promise.resolve(result).then(
      () => {
        state.asyncPending = false;
        state.asyncSettled = true;
        if (state.health !== null) {
          state.health.asyncCleanupPending = false;
          state.health.asyncCleanupSettled = true;
        }
      },
      () => {
        state.asyncPending = false;
        state.asyncSettled = true;
        state.asyncFailed = true;
        if (state.health !== null) {
          state.health.asyncCleanupPending = false;
          state.health.asyncCleanupSettled = true;
          state.health.asyncCleanupFailure = true;
          state.health.ok = false;
        }
      }
    );
  } catch {
    state.asyncPending = false;
    state.asyncSettled = true;
    state.asyncFailed = true;
  }
}

function safeStop(writer) {
  try { return writer.stop(); } catch { return { ok: false }; }
}

export function createHostToolObserver({
  subscribe,
  writer,
  subscriptions = [...SUPPORTED_EVENTS],
  origin = ORIGIN
} = {}) {
  if (typeof subscribe !== 'function') fail('SUBSCRIBE_FAILED', 'subscribe is required');
  if (writer === null || typeof writer !== 'object' || typeof writer.open !== 'function'
    || typeof writer.accept !== 'function' || typeof writer.stop !== 'function'
    || typeof writer.addDiagnostic !== 'function') {
    fail('SUBSCRIBE_FAILED', 'writer is required');
  }
  if (origin !== ORIGIN) fail('SUBSCRIBE_FAILED', 'unsupported origin');
  if (!Array.isArray(subscriptions) || subscriptions.some((name) => !SUPPORTED_EVENTS.includes(name))) {
    fail('SUBSCRIBE_FAILED', 'unsupported subscription name');
  }
  if (new Set(subscriptions).size !== subscriptions.length) {
    fail('SUBSCRIBE_FAILED', 'duplicate subscription name');
  }

  const disposers = new Map();
  let attached = false;
  let stopped = false;
  let health = null;

  function handlerFor(eventName) {
    return (...args) => {
      if (stopped) return;
      try {
        const projected = eventName === TOOLS_EVENT
          ? projectHostToolsResultDetailed(args[0], args[1])
          : projectHostSessionEventDetailed(args[0], args[1]);
        if (projected === null || projected.observation === null) return;
        for (const code of projected.diagnosticCodes) safeDiagnostic(writer, code);
        writer.accept(projected.observation);
      } catch {
        safeDiagnostic(writer, 'NORMALIZATION_FAILED');
      }
    };
  }

  function disposeAll() {
    const state = {
      failed: false,
      asyncPending: false,
      asyncSettled: false,
      asyncFailed: false,
      health: null
    };
    for (const dispose of disposers.values()) settleDisposer(dispose, state);
    disposers.clear();
    return state;
  }

  function attachFailure({ ownershipUncertain = false, rollbackFailed = false, asyncCleanupPending = false } = {}) {
    stopped = true;
    attached = false;
    safeDiagnostic(writer, 'SUBSCRIBE_FAILED');
    const result = safeStop(writer);
    health = {
      ok: false,
      code: 'SUBSCRIBE_FAILED',
      stopped: true,
      ownershipUncertain,
      rollbackFailed,
      asyncCleanupPending,
      writer: result
    };
    return health;
  }

  function attach() {
    if (stopped) return health ?? { ok: false, code: 'STOPPED' };
    if (attached) return health;
    let opened;
    try { opened = writer.open(); } catch { opened = false; }
    if (opened !== true) {
      stopped = true;
      health = { ok: false, code: 'WRITE_FAILED', stopped: true, writer: safeStop(writer) };
      return health;
    }
    for (const eventName of subscriptions) {
      let dispose;
      try {
        dispose = subscribe(eventName, handlerFor(eventName));
      } catch {
        const rolled = disposeAll();
        return attachFailure({
          ownershipUncertain: true,
          rollbackFailed: rolled.failed,
          asyncCleanupPending: rolled.asyncPending
        });
      }
      if (typeof dispose !== 'function') {
        const rolled = disposeAll();
        return attachFailure({
          ownershipUncertain: true,
          rollbackFailed: rolled.failed,
          asyncCleanupPending: rolled.asyncPending
        });
      }
      disposers.set(eventName, dispose);
    }
    attached = true;
    health = { ok: true, attached: true, subscriptions: [...subscriptions], ownershipUncertain: false };
    return health;
  }

  function stop() {
    if (stopped) return health ?? { ok: true, stopped: true };
    stopped = true;
    const drained = disposeAll();
    if (drained.failed) safeDiagnostic(writer, 'UNSUBSCRIBE_FAILED');
    const result = safeStop(writer);
    attached = false;
    health = {
      ok: !drained.failed && !drained.asyncPending && result.ok === true,
      stopped: true,
      unsubscribeFailed: drained.failed,
      ownershipUncertain: drained.failed || drained.asyncPending || drained.asyncFailed,
      asyncCleanupPending: drained.asyncPending,
      asyncCleanupSettled: drained.asyncSettled,
      asyncCleanupFailure: drained.asyncFailed,
      writer: result
    };
    // A late rejection/resolution of a disposer must update the same health
    // object; it never changes the already-returned ok:false into success.
    drained.health = health;
    return health;
  }

  return { attach, stop, health: () => health, get attached() { return attached; } };
}
