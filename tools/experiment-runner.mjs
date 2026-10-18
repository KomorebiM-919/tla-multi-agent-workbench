/**
 * One supervised experiment, from fake upstream to bounded teardown.
 *
 * Why this exists: the launcher refuses to start a host it cannot trust, but it
 * has no opinion about who owns the upstream service. Starting that service
 * from an ordinary tool call produced a detached process which died with the
 * shell that launched it, so the fourth attempt was refused for a reason that
 * had nothing to do with the protection chain (matrix section 18).
 *
 * This runner derives every endpoint from one spec, owns both child processes,
 * proves readiness before the host exists, keeps watching while the host runs,
 * and tears down within a bound whatever happens. It never touches a process it
 * did not spawn.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { probeUpstreamHealth, describeHealth } from './health-probe.mjs';
import { renderOverlay } from './overlay-template.mjs';

export const RUNNER_SCHEMA = 'tla.experiment-run/v1';

export const RUNNER_STATUSES = Object.freeze([
  'completed',
  'upstream-failed',
  'upstream-lost-before-host',
  'upstream-lost',
  'host-failed',
  'host-spawn-failed',
  'timeout',
  'cancelled',
  'preflight-failed',
  'cleanup-anomaly',
  'spec-invalid'
]);

const DEFAULT_LEASE_TTL_MS = 6_000;
const DEFAULT_HEARTBEAT_MAX_AGE_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL_REQUESTS = 40;
const MAX_MODEL_REQUESTS = 40;
const READY_TIMEOUT_MS = 10_000;
const READY_INTERVAL_MS = 100;
const MONITOR_INTERVAL_MS = 100;
const STOP_GRACE_MS = 2_000;
const STOP_KILL_MS = 2_000;
const PORT_FREE_TIMEOUT_MS = 2_000;

export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function randomSuffix() {
  return randomBytes(4).toString('hex');
}

/** DERIVED endpoints: ports, run ids and URLs never come from separate fields. */
export function deriveEndpoints(spec) {
  const upstreamPort = Number(spec.upstreamPort);
  const gatePort = Number(spec.gatePort);
  const runId = typeof spec.upstreamRunId === 'string' && spec.upstreamRunId !== ''
    ? spec.upstreamRunId
    : 'exp-' + Date.now().toString(36) + '-' + randomSuffix();
  return {
    runId,
    upstreamPort,
    gatePort,
    upstreamUrl: 'http://127.0.0.1:' + String(upstreamPort),
    healthUrl: 'http://127.0.0.1:' + String(upstreamPort) + '/health',
    gateUrl: 'http://127.0.0.1:' + String(gatePort)
  };
}

function assertIntegerRange(name, value, min, max) {
  if (!Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new RunnerError('spec-invalid', name + ' must be an integer in ' + String(min) + '..' + String(max) + ' (got ' + String(value) + ')');
  }
}

