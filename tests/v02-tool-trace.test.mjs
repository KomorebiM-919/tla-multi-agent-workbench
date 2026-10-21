// B1 offline tests: strict trace contracts, bounded writer, passive adapter and
// the inspector CLI. All records are invented; no DSH module is imported.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  inspectTraceBytes, TRACE_LIMITS, TRACE_SCHEMA, validateFooter, validateHeader,
  validateObservation
} from '../tools/lib/tool-trace-contracts.mjs';
import { createTraceWriter } from '../orchestration/tool-observer/writer.mjs';
import { createToolObserver } from '../orchestration/tool-observer/index.mjs';

mkdirSync('tests/.scratch', { recursive: true });
const root = mkdtempSync(join(process.cwd(), 'tests/.scratch/b1-trace-'));
const binding = { runnerRunId: null, launchId: null, gateRunId: null, budgetRunId: null };
const header = (traceId = randomUUID(), origin = 'simulated-dispatcher') => ({
  schema: TRACE_SCHEMA, kind: 'header', traceId, origin, scope: 'tool-metadata-only',
  bindingClaim: binding, order: 'observer-delivery-only', coverage: 'unknown'
});
const call = (seq, sessionId = 's1', callId = 'c1', extra = {}) => ({
  kind: 'observation', receiptSeq: seq, source: 'session/event', event: 'call',
  sessionId, callId, rootCallId: null, toolName: 'write', sourceSeq: 1,
  outcome: 'unknown', valueState: 'absent', process: null, ...extra
});
const result = (seq, sessionId = 's1', callId = 'c1', extra = {}) => ({
  kind: 'observation', receiptSeq: seq, source: 'tools/result', event: 'result',
  sessionId, callId, rootCallId: null, toolName: 'write', sourceSeq: 1,
  outcome: 'success', valueState: 'present', process: null, ...extra
});
const footer = (traceId, count, extra = {}) => ({
  kind: 'footer', traceId, observationsWritten: count, captureState: 'finalized',
  diagnostics: [], diagnosticsDropped: 0, ...extra
});
const jsonl = (...records) => Buffer.from(records.map((item) => `${JSON.stringify(item)}\n`).join(''), 'utf8');

