// Assemble an explicit, local run-artifact inventory. This is a byte-copy and
// hash inventory, not an observer and not an acceptance verdict.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ContractError,
  IoError,
  checkLocalPath,
  fields,
  fail,
  hashBytes,
  idValue,
  plainObject,
  readJsonFile,
  readStableSource,
  relativePathValue,
  validateArrayLimit
} from './lib/evidence-contracts.mjs';

export const BUNDLE_SCHEMA = 'tla.run-evidence-bundle/v1';
export const ROLES = Object.freeze([
  'runner-summary',
  'launch-receipt',
  'gate-summary',
  'gate-events',
  'budget-events',
  'upstream-events',
  'observer-events',
  'capture-capabilities'
]);
export const LIMITS = Object.freeze({
  artifacts: 32,
  artifactBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  manifestBytes: 1024 * 1024
});
const MANIFEST_NAME = 'manifest.json';
const RUN_BEARING = new Set(['runner-summary', 'gate-summary', 'gate-events', 'budget-events', 'upstream-events']);

function validateSelection(selection) {
  fields(selection, ['artifacts'], 'selection');
  const artifacts = validateArrayLimit(selection.artifacts, LIMITS.artifacts, 'ARTIFACT_LIMIT');
  const ids = new Set();
  const paths = new Set();
  const normalized = [];
  for (const artifact of artifacts) {
    fields(artifact, ['id', 'role', 'sourcePath', 'path'], 'selection artifact');
    idValue(artifact.id);
    if (!ROLES.includes(artifact.role)) fail('ROLE_INVALID', artifact.role);
    checkLocalPath(artifact.sourcePath);
    const bundlePath = relativePathValue(artifact.path, { reservedManifest: true });
    const pathKey = bundlePath.toLowerCase();
    if (ids.has(artifact.id)) fail('ARTIFACT_ID_DUPLICATE', artifact.id);
    if (paths.has(pathKey)) fail('ARTIFACT_PATH_DUPLICATE', bundlePath);
    ids.add(artifact.id);
    paths.add(pathKey);
    normalized.push({ ...artifact, path: bundlePath, sourcePath: resolve(artifact.sourcePath) });
  }
  return normalized;
}

function readRunId(value, label) {
  if (!plainObject(value)) fail('RUN_BEARER_JSON_INVALID', label);
  for (const key of ['runId', 'runnerRunId', 'gateRunId', 'budgetRunId']) {
    if (Object.hasOwn(value, key) && typeof value[key] === 'string' && value[key] !== '') return value[key];
  }
  return null;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('RUN_BEARER_JSON_INVALID', label);
  }
}

function parseJsonLines(bytes, label) {
  const values = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      fail('RUN_BEARER_JSON_INVALID', label);
    }
  }
  if (values.length === 0) fail('RUN_BEARER_EMPTY', label);
  return values;
}

