// Offline tests for the B1 host-shaped adapter. Every callback payload is
// invented; no DSH module is imported and no subscription is auto-created.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { inspectTraceBytes } from '../tools/lib/tool-trace-contracts.mjs';
import { createTraceWriter } from '../orchestration/tool-observer/writer.mjs';
import {
  createHostToolObserver,
  projectHostSessionEvent,
  projectHostSessionEventDetailed,
  projectHostToolsResult,
  projectHostToolsResultDetailed
} from '../orchestration/tool-observer/host-bridge.mjs';
import { createContextSubscriber } from '../orchestration/tool-observer/context-subscription.mjs';

mkdirSync('tests/.scratch', { recursive: true });
const root = mkdtempSync(join(process.cwd(), 'tests/.scratch/b1-host-'));
const writer = (name) => createTraceWriter({
  outputFile: join(root, `${name}.jsonl`),
  assertPath: () => {}
});
const writerFile = (name) => join(root, `${name}.jsonl`);
const traceOf = (file) => inspectTraceBytes(readFileSync(file));

function foreground({ exitCode = 0, signal = null, timedOut = false, aborted = false, stdout = false, stderr = false } = {}) {
  return {
    isError: false,
    value: { kind: 'foreground', exitCode, signal, timedOut, aborted, stdout: { truncated: stdout }, stderr: { truncated: stderr } }
  };
}

function exec({ callId = 'c1', rootCallId = 'r1', name = 'pwsh', sessionId = 's1' } = {}) {
  return { callId, rootCallId, name, agent: { session: { id: sessionId } } };
}

const base = projectHostToolsResultDetailed(exec(), foreground());
assert.equal(base.observation.source, 'tools/result');
assert.equal(base.observation.callId, 'c1');
assert.equal(base.observation.rootCallId, 'r1');
assert.equal(base.observation.sessionId, 's1');
assert.equal(base.observation.toolName, 'pwsh');
assert.equal(base.observation.outcome, 'success');
assert.equal(base.observation.valueState, 'present');
assert.deepEqual(base.observation.process, {
  exitCode: 0, signal: null, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false
});
assert.deepEqual(base.diagnosticCodes, []);

assert.equal(projectHostToolsResult(exec({ name: 'read' }), foreground()).process, null);
assert.equal(projectHostToolsResult(exec(), { isError: true, value: {} }).process, null);
assert.equal(projectHostToolsResult(exec(), { isError: false, value: { kind: 'background' } }).process, null);
assert.equal(projectHostToolsResult(exec(), { isError: false }).valueState, 'absent');
assert.equal(projectHostToolsResult(exec(), { isError: false }).process, null);
assert.equal(projectHostToolsResult(exec(), { isError: 'no' }).outcome, 'unknown');

const sessionCall = projectHostSessionEventDetailed(
  { id: 's1' },
  { type: 'tool/call', seq: 4, data: { callId: 'c1', name: 'read' } }
);
assert.deepEqual(sessionCall.observation, {
  source: 'session/event', event: 'call', sessionId: 's1', callId: 'c1',
  rootCallId: null, toolName: 'read', sourceSeq: 4, outcome: 'unknown',
  valueState: 'absent', process: null
});
assert.deepEqual(sessionCall.diagnosticCodes, []);

const sessionResult = projectHostSessionEvent(
  { id: 's1' },
  { type: 'tool/result', seq: 5, data: { message: { source: { callId: 'c1' } } } }
);
assert.equal(sessionResult.event, 'result');
assert.equal(sessionResult.callId, 'c1');
assert.equal(sessionResult.toolName, null);
assert.equal(sessionResult.outcome, 'unknown');
assert.equal(sessionResult.valueState, 'unknown');
assert.equal(sessionResult.process, null);
assert.equal(projectHostSessionEvent({ id: 's1' }, { type: 'message', seq: 1, data: {} }), null);
assert.equal(projectHostSessionEvent({ id: 's1' }, { type: 'tool/call', seq: 'bad', data: {} }).sourceSeq, null);

