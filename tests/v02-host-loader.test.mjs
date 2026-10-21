import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as loaderPlugin from '../orchestration/tool-observer/host-plugin/index.js';
import { createLoaderPlugin } from '../orchestration/tool-observer/host-plugin/index.js';
import * as m0Plugin from '../orchestration/tool-observer/plugin/index.js';
import { readLifecycle } from '../orchestration/tool-observer/lifecycle.mjs';
import { inspectTraceBytes } from '../tools/lib/tool-trace-contracts.mjs';

const UUID = randomUUID();
const UUID2 = randomUUID();

function scratch() {
  const parent = join(process.cwd(), 'tests', '.scratch');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'm1a-'));
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
    cleanupTimeoutMs: 1000,
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
      for (const callback of [...(listeners.get(name) ?? [])]) callback(...args);
    }
  };
}

// Minimal model of the loader contract: normalize a module, call apply, reject
// any non-function/non-null effect. This is a fake harness, not a DSH import.
async function fakeLoaderLoad(moduleValue, ctx, cfg) {
  const candidate = moduleValue?.default ?? moduleValue;
  const apply = typeof candidate === 'function' ? candidate : candidate?.apply;
  assert.equal(typeof apply, 'function');
  const effect = await apply(ctx, cfg);
  if (effect === undefined || effect === null) return null;
  if (typeof effect !== 'function') throw new Error('Invalid effect');
  return effect;
}

test('module normalization exposes name, inject and apply without a controller default', async () => {
  const candidate = loaderPlugin.default ?? loaderPlugin;
  assert.equal(typeof candidate.apply, 'function');
  assert.equal(candidate.name, 'tla-tool-observer');
  assert.deepEqual(candidate.inject, []);
  assert.equal(Object.hasOwn(candidate, 'default'), false);
});

test('disabled apply has no filesystem or subscription side effect', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  let subscribed = 0;
  const ctx = { on() { subscribed += 1; return () => {}; } };
  const effect = await loaderPlugin.apply(ctx, { enabled: false });
  assert.equal(effect, undefined);
  assert.equal(subscribed, 0);
  assert.deepEqual(readdirSync(runDir), []);
  rmSync(root, { recursive: true, force: true });
});

test('enabled apply returns a disposer and unload stops through the controller', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const ctx = fakeContext();
  const effect = await fakeLoaderLoad(loaderPlugin, ctx, config(runDir));
  assert.equal(typeof effect, 'function');
  assert.equal(Object.hasOwn(effect, 'stop'), false);
  const result = await effect();
  assert.equal(result, undefined);
  const lifecycle = readLifecycle(readFileSync(join(runDir, 'lifecycle.jsonl')));
  assert.deepEqual(lifecycle.records.map((record) => record.phase), ['preparing', 'attached', 'stopping', 'stopped']);
  assert.equal(lifecycle.records.at(1).origin, 'host-notification');
  const trace = inspectTraceBytes(readFileSync(join(runDir, 'trace.jsonl')));
  assert.equal(trace.status, 'VALID_METADATA');
  assert.equal(trace.origin, 'host-notification');
  rmSync(root, { recursive: true, force: true });
});

test('the old M0 controller return fails the loader effect contract', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const controller = await m0Plugin.apply(fakeContext(), config(runDir));
  assert.equal(controller.ok, true);
  assert.equal(typeof controller.stop, 'function');
  const secondRun = join(root, 'second');
  mkdirSync(secondRun);
  await assert.rejects(
    () => fakeLoaderLoad(m0Plugin, fakeContext(), config(secondRun)),
    /Invalid effect/
  );
  await controller.stop();
  rmSync(root, { recursive: true, force: true });
});

test('setup failure returns a fixed error after bounded cleanup', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  let stopped = 0;
  const plugin = createLoaderPlugin({
    factory: async () => ({
      enabled: true,
      ok: false,
      code: 'PATH_BLOCKED',
      stop: async () => { stopped += 1; return { ok: true }; }
    })
  });
  await assert.rejects(
    () => plugin.apply(fakeContext(), config(runDir)),
    (error) => error.code === 'PATH_BLOCKED'
  );
  assert.equal(stopped, 1);
  rmSync(root, { recursive: true, force: true });
});

test('an asynchronous factory rejection is a fixed setup error without raw text', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const plugin = createLoaderPlugin({
    factory: async () => { throw new Error('CANARY_ASYNC_SETUP'); }
  });
  await assert.rejects(
    () => plugin.apply(fakeContext(), config(runDir)),
    (error) => error.code === 'SETUP_FAILED' &&
      !String(error).includes('CANARY_ASYNC_SETUP') &&
      !JSON.stringify(error).includes('CANARY_ASYNC_SETUP')
  );
  rmSync(root, { recursive: true, force: true });
});

test('disabled config still rejects unknown fields and never leaks a canary', async () => {
  const plugin = createLoaderPlugin();
  await assert.rejects(
    () => plugin.apply(fakeContext(), { enabled: false, secret: 'CANARY_CONFIG' }),
    (error) => error.code === 'CONFIG_INVALID' &&
      !String(error).includes('CANARY_CONFIG') &&
      !JSON.stringify(error).includes('CANARY_CONFIG')
  );
});

test('a cleanup failure rejects with a fixed code and is idempotent', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const plugin = createLoaderPlugin({
    factory: async () => ({
      enabled: true,
      ok: true,
      stop: () => ({ ok: false, code: 'CLEANUP_FAILED' })
    })
  });
  const effect = await plugin.apply(fakeContext(), config(runDir));
  const first = effect();
  const second = effect();
  assert.equal(first, second);
  await assert.rejects(() => first, (error) => error.code === 'CLEANUP_FAILED');
  await assert.rejects(() => first, (error) => error.code === 'CLEANUP_FAILED');
  rmSync(root, { recursive: true, force: true });
});

test('double unload shares one cleanup promise and one final result', async () => {
  const root = scratch();
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const effect = await loaderPlugin.apply(fakeContext(), config(runDir));
  const first = effect();
  const second = effect();
  assert.equal(first, second);
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
  const text = readFileSync(join(runDir, 'lifecycle.jsonl'), 'utf8');
  assert.equal((text.match(/"phase":"stopped"/gu) ?? []).length, 1);
  rmSync(root, { recursive: true, force: true });
});
