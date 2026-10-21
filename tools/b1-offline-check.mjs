// Offline B1 end-to-end smoke check. It uses an invented dispatcher, a temporary
// trace/writer/report and an explicit bundle selection. It never imports DSH and
// never starts a host or model.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createTraceWriter } from '../orchestration/tool-observer/writer.mjs';
import { createToolObserver } from '../orchestration/tool-observer/index.mjs';
import { assertFreshOutputPath } from '../tools/lib/trace-output.mjs';
import { assembleBundle } from '../tools/bundle-run-evidence.mjs';

const root = mkdtempSync(join(process.cwd(), 'tests/.scratch/b1-e2e-'));
const trace = join(root, 'observer.jsonl');
const report = join(root, 'report.json');
function fakeDispatcher() {
  const handlers = new Map();
  return {
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler); },
    off(name, handler) { handlers.get(name)?.delete(handler); },
    emit(name, payload) { for (const handler of handlers.get(name) ?? []) handler(payload); },
    count(name) { return handlers.get(name)?.size ?? 0; }
  };
}

function mapper(eventName, payload) {
  if (eventName === 'session/event') {
    return {
      source: 'session/event', event: 'call', sessionId: payload.sessionId, callId: payload.callId,
      rootCallId: null, toolName: payload.toolName, sourceSeq: null,
      outcome: 'unknown', valueState: 'absent', process: null
    };
  }
  return {
    source: 'tools/result', event: 'result', sessionId: payload.sessionId, callId: payload.callId,
    rootCallId: null, toolName: payload.toolName, sourceSeq: null,
    outcome: 'success', valueState: 'present', process: null
  };
}

function writeTrace({ includeResult = true } = {}) {
  rmSync(trace, { force: true });
  rmSync(report, { force: true });
  const writer = createTraceWriter({ outputFile: trace, assertPath: (path) => assertFreshOutputPath(path) });
  const dispatcher = fakeDispatcher();
  const observer = createToolObserver({ dispatcher, writer, mapper, subscriptions: ['session/event', 'tools/result'] });
  assert.equal(observer.attach().ok, true);
  dispatcher.emit('session/event', { sessionId: 's1', callId: 'c1', toolName: 'write' });
  if (includeResult) dispatcher.emit('tools/result', { sessionId: 's1', callId: 'c1', toolName: 'write' });
  assert.equal(observer.stop().ok, true);
  assert.equal(dispatcher.count('session/event'), 0);
  assert.equal(dispatcher.count('tools/result'), 0);
}

function cli(input = trace) {
  rmSync(report, { force: true });
  return spawnSync(process.execPath, [join(process.cwd(), 'tools/inspect-tool-trace.mjs'), '--trace', input, '--out', report], { encoding: 'utf8' });
}

try {
  writeTrace();
  const good = cli();
  if (good.status !== 0) {
    console.error('GOOD_CLI', good.status, good.stdout, good.stderr);
    console.error(readFileSync(report, 'utf8'));
  }
  assert.equal(good.status, 0);
  const goodReport = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
  assert.equal(goodReport.status, 'VALID_METADATA');
  assert.equal(goodReport.hostVerified, false);
  assert.equal(goodReport.coverage, 'unknown');
  assert.equal(goodReport.binding.status, 'unproven');

  const bundleOut = join(root, 'bundle');
  const bundle = assembleBundle({
    artifacts: [{ id: 'observer', role: 'observer-events', sourcePath: trace, path: 'observer.jsonl' }]
  }, { out: bundleOut, pathSafetyProbe: () => ({ available: true, reparse: false }) });
  assert.equal(bundle.exitCode, 2);
  assert.equal(bundle.manifest.status, 'INCOMPLETE');
  assert.equal(bundle.manifest.hostVerified, false);
  assert.equal(bundle.manifest.binding.status, 'unproven');

  writeTrace({ includeResult: false });
  assert.equal(cli().status, 2); // report is INCOMPLETE, so the CLI exits 2
  const missing = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(missing.status, 'INCOMPLETE');
  assert.ok(missing.diagnostics.some((item) => item.code === 'CALL_UNPAIRED'));

  writeTrace();
  const truncated = join(root, 'truncated.jsonl');
  const bytes = readFileSync(trace);
  writeFileSync(truncated, bytes.subarray(0, Math.max(0, bytes.length - 20)));
  assert.equal(cli(truncated).status, 2);

  const fault = join(root, 'fault.jsonl');
  let writes = 0;
  const faultWriter = createTraceWriter({
    outputFile: fault,
    assertPath: (path) => assertFreshOutputPath(path),
    io: {
      openSync: fs.openSync,
      writeSync: (fd, buffer, offset, length) => {
        writes += 1;
        if (writes >= 2) throw new Error('invented write failure');
        return fs.writeSync(fd, buffer, offset, length);
      },
      closeSync: fs.closeSync
    }
  });
  const faultDispatcher = fakeDispatcher();
  const faultObserver = createToolObserver({ dispatcher: faultDispatcher, writer: faultWriter, mapper, subscriptions: ['session/event', 'tools/result'] });
  assert.equal(faultObserver.attach().ok, true);
  faultDispatcher.emit('session/event', { sessionId: 's1', callId: 'c1', toolName: 'write' });
  assert.equal(faultObserver.stop().ok, false);
  assert.equal(cli(fault).status, 2);

  const dropped = join(root, 'dropped.jsonl');
  const lines = readFileSync(trace, 'utf8').trimEnd().split(/\r?\n/u);
  const footer = JSON.parse(lines.pop());
  footer.diagnosticsDropped = 1;
  writeFileSync(dropped, `${lines.join('\n')}\n${JSON.stringify(footer)}\n`, 'utf8');
  assert.equal(cli(dropped).status, 2);

  console.log(JSON.stringify({
    schema: 'tla.b1-offline-check/v1',
    status: 'ok',
    trace: 'invented',
    hostVerified: false,
    coverage: 'unknown',
    binding: 'unproven',
    checks: ['normal', 'bundle', 'missing-result', 'write-failure', 'truncated', 'dropped-diagnostics']
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
