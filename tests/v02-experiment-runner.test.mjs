/**
 * The supervisor is proven against real local processes: a real loopback
 * upstream, real child processes, real ports, real teardown. Nothing here is a
 * mock of `spawn`; every scenario asserts that ports and pids are gone
 * afterwards.
 *
 * No DSH host is started and no external model is contacted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHostArgs, resolveEffective, runExperiment, runSpecFile, stopOwnedProcess, validateSpec, verifyInvocationArgs } from '../tools/experiment-runner.mjs';

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

writeFileSync(join(scripts, 'host-orphan.mjs'), `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const read = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = read('--hold-port', '0');
const pidFile = read('--orphan-pid-file', null);
const code = "const net = require('node:net'); const s = net.createServer(); s.listen(Number(process.argv[1]), '127.0.0.1'); setInterval(() => {}, 1000)";
const orphan = spawn(process.execPath, ['-e', code, port], { stdio: 'ignore', windowsHide: true, detached: true });
orphan.unref();
if (pidFile !== null) writeFileSync(pidFile, String(orphan.pid), 'utf8');
setTimeout(() => process.exit(0), 300);
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
  check('happy path recorded phases in order', summary.phases.map((entry) => entry.phase).join(',').startsWith('pinned-verified,ports-free,upstream-spawned,upstream-ready,upstream-recheck-ok,host-spawned'), summary.phases.map((entry) => entry.phase).join(','));
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
  const s = await spec({ timeoutMs: 1_000, hostArgs: [join(scripts, 'host.mjs'), '--sleep-ms', '30000'] });
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
    timeoutMs: 1_000,
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

const standinFake = join(work, 'fake-upstream.mjs');
writeFileSync(standinFake, '// stand-in upstream for provenance tests\n', 'utf8');
const standinPolicy = join(work, 'standin-policy.json');
writeFileSync(standinPolicy, '{"rules":[]}\n', 'utf8');

// 14. a host that cannot start at all
{
  const s = await spec({ hostCommand: join(work, 'no-such-host.exe') });
  const summary = await runExperiment(s);
  check('a host that cannot be spawned is host-spawn-failed', summary.status === 'host-spawn-failed', summary.status);
  check('the failure explains itself', /no such file|cannot find|ENOENT/u.test(String(summary.reason)) || String(summary.reason).includes('did not start'), summary.reason);
  check('the upstream is torn down when the host cannot start', summary.owned.every((entry) => entry.pid === null || !pidAlive(entry.pid)), JSON.stringify(summary.owned.map((entry) => entry.pid)));
  check('ports are free after a failed host spawn', (await portFree(s.gatePort)) && (await portFree(s.upstreamPort)));
}

// 15. a grandchild outliving its parent is not reported as a clean run
{
  const orphanFile = join(work, 'orphan.pid');
  const s = await spec({ requireTreeProof: true });
  s.hostArgs = [join(scripts, 'host-orphan.mjs'), '--hold-port', String(s.gatePort), '--orphan-pid-file', orphanFile];
  const summary = await runExperiment(s);
  const orphanPid = existsSync(orphanFile) ? Number(readFileSync(orphanFile, 'utf8')) : 0;
  check('the stand-in host left a grandchild holding the gate port', Number.isInteger(orphanPid) && orphanPid > 0, String(orphanPid));
  check('an unclean teardown is not completed', summary.status === 'cleanup-anomaly', summary.status);
  check('the anomaly names the surviving port', String(summary.reason).includes(String(s.gatePort)), summary.reason);
  check('the run records that its host exited before teardown', summary.treeProof === 'exited-before-teardown', String(summary.treeProof));
  if (orphanPid > 0) spawnSync('taskkill', ['/PID', String(orphanPid), '/T', '/F'], { encoding: 'utf8' });
  await sleep(300);
}

// 15b. A host that exits on its own cannot prove its tree, so a run that requires tree
// proof must not report completed even though the host exited 0.
{
  const s = await spec({ requireTreeProof: true });
  s.hostArgs = [join(scripts, 'host.mjs'), '--sleep-ms', '200', '--exit-code', '0'];
  const summary = await runExperiment(s);
  check('a clean host exit without tree proof is not completed', summary.status === 'cleanup-anomaly', summary.status);
  check('the tree-proof anomaly names the reason', /descendants|tree/u.test(String(summary.reason)), summary.reason);
  check('the anomaly records the exited-before-teardown proof', summary.treeProof === 'exited-before-teardown', String(summary.treeProof));
}
{
  const s = await spec({});
  s.hostArgs = [join(scripts, 'host.mjs'), '--sleep-ms', '200', '--exit-code', '0'];
  const summary = await runExperiment(s);
  check('without a tree-proof requirement a host exit 0 still completes', summary.status === 'completed', summary.status);
  check('the completed run records how the host ended', summary.treeProof === 'exited-before-teardown', String(summary.treeProof));
}

// 15c. When teardown gets to a live host that already spawned a child of its own, the run
// records what it collected and that child is gone afterwards.
{
  const grandchildFile = join(work, 'teardown-grandchild.pid');
  const s = await spec({ timeoutMs: 1500 });
  s.hostArgs = [join(scripts, 'host.mjs'), '--sleep-ms', '10000', '--exit-code', '0', '--grandchild-pid-file', grandchildFile];
  const summary = await runExperiment(s);
  const grandchildPid = existsSync(grandchildFile) ? Number(readFileSync(grandchildFile, 'utf8')) : 0;
  check('the timed-out host had started a child of its own', grandchildPid > 0, String(grandchildPid));
  check('the timed-out run is torn down, not left running', summary.status === 'timeout', summary.status);
  const hostTeardown = summary.teardown.find((entry) => entry.role === 'host');
  const proof = hostTeardown === undefined ? 'missing' : hostTeardown.descendantsProof;
  check(
    'teardown says whether it could enumerate the tree',
    proof === 'collected' || proof === 'unavailable',
    String(proof)
  );
  if (proof === 'collected') {
    check('teardown enumerated the descendants it killed', summary.treeProof === 'descendants-killed', String(summary.treeProof));
  } else {
    check('without enumeration the run does not claim descendant proof', summary.treeProof === 'tree-killed', String(summary.treeProof));
  }
  check('the grandchild did not survive the supervisor', grandchildPid > 0 && !pidAlive(grandchildPid), String(grandchildPid));
  if (grandchildPid > 0 && pidAlive(grandchildPid)) spawnSync('taskkill', ['/PID', String(grandchildPid), '/T', '/F'], { encoding: 'utf8' });
}

// 16. an exception mid-run still tears the run down
{
  const s = await spec({});
  const summary = await runExperiment(s, {
    afterReady: () => { throw new Error('injected failure after the upstream was ready'); }
  });
  check('an exception is reported as internal-error', summary.status === 'internal-error', summary.status);
  check('the exception text is kept', String(summary.reason).includes('injected failure'), summary.reason);
  check('an exception still stops the upstream', summary.owned.every((entry) => entry.pid === null || !pidAlive(entry.pid)));
  check('an exception still frees the ports', (await portFree(s.gatePort)) && (await portFree(s.upstreamPort)));
  check('an exception still writes the summary', existsSync(join(work, 'runner-' + s.upstreamRunId + '.json')));
}

// 17. the timing parameters are validated, not only the budget
{
  const base = { profile: 'x', projectCwd: projectDir, runDir: join(work, 'range-run'), gatePort: 18_301, upstreamPort: 18_302, fakeServerPath: standinFake, policyPath: standinPolicy };
  const rejects = (overrides) => {
    try { validateSpec({ ...base, ...overrides }); return null; } catch (error) { return error.code; }
  };
  check('a lease ttl below one second is rejected', rejects({ leaseTtlMs: 500 }) === 'spec-invalid');
  check('a lease ttl above one minute is rejected', rejects({ leaseTtlMs: 60_001 }) === 'spec-invalid');
  check('a heartbeat max age below half a second is rejected', rejects({ heartbeatMaxAgeMs: 100 }) === 'spec-invalid');
  check('a heartbeat max age larger than the lease is rejected', rejects({ leaseTtlMs: 2_000, heartbeatMaxAgeMs: 5_000 }) === 'spec-invalid');
  check('a timeout below one second is rejected', rejects({ timeoutMs: 10 }) === 'spec-invalid');
  check('a timeout above fifteen minutes is rejected', rejects({ timeoutMs: 900_001 }) === 'spec-invalid');
  check('a non numeric timeout is rejected', rejects({ timeoutMs: 'soon' }) === 'spec-invalid');
  check('the defaults are accepted', rejects({}) === null);
}

// 18-21. pinned revisions are checked against the bytes on disk
const gitIn = (repo, args) => {
  // Pipes are refused in this sandbox, so git output goes through a temporary file.
  const dir = mkdtempSync(join(tmpdir(), 'tla-test-git-'));
  const out = join(dir, 'out.txt');
  const fd = openSync(out, 'w');
  const result = spawnSync('git', ['-C', repo, ...args], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const text = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout: text };
};
const pinnedRepo = join(work, 'pinned');
mkdirSync(join(pinnedRepo, 'tests', 'fixtures', 'repair-protocol'), { recursive: true });
writeFileSync(join(pinnedRepo, 'tests', 'fixtures', 'repair-protocol', 'request-001.json'), '{"fixture":1}\n', 'utf8');
writeFileSync(join(pinnedRepo, 'tests', 'fixtures', 'repair-loop-policy.v2.json'), '{"rules":[]}\n', 'utf8');
gitIn(pinnedRepo, ['init', '-q']);
gitIn(pinnedRepo, ['add', '-A']);
gitIn(pinnedRepo, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'fixture']);
const pinnedSha = gitIn(pinnedRepo, ['rev-parse', 'HEAD']).stdout.trim();

{
  const s = await spec({ pinned: { sourceSha: pinnedSha, fixturesSha: pinnedSha }, fakeServerPath: standinFake, policyPath: standinPolicy });
  const summary = await runExperiment(s, { repoRoot: pinnedRepo });
  check('a verified pinned run completes', summary.status === 'completed', summary.status);
  check('provenance was checked before spawning', summary.phases.map((entry) => entry.phase).includes('pinned-verified'));
  check('provenance records the executing sha', summary.pinnedEvidence.head === pinnedSha, String(summary.pinnedEvidence.head));
  check('every provenance check passed', summary.pinnedEvidence.checks.every((entry) => entry.ok === true), JSON.stringify(summary.pinnedEvidence.checks.filter((entry) => !entry.ok)));
  check('the fake server bytes are hashed into the evidence', /^[0-9a-f]{64}$/u.test(summary.pinnedEvidence.fakeServer.sha256), String(summary.pinnedEvidence.fakeServer.sha256));
  check('the policy bytes are hashed into the evidence', /^[0-9a-f]{64}$/u.test(summary.pinnedEvidence.policy.sha256), String(summary.pinnedEvidence.policy.sha256));
}

{
  const s = await spec({ pinned: { sourceSha: '0'.repeat(40), fixturesSha: pinnedSha }, fakeServerPath: standinFake, policyPath: standinPolicy });
  const summary = await runExperiment(s, { repoRoot: pinnedRepo });
  check('a wrong pinned source is refused', summary.status === 'spec-invalid', summary.status);
  check('the refusal names the source mismatch', /does not match pinned source/u.test(String(summary.reason)), summary.reason);
  check('nothing was spawned when provenance failed', summary.owned.length === 0, String(summary.owned.length));
}

{
  writeFileSync(join(pinnedRepo, 'tests', 'fixtures', 'repair-protocol', 'request-001.json'), '{"fixture":2}\n', 'utf8');
  gitIn(pinnedRepo, ['add', '-A']);
  gitIn(pinnedRepo, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'drift']);
  const s = await spec({ pinned: { sourceSha: pinnedSha, fixturesSha: pinnedSha }, fakeServerPath: standinFake, policyPath: standinPolicy });
  const summary = await runExperiment(s, { repoRoot: pinnedRepo });
  check('fixture drift is refused', summary.status === 'spec-invalid', summary.status);
  check('the refusal names the fixture drift', /differ from pinned revision/u.test(String(summary.reason)), summary.reason);
  check('drift is refused before anything is spawned', summary.owned.length === 0, String(summary.owned.length));
}

{
  const dirtyRepo = join(work, 'dirty');
  mkdirSync(join(dirtyRepo, 'tests', 'fixtures', 'repair-protocol'), { recursive: true });
  writeFileSync(join(dirtyRepo, 'tests', 'fixtures', 'repair-protocol', 'request-001.json'), '{"fixture":1}\n', 'utf8');
  writeFileSync(join(dirtyRepo, 'tests', 'fixtures', 'repair-loop-policy.v2.json'), '{"rules":[]}\n', 'utf8');
  gitIn(dirtyRepo, ['init', '-q']);
  gitIn(dirtyRepo, ['add', '-A']);
  gitIn(dirtyRepo, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'fixture']);
  const sha = gitIn(dirtyRepo, ['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(join(dirtyRepo, 'tests', 'fixtures', 'repair-loop-policy.v2.json'), '{"rules":[1]}\n', 'utf8');
  const s = await spec({ pinned: { sourceSha: sha, fixturesSha: sha }, fakeServerPath: standinFake, policyPath: standinPolicy });
  const summary = await runExperiment(s, { repoRoot: dirtyRepo });
  check('an executing checkout with local modifications is refused', summary.status === 'spec-invalid', summary.status);
  check('the refusal names the local modification', /local modifications/u.test(String(summary.reason)), summary.reason);
}

// 22. the argv carries the numbers the summary will report
{
  const effective = resolveEffective({ modelRequests: 7, leaseTtlMs: 3_000, heartbeatMaxAgeMs: 2_000, timeoutMs: 60_000 });
  const endpoints = { gatePort: 18_401, upstreamPort: 18_402, upstreamUrl: 'http://127.0.0.1:18402', healthUrl: 'http://127.0.0.1:18402/health', runId: 'argv-run' };
  const args = buildHostArgs({ profile: 'standin', projectCwd: projectDir, requireFiles: ['a.txt'] }, endpoints, join(work, 'argv-run'), join(work, 'argv-overlay.yml'), effective);
  const valueOf = (flag) => args[args.indexOf(flag) + 1];
  check('the argv carries the budget', valueOf('--model-requests') === '7', String(valueOf('--model-requests')));
  check('the argv carries the lease ttl', valueOf('--lease-ttl-ms') === '3000', String(valueOf('--lease-ttl-ms')));
  check('the argv carries the heartbeat max age', valueOf('--heartbeat-max-age-ms') === '2000', String(valueOf('--heartbeat-max-age-ms')));
  check('the argv carries the timeout', valueOf('--timeout-ms') === '60000', String(valueOf('--timeout-ms')));
  const agreement = verifyInvocationArgs(args, {
    '--model-requests': '7', '--lease-ttl-ms': '3000', '--heartbeat-max-age-ms': '2000', '--timeout-ms': '60000'
  });
  check('the argv agrees with the resolved spec', agreement.ok === true, JSON.stringify(agreement.mismatches));
  const drifted = verifyInvocationArgs(args, { '--lease-ttl-ms': '4000', '--timeout-ms': '60000' });
  check('a drifted argv is caught', drifted.ok === false);
  check('the disagreement names the flag', drifted.mismatches.join(',').includes('--lease-ttl-ms'), drifted.mismatches.join(','));
  const defaults = resolveEffective({});
  check('the resolved defaults are the documented ones', defaults.modelRequests === 40 && defaults.timeoutMs === 300_000, JSON.stringify(defaults));
}

console.log('v02-experiment-runner: ' + checks + ' checks, ' + failures + ' failures');
process.exit(failures === 0 ? 0 : 1);
