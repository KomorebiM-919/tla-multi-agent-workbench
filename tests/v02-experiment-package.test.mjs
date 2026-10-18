// Offline checks for docs/V0.2-NEXT-EXPERIMENT.md and tools/experiment-command.mjs.
//
// The package is the thing a reviewer approves before a host run, so the documented
// command has to be the command the launcher actually accepts. Documentation strings
// are checked against the launcher's own parseArgs and against the fake model's real
// flags; nothing here starts a process, opens a socket, or touches the network.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseLauncherArgs, UsageError } from '../tools/gated-run.mjs';
import { buildCommand, PLACEHOLDER_PATTERN, REPORTED_FLAGS, runCommandBuilder } from '../tools/experiment-command.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOC_PATH = join(HERE, '..', 'docs', 'V0.2-NEXT-EXPERIMENT.md');
const DOC = readFileSync(DOC_PATH, 'utf8');
const FAKE_SERVER = join(HERE, '.scratch', 'v02-stage2', 'fake-model-server.mjs');

let checks = 0;
let failures = 0;
function check(condition, label, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error('FAIL ' + label + (detail === '' ? '' : '  ?  ' + detail));
  }
}

// Pull the one command block that invokes the launcher, drop the bash line
// continuations, and split it the way a shell would.
function commandBlock(text) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /node\s+tools\/gated-run\.mjs/u.test(line));
  if (start === -1) return { args: [], raw: '' };
  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('```')) break;
    const continued = line.endsWith('\\');
    collected.push(continued ? line.slice(0, -1).trim() : line);
    if (!continued) break;
  }
  const raw = collected.join(' ');
  const args = [];
  let current = '';
  let quote = null;
  for (const character of raw) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ' ') { if (current !== '') { args.push(current); current = ''; } continue; }
    current += character;
  }
  if (current !== '') args.push(current);
  const firstFlag = args.findIndex((value) => value.startsWith('--'));
  return { args: firstFlag === -1 ? [] : args.slice(firstFlag), raw };
}

const block = commandBlock(DOC);

// 1. The documented command is the launcher's command, with placeholders filled in.
const SUBSTITUTIONS = new Map([
  ['<repo>', 'C:\\work\\repo'],
  ['<harness>', 'C:\\work\\repo\\tests\\.scratch\\v02-stage2'],
  ['<new-overlay>.patch.yml', 'C:\\work\\repo\\overlay.patch.yml'],
  ['<new-overlay>', 'C:\\work\\repo\\overlay.patch.yml'],
  ['<overlay>.patch.yml', 'C:\\work\\repo\\overlay.patch.yml'],
  ['<new-project>', 'C:\\work\\repo\\project'],
  ['<new-run-dir>', 'C:\\work\\repo\\run'],
  ['<captain prompt>', 'You are the captain of team next.'],
  ['<path-to-host-exe>', 'C:\\work\\host\\DeepSeek Harness.exe'],
  ['<path-to-host-cli.js>', 'C:\\work\\host\\cli.js'],
  ['<dir>', 'C:\\work\\repo\\bodies'],
]);
function filled(value) {
  let result = value;
  for (const [placeholder, replacement] of SUBSTITUTIONS) result = result.split(placeholder).join(replacement);
  return result;
}

check(block.args.length > 0, 'the package contains a launcher command');
const filledArgs = block.args.map(filled);
const leftover = filledArgs.filter((value) => PLACEHOLDER_PATTERN.test(value));
check(leftover.length === 0, 'every placeholder in the command has a documented substitution', JSON.stringify(leftover));

let parsed = null;
try {
  parsed = parseLauncherArgs(filledArgs);
  check(true, 'the launcher accepts the documented command unchanged');
} catch (error) {
  check(false, 'the launcher accepts the documented command unchanged', error instanceof UsageError ? error.message : String(error));
}

if (parsed !== null) {
  check(parsed.modelRequests === 40, 'the documented budget is the approved 40', String(parsed.modelRequests));
  check(parsed.gatePort === 18921, 'the documented gate port is 18921', String(parsed.gatePort));
  check(parsed.upstream === 'http://127.0.0.1:18920', 'the documented upstream is the loopback fake model', String(parsed.upstream));
  check(parsed.dshExe !== undefined && parsed.dshCli !== undefined, 'the command passes the host executable and cli it validates');
  check(parsed.profile === 'stage1', 'the command uses the isolated profile', String(parsed.profile));
  check(parsed.requireFiles.length === 3, 'the command requires every project file the run reads', JSON.stringify(parsed.requireFiles));
  check(typeof parsed.prompt === 'string' && parsed.prompt.length > 0, 'the command carries the captain prompt');
  check(parsed.heartbeatFile.endsWith('plugin-events.jsonl'), 'the heartbeat file is the plugin event log', parsed.heartbeatFile);
  check(resolve(dirname(parsed.summary)) === resolve(dirname(parsed.heartbeatFile)), 'summary and heartbeat live in the same run directory');
}

