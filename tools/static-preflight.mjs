// Static pre-flight for the host experiment: everything that can be settled *before*
// asking for a sandbox escalation is settled here.
//
// The 2026-10-18 run wasted its single approval on a fault that was fully checkable in
// advance: the launcher refused because the checkout had rewritten the plugin's line
// endings. That refusal is correct, but it should have happened before the approval, not
// after it. This module resolves the installed plugin the same way the launcher does
// (profile directory -> realpath -> fingerprint), runs the project's red test, and probes
// the two loopback ports. It never starts the host and never touches the network.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyInstalledPlugin } from '../orchestration/gate/preflight.mjs';

export const STATIC_SCHEMA = 'tla.static-preflight/v1';
export const DEFAULT_RED_TEST = 'test/sum.test.mjs';
export const REQUIRED_PLUGINS = ['tla-prelaunch-budget', '@nanmicoder/dsh-agent-teams'];

export function resolveProfilePluginDir(dshHome, profile, name) {
  const candidate = join(dshHome, 'profiles', profile, 'node_modules', name);
  if (!existsSync(candidate)) return { dir: null, detail: 'not installed under ' + candidate };
  try {
    return { dir: realpathSync(candidate), detail: 'resolved to ' + realpathSync(candidate) };
  } catch (error) {
    return { dir: null, detail: 'could not resolve ' + candidate + ': ' + error.message };
  }
}

// The project test must be *red* before the run: a green test would prove nothing about
// the repair. Output goes to a file because pipe-backed stdio is blocked in this sandbox.
export function runRedTest(projectCwd, relPath = DEFAULT_RED_TEST) {
  const target = join(projectCwd, relPath);
  if (!existsSync(target)) {
    return { ok: false, detail: 'project test is missing: ' + target, exitCode: null, tail: null };
  }
  const logPath = join(tmpdir(), 'tla-static-red-test-' + process.pid + '.log');
  const fd = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [target], { cwd: projectCwd, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  let tail = '';
  try {
    tail = readFileSync(logPath, 'utf8').trim().split(/\r?\n/u).slice(-1)[0] ?? '';
  } catch {
    tail = '';
  } finally {
    rmSync(logPath, { force: true });
  }
  const exitCode = result.status === null ? -1 : result.status;
  const red = exitCode !== 0;
  return {
    ok: red,
    exitCode,
    tail,
    detail: red
      ? 'the project test is red (exit ' + exitCode + '): ' + tail
      : 'the project test already passes (exit 0); a green baseline cannot show a repair'
  };
}

export function checkPortFree(port) {
  return new Promise((resolveCheck) => {
    const server = net.createServer();
    server.once('error', (error) => {
      resolveCheck({ ok: false, detail: 'port ' + port + ' is not free: ' + error.code });
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolveCheck({ ok: true, detail: 'port ' + port + ' is free' }));
    });
  });
}

// A guarded provider still has to resolve a credential *before* it builds a request: the
// 2026-10-18 run started, mounted the plugin, and died with MISSING_CREDENTIAL because the
// overlay rewrote `baseURL` but not `apiKeyEnv`. Zero requests reached the gate, so the
// experiment proved nothing. Check the overlay and the environment here instead.
export function checkOverlayCredentials(overlayPath, env = process.env) {
  if (typeof overlayPath !== 'string' || overlayPath === '' || !existsSync(overlayPath)) {
    return { ok: false, detail: 'overlay is missing: ' + String(overlayPath), envName: null };
  }
  const lines = readFileSync(overlayPath, 'utf8').split(/\r?\n/u);
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const header = /^-\s+id:\s*(\S+)\s*$/u.exec(line);
    if (header !== null) {
      current = header[1];
      sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  const block = sections.get('llm-deepseek');
  if (block === undefined) {
    return { ok: false, detail: 'the overlay does not configure the llm-deepseek provider', envName: null };
  }
  const apiKeyLine = block.map((line) => /^\s+apiKeyEnv:\s*(\S+)\s*$/u.exec(line)).find((match) => match !== null);
  if (apiKeyLine === undefined) {
    return {
      ok: false,
      detail: 'the llm-deepseek block sets no apiKeyEnv; a guarded baseURL is not enough — the host resolves the API key first',
      envName: null
    };
  }
  const envName = apiKeyLine[1];
  const value = env[envName];
  if (typeof value !== 'string' || value === '') {
    return { ok: false, detail: 'apiKeyEnv names ' + envName + ' but that variable is empty in the launching environment', envName };
  }
  return { ok: true, detail: 'llm-deepseek takes its key from ' + envName + ' (set, ' + value.length + ' chars)', envName };
}

function pluginCheck(name, dir, detail) {
  const identity = verifyInstalledPlugin({ name, pkgDir: dir });
  const ok = identity.status === 'verified';
  return {
    name: 'plugin:' + name,
    ok,
    detail: ok
      ? name + ' ' + identity.installedVersion + ' verified, ' + identity.fileCount + ' files, ' + identity.buildDigest.slice(0, 16) + '…'
      : name + ' ' + identity.status + ': ' + (identity.detail ?? '') + ' (' + detail + ')',
    identity
  };
}

export async function runStaticChecks(spec) {
  const checks = [];
  const projectCwd = spec.projectCwd === undefined ? null : spec.projectCwd;
  checks.push({
    name: 'project:red-test',
    ...(projectCwd === null
      ? { ok: false, detail: 'no --project-cwd was given' }
      : runRedTest(projectCwd, spec.redTest ?? DEFAULT_RED_TEST))
  });
  const dshHome = spec.dshHome === undefined ? '' : spec.dshHome;
  const profile = spec.profile ?? 'stage1';
  if (spec.overlay !== undefined) {
    checks.push({ name: 'overlay:credentials', ...checkOverlayCredentials(spec.overlay, spec.env ?? process.env) });
  }
  for (const name of spec.plugins ?? REQUIRED_PLUGINS) {
    const { dir, detail } = resolveProfilePluginDir(dshHome, profile, name);
    checks.push(pluginCheck(name, dir, detail));
  }
  for (const [label, port] of [['gate', spec.gatePort], ['upstream', spec.upstreamPort]]) {
    if (!Number.isInteger(port)) {
      checks.push({ name: 'port:' + label, ok: false, detail: 'no ' + label + ' port was given' });
      continue;
    }
    checks.push({ name: 'port:' + label, ...(await checkPortFree(port)) });
  }
  const problems = checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail);
  return { schema: STATIC_SCHEMA, ok: problems.length === 0, checks, problems };
}
