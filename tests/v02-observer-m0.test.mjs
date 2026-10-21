// M0 lifecycle, bounded cleanup and candidate-entry tests. All contexts and
// notifications are fictional; no DSH host, provider or model is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  apply, validateConfig
} from '../orchestration/tool-observer/plugin/index.js';
import { createHostToolObserver } from '../orchestration/tool-observer/host-bridge.mjs';
import { createTraceWriter } from '../orchestration/tool-observer/writer.mjs';
import { createLifecycleJournal, readLifecycle } from '../orchestration/tool-observer/lifecycle.mjs';
import { inspectTraceBytes } from '../tools/lib/tool-trace-contracts.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function scratch() {
  const parent = join(process.cwd(), 'tests', '.scratch');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'm0-'));
}

function config(runDir, overrides = {}) {
  return {
    enabled: true,
    runDir,
    traceFile: join(runDir, 'trace.jsonl'),
    lifecycleFile: join(runDir, 'lifecycle.jsonl'),
    runnerRunId: 'runner-1',
    launchId: UUID,
    gateRunId: 'gate-1',
    budgetRunId: 'gate-1',
    maxBytes: 128 * 1024,
    maxObservations: 10,
    maxPending: 10,
    cleanupTimeoutMs: 50,
    ...overrides
  };
}

function fakeContext() {
  const listeners = new Map();
  return {
    listeners,
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
      return () => {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(name, ...args) {
      for (const callback of listeners.get(name) ?? []) callback(...args);
    }
  };
}

function execResult(callId = 'c1') {
  return {
    exec: { callId, rootCallId: 'r1', name: 'pwsh', agent: { session: { id: 's1' } } },
    result: {
      isError: false,
      value: {
        kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false,
        stdout: { truncated: false }, stderr: { truncated: false }
      }
    }
  };
}

test('disabled import/apply has no filesystem or subscription side effects', async () => {
  let calls = 0;
  const ctx = { on() { calls += 1; return () => {}; } };
  const result = await apply(ctx, { enabled: false });
  assert.deepEqual(result, { enabled: false });
  assert.equal(calls, 0);
});

test('config rejects unknown fields, missing fields, invalid IDs and non-empty runDir', () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  assert.throws(() => validateConfig({ ...config(runDir), extra: true }), /CONFIG_INVALID/);
  assert.throws(() => validateConfig({ enabled: true, runDir }), /CONFIG_INVALID/);
  assert.throws(() => validateConfig({ ...config(runDir), gateRunId: 'other' }), /CONFIG_INVALID/);
  assert.throws(() => validateConfig({ ...config(runDir), launchId: 'not-uuid' }), /CONFIG_INVALID/);
  rmSync(root, { recursive: true, force: true });
});

test('normal attach, fake notification, exact journal and successful stop', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const ctx = fakeContext();
  const controller = await apply(ctx, config(runDir));
  assert.equal(controller.ok, true);
  assert.equal(controller.observer.attached, true);
  const probe = execResult();
  ctx.emit('session/event', { id: 's1' }, { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'pwsh' } });
  ctx.emit('tools/result', probe.exec, probe.result);
  const stopped = await controller.stop();
  assert.equal(stopped.ok, true);
  const journalBytes = readFileSync(join(runDir, 'lifecycle.jsonl'));
  const lifecycle = readLifecycle(journalBytes);
  assert.deepEqual(lifecycle.records.map((r) => r.phase), ['preparing', 'attached', 'stopping', 'stopped']);
  assert.equal(lifecycle.records.at(-1).health.writerOk, true);
  const trace = inspectTraceBytes(readFileSync(join(runDir, 'trace.jsonl')));
  assert.equal(trace.status, 'VALID_METADATA');
  assert.equal(trace.counts.observations, 2);
  rmSync(root, { recursive: true, force: true });
});

