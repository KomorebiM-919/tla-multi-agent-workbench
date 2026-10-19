// Offline checks for docs/V0.2-NEXT-EXPERIMENT.md and tools/experiment-command.mjs.
//
// The package is the thing a reviewer approves before a host run, so the documented
// command has to be the command the launcher actually accepts. Documentation strings
// are checked against the launcher's own parseArgs and against the fake model's real
// flags; nothing here starts a process, opens a socket, or touches the network.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseLauncherArgs, buildInvocation, UsageError } from '../tools/gated-run.mjs';
import { buildCommand, ensureOverlayFile, inspectionInputFor, PLACEHOLDER_PATTERN, REPORTED_FLAGS, runCommandBuilder, supervisorSpecFor } from '../tools/experiment-command.mjs';
import { renderOverlay } from '../tools/overlay-template.mjs';
import { validateSpec } from '../tools/experiment-runner.mjs';

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

// Pull the command block that invokes one tool, drop the bash line continuations, and split it
// the way a shell would.
function commandBlock(text, pattern) {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => pattern.test(line));
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

const block = commandBlock(DOC, /node\s+tools\/experiment-command\.mjs/u);
const supervised = commandBlock(DOC, /node\s+tools\/experiment-runner\.mjs/u);

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
  ['<source sha>', '45b6540e61c2bf0da477a0b7009fc4b8e1640023'],
  ['<fixtures sha>', '509067753c29af2d37c794acb0a89fc850e9e2ff'],
]);
function filled(value) {
  let result = value;
  for (const [placeholder, replacement] of SUBSTITUTIONS) result = result.split(placeholder).join(replacement);
  return result;
}

check(block.args.length > 0, 'the package contains the command builder invocation');
const filledArgs = block.args.map(filled);
const leftover = filledArgs.filter((value) => PLACEHOLDER_PATTERN.test(value));
check(leftover.length === 0, 'every placeholder in the command has a documented substitution', JSON.stringify(leftover));

