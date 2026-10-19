#!/usr/bin/env node
// Read-only audit of an isolated DSH profile after a worktree migration.
//
// A Git worktree move rewrites Git's own registration, but it does not rewrite
// links that live outside the worktree. The profile's package manifest, its
// pnpm lockfile and node_modules can still point at the old, now-missing path.
// This check fails before an experiment approval is requested when that happens.
//
// It deliberately reads only the profile's active dependency files. Historical
// artifacts (old logs, old specs, package.before-uninstall.json and pnpm's
// .ignored* store) are evidence, not active configuration, and are not scanned.

import { existsSync, lstatSync, readlinkSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEWED_PLUGIN_EVIDENCE,
  fingerprintPluginDir,
  verifyInstalledPlugin
} from '../orchestration/gate/preflight.mjs';

export const DEFAULT_PLUGIN = 'tla-prelaunch-budget';

// Files that can carry an active dependency path. Keep this list explicit:
// a recursive scan would also hit historical evidence and backups.
export const ACTIVE_PROFILE_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.yml',
  'cordis.patch.yml',
  'stage1-config.yml',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json'
]);

function normalized(path) {
  return resolve(path).replace(/\\/g, '/');
}

function inside(root, child) {
  const base = normalized(root);
  const candidate = normalized(child);
  return candidate === base || candidate.startsWith(base + '/');
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (_missing) {
    return null;
  }
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (_invalid) {
    return null;
  }
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Read the importer entry for one dependency from a pnpm v9 lockfile without
// pulling in a YAML dependency. The importer block is indentation based and the
// dependency entry only has specifier/version children.
export function parsePnpmLockEntry(lockText, plugin = DEFAULT_PLUGIN) {
  const lines = lockText.split(/\r?\n/);
  const header = new RegExp('^\\s+' + escaped(plugin) + ':\\s*$');
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const baseIndent = lines[start].match(/^\s*/)[0].length;
  const entry = { specifier: null, version: null };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;
    const match = line.match(/^\s*(specifier|version):\s*(.+?)\s*$/);
    if (match !== null) entry[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return entry;
}

function check(checks, id, ok, detail) {
  checks.push({ id, ok: ok === true, detail: String(detail ?? '') });
}

export function auditMigrationLinks(options = {}) {
  const profile = options.profile;
  if (typeof profile !== 'string' || profile === '') {
    throw new Error('profile is required');
  }
  const plugin = options.plugin ?? DEFAULT_PLUGIN;
  const profileRoot = resolve(profile);
  const checks = [];

  const manifestPath = join(profileRoot, 'package.json');
  const lockPath = join(profileRoot, 'pnpm-lock.yaml');
  const linkPath = join(profileRoot, 'node_modules', plugin);

  check(checks, 'profile:readable', existsSync(profileRoot), profileRoot);

  const manifest = readJson(manifestPath);
  const declared = manifest?.dependencies?.[plugin] ?? manifest?.optionalDependencies?.[plugin] ?? null;
  const declaresLink = typeof declared === 'string' && declared.startsWith('link:');
  const manifestTarget = declaresLink ? resolve(profileRoot, declared.slice('link:'.length)) : null;
  check(checks, 'manifest:declared', declared !== null, declared ?? 'dependency not declared');
  check(checks, 'manifest:link-syntax', declaresLink, declared ?? '');
  check(
    checks,
    'manifest:inside-profile',
    manifestTarget !== null && inside(profileRoot, manifestTarget),
    manifestTarget ?? ''
  );
  check(
    checks,
    'manifest:target-exists',
    manifestTarget !== null && existsSync(join(manifestTarget, 'package.json')),
    manifestTarget ?? ''
  );

  const lockText = readText(lockPath);
  const lockEntry = lockText === null ? null : parsePnpmLockEntry(lockText, plugin);
  check(checks, 'lock:present', lockText !== null, lockPath);
  check(checks, 'lock:entry', lockEntry !== null, lockEntry === null ? 'dependency not found' : '');
  check(
    checks,
    'lock:specifier',
    lockEntry !== null && lockEntry.specifier === declared,
    lockEntry?.specifier ?? ''
  );
  const lockVersion = lockEntry?.version ?? null;
  const lockIsLink = typeof lockVersion === 'string' && lockVersion.startsWith('link:');
  const lockTarget = lockIsLink ? resolve(profileRoot, lockVersion.slice('link:'.length)) : null;
  check(
    checks,
    'lock:version-syntax',
    lockIsLink,
    lockVersion ?? ''
  );
  check(
    checks,
    'lock:inside-profile',
    lockTarget !== null && inside(profileRoot, lockTarget),
    lockTarget ?? ''
  );
  check(
    checks,
    'lock:matches-manifest',
    manifestTarget !== null && lockTarget !== null && normalized(manifestTarget) === normalized(lockTarget),
    lockTarget ?? ''
  );

  // readlink reads the reparse target itself; realpath alone could also
  // succeed on an ordinary directory. Some Windows environments expose a
  // directory-like lstat for a junction, so retain both observations.
  let linkType = 'missing';
  let statSaysLink = false;
  let linkTarget = null;
  try {
    statSaysLink = lstatSync(linkPath).isSymbolicLink();
    linkType = 'not-a-link';
    try { linkTarget = readlinkSync(linkPath); } catch (_notReadableLink) {}
    if (typeof linkTarget === 'string' && linkTarget.length > 0) {
      linkType = 'junction-or-symlink';
    }
  } catch (_missingLink) {}
  check(checks, 'link:present', linkType !== 'missing', linkPath);
  check(checks, 'link:junction', linkType === 'junction-or-symlink',
    `${linkType}; lstat-link=${statSaysLink}; readlink=${linkTarget ?? 'unavailable'}`);

  let resolvedTarget = null;
  try {
    resolvedTarget = realpathSync(linkPath);
  } catch (_brokenLink) {
    resolvedTarget = null;
  }
  check(checks, 'link:resolves', resolvedTarget !== null, resolvedTarget ?? 'link target is missing');
  check(
    checks,
    'link:inside-profile',
    resolvedTarget !== null && inside(profileRoot, resolvedTarget),
    resolvedTarget ?? ''
  );
  check(
    checks,
    'link:matches-manifest',
    resolvedTarget !== null && manifestTarget !== null && normalized(resolvedTarget) === normalized(manifestTarget),
    resolvedTarget ?? ''
  );

  let mirror = null;
  const mirrorDir = resolvedTarget ?? manifestTarget;
  if (mirrorDir !== null) {
    try {
      mirror = fingerprintPluginDir(mirrorDir);
    } catch (_unreadable) {
      mirror = { ok: false, reason: 'PLUGIN_UNREADABLE' };
    }
  }
  check(
    checks,
    'mirror:fingerprint',
    mirror?.ok === true,
    mirror?.ok === true ? mirror.buildDigest : (mirror?.reason ?? 'no package directory')
  );

  const expectedDigest = options.expectedDigest ?? REVIEWED_PLUGIN_EVIDENCE[plugin]?.buildDigest ?? null;
  if (expectedDigest !== null) {
    check(
      checks,
      'mirror:registered',
      mirror?.ok === true && mirror.buildDigest === expectedDigest,
      mirror?.buildDigest ?? ''
    );
  }

  if (options.sourceDir) {
    const sourceRoot = resolve(options.sourceDir);
    let source = null;
    try {
      source = fingerprintPluginDir(sourceRoot);
    } catch (_unreadableSource) {
      source = { ok: false, reason: 'SOURCE_UNREADABLE' };
    }
    check(checks, 'source:fingerprint', source?.ok === true, source?.reason ?? sourceRoot);
    check(
      checks,
      'mirror:source-match',
      mirror?.ok === true
        && source?.ok === true
        && mirror.buildDigest === source.buildDigest
        && mirror.version === source.version
        && mirror.fileCount === source.fileCount,
      `${mirror?.buildDigest ?? ''} vs ${source?.buildDigest ?? ''}`
    );
  }

  let identity = null;
  if (resolvedTarget !== null) {
    identity = verifyInstalledPlugin({ name: plugin, pkgDir: resolvedTarget });
  }
  check(
    checks,
    'identity:verified',
    identity?.status === 'verified',
    identity?.status === 'verified'
      ? `${identity.version} / ${identity.fileCount} files / ${identity.buildDigest}`
      : (identity?.detail ?? identity?.reason ?? 'no identity result')
  );
  if (expectedDigest !== null) {
    check(
      checks,
      'identity:registered',
      identity?.buildDigest === expectedDigest,
      identity?.buildDigest ?? ''
    );
  }

  const legacyPath = options.legacyPath ?? null;
  const activeFiles = options.activeFiles ?? ACTIVE_PROFILE_FILES;
  const legacyHits = [];
  if (legacyPath !== null) {
    for (const relativePath of activeFiles) {
      const text = readText(join(profileRoot, relativePath));
      if (text !== null && text.includes(legacyPath)) legacyHits.push(relativePath);
    }
  }
  check(
    checks,
    'active:legacy-path',
    legacyPath === null || legacyHits.length === 0,
    legacyPath === null ? 'not requested' : legacyHits.join(', ')
  );

  const problems = checks.filter((item) => item.ok !== true);
  return {
    ok: problems.length === 0,
    profile: profileRoot,
    plugin,
    checks,
    problems
  };
}

function usage() {
  return [
    'usage: node tools/check-migration-links.mjs --profile <dir> [options]',
    '',
    '  --plugin <name>             plugin to inspect (default tla-prelaunch-budget)',
    '  --source-dir <dir>          reviewed source tree to compare the profile mirror against',
    '  --expected-digest <sha256>  override the registered build digest',
    '  --legacy-path <text>        fail if this text survives in an active profile file',
    '  --json                      print the result as JSON',
    ''
  ].join('\n');
}

function parseCli(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    const accepted = ['--profile', '--plugin', '--source-dir', '--expected-digest', '--legacy-path'];
    if (!accepted.includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === '--profile') options.profile = value;
    if (flag === '--plugin') options.plugin = value;
    if (flag === '--source-dir') options.sourceDir = value;
    if (flag === '--expected-digest') options.expectedDigest = value;
    if (flag === '--legacy-path') options.legacyPath = value;
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-migration-links: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  let result;
  try {
    result = auditMigrationLinks(options);
  } catch (error) {
    process.stderr.write(`check-migration-links: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    for (const item of result.checks) {
      process.stdout.write(`migration-links: ${item.ok ? 'ok  ' : 'FAIL'} ${item.id} — ${item.detail}\n`);
    }
    process.stdout.write(
      result.ok
        ? `MIGRATION LINKS OK (${result.checks.length} checks)\n`
        : `MIGRATION LINKS FAILED (${result.problems.length} of ${result.checks.length} checks)\n`
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();
