// Bounded JSONL writer for tla.tool-metadata-trace/v1. Importing this module has
// no side effects; the writer opens only on an explicit open().
import { closeSync, openSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  TRACE_LIMITS, TRACE_SCHEMA, TraceError, validateDiagnostic, validateFooter,
  validateHeader, validateObservation
} from '../../tools/lib/tool-trace-contracts.mjs';

function fail(code, detail) { throw new TraceError(code, detail); }
function limit(value, fallback, name, minimum = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > fallback) {
    fail('WRITE_FAILED', `${name} must be a safe integer between ${minimum} and ${fallback}`);
  }
  return value;
}
function bytesOf(value) { return Buffer.byteLength(value, 'utf8'); }

export function createTraceWriter({
  outputFile,
  traceId = randomUUID(),
  origin = 'simulated-dispatcher',
  bindingClaim = { runnerRunId: null, launchId: null, gateRunId: null, budgetRunId: null },
  maxBytes = TRACE_LIMITS.maxBytes,
  maxObservations = TRACE_LIMITS.maxObservations,
  maxPending = TRACE_LIMITS.maxPending,
  assertPath = null,
  io = { openSync, writeSync, closeSync }
} = {}) {
  if (typeof outputFile !== 'string' || outputFile.length === 0) fail('WRITE_FAILED', 'outputFile is required');
  if (typeof assertPath !== 'function') fail('WRITE_FAILED', 'assertPath is required');
  const byteLimit = limit(maxBytes, TRACE_LIMITS.maxBytes, 'maxBytes', TRACE_LIMITS.minMaxBytes);
  const observationLimit = limit(maxObservations, TRACE_LIMITS.maxObservations, 'maxObservations');
  limit(maxPending, TRACE_LIMITS.maxPending, 'maxPending');
  const header = validateHeader({
    schema: TRACE_SCHEMA,
    kind: 'header',
    traceId,
    origin,
    scope: 'tool-metadata-only',
    bindingClaim,
    order: 'observer-delivery-only',
    coverage: 'unknown'
  });
  let fd = null;
  let opened = false;
  let stopped = false;
  let bytes = 0;
  let observations = 0;
  let receiptSeq = 0;
  let degraded = false;
  let writeFailed = false;
  let closeFailed = null;
  let primaryFailure = null;
  const diagnostics = [];
  let diagnosticsDropped = 0;

  function recordPrimary(stage, code) {
    if (primaryFailure === null) primaryFailure = { stage, code };
  }

  function addDiagnostic(code, seq = null, count = 1) {
    if (!['FIELD_UNAVAILABLE', 'FIELD_INVALID', 'CALL_UNPAIRED', 'RESULT_UNPAIRED',
      'CALL_IDENTITY_MISSING', 'CALL_CONFLICT', 'RESULT_CONFLICT',
      'SOURCE_LINK_AMBIGUOUS', 'LIMIT_REACHED', 'WRITE_FAILED', 'SUBSCRIBE_FAILED',
      'UNSUBSCRIBE_FAILED', 'NORMALIZATION_FAILED'].includes(code)) return;
    const existing = diagnostics.find((item) => item.code === code && item.receiptSeq === seq);
    if (existing) { existing.count += count; return; }
    if (diagnostics.length >= TRACE_LIMITS.maxDiagnostics) {
      diagnosticsDropped += count;
      degraded = true;
      return;
    }
    diagnostics.push(validateDiagnostic({ code, receiptSeq: seq, count }));
    if (!['FIELD_UNAVAILABLE'].includes(code)) degraded = true;
  }

  function writeAll(text) {
    const buffer = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = io.writeSync(fd, buffer, offset, buffer.length - offset);
      if (!Number.isInteger(written) || written <= 0) fail('WRITE_FAILED', 'short write');
      offset += written;
    }
    bytes += buffer.length;
  }

  function serialize(record) {
    const line = `${JSON.stringify(record)}\n`;
    if (bytesOf(line) > TRACE_LIMITS.maxRecordBytes) fail('WRITE_FAILED', 'record exceeds 16 KiB');
    return line;
  }

  function open() {
    if (opened || stopped) fail('WRITE_FAILED', 'writer is not reusable');
    try {
      assertPath(outputFile);
    } catch (error) {
      recordPrimary('header', 'WRITE_FAILED');
      if (error instanceof TraceError) throw error;
      throw new TraceError('WRITE_FAILED', 'path assertion failed');
    }
    try {
      fd = io.openSync(outputFile, 'wx');
    } catch (error) {
      recordPrimary('header', 'WRITE_FAILED');
      throw new TraceError('WRITE_FAILED', 'open failed');
    }
    opened = true;
    try {
      const line = serialize(header);
      writeAll(line);
      if (bytes + TRACE_LIMITS.footerReserveBytes > byteLimit) fail('LIMIT_REACHED', 'header leaves no footer reserve');
    } catch (error) {
      writeFailed = true;
      degraded = true;
      recordPrimary('header', error instanceof TraceError ? error.code : 'WRITE_FAILED');
      closeHandle();
      if (error instanceof TraceError) throw error;
      throw new TraceError('WRITE_FAILED', 'header write failed');
    }
    return true;
  }

  function accept(partial) {
    if (!opened || stopped || writeFailed) return { accepted: false, receiptSeq: null };
    if (observations >= observationLimit) {
      addDiagnostic('LIMIT_REACHED');
      return { accepted: false, receiptSeq: null };
    }
    let record;
    try {
      record = { ...partial, kind: 'observation', receiptSeq: receiptSeq + 1 };
      validateObservation(record, { expectedSeq: receiptSeq + 1 });
    } catch (error) {
      addDiagnostic(error?.code === 'FIELD_INVALID' ? 'FIELD_INVALID' : 'NORMALIZATION_FAILED', null);
      return { accepted: false, receiptSeq: null };
    }
    const line = serialize(record);
    if (bytes + bytesOf(line) + TRACE_LIMITS.footerReserveBytes > byteLimit) {
      addDiagnostic('LIMIT_REACHED');
      return { accepted: false, receiptSeq: null };
    }
    try {
      writeAll(line);
    } catch (error) {
      writeFailed = true;
      degraded = true;
      recordPrimary('observation', 'WRITE_FAILED');
      addDiagnostic('WRITE_FAILED');
      return { accepted: false, receiptSeq: null };
    }
    receiptSeq += 1;
    observations += 1;
    return { accepted: true, receiptSeq };
  }

  function closeHandle() {
    if (fd === null) return;
    try {
      io.closeSync(fd);
      fd = null;
    } catch (error) {
      closeFailed = 'CLOSE_FAILED';
      degraded = true;
      fd = null;
    }
  }

  function finalize() {
    if (stopped) {
      return {
        ok: false, code: 'STOPPED', stage: 'stopped', closeFailed,
        diagnostics: diagnostics.map((item) => ({ ...item }))
      };
    }
    if (!opened || writeFailed) {
      closeHandle();
      stopped = true;
      const code = primaryFailure?.code ?? (writeFailed ? 'WRITE_FAILED' : 'NOT_OPEN');
      const stage = primaryFailure?.stage ?? 'write';
      return {
        ok: false,
        code,
        stage,
        closeFailed,
        observations,
        diagnostics: diagnostics.map((item) => ({ ...item }))
      };
    }
    const footer = validateFooter({
      kind: 'footer',
      traceId,
      observationsWritten: observations,
      captureState: degraded ? 'degraded' : 'finalized',
      diagnostics,
      diagnosticsDropped
    }, { traceId });
    let footerOk = true;
    try {
      const line = serialize(footer);
      if (bytes + bytesOf(line) > byteLimit) {
        addDiagnostic('LIMIT_REACHED');
        degraded = true;
        recordPrimary('footer', 'LIMIT_REACHED');
        footerOk = false;
      } else {
        writeAll(line);
      }
    } catch (error) {
      writeFailed = true;
      degraded = true;
      recordPrimary('footer', error instanceof TraceError ? error.code : 'WRITE_FAILED');
      footerOk = false;
    }
    closeHandle();
    stopped = true;
    const code = primaryFailure?.code ?? (closeFailed === null ? null : 'CLOSE_FAILED');
    const stage = primaryFailure?.stage ?? (closeFailed === null ? null : 'close');
    return {
      ok: footerOk && closeFailed === null && !degraded,
      code,
      stage,
      footerWritten: footerOk,
      closeFailed,
      degraded,
      observations,
      diagnostics: diagnostics.map((item) => ({ ...item })),
      diagnosticsDropped
    };
  }

  function stop() { return finalize(); }

  return {
    open,
    accept,
    addDiagnostic,
    finalize,
    stop,
    get opened() { return opened; },
    get stopped() { return stopped; },
    get bytes() { return bytes; },
    get observations() { return observations; }
  };
}
