// Assemble an explicit, local run-artifact inventory. This is a byte-copy and
// hash inventory, not an observer and not an acceptance verdict.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ContractError,
  IoError,
  checkLocalPath,
  fields,
  fail,
  hashBytes,
  idValue,
  pathKey,
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
  const paths = new Map();
  const normalized = [];
  for (const artifact of artifacts) {
    fields(artifact, ['id', 'role', 'sourcePath', 'path'], 'selection artifact');
    idValue(artifact.id);
    if (!ROLES.includes(artifact.role)) fail('ROLE_INVALID', artifact.role);
    checkLocalPath(artifact.sourcePath);
    const bundlePath = relativePathValue(artifact.path, { reservedManifest: true });
    const key = pathKey(bundlePath);
    if (ids.has(artifact.id)) fail('ARTIFACT_ID_DUPLICATE', artifact.id);
    if (paths.has(key)) fail('ARTIFACT_PATH_DUPLICATE', bundlePath);
    ids.add(artifact.id);
    paths.set(key, bundlePath);
    normalized.push({ ...artifact, path: bundlePath, sourcePath: resolve(artifact.sourcePath) });
  }
  const keys = [...paths.keys()];
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      const a = keys[left];
      const b = keys[right];
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        fail('ARTIFACT_PATH_PREFIX_CONFLICT', `${paths.get(a)} <-> ${paths.get(b)}`);
      }
    }
  }
  return normalized;
}

function defaultPathSafetyProbe(path) {
  const result = spawnSync('fsutil', ['reparsepoint', 'query', path], { windowsHide: true });
  if (result.error || result.status === null) {
    fail('PATH_SAFETY_PROBE_UNAVAILABLE', `${path}: fsutil unavailable`);
  }
  const decode = (buffer) => {
    if (!buffer) return '';
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return utf8;
    }
  };
  const output = `${decode(result.stdout)}\n${decode(result.stderr)}`;
  if (/0x[0-9a-f]{8}/iu.test(output)) return { reparse: true };
  if (/not a reparse point|4390|重分析点|重解析点/iu.test(output)) return { reparse: false };
  fail('PATH_SAFETY_PROBE_UNAVAILABLE', `${path}: fsutil result was not interpretable`);
}

function checkExistingPath(path, label, probe) {
  let info;
  let followed;
  try {
    info = lstatSync(path);
    followed = statSync(path);
  } catch (error) {
    throw new IoError('PATH_UNREADABLE', `${label}: ${path}: ${error.code ?? error.message}`);
  }
  if (info.isSymbolicLink()) fail('PATH_ANCESTOR_LINK', `${label}: ${path}`);
  let real;
  try {
    real = realpathSync(path);
  } catch (error) {
    throw new IoError('PATH_UNREADABLE', `${label}: ${path}: ${error.code ?? error.message}`);
  }
  if (pathKey(resolve(real)) !== pathKey(resolve(path))) {
    fail('PATH_ANCESTOR_REPARSE', `${label}: ${path} (realpath differs)`);
  }
  if (pathKey(resolve(path)) === pathKey(parse(path).root)) return;
  const observed = probe(path);
  if (observed.reparse) fail('PATH_ANCESTOR_REPARSE', `${label}: ${path} (reparse point)`);
}

function checkPathAncestors(target, label, probe) {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = dirname(absolute);
  const seen = [];
  while (true) {
    if (existsSync(current)) seen.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of seen.reverse()) checkExistingPath(path, label, probe);
}

function assertSourcePathsSafe(artifacts, probe) {
  for (const artifact of artifacts) {
    checkPathAncestors(artifact.sourcePath, `source ${artifact.id}`, probe);
    if (!existsSync(artifact.sourcePath)) fail('SOURCE_MISSING', artifact.id);
    checkExistingPath(artifact.sourcePath, `source ${artifact.id}`, probe);
  }
}