/** Validate the one spec the whole experiment is derived from. */
export function validateSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RunnerError('spec-invalid', 'spec must be an object');
  }
  const problems = [];
  const requireString = (name, value) => {
    if (typeof value !== 'string' || value.trim() === '') problems.push(name + ' must be a non-empty string');
  };
  requireString('projectCwd', spec.projectCwd);
  requireString('runDir', spec.runDir);
  requireString('profile', spec.profile);
  if (spec.projectCwd !== undefined && !existsSync(resolve(spec.projectCwd))) problems.push('projectCwd does not exist: ' + String(spec.projectCwd));
  if (spec.runDir !== undefined && existsSync(resolve(spec.runDir))) {
    if (readdirSync(resolve(spec.runDir)).length !== 0) problems.push('runDir must not exist or be empty: ' + String(spec.runDir));
  }
  try {
    assertIntegerRange('gatePort', spec.gatePort, 1024, 65_535);
    assertIntegerRange('upstreamPort', spec.upstreamPort, 1024, 65_535);
    assertIntegerRange('modelRequests', spec.modelRequests === undefined ? DEFAULT_MODEL_REQUESTS : spec.modelRequests, 1, MAX_MODEL_REQUESTS);
  } catch (error) {
    problems.push(error.message);
  }
  if (Number(spec.gatePort) === Number(spec.upstreamPort)) problems.push('gatePort and upstreamPort must differ');
  if (spec.requireFiles !== undefined) {
    if (!Array.isArray(spec.requireFiles)) problems.push('requireFiles must be an array');
    else {
      for (const rel of spec.requireFiles) {
        if (typeof rel !== 'string' || rel === '') problems.push('requireFiles entries must be non-empty strings');
        else if (!existsSync(join(resolve(spec.projectCwd), rel))) problems.push('required file is missing: ' + rel);
      }
    }
  }
  if (spec.prompt !== undefined) requireString('prompt', spec.prompt);
  if (spec.upstreamCommand === undefined) {
    requireString('fakeServerPath', spec.fakeServerPath);
    requireString('policyPath', spec.policyPath);
  } else if (!Array.isArray(spec.upstreamArgs)) {
    problems.push('upstreamArgs must be an array when upstreamCommand is set');
  }
  for (const name of ['fakeServerPath', 'policyPath']) {
    const value = spec[name];
    if (typeof value === 'string' && value !== '' && !existsSync(resolve(value))) problems.push(name + ' does not exist: ' + value);
  }
  if (problems.length > 0) throw new RunnerError('spec-invalid', problems.join('; '));
  return true;
}

/** Read a spec file, validate it, and run it. One command per experiment. */
export async function runSpecFile(specPath, options = {}) {
  const text = readFileSync(resolve(specPath), 'utf8');
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (error) {
    throw new RunnerError('spec-invalid', 'spec is not valid JSON: ' + error.message);
  }
  return runExperiment(spec, options);
}

export async function main(argv) {
  const args = argv.slice();
  let specPath = null;
  let checkOnly = false;
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--spec') specPath = args.shift();
    else if (token === '--check') checkOnly = true;
    else {
      console.error('usage: node tools/experiment-runner.mjs --spec <spec.json> [--check]');
      return 2;
    }
  }
  if (specPath === null) {
    console.error('usage: node tools/experiment-runner.mjs --spec <spec.json> [--check]');
    return 2;
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
    validateSpec(spec);
  } catch (error) {
    console.error('SPEC REJECTED — ' + String(error.message));
    return 1;
  }
  if (checkOnly) {
    console.log('SPEC OK — ' + resolve(specPath));
    return 0;
  }
  const summary = await runExperiment(spec);
  console.log('experiment ' + summary.runId + ': ' + summary.status + (summary.reason === null ? '' : ' — ' + summary.reason));
  console.log('summary: ' + join(resolve(spec.runDir), '..', 'runner-' + summary.runId + '.json'));
  if (summary.status !== 'completed') return 1;
  return 0;
}

/** True when nothing accepts connections on the port. */
export function probePortFree(port, timeoutMs = 400) {
  return new Promise((resolvePromise) => {
    const socket = createServer();
    let settled = false;
    const done = (free) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolvePromise(free);
    };
    socket.once('error', () => done(false));
    socket.once('listening', () => done(true));
    socket.listen(port, '127.0.0.1');
    setTimeout(() => done(false), timeoutMs).unref?.();
  });
}

async function waitPortFree(port, timeoutMs = PORT_FREE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePortFree(port, 200)) return true;
    await sleep(50);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && error !== undefined && error.code === 'EPERM';
  }
}

async function waitPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return !pidAlive(pid);
}

/**
 * Stop a process this runner owns: polite signal first, then force, then a
 * bounded tree kill on Windows. Every step is time-boxed so cleanup itself can
 * never hang the experiment.
 */
