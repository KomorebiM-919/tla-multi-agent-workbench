// Unit-level counterexamples for the migration-link diagnostic. They classify
// observations only; they do not create links and do not touch the production
// checker. The observed shapes are the ones the probe records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservation, isTargetOutside, PROBE_SCHEMA } from '../tools/probe-migration-links.mjs';

const ordinary = {
  lstat: { ok: true, value: { isSymbolicLink: false, isDirectory: true } },
  readlink: { ok: false, error: { code: 'EINVAL' } },
  realpath: { ok: true, value: 'C:\\profile\\ordinary' }
};

test('schema is stable', () => {
  assert.equal(PROBE_SCHEMA, 'tla.migration-link-probe/v1');
});

test('an ordinary directory is not classified as a link', () => {
  assert.equal(classifyObservation(ordinary, null), 'ordinary-directory');
});

test('a missing path is reported as missing', () => {
  assert.equal(classifyObservation({ lstat: { ok: false, error: { code: 'ENOENT' } } }, null), 'missing');
});

test('an observable link is classified as a link', () => {
  assert.equal(classifyObservation({
    lstat: { ok: true, value: { isSymbolicLink: true, isDirectory: false } },
    readlink: { ok: true, value: 'C:\\profile\\vendor\\plugin' },
    realpath: { ok: true, value: 'C:\\profile\\vendor\\plugin' }
  }, { tag: '0xa0000003' }), 'link');
});

test('a reparse point hidden from Node lstat is not mislabeled ordinary', () => {
  assert.equal(classifyObservation({
    lstat: { ok: true, value: { isSymbolicLink: false, isDirectory: true } },
    readlink: { ok: false, error: { code: 'EINVAL' } },
    realpath: { ok: true, value: 'C:\\profile\\link' }
  }, { tag: '0xa0000003' }), 'reparse-not-visible-to-node');
});

test('a broken reparse point is distinguished from a visible broken link', () => {
  assert.equal(classifyObservation({
    lstat: { ok: true, value: { isSymbolicLink: false, isDirectory: true } },
    readlink: { ok: false, error: { code: 'EINVAL' } },
    realpath: { ok: false, error: { code: 'ENOENT' } }
  }, { tag: '0xa0000003' }), 'reparse-not-visible-broken');
});

test('external and in-profile targets are distinguished', () => {
  assert.equal(isTargetOutside('C:\\profile', 'C:\\profile\\vendor\\plugin'), false);
  assert.equal(isTargetOutside('C:\\profile', 'C:\\outside\\plugin'), true);
  assert.equal(isTargetOutside('C:\\profile', 'D:\\profile\\vendor\\plugin'), true);
});
