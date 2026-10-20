// Read-only diagnostic for the migration-link observation difference. This tool
// does not import or change the production migration checker, the acceptance
// predicate or the evidence collector. It creates links only inside a unique
// container under an explicitly supplied writable root and removes that
// container afterwards. Existing profile links are observed only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROBE_SCHEMA = 'tla.migration-link-probe/v1';

const CHILD_OBSERVER = `import fs from 'node:fs';
const p = process.env.PROBE_PATH;
const out = { path: p, execPath: process.execPath, version: process.version };
function capture(fn) { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error: { name: error.name, code: error.code ?? null, message: error.message } }; } }
out.lstat = capture(() => { const s = fs.lstatSync(p); return { isSymbolicLink: s.isSymbolicLink(), isDirectory: s.isDirectory(), isFile: s.isFile(), mode: s.mode, size: s.size, ino: String(s.ino), dev: String(s.dev) }; });
out.readlink = capture(() => fs.readlinkSync(p));
out.realpath = capture(() => fs.realpathSync(p));
console.log(JSON.stringify(out));`;

function captureError(error) {
  return {
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: error?.message ?? String(error)
  };
}

function capture(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: captureError(error) };
  }
}

function lstatInfo(filePath) {
  const s = fs.lstatSync(filePath);
  return {
    isSymbolicLink: s.isSymbolicLink(),
    isDirectory: s.isDirectory(),
    isFile: s.isFile(),
    mode: s.mode,
    size: s.size,
    ino: String(s.ino),
    dev: String(s.dev),
    birthtimeMs: s.birthtimeMs
  };
}

function statInfo(filePath) {
  const s = fs.statSync(filePath);
  return { isDirectory: s.isDirectory(), isFile: s.isFile(), mode: s.mode, size: s.size, ino: String(s.ino), dev: String(s.dev) };
}

export function observePath(filePath) {
  const observation = { path: filePath, exists: false, lstat: null, stat: null, readlink: null, realpath: null, entries: null };
  observation.lstat = capture(() => lstatInfo(filePath));
  observation.exists = observation.lstat.ok;
  observation.stat = capture(() => statInfo(filePath));
  observation.readlink = capture(() => fs.readlinkSync(filePath));
  observation.realpath = capture(() => fs.realpathSync(filePath));
  if (observation.lstat.ok && observation.lstat.value.isDirectory) {
    observation.entries = capture(() => fs.readdirSync(filePath));
  }
  return observation;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15000,
    windowsHide: true,
    env: options.env ?? process.env
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    error: result.error ? captureError(result.error) : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function reparseInfo(filePath) {
  const command = run('fsutil.exe', ['reparsepoint', 'query', filePath]);
  const text = `${command.stdout}\n${command.stderr}`;
  const tagMatch = text.match(/\b(0x[0-9a-f]{8})\b/i);
  const substituteMatch = text.match(/(\\\?\?\\[^\r\n]+)/);
  const substituteName = substituteMatch ? substituteMatch[1].trim() : null;
  return {
    command,
    tag: tagMatch ? tagMatch[1].toLowerCase() : null,
    substituteName,
    printName: null,
    globalPrefix: substituteName ? /\\Global\\/i.test(substituteName) : false
  };
}

function independentObservation(filePath) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_OBSERVER], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, PROBE_PATH: filePath }
  });
  let parsed = null;
  try {
    parsed = child.stdout ? JSON.parse(child.stdout.trim()) : null;
  } catch {
    parsed = null;
  }
  return {
    command: process.execPath,
    status: child.status,
    signal: child.signal,
    error: child.error ? captureError(child.error) : null,
    stderr: child.stderr ?? '',
    stdout: child.stdout ?? '',
    parsed
  };
}

export function classifyObservation(observation, reparse = null) {
  if (!observation?.lstat?.ok) return 'missing';
  if (observation.lstat.value.isSymbolicLink && observation.readlink?.ok && observation.readlink.value) return 'link';
  if (reparse?.tag === '0xa0000003') {
    return observation.realpath?.ok ? 'reparse-not-visible-to-node' : 'reparse-not-visible-broken';
  }
  if (reparse?.command?.error) return 'reparse-probe-unavailable';
  if (observation.lstat.value.isDirectory) return 'ordinary-directory';
  return 'unknown';
}

export function isTargetOutside(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function createNodeJunction(target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
    return { method: 'fs.symlinkSync', target, link, ok: true };
  } catch (error) {
    return { method: 'fs.symlinkSync', target, link, ok: false, error: captureError(error) };
  }
}

