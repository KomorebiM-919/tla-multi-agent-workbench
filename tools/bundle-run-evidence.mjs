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
import { parseReceipt, joinReceipts } from './lib/launch-receipts.mjs';

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
  // The upstream service run ID is not a gate/request run ID. Its actual
  // semantics are not frozen here, so no runId field may be promoted.
  'upstream-events': {}
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
  const receipts = [];
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
      if (role === 'upstream-events') {
        note('UPSTREAM_ID_SEMANTICS_UNSUPPORTED', artifactId, 'the upstream service runId is not assumed to be a gate/request run ID');
        continue;
      }
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
      let values;
      if (artifact.role === 'gate-summary') {
        values = [parseJsonBytes(bytes, artifact.id)];
      } else {
        try {
          values = parseJsonLines(bytes, artifact.id);
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.code === 'RUN_BEARER_EMPTY') values = [];
          else throw error;
        }
      }
      for (const value of values) collectRecord(value, artifact.role, artifact.id);
    } else if (artifact.role === 'launch-receipt') {
      try {
        const parsed = parseReceipt(parseJsonBytes(bytes, artifact.id));
        receipts.push({ artifactId: artifact.id, kind: parsed.kind, value: parsed.value });
      } catch (error) {
        note('LAUNCH_RECEIPT_INVALID', artifact.id, String(error instanceof Error ? error.message : error));
      }
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
    receipts,
    runnerRunId: single(observed.runner),
    gateRunId: gateId !== null && budgetId !== null && gateId !== budgetId ? null : gateId,
    budgetRunId: gateId !== null && budgetId !== null && gateId !== budgetId ? null : budgetId
  };
}

function evaluateReceiptJoin(observation, artifacts, independent, note) {
  const receipts = observation.receipts;
  const runners = receipts.filter((item) => item.kind === 'runner');
  const gates = receipts.filter((item) => item.kind === 'gate');
  if (runners.length === 0 && gates.length === 0) {
    note('LAUNCH_RECEIPT_MISSING', null, 'no launch receipt was selected');
    return { status: 'unproven', conflict: false };
  }
  if (runners.length > 1 || gates.length > 1) {
    note('RECEIPT_DUPLICATE', null, `runner receipts=${runners.length}, gate receipts=${gates.length}`);
    return { status: 'unproven', conflict: true };
  }
  if (runners.length !== 1 || gates.length !== 1) {
    note('RECEIPT_INCOMPLETE', null, `runner receipts=${runners.length}, gate receipts=${gates.length}`);
    return { status: 'unproven', conflict: false };
  }
  const runner = runners[0].value;
  const gate = gates[0].value;
  const joined = joinReceipts(runner, gate);
  for (const problem of joined.problems) {
    if (problem === 'RECEIPT_SIMULATED') {
      note(problem, null, 'simulated receipts exercise the validator but cannot establish a runtime binding');
    } else {
      note(problem, null, 'receipt fields or origin do not join');
    }
  }
  if (!joined.ok && !joined.problems.every((problem) => problem === 'RECEIPT_SIMULATED' || problem === 'RUNNER_RECEIPT_NOT_SPAWNED')) {
    return { status: 'unproven', conflict: true };
  }
  if (joined.problems.includes('RECEIPT_SIMULATED')) return { status: 'unproven', conflict: false };
  if (runner.state !== 'spawned') {
    note('RUNNER_RECEIPT_NOT_SPAWNED', null, 'the selected runner receipt did not observe a spawn');
    return { status: 'unproven', conflict: false };
  }
  for (const issue of independent.issues) note(issue.code, issue.artifactId, issue.detail);
  const conflict = independent.runner.conflict || independent.gate.conflict || independent.budget.conflict;
  if (conflict) return { status: 'unproven', conflict: true };
  if (independent.runner.id === null || independent.gate.id === null || independent.budget.id === null) {
    return { status: 'unproven', conflict: false };
  }
  if (independent.runner.id !== runner.runnerRunId) {
    note('RECEIPT_RUNNER_ID_MISMATCH', independent.runner.artifactId, 'runner summary does not match the receipt');
    return { status: 'unproven', conflict: true };
  }
  if (independent.gate.id !== gate.gateRunId) {
    note('RECEIPT_GATE_ID_MISMATCH', independent.gate.artifactId, 'gate summary does not match the receipt');
    return { status: 'unproven', conflict: true };
  }
  if (independent.budget.id !== gate.budgetRunId) {
    note('RECEIPT_BUDGET_ID_MISMATCH', independent.budget.artifactId, 'budget events do not match the receipt');
    return { status: 'unproven', conflict: true };
  }
  if (gate.gateRunId !== gate.budgetRunId) {
    note('GATE_BUDGET_ID_CONFLICT', null, 'gate and budget receipt identities differ');
    return { status: 'unproven', conflict: true };
  }
  if (independent.carriedBudget !== null && independent.carriedBudget !== independent.budget.id) {
    note('GATE_BUDGET_ID_CONFLICT', independent.gate.artifactId, 'gate summary budgetRunId differs from budget events');
    return { status: 'unproven', conflict: true };
  }
  return { status: 'consistent', conflict: false };
}