try {
  const id = randomUUID();
  const valid = jsonl(header(id), call(1), result(2), footer(id, 2));
  const inspected = inspectTraceBytes(valid);
  assert.equal(inspected.status, 'VALID_METADATA');
  assert.equal(inspected.counts.pairedCalls, 1);
  assert.equal(inspected.hostVerified, false);
  assert.equal(inspected.coverage, 'unknown');

  const reversed = inspectTraceBytes(jsonl(header(id), result(1), call(2), footer(id, 2)));
  assert.equal(reversed.status, 'VALID_METADATA');
  assert.equal(reversed.counts.pairedCalls, 1);

  const replay = inspectTraceBytes(jsonl(header(id), call(1), call(2), result(3), footer(id, 3)));
  assert.equal(replay.status, 'VALID_METADATA');
  assert.equal(replay.counts.exactReplays, 1);
  assert.ok(replay.diagnostics.some((item) => item.code === 'EXACT_REPLAY'));

  const changed = inspectTraceBytes(jsonl(header(id), call(1), call(2, 's1', 'c1', { toolName: 'read' }), result(3), footer(id, 3)));
  assert.equal(changed.status, 'INCOMPLETE');
  assert.ok(changed.diagnostics.some((item) => item.code === 'CALL_CONFLICT'));

  const missingId = inspectTraceBytes(jsonl(header(id), call(1, null, 'c1'), footer(id, 1)));
  assert.equal(missingId.status, 'INCOMPLETE');
  assert.ok(missingId.diagnostics.some((item) => item.code === 'CALL_IDENTITY_MISSING'));

  const orphan = inspectTraceBytes(jsonl(header(id), call(1), footer(id, 1)));
  assert.equal(orphan.status, 'INCOMPLETE');
  assert.ok(orphan.diagnostics.some((item) => item.code === 'CALL_UNPAIRED'));

  const separate = inspectTraceBytes(jsonl(
    header(id), call(1, 's1', 'c1'), call(2, 's2', 'c1'), result(3, 's1', 'c1'), result(4, 's2', 'c1'), footer(id, 4)
  ));
  assert.equal(separate.counts.pairedCalls, 2);

  assert.throws(() => inspectTraceBytes(jsonl(header(id), call(2), footer(id, 1))), /SEQUENCE_INVALID/);
  assert.throws(() => inspectTraceBytes(jsonl(header(id), call(1, 's1', 'c1', { extra: 1 }), footer(id, 1))), /RECORD_INVALID/);
  assert.throws(() => inspectTraceBytes(jsonl(header(id), call(1))), /FOOTER_MISSING/);
  assert.throws(() => inspectTraceBytes(jsonl(header(id), footer(id, 0), call(1))), /TRAILING_DATA/);
  assert.throws(() => inspectTraceBytes(Buffer.alloc(0)), /INPUT_INVALID/);
  assert.throws(() => inspectTraceBytes(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), valid])), /INPUT_INVALID/);

  assert.throws(() => validateHeader({ ...header(id), extra: true }), /RECORD_INVALID/);
  assert.throws(() => validateObservation({ ...call(1), outcome: 'success' }), /FIELD_INVALID/);
  assert.throws(() => validateFooter(footer(id, 1), { traceId: randomUUID() }), /FOOTER_INVALID/);

  // Writer: real file, exclusive creation, twice-stop and close fault.
  const writerFile = join(root, 'writer.jsonl');
  const writer = createTraceWriter({ outputFile: writerFile, assertPath: () => {} });
  assert.equal(writer.open(), true);
  assert.equal(writer.accept(call(1)).accepted, true);
  assert.equal(writer.accept(result(2)).accepted, true);
  const finalized = writer.stop();
  assert.equal(finalized.ok, true);
  assert.equal(writer.stop().ok, false);
  assert.match(readFileSync(writerFile, 'utf8'), /"kind":"footer"/u);

  const existing = join(root, 'existing.jsonl');
  writeFileSync(existing, 'keep', 'utf8');
  const existingWriter = createTraceWriter({ outputFile: existing, assertPath: () => {} });
  assert.throws(() => existingWriter.open(), /WRITE_FAILED/);
  assert.equal(readFileSync(existing, 'utf8'), 'keep');

  const closeFault = join(root, 'close-fault.jsonl');
  const fs = await import('node:fs');
  const closeWriter = createTraceWriter({
    outputFile: closeFault,
    assertPath: () => {},
    io: { openSync: fs.openSync, writeSync: fs.writeSync, closeSync: () => { throw new Error('close injected'); } }
  });
  closeWriter.open();
  closeWriter.accept(call(1));
  const closeHealth = closeWriter.stop();
  assert.equal(closeHealth.closeFailed, 'close injected');
  assert.equal(closeHealth.ok, false);
  assert.match(readFileSync(closeFault, 'utf8'), /"kind":"footer"/u);

  const shortFile = join(root, 'short-write.jsonl');
  const shortWriter = createTraceWriter({
    outputFile: shortFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, Math.min(1, length)),
      closeSync: fs.closeSync
    }
  });
  shortWriter.open();
  assert.equal(shortWriter.accept(call(1)).accepted, true);
  assert.equal(shortWriter.accept(result(2)).accepted, true);
  assert.equal(shortWriter.stop().ok, true);

  const failingFile = join(root, 'write-fault.jsonl');
  let writes = 0;
  const failingWriter = createTraceWriter({
    outputFile: failingFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => {
        writes += 1;
        if (writes >= 2) throw new Error('disk injected');
        return fs.writeSync(fd, buffer, offset, length);
      },
      closeSync: fs.closeSync
    }
  });
  failingWriter.open();
  assert.equal(failingWriter.accept(call(1)).accepted, false);
  assert.equal(failingWriter.stop().ok, false);
  assert.doesNotMatch(readFileSync(failingFile, 'utf8'), /"kind":"footer"/u);

  const limitedFile = join(root, 'limited.jsonl');
  const limitedWriter = createTraceWriter({ outputFile: limitedFile, assertPath: () => {}, maxObservations: 1 });
  limitedWriter.open();
  assert.equal(limitedWriter.accept(call(1)).accepted, true);
  assert.equal(limitedWriter.accept(result(2)).accepted, false);
  assert.equal(limitedWriter.stop().ok, false);

  const byteLimitedFile = join(root, 'byte-limited.jsonl');
  const byteLimited = createTraceWriter({
    outputFile: byteLimitedFile,
    assertPath: () => {},
    maxBytes: 128 * 1024,
    maxObservations: 10_000
  });
  byteLimited.open();
  let accepted = 0;
  for (let index = 0; index < 1000; index += 1) {
    if (byteLimited.accept(call(1, 's1', `c-${index}`)).accepted) accepted += 1;
  }
  assert.ok(accepted > 0);
  assert.equal(byteLimited.stop().ok, false);
  assert.ok(readFileSync(byteLimitedFile).length <= 128 * 1024);

  const privateFile = join(root, 'private.jsonl');
  const privateWriter = createTraceWriter({ outputFile: privateFile, assertPath: () => {} });
  privateWriter.open();
  assert.equal(privateWriter.accept({ ...call(1), rawResult: 'CANARY-SECRET' }).accepted, false);
  privateWriter.stop();
  assert.doesNotMatch(readFileSync(privateFile, 'utf8'), /CANARY-SECRET/u);

  // Adapter: invented dispatcher, rollback, exception containment, reference identity.
  const dispatcher = (() => {
    const handlers = new Map();
    return {
      handlers,
      on(name, fn) { handlers.set(name, fn); },
      off(name) { handlers.delete(name); },
      emit(name, payload) { handlers.get(name)?.(payload); }
    };
  })();
  const received = [];
  const fakeWriter = {
    opened: false,
    open() { this.opened = true; },
    accept(value) { received.push(value); },
    addDiagnostic() {},
    stop() { return { ok: true }; }
  };
  const observer = createToolObserver({ dispatcher, writer: fakeWriter, mapper: (_event, payload) => ({ ...result(1), sessionId: 's', callId: payload.exec.callId }) });
  const attach = observer.attach();
  assert.equal(attach.ok, true);
  const payload = { exec: { callId: 'c9' }, rawResult: 'CANARY' };
  const before = JSON.stringify(payload);
  dispatcher.emit('tools/result', payload);
  assert.equal(JSON.stringify(payload), before);
  assert.equal(received.length, 1);
  assert.equal(received[0].rawResult, undefined);
  dispatcher.emit('tools/result', { get exec() { throw new Error('getter'); } });
  assert.equal(received.length, 1);
  const stop1 = observer.stop();
  const stop2 = observer.stop();
  assert.equal(stop1.ok, true);
  assert.equal(stop2.stopped, true);
  assert.equal(dispatcher.handlers.size, 0);

  const rollbackDispatcher = (() => {
    const handlers = new Map();
    let calls = 0;
    return {
      handlers,
      on(name, fn) { calls += 1; if (calls === 2) throw new Error('subscribe failed'); handlers.set(name, fn); },
      off(name) { handlers.delete(name); }
    };
  })();
  const rollbackWriter = { open() {}, accept() {}, addDiagnostic() {}, stop() { return { ok: false }; } };
  const rollbackObserver = createToolObserver({ dispatcher: rollbackDispatcher, writer: rollbackWriter, subscriptions: ['tools/result', 'session/event'] });
  assert.equal(rollbackObserver.attach().ok, false);
  assert.equal(rollbackDispatcher.handlers.size, 0);

  // CLI: valid, invalid, existing output.
  const traceFile = join(root, 'cli.jsonl');
  writeFileSync(traceFile, valid);
  const reportFile = join(root, 'report.json');
  const cli = spawnSync(process.execPath, [join(process.cwd(), 'tools/inspect-tool-trace.mjs'), '--trace', traceFile, '--out', reportFile], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.schema, 'tla.tool-metadata-report/v1');
  assert.equal(report.status, 'VALID_METADATA');
  assert.equal(report.hostVerified, false);
  assert.equal(report.coverage, 'unknown');
  assert.equal(report.binding.status, 'unproven');

  const invalidTrace = join(root, 'invalid.jsonl');
  writeFileSync(invalidTrace, jsonl(header(id), call(1)));
  const invalidReport = join(root, 'invalid-report.json');
  const invalidCli = spawnSync(process.execPath, [join(process.cwd(), 'tools/inspect-tool-trace.mjs'), '--trace', invalidTrace, '--out', invalidReport], { encoding: 'utf8' });
  assert.equal(invalidCli.status, 2);
  assert.equal(JSON.parse(readFileSync(invalidReport, 'utf8')).status, 'INCOMPLETE');

  const existingReport = spawnSync(process.execPath, [join(process.cwd(), 'tools/inspect-tool-trace.mjs'), '--trace', traceFile, '--out', reportFile], { encoding: 'utf8' });
  assert.equal(existingReport.status, 1);
  assert.equal(JSON.parse(readFileSync(reportFile, 'utf8')).status, 'VALID_METADATA');

  const missingInputReport = join(root, 'missing-input-report.json');
  const missingInput = spawnSync(process.execPath, [join(process.cwd(), 'tools/inspect-tool-trace.mjs'), '--trace', join(root, 'absent.jsonl'), '--out', missingInputReport], { encoding: 'utf8' });
  assert.equal(missingInput.status, 2);
  assert.equal(JSON.parse(readFileSync(missingInputReport, 'utf8')).status, 'INCOMPLETE');

  console.log('tool trace tests: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
