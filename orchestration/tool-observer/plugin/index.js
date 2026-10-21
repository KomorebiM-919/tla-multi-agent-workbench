// tla-tool-observer candidate entry. It is deliberately a thin composition
// boundary: importing it has no side effects, it never discovers DSH, never
// imports a profile and never registers anything unless apply() is called with
// enabled=true. Loader activation is not claimed by this offline package.
import { readdirSync, lstatSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TraceError } from '../../../tools/lib/tool-trace-contracts.mjs';
import { assertFreshOutputPath } from '../../../tools/lib/trace-output.mjs';
import { isId, isUuid } from '../../../tools/lib/launch-receipts.mjs';
import { createContextSubscriber } from '../context-subscription.mjs';
import { createHostToolObserver } from '../host-bridge.mjs';
import { createTraceWriter } from '../writer.mjs';
import { createLifecycleJournal } from '../lifecycle.mjs';

export const name = 'tla-tool-observer';
export const inject = [];
export const loadable = false;

const CONFIG_KEYS = [
  'enabled', 'runDir', 'traceFile', 'lifecycleFile', 'runnerRunId', 'launchId',
  'gateRunId', 'budgetRunId', 'maxBytes', 'maxObservations', 'maxPending',
  'cleanupTimeoutMs'
];
const LIMITS = Object.freeze({ minMaxBytes: 128 * 1024, maxBytes: 8 * 1024 * 1024, maxObservations: 10000, maxPending: 1000, cleanupTimeoutMs: 5000 });

