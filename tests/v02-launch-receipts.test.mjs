// Validator and bundle-join tests for B0 launch receipts. All records here are
// invented validation data; they are not live provenance.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBundle } from '../tools/bundle-run-evidence.mjs';
import { parseArgs as parseGateArgs } from '../tools/gated-run.mjs';
import { supervisorSpecFor } from '../tools/experiment-command.mjs';import {
  gateReceipt,
  invocationDigest,
  joinReceipts,
  newLaunchId,
  parseReceipt,
  runnerReceipt,
  validateGateReceipt,
  validateRunnerReceipt
} from '../tools/lib/launch-receipts.mjs';

mkdirSync('tests/.scratch', { recursive: true });
const root = mkdtempSync(join(process.cwd(), 'tests/.scratch/b0-receipts-'));
const out = join(root, 'out');
const launchId = newLaunchId();
const digest = invocationDigest('node', ['gated-run.mjs']);
const runner = runnerReceipt({
  runnerRunId: 'exp-test',
  launchId,
  state: 'spawned',
  launcherPid: 1234,
  command: 'node',
  args: ['gated-run.mjs']
});
const gate = {
  ...gateReceipt({
    runnerRunId: 'exp-test',
    launchId,
    gateRunId: 'tla-test',
    budgetRunId: 'tla-test',
    command: 'node',
    args: ['gated-run.mjs']
  }),
  launcherPid: 1234
};