// Prohibited getters must not be touched; allowed getter failures stay inert.
let touched = 0;
const sensitive = exec();
Object.defineProperty(sensitive, 'arguments', { get() { touched += 1; throw new Error('CANARY_ARGS'); } });
Object.defineProperty(sensitive, 'cwd', { get() { touched += 1; throw new Error('CANARY_CWD'); } });
const sensitiveResult = foreground();
Object.defineProperty(sensitiveResult, 'content', { get() { touched += 1; throw new Error('CANARY_CONTENT'); } });
Object.defineProperty(sensitiveResult, 'error', { get() { touched += 1; throw new Error('CANARY_ERROR'); } });
const noTouch = projectHostToolsResultDetailed(sensitive, sensitiveResult);
assert.equal(touched, 0);
assert.equal(noTouch.observation.callId, 'c1');
assert.ok(!JSON.stringify(noTouch).includes('CANARY'));

const throwingId = exec();
Object.defineProperty(throwingId, 'callId', { get() { throw new Error('CANARY_CALL'); } });
const failedProjection = projectHostToolsResultDetailed(throwingId, foreground());
assert.equal(failedProjection.observation.callId, null);
assert.ok(failedProjection.diagnosticCodes.includes('FIELD_UNAVAILABLE'));
assert.ok(!JSON.stringify(failedProjection).includes('CANARY'));

// Strict raw identity is rejected at projection time, without a throw.
const badId = projectHostToolsResultDetailed(exec({ sessionId: 's1 ' }), foreground());
assert.equal(badId.observation.sessionId, null);
assert.ok(badId.diagnosticCodes.includes('FIELD_INVALID'));
assert.ok(!JSON.stringify(badId).includes('CANARY'));

// Process leaves: invalid values are nulled with a diagnostic, never coerced.
const badProcess = projectHostToolsResultDetailed(exec(), {
  isError: false,
  value: {
    kind: 'foreground', exitCode: '0', signal: 7, timedOut: 'false', aborted: 1,
    stdout: { truncated: 'no' }, stderr: { truncated: 0 }
  }
});
assert.deepEqual(badProcess.observation.process, {
  exitCode: null, signal: null, timedOut: null, aborted: null, stdoutTruncated: null, stderrTruncated: null
});
assert.ok(badProcess.diagnosticCodes.includes('FIELD_INVALID'));

// Bridge: explicit positional callbacks, dual-source agreement and inert errors.
const callbacks = new Map();
const disposed = [];
const subscribes = [];
const bridgeWriter = writer('bridge');
const bridge = createHostToolObserver({
  subscribe(name, callback) {
    subscribes.push(name);
    callbacks.set(name, callback);
    return () => disposed.push(name);
  },
  writer: bridgeWriter
});
assert.deepEqual(subscribes, []);
assert.equal(bridge.attach().ok, true);
assert.deepEqual(subscribes.sort(), ['session/event', 'tools/result']);
const execPayload = exec();
const resultPayload = foreground({ exitCode: 0, stdout: true, stderr: false });
const execSnapshot = JSON.stringify(execPayload);
const resultSnapshot = JSON.stringify(resultPayload);
callbacks.get('session/event')({ id: 's1' }, { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'pwsh' } });
callbacks.get('tools/result')(execPayload, resultPayload);
assert.equal(JSON.stringify(execPayload), execSnapshot);
assert.equal(JSON.stringify(resultPayload), resultSnapshot);
const stopped = bridge.stop();
const bridgeReport = traceOf(writerFile('bridge'));
assert.equal(bridgeReport.status, 'VALID_METADATA');
assert.equal(bridgeReport.counts.pairedCalls, 1);
assert.equal(bridgeReport.hostVerified, false);
assert.equal(bridgeReport.coverage, 'unknown');
assert.equal(bridgeReport.binding.status, 'unproven');
assert.equal(bridgeReport.counts.observations, 2);
assert.equal(stopped.ok, true);
assert.equal(bridge.stop(), stopped);
assert.deepEqual(disposed.sort(), ['session/event', 'tools/result']);

