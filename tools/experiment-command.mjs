// Build and check the exact command that starts the next host experiment.
//
// The public copy of that command lives in docs/V0.2-NEXT-EXPERIMENT.md and uses
// placeholders only. This tool turns a local spec into the real argv, checks it with
// the launcher's own parseArgs (so the documented flags cannot drift from the
// implementation), and verifies the preconditions that a documentation string cannot
// prove: required project files exist, the run directory is new, the loopback ports
// differ, and no value is still a placeholder.
//
// It never starts the host, never opens a socket, and never touches the network.
//
// Usage:
//   node tools/experiment-command.mjs --dsh-exe <path> --dsh-cli <path> \
//     --dsh-home <isolated DSH_HOME> --overlay <overlay.yml> --project-cwd <project> \
//     --run-dir <new run dir> --gate-port 18921 --upstream-port 18920 \
//     --require-file src/sum.mjs --require-file test/sum.test.mjs [--print] [--json]

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseLauncherArgs, UsageError } from './gated-run.mjs';
import { runStaticChecks } from './static-preflight.mjs';

export const COMMAND_SCHEMA = 'tla.experiment-command/v1';
export const REPORTED_FLAGS = [
  '--dsh-exe',
  '--dsh-cli',
  '--profile',
  '--patch',
  '--project-cwd',
  '--run-dir',
  '--gate-port',
  '--upstream',
  '--upstream-health-url',
  '--upstream-run-id',
  '--model-requests',
  '--lease-ttl-ms',
  '--heartbeat-max-age-ms',
  '--heartbeat-file',
  '--gate-log',
  '--summary',
  '--timeout-ms',
  '--require-file',
  '--prompt',
];
export const PLACEHOLDER_PATTERN = /^<[^>]+>$/u;
export const MODEL_REQUEST_CEILING = 40;
export const LOOPBACK_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/u;

const KNOWN = new Set([
  '--dsh-exe',
  '--dsh-cli',
  '--dsh-home',
  '--overlay',
  '--profile',
  '--project-cwd',
  '--run-dir',
  '--gate-port',
  '--upstream-port',
  '--model-requests',
  '--lease-ttl-ms',
  '--heartbeat-max-age-ms',
  '--timeout-ms',
  '--require-file',
  '--prompt',
  '--print',
  '--json',
]);

function readLocalArgs(argv) {
  const spec = { requireFiles: [], print: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(arg + ' requires a value');
      return argv[index];
    };
    if (!KNOWN.has(arg)) throw new Error('unknown argument: ' + arg);
    switch (arg) {
      case '--dsh-exe': spec.dshExe = next(); break;
      case '--dsh-cli': spec.dshCli = next(); break;
      case '--dsh-home': spec.dshHome = next(); break;
      case '--overlay': spec.overlay = next(); break;
      case '--profile': spec.profile = next(); break;
      case '--project-cwd': spec.projectCwd = next(); break;
      case '--run-dir': spec.runDir = next(); break;
      case '--gate-port': spec.gatePort = Number(next()); break;
      case '--upstream-port': spec.upstreamPort = Number(next()); break;
      case '--model-requests': spec.modelRequests = Number(next()); break;
      case '--lease-ttl-ms': spec.leaseTtlMs = Number(next()); break;
      case '--heartbeat-max-age-ms': spec.heartbeatMaxAgeMs = Number(next()); break;
      case '--timeout-ms': spec.timeoutMs = Number(next()); break;
      case '--require-file': spec.requireFiles.push(next()); break;
      case '--prompt': spec.prompt = next(); break;
      case '--print': spec.print = true; break;
      case '--json': spec.json = true; break;
      default: throw new Error('unhandled argument: ' + arg);
    }
  }
  return spec;
}

// Electron resolves `--dsh-cli` through the asar archive, so a path inside `*.asar`
// cannot be probed with a filesystem call from outside: only the archive itself is
// visible. Check the archive and leave the inner entry to the host.
function runtimePathState(path) {
  const text = String(path);
  const marker = /(^|[\\/])[^\\/]+\.asar([\\/])/iu.exec(text);
  if (marker === null) return existsSync(text) ? 'present' : 'missing';
  const archive = text.slice(0, marker.index + marker[0].length - 1);
  return existsSync(archive) ? 'inside-archive' : 'archive-missing';
}

