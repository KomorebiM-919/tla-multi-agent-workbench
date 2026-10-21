#!/usr/bin/env node
// Offline M0 candidate-package fidelity check. It neither imports DSH nor
// starts a host. It compares fixed Git blobs, a fresh autocrlf=true checkout and
// git archive bytes, assembles the expanded closure in a new directory, then
// imports that closure and performs a fictional mount/stop.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const MANIFEST_SCHEMA = 'tla.observer-m0-package/v1';

const HELP = `Usage: node tools/check-observer-m0-package.mjs \\
  --repo <git-worktree> --commit <sha> --checkout <fresh-checkout> \\
  --manifest <docs/V0.2-OBSERVER-M0-PACKAGE-MANIFEST.json> \\
  [--keep]

Exit 0 all byte sources and the isolated fictional mount agree; 1 mismatch or
I/O failure; 2 usage or manifest error.`;

function usage(message) {
  if (message) process.stderr.write(`m0-package: ${message}\n`);
  process.stderr.write(`${HELP}\n`);
  process.exit(2);
}

function parse(argv) {
  const out = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') { out.keep = true; continue; }
    if (!['--repo', '--commit', '--checkout', '--manifest'].includes(flag)) usage(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) usage(`${flag} requires a value`);
    out[flag.slice(2)] = value;
    index += 1;
  }
  if (!out.repo || !out.commit || !out.checkout || !out.manifest) usage('--repo, --commit, --checkout and --manifest are required');
  return out;
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr ?? '').trim()}`);
  return result.stdout;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

function manifest(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.schema !== MANIFEST_SCHEMA || parsed.candidateSet !== 'b1-observer-m0' || !Array.isArray(parsed.files)) {
    throw new Error('manifest schema/candidateSet is invalid');
  }
  const byPath = new Map();
  for (const item of parsed.files) {
    if (typeof item.path !== 'string' || !item.path.startsWith('orchestration/tool-observer/') && !item.path.startsWith('tools/')) {
      throw new Error(`unsafe manifest path: ${item.path}`);
    }
    if (byPath.has(item.path)) throw new Error(`duplicate manifest path: ${item.path}`);
    byPath.set(item.path, item);
  }
  if (byPath.size < 9) throw new Error('manifest is missing the candidate closure');
  return byPath;
}

function attributes(repo, paths) {
  const raw = git(repo, ['check-attr', '-z', 'text', 'eol', '--', ...paths]).toString('utf8');
  const parts = raw.split('\0');
  const attrs = new Map();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const [path, name, value] = [parts[index], parts[index + 1], parts[index + 2]];
    if (!attrs.has(path)) attrs.set(path, {});
    attrs.get(path)[name] = value;
  }
  for (const path of paths) {
    const entry = attrs.get(path) ?? {};
    if (entry.text === 'unset' || entry.eol !== 'lf') throw new Error(`${path} is not protected by text eol=lf`);
  }
}

function childMount(packageDir) {
  const code = `
import { apply } from './orchestration/tool-observer/plugin/index.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const runDir = join(process.cwd(), 'fake-run');
mkdirSync(runDir, { recursive: true });
const ctx = { on() { return () => {}; } };
const config = {
  enabled: true, runDir,
  traceFile: join(runDir, 'trace.jsonl'), lifecycleFile: join(runDir, 'lifecycle.jsonl'),
  runnerRunId: 'runner-1', launchId: '123e4567-e89b-42d3-a456-426614174000',
  gateRunId: 'gate-1', budgetRunId: 'gate-1',
  maxBytes: 131072, maxObservations: 10, maxPending: 10, cleanupTimeoutMs: 50
};
const c = await apply(ctx, config);
if (!c || c.ok !== true) throw new Error('apply failed');
const r = await c.stop();
if (!r || r.ok !== true) throw new Error('stop failed: ' + JSON.stringify(r));
const journal = readFileSync(join(runDir, 'lifecycle.jsonl'), 'utf8');
if (!journal.includes('"phase":"stopped"')) throw new Error('no stopped record');
if (!journal.includes('"phase":"attached"')) throw new Error('no attached record');
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: packageDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`isolated mount failed: ${result.stderr || result.stdout}`);
}

function main() {
  const args = parse(process.argv.slice(2));
  const pinned = manifest(args.manifest);
  const paths = [...pinned.keys()];
  attributes(args.repo, paths);
  const temp = mkdtempSync(join(tmpdir(), 'tla-m0-package-'));
  const archive = join(temp, 'package.tar');
  const extracted = join(temp, 'extracted');
  const packageDir = join(temp, 'package');
  mkdirSync(extracted, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  try {
    git(args.repo, ['archive', '--format=tar', `--output=${archive}`, args.commit]);
    const tar = spawnSync('tar', ['-xf', archive, '-C', extracted], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar extraction failed: ${tar.stderr || 'unknown error'}`);
    for (const path of paths) {
      const expected = pinned.get(path);
      const blob = git(args.repo, ['cat-file', 'blob', `${args.commit}:${path}`]);
      const checkout = readFileSync(join(args.checkout, path));
      const archiveBytes = readFileSync(join(extracted, path));
      for (const [label, bytes] of [['blob', blob], ['checkout', checkout], ['archive', archiveBytes]]) {
        if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
          throw new Error(`${path} ${label} does not match manifest`);
        }
      }
    }
    if (readdirSync(packageDir).length !== 0) throw new Error('package directory must be empty');
    for (const path of paths) {
      const destination = join(packageDir, path);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      writeFileSync(destination, readFileSync(join(extracted, path)));
    }
    childMount(packageDir);
    process.stdout.write(`M0 PACKAGE OK (${paths.length} files, ${sha256(readFileSync(join(packageDir, 'orchestration/tool-observer/plugin/index.js'))).slice(0, 12)})\n`);
  } finally {
    if (!args.keep) rmSync(temp, { recursive: true, force: true });
    else process.stdout.write(`kept: ${temp}\n`);
  }
}

main();