function createCmdJunction(target, link) {
  return {
    method: 'cmd.exe mklink /J',
    target,
    link,
    result: run('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target])
  };
}

function addCase(container, id, { target = null, create = null, external = false } = {}) {
  const link = path.join(container, id);
  const createResult = create ? create(target, link) : null;
  const observation = observePath(link);
  const reparse = reparseInfo(link);
  const independent = independentObservation(link);
  return {
    id,
    external,
    link,
    target,
    create: createResult,
    observation,
    reparse,
    independent,
    classification: classifyObservation(observation, reparse),
    targetOutsideContainer: target ? isTargetOutside(container, target) : null
  };
}

function probeRoot(root) {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) throw new Error(`probe root does not exist: ${absoluteRoot}`);
  const container = fs.mkdtempSync(path.join(absoluteRoot, 'dsh-link-probe-'));
  const target = path.join(container, 'target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'marker.txt'), 'TARGET\n');

  const outside = path.join(absoluteRoot, `dsh-link-outside-${path.basename(container)}`);
  fs.mkdirSync(outside, { recursive: true });

  const cases = [];
  cases.push(addCase(container, 'node-junction', { target, create: createNodeJunction }));
  cases.push(addCase(container, 'cmd-junction', { target, create: createCmdJunction }));
  cases.push(addCase(container, 'external-target', { target: outside, create: createNodeJunction, external: true }));

  const ordinary = path.join(container, 'ordinary-directory');
  fs.mkdirSync(ordinary);
  cases.push(addCase(container, 'ordinary-directory'));

  cases.push(addCase(container, 'missing-path'));

  const brokenTarget = path.join(container, 'broken-target');
  fs.mkdirSync(brokenTarget);
  const brokenLink = path.join(container, 'broken-junction');
  const brokenCreate = createNodeJunction(brokenTarget, brokenLink);
  fs.rmSync(brokenTarget, { recursive: true, force: true });
  const brokenObservation = observePath(brokenLink);
  const brokenReparse = reparseInfo(brokenLink);
  cases.push({
    id: 'broken-junction',
    external: false,
    link: brokenLink,
    target: brokenTarget,
    create: brokenCreate,
    observation: brokenObservation,
    reparse: brokenReparse,
    independent: independentObservation(brokenLink),
    classification: classifyObservation(brokenObservation, brokenReparse),
    targetOutsideContainer: false
  });

  const cleanup = capture(() => fs.rmSync(container, { recursive: true, force: true }));
  const outsideCleanup = capture(() => fs.rmSync(outside, { recursive: true, force: true }));
  return {
    root: absoluteRoot,
    container,
    cases,
    cleanup,
    outsideCleanup,
    residualContainer: fs.existsSync(container),
    residualOutside: fs.existsSync(outside)
  };
}

function probeExisting(filePath) {
  const observation = observePath(filePath);
  const reparse = reparseInfo(filePath);
  return {
    path: filePath,
    observation,
    reparse,
    independent: independentObservation(filePath),
    classification: classifyObservation(observation, reparse)
  };
}

function runtimeInfo() {
  return {
    execPath: process.execPath,
    version: process.version,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    execArgv: process.execArgv,
    environment: {
      filePolicy: process.env.DSH_FILE_POLICY ?? null,
      sandboxMode: process.env.DSH_SANDBOX_MODE ?? null,
      workspace: process.env.DSH_WORKSPACE ?? null
    }
  };
}

function parseArgs(argv) {
  const roots = [];
  let existing = null;
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error('--root requires a value');
      roots.push(value);
    } else if (arg === '--existing') {
      const value = argv[++i];
      if (!value) throw new Error('--existing requires a value');
      existing = value;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out requires a value');
      out = value;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (roots.length === 0) throw new Error('at least one --root is required');
  return { roots, existing, out, help: false };
}

function usage() {
  return [
    'Usage:',
    '  node tools/probe-migration-links.mjs --root <writable-root> [--root <writable-root> ...] [--existing <link>] [--out <json>]',
    '',
    'Creates a unique container under each root, probes Node/cmd junctions and',
    'ordinary/missing/broken/external paths, and removes only the containers it',
    'created. An existing link is observed read-only. Exit 0 means all requested',
    'probes completed and cleaned up; exit 1 means a probe or cleanup failed;',
    'exit 2 means invalid CLI usage. A Node observation of "not a link" is data,',
    'not a tool failure.'
  ].join('\n');
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`probe-migration-links: ${error.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const report = {
    schema: PROBE_SCHEMA,
    generatedAt: new Date().toISOString(),
    runtime: runtimeInfo(),
    roots: [],
    existing: null
  };
  let failed = false;

  for (const root of options.roots) {
    try {
      const result = probeRoot(root);
      report.roots.push(result);
      if (!result.cleanup.ok || !result.outsideCleanup.ok || result.residualContainer || result.residualOutside) failed = true;
    } catch (error) {
      report.roots.push({ root: path.resolve(root), error: captureError(error) });
      failed = true;
    }
  }
  if (options.existing) {
    try {
      report.existing = probeExisting(path.resolve(options.existing));
    } catch (error) {
      report.existing = { path: path.resolve(options.existing), error: captureError(error) };
      failed = true;
    }
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    try {
      fs.writeFileSync(path.resolve(options.out), text);
    } catch (error) {
      console.error(`probe-migration-links: cannot write --out: ${error.message}`);
      failed = true;
    }
  }
  process.stdout.write(text);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