// 2. The package never leaks a local absolute path or the retired flag name.
check(!block.args.includes('--captain-prompt'), 'the documented command does not use the retired --captain-prompt flag');
const absolute = DOC.match(/\b[A-Za-z]:[\\/][^\s`)|]*/gu) ?? [];
check(absolute.length === 0, 'the package contains no local absolute path', JSON.stringify(absolute.slice(0, 3)));
// The account name is deliberately not written into this file: the check reads it from
// the environment, so the guard cannot itself become the leak it is meant to catch.
const localUser = process.env.USERNAME ?? process.env.USER ?? '';
check(localUser === '' || !DOC.includes(localUser), 'the package contains no local account name');
check(!/[A-Za-z]:\\{1,2}Users\\{1,2}\d+/u.test(DOC), 'the package contains no absolute user home path');
const unknown = filledArgs.filter((value) => value.startsWith('--') && !REPORTED_FLAGS.includes(value));
check(unknown.length === 0, 'every flag in the command is a real launcher flag', JSON.stringify(unknown));

// 3. Three named revisions: the code that executes, the fixtures that replay, and the
//    document itself. A document cannot carry its own hash, so it states how to read it.
const SHAS = DOC.match(/\b[0-9a-f]{40}\b/gu) ?? [];
check(SHAS.length >= 2, 'the package pins the executing revision and the fixture revision', JSON.stringify(SHAS));
check(/执行源码（executable source）/u.test(DOC), 'the package labels the execution source revision');
check(/夹具（fixtures）/u.test(DOC), 'the package labels the fixture revision');
check(/说明文档（this document）/u.test(DOC) && /git log -1 --format=%H -- docs\/V0\.2-NEXT-EXPERIMENT\.md/u.test(DOC), 'the package states how to read the document revision without hashing itself');
check(SHAS.includes('4fc9515935fbbe67ad567ef12921bc1ff5b47d1d'), 'the frozen fixture revision is still the one that replays offline');

// 4. Preconditions the run depends on are stated, not implied.
const PRE = [
  ['defect hash', /3C1B1584AD85CEB46CB65251A19ABF93435A973B4C19CEA72BC57094195460/u],
  ['red test command', /node test\/sum\.test\.mjs/u],
  ['expected fixed behaviour', /修复版|fixed revision|转绿/u],
  ['fresh team directory', /团队状态目录|teams/u],
  ['fresh run id', /runId/u],
  ['log directory', /run-dir|日志目录/u],
  ['note.txt read before write', /note\.txt/u],
];
for (const [label, pattern] of PRE) check(pattern.test(DOC), 'the package states: ' + label);

// 5. Success is never decided from text alone.
for (const [label, pattern] of [
  ['tool_result', /tool_result/u],
  ['exit code', /退出码|exit code/u],
  ['complete summary', /gate-summary|summary/u],
]) {
  check(pattern.test(DOC), 'success criteria include ' + label);
}
check(/不能仅凭|not from text alone|文本/u.test(DOC), 'the package says text alone is not a success signal');

// 6. The fake model invocation matches the fake model's real flags, and the ports and
//    run id agree with what the launcher is told.
const fakeLine = DOC.split(/\r?\n/u).find((line) => /--policy\s+tests\/fixtures/u.test(line)) ?? '';
check(fakeLine !== '', 'the package shows how the fake model is started');
const fakeFlags = fakeLine.match(/--[a-z-]+/gu) ?? [];
for (const flag of ['--port', '--policy', '--run-id', '--body-dir']) {
  check(fakeFlags.includes(flag), 'the documented fake model invocation uses ' + flag);
}
if (existsSync(FAKE_SERVER)) {
  const source = readFileSync(FAKE_SERVER, 'utf8');
  for (const flag of ['--port', '--policy', '--run-id', '--body-dir']) {
    check(source.includes("'" + flag + "'"), 'the fake model implementation recognises ' + flag);
  }
} else {
  check(/不入库|本地实验台|local harness/u.test(DOC), 'the package marks the fake model as a local (unversioned) harness');
}
const fakePort = fakeLine.match(/--port\s+(\d+)/u);
const fakeRunId = fakeLine.match(/--run-id\s+(\S+)/u);
if (fakePort !== null && parsed !== null) {
  check(parsed.upstream.endsWith(':' + fakePort[1]), 'the documented fake model port matches --upstream', fakePort[1]);
}
if (fakeRunId !== null && parsed !== null) {
  check(parsed.upstreamRunId === fakeRunId[1].replace(/["'`]/gu, ''), 'the documented fake model run id matches --upstream-run-id', fakeRunId[1]);
}