// Missing agent is a diagnostic, not a guessed identity.
const missingWriter = writer('missing-agent');
const missing = createHostToolObserver({
  subscribe(_name, callback) { callback({ callId: 'c1', name: 'read' }, { isError: false }); return () => {}; },
  writer: missingWriter
});
assert.equal(missing.attach().ok, true);
assert.ok(missing.stop().ok);
assert.ok(traceOf(writerFile('missing-agent')).diagnostics.some((item) => item.code === 'FIELD_UNAVAILABLE'));

// Two host-shaped results with different known process facts stay diagnostic.
const conflictCallbacks = new Map();
const conflictWriter = writer('conflict');
const conflict = createHostToolObserver({
  subscribe(name, callback) {
    conflictCallbacks.set(name, callback);
    return () => {};
  },
  writer: conflictWriter
});
assert.equal(conflict.attach().ok, true);
conflictCallbacks.get('session/event')({ id: 's1' }, { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'pwsh' } });
conflictCallbacks.get('tools/result')(exec(), foreground({ exitCode: 0 }));
conflictCallbacks.get('tools/result')(exec(), foreground({ exitCode: 1 }));
assert.equal(conflict.stop().stopped, true);
const conflictReport = traceOf(writerFile('conflict'));
assert.equal(conflictReport.status, 'INCOMPLETE');
assert.ok(conflictReport.diagnostics.some((item) => item.code === 'RESULT_CONFLICT'));

// Registration failure rolls back prior disposers and latches callbacks inert.
let retained = null;
let firstDisposed = 0;
const rollbackWriter = writer('rollback');
const rollback = createHostToolObserver({
  subscribe(name, callback) {
    if (name === 'tools/result') { retained = callback; return () => { firstDisposed += 1; }; }
    throw new Error('CANARY_SUBSCRIBE');
  },
  writer: rollbackWriter
});
const rollbackHealth = rollback.attach();
assert.equal(rollbackHealth.ok, false);
assert.equal(rollbackHealth.code, 'SUBSCRIBE_FAILED');
assert.equal(rollbackHealth.ownershipUncertain, true);
assert.equal(firstDisposed, 1);
retained(exec(), foreground());
assert.equal(traceOf(writerFile('rollback')).counts.observations, 0);
assert.ok(rollback.stop().stopped);

// Non-function disposer and throwing disposer are closed failures, not throws.
const noDisposer = createHostToolObserver({
  subscribe() { return null; },
  writer: writer('no-disposer')
});
assert.equal(noDisposer.attach().ownershipUncertain, true);
assert.equal(noDisposer.stop().stopped, true);
const throwingDisposer = createHostToolObserver({
  subscribe() { return () => { throw new Error('CANARY_DISPOSE'); }; },
  writer: writer('throwing-disposer')
});
assert.equal(throwingDisposer.attach().ok, true);
const throwingStop = throwingDisposer.stop();
assert.equal(throwingStop.ok, false);
assert.equal(throwingStop.unsubscribeFailed, true);
assert.ok(!JSON.stringify(throwingStop).includes('CANARY'));

// A strict raw identity is rejected by the writer, not thrown from the callback.
let strictCallback = null;
const strictWriter = writer('strict-id');
const strict = createHostToolObserver({
  subscribe(name, callback) {
    if (name === 'tools/result') strictCallback = callback;
    return () => {};
  },
  writer: strictWriter
});
assert.equal(strict.attach().ok, true);
strictCallback(exec({ sessionId: 's1 ' }), foreground());
assert.equal(strict.stop().stopped, true);
assert.ok(traceOf(writerFile('strict-id')).diagnostics.some((item) => item.code === 'FIELD_INVALID'));

// A throwing writer open is a bounded failure.
const openFailure = createHostToolObserver({
  subscribe() { return () => {}; },
  writer: { open() { throw new Error('CANARY_OPEN'); }, accept() {}, stop() { return { ok: true }; }, addDiagnostic() {} }
});
const openHealth = openFailure.attach();
assert.equal(openHealth.ok, false);
assert.equal(openHealth.code, 'WRITE_FAILED');
assert.ok(!JSON.stringify(openHealth).includes('CANARY'));

// Unsupported origin is refused before writer/subscription side effects.
assert.throws(() => createHostToolObserver({
  subscribe() { return () => {}; },
  writer: writer('origin'),
  origin: 'host-notification'
}), /SUBSCRIBE_FAILED/u);