export async function stopOwnedProcess(child, options = {}) {
  const graceMs = Number.isInteger(options.graceMs) ? options.graceMs : STOP_GRACE_MS;
  const killMs = Number.isInteger(options.killMs) ? options.killMs : STOP_KILL_MS;
  const record = { pid: child === null || child === undefined ? null : child.pid, how: 'none' };
  if (child === null || child === undefined || child.pid === undefined) return record;
  if (child.exitCode !== null && child.exitCode !== undefined) {
    record.how = 'already-exited';
    return record;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  if (await waitPidGone(child.pid, graceMs)) {
    record.how = 'terminated';
    return record;
  }
  if (process.platform === 'win32') {
    // A child we own may itself own a host process; kill the tree so nothing
    // survives the experiment. `taskkill` is time-boxed like every other step.
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: killMs });
    } catch { /* best effort */ }
    if (await waitPidGone(child.pid, killMs)) {
      record.how = 'tree-killed';
      return record;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  if (await waitPidGone(child.pid, killMs)) {
    record.how = 'killed';
    return record;
  }
  record.how = 'still-alive';
  return record;
}

/**
 * Spawn a child whose stdout/stderr go to files, never to pipes: the sandbox
 * forbids named pipes, and the evidence is more useful on disk anyway.
 */
function spawnOwned(role, command, args, options) {
  const logPath = join(options.logDir, role + '.log');
  mkdirSync(options.logDir, { recursive: true });
  const fd = openSync(logPath, 'a');
  const child = spawn(command, args, {
    stdio: ['ignore', fd, fd],
    cwd: options.cwd,
    env: options.env,
    windowsHide: true
  });
  closeSync(fd);
  return { role, child, pid: child.pid === undefined ? null : child.pid, command, args, logPath, startedAt: nowIso() };
}

/** Wait until the upstream answers as this run, classifying every failure. */
export async function waitForUpstream(healthUrl, options = {}) {
  const expectedRunId = options.expectedRunId;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : READY_TIMEOUT_MS;
  const intervalMs = Number.isInteger(options.intervalMs) ? options.intervalMs : READY_INTERVAL_MS;
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : () => true;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeUpstreamHealth(healthUrl, { expectedRunId, timeoutMs: 1_000 });
    if (last.status === 'ok') return last;
    if (last.status !== 'connect-failed' && last.status !== 'timeout') return last;
    if (!isAlive()) return { ...last, status: 'connect-failed', detail: 'upstream process exited before answering' };
    await sleep(intervalMs);
  }
  return last === null
    ? { schema: 'tla.upstream-health/v1', healthUrl, status: 'timeout', detail: 'no answer within ' + String(timeoutMs) + ' ms', observedRunId: null, expectedRunId: expectedRunId === undefined ? null : expectedRunId }
    : { ...last, status: 'timeout', detail: 'not ready within ' + String(timeoutMs) + ' ms (' + last.detail + ')' };
}

function upstreamArgs(spec, endpoints, derived) {
  const argv = [
    resolve(spec.fakeServerPath),
    '--port', String(endpoints.upstreamPort),
    '--policy', resolve(spec.policyPath),
    '--run-id', endpoints.runId,
    '--log', join(derived.logDir, 'upstream-requests.jsonl'),
    '--body-dir', join(derived.logDir, 'upstream-bodies')
  ];
  return argv;
}

/**
 * Run one experiment end to end.
 *
 * @param {object} spec see validateSpec; `upstreamCommand`/`hostCommand` are
 *   overridable so tests can drive the runner with local stand-ins.
 * @param {object} [options] `signal` for cancellation, `preflight` hook.
 */
