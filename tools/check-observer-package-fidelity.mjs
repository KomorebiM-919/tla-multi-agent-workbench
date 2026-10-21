#!/usr/bin/env node
// Reproducible B1 observer packaging check. It never imports a host or starts a
// dispatcher: it compares Git blobs, a fresh checkout and a `git archive` export
// byte-for-byte, then imports only the exported seven-file closure and writes a
// fictional trace. A deliberate CRLF rewrite is expected to fail the check.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CANDIDATES = [
  'orchestration/tool-observer/context-subscription.mjs',
  'orchestration/tool-observer/host-bridge.mjs',
  'orchestration/tool-observer/writer.mjs',
  'tools/lib/tool-trace-contracts.mjs',
  'tools/lib/launch-receipts.mjs',
  'tools/lib/trace-output.mjs',
  'tools/inspect-tool-trace.mjs'
];

const HELP = `Usage: node tools/check-observer-package-fidelity.mjs \\
  --repo <git-worktree> --commit <sha> --checkout <fresh-checkout> \\
  --manifest <docs/V0.2-TOOL-OBSERVER-PACKAGE-MANIFEST.json> \\
  [--archive-dir <dir>] [--package-dir <dir>] [--mutate-crlf <relative-path>] [--keep]

Exit 0 all four byte sources and the isolated closure agree; 1 mismatch or I/O
failure; 2 usage.`;

function usage(message) {
  if (message) process.stderr.write(`fidelity: ${message}\n`);
  process.stderr.write(`${HELP}\n`);
  process.exit(2);
}

function parse(argv) {
  const out = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') { out.keep = true; continue; }
    if (!['--repo', '--commit', '--checkout', '--manifest', '--archive-dir', '--package-dir', '--mutate-crlf'].includes(flag)) usage(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) usage(`${flag} requires a value`);
    out[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    index += 1;
  }
  if (!out.repo || !out.commit || !out.checkout || !out.manifest) usage('--repo, --commit, --checkout and --manifest are required');
  return out;
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readManifest(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.schema !== 'tla.observer-package-manifest/v1' || !Array.isArray(parsed.files)) {
    throw new Error('manifest schema is not tla.observer-package-manifest/v1');
  }
  const byPath = new Map();
  for (const item of parsed.files) {
    if (!CANDIDATES.includes(item.path) || byPath.has(item.path)) throw new Error(`unexpected or duplicate manifest path: ${item.path}`);
    byPath.set(item.path, item);
  }
  if (byPath.size !== CANDIDATES.length) throw new Error('manifest must contain exactly the seven candidates');
  return byPath;
}

function attributes(repo) {
  const raw = git(repo, ['check-attr', '-z', 'text', 'eol', '--', ...CANDIDATES]).toString('utf8');
  const parts = raw.split('\0');
  const attrs = new Map();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const [path, name, value] = [parts[index], parts[index + 1], parts[index + 2]];
    if (!attrs.has(path)) attrs.set(path, {});
    attrs.get(path)[name] = value;
  }
  for (const path of CANDIDATES) {
    const entry = attrs.get(path) ?? {};
    if (entry.text === 'unset' || entry.eol !== 'lf') {
      throw new Error(`${path} is not protected by text eol=lf (text=${entry.text}, eol=${entry.eol})`);
    }
  }
}

