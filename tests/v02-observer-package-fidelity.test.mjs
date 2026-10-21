#!/usr/bin/env node
// Real CLI negative tests for the observer package fidelity entry. The canary
// lives outside the export and must never change, including on rejected paths.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'check-observer-package-fidelity.mjs');
const MANIFEST = join(ROOT, 'docs', 'V0.2-TOOL-OBSERVER-PACKAGE-MANIFEST.json');
const HEAD = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
let failures = 0;

function check(name, condition, detail = '') {
  if (!condition) {
    failures += 1;
    console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`);
  } else {
    console.log(`ok - ${name}`);
  }
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, '--repo', ROOT, '--commit', HEAD, '--checkout', ROOT, '--manifest', MANIFEST, ...args], {
    encoding: 'utf8'
  });
}

const canaryRoot = mkdtempSync(join(tmpdir(), 'fidelity-canary-'));
const canary = join(canaryRoot, 'canary.txt');
writeFileSync(canary, 'CANARY-UNCHANGED\n', 'utf8');
const canaryHash = createHash('sha256').update(readFileSync(canary)).digest('hex');

const tempPrefix = 'tla-observer-fidelity-';
const beforeTemps = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(tempPrefix)));
const invalid = [
  ['traversal', '../../canary.txt'],
  ['absolute', canary],
  ['non-candidate', 'README.md'],
  ['case variant', 'Orchestration/tool-observer/host-bridge.mjs'],
  ['separator variant', 'orchestration\\tool-observer\\host-bridge.mjs']
];

try {
  for (const [name, target] of invalid) {
    const result = run(['--mutate-crlf', target]);
    check(`${name} rejected`, result.status === 2, `exit ${result.status}`);
    check(`${name} writes no stdout`, result.stdout === '', JSON.stringify(result.stdout));
    check(`${name} leaves canary unchanged`, createHash('sha256').update(readFileSync(canary)).digest('hex') === canaryHash);
  }
  const afterTemps = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(tempPrefix)));
  check('rejected inputs create no fidelity temp directory', [...afterTemps].every((name) => beforeTemps.has(name)));

  const mutated = run(['--mutate-crlf', 'orchestration/tool-observer/host-bridge.mjs']);
  check('valid candidate mutation fails', mutated.status === 1, `exit ${mutated.status}`);
  check('valid mutation reports mismatch', /MISMATCH/.test(mutated.stderr), mutated.stderr.slice(0, 200));
  check('valid mutation leaves canary unchanged', createHash('sha256').update(readFileSync(canary)).digest('hex') === canaryHash);

  const normal = run([]);
  check('normal fidelity passes', normal.status === 0, `exit ${normal.status}`);
  check('normal closure is imported', /PACKAGE FIDELITY OK/.test(normal.stdout));
} finally {
  rmSync(canaryRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`fidelity cli tests: ${failures} failed`);
  process.exitCode = 1;
} else {
  console.log('fidelity cli tests: ok');
}
