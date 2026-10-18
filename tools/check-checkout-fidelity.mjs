#!/usr/bin/env node
// Prove that a fresh checkout reproduces the reviewed plugin bytes.
//
// The launcher refuses to start when `fingerprintPluginDir` disagrees with the
// registered build digest. On 2026-10-18 that refusal was correct: a checkout under
// the machine-wide `core.autocrlf=true` rewrote three plugin files from LF to CRLF.
// `.gitattributes` now marks the directory `-text`, so the checkout must reproduce the
// blob bytes. This tool checks that claim on a *throwaway worktree*, not on the tree the
// caller happens to sit in (which may already be hand-edited).
//
// Usage:
//   node tools/check-checkout-fidelity.mjs [--repo <path>] [--keep] [--json]
//
// Exit codes: 0 = checkout reproduces the reviewed bytes, 1 = it does not, 2 = usage.
// The child git process runs with `stdio: 'ignore'`: this sandbox forbids pipe-backed
// stdio, and only the exit status is needed here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fingerprintPluginDir, REVIEWED_PLUGIN_EVIDENCE } from '../orchestration/gate/preflight.mjs';

export const FIDELITY_SCHEMA = 'tla.checkout-fidelity/v1';
export const PLUGIN_DIR = 'orchestration/interceptor-plugin';
export const PLUGIN_NAME = 'tla-prelaunch-budget';

function parseArgs(argv) {
  const options = { repo: process.cwd(), keep: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--repo') {
      index += 1;
      if (index >= argv.length) throw new Error('--repo needs a path');
      options.repo = resolve(argv[index]);
    } else if (flag === '--keep') {
      options.keep = true;
    } else if (flag === '--json') {
      options.json = true;
    } else {
      throw new Error('unknown argument: ' + flag);
    }
  }
  return options;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore', env: process.env });
  return { status: result.status === null ? -1 : result.status, error: result.error ?? null };
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix === '' ? name : prefix + '/' + name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

// Same two invariants the launcher cares about: the digest matches the registry, and no
// file carries a CR (a CR means the checkout converted line endings).
export function inspectCheckout(repo, checkoutDir) {
  const pluginDir = join(checkoutDir, PLUGIN_DIR);
  const expected = REVIEWED_PLUGIN_EVIDENCE[PLUGIN_NAME].buildDigest;
  if (!existsSync(pluginDir)) {
    return { ok: false, reason: 'plugin directory is missing from the checkout', expected };
  }
  const files = listFiles(pluginDir).map((rel) => {
    const bytes = readFileSync(join(pluginDir, rel));
    return { path: rel, bytes: bytes.length, carriageReturns: bytes.includes(0x0d) };
  });
  const fingerprint = fingerprintPluginDir(pluginDir);
  const crlf = files.filter((file) => file.carriageReturns).map((file) => file.path);
  const match = fingerprint.buildDigest === expected;
  const problems = [];
  if (!match) problems.push('build digest ' + fingerprint.buildDigest + ' != registered ' + expected);
  if (crlf.length > 0) problems.push('checkout wrote CR bytes into: ' + crlf.join(', '));
  if (fingerprint.fileCount !== files.length) problems.push('file count changed during the checkout');
  return {
    ok: problems.length === 0,
    repo,
    checkout: checkoutDir,
    pluginDir,
    expected,
    digest: fingerprint.buildDigest,
    fileCount: fingerprint.fileCount,
    files,
    crlf,
    problems
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '');
  const scratch = join(options.repo, 'tests', '.scratch', 'checkout-fidelity');
  mkdirSync(scratch, { recursive: true });
  const checkoutDir = join(scratch, 'fresh-' + stamp);
  // `-c core.autocrlf=true` on the worktree invocation: the checkout must stay faithful
  // even on a machine configured to normalize line endings.
  const added = git(['-c', 'core.autocrlf=true', 'worktree', 'add', '--detach', checkoutDir, 'HEAD'], options.repo);
  if (added.status !== 0) {
    console.error('could not create a scratch worktree (git exit ' + added.status + ')');
    return 1;
  }
  let report;
  try {
    report = inspectCheckout(options.repo, checkoutDir);
  } finally {
    if (!options.keep) {
      git(['worktree', 'remove', '--force', checkoutDir], options.repo);
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  }
  report.schema = FIDELITY_SCHEMA;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const file of report.files) {
      console.log(file.path + ' ' + file.bytes + ' bytes' + (file.carriageReturns ? ' CRLF!' : ''));
    }
    console.log('digest   ' + report.digest);
    console.log('expected ' + report.expected);
    for (const problem of report.problems || []) console.log('problem  ' + problem);
    console.log(report.ok ? 'FIDELITY OK' : 'FIDELITY FAILED');
  }
  return report.ok ? 0 : 1;
}

if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/gu, '/').replace(/^\//u, '')) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