function isNewDirectory(path) {
  if (!existsSync(path)) return { ok: true, detail: 'does not exist yet' };
  if (!statSync(path).isDirectory()) return { ok: false, detail: 'exists and is not a directory' };
  const entries = readdirSync(path);
  return entries.length === 0
    ? { ok: true, detail: 'exists and is empty' }
    : { ok: false, detail: 'exists and has ' + entries.length + ' entries; a run directory must be new' };
}

// Pure builder: takes a local spec, returns the argv plus every problem found.
// Exported so the offline test can check the documented command shape directly.
export function buildCommand(spec) {
  const problems = [];
  const notes = [];
  const require = (name, value) => {
    if (value === undefined || value === '') problems.push(name + ' is required');
    else if (PLACEHOLDER_PATTERN.test(String(value))) problems.push(name + ' still holds a placeholder: ' + value);
  };

  require('--dsh-exe', spec.dshExe);
  require('--dsh-cli', spec.dshCli);
  require('--dsh-home', spec.dshHome);
  require('--overlay', spec.overlay);
  require('--project-cwd', spec.projectCwd);
  require('--run-dir', spec.runDir);
  require('--prompt', spec.prompt);
  const modelRequests = spec.modelRequests === undefined ? MODEL_REQUEST_CEILING : spec.modelRequests;
  const leaseTtlMs = spec.leaseTtlMs === undefined ? 6000 : spec.leaseTtlMs;
  const heartbeatMaxAgeMs = spec.heartbeatMaxAgeMs === undefined ? 4000 : spec.heartbeatMaxAgeMs;
  const timeoutMs = spec.timeoutMs === undefined ? 300000 : spec.timeoutMs;
  const profile = spec.profile === undefined ? 'stage1' : spec.profile;
  const gatePort = spec.gatePort;
  const upstreamPort = spec.upstreamPort;

  if (!Number.isInteger(modelRequests) || modelRequests < 1 || modelRequests > MODEL_REQUEST_CEILING) {
    problems.push('--model-requests must be an integer between 1 and ' + MODEL_REQUEST_CEILING + ' (no budget increase without a new approval)');
  }
  if (!Number.isInteger(gatePort) || gatePort < 1024 || gatePort > 65535) problems.push('--gate-port must be a usable local port');
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) problems.push('--upstream-port must be a usable local port');
  if (gatePort === upstreamPort) problems.push('the gate and the fake model must not share a port');
  if (leaseTtlMs < 1000) problems.push('--lease-ttl-ms must be at least 1000');
  if (heartbeatMaxAgeMs < 1000) problems.push('--heartbeat-max-age-ms must be at least 1000');
  if (timeoutMs < 1000) problems.push('--timeout-ms must be at least 1000');

  const runDir = spec.runDir === undefined ? '' : resolve(spec.runDir);
  const argv = ['--profile', profile, '--patch', spec.overlay === undefined ? '<overlay>' : spec.overlay];
  if (spec.projectCwd !== undefined) argv.push('--project-cwd', spec.projectCwd);
  if (runDir !== '') argv.push('--run-dir', runDir);
  argv.push('--gate-port', String(gatePort));
  argv.push('--upstream', 'http://127.0.0.1:' + upstreamPort);
  argv.push('--upstream-health-url', 'http://127.0.0.1:' + upstreamPort + '/health');
  argv.push('--upstream-run-id', 'upstream-next');
  argv.push('--model-requests', String(modelRequests));
  argv.push('--lease-ttl-ms', String(leaseTtlMs));
  argv.push('--heartbeat-max-age-ms', String(heartbeatMaxAgeMs));
  if (runDir !== '') {
    argv.push('--heartbeat-file', join(runDir, 'plugin-events.jsonl'));
    argv.push('--gate-log', join(runDir, 'gate-events.jsonl'));
    argv.push('--summary', join(runDir, 'gate-summary.json'));
  }
  argv.push('--timeout-ms', String(timeoutMs));
  for (const file of spec.requireFiles || []) argv.push('--require-file', file);
  if (spec.dshExe !== undefined) argv.push('--dsh-exe', spec.dshExe);
  if (spec.dshCli !== undefined) argv.push('--dsh-cli', spec.dshCli);
  if (spec.prompt !== undefined) argv.push('--prompt', spec.prompt);

  // The launcher is the authority on its own flags: parse the argv we just built.
  let options = null;
  try {
    options = parseLauncherArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) problems.push('the launcher rejects the command: ' + error.message);
    else throw error;
  }

  if (options !== null) {
    for (const flag of ['dshExe', 'dshCli', 'profile', 'prompt', 'upstream', 'heartbeatFile']) {
      if (options[flag] === undefined) problems.push('the launcher requires --' + flag.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
    }
    if (!LOOPBACK_PATTERN.test(options.upstream)) problems.push('--upstream must be a loopback origin, got ' + options.upstream);
    if (options.requireFiles.length === 0) problems.push('at least one --require-file is needed so an empty directory cannot pass as the project');
    for (const file of options.requireFiles) {
      const candidate = resolve(options.projectCwd ?? process.cwd(), file);
      if (!existsSync(candidate)) problems.push('required project file is missing: ' + file + ' (' + candidate + ')');
    }
    if (spec.overlay !== undefined && !existsSync(spec.overlay)) problems.push('overlay patch is missing: ' + spec.overlay);
    if (spec.dshExe !== undefined && !existsSync(spec.dshExe)) problems.push('--dsh-exe does not exist: ' + spec.dshExe);
    if (spec.dshCli !== undefined) {
      const state = runtimePathState(spec.dshCli);
      if (state === 'missing') problems.push('--dsh-cli does not exist: ' + spec.dshCli);
      if (state === 'archive-missing') problems.push('--dsh-cli names an archive that does not exist: ' + spec.dshCli);
      if (state === 'inside-archive') notes.push('--dsh-cli lives inside an asar archive; only the archive itself was checked');
    }
    const runDirState = isNewDirectory(options.runDir ?? runDir);
    if (!runDirState.ok) problems.push('run directory: ' + runDirState.detail);
    else notes.push('run directory: ' + runDirState.detail);
    for (const name of ['heartbeatFile', 'gateLog', 'summary']) {
      const value = options[name];
      if (typeof value === 'string' && runDir !== '' && resolve(dirname(value)) !== runDir) {
        problems.push('--' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ' must live inside the run directory');
      }
    }
  }

  return { schema: COMMAND_SCHEMA, argv, options, problems, notes, spec };
}