const valueOf = (args, flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

// 1. The documented generator invocation carries the whole experiment, and the only command that
//    needs an escalation is the supervisor one: it starts the fake upstream, waits for it, starts
//    the protected host, watches both and tears both down.
check(valueOf(filledArgs, '--model-requests') === '40', 'the documented budget is the approved 40', String(valueOf(filledArgs, '--model-requests')));
check(valueOf(filledArgs, '--gate-port') === '18921', 'the documented gate port is 18921', String(valueOf(filledArgs, '--gate-port')));
check(valueOf(filledArgs, '--upstream-port') === '18920', 'the documented upstream port is 18920', String(valueOf(filledArgs, '--upstream-port')));
check((valueOf(filledArgs, '--profile') ?? '') === 'stage1', 'the command uses the isolated profile', String(valueOf(filledArgs, '--profile')));
check(valueOf(filledArgs, '--dsh-exe') !== undefined && valueOf(filledArgs, '--dsh-cli') !== undefined, 'the command passes the host executable and cli it validates');
const requireFiles = filledArgs.filter((_value, index) => filledArgs[index - 1] === '--require-file');
check(requireFiles.length === 3, 'the command requires every project file the run reads', JSON.stringify(requireFiles));
check(typeof valueOf(filledArgs, '--prompt') === 'string' && valueOf(filledArgs, '--prompt').length > 0, 'the command carries the captain prompt');
check((valueOf(filledArgs, '--dsh-home') ?? '').includes('dshhome'), 'the command carries the isolated DSH_HOME', String(valueOf(filledArgs, '--dsh-home')));
check((valueOf(filledArgs, '--fake-server') ?? '').endsWith('fake-model-server.mjs'), 'the command names the local fake upstream', String(valueOf(filledArgs, '--fake-server')));
check((valueOf(filledArgs, '--policy') ?? '').endsWith('policy.v3.json'), 'the command names the reactive policy', String(valueOf(filledArgs, '--policy')));
check(valueOf(filledArgs, '--pin-source') !== undefined && valueOf(filledArgs, '--pin-fixtures') !== undefined, 'the command pins the executing source and the fixtures');
check(supervised.args.length > 0, 'the package contains the one supervised command');
check((valueOf(supervised.args, '--spec') ?? '').endsWith('experiment-spec.json'), 'the supervised command takes the generated spec', String(valueOf(supervised.args, '--spec')));
check(/supervised command|监督器/u.test(DOC), 'the package states that the supervisor owns the whole run');

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
check(SHAS.includes('509067753c29af2d37c794acb0a89fc850e9e2ff'), 'the frozen fixture revision is still the one that replays offline');

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

// 6. The fake model is started by the supervisor, never by a hand-typed command, and the
//    implementation still recognises the flags the spec passes to it.
check(!/^\s*node\s+tests\/\.scratch\S*fake-model-server\.mjs/mu.test(DOC), 'the package does not tell a human to start the fake model by hand');
if (existsSync(FAKE_SERVER)) {
  const source = readFileSync(FAKE_SERVER, 'utf8');
  for (const flag of ['--port', '--policy', '--run-id', '--body-dir']) {
    check(source.includes("'" + flag + "'"), 'the fake model implementation recognises ' + flag);
  }
} else {
  check(/不入库|本地实验台|local harness/u.test(DOC), 'the package marks the fake model as a local (unversioned) harness');
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
  // The isolated home must be part of the command and of the child environment, not something
  // the surrounding shell is expected to export. Without this the config probe resolved the
  // default profile and failed with 'profile "stage1" does not exist' — a pre-flight error that
  // said nothing about the experiment.
  const homeSpec = { ...spec, dshHome: join(root, 'isolated-home') };
  const built = buildCommand(homeSpec);
  const homeFlag = built.argv.indexOf('--dsh-home');
  check(homeFlag >= 0 && built.argv[homeFlag + 1] === homeSpec.dshHome, 'the command carries --dsh-home');
  const invocation = buildInvocation(
    {
      dshExe: spec.dshExe,
      dshCli: spec.dshCli,
      dshHome: homeSpec.dshHome,
      profile: spec.profile,
      patches: [],
      runId: 'tla-run-test',
      projectCwd: spec.projectCwd
    },
    ['--dump-config']
  );
  check(invocation.env.DSH_HOME === homeSpec.dshHome, 'the child process receives DSH_HOME');
  check(invocation.args.includes('--dsh-home') === false, 'the launcher flag is not forwarded to the DSH CLI itself');

  // The config probe has to inspect the same overlay the launcher will apply. Reading the wrong
  // field name silently inspected the bare profile instead.
  const inspectionInput = inspectionInputFor(spec, runDir);
  check(
    inspectionInput.patches.length === 1 && inspectionInput.patches[0] === spec.overlay,
    'the config probe receives the overlay the command carries'
  );
  check(
    built.argv.includes(spec.overlay),
    'the same overlay string appears in the launcher command'
  );

  // One supervised command per experiment: the spec carries the ports, the run id inputs, the
  // project, the log directory and the budget, so none of them is typed twice by hand.
  const policy = join(ROOT, 'tests', 'fixtures', 'repair-loop-policy.v2.json');
  const standinFake = join(root, 'fake-server.mjs');
  writeFileSync(standinFake, '// stand-in for the local fake upstream\n');
  const supSpec = supervisorSpecFor({
    ...spec,
    profile: 'stage1',
    requireFiles: ['src/sum.mjs'],
    fakeServerPath: standinFake,
    policyPath: policy,
    runDir: join(root, 'run-supervised')
  });
  check(supSpec.schema === 'tla.experiment-spec/v1', 'the supervisor spec declares its schema', supSpec.schema);
  check(supSpec.profile === 'stage1', 'the supervisor spec names the isolated profile', String(supSpec.profile));
  check(supSpec.gatePort === spec.gatePort && supSpec.upstreamPort === spec.upstreamPort, 'the supervisor spec carries both ports');
  check(supSpec.modelRequests === 40, 'the supervisor spec carries the budget', String(supSpec.modelRequests));
  check(supSpec.fakeKeyEnv === 'TLA_STAGE2_FAKE_KEY' && supSpec.fakeKeyValue === 'stage2-fake-key', 'the supervisor spec pins a dedicated fake credential');
  check(supSpec.projectCwd === resolve(spec.projectCwd), 'the supervisor spec pins the project working directory');
  check(typeof supSpec.repoRoot === 'string' && supSpec.repoRoot.length > 0, 'the supervisor spec names the checkout it will be proven against', String(supSpec.repoRoot));
  const pinnedSpec = supervisorSpecFor({
    ...spec,
    profile: 'stage1',
    requireFiles: ['src/sum.mjs'],
    fakeServerPath: standinFake,
    policyPath: policy,
    runDir: join(root, 'run-pinned'),
    pinned: { sourceSha: 'a'.repeat(40), fixturesSha: 'b'.repeat(40) }
  });
  check(pinnedSpec.requirePinned === true, 'a pinned spec requires the provenance check');
  check(pinnedSpec.pinned.sourceSha === 'a'.repeat(40) && pinnedSpec.pinned.fixturesSha === 'b'.repeat(40), 'both pinned revisions reach the supervisor');
  check(supervisorSpecFor({ ...spec, requireFiles: [], runDir: join(root, 'run-unpinned') }).requirePinned === false, 'an unpinned spec does not claim a pin');
  validateSpec(supSpec);
  check(true, 'the emitted supervisor spec passes the runner validator');

  // Supervised shape: the runner renders the overlay it will pass to the launcher, so the
  // operator must not be forced to write a second copy that could drift from the executed one.
  const supervisedBuild = buildCommand({
    ...spec,
    overlay: undefined,
    fakeServerPath: standinFake,
    policyPath: policy,
    requireFiles: ['src/sum.mjs'],
    runDir: join(root, 'run-supervised')
  });
  check(supervisedBuild.problems.length === 0, 'a supervised spec needs no hand-written overlay', JSON.stringify(supervisedBuild.problems));
  check(supervisedBuild.notes.some((note) => /--overlay is optional/u.test(note)), 'the builder says the overlay is rendered by the runner');
  const renderedPath = join(root, 'overlay-rendered.patch.yml');
  const withRendered = buildCommand(
    { ...spec, overlay: undefined, fakeServerPath: standinFake, policyPath: policy, requireFiles: ['src/sum.mjs'] },
    { overlayPath: renderedPath }
  );
  const patchFlag = withRendered.argv.indexOf('--patch');
  check(patchFlag >= 0 && withRendered.argv[patchFlag + 1] === renderedPath, 'the built command carries the overlay the pre-flight inspected');
  const unsupervised = buildCommand({ ...spec, overlay: undefined, fakeServerPath: undefined, policyPath: undefined });
  check(unsupervised.problems.some((problem) => /--overlay is required/u.test(problem)), 'an unsupervised spec still requires an overlay');

  // The runner resolves its harness paths against its own working directory, so the emitted
  // spec must carry absolute paths; a relative one would name a different file when the
  // supervisor is started from elsewhere.
  const relativeSup = supervisorSpecFor({
    ...spec,
    fakeServerPath: relative(process.cwd(), standinFake),
    policyPath: relative(process.cwd(), policy),
    requireFiles: ['src/sum.mjs'],
    runDir: join(root, 'run-relative')
  });
  check(isAbsolute(relativeSup.fakeServerPath) && relativeSup.fakeServerPath === resolve(standinFake), 'the supervisor spec makes the fake upstream path absolute');
  check(isAbsolute(relativeSup.policyPath) && relativeSup.policyPath === resolve(policy), 'the supervisor spec makes the policy path absolute');

  const rendered = ensureOverlayFile(
    { ...spec, overlay: undefined, runDir: join(root, 'run-supervised'), requireFiles: ['src/sum.mjs'] },
    join(root, 'run-supervised')
  );
  const expectedOverlay = renderOverlay({
    gateUrl: 'http://127.0.0.1:' + String(spec.gatePort),
    runDir: join(root, 'run-supervised'),
    modelRequests: 40
  });
  check(readFileSync(rendered, 'utf8') === expectedOverlay, 'the inspected overlay is the one the runner renders');
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
