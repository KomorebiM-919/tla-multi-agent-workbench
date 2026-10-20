// Formal counterexamples for the migration-link classification and summary.
// Cleanup cases go through the real suite executor; they use a narrow injected
// cleanup failure so no real permission is broken and no process is left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  STATUS,
  linkEvidence,
  parseChildReport,
  runMigrationLinkSuite,
  statusCase,
  subprocessFailure,
  summarizeCases
} from './lib/migration-link-suite.mjs';

function capability(overrides = {}) {
  return {
    create: { ok: true },
    lstat: { ok: true, isSymbolicLink: true, isDirectory: false },
    readlink: { ok: true, value: 'C:/profile/vendor/interceptor-plugin' },
    realpath: { ok: true, value: 'C:/profile/vendor/interceptor-plugin' },
    targetMatches: true,
    ...overrides
  };
}

function withStatus(status, id = 'case') {
  return statusCase(id, status, 'test', `synthetic ${status}`);
}

let scratchSerial = 0;
function scratchRoot() {
  scratchSerial += 1;
  return join(process.cwd(), 'tests', '.scratch', `migration-classification-${process.pid}-${scratchSerial}`);
}

function cleanupCase(id, status) {
  const state = { leftover: null };
  return {
    id,
    state,
    async run(context) {
      const dir = context.scratch();
      state.leftover = dir;
      context.cleanup(dir);
      return statusCase(id, status, 'product', `${status} from the real executor`);
    }
  };
}