// Cordis-shaped context registration: method receiver, exactly two arguments,
// no ctx.off, and a function disposer are required.
let contextDisposed = 0;
const contextCalls = [];
const context = {
  marker: 'ctx',
  on(name, callback, ...rest) {
    assert.equal(this, context);
    contextCalls.push({ name, rest: rest.length, callback });
    return () => { contextDisposed += 1; };
  },
  get off() { throw new Error('CANARY_OFF'); }
};
const contextSubscribe = createContextSubscriber(context);
const contextDisposer = contextSubscribe('tools/result', () => {});
assert.equal(typeof contextDisposer, 'function');
assert.equal(contextCalls.length, 1);
assert.equal(contextCalls[0].name, 'tools/result');
assert.equal(contextCalls[0].rest, 0);

assert.throws(() => createContextSubscriber({}), /SUBSCRIBE_FAILED/u);
assert.throws(() => createContextSubscriber({ on() { return true; } })('e', () => {}), /SUBSCRIBE_FAILED/u);
assert.throws(() => createContextSubscriber({ on() { throw new Error('CANARY_ON'); } })('e', () => {}), /CANARY_ON/u);

const contextWriter = writer('context');
const contextBridge = createHostToolObserver({
  subscribe: contextSubscribe,
  writer: contextWriter
});
assert.equal(contextBridge.attach().ok, true);
const contextStop = contextBridge.stop();
assert.equal(contextStop.ok, true);
assert.equal(contextDisposed, 2);

// Async disposer: stop stays synchronous, returns a non-success and records the
// pending transition; a later rejection is observed and never unhandled.
let resolveDispose;
const asyncDispose = new Promise((resolve) => { resolveDispose = resolve; });
const asyncContext = {
  on() { return () => { contextDisposed += 1; return asyncDispose; }; }
};
const asyncBridge = createHostToolObserver({
  subscribe: createContextSubscriber(asyncContext),
  writer: writer('async-resolve')
});
assert.equal(asyncBridge.attach().ok, true);
const asyncStop = asyncBridge.stop();
assert.equal(asyncStop.ok, false);
assert.equal(asyncStop.asyncCleanupPending, true);
assert.equal(asyncStop.ownershipUncertain, true);
resolveDispose();
await Promise.resolve();
await Promise.resolve();
assert.equal(asyncStop.asyncCleanupSettled, true);
assert.equal(asyncStop.asyncCleanupFailure, false);
assert.equal(asyncStop.ok, false);

let rejectDispose;
const rejectedDispose = new Promise((_resolve, reject) => { rejectDispose = reject; });
const rejectedBridge = createHostToolObserver({
  subscribe: createContextSubscriber({ on() { return () => rejectedDispose; } }),
  writer: writer('async-reject')
});
assert.equal(rejectedBridge.attach().ok, true);
const rejectedStop = rejectedBridge.stop();
assert.equal(rejectedStop.ok, false);
assert.equal(rejectedStop.asyncCleanupPending, true);
rejectDispose(new Error('CANARY_ASYNC_DISPOSE'));
await Promise.resolve();
await Promise.resolve();
assert.equal(rejectedStop.asyncCleanupSettled, true);
assert.equal(rejectedStop.asyncCleanupFailure, true);
assert.equal(rejectedStop.ok, false);
assert.ok(!JSON.stringify(rejectedStop).includes('CANARY_ASYNC_DISPOSE'));

