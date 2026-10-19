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
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeUpstreamHealth, describeHealth } from './health-probe.mjs';
import { renderOverlay } from './overlay-template.mjs';

// Every default path is resolved from this module, never from the caller's working
// directory: the runner must launch the launcher that lives beside it even when it is
// started from the repository root or from another checkout.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

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
  'internal-error',
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
// Windows only: one process-table query is enough to name every descendant before the tree
// is killed, so a detached member process cannot outlive the run it belongs to.
const DESCENDANT_PROBE_MS = 4_000;
const MAX_DESCENDANT_DEPTH = 32;
const PORT_FREE_TIMEOUT_MS = 2_000;

// Bounds for the knobs that used to be recorded but never passed on. A lease shorter than the
// heartbeat interval, or a heartbeat age longer than the lease, cannot protect anything.
export const LEASE_TTL_RANGE = Object.freeze({ min: 1_000, max: 60_000 });
export const HEARTBEAT_MAX_AGE_RANGE = Object.freeze({ min: 500, max: 30_000 });
export const TIMEOUT_RANGE = Object.freeze({ min: 1_000, max: 900_000 });

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
    for (const [name, range, fallback] of [
      ['leaseTtlMs', LEASE_TTL_RANGE, DEFAULT_LEASE_TTL_MS],
      ['heartbeatMaxAgeMs', HEARTBEAT_MAX_AGE_RANGE, DEFAULT_HEARTBEAT_MAX_AGE_MS],
      ['timeoutMs', TIMEOUT_RANGE, DEFAULT_TIMEOUT_MS]
    ]) {
      assertIntegerRange(name, spec[name] === undefined ? fallback : spec[name], range.min, range.max);
    }
  } catch (error) {
    problems.push(error.message);
  }
  if (Number(spec.gatePort) === Number(spec.upstreamPort)) problems.push('gatePort and upstreamPort must differ');
  if (spec.heartbeatMaxAgeMs !== undefined && spec.leaseTtlMs !== undefined && spec.heartbeatMaxAgeMs > spec.leaseTtlMs) {
    problems.push('heartbeatMaxAgeMs must not exceed leaseTtlMs');
  }
  if (spec.pinned !== undefined && spec.pinned !== null) {
    if (typeof spec.pinned !== 'object' || Array.isArray(spec.pinned)) {
      problems.push('pinned must be an object with sourceSha and fixturesSha');
    } else {
      for (const name of ['sourceSha', 'fixturesSha']) {
        const value = spec.pinned[name];
        if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
          problems.push('pinned.' + name + ' must be a 40-character lowercase hex commit');
        }
      }
      // External files are not versioned with the checkout, so the spec names their bytes.
      // Recording a hash is not verification; when the spec declares one, it is compared.
      if (spec.pinned.external !== undefined) {
        if (typeof spec.pinned.external !== 'object' || spec.pinned.external === null || Array.isArray(spec.pinned.external)) {
          problems.push('pinned.external must be an object');
        } else {
          for (const name of ['fakeServer', 'policy']) {
            const entry = spec.pinned.external[name];
            if (entry === undefined) continue;
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
              problems.push('pinned.external.' + name + ' must be an object');
              continue;
            }
            if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
              problems.push('pinned.external.' + name + '.sha256 must be a 64-character lowercase hex digest');
            }
            if (entry.bytes !== undefined && (!Number.isInteger(entry.bytes) || entry.bytes < 0)) {
              problems.push('pinned.external.' + name + '.bytes must be a non-negative integer');
            }
          }
        }
      }
    }
  }
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
  } catch (error) {
    console.error('SPEC REJECTED — ' + String(error.message));
    return 1;
  }
  if (checkOnly) {
    // --check proves everything the run proves before its first spawn, including the pinned
    // revisions. A shape-only check let stale pins reach a launch and spend an approval.
    const preflight = preflightSpec(spec, { repoRoot: spec.repoRoot });
    for (const check of preflight.checks) {
      console.log('PREFLIGHT ' + (check.ok ? 'ok   ' : 'FAIL ') + check.name + ' — ' + check.detail);
    }
    if (!preflight.ok) {
      console.error('FULL PREFLIGHT REJECTED — ' + preflight.problems.join('; '));
      return 1;
    }
    console.log('FULL PREFLIGHT OK — structure, source, fixtures and external hashes verified');
    return 0;
  }
  const summary = await runExperiment(spec);
  console.log('experiment ' + summary.runId + ': ' + summary.status + (summary.reason === null ? '' : ' — ' + summary.reason));
  console.log('summary: ' + join(resolve(spec.runDir), '..', 'runner-' + summary.runId + '.json'));
  if (summary.status !== 'completed') return 1;
  return 0;
}