function quote(value) {
  return "'" + String(value).replace(/'/gu, "''") + "'";
}

// PowerShell form of the same argv, with the two environment variables the run needs.
export function toPowerShell(command) {
  const { argv, spec } = command;
  const pieces = [];
  pieces.push('$env:DSH_HOME = ' + quote(spec.dshHome === undefined ? '<dsh-home>' : spec.dshHome));
  pieces.push('$env:TLA_STAGE2_FAKE_KEY = ' + quote('stage2-fake-key'));
  const args = argv.map(quote).join(' ');
  pieces.push('node ' + quote(join(dirname(fileURLToPath(import.meta.url)), 'gated-run.mjs')) + ' ' + args);
  return pieces.join('\n');
}

function main(argv) {
  let spec;
  try {
    spec = readLocalArgs(argv);
  } catch (error) {
    process.stderr.write('experiment-command: ' + error.message + '\n');
    return 2;
  }
  const command = buildCommand(spec);
  if (command.problems.length > 0) {
    for (const problem of command.problems) process.stderr.write('experiment-command: ' + problem + '\n');
    return 2;
  }
  for (const note of command.notes) process.stderr.write('experiment-command: ' + note + '\n');
  // Static checks run before the command is printed: a failure here means the run must
  // not be proposed for approval at all (2026-10-18 spent its approval on exactly this).
  return runStaticChecks({
    projectCwd: spec.projectCwd,
    redTest: spec.redTest,
    dshHome: spec.dshHome,
    profile: spec.profile,
    gatePort: spec.gatePort,
    upstreamPort: spec.upstreamPort
  }).then((statics) => {
    for (const check of statics.checks) process.stderr.write('experiment-command: static ' + (check.ok ? 'ok   ' : 'FAIL ') + check.name + ' — ' + check.detail + '\n');
    if (!statics.ok) {
      process.stderr.write('experiment-command: STATIC PREFLIGHT FAILED — do not request an escalation for this command\n');
      return 1;
    }
    if (spec.json) {
      process.stdout.write(
        JSON.stringify(
          { schema: command.schema, argv: command.argv, statics, runIdRule: 'generated by the launcher' },
          null,
          2
        ) + '\n'
      );
    }
    if (spec.print) process.stdout.write(toPowerShell(command) + '\n');
    if (!spec.json && !spec.print) {
      process.stdout.write('command validated: ' + command.argv.length + ' arguments, ' + (spec.requireFiles || []).length + ' required files\n');
    }
    process.stdout.write('STATIC PREFLIGHT OK\n');
    return 0;
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write('experiment-command: ' + (error instanceof Error ? error.message : String(error)) + '\n');
      process.exitCode = 2;
    }
  );
}
