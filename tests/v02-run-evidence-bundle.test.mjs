// Invented-material tests for explicit run-artifact assembly. No real logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  BUNDLE_SCHEMA,
  LIMITS,
  assembleBundle as realAssemble,
  main
} from '../tools/bundle-run-evidence.mjs';

function assembleBundle(selection, options = {}) {
  return realAssemble(selection, { ...options, pathSafetyProbe: () => ({ reparse: false }) });
}

const ROOT = join(process.cwd(), 'tests', '.scratch', `phase-a-bundle-${process.pid}`);
let serial = 0;

function workdir() {
  serial += 1;
  const dir = join(ROOT, String(serial));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, value);
  return path;
}

function selection(parts) {
  return {
    artifacts: parts.map(([id, role, sourcePath, path]) => ({ id, role, sourcePath, path }))
  };
}

function makeArtifacts(dir) {
  return {
    runner: write(dir, 'runner.json', '{"runId":"run-a"}\n'),
    gate: write(dir, 'gate.json', '{"runId":"gate-a","budgetRunId":"gate-a"}\n'),
    observer: write(dir, 'observer.jsonl', '{"runId":"gate-a","event":"x"}\n')
  };
}

function io() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (value) => out.push(value) },
    stderr: { write: (value) => err.push(value) }
  };
}