/** The values this run will actually use, resolved once. */
export function resolveEffective(spec) {
  return {
    modelRequests: spec.modelRequests === undefined ? DEFAULT_MODEL_REQUESTS : Number(spec.modelRequests),
    leaseTtlMs: spec.leaseTtlMs === undefined ? DEFAULT_LEASE_TTL_MS : Number(spec.leaseTtlMs),
    heartbeatMaxAgeMs: spec.heartbeatMaxAgeMs === undefined ? DEFAULT_HEARTBEAT_MAX_AGE_MS : Number(spec.heartbeatMaxAgeMs),
    timeoutMs: spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(spec.timeoutMs),
    heartbeatIntervalMs: spec.heartbeatIntervalMs === undefined ? 500 : Number(spec.heartbeatIntervalMs)
  };
}

/**
 * Read a pair of `--flag value` entries out of an argv. Used to prove that the argv the host
 * really received carries the same numbers the summary reports.
 */
export function verifyInvocationArgs(args, expected) {
  const mismatches = [];
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  for (const [flag, wanted] of Object.entries(expected)) {
    const seen = value(flag);
    if (String(seen) !== String(wanted)) mismatches.push(flag + ' is ' + String(seen) + ', expected ' + String(wanted));
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Run git and capture both streams through a file.
 *
 * Pipes are unavailable to this process (the sandbox refuses to create the named pipe that
 * child_process uses for `stdio: 'pipe'`), so the stream goes to a temporary file instead.
 */
function runGit(repoRoot, args, gitBin) {
  const dir = mkdtempSync(join(tmpdir(), 'tla-git-'));
  const out = join(dir, 'out.txt');
  const fd = openSync(out, 'w');
  const result = spawnSync(gitBin === undefined ? 'git' : gitBin, ['-C', repoRoot, ...args], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let text = '';
  try {
    text = readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const error = result.error === undefined ? null : String(result.error.message);
  return { status: result.status, stdout: text.trim(), stderr: text.trim(), error };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Repository-relative form of a path, or null when it is outside the repository. Only a path
 * inside the checkout can be versioned by the fixture revision; an external one is hashed.
 */
function repoRelative(repoRoot, path) {
  if (typeof path !== 'string' || path === '') return null;
  const rel = relative(resolve(repoRoot), resolve(path));
  if (rel === '' || rel.startsWith('..') || /^[A-Za-z]:/u.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return null;
  return rel.split('\\').join('/');
}

/**
 * Prove the pinned revisions instead of trusting the label.
 *
 * A spec can say "I ran revision X with fixtures Y"; that sentence is worth nothing unless the
 * bytes on disk are checked against those revisions before anything is spawned. The external
 * fake upstream and the policy are hashed into the same evidence block because they are part of
 * what executes, even though they are not versioned with the repository.
 */
export function verifyPinnedSources(spec, options = {}) {
  const repoRoot = options.repoRoot === undefined ? process.cwd() : options.repoRoot;
  const gitBin = options.gitBin;
  const evidence = {
    schema: 'tla.pinned-sources/v1',
    repoRoot,
    sourceSha: null,
    fixturesSha: null,
    head: null,
    dirty: [],
    fakeServer: null,
    policy: null,
    checks: []
  };
  const problems = [];
  const pinned = spec.pinned === undefined || spec.pinned === null ? null : spec.pinned;
  if (pinned === null) {
    if (spec.requirePinned === true) problems.push('pinned source is required but the spec has none');
    evidence.checks.push({ name: 'pinned:present', ok: spec.requirePinned !== true, detail: pinned === null ? 'no pinned revisions supplied' : '' });
    return { ok: problems.length === 0, problems, evidence };
  }
  evidence.sourceSha = pinned.sourceSha ?? null;
  evidence.fixturesSha = pinned.fixturesSha ?? null;

  const head = runGit(repoRoot, ['rev-parse', 'HEAD'], gitBin);
  evidence.head = head.status === 0 ? head.stdout : null;
  const headMatches = evidence.sourceSha !== null && evidence.head === evidence.sourceSha;
  evidence.checks.push({ name: 'pinned:source', ok: headMatches, detail: 'HEAD ' + String(evidence.head) + ' vs pinned ' + String(evidence.sourceSha) });
  if (!headMatches) problems.push('HEAD ' + String(evidence.head) + ' does not match pinned source ' + String(evidence.sourceSha));

  // Untracked files count as drift too: a fixture copied next to the pinned one would be read
  // by the run while the revision it claims to execute never contained it.
  const status = runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all'], gitBin);
  evidence.dirty = status.status === 0 && status.stdout !== '' ? status.stdout.split(/\r?\n/u) : [];
  const clean = evidence.dirty.length === 0;
  evidence.checks.push({ name: 'pinned:clean', ok: clean, detail: clean ? 'no tracked or untracked modifications' : evidence.dirty.join('; ') });
  if (!clean) problems.push('the executing checkout has local modifications: ' + evidence.dirty.join('; '));

  if (evidence.fixturesSha !== null) {
    const known = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', evidence.fixturesSha + '^{commit}'], gitBin);
    if (known.status !== 0) {
      evidence.checks.push({ name: 'pinned:fixtures', ok: false, detail: 'unknown revision ' + evidence.fixturesSha });
      problems.push('unknown fixture revision ' + evidence.fixturesSha);
    } else {
      // Pin the whole fixture tree, not two chosen files: a policy or protocol file the run
      // actually reads must be part of the revision the spec names. The policy can live
      // outside tests/fixtures; when it does, it is pinned by its own path instead.
      const pinnedPaths = ['tests/fixtures'];
      const policyRel = repoRelative(repoRoot, spec.policyPath);
      if (policyRel !== null && !policyRel.startsWith('tests/fixtures/')) pinnedPaths.push(policyRel);
      evidence.pinnedPaths = pinnedPaths;
      const diff = runGit(repoRoot, ['diff', '--quiet', evidence.fixturesSha, '--', ...pinnedPaths], gitBin);
      const fixtureStatus = runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...pinnedPaths], gitBin);
      const noDrift = fixtureStatus.status === 0 && fixtureStatus.stdout === '';
      const same = diff.status === 0 && noDrift;
      evidence.checks.push({ name: 'pinned:fixtures', ok: same, detail: same ? 'fixture bytes equal ' + evidence.fixturesSha : 'fixture bytes differ from ' + evidence.fixturesSha + (noDrift ? '' : ' (' + fixtureStatus.stdout.replace(/\n/gu, '; ') + ')') });
      if (!same) problems.push('fixture bytes differ from pinned revision ' + evidence.fixturesSha);
      // Byte equality is not the only claim: the revision must also contain the policy the
      // run is about to execute. A policy added after the pinned revision passed the old
      // check because only repair-protocol and v2 were compared.
      if (policyRel !== null) {
        const tracked = runGit(repoRoot, ['cat-file', '-e', evidence.fixturesSha + ':' + policyRel], gitBin);
        const versioned = tracked.status === 0;
        evidence.policyVersioned = versioned;
        evidence.checks.push({ name: 'pinned:policy-versioned', ok: versioned, detail: versioned ? policyRel + ' is in ' + evidence.fixturesSha : policyRel + ' is not tracked at ' + evidence.fixturesSha });
        if (!versioned) problems.push('the policy ' + policyRel + ' is not part of fixture revision ' + evidence.fixturesSha);
      }
    }
  }

  for (const [name, path] of [['fakeServer', spec.fakeServerPath], ['policy', spec.policyPath]]) {
    if (typeof path !== 'string' || path === '' || !existsSync(path)) {
      evidence.checks.push({ name: 'pinned:' + name, ok: false, detail: 'missing ' + String(path) });
      problems.push(name + ' does not exist: ' + String(path));
      continue;
    }
    evidence[name] = { path: resolve(path), bytes: statSync(path).size, sha256: sha256File(path) };
    const declared = pinned !== null && pinned.external !== undefined ? pinned.external[name] : undefined;
    if (declared !== undefined) {
      const hashMatches = declared.sha256 === undefined || declared.sha256 === evidence[name].sha256;
      const bytesMatch = declared.bytes === undefined || declared.bytes === evidence[name].bytes;
      const ok = hashMatches && bytesMatch;
      evidence.checks.push({
        name: 'pinned:' + name + '-declared',
        ok,
        detail: ok
          ? 'bytes equal the hash the spec declares'
          : 'actual ' + String(evidence[name].bytes) + 'B/' + evidence[name].sha256 + ' vs declared ' + String(declared.bytes) + 'B/' + String(declared.sha256)
      });
      if (!ok) problems.push('the ' + name + ' bytes differ from the hash the spec declares');
    }
    evidence.checks.push({ name: 'pinned:' + name, ok: true, detail: evidence[name].sha256 });
  }
  return { ok: problems.length === 0, problems, evidence };
}

/**
 * The one pre-flight used by `--check`, by a real run and by the command generator.
 *
 * `--check` used to validate only the shape of the spec; the source, fixtures and external
 * bytes were verified later, after an approval had already been spent. Both callers now run
 * this exact function, so "checked offline" and "checked before spawn" cannot diverge.
 */
export function preflightSpec(spec, options = {}) {
  const checks = [];
  try {
    validateSpec(spec);
  } catch (error) {
    return {
      ok: false,
      code: 'spec-invalid',
      problems: [error.message],
      checks: [{ name: 'spec:structure', ok: false, detail: error.message }],
      evidence: null
    };
  }
  checks.push({ name: 'spec:structure', ok: true, detail: 'shape, ranges, project files and external paths' });
  const pinned = verifyPinnedSources(spec, {
    repoRoot: options.repoRoot === undefined ? spec.repoRoot : options.repoRoot,
    gitBin: options.gitBin
  });
  checks.push(...pinned.evidence.checks);
  return {
    ok: pinned.ok,
    code: pinned.ok ? null : 'spec-invalid',
    problems: pinned.problems,
    checks,
    evidence: pinned.evidence
  };
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
 * Every process below `rootPid`, read once from the Windows process table.
 *
 * A tree kill only reaches processes still linked to the parent it kills. A member subagent
 * that detached itself (or was started after the launcher began exiting) survives `taskkill
 * /T` and keeps holding a port or a file. Naming the descendants before the kill is what
 * makes the teardown proof about processes rather than about the parent's word.
 */
function listDescendants(rootPid) {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) return { ok: false, pids: [] };
  const dir = mkdtempSync(join(tmpdir(), 'tla-ps-'));
  const out = join(dir, 'out.txt');
  const fd = openSync(out, 'w');
  let status = null;
  try {
    const query = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
      stdio: ['ignore', fd, fd],
      timeout: DESCENDANT_PROBE_MS,
      windowsHide: true
    });
    status = result.status;
  } catch { /* the probe is best effort, the kill below still runs */ } finally {
    closeSync(fd);
  }
  let text = '';
  try {
    text = readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (status !== 0) return { ok: false, pids: [] };
  const parentOf = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(\d+)\s+(\d+)$/u.exec(line.trim());
    if (match !== null) parentOf.set(Number(match[1]), Number(match[2]));
  }
  const pids = [];
  for (const [pid, parent] of parentOf) {
    let cursor = parent;
    let depth = 0;
    while (cursor !== 0 && cursor !== undefined && depth < MAX_DESCENDANT_DEPTH) {
      if (cursor === rootPid) {
        pids.push(pid);
        break;
      }
      cursor = parentOf.get(cursor);
      depth += 1;
    }
  }
  return { ok: true, pids };
}

/** Kill one pid this runner recorded, bounded, and report whether it is gone. */
async function forceKillPid(pid, timeoutMs) {
  if (!pidAlive(pid)) return true;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: timeoutMs });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
  return waitPidGone(pid, timeoutMs);
}