function idFromRecord(value, keys, label, artifactId, note) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    note('INDEPENDENT_ID_TYPE_INVALID', artifactId, `${label} must be an object`);
    return { value: null, conflict: false };
  }
  const present = [];
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      note('INDEPENDENT_ID_TYPE_INVALID', artifactId, `${label}.${key} must be a non-empty string`);
      continue;
    }
    present.push(value[key]);
  }
  const unique = [...new Set(present)];
  if (unique.length > 1) {
    note('INDEPENDENT_ID_CONFLICT', artifactId, `${label} has conflicting values: ${unique.join(',')}`);
    return { value: null, conflict: true };
  }
  return { value: unique.length === 0 ? null : unique[0], conflict: false };
}

/**
 * Read an identity from the role that is supposed to carry it. A global set is
 * not enough: an empty gate summary must not borrow a gate ID from gate-events,
 * and an empty budget log must not borrow one from the gate summary.
 */
function independentIds(artifacts, contents) {
  const note = (code, artifactId, detail) => ({ code, artifactId, detail });
  const issues = [];
  const result = {
    runner: { id: null, artifactId: null, conflict: false },
    gate: { id: null, artifactId: null, conflict: false },
    budget: { id: null, artifactId: null, conflict: false },
    carriedBudget: null,
    issues
  };
  const add = (issue) => issues.push(issue);
  const runnerArtifact = artifacts.find((item) => item.role === 'runner-summary');
  if (runnerArtifact === undefined) {
    add(note('INDEPENDENT_RUNNER_MISSING', null, 'runner summary is required to agree with the receipt'));
  } else {
    const value = parseJsonBytes(contents.get(runnerArtifact.id), runnerArtifact.id);
    const picked = idFromRecord(value, ['runId', 'runnerRunId'], 'runner summary', runnerArtifact.id, add);
    result.runner = { id: picked.value, artifactId: runnerArtifact.id, conflict: picked.conflict };
    if (picked.value === null && !picked.conflict) add(note('INDEPENDENT_RUNNER_ID_MISSING', runnerArtifact.id, 'runner summary has no valid runId'));
  }

  const gateArtifact = artifacts.find((item) => item.role === 'gate-summary');
  if (gateArtifact === undefined) {
    add(note('INDEPENDENT_GATE_MISSING', null, 'gate summary is required to agree with the receipt'));
  } else {
    const value = parseJsonBytes(contents.get(gateArtifact.id), gateArtifact.id);
    const picked = idFromRecord(value, ['runId', 'gateRunId'], 'gate summary', gateArtifact.id, add);
    result.gate = { id: picked.value, artifactId: gateArtifact.id, conflict: picked.conflict };
    if (picked.value === null && !picked.conflict) add(note('INDEPENDENT_GATE_ID_MISSING', gateArtifact.id, 'gate summary has no valid gate runId'));
    if (Object.hasOwn(value, 'budgetRunId')) {
      const carried = idFromRecord(value, ['budgetRunId'], 'gate summary budget', gateArtifact.id, add);
      result.carriedBudget = carried.value;
    }
  }

  const budgetArtifact = artifacts.find((item) => item.role === 'budget-events');
  if (budgetArtifact === undefined) {
    add(note('INDEPENDENT_BUDGET_MISSING', null, 'budget events are required to agree with the receipt'));
  } else {
    const values = [];
    for (const line of contents.get(budgetArtifact.id).toString('utf8').split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        fail('RUN_BEARER_JSON_INVALID', budgetArtifact.id);
      }
    }
    const ids = [];
    let conflict = false;
    if (values.length === 0) add(note('BUDGET_EVENTS_EMPTY', budgetArtifact.id, 'budget event stream is empty'));
    for (const value of values) {
      const picked = idFromRecord(value, ['runId', 'budgetRunId'], 'budget event', budgetArtifact.id, add);
      if (picked.conflict) conflict = true;
      if (picked.value !== null) ids.push(picked.value);
    }
    const unique = [...new Set(ids)];
    if (unique.length > 1) {
      conflict = true;
      add(note('INDEPENDENT_ID_CONFLICT', budgetArtifact.id, `budget events disagree: ${unique.join(',')}`));
    }
    result.budget = { id: unique.length === 1 ? unique[0] : null, artifactId: budgetArtifact.id, conflict };
    if (unique.length === 0 && !conflict) add(note('INDEPENDENT_BUDGET_ID_MISSING', budgetArtifact.id, 'budget events have no valid runId'));
  }

  return result;
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
    const noteIssue = (code, artifactId, detail) => issues.push({ code, artifactId, detail });
    verifyExpected(expected, observation.observed, issues);
    if (!artifacts.some((item) => item.role === 'runner-summary')) {
      issues.push(fatalIssue('RUNNER_SUMMARY_MISSING', null, 'a runner summary is required for an assembled inventory'));
    }
    const independent = independentIds(artifacts, contents);
    const receiptJoin = evaluateReceiptJoin(observation, artifacts, independent, noteIssue);
    if (receiptJoin.conflict) {
      issues.push(fatalIssue('RECEIPT_JOIN_INCONSISTENT', null, 'the selected receipts or role-specific independent identities conflict'));
    } else if (receiptJoin.status === 'unproven') {
      issues.push({ code: 'RUN_BINDING_UNPROVEN', artifactId: null, detail: 'the selected receipts do not establish a consistent runtime binding' });
    }
    const fatal = issues.some((issue) => ['RUNNER_SUMMARY_MISSING', 'RUNNER_ID_CONFLICT', 'GATE_ID_CONFLICT',
      'BUDGET_ID_CONFLICT', 'RUN_ID_CONFLICT', 'RUN_ID_FIELD_UNSUPPORTED', 'RUN_ID_TYPE_INVALID',
      'GATE_BUDGET_ID_CONFLICT', 'EXPECTED_ID_MISMATCH', 'RUN_BEARER_JSON_INVALID',
      'RUN_BEARER_EMPTY', 'LAUNCH_RECEIPT_INVALID', 'RECEIPT_JOIN_INCONSISTENT'].includes(issue.code));
    const manifest = {
      schema: BUNDLE_SCHEMA,
      scope: 'local-artifact-inventory',
      hostVerified: false,
      status: fatal ? 'INCOMPLETE' : 'ASSEMBLED',
      binding: {
        runnerRunId: independent.runner.id,
        gateRunId: independent.gate.id,
        budgetRunId: independent.budget.id ?? independent.carriedBudget,
        status: receiptJoin.status,
        evidenceRefs: [...new Set([...observation.evidenceRefs, ...observation.receipts.map((item) => item.artifactId)])]
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