test('manifest names and file/directory prefixes collide before output', () => {
  const dir = workdir();
  try {
    const file = write(dir, 'a.txt', 'a');
    for (const value of ['MANIFEST.JSON', 'Manifest.json', 'manifest.json/child']) {
      assert.throws(() => assembleBundle(selection([['a', 'capture-capabilities', file, value]]), { out: join(dir, `o-${value.replaceAll(/[^a-z0-9]/giu, '')}`) }), /RELATIVE_PATH_INVALID|ARTIFACT_PATH_PREFIX_CONFLICT|MANIFEST/);
    }
    assert.throws(() => assembleBundle(selection([
      ['a', 'capture-capabilities', file, 'a'],
      ['b', 'capture-capabilities', file, 'a/b']
    ]), { out: join(dir, 'o-prefix') }), /ARTIFACT_PATH_PREFIX_CONFLICT/);
    assert.equal(existsSync(join(dir, 'o-prefix')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a source junction ancestor is rejected before copying', (t) => {
  const dir = workdir();
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  mkdirSync(target);
  const source = write(target, 'runner.json', '{"runId":"run-a"}\n');
  try {
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
  } catch (error) {
    t.skip(`junction unavailable: ${error.code ?? error.message}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    let thrown = null;
    try {
      realAssemble(selection([
        ['runner', 'runner-summary', join(link, 'runner.json'), 'runner.json']
      ]), { out: join(dir, 'bundle') });
    } catch (error) {
      thrown = error;
    }
    if (thrown === null) assert.fail('junction ancestor was accepted');
    if (/PATH_SAFETY_PROBE_UNAVAILABLE/.test(thrown.message)) {
      t.skip(`reparse probe unavailable: ${thrown.message}`);
      return;
    }
    assert.match(thrown.message, /PATH_ANCESTOR_(REPARSE|LINK)/);
    assert.equal(existsSync(join(dir, 'bundle')), false);
  } finally {
    rmdirSync(link);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an output junction ancestor is rejected before writing', (t) => {
  const dir = workdir();
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  mkdirSync(target);
  const source = write(dir, 'runner.json', '{"runId":"run-a"}\n');
  try {
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
  } catch (error) {
    t.skip(`junction unavailable: ${error.code ?? error.message}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    let thrown = null;
    try {
      realAssemble(selection([
        ['runner', 'runner-summary', source, 'runner.json']
      ]), { out: join(link, 'bundle') });
    } catch (error) {
      thrown = error;
    }
    if (thrown === null) assert.fail('junction output ancestor was accepted');
    if (/PATH_SAFETY_PROBE_UNAVAILABLE/.test(thrown.message)) {
      t.skip(`reparse probe unavailable: ${thrown.message}`);
      return;
    }
    assert.match(thrown.message, /PATH_ANCESTOR_(REPARSE|LINK)/);
    assert.equal(existsSync(join(target, 'bundle')), false);
  } finally {
    rmdirSync(link);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('final verification catches a changed artifact and unexpected output', () => {
  const dir = workdir();
  try {
    const a = write(dir, 'a.txt', 'a');
    const b = write(dir, 'b.txt', 'b');
    const out = join(dir, 'bundle');
    assert.throws(() => assembleBundle(selection([
      ['a', 'capture-capabilities', a, 'a.txt'],
      ['b', 'capture-capabilities', b, 'b.txt']
    ]), {
      out,
      hooks: {
        afterCopy: (artifact, target) => {
          if (artifact.id === 'b') writeFileSync(join(out, 'a.txt'), 'tampered');
        }
      }
    }), /FINAL_ARTIFACT_MISMATCH/);
    assert.equal(existsSync(out), false);

    const out2 = join(dir, 'bundle2');
    assert.throws(() => assembleBundle(selection([
      ['a', 'capture-capabilities', a, 'a.txt']
    ]), {
      out: out2,
      hooks: { afterCopy: () => writeFileSync(join(out2, 'extra.txt'), 'extra') }
    }), /FINAL_UNEXPECTED_OUTPUT/);
    assert.equal(existsSync(out2), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner identity fields are not priority-selected', () => {
  const dir = workdir();
  try {
    const conflict = write(dir, 'conflict.json', '{"runId":"run-a","runnerRunId":"run-b"}\n');
    const conflictResult = assembleBundle(selection([
      ['runner', 'runner-summary', conflict, 'runner.json']
    ]), { out: join(dir, 'bundle-conflict') });
    assert.equal(conflictResult.exitCode, 2);
    assert.equal(conflictResult.manifest.issues.some((item) => item.code === 'RUNNER_ID_CONFLICT'), true);

    const badType = write(dir, 'bad-type.json', '{"runId":42}\n');
    const typeResult = assembleBundle(selection([
      ['runner', 'runner-summary', badType, 'runner.json']
    ]), { out: join(dir, 'bundle-type') });
    assert.equal(typeResult.exitCode, 2);
    assert.equal(typeResult.manifest.issues.some((item) => item.code === 'RUN_ID_TYPE_INVALID'), true);

    const unsupported = write(dir, 'unsupported.json', '{"runId":"run-a","gateRunId":"gate-a"}\n');
    const unsupportedResult = assembleBundle(selection([
      ['runner', 'runner-summary', unsupported, 'runner.json']
    ]), { out: join(dir, 'bundle-unsupported') });
    assert.equal(unsupportedResult.exitCode, 2);
    assert.equal(unsupportedResult.manifest.issues.some((item) => item.code === 'RUN_ID_FIELD_UNSUPPORTED'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a valid inventory is assembled, hashed and remains binding-unproven', () => {
  const dir = workdir();
  const out = join(dir, 'bundle');
  try {
    const files = makeArtifacts(dir);
    const result = assembleBundle(selection([
      ['runner', 'runner-summary', files.runner, 'runner.json'],
      ['gate', 'gate-summary', files.gate, 'gate.json'],
      ['observer', 'observer-events', files.observer, 'observer.jsonl']
    ]), { out });
    assert.equal(result.exitCode, 0);
    assert.equal(result.manifest.schema, BUNDLE_SCHEMA);
    assert.equal(result.manifest.status, 'ASSEMBLED');
    assert.equal(result.manifest.hostVerified, false);
    assert.equal(result.manifest.binding.status, 'unproven');
    assert.equal(result.manifest.binding.runnerRunId, 'run-a');
    assert.equal(result.manifest.binding.gateRunId, 'gate-a');
    assert.equal(result.manifest.binding.budgetRunId, 'gate-a');
    assert.equal(result.manifest.artifacts.length, 3);
    assert.equal(result.manifest.issues.some((item) => item.code === 'LAUNCH_RECEIPT_MISSING'), true);
    assert.equal(result.manifest.issues.some((item) => item.code === 'RUN_BINDING_UNPROVEN'), true);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, result.manifest);
    assert.equal(lstatSync(join(out, 'runner.json')).isFile(), true);
    assert.equal(readFileSync(files.runner, 'utf8'), '{"runId":"run-a"}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing runner summary is INCOMPLETE with a manifest, not a thrown error', () => {
  const dir = workdir();
  const out = join(dir, 'bundle');
  try {
    const gate = write(dir, 'gate.json', '{"runId":"gate-a","budgetRunId":"budget-a"}\n');
    const result = assembleBundle(selection([
      ['gate', 'gate-summary', gate, 'gate.json']
    ]), { out });
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, 'INCOMPLETE');
    assert.equal(result.manifest.issues.some((item) => item.code === 'RUNNER_SUMMARY_MISSING'), true);
    assert.equal(existsSync(join(out, 'manifest.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate IDs, paths, escapes, reserved manifest and extra fields are rejected', () => {
  const dir = workdir();
  try {
    const file = write(dir, 'a.txt', 'a');
    const base = [['a', 'capture-capabilities', file, 'same.json']];
    assert.throws(() => assembleBundle(selection([...base, ['a', 'capture-capabilities', file, 'other.json']]), { out: join(dir, 'o1') }), /ARTIFACT_ID_DUPLICATE/);
    assert.throws(() => assembleBundle(selection([...base, ['b', 'capture-capabilities', file, 'same.json']]), { out: join(dir, 'o2') }), /ARTIFACT_PATH_DUPLICATE/);
    assert.throws(() => assembleBundle(selection([['a', 'capture-capabilities', file, '../escape.json']]), { out: join(dir, 'o3') }), /RELATIVE_PATH_INVALID/);
    assert.throws(() => assembleBundle(selection([['a', 'capture-capabilities', file, 'manifest.json']]), { out: join(dir, 'o4') }), /RELATIVE_PATH_INVALID/);
    for (const invalidPath of ['C:/x.json', '//server/x.json', 'a:b.json', 'CON.json', 'a./x.json', 'a//b.json', '/x.json']) {
      assert.throws(() => assembleBundle(selection([['a', 'capture-capabilities', file, invalidPath]]), { out: join(dir, `o-${invalidPath.replaceAll(/[^a-z0-9]/giu, '')}`) }), /RELATIVE_PATH_INVALID/);
    }
    assert.throws(() => assembleBundle({ ...selection(base), extra: true }, { out: join(dir, 'o5') }), /FIELDS_INVALID/);
    assert.throws(() => assembleBundle(selection([['a', 'not-a-role', file, 'x.json']]), { out: join(dir, 'o6') }), /ROLE_INVALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conflicting runner or gate/budget identity is INCOMPLETE', () => {
  const dir = workdir();
  try {
    const r1 = write(dir, 'r1.json', '{"runId":"run-a"}\n');
    const r2 = write(dir, 'r2.json', '{"runId":"run-b"}\n');
    const conflictOut = join(dir, 'conflict');
    const conflict = assembleBundle(selection([
      ['r1', 'runner-summary', r1, 'r1.json'],
      ['r2', 'runner-summary', r2, 'r2.json']
    ]), { out: conflictOut });
    assert.equal(conflict.exitCode, 2);
    assert.equal(conflict.manifest.issues.some((item) => item.code === 'RUNNER_ID_CONFLICT'), true);

    const gate = write(dir, 'g.json', '{"runId":"gate-a","budgetRunId":"budget-b"}\n');
    const mismatchOut = join(dir, 'mismatch');
    const mismatch = assembleBundle(selection([
      ['runner', 'runner-summary', r1, 'runner.json'],
      ['gate', 'gate-summary', gate, 'gate.json']
    ]), { out: mismatchOut });
    assert.equal(mismatch.exitCode, 2);
    assert.equal(mismatch.manifest.issues.some((item) => item.code === 'GATE_BUDGET_ID_CONFLICT'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expected IDs are comparisons only and a mismatch is INCOMPLETE', () => {
  const dir = workdir();
  const out = join(dir, 'bundle');
  try {
    const files = makeArtifacts(dir);
    const result = assembleBundle(selection([
      ['runner', 'runner-summary', files.runner, 'runner.json'],
      ['gate', 'gate-summary', files.gate, 'gate.json']
    ]), { out, expected: { runner: 'other-run', gate: null, budget: null } });
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, 'INCOMPLETE');
    assert.equal(result.manifest.issues.some((item) => item.code === 'EXPECTED_ID_MISMATCH'), true);
    assert.equal(result.manifest.binding.runnerRunId, 'run-a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CRLF and LF bytes are distinct and preserved', () => {
  const dir = workdir();
  try {
    const lf = write(dir, 'lf.txt', 'a\nb\n');
    const crlf = write(dir, 'crlf.txt', 'a\r\nb\r\n');
    const a = assembleBundle(selection([['a', 'capture-capabilities', lf, 'lf.txt']]), { out: join(dir, 'lf-out') });
    const b = assembleBundle(selection([['a', 'capture-capabilities', crlf, 'crlf.txt']]), { out: join(dir, 'crlf-out') });
    assert.notEqual(a.manifest.artifacts[0].sha256, b.manifest.artifacts[0].sha256);
    assert.deepEqual(readFileSync(join(dir, 'crlf-out', 'crlf.txt')), Buffer.from('a\r\nb\r\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized source is rejected and cleanup preserves the original failure', () => {
  const dir = workdir();
  const out = join(dir, 'bundle');
  try {
    const big = write(dir, 'big.bin', Buffer.alloc(LIMITS.artifactBytes + 1, 0x61));
    assert.throws(() => assembleBundle(selection([['big', 'capture-capabilities', big, 'big.bin']]), {
      out,
      removeOutput: () => 'injected cleanup failure'
    }), /ASSEMBLY_CLEANUP_FAILED: FILE_TOO_LARGE.*injected cleanup failure/);
    assert.equal(existsSync(out), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the artifact count limit is a refusal, not truncation', () => {
  const dir = workdir();
  try {
    const file = write(dir, 'a.txt', 'a');
    const artifacts = [];
    for (let index = 0; index <= LIMITS.artifacts; index += 1) {
      artifacts.push({ id: `a${index}`, role: 'capture-capabilities', sourcePath: file, path: `a${index}.json` });
    }
    assert.throws(() => assembleBundle({ artifacts }, { out: join(dir, 'bundle') }), /ARTIFACT_LIMIT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a source change during copy is rejected and leaves no bundle', () => {
  const dir = workdir();
  const out = join(dir, 'bundle');
  try {
    const source = write(dir, 'changing.txt', 'before');
    assert.throws(() => assembleBundle(selection([
      ['a', 'capture-capabilities', source, 'a.txt']
    ]), {
      out,
      hooks: { beforeCopy: () => writeFileSync(source, 'after-change') }
    }), /SOURCE_CHANGED_DURING_CAPTURE/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copied-byte mismatch is rejected and leaves no bundle', () => {
  const dir = workdir();
  const out = join(dir, 'bundle');
  try {
    const source = write(dir, 'copy.txt', 'original');
    assert.throws(() => assembleBundle(selection([
      ['a', 'capture-capabilities', source, 'a.txt']
    ]), {
      out,
      hooks: { afterCopy: (_artifact, target) => writeFileSync(target, 'corrupted') }
    }), /COPIED_BYTES_MISMATCH/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink source is rejected when the platform permits creating one', (t) => {
  const dir = workdir();
  const out = join(dir, 'bundle');
  try {
    const target = write(dir, 'target.txt', 'target');
    const link = join(dir, 'link.txt');
    try {
      symlinkSync(target, link, 'file');
    } catch (error) {
      t.skip(`symlink unavailable: ${error.code ?? error.message}`);
      return;
    }
    assert.throws(() => assembleBundle(selection([['link', 'capture-capabilities', link, 'link.txt']]), { out }), /SYMLINK_REJECTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing output is refused and CLI returns assembled/invalid codes', () => {
  const dir = workdir();
  try {
    const files = makeArtifacts(dir);
    const out = join(dir, 'bundle');
    mkdirSync(out);
    assert.throws(() => assembleBundle(selection([
      ['runner', 'runner-summary', files.runner, 'runner.json']
    ]), { out }), /OUTPUT_EXISTS/);
    rmSync(out, { recursive: true, force: true });

    const selectionPath = write(dir, 'selection.json', JSON.stringify(selection([
      ['runner', 'runner-summary', files.runner, 'runner.json']
    ])));
    const good = io();
    assert.equal(main(['--selection', selectionPath, '--out', out], good, { pathSafetyProbe: () => ({ reparse: false }) }), 0);
    assert.match(good.out.join(''), /bundle ASSEMBLED/);

    rmSync(out, { recursive: true, force: true });
    const badSelection = write(dir, 'bad-selection.json', JSON.stringify({ artifacts: [{ id: 'x', role: 'runner-summary', sourcePath: files.runner, path: '../x' }] }));
    const bad = io();
    assert.equal(main(['--selection', badSelection, '--out', join(dir, 'bad')], bad), 2);
    assert.match(bad.err.join(''), /RELATIVE_PATH_INVALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