/**
 * Stop a process this runner owns: polite signal first, then force, then a
 * bounded tree kill on Windows, then a sweep of every descendant named before
 * the kill. Every step is time-boxed so cleanup itself can never hang the
 * experiment.
 */
export async function stopOwnedProcess(child, options = {}) {
  const graceMs = Number.isInteger(options.graceMs) ? options.graceMs : STOP_GRACE_MS;
  const killMs = Number.isInteger(options.killMs) ? options.killMs : STOP_KILL_MS;
  const record = { pid: child === null || child === undefined ? null : child.pid, how: 'none', descendants: [], survivors: [], descendantsProof: 'skipped' };
  if (child === null || child === undefined || child.pid === undefined) return record;
  if (child.exitCode !== null && child.exitCode !== undefined) {
    record.how = 'already-exited';
    return record;
  }
  if (options.descendants !== false) {
    const snapshot = listDescendants(child.pid);
    record.descendants = snapshot.pids;
    record.descendantsProof = snapshot.ok ? 'collected' : 'unavailable';
  }
  const settle = async (how) => {
    record.how = how;
    for (const descendant of record.descendants) {
      if (!(await forceKillPid(descendant, killMs))) record.survivors.push(descendant);
    }
    if (record.survivors.length > 0 && record.how !== 'still-alive') record.how = 'descendants-survived';
    return record;
  };
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  if (await waitPidGone(child.pid, graceMs)) return settle('terminated');
  if (process.platform === 'win32') {
    // A child we own may itself own a host process; kill the tree so nothing
    // survives the experiment. `taskkill` is time-boxed like every other step.
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: killMs });
    } catch { /* best effort */ }
    if (await waitPidGone(child.pid, killMs)) return settle('tree-killed');
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  if (await waitPidGone(child.pid, killMs)) return settle('killed');
  return settle('still-alive');
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
  // A failed spawn emits 'error' instead of 'exit'. Without a listener the event is unhandled and
  // takes the whole runner down, leaving the other child orphaned.
  const errors = [];
  child.on('error', (error) => {
    errors.push(error instanceof Error ? error.message : String(error));
  });
  return { role, child, pid: child.pid === undefined ? null : child.pid, command, args, logPath, startedAt: nowIso(), errors };
}

