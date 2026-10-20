// Producer wiring test: a real local gated-run child writes a gate receipt, and
// the runner writes the runner receipt after the spawn event. The fake DSH path
// does not exist, so the gate refuses during config probing and never launches a
// host. No real DSH or model server is started.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExperiment } from '../tools/experiment-runner.mjs';
import { validateGateReceipt, validateRunnerReceipt } from '../tools/lib/launch-receipts.mjs';

const root = mkdtempSync(join(tmpdir(), 'tla-b0-producers-'));
const project = join(root, 'project');
const runDir = join(root, 'run');
const scripts = join(root, 'scripts');
mkdirSync(project, { recursive: true });
mkdirSync(scripts, { recursive: true });

writeFileSync(join(scripts, 'upstream.mjs'), `
import { createServer } from 'node:http';
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const port = Number(value('--port'));
const runId = value('--run-id');
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, runId, pid: process.pid }));
}).listen(port, '127.0.0.1');
`, 'utf8');

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

try {
  const gatePort = await freePort();
  let upstreamPort = await freePort();
  while (upstreamPort === gatePort) upstreamPort = await freePort();
  const upstreamRunId = 'exp-producer-test';
  const spec = {
    schema: 'tla.experiment-spec/v1',
    profile: 'stage1',
    projectCwd: project,
    runDir,
    gatePort,
    upstreamPort,
    modelRequests: 1,
    upstreamRunId: 'exp-producer-test',
    timeoutMs: 5_000,
    readyTimeoutMs: 5_000,
    evidenceReceipts: true,
    prompt: 'receipt producer test',
    dshExe: join(root, 'no-such-dsh.exe'),
    dshCli: join(root, 'no-such-cli.js'),
    dshHome: join(root, 'dsh-home'),
    upstreamCommand: process.execPath,
    upstreamArgs: [join(scripts, 'upstream.mjs'), '--port', String(upstreamPort), '--run-id', upstreamRunId]
  };
  const summary = await runExperiment(spec, { graceMs: 200, killMs: 500 });
  assert.equal(summary.receipts !== null, true);
  assert.equal(summary.receipts.runnerState, 'spawned');
  const runner = JSON.parse(readFileSync(summary.receipts.runnerPath, 'utf8'));
  const gate = JSON.parse(readFileSync(summary.receipts.gatePath, 'utf8'));
  validateRunnerReceipt(runner);
  validateGateReceipt(gate);
  assert.equal(runner.state, 'spawned');
  assert.equal(runner.launcherPid, summary.hostPid);
  assert.equal(runner.launcherInvocationSha256, gate.launcherInvocationSha256);
  assert.equal(runner.runnerRunId, gate.runnerRunId);
  assert.equal(runner.launchId, gate.launchId);
  assert.equal(summary.status, 'host-failed');
  console.log('receipt producer test: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