function material(name, value) {
  const path = join(root, name);
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

function assertIssueShape(issues) {
  for (const issue of issues) {
    assert.equal(typeof issue.code, 'string');
    assert.ok(issue.code.length > 0);
    assert.equal(typeof issue.detail, 'string');
    assert.ok(issue.detail.length > 0);
    assert.ok(issue.artifactId === null || typeof issue.artifactId === 'string');
  }
}

function selection(extra = {}) {
  return {
    artifacts: [
      { id: 'runner-summary', role: 'runner-summary', sourcePath: material('runner.json', { runId: 'exp-test' }), path: 'runner.json' },
      { id: 'runner-receipt', role: 'launch-receipt', sourcePath: material('runner-receipt.json', runner), path: 'runner-receipt.json' },
      { id: 'gate-receipt', role: 'launch-receipt', sourcePath: material('gate-receipt.json', gate), path: 'gate-receipt.json' },
      { id: 'gate-summary', role: 'gate-summary', sourcePath: material('gate.json', { runId: 'tla-test' }), path: 'gate.json' },
      { id: 'gate-events', role: 'gate-events', sourcePath: material('gate-events.jsonl', { runId: 'tla-test' }), path: 'gate-events.jsonl' },
      { id: 'budget-events', role: 'budget-events', sourcePath: material('budget-events.jsonl', { runId: 'tla-test' }), path: 'budget-events.jsonl' }
    ]
  };
}

try {
try {
  assert.equal(parseReceipt(runner).kind, 'runner');
  assert.equal(parseReceipt(gate).kind, 'gate');
  assert.throws(() => validateRunnerReceipt({ ...runner, extra: true }), /unexpected|missing/u);
} catch (error) {
  throw error;
}
try {
  validateRunnerReceipt({ ...runner, launcherPid: null });
  assert.fail('spawned receipt must have a pid');
} catch (error) {
  assert.match(String(error.message), /pid/u);
}
assert.equal(joinReceipts(runner, gate).ok, true);
assert.equal(joinReceipts(runner, { ...gate, launcherPid: 9 }).ok, false);
assert.equal(invocationDigest('node', ['x']), invocationDigest('node', ['x']));
assert.throws(() => runnerReceipt({ ...runner, command: 'node', args: ['x'], state: 'spawned', launcherPid: null }), /pid|mismatch/u);
const failedRunner = runnerReceipt({ ...runner, command: 'node', args: ['x'], state: 'spawn-failed', launcherPid: null });
assert.equal(validateRunnerReceipt(failedRunner).state, 'spawn-failed');
assert.throws(() => parseGateArgs(['--receipt-runner-id', 'exp-x']), /together/u);
const supervisor = supervisorSpecFor({
  profile: 'stage1',
  projectCwd: root,
  runDir: join(root, 'spec-run'),
  gatePort: 30001,
  upstreamPort: 30002,
  modelRequests: 1,
  requireFiles: [],
  evidenceReceipts: true
});
assert.equal(supervisor.evidenceReceipts, true);

const good = assembleBundle(selection(), { out, pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(good.manifest.status, 'ASSEMBLED');
assert.equal(good.manifest.binding.status, 'consistent');
assert.equal(good.manifest.hostVerified, false);
assert.equal(good.manifest.binding.runnerRunId, 'exp-test');
assert.equal(good.manifest.binding.gateRunId, 'tla-test');
assert.equal(good.manifest.binding.budgetRunId, 'tla-test');

const missingGate = selection();
missingGate.artifacts = missingGate.artifacts.filter((item) => item.id !== 'gate-summary');
const missing = assembleBundle(missingGate, { out: join(root, 'out-missing'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(missing.manifest.status, 'ASSEMBLED');
assert.equal(missing.manifest.binding.status, 'unproven');
assert.ok(missing.manifest.issues.some((item) => item.code === 'INDEPENDENT_GATE_MISSING'));

const emptyGate = selection();
for (const item of emptyGate.artifacts) {
  if (item.id === 'gate-summary') item.sourcePath = material('gate-empty.json', {});
}
const emptyGateResult = assembleBundle(emptyGate, { out: join(root, 'out-empty-gate'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(emptyGateResult.manifest.status, 'ASSEMBLED');
assert.equal(emptyGateResult.manifest.binding.status, 'unproven');
assert.ok(emptyGateResult.manifest.issues.some((item) => item.code === 'INDEPENDENT_GATE_ID_MISSING'));

const emptyBudget = selection();
for (const item of emptyBudget.artifacts) {
  if (item.id === 'budget-events') item.sourcePath = material('budget-empty.json', '');
}
const emptyBudgetResult = assembleBundle(emptyBudget, { out: join(root, 'out-empty-budget'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(emptyBudgetResult.manifest.status, 'ASSEMBLED');
assert.equal(emptyBudgetResult.manifest.binding.status, 'unproven');
assert.ok(emptyBudgetResult.manifest.issues.some((item) => item.code === 'BUDGET_EVENTS_EMPTY'));

const carriedBudget = selection();
for (const item of carriedBudget.artifacts) {
  if (item.id === 'gate-summary') item.sourcePath = material('gate-carried-budget.json', { runId: 'tla-test', budgetRunId: 'tla-other' });
}
const carried = assembleBundle(carriedBudget, { out: join(root, 'out-carried'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(carried.manifest.status, 'INCOMPLETE');
assert.equal(carried.manifest.binding.status, 'unproven');

const conflictingBudget = selection();
for (const item of conflictingBudget.artifacts) {
  if (item.id === 'budget-events') {
    item.sourcePath = material('budget-conflict.jsonl', `${JSON.stringify({ runId: 'tla-test' })}\n${JSON.stringify({ budgetRunId: 'tla-other' })}\n`);
  }
}
const conflicting = assembleBundle(conflictingBudget, { out: join(root, 'out-conflicting'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(conflicting.manifest.status, 'INCOMPLETE');
assert.equal(conflicting.manifest.binding.status, 'unproven');

const conflictingGate = selection();
for (const item of conflictingGate.artifacts) {
  if (item.id === 'gate-summary') item.sourcePath = material('gate-conflict.json', { runId: 'tla-test', gateRunId: 'tla-other' });
}
const gateConflict = assembleBundle(conflictingGate, { out: join(root, 'out-gate-conflict'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(gateConflict.manifest.status, 'INCOMPLETE');
assert.equal(gateConflict.manifest.binding.status, 'unproven');

const mismatch = selection();
const wrongGate = material('gate-wrong.json', { runId: 'tla-other' });
for (const item of mismatch.artifacts) if (item.id === 'gate-summary') item.sourcePath = wrongGate;
const bad = assembleBundle(mismatch, { out: join(root, 'out-bad'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(bad.manifest.status, 'INCOMPLETE');
assert.equal(bad.manifest.binding.status, 'unproven');

const simulated = selection();
const simulatedRunner = {
  ...runner,
  origin: 'simulated'
};
const simulatedGate = {
  ...gate,
  origin: 'simulated'
};
for (const item of simulated.artifacts) {
  if (item.id === 'runner-receipt') item.sourcePath = material('sim-runner.json', simulatedRunner);
  if (item.id === 'gate-receipt') item.sourcePath = material('sim-gate.json', simulatedGate);
}
const sim = assembleBundle(simulated, { out: join(root, 'out-sim'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(sim.manifest.status, 'ASSEMBLED');
assert.equal(sim.manifest.binding.status, 'unproven');
assert.ok(sim.manifest.issues.some((item) => item.code === 'RECEIPT_SIMULATED'));

const malformed = selection();
for (const item of malformed.artifacts) {
  if (item.id === 'gate-receipt') item.sourcePath = material('bad-receipt.json', { schema: 'tla.gate-launch-receipt/v1' });
}
const badReceipt = assembleBundle(malformed, { out: join(root, 'out-malformed'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(badReceipt.manifest.status, 'INCOMPLETE');
assert.ok(badReceipt.manifest.issues.some((item) => item.code === 'LAUNCH_RECEIPT_INVALID'));

const upstream = selection();
upstream.artifacts.push({
  id: 'upstream-events',
  role: 'upstream-events',
  sourcePath: material('upstream.jsonl', { runId: 'upstream-service-only' }),
  path: 'upstream.jsonl'
});
const upstreamResult = assembleBundle(upstream, { out: join(root, 'out-upstream'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(upstreamResult.manifest.status, 'ASSEMBLED');
assert.equal(upstreamResult.manifest.binding.status, 'consistent');
assert.ok(upstreamResult.manifest.issues.some((item) => item.code === 'UPSTREAM_ID_SEMANTICS_UNSUPPORTED'));

const sameRecord = selection();
for (const item of sameRecord.artifacts) {
  if (item.id === 'budget-events') {
    item.sourcePath = material('budget-same-record-conflict.jsonl', { runId: 'tla-test', budgetRunId: 'tla-other' });
  }
}
const sameRecordResult = assembleBundle(sameRecord, { out: join(root, 'out-same-record'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(sameRecordResult.manifest.status, 'INCOMPLETE');
assert.equal(sameRecordResult.manifest.binding.status, 'unproven');
assert.ok(sameRecordResult.manifest.issues.some((item) => item.code === 'INDEPENDENT_ID_CONFLICT'));
assertIssueShape(sameRecordResult.manifest.issues);

const invalidType = selection();
for (const item of invalidType.artifacts) {
  if (item.id === 'gate-summary') item.sourcePath = material('gate-invalid-type.json', { runId: 7 });
}
const invalidTypeResult = assembleBundle(invalidType, { out: join(root, 'out-invalid-type'), pathSafetyProbe: () => ({ reparse: false }) });
assert.equal(invalidTypeResult.manifest.status, 'INCOMPLETE');
assert.equal(invalidTypeResult.manifest.binding.status, 'unproven');
assert.ok(invalidTypeResult.manifest.issues.some((item) => item.code === 'INDEPENDENT_ID_TYPE_INVALID'));
assertIssueShape(invalidTypeResult.manifest.issues);

for (const result of [good, missing, emptyGateResult, emptyBudgetResult, carried, conflicting, gateConflict, bad, sim, badReceipt, upstreamResult, sameRecordResult, invalidTypeResult]) {
  assertIssueShape(result.manifest.issues);
}

console.log('launch receipt tests: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