/**
 * Give a just-spawned child a moment to report a start failure.
 *
 * Windows returns from spawn() even when the executable does not exist; the 'error' event arrives
 * on the next turn of the loop. Every caller needs the same small window and the same detail.
 */
export async function waitSpawnOutcome(entry, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.errors.length > 0) return { ok: false, detail: entry.errors.join('; ') };
    if (entry.pid !== null) return { ok: true, detail: '' };
    await sleep(10);
  }
  return entry.errors.length > 0
    ? { ok: false, detail: entry.errors.join('; ') }
    : { ok: entry.pid !== null, detail: entry.pid === null ? 'no pid was assigned' : '' };
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
  const effective = resolveEffective(spec);
  const overlayText = renderOverlay({
    gateUrl: endpoints.gateUrl,
    runDir,
    modelRequests: effective.modelRequests,
    heartbeatIntervalMs: effective.heartbeatIntervalMs
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
      modelRequests: effective.modelRequests,
      leaseTtlMs: effective.leaseTtlMs,
      heartbeatMaxAgeMs: effective.heartbeatMaxAgeMs,
      timeoutMs: effective.timeoutMs
    },
    derived: endpoints,
    overlayPath,
    logDir,
    pinned: spec.pinned === undefined ? null : spec.pinned,
    pinnedEvidence: null,
    hostArgs: null,
    treeProof: null,
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
      // Only the launcher owns a process tree; the fake upstream is one process.
      const result = await stopOwnedProcess(entry.child, { graceMs: options.graceMs, killMs: options.killMs, descendants: role === 'host' });
      summary.teardown.push({
        role,
        pid: result.pid,
        how: result.how,
        descendants: result.descendants,
        descendantsProof: result.descendantsProof,
        survivors: result.survivors
      });
      if (result.how === 'still-alive' || result.how === 'descendants-survived' || result.survivors.length > 0) {
        summary.status = 'cleanup-anomaly';
        const detail = result.survivors.length > 0
          ? 'descendants still alive: ' + result.survivors.join(', ')
          : 'pid ' + String(result.pid) + ' still alive';
        summary.reason = (summary.reason === null ? '' : summary.reason + '; ') + role + ' teardown: ' + detail;
      }
      // The host is the tree; the upstream is a single process. Record the host's proof, and
      // never let the upstream's clean stop overwrite it.
      if (role === 'host') {
        // "already-exited" means the child ended on its own before we could kill its tree. We
        // cannot enumerate the descendants of a dead pid without platform support, so say so.
        if (result.how === 'already-exited') summary.treeProof = 'exited-before-teardown';
        else if (result.descendantsProof === 'collected') {
          summary.treeProof = result.descendants.length > 0 ? 'descendants-killed' : 'tree-killed';
        } else summary.treeProof = 'tree-killed';
      }
    }
    const gateFree = await waitPortFree(endpoints.gatePort);
    const upstreamFree = await waitPortFree(endpoints.upstreamPort);
    summary.teardown.push({ role: 'ports', gateFree, upstreamFree });
    // Only our own spawns can leak. A run that never started anything cannot be blamed for a
    // port that somebody else holds (for example the port-conflict scenario).
    if (summary.owned.length > 0 && (!gateFree || !upstreamFree)) {
      summary.status = 'cleanup-anomaly';
      const stuck = [!gateFree ? 'gate ' + String(endpoints.gatePort) : null, !upstreamFree ? 'upstream ' + String(endpoints.upstreamPort) : null].filter(Boolean).join(' and ');
      summary.reason = (summary.reason === null ? '' : summary.reason + '; ') + 'a port owned by this experiment is still accepting connections after cleanup: ' + stuck;
    }
    if (spec.requireTreeProof === true && summary.treeProof === 'exited-before-teardown' && summary.status === 'completed') {
      summary.status = 'cleanup-anomaly';
      summary.reason = 'the host exited before teardown, so its descendants cannot be proven gone';
    }
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

  // Provenance is checked before anything is spawned: a label is not evidence. This is the
  // same function `--check` runs, so the offline verdict and the run verdict cannot diverge.
  const pinnedCheck = preflightSpec(spec, {
    repoRoot: options.repoRoot === undefined ? spec.repoRoot : options.repoRoot,
    gitBin: options.gitBin
  });
  summary.pinnedEvidence = pinnedCheck.evidence;
  summary.preflightChecks = pinnedCheck.checks;
  if (!pinnedCheck.ok) return fail('spec-invalid', 'pre-flight failed: ' + pinnedCheck.problems.join('; '));
  phase('pinned-verified', { checks: pinnedCheck.checks.length });

  // Everything below owns child processes, so it runs inside a guard: a throw of any kind must
  // still go through teardown rather than leave a host or an upstream behind.
  const execute = async () => {
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
  // A spawn that cannot start reports asynchronously; without this the process would die on an
  // unhandled 'error' event and leave the other child behind.
  const upstreamSpawn = await waitSpawnOutcome(upstream);
  if (!upstreamSpawn.ok) return fail('upstream-failed', 'upstream did not start: ' + upstreamSpawn.detail);

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

  // Observation hook: lets a caller inject a failure after the upstream is ready, so the
  // "an exception still tears the run down" path can be exercised with real children.
  if (typeof options.afterReady === 'function') {
    await options.afterReady({ spec, endpoints, runDir });
    phase('after-ready');
  }

  const hostCommand = spec.hostCommand === undefined ? process.execPath : spec.hostCommand;
  const hostArgv = spec.hostCommand === undefined ? buildHostArgs(spec, endpoints, runDir, overlayPath, effective) : spec.hostArgs.slice();
  summary.hostArgs = hostArgv;
  // The summary must describe the argv the host really received, not the intent behind it.
  if (spec.hostCommand === undefined) {
    if (!existsSync(hostArgv[0])) return fail('spec-invalid', 'the launcher is missing next to the runner: ' + hostArgv[0]);
    const expectedArgs = {
      '--model-requests': String(effective.modelRequests),
      '--lease-ttl-ms': String(effective.leaseTtlMs),
      '--heartbeat-max-age-ms': String(effective.heartbeatMaxAgeMs),
      '--timeout-ms': String(effective.timeoutMs),
      '--gate-port': String(endpoints.gatePort),
      '--upstream': endpoints.upstreamUrl,
      '--upstream-run-id': endpoints.runId,
      '--project-cwd': resolve(spec.projectCwd),
      '--run-dir': runDir,
      '--patch': overlayPath
    };
    for (const [flag, value] of [['--dsh-exe', spec.dshExe], ['--dsh-cli', spec.dshCli], ['--dsh-home', spec.dshHome], ['--prompt', spec.prompt]]) {
      if (value !== undefined) expectedArgs[flag] = value;
    }
    const agreement = verifyInvocationArgs(hostArgv, expectedArgs);
    // A spec field that never reaches the launcher is the same bug as a knob that is
    // recorded but not passed on, so the required files are checked one by one.
    for (const rel of spec.requireFiles === undefined ? [] : spec.requireFiles) {
      const at = hostArgv.indexOf(rel);
      if (at <= 0 || hostArgv[at - 1] !== '--require-file') agreement.mismatches.push('--require-file is missing ' + rel);
    }
    summary.hostArgsAgreement = agreement;
    if (!agreement.ok) return fail('spec-invalid', 'the host argv does not carry the resolved spec: ' + agreement.mismatches.join('; '));
  }
  const host = spawnOwned('host', hostCommand, hostArgv, { logDir, cwd: spec.projectCwd, env: buildHostEnv(spec) });
  owned.host = host;
  summary.owned.push({ role: 'host', pid: host.pid, command: hostCommand, args: hostArgv, log: host.logPath });
  summary.hostStarted = true;
  summary.hostPid = host.pid;
  phase('host-spawned', { pid: host.pid });
  const hostSpawn = await waitSpawnOutcome(host);
  if (!hostSpawn.ok) return fail('host-spawn-failed', 'host did not start: ' + hostSpawn.detail);

  const timeoutMs = effective.timeoutMs;
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
  };

  try {
    return await execute();
  } catch (error) {
    return fail('internal-error', 'the runner threw: ' + String(error instanceof Error ? error.message : error));
  }
}