function observeRunIds(artifacts, contents) {
  const observed = { runner: new Set(), gate: new Set(), budget: new Set() };
  const evidence = new Map();
  const issues = [];
  const note = (code, artifactId, detail) => issues.push({ code, artifactId, detail });
  const add = (kind, id, artifactId) => {
    if (id !== null) {
      observed[kind].add(id);
      if (!evidence.has(kind)) evidence.set(kind, []);
      evidence.get(kind).push(artifactId);
    }
  };

  for (const artifact of artifacts) {
    const bytes = contents.get(artifact.id);
    if (artifact.role === 'runner-summary') {
      const value = parseJsonBytes(bytes, artifact.id);
      const runId = readRunId(value, artifact.id);
      if (runId === null) note('RUNNER_ID_UNKNOWN', artifact.id, 'runner summary has no explicit runId');
      add('runner', runId, artifact.id);
    } else if (artifact.role === 'gate-summary') {
      const value = parseJsonBytes(bytes, artifact.id);
      const runId = readRunId(value, artifact.id);
      if (runId === null) note('GATE_ID_UNKNOWN', artifact.id, 'gate summary has no explicit runId');
      add('gate', runId, artifact.id);
      const budgetId = plainObject(value) && typeof value.budgetRunId === 'string' ? value.budgetRunId : null;
      add('budget', budgetId, artifact.id);
    } else if (artifact.role === 'budget-events' || artifact.role === 'gate-events' || artifact.role === 'upstream-events') {
      for (const value of parseJsonLines(bytes, artifact.id)) {
        const runId = readRunId(value, artifact.id);
        if (runId !== null) {
          add(artifact.role === 'budget-events' ? 'budget' : 'gate', runId, artifact.id);
        }
      }
    } else if (artifact.role === 'launch-receipt') {
      note('LAUNCH_RECEIPT_FORMAT_UNSUPPORTED', artifact.id, 'Phase A has no receipt parser; it cannot establish a parent-child mapping');
    } else if (artifact.role === 'observer-events') {
      note('OBSERVER_SCHEMA_UNSPECIFIED', artifact.id, 'observer event schema is not defined in Phase A');
    }
  }

  for (const [kind, values] of Object.entries(observed)) {
    if (values.size > 1) {
      note(`${kind.toUpperCase()}_ID_CONFLICT`, null, [...values].join(','));
    }
  }
  if (observed.gate.size > 0 && observed.budget.size > 0 &&
      [...observed.gate].some((value) => !observed.budget.has(value))) {
    note('GATE_BUDGET_ID_CONFLICT', null, 'gate and budget IDs do not match');
  }
  if (!artifacts.some((item) => item.role === 'launch-receipt')) {
    note('LAUNCH_RECEIPT_MISSING', null, 'no receipt independently joins runner and child/gate identity');
  }
  if (!artifacts.some((item) => item.role === 'observer-events')) {
    note('OBSERVER_EVIDENCE_MISSING', null, 'no observer event artifact was selected');
  }
  const single = (set) => (set.size === 1 ? [...set][0] : null);
  const gateId = single(observed.gate);
  const budgetId = single(observed.budget);
  return {
    observed,
    evidenceRefs: [...new Set([...evidence.values()].flat())],
    issues,
    runnerRunId: single(observed.runner),
    gateRunId: gateId !== null && budgetId !== null && gateId !== budgetId ? null : gateId,
    budgetRunId: gateId !== null && budgetId !== null && gateId !== budgetId ? null : budgetId
  };
}

function fatalIssue(code, artifactId, detail) {
  return { code, artifactId, detail };
}

function verifyExpected(expected, observed, issues) {
  for (const [kind, expectedId] of Object.entries(expected)) {
    if (expectedId === null) continue;
    const values = observed[kind];
    if (values.size === 0) {
      issues.push(fatalIssue('EXPECTED_ID_UNOBSERVED', null, `${kind} expected ID was not observed; it was not used as evidence`));
    } else if (values.size === 1 && !values.has(expectedId)) {
      issues.push(fatalIssue('EXPECTED_ID_MISMATCH', null, `${kind} expected ID does not match the observed value`));
    }
  }
}

