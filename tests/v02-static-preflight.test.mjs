// The static pre-flight exists because a launch-time failure costs an approval. On
// 2026-10-18 the host started, mounted the plugin and died with MISSING_CREDENTIAL before a
// single request: the overlay rewrote baseURL but never set apiKeyEnv. These tests pin the
// checks that must fail *before* an escalation is requested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOverlayCredentials, runRedTest, runStaticChecks } from '../tools/static-preflight.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH = join(ROOT, 'tests', '.scratch', 'static-preflight');

function scratch() {
  mkdirSync(SCRATCH, { recursive: true });
  return mkdtempSync(join(SCRATCH, 'case-'));
}

function writeOverlay(dir, extra) {
  const path = join(dir, 'overlay.patch.yml');
  const body = [
    '- id: llm-deepseek',
    '  config:',
    ...extra,
    '    baseURL: http://127.0.0.1:18921',
    '- id: web-search-deepseek',
    '  config:',
    '    baseURL: http://127.0.0.1:18921',
    ''
  ].join('\n');
  writeFileSync(path, body);
  return path;
}

test('an overlay that wires the key passes', () => {
  const dir = scratch();
  try {
    const overlay = writeOverlay(dir, ['    apiKeyEnv: TLA_STAGE2_FAKE_KEY']);
    const result = checkOverlayCredentials(overlay, { TLA_STAGE2_FAKE_KEY: 'stage2-fake-key' });
    assert.equal(result.ok, true);
    assert.equal(result.envName, 'TLA_STAGE2_FAKE_KEY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an overlay that only rewrites baseURL is rejected', () => {
  const dir = scratch();
  try {
    const overlay = writeOverlay(dir, []);
    const result = checkOverlayCredentials(overlay, { TLA_STAGE2_FAKE_KEY: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /apiKeyEnv/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a named key that the environment does not define is rejected', () => {
  const dir = scratch();
  try {
    const overlay = writeOverlay(dir, ['    apiKeyEnv: TLA_STAGE2_FAKE_KEY']);
    const result = checkOverlayCredentials(overlay, {});
    assert.equal(result.ok, false);
    assert.equal(result.envName, 'TLA_STAGE2_FAKE_KEY');
    assert.match(result.detail, /empty/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing overlay is rejected', () => {
  assert.equal(checkOverlayCredentials(join(SCRATCH, 'does-not-exist.yml'), {}).ok, false);
});

test('the red-test check is the inverse of a green baseline', () => {
  const dir = scratch();
  try {
    const project = join(dir, 'project');
    mkdirSync(join(project, 'test'), { recursive: true });
    writeFileSync(join(project, 'test', 'sum.test.mjs'), "console.log('sum tests: 0 passed, 1 failed');\nprocess.exit(1);\n");
    const red = runRedTest(project);
    assert.equal(red.ok, true);
    assert.equal(red.exitCode, 1);
    assert.match(red.tail, /0 passed, 1 failed/u);
    writeFileSync(join(project, 'test', 'sum.test.mjs'), "console.log('sum tests: 3 passed, 0 failed');\n");
    const green = runRedTest(project);
    assert.equal(green.ok, false);
    assert.match(green.detail, /already passes/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStaticChecks reports every failing precondition instead of the first', async () => {
  const dir = scratch();
  try {
    const project = join(dir, 'project');
    mkdirSync(join(project, 'test'), { recursive: true });
    writeFileSync(join(project, 'test', 'sum.test.mjs'), "console.log('sum tests: 0 passed, 1 failed');\nprocess.exit(1);\n");
    const overlay = writeOverlay(dir, []);
    const report = await runStaticChecks({
      projectCwd: project,
      dshHome: join(dir, 'dsh-home-without-plugins'),
      profile: 'stage1',
      overlay,
      gatePort: 65533,
      upstreamPort: 65534,
      env: {}
    });
    assert.equal(report.ok, false);
    const names = report.checks.map((check) => check.name);
    assert.deepEqual(names, ['project:red-test', 'overlay:credentials', 'plugin:tla-prelaunch-budget', 'plugin:@nanmicoder/dsh-agent-teams', 'port:gate', 'port:upstream']);
    assert.equal(report.checks.find((check) => check.name === 'project:red-test').ok, true);
    assert.equal(report.checks.find((check) => check.name === 'overlay:credentials').ok, false);
    assert.equal(report.checks.filter((check) => check.name.startsWith('plugin:')).every((check) => check.ok === false), true);
    assert.ok(report.problems.length >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