// A rollback whose first disposer is asynchronous is reported as pending, not
// as a completed cleanup.
const rollbackAsync = createHostToolObserver({
  subscribe(name) {
    if (name === 'tools/result') return () => asyncDispose;
    throw new Error('CANARY_ROLLBACK');
  },
  writer: writer('rollback-async')
});
const rollbackAsyncHealth = rollbackAsync.attach();
assert.equal(rollbackAsyncHealth.ok, false);
assert.equal(rollbackAsyncHealth.ownershipUncertain, true);
assert.equal(rollbackAsyncHealth.asyncCleanupPending, true);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Multiple async disposers: one completion must not clear the aggregate pending
// state, and an early failure must stay latched.
const first = deferred();
const second = deferred();
const multi = createHostToolObserver({
  subscribe(name) {
    return () => (name === 'tools/result' ? first.promise : second.promise);
  },
  writer: writer('multi-async')
});
assert.equal(multi.attach().ok, true);
const multiHealth = multi.stop();
assert.equal(multiHealth.ok, false);
assert.equal(multiHealth.asyncCleanupPending, true);
assert.equal(multiHealth.asyncCleanupSettled, false);
first.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(multiHealth.asyncCleanupPending, true);
assert.equal(multiHealth.asyncCleanupSettled, false);
assert.equal(multiHealth.ownershipUncertain, true);
second.reject(new Error('CANARY_SECOND'));
await Promise.resolve();
await Promise.resolve();
assert.equal(multiHealth.asyncCleanupPending, false);
assert.equal(multiHealth.asyncCleanupSettled, true);
assert.equal(multiHealth.asyncCleanupFailure, true);
assert.equal(multiHealth.ok, false);
assert.ok(!JSON.stringify(multiHealth).includes('CANARY_SECOND'));

// Reverse order: reject first, resolve second; the failure remains latched.
const third = deferred();
const fourth = deferred();
const reverse = createHostToolObserver({
  subscribe(name) {
    return () => (name === 'tools/result' ? third.promise : fourth.promise);
  },
  writer: writer('reverse-async')
});
assert.equal(reverse.attach().ok, true);
const reverseHealth = reverse.stop();
third.reject(new Error('CANARY_THIRD'));
await Promise.resolve();
await Promise.resolve();
assert.equal(reverseHealth.asyncCleanupPending, true);
assert.equal(reverseHealth.asyncCleanupFailure, true);
fourth.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(reverseHealth.asyncCleanupPending, false);
assert.equal(reverseHealth.asyncCleanupSettled, true);
assert.equal(reverseHealth.asyncCleanupFailure, true);
assert.equal(reverseHealth.ok, false);

// Mixed sync/async, and repeated stop returns the same observable health.
const fifth = deferred();
const mixed = createHostToolObserver({
  subscribe(name) {
    return name === 'tools/result' ? (() => {}) : (() => fifth.promise);
  },
  writer: writer('mixed-async')
});
assert.equal(mixed.attach().ok, true);
const mixedHealth = mixed.stop();
assert.equal(mixedHealth.asyncCleanupPending, true);
assert.equal(mixed.stop(), mixedHealth);
fifth.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(mixedHealth.asyncCleanupPending, false);
assert.equal(mixedHealth.asyncCleanupSettled, true);
assert.equal(mixedHealth.ok, false);
assert.equal(mixedHealth.ownershipUncertain, false);

// A never-settling disposer keeps the aggregate pending without blocking stop.
const never = createHostToolObserver({
  subscribe() { return () => new Promise(() => {}); },
  writer: writer('never-async')
});
assert.equal(never.attach().ok, true);
const neverHealth = never.stop();
assert.equal(neverHealth.ok, false);
assert.equal(neverHealth.asyncCleanupPending, true);
assert.equal(neverHealth.asyncCleanupSettled, false);
assert.equal(neverHealth.ownershipUncertain, true);

// Rollback async completion updates its health instead of leaving it pending.
const rollbackDeferred = deferred();
const rollbackResolved = createHostToolObserver({
  subscribe(name) {
    if (name === 'tools/result') return () => rollbackDeferred.promise;
    throw new Error('CANARY_ROLLBACK_SECOND');
  },
  writer: writer('rollback-resolved')
});
const rollbackResolvedHealth = rollbackResolved.attach();
assert.equal(rollbackResolvedHealth.asyncCleanupPending, true);
rollbackDeferred.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(rollbackResolvedHealth.asyncCleanupPending, false);
assert.equal(rollbackResolvedHealth.asyncCleanupSettled, true);
assert.equal(rollbackResolvedHealth.rollbackFailed, false);
assert.equal(rollbackResolvedHealth.ok, false);
assert.equal(rollbackResolvedHealth.ownershipUncertain, true);

rmSync(root, { recursive: true, force: true });
console.log('host adapter tests: ok');