function assertOutputPathSafe(out, probe) {
  let info;
  try {
    info = lstatSync(out);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new IoError('OUTPUT_UNREADABLE', `${out}: ${error.code ?? error.message}`);
    info = null;
  }
  if (info !== null) fail('OUTPUT_EXISTS', out);
  const parent = dirname(out);
  if (!existsSync(parent)) fail('OUTPUT_PARENT_MISSING', parent);
  checkPathAncestors(parent, 'output parent', probe);
  checkExistingPath(parent, 'output parent', probe);
}

function verifyArtifactFiles(out, artifacts, contents, includeManifest = false) {
  const expected = new Map();
  for (const artifact of artifacts) {
    const bytes = contents.get(artifact.id);
    const target = join(out, ...artifact.path.split('/'));
    let actual;
    try {
      actual = readFileSync(target);
    } catch (error) {
      throw new IoError('FINAL_ARTIFACT_UNREADABLE', `${artifact.id}: ${error.code ?? error.message}`);
    }
    const expectedHash = hashBytes(bytes);
    if (actual.length !== bytes.length || hashBytes(actual) !== expectedHash) {
      fail('FINAL_ARTIFACT_MISMATCH', artifact.id);
    }
    expected.set(pathKey(artifact.path), true);
  }
  if (includeManifest) expected.set(pathKey(MANIFEST_NAME), true);
  const extras = [];
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (!entry.isFile()) fail('FINAL_OUTPUT_NOT_REGULAR', relative);
      else if (!expected.has(pathKey(relative))) extras.push(relative);
    }
  };
  walk(out);
  if (extras.length !== 0) fail('FINAL_UNEXPECTED_OUTPUT', extras.join(','));
}