test('second subscription failure rolls back and never reports attached', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  let count = 0;
  const ctx = {
    on() {
      count += 1;
      if (count === 2) throw new Error('fake registration failure');
      return () => {};
    }
  };
  const controller = await apply(ctx, config(runDir));
  assert.equal(controller.ok, false);
  const lifecycle = readLifecycle(readFileSync(join(runDir, 'lifecycle.jsonl')));
  assert.deepEqual(lifecycle.records.map((r) => r.phase), ['preparing', 'failed']);
  assert.equal(lifecycle.records.at(-1).code, 'ATTACH_FAILED');
  rmSync(root, { recursive: true, force: true });
});

test('bounded cleanup: pre-stop rejection, pending, settlement, timeout, failure and detached snapshots', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const writer = createTraceWriter({ outputFile: join(runDir, 'trace.jsonl'), assertPath: () => {} });
  let release;
  const observer = createHostToolObserver({
    subscribe: () => () => new Promise((resolve) => { release = resolve; }),
    writer,
    subscriptions: ['tools/result']
  });
  assert.equal(observer.attach().ok, true);
  assert.throws(() => observer.waitForCleanup({ timeoutMs: 10 }), /WAIT_BEFORE_STOP/);
  observer.stop();
  const pending = observer.waitForCleanup({ timeoutMs: 100 });
  release();
  const settled = await pending;
  assert.deepEqual(settled, { status: 'settled', pendingCount: 0, failedCount: 0 });
  const again = await observer.waitForCleanup({ timeoutMs: 100 });
  assert.deepEqual(again, settled);
  rmSync(root, { recursive: true, force: true });
});

test('cleanup timeout and rejection are reported without hiding the primary state', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  let reject;
  const writer = createTraceWriter({ outputFile: join(runDir, 'timeout.jsonl'), assertPath: () => {} });
  const observer = createHostToolObserver({
    subscribe: () => () => new Promise((resolve, rejectFn) => { reject = rejectFn; }),
    writer
  });
  observer.attach();
  observer.stop();
  const timeout = await observer.waitForCleanup({ timeoutMs: 1 });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.pendingCount, 2);
  reject(new Error('fake rejection'));
  rmSync(root, { recursive: true, force: true });
});

test('entry stop reports cleanup timeout as failed, not stopped', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const ctx = { on: () => () => new Promise(() => {}) };
  const controller = await apply(ctx, config(runDir, { cleanupTimeoutMs: 1 }));
  assert.equal(controller.ok, true);
  const result = await controller.stop();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CLEANUP_TIMEOUT');
  const lifecycle = readLifecycle(readFileSync(join(runDir, 'lifecycle.jsonl')));
  assert.equal(lifecycle.records.at(-1).phase, 'failed');
  assert.equal(lifecycle.records.at(-1).code, 'CLEANUP_TIMEOUT');
  rmSync(root, { recursive: true, force: true });
});

test('journal reader rejects malformed, mixed and missing-terminal records', () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const file = join(runDir, 'lifecycle.jsonl');
  const identity = {
    traceId: UUID, origin: 'simulated-dispatcher', runnerRunId: 'runner-1',
    launchId: UUID, gateRunId: 'gate-1', budgetRunId: 'gate-1'
  };
  const journal = createLifecycleJournal({ file, identity, observerPid: process.pid });
  journal.open();
  journal.writeRecord('attached');
  journal.writeRecord('stopping');
  journal.writeRecord('stopped', null, { writerOk: true, cleanupState: 'settled', ownershipUncertain: false });
  journal.close();
  const good = readFileSync(file);
  assert.equal(readLifecycle(good).phase, 'stopped');
  assert.throws(() => readLifecycle(Buffer.from(good.toString('utf8').replace('"seq":2', '"seq":9'))), /JOURNAL_INVALID/);
  const lines = good.toString('utf8').trimEnd().split('\n');
  assert.throws(() => readLifecycle(Buffer.from(`${lines.slice(0, -1).join('\n')}\n`)), /JOURNAL_INVALID/);
  rmSync(root, { recursive: true, force: true });
});