function verify(repo, commit, checkout, manifest, archiveDir, packageDir, mutate) {
  attributes(repo);
  const pinned = readManifest(manifest);
  const archive = join(archiveDir, 'observer-package.tar');
  const extracted = join(archiveDir, 'extracted');
  mkdirSync(extracted, { recursive: true });
  git(repo, ['archive', '--format=tar', `--output=${archive}`, commit]);
  const tar = spawnSync('tar', ['-xf', archive, '-C', extracted], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar extraction failed: ${tar.stderr || 'unknown error'}`);

  if (mutate) {
    const target = join(extracted, mutate);
    if (!existsSync(target)) throw new Error(`mutation target not exported: ${mutate}`);
    writeFileSync(target, readFileSync(target).toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    process.stderr.write(`MUTATED ${mutate}: CRLF rewrite is expected to make this check fail\n`);
  }

  let mismatches = 0;
  for (const path of CANDIDATES) {
    const expected = pinned.get(path);
    const blob = git(repo, ['cat-file', 'blob', `${commit}:${path}`]);
    const checkoutBytes = readFileSync(join(checkout, path));
    const archiveBytes = readFileSync(join(extracted, path));
    for (const [label, bytes] of [['blob', blob], ['checkout', checkoutBytes], ['archive', archiveBytes]]) {
      const actual = { bytes: bytes.length, sha256: sha256(bytes) };
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        process.stderr.write(`MISMATCH ${path} ${label}: ${actual.bytes}/${actual.sha256} != ${expected.bytes}/${expected.sha256}\n`);
        mismatches += 1;
      }
      if (label === 'blob') {
        const blobSha = spawnSync('git', ['hash-object', '--stdin'], { input: bytes, encoding: 'utf8' });
        if (blobSha.status !== 0 || blobSha.stdout.trim() !== expected.blob) {
          process.stderr.write(`MISMATCH ${path} blob object id: ${String(blobSha.stdout ?? '').trim()} != ${expected.blob}\n`);
          mismatches += 1;
        }
      }
    }
  }
  if (mismatches > 0) return false;

  mkdirSync(packageDir, { recursive: true });
  if (readdirSafe(packageDir).length > 0) throw new Error('package directory must be empty');
  for (const path of CANDIDATES) {
    const destination = join(packageDir, path);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, readFileSync(join(extracted, path)));
  }
  const code = `import { createHostToolObserver, projectHostToolsResult } from './orchestration/tool-observer/host-bridge.mjs';
import { createTraceWriter } from './orchestration/tool-observer/writer.mjs';
import './orchestration/tool-observer/context-subscription.mjs';
import './tools/lib/launch-receipts.mjs';
import './tools/lib/trace-output.mjs';
import './tools/inspect-tool-trace.mjs';
const writer = createTraceWriter({ outputFile: './closure.jsonl', assertPath: () => {} });
if (writer.open() !== true) throw new Error('writer open failed');
writer.accept(projectHostToolsResult({ callId: 'c1', rootCallId: 'r1', name: 'pwsh', agent: { session: { id: 's1' } } }, { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { truncated: false }, stderr: { truncated: false } } }));
if (writer.stop().ok !== true) throw new Error('writer stop failed');
console.log('CLOSURE_OK');`;
  const closure = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: packageDir, encoding: 'utf8' });
  if (closure.status !== 0 || !closure.stdout.includes('CLOSURE_OK')) {
    throw new Error(`isolated closure failed: ${closure.stderr || closure.stdout || 'unknown error'}`);
  }
  return true;
}

function readdirSafe(path) {
  try { return readdirSync(path); } catch { return []; }
}

let options;
try { options = parse(process.argv.slice(2)); } catch (error) { usage(error.message); }
const temporary = mkdtempSync(join(tmpdir(), 'tla-observer-fidelity-'));
const archiveDir = options.archiveDir ? resolve(options.archiveDir) : join(temporary, 'archive');
const packageDir = options.packageDir ? resolve(options.packageDir) : join(temporary, 'package');
try {
  mkdirSync(archiveDir, { recursive: true });
  const ok = verify(
    resolve(options.repo), options.commit, resolve(options.checkout), resolve(options.manifest),
    archiveDir, packageDir, options.mutateCrlf
  );
  process.stdout.write(ok ? 'PACKAGE FIDELITY OK: blob == checkout == archive == manifest; closure OK\n' : 'PACKAGE FIDELITY FAILED\n');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  process.stderr.write(`PACKAGE FIDELITY FAILED: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (!options.keep) rmSync(temporary, { recursive: true, force: true });
}
