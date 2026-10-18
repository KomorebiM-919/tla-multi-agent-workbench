// Checkout fidelity is a precondition of the launcher's identity check: the registered
// build digest describes *bytes on disk*, so a checkout that rewrites line endings makes a
// correct refusal look like a broken plugin (that is exactly what happened on 2026-10-18).
//
// These tests are hermetic: they read the tree that is checked out, and they tamper with
// copies. `tools/check-checkout-fidelity.mjs` performs the real "fresh worktree under
// core.autocrlf=true" check, because spawning git from the test runner is blocked by this
// sandbox's stdio rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintPluginDir, REVIEWED_PLUGIN_EVIDENCE, verifyInstalledPlugin } from '../orchestration/gate/preflight.mjs';
import { inspectCheckout } from '../tools/check-checkout-fidelity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = 'tla-prelaunch-budget';
const PLUGIN_DIR = join(ROOT, 'orchestration', 'interceptor-plugin');
const EXPECTED = REVIEWED_PLUGIN_EVIDENCE[PLUGIN];
const SIZES = { 'index.js': 10362, 'lib/budget.mjs': 5189, 'package.json': 455 };

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

function scratchCopy() {
  const base = join(ROOT, 'tests', '.scratch', 'checkout-fidelity');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'tamper-'));
  cpSync(PLUGIN_DIR, dir, { recursive: true });
  return dir;
}

test('the line-ending rule is byte fidelity only', () => {
  const lines = readFileSync(join(ROOT, '.gitattributes'), 'utf8').split(/\r?\n/u);
  const rule = lines.find((line) => /^orchestration\/interceptor-plugin\/\*\*/u.test(line));
  assert.ok(rule !== undefined, 'the plugin directory must have its own .gitattributes rule');
  assert.match(rule, /\s-text(\s|$)/u, 'the rule must disable line-ending conversion');
  assert.doesNotMatch(rule, /-whitespace/u, 'whitespace checking must not be switched off for the plugin');
});

test('the checked-out plugin carries the reviewed bytes', () => {
  const files = listFiles(PLUGIN_DIR);
  assert.deepEqual(files.sort(), Object.keys(SIZES).sort());
  for (const rel of files) {
    const bytes = readFileSync(join(PLUGIN_DIR, rel));
    assert.equal(bytes.length, SIZES[rel], rel + ' has an unexpected size');
    assert.equal(bytes.includes(0x0d), false, rel + ' must not contain a CR byte');
  }
  const fingerprint = fingerprintPluginDir(PLUGIN_DIR);
  assert.equal(fingerprint.fileCount, 3);
  assert.equal(fingerprint.buildDigest, EXPECTED.buildDigest);
});

test('the identity check accepts this tree and the fidelity tool agrees', () => {
  const identity = verifyInstalledPlugin({ name: PLUGIN, pkgDir: PLUGIN_DIR });
  assert.equal(identity.status, 'verified');
  assert.equal(identity.installedVersion, EXPECTED.version);
  const report = inspectCheckout(ROOT, ROOT);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.crlf, []);
});

test('a CRLF rewrite is rejected, not normalized away', () => {
  const dir = scratchCopy();
  try {
    const entry = join(dir, 'index.js');
    const text = readFileSync(entry, 'utf8');
    writeFileSync(entry, text.replace(/\n/gu, '\r\n'));
    const fingerprint = fingerprintPluginDir(dir);
    assert.notEqual(fingerprint.buildDigest, EXPECTED.buildDigest);
    const identity = verifyInstalledPlugin({ name: PLUGIN, pkgDir: dir });
    assert.equal(identity.status, 'build-mismatch');
    assert.equal(identity.buildDigest === EXPECTED.buildDigest, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a code change is rejected', () => {
  const dir = scratchCopy();
  try {
    writeFileSync(join(dir, 'lib', 'budget.mjs'), readFileSync(join(dir, 'lib', 'budget.mjs'), 'utf8') + '\n// tampered\n');
    assert.equal(verifyInstalledPlugin({ name: PLUGIN, pkgDir: dir }).status, 'build-mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the registry is not silently rewritten to match a bad checkout', () => {
  // The digest is compared against a frozen literal: if someone "fixes" a mismatch by
  // editing the registry, this test keeps failing until the evidence is re-reviewed.
  assert.equal(EXPECTED.buildDigest, '54f1a8e32f717f52d563ba368713c744c3bde486afeb3f3d133052a0a027e43d');
  assert.equal(EXPECTED.version, '0.0.0-local');
  assert.equal(EXPECTED.fileCount, 3);
  assert.match(EXPECTED.buildDigest, /^[0-9a-f]{64}$/u);
});