function fail(code, detail) { throw new TraceError(code, detail); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) {
  if (!plain(value)) fail('CONFIG_INVALID', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('CONFIG_INVALID', `${label} has an invalid field set`);
  }
}
function safeInt(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validateConfig(config) {
  if (!plain(config)) fail('CONFIG_INVALID', 'config must be an object');
  if (config.enabled === false) {
    exact(config, ['enabled'], 'config');
    return { enabled: false };
  }
  if (config.enabled !== true) fail('CONFIG_INVALID', 'enabled must be boolean');
  exact(config, CONFIG_KEYS, 'config');
  for (const key of ['runDir', 'traceFile', 'lifecycleFile']) {
    if (typeof config[key] !== 'string' || config[key].length === 0) fail('CONFIG_INVALID', `${key} is required`);
  }
  for (const key of ['runnerRunId', 'gateRunId', 'budgetRunId']) {
    if (!isId(config[key])) fail('CONFIG_INVALID', `${key} is invalid`);
  }
  if (!isUuid(config.launchId)) fail('CONFIG_INVALID', 'launchId must be UUID v4');
  if (config.gateRunId !== config.budgetRunId) fail('CONFIG_INVALID', 'gateRunId and budgetRunId must agree');
  if (!safeInt(config.maxBytes, LIMITS.minMaxBytes, LIMITS.maxBytes)) fail('CONFIG_INVALID', 'maxBytes is invalid');
  if (!safeInt(config.maxObservations, 1, LIMITS.maxObservations)) fail('CONFIG_INVALID', 'maxObservations is invalid');
  if (!safeInt(config.maxPending, 1, LIMITS.maxPending)) fail('CONFIG_INVALID', 'maxPending is invalid');
  if (!safeInt(config.cleanupTimeoutMs, 1, LIMITS.cleanupTimeoutMs)) fail('CONFIG_INVALID', 'cleanupTimeoutMs is invalid');

  const runDir = resolve(config.runDir);
  const traceFile = resolve(config.traceFile);
  const lifecycleFile = resolve(config.lifecycleFile);
  if (runDir === traceFile || runDir === lifecycleFile) fail('CONFIG_INVALID', 'outputs must not be the run directory');
  if (traceFile === lifecycleFile) fail('CONFIG_INVALID', 'outputs must be distinct');
  for (const file of [traceFile, lifecycleFile]) {
    const rel = relative(runDir, file);
    if (rel === '' || rel.startsWith('..') || /^([A-Za-z]:|[\\/])/u.test(rel)) fail('CONFIG_INVALID', 'output must be inside runDir');
    if (dirname(file) !== runDir) fail('CONFIG_INVALID', 'output must be a direct child of runDir');
  }
  let info;
  try { info = lstatSync(runDir); } catch { fail('PATH_BLOCKED', 'runDir cannot be inspected'); }
  if (!info.isDirectory()) fail('PATH_BLOCKED', 'runDir must be a directory');
  let entries;
  try { entries = readdirSync(runDir); } catch { fail('PATH_BLOCKED', 'runDir cannot be read'); }
  if (entries.length !== 0) fail('PATH_BLOCKED', 'runDir must be empty');
  return {
    enabled: true,
    runDir,
    traceFile,
    lifecycleFile,
    runnerRunId: config.runnerRunId,
    launchId: config.launchId,
    gateRunId: config.gateRunId,
    budgetRunId: config.budgetRunId,
    maxBytes: config.maxBytes,
    maxObservations: config.maxObservations,
    maxPending: config.maxPending,
    cleanupTimeoutMs: config.cleanupTimeoutMs
  };
}

export function createToolObserver({
  ctx,
  config,
  assertPath = assertFreshOutputPath,
  writerFactory = createTraceWriter,
  journalFactory = createLifecycleJournal,
  observerFactory = createHostToolObserver,
  pid = process.pid
} = {}) {
  const normalized = validateConfig(config);
  if (normalized.enabled === false) return { enabled: false, stop: () => ({ ok: true, stopped: true }) };
  if (typeof assertPath !== 'function') fail('CONFIG_INVALID', 'assertPath is required');
  for (const file of [normalized.traceFile, normalized.lifecycleFile]) {
    try { assertPath(file); } catch { fail('PATH_BLOCKED', 'output path failed physical validation'); }
  }
  const traceId = randomUUID();
  const identity = {
    traceId,
    origin: 'simulated-dispatcher',
    runnerRunId: normalized.runnerRunId,
    launchId: normalized.launchId,
    gateRunId: normalized.gateRunId,
    budgetRunId: normalized.budgetRunId
  };
  let journal;
  let writer;
  let observer;
  let stopped = false;
  let finalResult = null;

  function failRecord(code) {
    try { journal?.writeRecord('failed', code, null); } catch { /* journal failure is secondary */ }
    try { journal?.close(); } catch { /* close is secondary */ }
  }

  try {
    journal = journalFactory({ file: normalized.lifecycleFile, identity, observerPid: pid });
    journal.open();
  } catch {
    failRecord('PATH_BLOCKED');
    return { enabled: true, ok: false, code: 'PATH_BLOCKED', stop: () => ({ ok: false }) };
  }

  try {
    writer = writerFactory({
      outputFile: normalized.traceFile,
      traceId,
      origin: identity.origin,
      bindingClaim: {
        runnerRunId: normalized.runnerRunId,
        launchId: normalized.launchId,
        gateRunId: normalized.gateRunId,
        budgetRunId: normalized.budgetRunId
      },
      maxBytes: normalized.maxBytes,
      maxObservations: normalized.maxObservations,
      maxPending: normalized.maxPending,
      assertPath
    });
    const subscribe = createContextSubscriber(ctx);
    observer = observerFactory({ subscribe, writer });
    const attached = observer.attach();
    if (attached?.ok !== true) {
      journal.writeRecord('failed', 'ATTACH_FAILED', null);
      journal.close();
      return { enabled: true, ok: false, code: 'ATTACH_FAILED', stop: () => observer.stop() };
    }
    journal.writeRecord('attached');
  } catch {
    try { observer?.stop(); } catch { /* secondary */ }
    failRecord('ATTACH_FAILED');
    return { enabled: true, ok: false, code: 'ATTACH_FAILED', stop: () => ({ ok: false }) };
  }

  function stop() {
    if (stopped) return finalResult ?? { ok: true, stopped: true };
    stopped = true;
    try { journal.writeRecord('stopping'); } catch { failRecord('WRITE_FAILED'); return (finalResult = { ok: false, code: 'WRITE_FAILED' }); }
    let stoppedHealth;
    try { stoppedHealth = observer.stop(); } catch { stoppedHealth = { ok: false }; }
    return observer.waitForCleanup({ timeoutMs: normalized.cleanupTimeoutMs }).then((cleanup) => {
      if (cleanup.status === 'timeout') {
        try { journal.writeRecord('failed', 'CLEANUP_TIMEOUT', null); } catch { /* secondary */ }
        try { journal.close(); } catch { /* secondary */ }
        return (finalResult = { ok: false, code: 'CLEANUP_TIMEOUT', cleanup });
      }
      if (cleanup.status === 'failed' || stoppedHealth?.ok !== true) {
        try { journal.writeRecord('failed', 'CLEANUP_FAILED', null); } catch { /* secondary */ }
        try { journal.close(); } catch { /* secondary */ }
        return (finalResult = { ok: false, code: 'CLEANUP_FAILED', cleanup });
      }
      try {
        journal.writeRecord('stopped', null, {
          writerOk: stoppedHealth.writer?.ok === true,
          cleanupState: 'settled',
          ownershipUncertain: stoppedHealth.ownershipUncertain === true || cleanup.failedCount > 0
        });
        if (stoppedHealth.writer?.ok !== true) {
          return (finalResult = { ok: false, code: 'WRITE_FAILED', cleanup });
        }
      } catch {
        try { journal.writeRecord('failed', 'WRITE_FAILED', null); } catch { /* secondary */ }
        try { journal.close(); } catch { /* secondary */ }
        return (finalResult = { ok: false, code: 'WRITE_FAILED', cleanup });
      }
      const closeResult = journal.close();
      if (closeResult.closeFailed !== null) return (finalResult = { ok: false, code: 'CLOSE_FAILED', cleanup });
      return (finalResult = { ok: true, cleanup });
    });
  }

  return { enabled: true, ok: true, traceId, stop, observer, journal, writer };
}

export async function apply(ctx, config) {
  const normalized = validateConfig(config);
  if (normalized.enabled === false) return { enabled: false };
  // The host loader shape is not established as a mount contract by the
  // offline source audit. The candidate returns a controller but does not
  // claim that a host will call it; installation remains separately gated.
  return createToolObserver({ ctx, config });
}