// 7. The builder refuses incomplete specs instead of producing a plausible command.
const placeholderSpec = buildCommand({ requireFiles: ['src/sum.mjs'], modelRequests: 40, gatePort: 18921, upstreamPort: 18920 });
check(placeholderSpec.problems.length > 0, 'an incomplete spec is refused, not filled in');
check(placeholderSpec.problems.some((problem) => /--dsh-exe is required/u.test(problem)), 'the refusal names the missing host executable');

// 8. A real local spec is accepted only when its preconditions hold.
const root = mkdtempSync(join(tmpdir(), 'tla-package-'));
try {
  const project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'test'), { recursive: true });
  writeFileSync(join(project, 'src', 'sum.mjs'), 'export const sum = () => 0;\n');
  writeFileSync(join(project, 'src', 'note.txt'), 'PREFLIGHT-BASELINE\n');
  writeFileSync(join(project, 'test', 'sum.test.mjs'), 'console.log("sum tests: 0 passed, 1 failed");\n');
  const overlay = join(root, 'overlay.patch.yml');
  writeFileSync(overlay, '- id: llm-deepseek\n');
  const runDir = join(root, 'run');
  const exe = join(root, 'host.exe');
  writeFileSync(exe, '');
  const spec = {
    dshExe: exe,
    dshCli: exe,
    dshHome: join(root, 'dsh-home'),
    overlay,
    projectCwd: project,
    runDir,
    gatePort: 18921,
    upstreamPort: 18920,
    modelRequests: 40,
    requireFiles: ['src/sum.mjs', 'test/sum.test.mjs', 'src/note.txt'],
    prompt: 'You are the captain of team next.',
  };
  const good = buildCommand(spec);
  check(good.problems.length === 0, 'a complete local spec is accepted', JSON.stringify(good.problems));
  check(good.argv.includes('--dsh-exe') && good.argv.includes('--dsh-cli'), 'the built command passes both host paths the launcher needs');
  const again = buildCommand(spec);
  check(JSON.stringify(again.argv) === JSON.stringify(good.argv), 'the same spec builds the same command');

  rmSync(join(project, 'src', 'note.txt'));
  const missingNote = buildCommand(spec);
  check(missingNote.problems.some((problem) => /note\.txt/u.test(problem)), 'a missing note.txt is caught before the host starts');

  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'leftover.log'), 'x\n');
  const reused = buildCommand({ ...spec, requireFiles: ['src/sum.mjs'] });
  check(reused.problems.some((problem) => /run directory/u.test(problem)), 'a reused run directory is refused');

  const overBudget = buildCommand({ ...spec, modelRequests: 41, requireFiles: ['src/sum.mjs'] });
  check(overBudget.problems.some((problem) => /model-requests/u.test(problem)), 'the request ceiling cannot be raised by editing the spec');

  // Electron serves `--dsh-cli` from inside the asar archive, where a filesystem probe
  // cannot see it. The archive is checked instead, so a valid packaged path is accepted.
  const archive = join(root, 'app.asar');
  writeFileSync(archive, '');
  const packed = buildCommand({ ...spec, runDir: join(root, 'run-packed'), dshCli: join(archive, 'dsh', 'cli.js'), requireFiles: ['src/sum.mjs'] });
  check(packed.problems.length === 0, 'a cli path inside an existing asar archive is accepted', JSON.stringify(packed.problems));
  check(packed.notes.some((note) => /asar/u.test(note)), 'the asar case is called out rather than silently trusted');
  const noArchive = buildCommand({ ...spec, dshCli: join(root, 'absent.asar', 'cli.js'), requireFiles: ['src/sum.mjs'] });
  check(noArchive.problems.some((problem) => /archive/u.test(problem)), 'a cli path inside a missing archive is refused');
  const plainMissing = buildCommand({ ...spec, dshCli: join(root, 'nope.js'), requireFiles: ['src/sum.mjs'] });
  check(plainMissing.problems.some((problem) => /--dsh-cli does not exist/u.test(problem)), 'a plain missing cli path is refused');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The command must fail closed when the caller passes something it does not know. The first
// version of main() returned a number while the happy path returned a promise, so an unknown
// flag crashed with "main(...).then is not a function" instead of a usage error. Checks call
// main() directly: spawning a child that redirects into this workspace is blocked by the
// sandbox anyway, and the defect lived in the return shape, not in the process plumbing.
{
  const pending = runCommandBuilder(['--not-a-flag', 'x']);
  check(typeof pending.then === 'function', 'the command builder returns a promise on the failure path');
  check((await pending) === 2, 'an unknown argument resolves to exit code 2');
}

console.log('v02-experiment-package: ' + checks + ' checks, ' + failures + ' failures');
if (failures > 0) process.exitCode = 1;
