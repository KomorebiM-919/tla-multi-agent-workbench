// B1 offline tests: strict trace contracts, bounded writer, passive adapter and
// the inspector CLI. All records are invented; no DSH module is imported.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  inspectTraceBytes, TRACE_LIMITS, TRACE_SCHEMA, TraceError, validateFooter, validateHeader,
  validateObservation
} from '../tools/lib/tool-trace-contracts.mjs';
import { assertFreshOutputPath } from '../tools/lib/trace-output.mjs';
import { createTraceWriter } from '../orchestration/tool-observer/writer.mjs';
import { createToolObserver } from '../orchestration/tool-observer/index.mjs';

mkdirSync('tests/.scratch', { recursive: true });
const root = mkdtempSync(join(process.cwd(), 'tests/.scratch/b1-trace-'));
const pathDir = join(root, 'path');
mkdirSync(pathDir, { recursive: true });
const fresh = join(pathDir, 'fresh.jsonl');
assert.equal(assertFreshOutputPath(fresh, { reparseProbe: () => ({ available: true, reparse: false }) }), fresh);
assert.throws(() => assertFreshOutputPath(fresh, { reparseProbe: () => ({ available: false }) }), /probe unavailable/u);
assert.throws(() => assertFreshOutputPath(fresh, { reparseProbe: () => ({ available: true, reparse: true }) }), /reparse point/u);
const junctionTarget = join(root, 'junction-target');
const junctionLink = join(root, 'junction-link');
mkdirSync(junctionTarget, { recursive: true });
const madeJunction = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', junctionLink, junctionTarget], { encoding: 'utf8', windowsHide: true });
if (madeJunction.status === 0) {
  assert.throws(() => assertFreshOutputPath(join(junctionLink, 'new.jsonl')), /symbolic link|reparse point/u);
} else {
  console.log(`junction path test skipped: ${String(madeJunction.stderr ?? madeJunction.stdout).trim()}`);
}
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

  const twoSource = inspectTraceBytes(jsonl(header(id), call(1), result(2), footer(id, 2)));
  assert.equal(twoSource.counts.pairedCalls, 1);
  assert.equal(twoSource.status, 'VALID_METADATA');

  const duplicateSource = inspectTraceBytes(jsonl(
    header(id), call(1), result(2), result(3, 's1', 'c1', { source: 'session/event', outcome: 'unknown', valueState: 'unknown' }), footer(id, 3)
  ));
  assert.equal(duplicateSource.status, 'VALID_METADATA');
  assert.equal(duplicateSource.counts.pairedCalls, 1);
  assert.equal(duplicateSource.diagnostics.some((item) => item.code === 'RESULT_CONFLICT'), false);

  const conflictingSource = inspectTraceBytes(jsonl(
    header(id), call(1), result(2), result(3, 's1', 'c1', { source: 'session/event', toolName: 'read', outcome: 'unknown', valueState: 'unknown' }), footer(id, 3)
  ));
  assert.equal(conflictingSource.status, 'INCOMPLETE');
  assert.ok(conflictingSource.diagnostics.some((item) => item.code === 'CALL_CONFLICT'));

  const literalUnknownTool = inspectTraceBytes(jsonl(
    header(id), call(1, 's1', 'c1'),
    call(2, 's1', 'c1', { source: 'session/event', toolName: 'unknown' }), footer(id, 2)
  ));
  assert.equal(literalUnknownTool.status, 'INCOMPLETE');
  assert.ok(literalUnknownTool.diagnostics.some((item) => item.code === 'CALL_CONFLICT'));

  const directOutcomeConflict = inspectTraceBytes(jsonl(
    header(id), call(1), result(2),
    result(3, 's1', 'c1', { source: 'session/event', outcome: 'error', valueState: 'unknown' }),
    footer(id, 3)
  ));
  assert.equal(directOutcomeConflict.status, 'INCOMPLETE');
  assert.ok(directOutcomeConflict.diagnostics.some((item) => item.code === 'RESULT_CONFLICT'));

  const processFacts = (patch = {}) => ({
    exitCode: 0, signal: null, timedOut: null, aborted: null,
    stdoutTruncated: null, stderrTruncated: null, ...patch
  });
  const crossProcessResult = (seq, process, extra = {}) => result(seq, 's1', 'c1', {
    source: 'session/event', process, ...extra
  });

  const processConflict = inspectTraceBytes(jsonl(
    header(id), call(1),
    result(2, 's1', 'c1', { process: processFacts({ exitCode: 0 }) }),
    crossProcessResult(3, processFacts({ exitCode: 1 })),
    footer(id, 3)
  ));
  assert.equal(processConflict.status, 'INCOMPLETE');
  const processConflictDiagnostic = processConflict.diagnostics.find((item) => item.code === 'RESULT_CONFLICT');
  assert.ok(processConflictDiagnostic);
  assert.equal(processConflictDiagnostic.receiptSeq, 3);

  for (const [field, value] of [
    ['exitCode', 1], ['signal', 'SIGKILL'], ['timedOut', true], ['aborted', true],
    ['stdoutTruncated', true], ['stderrTruncated', true]
  ]) {
    const baseline = field === 'exitCode' ? 0 : field === 'signal' ? 'SIGTERM' : false;
    const byField = inspectTraceBytes(jsonl(
      header(id), call(1),
      result(2, 's1', 'c1', { process: processFacts({ [field]: baseline }) }),
      crossProcessResult(3, processFacts({ [field]: value })),
      footer(id, 3)
    ));
    assert.equal(byField.status, 'INCOMPLETE', field);
    assert.ok(byField.diagnostics.some((item) => item.code === 'RESULT_CONFLICT'), field);
  }

  const processNullVsKnown = inspectTraceBytes(jsonl(
    header(id), call(1),
    result(2, 's1', 'c1', { process: processFacts({ exitCode: 0 }) }),
    crossProcessResult(3, processFacts({ exitCode: null })),
    footer(id, 3)
  ));
  assert.equal(processNullVsKnown.status, 'VALID_METADATA');
  assert.equal(processNullVsKnown.diagnostics.some((item) => item.code === 'RESULT_CONFLICT'), false);

  const processBothNull = inspectTraceBytes(jsonl(
    header(id), call(1),
    result(2, 's1', 'c1', { process: processFacts({ exitCode: null, signal: null }) }),
    crossProcessResult(3, processFacts({ exitCode: null, signal: null })),
    footer(id, 3)
  ));
  assert.equal(processBothNull.status, 'VALID_METADATA');

  const processSame = inspectTraceBytes(jsonl(
    header(id), call(1),
    result(2, 's1', 'c1', { process: processFacts({ exitCode: 0, stdoutTruncated: false }) }),
    crossProcessResult(3, processFacts({ exitCode: 0, stdoutTruncated: false })),
    footer(id, 3)
  ));
  assert.equal(processSame.status, 'VALID_METADATA');

  const processComplementary = inspectTraceBytes(jsonl(
    header(id), call(1),
    result(2, 's1', 'c1', { process: processFacts({ exitCode: 0 }) }),
    crossProcessResult(3, processFacts({ exitCode: null, signal: 'SIGTERM' })),
    footer(id, 3)
  ));
  assert.equal(processComplementary.status, 'VALID_METADATA');

  const literalUnknownIdentity = inspectTraceBytes(jsonl(
    header(id), call(1, 's1', 'c1', { toolName: 'unknown' }),
    result(2, 's1', 'c1', { toolName: 'unknown' }), footer(id, 2)
  ));
  assert.equal(literalUnknownIdentity.status, 'VALID_METADATA');

  const changedResultReplay = inspectTraceBytes(jsonl(
    header(id), call(1), result(2), result(3, 's1', 'c1', { outcome: 'error', valueState: 'absent' }), footer(id, 3)
  ));
  assert.equal(changedResultReplay.status, 'INCOMPLETE');
  assert.ok(changedResultReplay.diagnostics.some((item) => item.code === 'RESULT_CONFLICT'));

  const missingIdentity = inspectTraceBytes(jsonl(header(id), call(1, 's1', null), footer(id, 1)));
  assert.equal(missingIdentity.status, 'INCOMPLETE');
  assert.ok(missingIdentity.diagnostics.some((item) => item.code === 'CALL_IDENTITY_MISSING'));

  const crossSession = inspectTraceBytes(jsonl(
    header(id), call(1, 's1', 'c1'), call(2, 's2', 'c1'), result(3, 's1', 'c1'), footer(id, 3)
  ));
  assert.equal(crossSession.status, 'INCOMPLETE');
  assert.ok(crossSession.diagnostics.some((item) => item.code === 'CALL_UNPAIRED'));
  assert.equal(crossSession.diagnostics.some((item) => item.code === 'CALL_CONFLICT'), false);

  assert.throws(() => validateObservation(call(1, 's1 ', 'c1')), /whitespace/u);
  const caseDistinct = inspectTraceBytes(jsonl(
    header(id), call(1, 's1', 'c1'), call(2, 'S1', 'c1'), result(3, 's1', 'c1'), footer(id, 3)
  ));
  assert.equal(caseDistinct.status, 'INCOMPLETE');
  assert.ok(caseDistinct.diagnostics.some((item) => item.code === 'CALL_UNPAIRED'));
  assert.equal(caseDistinct.diagnostics.some((item) => item.code === 'CALL_CONFLICT'), false);

  const resultFirst = inspectTraceBytes(jsonl(header(id), result(1), call(2), footer(id, 2)));
  assert.equal(resultFirst.status, 'VALID_METADATA');
  assert.equal(resultFirst.counts.pairedCalls, 1);

  const dropped = inspectTraceBytes(jsonl(header(id), footer(id, 0, { diagnosticsDropped: 1 })));
  assert.equal(dropped.status, 'INCOMPLETE');
  assert.ok(dropped.diagnostics.some((item) => item.code === 'LIMIT_REACHED'));

  const pending = inspectTraceBytes(jsonl(header(id), call(1, 's1', 'c1'), call(2, 's1', 'c2'), footer(id, 2)), { maxPending: 1 });
  assert.equal(pending.status, 'INCOMPLETE');
  assert.ok(pending.diagnostics.some((item) => item.code === 'LIMIT_REACHED'));
  assert.throws(() => inspectTraceBytes(valid, { maxPending: 0 }), /INPUT_INVALID/);

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
  const paddedHeader = Buffer.from(`${JSON.stringify(header(id))}${' '.repeat(17_000)}\n`);
  assert.throws(() => inspectTraceBytes(Buffer.concat([paddedHeader, Buffer.from(`${JSON.stringify(footer(id, 0))}\n`)])), /HEADER_INVALID/);
  const paddedFooter = Buffer.from(`${JSON.stringify(footer(id, 0))}${' '.repeat(17_000)}\n`);
  assert.throws(() => inspectTraceBytes(Buffer.concat([Buffer.from(`${JSON.stringify(header(id))}\n`), paddedFooter])), /FOOTER_INVALID/);

  assert.throws(() => validateHeader({ ...header(id), extra: true }), /RECORD_INVALID/);
  assert.throws(() => validateObservation({ ...call(1), outcome: 'success' }), /FIELD_INVALID/);
  assert.throws(() => validateFooter(footer(id, 1), { traceId: randomUUID() }), /FOOTER_INVALID/);

  // Writer: real file, exclusive creation, twice-stop and close fault.
  const writerFile = join(root, 'writer.jsonl');
  for (const options of [
    { maxBytes: 0 }, { maxBytes: 131071 }, { maxBytes: 1.5 }, { maxBytes: '1' },
    { maxObservations: 0 }, { maxObservations: -1 }, { maxObservations: 1.5 }, { maxObservations: 10001 },
    { maxPending: 0 }, { maxPending: -1 }, { maxPending: 1.5 }, { maxPending: 1001 }
  ]) {
    assert.throws(() => createTraceWriter({ outputFile: join(root, 'invalid-limits.jsonl'), assertPath: () => {}, ...options }), /WRITE_FAILED/u);
  }
  const validLimits = createTraceWriter({
    outputFile: join(root, 'valid-limits.jsonl'), assertPath: () => {},
    maxBytes: 128 * 1024, maxObservations: 1, maxPending: 1
  });
  assert.equal(typeof validLimits.open, 'function');
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
    io: { openSync: fs.openSync, writeSync: fs.writeSync, closeSync: () => { throw new Error('sk-secret close marker'); } }
  });
  closeWriter.open();
  closeWriter.accept(call(1));
  const closeHealth = closeWriter.stop();
  assert.equal(closeHealth.closeFailed, 'CLOSE_FAILED');
  assert.equal(closeHealth.code, 'CLOSE_FAILED');
  assert.equal(closeHealth.stage, 'close');
  assert.equal(closeHealth.ok, false);
  assert.doesNotMatch(JSON.stringify(closeHealth), /sk-secret/u);
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
  let closeCalls = 0;
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
      closeSync: (fd) => { closeCalls += 1; return fs.closeSync(fd); }
    }
  });
  failingWriter.open();
  assert.equal(failingWriter.accept(call(1)).accepted, false);
  const failingHealth = failingWriter.stop();
  assert.equal(failingHealth.code, 'WRITE_FAILED');
  assert.equal(failingHealth.stage, 'observation');
  assert.equal(failingHealth.closeFailed, null);
  assert.equal(closeCalls, 1);
  assert.doesNotMatch(readFileSync(failingFile, 'utf8'), /"kind":"footer"/u);

  const headerFile = join(root, 'header-fault.jsonl');
  const headerWriter = createTraceWriter({
    outputFile: headerFile,
    assertPath: () => {},
    io: { openSync: fs.openSync, writeSync: () => { throw new Error('header injected sk-secret'); }, closeSync: fs.closeSync }
  });
  let headerError = null;
  try { headerWriter.open(); } catch (error) { headerError = error; }
  assert.match(String(headerError?.message), /WRITE_FAILED/u);
  assert.doesNotMatch(String(headerError?.message), /sk-secret/u);
  const headerHealth = headerWriter.stop();
  assert.equal(headerHealth.ok, false);
  assert.equal(headerHealth.code, 'WRITE_FAILED');
  assert.equal(headerHealth.stage, 'header');

  let headerCloseCalls = 0;
  const headerCloseFile = join(root, 'header-close-fault.jsonl');
  const headerCloseWriter = createTraceWriter({
    outputFile: headerCloseFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: () => { throw new Error('header injected'); },
      closeSync: () => { headerCloseCalls += 1; throw new Error('header close injected'); }
    }
  });
  assert.throws(() => headerCloseWriter.open(), /WRITE_FAILED/u);
  const headerCloseHealth = headerCloseWriter.stop();
  assert.equal(headerCloseHealth.code, 'WRITE_FAILED');
  assert.equal(headerCloseHealth.stage, 'header');
  assert.equal(headerCloseHealth.closeFailed, 'CLOSE_FAILED');
  assert.equal(headerCloseCalls, 1);
  assert.equal(headerCloseWriter.stop().code, 'STOPPED');
  assert.equal(headerCloseCalls, 1);

  const CANARY = 'CANARY_PRIVATE_EXCEPTION';
  const assertSafeWriteError = (error) => {
    assert.ok(error instanceof TraceError);
    assert.equal(error.code, 'WRITE_FAILED');
    assert.doesNotMatch(String(error.message), /CANARY_PRIVATE_EXCEPTION/u);
  };

  const pathFaultFile = join(root, 'path-trace-fault.jsonl');
  const pathFaultWriter = createTraceWriter({
    outputFile: pathFaultFile,
    assertPath: () => { throw new TraceError('CANARY_PATH', CANARY); }
  });
  let pathFaultError = null;
  try { pathFaultWriter.open(); } catch (error) { pathFaultError = error; }
  assertSafeWriteError(pathFaultError);
  const pathFaultHealth = pathFaultWriter.stop();
  assert.equal(pathFaultHealth.stage, 'header');
  assert.equal(pathFaultHealth.code, 'WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(pathFaultHealth), /CANARY_PRIVATE_EXCEPTION/u);

  const openFaultFile = join(root, 'open-trace-fault.jsonl');
  const openFaultWriter = createTraceWriter({
    outputFile: openFaultFile,
    assertPath: () => {},
    io: { openSync: () => { throw new TraceError('CANARY_OPEN', CANARY); }, writeSync: fs.writeSync, closeSync: fs.closeSync }
  });
  let openFaultError = null;
  try { openFaultWriter.open(); } catch (error) { openFaultError = error; }
  assertSafeWriteError(openFaultError);
  const openFaultHealth = openFaultWriter.stop();
  assert.equal(openFaultHealth.stage, 'header');
  assert.equal(openFaultHealth.code, 'WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(openFaultHealth), /CANARY_PRIVATE_EXCEPTION/u);

  const traceHeaderFile = join(root, 'trace-header-fault.jsonl');
  const traceHeaderWriter = createTraceWriter({
    outputFile: traceHeaderFile,
    assertPath: () => {},
    io: { openSync: fs.openSync, writeSync: () => { throw new TraceError('CANARY_HEADER', CANARY); }, closeSync: fs.closeSync }
  });
  let traceHeaderError = null;
  try { traceHeaderWriter.open(); } catch (error) { traceHeaderError = error; }
  assertSafeWriteError(traceHeaderError);
  const traceHeaderHealth = traceHeaderWriter.stop();
  assert.equal(traceHeaderHealth.stage, 'header');
  assert.equal(traceHeaderHealth.code, 'WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(traceHeaderHealth), /CANARY_PRIVATE_EXCEPTION/u);

  let traceObservationWrites = 0;
  const traceObservationFile = join(root, 'trace-observation-fault.jsonl');
  const traceObservationWriter = createTraceWriter({
    outputFile: traceObservationFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => {
        traceObservationWrites += 1;
        if (traceObservationWrites >= 2) throw new TraceError('CANARY_OBSERVATION', CANARY);
        return fs.writeSync(fd, buffer, offset, length);
      },
      closeSync: fs.closeSync
    }
  });
  assert.equal(traceObservationWriter.open(), true);
  assert.equal(traceObservationWriter.accept(call(1)).accepted, false);
  const traceObservationHealth = traceObservationWriter.stop();
  assert.equal(traceObservationHealth.stage, 'observation');
  assert.equal(traceObservationHealth.code, 'WRITE_FAILED');
  assert.doesNotMatch(readFileSync(traceObservationFile, 'utf8'), /CANARY_PRIVATE_EXCEPTION/u);
  assert.doesNotMatch(JSON.stringify(traceObservationHealth), /CANARY_PRIVATE_EXCEPTION/u);

  const traceFooterFile = join(root, 'trace-footer-fault.jsonl');
  const traceFooterWriter = createTraceWriter({
    outputFile: traceFooterFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => {
        if (buffer.toString('utf8').includes('"kind":"footer"')) throw new TraceError('CANARY_FOOTER', CANARY);
        return fs.writeSync(fd, buffer, offset, length);
      },
      closeSync: fs.closeSync
    }
  });
  traceFooterWriter.open();
  traceFooterWriter.accept(call(1));
  const traceFooterHealth = traceFooterWriter.stop();
  assert.equal(traceFooterHealth.stage, 'footer');
  assert.equal(traceFooterHealth.code, 'WRITE_FAILED');
  assert.equal(traceFooterHealth.footerWritten, false);
  assert.doesNotMatch(JSON.stringify(traceFooterHealth), /CANARY_PRIVATE_EXCEPTION/u);

  const traceCloseFile = join(root, 'trace-close-fault.jsonl');
  const traceCloseWriter = createTraceWriter({
    outputFile: traceCloseFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: fs.writeSync,
      closeSync: () => { throw new TraceError('CANARY_CLOSE', CANARY); }
    }
  });
  traceCloseWriter.open();
  traceCloseWriter.accept(call(1));
  const traceCloseHealth = traceCloseWriter.stop();
  assert.equal(traceCloseHealth.code, 'CLOSE_FAILED');
  assert.equal(traceCloseHealth.closeFailed, 'CLOSE_FAILED');
  assert.doesNotMatch(JSON.stringify(traceCloseHealth), /CANARY_PRIVATE_EXCEPTION/u);

  for (const thrown of [CANARY, { message: CANARY }, 42]) {
    const nonstandardFile = join(root, `trace-nonstandard-${Math.random().toString(16).slice(2)}.jsonl`);
    const nonstandardWriter = createTraceWriter({
      outputFile: nonstandardFile,
      assertPath: () => {},
      io: { openSync: fs.openSync, writeSync: () => { throw thrown; }, closeSync: fs.closeSync }
    });
    let nonstandardError = null;
    try { nonstandardWriter.open(); } catch (error) { nonstandardError = error; }
    assertSafeWriteError(nonstandardError);
    assert.doesNotMatch(JSON.stringify(nonstandardWriter.stop()), /CANARY_PRIVATE_EXCEPTION/u);
  }

  const footerFile = join(root, 'footer-fault.jsonl');
  const footerWriter = createTraceWriter({
    outputFile: footerFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => {
        if (buffer.toString('utf8').includes('"kind":"footer"')) throw new Error('footer injected sk-secret');
        return fs.writeSync(fd, buffer, offset, length);
      },
      closeSync: fs.closeSync
    }
  });
  footerWriter.open();
  footerWriter.accept(call(1));
  const footerHealth = footerWriter.stop();
  assert.equal(footerHealth.code, 'WRITE_FAILED');
  assert.equal(footerHealth.stage, 'footer');
  assert.equal(footerHealth.footerWritten, false);
  assert.equal(footerHealth.ok, false);

  const footerCloseFile = join(root, 'footer-close-fault.jsonl');
  const footerCloseWriter = createTraceWriter({
    outputFile: footerCloseFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => {
        if (buffer.toString('utf8').includes('"kind":"footer"')) throw new Error('footer injected');
        return fs.writeSync(fd, buffer, offset, length);
      },
      closeSync: () => { throw new Error('footer close injected sk-secret'); }
    }
  });
  footerCloseWriter.open();
  footerCloseWriter.accept(call(1));
  const footerCloseHealth = footerCloseWriter.stop();
  assert.equal(footerCloseHealth.code, 'WRITE_FAILED');
  assert.equal(footerCloseHealth.stage, 'footer');
  assert.equal(footerCloseHealth.closeFailed, 'CLOSE_FAILED');
  assert.equal(footerCloseHealth.ok, false);
  assert.doesNotMatch(JSON.stringify(footerCloseHealth), /sk-secret/u);
  assert.doesNotMatch(readFileSync(footerCloseFile, 'utf8'), /sk-secret/u);

  const observationCloseFile = join(root, 'observation-close-fault.jsonl');
  const observationCloseWriter = createTraceWriter({
    outputFile: observationCloseFile,
    assertPath: () => {},
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => {
        if (buffer.toString('utf8').includes('"kind":"observation"')) throw new Error('observation injected sk-secret');
        return fs.writeSync(fd, buffer, offset, length);
      },
      closeSync: () => { throw new Error('observation close injected'); }
    }
  });
  observationCloseWriter.open();
  assert.equal(observationCloseWriter.accept(call(1)).accepted, false);
  const observationCloseHealth = observationCloseWriter.stop();
  assert.equal(observationCloseHealth.code, 'WRITE_FAILED');
  assert.equal(observationCloseHealth.stage, 'observation');
  assert.equal(observationCloseHealth.closeFailed, 'CLOSE_FAILED');
  assert.equal(observationCloseHealth.ok, false);
  assert.doesNotMatch(JSON.stringify(observationCloseHealth), /sk-secret/u);
  assert.doesNotMatch(readFileSync(observationCloseFile, 'utf8'), /sk-secret/u);

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
      on(name, fn) { calls += 1; if (calls === 2) throw new TraceError('SUBSCRIBE_FAILED', 'subscribe failed sk-secret'); handlers.set(name, fn); },
      off(name) { handlers.delete(name); }
    };
  })();
  const rollbackWriter = { open() {}, accept() {}, addDiagnostic() {}, stop() { return { ok: false }; } };
  const rollbackObserver = createToolObserver({ dispatcher: rollbackDispatcher, writer: rollbackWriter, subscriptions: ['tools/result', 'session/event'] });
  const rollbackHealth = rollbackObserver.attach();
  assert.equal(rollbackHealth.ok, false);
  assert.doesNotMatch(JSON.stringify(rollbackHealth), /sk-secret/u);
  assert.equal(rollbackDispatcher.handlers.size, 0);
  assert.throws(() => createToolObserver({ dispatcher, writer: fakeWriter, subscriptions: ['tools/result', 'tools/result'] }), /duplicate subscription/u);

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

  const e2e = spawnSync(process.execPath, [join(process.cwd(), 'tools/b1-offline-check.mjs')], { encoding: 'utf8' });
  assert.equal(e2e.status, 0, e2e.stderr);

  console.log('tool trace tests: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
