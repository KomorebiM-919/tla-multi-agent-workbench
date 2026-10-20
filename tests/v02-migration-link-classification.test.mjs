// Formal counterexamples for the migration-link classification and summary.
// These are pure checks: they do not create links and do not touch the profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS,
  linkEvidence,
  statusCase,
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
  return statusCase(id, status, 'test', 'synthetic status');
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

test('a blocked-only suite is not a success and exits 2', () => {
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

test('all-pass suite exits 0 and a fully blocked suite still exits 2', () => {
  assert.equal(summarizeCases([withStatus(STATUS.PASS)]).exitCode, 0);
  assert.equal(summarizeCases([withStatus(STATUS.ENVIRONMENT_BLOCKED)]).exitCode, 2);
});

test('synthetic pass is counted separately', () => {
  const synthetic = { ...withStatus(STATUS.PASS, 'synthetic'), synthetic: true };
  const summary = summarizeCases([synthetic, withStatus(STATUS.PASS, 'real')]);
  assert.equal(summary.counts.syntheticPass, 1);
  assert.equal(summary.exitCode, 0);
});