test('journal writer enforces final-phase and health transitions', () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const identity = {
    traceId: UUID, origin: 'simulated-dispatcher', runnerRunId: 'runner-1',
    launchId: UUID, gateRunId: 'gate-1', budgetRunId: 'gate-1'
  };
  const journal = createLifecycleJournal({ file: join(runDir, 'lifecycle.jsonl'), identity });
  journal.open();
  assert.throws(() => journal.writeRecord('attached', 'X'), /WRITE_FAILED/);
  journal.writeRecord('attached');
  assert.throws(() => journal.writeRecord('stopped', null, { writerOk: true, cleanupState: 'settled', ownershipUncertain: false }), /WRITE_FAILED/);
  journal.writeRecord('stopping');
  journal.writeRecord('stopped', null, { writerOk: true, cleanupState: 'settled', ownershipUncertain: false });
  assert.throws(() => journal.writeRecord('failed', 'CLEANUP_FAILED'), /WRITE_FAILED/);
  journal.close();
  rmSync(root, { recursive: true, force: true });
});

test('trace/journal do not contain private canary values', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const ctx = fakeContext();
  const controller = await apply(ctx, config(runDir));
  const probe = execResult();
  probe.exec.privatePrompt = 'CANARY_PRIVATE_VALUE';
  probe.result.privatePrompt = 'CANARY_PRIVATE_VALUE';
  ctx.emit('session/event', { id: 's1' }, { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'pwsh' } });
  ctx.emit('tools/result', probe.exec, probe.result);
  await controller.stop();
  const traceText = readFileSync(join(runDir, 'trace.jsonl'), 'utf8');
  const journalText = readFileSync(join(runDir, 'lifecycle.jsonl'), 'utf8');
  assert.equal(traceText.includes('CANARY_PRIVATE_VALUE'), false);
  assert.equal(journalText.includes('CANARY_PRIVATE_VALUE'), false);
  rmSync(root, { recursive: true, force: true });
});

test('writer footer failure keeps the footer stage and closes independently', () => {
  const root = scratch();
  const file = join(root, 'trace.jsonl');
  let writes = 0;
  let closes = 0;
  const writer = createTraceWriter({
    outputFile: file,
    assertPath: () => {},
    io: {
      openSync: () => 1,
      writeSync: (_fd, buffer) => {
        writes += 1;
        if (writes === 2) throw new Error('CANARY_PRIVATE_EXCEPTION');
        return buffer.length;
      },
      closeSync: () => { closes += 1; }
    }
  });
  writer.open();
  const result = writer.stop();
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'footer');
  assert.equal(result.code, 'WRITE_FAILED');
  assert.equal(result.footerWritten, false);
  assert.equal(closes, 1);
  assert.equal(JSON.stringify(result).includes('CANARY_PRIVATE_EXCEPTION'), false);
  rmSync(root, { recursive: true, force: true });
});

test('writer close failure is reported independently of a written footer', () => {
  const root = scratch();
  const file = join(root, 'trace.jsonl');
  const writer = createTraceWriter({
    outputFile: file,
    assertPath: () => {},
    io: {
      openSync: () => 1,
      writeSync: (_fd, buffer) => buffer.length,
      closeSync: () => { throw new Error('CANARY_PRIVATE_EXCEPTION'); }
    }
  });
  writer.open();
  const result = writer.stop();
  assert.equal(result.ok, false);
  assert.equal(result.footerWritten, true);
  assert.equal(result.closeFailed, 'CLOSE_FAILED');
  assert.equal(result.stage, 'close');
  assert.equal(result.code, 'CLOSE_FAILED');
  assert.equal(JSON.stringify(result).includes('CANARY_PRIVATE_EXCEPTION'), false);
  rmSync(root, { recursive: true, force: true });
});

test('lifecycle journal file limit and fresh output collision', () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const identity = {
    traceId: UUID, origin: 'simulated-dispatcher', runnerRunId: 'runner-1',
    launchId: UUID, gateRunId: 'gate-1', budgetRunId: 'gate-1'
  };
  const file = join(runDir, 'lifecycle.jsonl');
  const first = createLifecycleJournal({ file, identity });
  first.open();
  assert.throws(() => createLifecycleJournal({ file, identity }).open(), /WRITE_FAILED/);
  first.close();
  rmSync(root, { recursive: true, force: true });
});
