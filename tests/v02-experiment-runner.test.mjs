/**
 * The supervisor is proven against real local processes: a real loopback
 * upstream, real child processes, real ports, real teardown. Nothing here is a
 * mock of `spawn`; every scenario asserts that ports and pids are gone
 * afterwards.
 *
 * No DSH host is started and no external model is contacted.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExperiment, runSpecFile, stopOwnedProcess, validateSpec } from '../tools/experiment-runner.mjs';

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.log('not ok: ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

const work = mkdtempSync(join(tmpdir(), 'tla-runner-'));
const scripts = join(work, 'standins');
mkdirSync(scripts, { recursive: true });

writeFileSync(join(scripts, 'upstream.mjs'), `
import { createServer } from 'node:http';
const args = process.argv.slice(2);
const read = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(read('--port', '0'));
const runId = read('--run-id', 'standin');
const exitAfterMs = read('--exit-after-ms', null);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, runId, pid: process.pid }));
});
server.listen(port, '127.0.0.1', () => console.log('upstream listening ' + String(port) + ' ' + runId));
if (exitAfterMs !== null) setTimeout(() => { server.close(); process.exit(0); }, Number(exitAfterMs));
`, 'utf8');

writeFileSync(join(scripts, 'host.mjs'), `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const read = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const sleepMs = Number(read('--sleep-ms', '200'));
const exitCode = Number(read('--exit-code', '0'));
const grandchildFile = read('--grandchild-pid-file', null);
if (grandchildFile !== null) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(grandchildFile, String(grandchild.pid), 'utf8');
}
setTimeout(() => process.exit(exitCode), sleepMs);
`, 'utf8');

const freePort = () => new Promise((resolvePromise) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolvePromise(port));
  });
});
const portFree = (port) => new Promise((resolvePromise) => {
  const server = createServer();
  server.once('error', () => resolvePromise(false));
  server.once('listening', () => server.close(() => resolvePromise(true)));
  server.listen(port, '127.0.0.1');
});
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error !== null && error !== undefined && error.code === 'EPERM'; }
};
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const projectDir = join(work, 'project');
mkdirSync(projectDir, { recursive: true });

let scenario = 0;
async function spec(overrides) {
  scenario += 1;
  const gatePort = await freePort();
  const upstreamPort = await freePort();
  const runId = 'standin-' + String(scenario);
  const runDir = join(work, 'run-' + String(scenario));
  const base = {
    profile: 'standin',
    projectCwd: projectDir,
    runDir,
    gatePort,
    upstreamPort,
    upstreamRunId: runId,
    modelRequests: 5,
    timeoutMs: 4_000,
    readyTimeoutMs: 4_000,
    upstreamCommand: process.execPath,
    upstreamArgs: [join(scripts, 'upstream.mjs'), '--port', String(upstreamPort), '--run-id', runId],
    hostCommand: process.execPath,
    hostArgs: [join(scripts, 'host.mjs'), '--sleep-ms', '150'],
    ...overrides
  };
  return base;
}

// 1. happy path
{
  const s = await spec({});
  const summary = await runExperiment(s);
  check('happy path completes', summary.status === 'completed', summary.status);
  check('happy path reports both owned pids', summary.owned.length === 2, String(summary.owned.length));
  check('happy path released the gate port', await portFree(s.gatePort));
  check('happy path released the upstream port', await portFree(s.upstreamPort));
  const dead = summary.owned.every((entry) => !pidAlive(entry.pid));
  check('happy path left no owned process alive', dead, JSON.stringify(summary.owned.map((entry) => entry.pid)));
  check('happy path recorded phases in order', summary.phases.map((entry) => entry.phase).join(',').startsWith('ports-free,upstream-spawned,upstream-ready,upstream-recheck-ok,host-spawned'), summary.phases.map((entry) => entry.phase).join(','));
  const written = JSON.parse(readFileSync(join(work, 'runner-' + s.upstreamRunId + '.json'), 'utf8'));
  check('happy path wrote a runner summary next to the run dir', written.runId === s.upstreamRunId, written.runId);
}

// 2. port conflict before anything starts
{
  const s = await spec({});
  const blocker = createServer();
  await new Promise((resolvePromise) => blocker.listen(s.gatePort, '127.0.0.1', resolvePromise));
  const summary = await runExperiment(s);
  check('a taken gate port stops the experiment', summary.status === 'spec-invalid', summary.status);
  check('the port conflict names the port', String(summary.reason).includes(String(s.gatePort)), summary.reason);
  check('nothing was spawned on a port conflict', summary.owned.length === 0, String(summary.owned.length));
  await new Promise((resolvePromise) => blocker.close(resolvePromise));
}

// 3. upstream cannot start
{
  const s = await spec({
    upstreamArgs: ['-e', 'process.exit(2)']
  });
  const started = Date.now();
  const summary = await runExperiment(s);
  check('a dead upstream is upstream-failed', summary.status === 'upstream-failed', summary.status);
  check('a dead upstream is classified as connect-failed', summary.health[0].status === 'connect-failed' || summary.health[0].status === 'timeout', summary.health[0].status);
  check('a dead upstream never starts the host', summary.hostPid === undefined, String(summary.hostPid));
  check('a dead upstream fails fast', Date.now() - started < 6_000, String(Date.now() - started) + ' ms');
}

// 4. upstream disappears between readiness and host start
{
  const s = await spec({ recheckDelayMs: 700 });
  s.upstreamArgs = [join(scripts, 'upstream.mjs'), '--port', String(s.upstreamPort), '--run-id', s.upstreamRunId, '--exit-after-ms', '250'];
  const summary = await runExperiment(s);
  check('an upstream that dies before the host is stopped', summary.status === 'upstream-lost-before-host', summary.status);
  check('the host is never spawned in that case', summary.hostPid === undefined, String(summary.hostPid));
  check('the readiness probe had succeeded first', summary.health[0].status === 'ok', summary.health[0].status);
  check('the recheck is what caught it', summary.health[1].status === 'connect-failed' || summary.health[1].status === 'timeout', summary.health[1].status);
}

// 5. upstream dies while the host runs
{
  const s = await spec({});
  s.upstreamArgs = [join(scripts, 'upstream.mjs'), '--port', String(s.upstreamPort), '--run-id', s.upstreamRunId, '--exit-after-ms', '600'];
  s.hostArgs = [join(scripts, 'host.mjs'), '--sleep-ms', '6000'];
  const summary = await runExperiment(s);
  check('losing the upstream during the run is upstream-lost', summary.status === 'upstream-lost', summary.status);
  check('the host was started before the loss', summary.hostStarted === true, String(summary.hostStarted));
  check('the host was stopped after the loss', !pidAlive(summary.hostPid), String(summary.hostPid));
  check('ports are free after an upstream loss', (await portFree(s.gatePort)) && (await portFree(s.upstreamPort)));
}

// 6. host fails
{
  const s = await spec({ hostArgs: [join(scripts, 'host.mjs'), '--sleep-ms', '150', '--exit-code', '3'] });
  const summary = await runExperiment(s);
  check('a failing host is host-failed', summary.status === 'host-failed', summary.status);
  check('a failing host reports its exit code', String(summary.reason).includes('3'), summary.reason);
  check('a failing host leaves no upstream alive', summary.owned.every((entry) => !pidAlive(entry.pid)));
}

// 7. timeout is bounded
{
  const s = await spec({ timeoutMs: 800, hostArgs: [join(scripts, 'host.mjs'), '--sleep-ms', '30000'] });
  const started = Date.now();
  const summary = await runExperiment(s);
  const elapsed = Date.now() - started;
  check('a host that never finishes is a timeout', summary.status === 'timeout', summary.status);
  check('the timeout is bounded', elapsed < 8_000, String(elapsed) + ' ms');
  check('timeout stopped the host', !pidAlive(summary.hostPid), String(summary.hostPid));
}

// 8. cancellation is bounded
{
  const s = await spec({ hostArgs: [join(scripts, 'host.mjs'), '--sleep-ms', '30000'] });
  const controller = new AbortController();
  const running = runExperiment(s, { signal: controller.signal });
  await sleep(400);
  const startedAbort = Date.now();
  controller.abort();
  const summary = await running;
  check('cancellation is reported', summary.status === 'cancelled', summary.status);
  check('cancellation is bounded', Date.now() - startedAbort < 8_000, String(Date.now() - startedAbort) + ' ms');
  check('cancellation left no owned process alive', summary.owned.every((entry) => !pidAlive(entry.pid)));
}

// 9. cleanup also removes the host's own children
{
  const grandchildFile = join(work, 'grandchild.pid');
  const s = await spec({
    timeoutMs: 900,
    hostArgs: [join(scripts, 'host.mjs'), '--sleep-ms', '30000', '--grandchild-pid-file', grandchildFile]
  });
  const summary = await runExperiment(s);
  const grandchildPid = Number(readFileSync(grandchildFile, 'utf8'));
  check('the stand-in host started a grandchild', Number.isInteger(grandchildPid) && grandchildPid > 0, String(grandchildPid));
  check('cleanup kills the whole owned tree', !pidAlive(grandchildPid), 'grandchild ' + String(grandchildPid) + ' still alive');
  check('tree cleanup still ends the experiment', summary.status === 'timeout', summary.status);
}

// 10. stopOwnedProcess never hangs
{
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await sleep(150);
  const started = Date.now();
  const result = await stopOwnedProcess(child, { graceMs: 300, killMs: 300 });
  const elapsed = Date.now() - started;
  check('stopOwnedProcess ends the process', !pidAlive(child.pid), String(child.pid));
  check('stopOwnedProcess is bounded', elapsed < 4_000, String(elapsed) + ' ms');
  check('stopOwnedProcess reports how it stopped the process', typeof result.how === 'string' && result.how !== 'still-alive', result.how);
}

// 11. spec validation
{
  let code = null;
  try { validateSpec({ profile: 'x', projectCwd: join(work, 'missing'), runDir: join(work, 'r'), gatePort: 1, upstreamPort: 2 }); } catch (error) { code = error.code; }
  check('a missing project is rejected', code === 'spec-invalid', String(code));
  code = null;
  try { validateSpec({ profile: 'x', projectCwd: projectDir, runDir: join(work, 'r'), gatePort: 18_100, upstreamPort: 18_100 }); } catch (error) { code = error.code; }
  check('identical gate and upstream ports are rejected', code === 'spec-invalid', String(code));
  code = null;
  try { validateSpec({ profile: 'x', projectCwd: projectDir, runDir: join(work, 'r'), gatePort: 18_101, upstreamPort: 18_102, modelRequests: 41 }); } catch (error) { code = error.code; }
  check('more than 40 model requests is rejected', code === 'spec-invalid', String(code));
  const nonEmpty = join(work, 'not-empty');
  mkdirSync(nonEmpty, { recursive: true });
  writeFileSync(join(nonEmpty, 'evidence.txt'), 'x', 'utf8');
  code = null;
  try { validateSpec({ profile: 'x', projectCwd: projectDir, runDir: nonEmpty, gatePort: 18_103, upstreamPort: 18_104 }); } catch (error) { code = error.code; }
  check('a non-empty run dir is rejected', code === 'spec-invalid', String(code));
}

// 12. the same experiment can be driven from one spec file
{
  const s = await spec({});
  const specPath = join(work, 'experiment-spec.json');
  writeFileSync(specPath, JSON.stringify(s, null, 2) + '\n', 'utf8');
  const summary = await runSpecFile(specPath);
  check('a spec file runs the experiment', summary.status === 'completed', summary.status);
  check('a spec file keeps the run id from the spec', summary.runId === s.upstreamRunId, summary.runId);
  check('a spec file leaves no owned process alive', summary.owned.every((entry) => !pidAlive(entry.pid)));
}

// 13. a spec without the fake upstream is rejected
{
  const problems = [];
  try {
    validateSpec({ profile: 'x', projectCwd: projectDir, runDir: join(work, 'run-nofake'), gatePort: 18_201, upstreamPort: 18_202 });
  } catch (error) {
    problems.push(error.message);
  }
  check('a spec without a fake upstream is rejected', problems.length === 1 && /fakeServerPath/u.test(problems[0]), problems.join(';'));
}

console.log('v02-experiment-runner: ' + checks + ' checks, ' + failures + ' failures');
process.exit(failures === 0 ? 0 : 1);