const ID_FIELDS = new Set(['runId', 'runnerRunId', 'gateRunId', 'budgetRunId']);
const ROLE_ID_SPECS = {
  'runner-summary': { runner: ['runId', 'runnerRunId'] },
  'gate-summary': { run: ['runId', 'gateRunId', 'budgetRunId'], gate: ['runId', 'gateRunId'], budget: ['budgetRunId'] },
  'gate-events': { run: ['runId', 'gateRunId', 'budgetRunId'], gate: ['runId', 'gateRunId'], budget: ['budgetRunId'] },
  'budget-events': { run: ['runId', 'budgetRunId', 'gateRunId'], gate: ['gateRunId'], budget: ['runId', 'budgetRunId'] },
  'upstream-events': { run: ['runId', 'gateRunId', 'budgetRunId'], gate: ['runId', 'gateRunId'], budget: ['budgetRunId'] }
};

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
  const observed = { runner: new Set(), run: new Set(), gate: new Set(), budget: new Set() };
  const evidence = new Map();
  const issues = [];
  const issueKeys = new Set();
  const note = (code, artifactId, detail) => {
    const key = `${code}|${artifactId}|${detail}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ code, artifactId, detail });
  };
  const add = (kind, id, artifactId) => {
    if (id !== null) {
      observed[kind].add(id);
      if (!evidence.has(kind)) evidence.set(kind, []);
      evidence.get(kind).push(artifactId);
    }
  };

  const collectRecord = (value, role, artifactId) => {
    if (!plainObject(value)) fail('RUN_BEARER_JSON_INVALID', artifactId);
    const spec = ROLE_ID_SPECS[role];
    if (!spec) return;
    const allowed = new Set(Object.values(spec).flat());
    const record = new Map();
    for (const key of Object.keys(value)) {
      if (!ID_FIELDS.has(key)) continue;
      if (!allowed.has(key)) {
        note('RUN_ID_FIELD_UNSUPPORTED', artifactId, `${role} does not define ${key}`);
        continue;
      }
      if (typeof value[key] !== 'string' || value[key].trim() === '') {
        note('RUN_ID_TYPE_INVALID', artifactId, `${key} must be a non-empty string`);
        continue;
      }
      for (const [kind, keys] of Object.entries(spec)) {
        if (!keys.includes(key)) continue;
        if (!record.has(kind)) record.set(kind, new Set());
        record.get(kind).add(value[key]);
      }
    }
    for (const [kind, values] of record) {
      if (values.size > 1) {
        note(kind === 'runner' ? 'RUNNER_ID_CONFLICT' : 'RUN_ID_CONFLICT', artifactId, `${kind} values: ${[...values].join(',')}`);
      }
      for (const id of values) add(kind, id, artifactId);
    }
    const runnerId = record.get('runner');
    if (runnerId && runnerId.size === 1) add('runner', [...runnerId][0], artifactId);
  };

  for (const artifact of artifacts) {
    const bytes = contents.get(artifact.id);
    if (artifact.role === 'runner-summary') {
      const value = parseJsonBytes(bytes, artifact.id);
      collectRecord(value, artifact.role, artifact.id);
      if (![...ROLE_ID_SPECS[artifact.role].runner].some((key) => Object.hasOwn(value, key))) {
        note('RUNNER_ID_UNKNOWN', artifact.id, 'runner summary has no explicit runId');
      }
    } else if (artifact.role === 'gate-summary' || artifact.role === 'gate-events' ||
        artifact.role === 'budget-events' || artifact.role === 'upstream-events') {
      const values = artifact.role === 'gate-summary' ? [parseJsonBytes(bytes, artifact.id)] : parseJsonLines(bytes, artifact.id);
      for (const value of values) collectRecord(value, artifact.role, artifact.id);
    } else if (artifact.role === 'launch-receipt') {
      note('LAUNCH_RECEIPT_FORMAT_UNSUPPORTED', artifact.id, 'Phase A has no receipt parser; it cannot establish a parent-child mapping');
    } else if (artifact.role === 'observer-events') {
      note('OBSERVER_SCHEMA_UNSPECIFIED', artifact.id, 'observer event schema is not defined in Phase A');
    }
  }

  for (const [kind, values] of Object.entries(observed)) {
    if (values.size > 1) {
      const code = kind === 'runner' ? 'RUNNER_ID_CONFLICT' : kind === 'run' ? 'RUN_ID_CONFLICT' :
        `${kind.toUpperCase()}_ID_CONFLICT`;
      note(code, null, [...values].join(','));
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
  const pathSafetyProbe = options.pathSafetyProbe ?? defaultPathSafetyProbe;
  assertSourcePathsSafe(artifacts, pathSafetyProbe);
  assertOutputPathSafe(out, pathSafetyProbe);
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
    verifyArtifactFiles(out, artifacts, contents, false);

    const observation = observeRunIds(artifacts, contents);
    const issues = [...observation.issues];
    verifyExpected(expected, observation.observed, issues);
    if (!artifacts.some((item) => item.role === 'runner-summary')) {
      issues.push(fatalIssue('RUNNER_SUMMARY_MISSING', null, 'a runner summary is required for an assembled inventory'));
    }
    issues.push({ code: 'RUN_BINDING_UNPROVEN', artifactId: null, detail: 'Phase A cannot prove the runner-child mapping without an explicit launch receipt' });
    const fatal = issues.some((issue) => ['RUNNER_SUMMARY_MISSING', 'RUNNER_ID_CONFLICT', 'GATE_ID_CONFLICT',
      'BUDGET_ID_CONFLICT', 'RUN_ID_CONFLICT', 'RUN_ID_FIELD_UNSUPPORTED', 'RUN_ID_TYPE_INVALID',
      'GATE_BUDGET_ID_CONFLICT', 'EXPECTED_ID_MISMATCH', 'RUN_BEARER_JSON_INVALID',
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
    const manifestPath = join(out, MANIFEST_NAME);
    writeFileSync(manifestPath, serialized);
    const writtenManifest = readFileSync(manifestPath, 'utf8');
    if (writtenManifest !== serialized) fail('FINAL_MANIFEST_MISMATCH');
    verifyArtifactFiles(out, artifacts, contents, true);
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

export function main(argv = process.argv.slice(2), io = process, runtimeOptions = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  try {
    const { value: selection } = readJsonFile(options.selection);
    const result = assembleBundle(selection, {
      out: options.out,
      expected: options.expected,
      pathSafetyProbe: runtimeOptions.pathSafetyProbe
    });
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
