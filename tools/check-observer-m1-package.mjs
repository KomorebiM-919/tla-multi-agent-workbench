#!/usr/bin/env node
// Offline M1A wrapper-package fidelity check. It compares fixed Git blobs, a
// fresh autocrlf=true checkout and git archive bytes, assembles only the pinned
// closure, then fake-loads and unloads that closure. It never imports DSH.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCHEMA = 'tla.observer-m1-package/v1';
const SET = 'b1-observer-m1a';
const HELP = `Usage: node tools/check-observer-m1-package.mjs \\
  --repo <git-worktree> --commit <sha> --checkout <fresh-checkout> \\
  --manifest <docs/V0.2-OBSERVER-M1-PACKAGE-MANIFEST.json> [--keep]

Exit 0 all byte sources and the isolated fake load/unload agree; 1 mismatch or
I/O failure; 2 usage or manifest error.`;

function usage(message) {
  if (message) process.stderr.write(`m1a-package: ${message}\n`);
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

function readManifest(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.schema !== SCHEMA || parsed.candidateSet !== SET || parsed.entry !==
      'orchestration/tool-observer/host-plugin/index.js' || !Array.isArray(parsed.files)) {
    throw new Error('manifest schema/candidateSet/entry is invalid');
  }
  const byPath = new Map();
  for (const item of parsed.files) {
    if (typeof item.path !== 'string' || !/^(orchestration\/tool-observer\/|tools\/lib\/)/u.test(item.path)) {
      throw new Error(`unsafe manifest path: ${item.path}`);
    }
    if (byPath.has(item.path)) throw new Error(`duplicate manifest path: ${item.path}`);
    byPath.set(item.path, item);
  }
  if (byPath.size !== 11) throw new Error('manifest must contain exactly the M1A closure (11 files)');
  return byPath;
}

function attributes(repo, paths) {
  const raw = git(repo, ['check-attr', '-z', 'text', 'eol', '--', ...paths]).toString('utf8');
  const parts = raw.split('\0');
  const attrs = new Map();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    if (!attrs.has(parts[index])) attrs.set(parts[index], {});
    attrs.get(parts[index])[parts[index + 1]] = parts[index + 2];
  }
  for (const path of paths) {
    const entry = attrs.get(path) ?? {};
    if (entry.text === 'unset' || entry.eol !== 'lf') throw new Error(`${path} is not protected by text eol=lf`);
  }
}

function fakeLoad(packageDir) {
  const code = `
import * as mod from './orchestration/tool-observer/host-plugin/index.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const plugin = mod.default ?? mod;
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
const effect = await plugin.apply(ctx, config);
if (typeof effect !== 'function') throw new Error('apply did not return a disposer');
const result = await effect();
if (result !== undefined) throw new Error('disposer returned a value');
const journal = readFileSync(join(runDir, 'lifecycle.jsonl'), 'utf8');
for (const phase of ['preparing', 'attached', 'stopping', 'stopped']) {
  if (!journal.includes('"phase":"' + phase + '"')) throw new Error('missing ' + phase);
}
const header = JSON.parse(readFileSync(join(runDir, 'trace.jsonl'), 'utf8').split('\\n')[0]);
if (header.origin !== 'host-notification') throw new Error('origin mismatch');
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: packageDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`isolated fake load failed: ${result.stderr || result.stdout}`);
}

function main() {
  const args = parse(process.argv.slice(2));
  const pinned = readManifest(args.manifest);
  const paths = [...pinned.keys()];
  attributes(args.repo, paths);
  const temp = mkdtempSync(join(tmpdir(), 'tla-m1a-package-'));
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
      const blobId = git(args.repo, ['rev-parse', `${args.commit}:${path}`]).toString('utf8').trim();
      if (expected.blob && blobId !== expected.blob) throw new Error(`${path} Git blob does not match manifest`);
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
    fakeLoad(packageDir);
    console.log(`M1A PACKAGE OK (${paths.length} files, ${sha256(readFileSync(join(packageDir, 'orchestration/tool-observer/host-plugin/index.js'))).slice(0, 12)})`);
  } finally {
    if (!args.keep) rmSync(temp, { recursive: true, force: true });
    else console.log(`kept: ${temp}`);
  }
}

main();
