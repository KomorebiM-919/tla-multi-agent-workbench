// Passive B1 observer adapter. Merely importing this module does not subscribe,
// open files or import a DSH module. The caller must supply a dispatcher-shaped
// object and an explicit writer; attach/stop own the subscriptions.
import { TraceError } from '../../tools/lib/tool-trace-contracts.mjs';

function fail(code, detail) { throw new TraceError(code, detail); }
function read(value, key) {
  try { return value === null || value === undefined ? undefined : value[key]; }
  catch { return undefined; }
}
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// The default mapper only projects fields whose names are attested by the
// audited seam. Everything else stays unknown. Tests can inject a mapper to
// exercise correlation; that mapper is invented data, not host support.
export function mapToolsResult(_eventName, payload) {
  const exec = read(payload, 'exec');
  return {
    source: 'tools/result',
    event: 'result',
    sessionId: null,
    callId: text(read(exec, 'callId')),
    rootCallId: text(read(exec, 'rootCallId')),
    toolName: null,
    sourceSeq: null,
    outcome: 'unknown',
    valueState: 'unknown',
    process: null
  };
}

export function createToolObserver({ dispatcher, writer, mapper = mapToolsResult, subscriptions = ['tools/result'] } = {}) {
  if (dispatcher === null || typeof dispatcher !== 'object') fail('SUBSCRIBE_FAILED', 'dispatcher is required');
  if (typeof dispatcher.on !== 'function' || typeof dispatcher.off !== 'function') fail('SUBSCRIBE_FAILED', 'dispatcher must expose on/off');
  if (writer === null || typeof writer !== 'object' || typeof writer.open !== 'function'
    || typeof writer.accept !== 'function' || typeof writer.stop !== 'function') {
    fail('SUBSCRIBE_FAILED', 'writer is required');
  }
  if (typeof mapper !== 'function') fail('SUBSCRIBE_FAILED', 'mapper must be a function');
  if (!Array.isArray(subscriptions) || subscriptions.some((name) => name !== 'tools/result' && name !== 'session/event')) {
    fail('SUBSCRIBE_FAILED', 'unsupported subscription name');
  }
  if (new Set(subscriptions).size !== subscriptions.length) {
    fail('SUBSCRIBE_FAILED', 'duplicate subscription name');
  }
  const handlers = new Map();
  let attached = false;
  let stopped = false;
  let health = null;

  function handlerFor(eventName) {
    return (payload) => {
      if (stopped) return;
      try {
        const partial = mapper(eventName, payload);
        if (partial === null || partial === undefined) return;
        for (const key of ['sessionId', 'callId', 'rootCallId', 'toolName']) {
          if (partial[key] === null) writer.addDiagnostic('FIELD_UNAVAILABLE');
        }
        writer.accept(partial);
      } catch {
        try { writer.addDiagnostic('NORMALIZATION_FAILED'); } catch { /* retain original silence */ }
      }
    };
  }

  function attach() {
    if (attached || stopped) return health ?? { ok: false, code: 'STOPPED' };
    let opened = false;
    try {
      writer.open();
      opened = true;
      for (const eventName of subscriptions) {
        const handler = handlerFor(eventName);
        dispatcher.on(eventName, handler);
        handlers.set(eventName, handler);
      }
      attached = true;
      health = { ok: true, attached: true, subscriptions: [...subscriptions] };
      return health;
    } catch (error) {
      for (const [eventName, handler] of handlers) {
        try { dispatcher.off(eventName, handler); } catch { /* rollback is best effort */ }
      }
      handlers.clear();
      try { writer.addDiagnostic('SUBSCRIBE_FAILED'); } catch { /* no throw into host */ }
      const result = writer.stop();
      attached = false;
      stopped = true;
      health = { ok: false, code: 'SUBSCRIBE_FAILED', writer: result };
      return health;
    }
  }

  function stop() {
    if (stopped) return health ?? { ok: true, stopped: true };
    stopped = true;
    let unsubscribeFailed = false;
    for (const [eventName, handler] of handlers) {
      try { dispatcher.off(eventName, handler); } catch { unsubscribeFailed = true; }
    }
    handlers.clear();
    if (unsubscribeFailed) {
      try { writer.addDiagnostic('UNSUBSCRIBE_FAILED'); } catch { /* retained health below */ }
    }
    const result = writer.stop();
    attached = false;
    health = {
      ok: !unsubscribeFailed && result.ok === true,
      stopped: true,
      unsubscribeFailed,
      writer: result
    };
    return health;
  }

  return { attach, stop, health: () => health, get attached() { return attached; } };
}