async function runCleanupCase(status) {
  const root = scratchRoot();
  const definition = cleanupCase('cleanup-fixture', status);
  try {
    const report = await runMigrationLinkSuite({
      scratchRoot: root,
      cases: [definition],
      cleanupFailure: () => {
        throw Object.assign(new Error('injected cleanup failure'), { code: 'EPERM' });
      }
    });
    return { report, leftover: definition.state.leftover, root };
  } finally {
    if (definition.state.leftover) rmSync(definition.state.leftover, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test('a fully observed link is accepted as evidence', () => {
  assert.equal(linkEvidence(capability()), true);
});

test('an ordinary directory is not link evidence', () => {
  assert.equal(linkEvidence(capability({
    lstat: { ok: true, isSymbolicLink: false, isDirectory: true }
  })), false);
});

test('a failed create, readlink, realpath or target mismatch blocks evidence', () => {
  assert.equal(linkEvidence(capability({ create: { ok: false, code: 'EPERM' } })), false);
  assert.equal(linkEvidence(capability({ readlink: { ok: false, code: 'EINVAL' } })), false);
  assert.equal(linkEvidence(capability({ realpath: { ok: false, code: 'ENOENT' } })), false);
  assert.equal(linkEvidence(capability({ targetMatches: false })), false);
});

test('blocked-only is not a success and exits 2', () => {
  const summary = summarizeCases([
    withStatus(STATUS.PASS, 'pass'),
    withStatus(STATUS.ENVIRONMENT_BLOCKED, 'blocked')
  ]);
  assert.equal(summary.status, STATUS.ENVIRONMENT_BLOCKED);
  assert.equal(summary.exitCode, 2);
  assert.deepEqual(summary.counts, { pass: 1, fail: 0, environmentBlocked: 1, syntheticPass: 0 });
});

test('an assertion failure outranks a block and exits 1', () => {
  const summary = summarizeCases([
    withStatus(STATUS.PASS, 'pass'),
    withStatus(STATUS.FAIL, 'fail'),
    withStatus(STATUS.ENVIRONMENT_BLOCKED, 'blocked')
  ]);
  assert.equal(summary.status, STATUS.FAIL);
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.counts, { pass: 1, fail: 1, environmentBlocked: 1, syntheticPass: 0 });
});

test('all-pass exits 0 and a fully blocked suite still exits 2', () => {
  assert.equal(summarizeCases([withStatus(STATUS.PASS)]).exitCode, 0);
  assert.equal(summarizeCases([withStatus(STATUS.ENVIRONMENT_BLOCKED)]).exitCode, 2);
});

test('synthetic pass is counted separately', () => {
  const synthetic = { ...withStatus(STATUS.PASS, 'synthetic'), synthetic: true };
  const summary = summarizeCases([synthetic, withStatus(STATUS.PASS, 'real')]);
  assert.equal(summary.counts.syntheticPass, 1);
  assert.equal(summary.exitCode, 0);
});

test('FAIL plus cleanup keeps the assertion failure and exits 1', async () => {
  const { report } = await runCleanupCase(STATUS.FAIL);
  const item = report.cases[0];
  assert.equal(report.status, STATUS.FAIL);
  assert.equal(report.exitCode, 1);
  assert.equal(report.counts.fail, 1);
  assert.equal(report.counts.environmentBlocked, 0);
  assert.equal(item.status, STATUS.FAIL);
  assert.equal(item.assertion.status, STATUS.FAIL);
  assert.equal(item.assertion.detail, 'FAIL from the real executor');
  assert.equal(item.cleanupResiduals.length, 1);
  assert.equal(item.cleanupResiduals[0].errorCode, 'EPERM');
  assert.equal(report.diagnosticCounts.assertionFail, 1);
  assert.equal(report.diagnosticCounts.cleanupBlocked, 1);
  assert.match(item.detail, /FAIL from the real executor/);
  assert.match(item.detail, /cleanup/i);
});

test('PASS plus cleanup is not a success and locates the cleanup', async () => {
  const { report } = await runCleanupCase(STATUS.PASS);
  const item = report.cases[0];
  assert.equal(report.status, STATUS.ENVIRONMENT_BLOCKED);
  assert.equal(report.exitCode, 2);
  assert.equal(report.counts.pass, 0);
  assert.equal(report.counts.environmentBlocked, 1);
  assert.equal(item.assertion.status, STATUS.PASS);
  assert.equal(item.cleanupResiduals.length, 1);
  assert.equal(item.cleanupResiduals[0].path.startsWith(process.cwd()), true);
  assert.match(item.detail, /cleanup/i);
});

test('BLOCK plus cleanup keeps both diagnostics', async () => {
  const { report } = await runCleanupCase(STATUS.ENVIRONMENT_BLOCKED);
  const item = report.cases[0];
  assert.equal(report.status, STATUS.ENVIRONMENT_BLOCKED);
  assert.equal(report.exitCode, 2);
  assert.equal(item.assertion.status, STATUS.ENVIRONMENT_BLOCKED);
  assert.equal(item.cleanupResiduals.length, 1);
  assert.equal(report.diagnosticCounts.assertionBlocked, 1);
  assert.equal(report.diagnosticCounts.cleanupBlocked, 1);
  assert.match(item.detail, /cleanup/i);
});

test('a previous cleanup residual does not contaminate a later parser case', async () => {
  const root = scratchRoot();
  const failing = cleanupCase('first-cleanup-failure', STATUS.PASS);
  const succeeding = cleanupCase('second-parser', STATUS.PASS);
  let cleanupCalls = 0;
  try {
    const report = await runMigrationLinkSuite({
      scratchRoot: root,
      cases: [failing, succeeding],
      cleanupFailure: (dir) => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          throw Object.assign(new Error('injected cleanup failure'), { code: 'EPERM' });
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
    assert.equal(report.cases[0].status, STATUS.ENVIRONMENT_BLOCKED);
    assert.equal(report.cases[0].cleanupResiduals.length, 1);
    assert.equal(report.cases[1].status, STATUS.PASS);
    assert.equal(report.cases[1].cleanupResiduals, undefined);
    assert.equal(report.counts.pass, 1);
    assert.equal(report.counts.environmentBlocked, 1);
    assert.equal(report.cleanupResiduals.length, 1);
    assert.equal(report.cleanupResiduals[0].caseId, 'first-cleanup-failure');
  } finally {
    if (failing.state.leftover) rmSync(failing.state.leftover, { recursive: true, force: true });
    if (succeeding.state.leftover) rmSync(succeeding.state.leftover, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('subprocess errors, timeouts, nonzero and non-JSON are distinguished', () => {
  const eperm = subprocessFailure('child', { error: { code: 'EPERM', message: 'denied' } });
  assert.equal(eperm.status, STATUS.ENVIRONMENT_BLOCKED);
  assert.equal(eperm.errorCode, 'EPERM');

  const timeout = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    timeout: 20,
    stdio: 'ignore'
  });
  const timedOut = subprocessFailure('child', timeout);
  assert.equal(timedOut.status, STATUS.ENVIRONMENT_BLOCKED);

  const nonzero = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
  assert.equal(subprocessFailure('child', nonzero).status, STATUS.FAIL);

  assert.equal(parseChildReport('not-json').ok, false);
  assert.equal(parseChildReport('{"ok":true}').ok, true);
});