export async function runExperiment(spec, options = {}) {
  validateSpec(spec);
  const endpoints = deriveEndpoints(spec);
  const runDir = resolve(spec.runDir);
  const workDir = dirname(runDir);
  const logDir = spec.logDir === undefined ? join(workDir, 'logs-' + endpoints.runId) : resolve(spec.logDir);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const overlayPath = join(workDir, 'overlay-' + endpoints.runId + '.patch.yml');
  const modelRequests = spec.modelRequests === undefined ? DEFAULT_MODEL_REQUESTS : Number(spec.modelRequests);
  const overlayText = renderOverlay({
    gateUrl: endpoints.gateUrl,
    runDir,
    modelRequests,
    heartbeatIntervalMs: spec.heartbeatIntervalMs === undefined ? 500 : spec.heartbeatIntervalMs
  });
  writeFileSync(overlayPath, overlayText, 'utf8');

  const summary = {
    schema: RUNNER_SCHEMA,
    runId: endpoints.runId,
    status: 'starting',
    startedAt: nowIso(),
    finishedAt: null,
    spec: {
      profile: spec.profile,
      projectCwd: resolve(spec.projectCwd),
      runDir,
      gatePort: endpoints.gatePort,
      upstreamPort: endpoints.upstreamPort,
      modelRequests,
      leaseTtlMs: spec.leaseTtlMs === undefined ? DEFAULT_LEASE_TTL_MS : spec.leaseTtlMs,
      heartbeatMaxAgeMs: spec.heartbeatMaxAgeMs === undefined ? DEFAULT_HEARTBEAT_MAX_AGE_MS : spec.heartbeatMaxAgeMs,
      timeoutMs: spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : spec.timeoutMs
    },
    derived: endpoints,
    overlayPath,
    logDir,
    pinned: spec.pinned === undefined ? null : spec.pinned,
    phases: [],
    owned: [],
    health: [],
    teardown: [],
    reason: null
  };
  const phase = (name, detail) => {
    summary.phases.push({ phase: name, at: nowIso(), ...(detail === undefined ? {} : { detail }) });
  };
  const owned = { upstream: null, host: null };
  const signal = options.signal;

  const teardown = async () => {
    for (const role of ['host', 'upstream']) {
      const entry = owned[role];
      if (entry === null) continue;
      const result = await stopOwnedProcess(entry.child, { graceMs: options.graceMs, killMs: options.killMs });
      summary.teardown.push({ role, pid: result.pid, how: result.how });
      if (result.how === 'still-alive') summary.status = 'cleanup-anomaly';
    }
    summary.teardown.push({ role: 'ports', gateFree: await waitPortFree(endpoints.gatePort), upstreamFree: await waitPortFree(endpoints.upstreamPort) });
    summary.finishedAt = nowIso();
    writeFileSync(join(workDir, 'runner-' + endpoints.runId + '.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    return summary;
  };

  const fail = async (status, reason) => {
    summary.status = status;
    summary.reason = reason;
    phase('stop', { status, reason });
    return teardown();
  };

  if (signal !== undefined && signal.aborted) return fail('cancelled', 'cancelled before start');

  for (const [name, port] of [['gatePort', endpoints.gatePort], ['upstreamPort', endpoints.upstreamPort]]) {
    if (!(await probePortFree(port))) return fail('spec-invalid', name + ' ' + String(port) + ' is already in use');
  }
  phase('ports-free');

  if (typeof options.preflight === 'function') {
    const checked = await options.preflight({ spec, endpoints, overlayPath });
    summary.preflight = checked;
    if (checked === null || checked === undefined || checked.ok !== true) {
      return fail('preflight-failed', checked === null || checked === undefined ? 'preflight returned nothing' : String(checked.detail));
    }
    phase('preflight-ok', { checks: Array.isArray(checked.checks) ? checked.checks.length : 0 });
  }

  const upstreamCommand = spec.upstreamCommand === undefined ? process.execPath : spec.upstreamCommand;
  const upstreamArgv = spec.upstreamCommand === undefined
    ? upstreamArgs(spec, endpoints, { logDir })
    : spec.upstreamArgs.slice();
  const upstream = spawnOwned('upstream', upstreamCommand, upstreamArgv, { logDir, cwd: spec.projectCwd, env: process.env });
  owned.upstream = upstream;
  summary.owned.push({ role: 'upstream', pid: upstream.pid, command: upstreamCommand, args: upstreamArgv, log: upstream.logPath });
  phase('upstream-spawned', { pid: upstream.pid });

  let upstreamExited = false;
  upstream.child.once('exit', (code, sig) => {
    upstreamExited = true;
    summary.teardown.push({ role: 'upstream-exit', code, signal: sig, at: nowIso() });
  });

  const ready = await waitForUpstream(endpoints.healthUrl, {
    expectedRunId: endpoints.runId,
    timeoutMs: spec.readyTimeoutMs === undefined ? READY_TIMEOUT_MS : spec.readyTimeoutMs,
    isAlive: () => !upstreamExited
  });
  summary.health.push({ step: 'ready', ...ready });
  if (ready.status !== 'ok') return fail('upstream-failed', describeHealth(ready));
  phase('upstream-ready', { observedRunId: ready.observedRunId });

  if (spec.recheckDelayMs !== undefined) await sleep(spec.recheckDelayMs);
  const recheck = await probeUpstreamHealth(endpoints.healthUrl, { expectedRunId: endpoints.runId, timeoutMs: 1_000 });
  summary.health.push({ step: 'recheck', ...recheck });
  if (recheck.status !== 'ok') return fail('upstream-lost-before-host', describeHealth(recheck));
  phase('upstream-recheck-ok');

  const hostCommand = spec.hostCommand === undefined ? process.execPath : spec.hostCommand;
  const hostArgv = spec.hostCommand === undefined ? buildHostArgs(spec, endpoints, runDir, overlayPath) : spec.hostArgs.slice();
  const host = spawnOwned('host', hostCommand, hostArgv, { logDir, cwd: spec.projectCwd, env: buildHostEnv(spec) });
  owned.host = host;
  summary.owned.push({ role: 'host', pid: host.pid, command: hostCommand, args: hostArgv, log: host.logPath });
  summary.hostStarted = true;
  summary.hostPid = host.pid;
  phase('host-spawned', { pid: host.pid });

  const timeoutMs = spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : spec.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  let hostExit = null;
  host.child.once('exit', (code, sig) => { hostExit = { code, signal: sig }; });

  while (true) {
    if (signal !== undefined && signal.aborted) return fail('cancelled', 'cancelled while the host was running');
    if (upstreamExited) {
      summary.reason = 'upstream exited while the host was running';
      return fail('upstream-lost', summary.reason);
    }
    if (hostExit !== null) {
      summary.hostExit = hostExit;
      if (hostExit.code === 0) {
        summary.status = 'completed';
        phase('host-exited', { code: 0 });
        return teardown();
      }
      return fail('host-failed', 'host exited with code ' + String(hostExit.code));
    }
    if (Date.now() > deadline) return fail('timeout', 'host did not finish within ' + String(timeoutMs) + ' ms');
    await sleep(MONITOR_INTERVAL_MS);
  }
}

function buildHostEnv(spec) {
  const env = { ...process.env };
  if (spec.dshHome !== undefined) env.DSH_HOME = spec.dshHome;
  if (spec.fakeKeyEnv !== undefined) env[spec.fakeKeyEnv] = spec.fakeKeyValue;
  return env;
}

function buildHostArgs(spec, endpoints, runDir, overlayPath) {
  const args = [
    resolve(spec.launcherPath === undefined ? 'tools/gated-run.mjs' : spec.launcherPath),
    '--profile', spec.profile,
    '--patch', overlayPath,
    '--project-cwd', resolve(spec.projectCwd),
    '--run-dir', runDir,
    '--gate-port', String(endpoints.gatePort),
    '--upstream', endpoints.upstreamUrl,
    '--upstream-health-url', endpoints.healthUrl,
    '--upstream-run-id', endpoints.runId,
    '--model-requests', String(spec.modelRequests === undefined ? DEFAULT_MODEL_REQUESTS : spec.modelRequests),
    '--heartbeat-file', join(runDir, 'plugin-events.jsonl'),
    '--gate-log', join(runDir, 'gate-events.jsonl'),
    '--summary', join(runDir, 'gate-summary.json'),
    '--timeout-ms', String(spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : spec.timeoutMs)
  ];
  for (const rel of spec.requireFiles === undefined ? [] : spec.requireFiles) args.push('--require-file', rel);
  if (spec.dshExe !== undefined) args.push('--dsh-exe', spec.dshExe);
  if (spec.dshCli !== undefined) args.push('--dsh-cli', spec.dshCli);
  if (spec.dshHome !== undefined) args.push('--dsh-home', spec.dshHome);
  args.push('--prompt', spec.prompt === undefined ? 'supervised experiment' : spec.prompt);
  return args;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1])) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
      console.error('RUNNER ERROR — ' + String(error === null || error === undefined ? 'unknown' : error.message));
      process.exitCode = 1;
    });
  }
}
