// Producer wiring test: a real local gated-run child writes a gate receipt, and
// the runner writes the runner receipt after the spawn event. The fake DSH path
// does not exist, so the gate refuses during config probing and never launches a
// host. No real DSH or model server is started.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExperiment } from '../tools/experiment-runner.mjs';
import { newLaunchId, validateGateReceipt, validateRunnerReceipt } from '../tools/lib/launch-receipts.mjs';

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

  const failedRunDir = join(root, 'run-receipt-failure');
  let failedUpstreamPort = await freePort();
  while (failedUpstreamPort === gatePort) failedUpstreamPort = await freePort();
  const failedSpec = {
    ...spec,
    runDir: failedRunDir,
    gatePort: await freePort(),
    upstreamPort: failedUpstreamPort,
    upstreamArgs: [join(scripts, 'upstream.mjs'), '--port', String(failedUpstreamPort), '--run-id', upstreamRunId]
  };
  const failedSummary = await runExperiment(failedSpec, {
    graceMs: 200,
    killMs: 500,
    receiptWriter: (path) => {
      writeFileSync(path, '{"schema":', 'utf8');
      throw new Error('injected receipt write failure');
    }
  });
  assert.equal(failedSummary.status, 'receipt-write-failed');
  assert.equal(failedSummary.receipts.runnerState, null);
  assert.match(String(failedSummary.reason), /injected receipt write failure/u);
  assert.equal(existsSync(failedSummary.receipts.runnerPath), true);
  assert.throws(() => JSON.parse(readFileSync(failedSummary.receipts.runnerPath, 'utf8')));
  assert.equal(failedSummary.teardown.some((item) => item.role === 'host'), true);
  assert.equal(failedSummary.teardown.some((item) => item.role === 'upstream'), true);
  assert.equal(failedSummary.teardown.some((item) => item.role === 'ports' && item.gateFree === true && item.upstreamFree === true), true);

  const gateFailDir = join(root, 'run-gate-write-failure');
  mkdirSync(gateFailDir, { recursive: true });
  const gateFailReceipt = join(gateFailDir, 'gate-receipt.json');
  writeFileSync(gateFailReceipt, 'existing', 'utf8');
  const gateFail = spawnSync(process.execPath, [
    join(process.cwd(), 'tools/gated-run.mjs'),
    '--upstream', 'http://127.0.0.1:1',
    '--model-requests', '1',
    '--heartbeat-file', join(gateFailDir, 'heartbeat'),
    '--dsh-exe', join(root, 'no-such-dsh.exe'),
    '--dsh-cli', join(root, 'no-such-cli.js'),
    '--profile', 'stage1',
    '--prompt', 'receipt write failure test',
    '--run-dir', gateFailDir,
    '--timeout-ms', '1000',
    '--config-timeout-ms', '100',
    '--receipt-runner-id', 'exp-producer-test',
    '--receipt-launch-id', newLaunchId(),
    '--receipt-file', gateFailReceipt
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(gateFail.status, 2);
  assert.match(String(gateFail.stdout) + String(gateFail.stderr), /could not be written|inside the fresh run directory/u);
  assert.equal(readFileSync(gateFailReceipt, 'utf8'), 'existing');

  console.log('receipt producer test: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