function buildHostEnv(spec) {
  const env = { ...process.env };
  if (spec.dshHome !== undefined) env.DSH_HOME = spec.dshHome;
  if (spec.fakeKeyEnv !== undefined) env[spec.fakeKeyEnv] = spec.fakeKeyValue;
  return env;
}

export function buildHostArgs(spec, endpoints, runDir, overlayPath, effective) {
  const args = [
    spec.launcherPath === undefined ? join(TOOLS_DIR, 'gated-run.mjs') : resolve(spec.launcherPath),
    '--profile', spec.profile,
    '--patch', overlayPath,
    '--project-cwd', resolve(spec.projectCwd),
    '--run-dir', runDir,
    '--gate-port', String(endpoints.gatePort),
    '--upstream', endpoints.upstreamUrl,
    '--upstream-health-url', endpoints.healthUrl,
    '--upstream-run-id', endpoints.runId,
    '--model-requests', String(effective.modelRequests),
    '--lease-ttl-ms', String(effective.leaseTtlMs),
    '--heartbeat-max-age-ms', String(effective.heartbeatMaxAgeMs),
    '--heartbeat-file', join(runDir, 'plugin-events.jsonl'),
    '--gate-log', join(runDir, 'gate-events.jsonl'),
    '--summary', join(runDir, 'gate-summary.json'),
    '--timeout-ms', String(effective.timeoutMs)
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