function cleanupOutput(out) {
  try {
    rmSync(out, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `${error.code ?? error.message}`;
  }
}

export function assembleBundle(selection, options = {}) {
  const artifacts = validateSelection(selection);
  const out = resolve(options.out);
  if (existsSync(out)) fail('OUTPUT_EXISTS', out);
  const removeOutput = options.removeOutput ?? cleanupOutput;
  const expected = {
    runner: options.expected?.runner ?? null,
    gate: options.expected?.gate ?? null,
    budget: options.expected?.budget ?? null
  };
  const contents = new Map();
  let totalBytes = 0;
  const hooks = options.hooks ?? {};
  try {
    mkdirSync(out);
    for (const artifact of artifacts) {
      const source = readStableSource(artifact.sourcePath, LIMITS.artifactBytes);
      totalBytes += source.bytes.length;
      if (totalBytes > LIMITS.totalBytes) fail('TOTAL_BYTES_LIMIT', `${totalBytes} > ${LIMITS.totalBytes}`);
      const target = join(out, ...artifact.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      hooks.beforeCopy?.(artifact, artifact.sourcePath);
      writeFileSync(target, source.bytes);
      hooks.afterCopy?.(artifact, target);
      const copied = readFileSync(target);
      if (copied.length !== source.bytes.length || hashBytes(copied) !== source.sha256) {
        fail('COPIED_BYTES_MISMATCH', artifact.id);
      }
      const after = readStableSource(artifact.sourcePath, LIMITS.artifactBytes);
      if (after.sha256 !== source.sha256) fail('SOURCE_CHANGED_DURING_CAPTURE', artifact.id);
      contents.set(artifact.id, source.bytes);
    }

    const observation = observeRunIds(artifacts, contents);
    const issues = [...observation.issues];
    verifyExpected(expected, observation.observed, issues);
    if (!artifacts.some((item) => item.role === 'runner-summary')) {
      issues.push(fatalIssue('RUNNER_SUMMARY_MISSING', null, 'a runner summary is required for an assembled inventory'));
    }
    issues.push({ code: 'RUN_BINDING_UNPROVEN', artifactId: null, detail: 'Phase A cannot prove the runner-child mapping without an explicit launch receipt' });
    const fatal = issues.some((issue) => ['RUNNER_SUMMARY_MISSING', 'RUNNER_ID_CONFLICT', 'GATE_ID_CONFLICT',
      'BUDGET_ID_CONFLICT', 'GATE_BUDGET_ID_CONFLICT', 'EXPECTED_ID_MISMATCH', 'RUN_BEARER_JSON_INVALID',
      'RUN_BEARER_EMPTY'].includes(issue.code));
    const manifest = {
      schema: BUNDLE_SCHEMA,
      scope: 'local-artifact-inventory',
      hostVerified: false,
      status: fatal ? 'INCOMPLETE' : 'ASSEMBLED',
      binding: {
        runnerRunId: observation.runnerRunId,
        gateRunId: observation.gateRunId,
        budgetRunId: observation.budgetRunId,
        status: 'unproven',
        evidenceRefs: observation.evidenceRefs
      },
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        role: artifact.role,
        path: artifact.path,
        bytes: contents.get(artifact.id).length,
        sha256: hashBytes(contents.get(artifact.id))
      })),
      issues
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > LIMITS.manifestBytes) {
      fail('MANIFEST_TOO_LARGE', `${Buffer.byteLength(serialized, 'utf8')} > ${LIMITS.manifestBytes}`);
    }
    writeFileSync(join(out, MANIFEST_NAME), serialized);
    return { manifest, exitCode: manifest.status === 'ASSEMBLED' ? 0 : 2 };
  } catch (error) {
    const cleanup = removeOutput(out);
    if (cleanup) throw new IoError('ASSEMBLY_CLEANUP_FAILED', `${error.message}; cleanup failed: ${cleanup}`);
    throw error;
  }
}

function parseArgs(argv) {
  const options = { selection: null, out: null, expected: null, json: false };
  const expected = { runner: null, gate: null, budget: null };
  let expectedSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { options.json = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) fail('CLI_USAGE', `${arg} needs a value`, 'cli');
    if (arg === '--selection') options.selection = value;
    else if (arg === '--out') options.out = value;
    else if (arg === '--expected-runner' || arg === '--expected-gate' || arg === '--expected-budget') {
      expectedSeen = true;
      const kind = arg.slice('--expected-'.length);
      idValue(value, 'EXPECTED_ID_INVALID');
      if (expected[kind] !== null) fail('CLI_DUPLICATE_EXPECTED', kind, 'cli');
      expected[kind] = value;
    } else fail('CLI_USAGE', `unknown argument ${arg}`, 'cli');
    index += 1;
  }
  if (!options.selection) fail('CLI_USAGE', '--selection is required', 'cli');
  if (!options.out) fail('CLI_USAGE', '--out is required', 'cli');
  options.expected = expectedSeen ? expected : null;
  return options;
}

function publicSummary(manifest) {
  return {
    schema: manifest.schema,
    scope: manifest.scope,
    hostVerified: false,
    status: manifest.status,
    artifacts: manifest.artifacts.length,
    issues: manifest.issues.length,
    bindingStatus: manifest.binding.status
  };
}

export function main(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  try {
    const { value: selection } = readJsonFile(options.selection);
    const result = assembleBundle(selection, { out: options.out, expected: options.expected });
    if (options.json) io.stdout.write(`${JSON.stringify(publicSummary(result.manifest))}\n`);
    else io.stdout.write(`bundle ${result.manifest.status}: artifacts=${result.manifest.artifacts.length} issues=${result.manifest.issues.length} binding=${result.manifest.binding.status}\n`);
    return result.exitCode;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    if (error instanceof IoError) return 1;
    if (error instanceof ContractError) return error.kind === 'cli' ? 1 : 2;
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
