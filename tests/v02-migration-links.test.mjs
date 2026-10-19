// A worktree move rewrites Git registration only. The isolated DSH profile can
// still hold a Junction, a package manifest entry and a pnpm lock entry that
// point at the old path. These tests pin the read-only migration audit so the
// next move fails before an experiment approval instead of at launch time.
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, lstatSync, readlinkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMigrationLinks, parsePnpmLockEntry } from '../tools/check-migration-links.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'orchestration', 'interceptor-plugin');
const SCRATCH = process.env.TLA_LINK_TEST_ROOT || join(ROOT, 'tests', '.scratch', 'migration-links');
const PLUGIN = 'tla-prelaunch-budget';
const SPEC = 'link:./vendor/interceptor-plugin';
const LOCK_VERSION = 'link:vendor/interceptor-plugin';

function scratch() {
  mkdirSync(SCRATCH, { recursive: true });
  return mkdtempSync(join(SCRATCH, 'case-'));
}

function writeProfile(dir, {
  spec = SPEC,
  lockSpecifier = spec,
  lockVersion = LOCK_VERSION,
  linkTarget = join(dir, 'vendor', 'interceptor-plugin')
} = {}) {
  mkdirSync(join(dir, 'vendor'), { recursive: true });
  cpSync(SOURCE, join(dir, 'vendor', 'interceptor-plugin'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-profile', private: true, dependencies: { [PLUGIN]: spec } }, null, 2) + '\n'
  );
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      `      ${PLUGIN}:`,
      `        specifier: ${lockSpecifier}`,
      `        version: ${lockVersion}`,
      ''
    ].join('\n')
  );
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(linkTarget, join(dir, 'node_modules', PLUGIN), 'junction');
}

function failedIds(result) {
  return result.problems.map((item) => item.id);
}

test('an in-profile link with a matching manifest and lock passes', () => {
  const dir = scratch();
  try {
    writeProfile(dir);
    writeFileSync(join(dir, 'cordis.yml'), 'plugins:\n  - id: llm-deepseek\n');
    const result = auditMigrationLinks({ profile: dir, sourceDir: SOURCE, legacyPath: 'v02-worktree' });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.checks.length, 23);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an external link target fails the inside-profile checks', () => {
  const container = scratch();
  const dir = join(container, 'profile');
  const outside = join(container, 'outside-plugin');
  try {
    cpSync(SOURCE, outside, { recursive: true });
    writeProfile(dir, {
      spec: 'link:../outside-interceptor-plugin',
      lockSpecifier: 'link:../outside-interceptor-plugin',
      lockVersion: 'link:../outside-interceptor-plugin',
      linkTarget: outside
    });
    const result = auditMigrationLinks({ profile: dir });
    assert.equal(result.ok, false);
    assert.equal(failedIds(result).includes('manifest:inside-profile'), true);
    assert.equal(failedIds(result).includes('link:inside-profile'), true);
    assert.equal(failedIds(result).includes('lock:inside-profile'), true);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test('a broken junction fails before the plugin is read', () => {
  const dir = scratch();
  try {
    writeProfile(dir);
    rmSync(join(dir, 'vendor', 'interceptor-plugin'), { recursive: true, force: true });
    const result = auditMigrationLinks({ profile: dir });
    assert.equal(result.ok, false);
    assert.equal(failedIds(result).includes('link:resolves'), true);
    assert.equal(failedIds(result).includes('manifest:target-exists'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock specifier that disagrees with the manifest fails', () => {
  const dir = scratch();
  try {
    writeProfile(dir, { lockSpecifier: 'link:./vendor/other-plugin' });
    const result = auditMigrationLinks({ profile: dir });
    assert.equal(result.ok, false);
    assert.equal(failedIds(result).includes('lock:specifier'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mirror drift fails against both the registered digest and the source', () => {
  const dir = scratch();
  try {
    writeProfile(dir);
    appendFileSync(join(dir, 'vendor', 'interceptor-plugin', 'index.js'), '\n// unregistered drift\n');
    const result = auditMigrationLinks({ profile: dir, sourceDir: SOURCE });
    assert.equal(result.ok, false);
    assert.equal(failedIds(result).includes('mirror:registered'), true);
    assert.equal(failedIds(result).includes('mirror:source-match'), true);
    assert.equal(failedIds(result).includes('identity:verified'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy text in an active file fails, but the pnpm .ignored store is not active', () => {
  const dir = scratch();
  try {
    writeProfile(dir);
    writeFileSync(join(dir, '.ignored_tla-prelaunch-budget'), 'old: D:/old/v02-worktree/orchestration\n');
    const clean = auditMigrationLinks({ profile: dir, legacyPath: 'v02-worktree' });
    assert.equal(clean.ok, true, JSON.stringify(clean.problems));

    writeFileSync(join(dir, 'cordis.yml'), 'pluginRoot: D:/old/v02-worktree/orchestration\n');
    const dirty = auditMigrationLinks({ profile: dir, legacyPath: 'v02-worktree' });
    assert.equal(dirty.ok, false);
    assert.equal(failedIds(dirty).includes('active:legacy-path'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock parser reads only the importer entry', () => {
  const text = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      ${PLUGIN}:`,
    '        specifier: link:./vendor/interceptor-plugin',
    '        version: link:vendor/interceptor-plugin',
    '      other-plugin:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    ''
  ].join('\n');
  assert.deepEqual(parsePnpmLockEntry(text, PLUGIN), {
    specifier: 'link:./vendor/interceptor-plugin',
    version: 'link:vendor/interceptor-plugin'
  });
});

test('ordinary directory cannot substitute for a dependency junction', () => {
  const dir = scratch();
  try {
    writeProfile(dir);
    const link = join(dir, 'node_modules', PLUGIN);
    rmSync(link, { recursive: true, force: true });
    cpSync(join(dir, 'vendor', 'interceptor-plugin'), link, { recursive: true });
    const result = auditMigrationLinks({ profile: dir, sourceDir: SOURCE });
    assert.equal(result.ok, false);
    assert.ok(failedIds(result).includes('link:junction'));
    assert.ok(failedIds(result).includes('link:matches-manifest'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OS temp volume and checkout volume expose real link targets', () => {
  for (const base of [SCRATCH, tmpdir()]) {
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'link-volume-'));
    try {
      writeProfile(dir);
      const link = join(dir, 'node_modules', PLUGIN);
      assert.ok(readlinkSync(link).length > 0);
      const result = auditMigrationLinks({ profile: dir, sourceDir: SOURCE });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      console.log(JSON.stringify({ probe: 'junction', volumeRoot: base,
        node: process.version, lstatLink: lstatSync(link).isSymbolicLink() }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('readlink proves a junction even when lstat reports directory-like metadata', () => {
  const dir = scratch();
  try {
    writeProfile(dir);
    const moduleUrl = new URL('../tools/check-migration-links.mjs', import.meta.url).href;
    // Isolated process models only the discrepant lstat observation; readlink,
    // realpath, installed bytes and all containment checks remain real.
    const code = `import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original=fs.lstatSync;
      fs.lstatSync=(...args)=>{ const stat=original(...args);
        if(String(args[0]).endsWith('tla-prelaunch-budget')) stat.isSymbolicLink=()=>false;
        return stat; };
      syncBuiltinESMExports();
      const {auditMigrationLinks}=await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify(auditMigrationLinks({profile:process.argv[1]})));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, dir], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.match(report.checks.find(c => c.id === 'link:junction').detail, /lstat-link=false; readlink=/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
