import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateObserverPlan, renderObserverPatch, OBSERVER_PLAN_SCHEMA, OBSERVER_PLUGIN_NAME, OBSERVER_VERSION, OBSERVER_FILE_COUNT } from '../tools/lib/observer-plan.mjs'
import { buildHostArgs, validateSpec } from '../tools/experiment-runner.mjs'
import { evaluateMountProbe, MOUNT_PROBE_INPUT_SCHEMA } from '../tools/lib/observer-mount-probe.mjs'
import { validatePolicy } from './lib/reactive-model.mjs'

const repo = resolve('.')
const packageRoot = resolve('orchestration/tool-observer')
const digest = 'dc68af4508722c8452e84f4538dc215126c649771ea49d479f10be948e16f619'

function plan (overrides = {}) {
  return {
    schema: OBSERVER_PLAN_SCHEMA,
    plugin: OBSERVER_PLUGIN_NAME,
    packageRoot,
    version: OBSERVER_VERSION,
    fileCount: OBSERVER_FILE_COUNT,
    digest,
    limits: { maxBytes: 131072, maxObservations: 10, maxPending: 2 },
    cleanupTimeoutMs: 100,
    ...overrides
  }
}

function probeInput () {
  return {
    schema: MOUNT_PROBE_INPUT_SCHEMA,
    journal: { records: [{ phase: 'preparing' }, { phase: 'attached' }, { phase: 'stopping' }, { phase: 'stopped' }] },
    trace: {
      header: { schema: 'tla.tool-metadata-trace/v1', origin: 'host-notification' },
      observations: [
        { schema: 'tla.tool-metadata-trace/v1', seq: 1, at: '2026-01-01T00:00:00Z', event: 'tool/result', sessionId: 's', callId: 'c1', toolName: 'read', outcome: 'success', valueState: 'present', process: null, receiptSeq: 1 },
        { schema: 'tla.tool-metadata-trace/v1', seq: 2, at: '2026-01-01T00:00:01Z', event: 'tool/result', sessionId: 's', callId: 'c2', toolName: 'pwsh', outcome: 'success', valueState: 'present', process: null, receiptSeq: 2 }
      ]
    },
    receipts: { runner: { schema: 'tla.runner-launch-receipt/v1' }, gate: { schema: 'tla.gate-launch-receipt/v1' } },
    binding: 'consistent',
    ledger: { completeness: 'complete', runnerRunId: 'r', gateRunId: 'g' },
    runner: { runId: 'r' },
    gate: { runId: 'g' },
    cleanup: { residual: false }
  }
}

test('plan validates and patch carries all twelve fields', () => {
  const p = plan()
  assert.equal(validateObserverPlan(p), p)
  const rendered = renderObserverPatch(p, { runDir: join(tmpdir(), 'm1b-patch'), runnerRunId: 'runner-1', launchId: 'launch-1', gateRunId: 'gate-1', budgetRunId: 'gate-1' })
  assert.match(rendered.patch, /maxBytes: 131072/u)
  assert.match(rendered.patch, /gateRunId: "gate-1"/u)
  assert.equal(rendered.paths.planPath, join(tmpdir(), 'm1b-patch', 'observer-plan.json'))
})

test('plan rejects unknown fields and mismatched gate/budget identity', () => {
  assert.throws(() => validateObserverPlan(plan({ extra: true })), /exactly/u)
  assert.throws(() => renderObserverPatch(plan(), { runDir: join(tmpdir(), 'm1b-patch'), runnerRunId: 'r', launchId: 'l', gateRunId: 'g', budgetRunId: 'other' }), /must be equal/u)
  assert.throws(() => validateObserverPlan(plan({ digest: 'ABC' })), /64-character/u)
})

test('runner spec requires receipts and standard launcher for observer', () => {
  const project = mkdtempSync(join(tmpdir(), 'm1b-runner-project-'))
  const runDir = join(tmpdir(), 'm1b-runner-' + String(Date.now()))
  try {
    assert.throws(() => validateSpec({ projectCwd: project, runDir, profile: 'stage1', gatePort: 18921, upstreamPort: 18920, fakeServerPath: 'x', policyPath: 'y', observer: plan() }), /evidenceReceipts=true/u)
    assert.throws(() => validateSpec({ projectCwd: project, runDir, profile: 'stage1', gatePort: 18921, upstreamPort: 18920, fakeServerPath: 'x', policyPath: 'y', evidenceReceipts: true, hostCommand: process.execPath, hostArgs: [], observer: plan() }), /standard gated launcher/u)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('host args carry the observer plan path', () => {
  const spec = { projectCwd: repo, runDir: join(tmpdir(), 'm1b-args'), profile: 'stage1', prompt: 'x', gatePort: 18921, upstreamPort: 18920 }
  const endpoints = { runId: 'exp-1', gatePort: 18921, upstreamPort: 18920, upstreamUrl: 'http://127.0.0.1:18920', gateUrl: 'http://127.0.0.1:18921' }
  const effective = { modelRequests: 1, leaseTtlMs: 1000, heartbeatMaxAgeMs: 500, timeoutMs: 1000, heartbeatIntervalMs: 100 }
  const args = buildHostArgs(spec, endpoints, spec.runDir, 'overlay.yml', effective, { launchId: 'launch-1', gatePath: 'gate.json' }, 'observer-plan.json')
  assert.equal(args.filter((value) => value === '--observer-plan').length, 1)
  assert.equal(args[args.indexOf('--observer-plan') + 1], 'observer-plan.json')
})

test('M1B envelope verifies twelve files and imports the entry', () => {
  const result = spawnSync(process.execPath, ['tools/check-observer-m1b-package.mjs', '--repo', '.'], { cwd: repo, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /M1B ENVELOPE OK \(12 files, dc68af450872\)/u)
})

test('mount probe accepts a complete synthetic evidence set', () => {
  const report = evaluateMountProbe(probeInput())
  assert.equal(report.status, 'probe-passed')
  assert.equal(report.hostVerified, false)
  assert.equal(report.coverage, 'unknown')
  assert.equal(report.closed, false)
  assert.equal(report.binding.status, 'consistent')
})

test('missing cleanup, origin and ledger are not success', () => {
  const input = probeInput()
  input.cleanup.residual = true
  input.trace.header.origin = 'simulated-dispatcher'
  input.ledger.completeness = 'incomplete'
  const report = evaluateMountProbe(input)
  assert.notEqual(report.status, 'probe-passed')
  assert.equal(report.status, 'failed')
  assert.ok(report.checks.some((entry) => entry.code === 'cleanup-empty' && !entry.ok))
})

test('unsafe trace DTO or extra tool is rejected', () => {
  const input = probeInput()
  input.trace.observations.push({ schema: 'tla.tool-metadata-trace/v1', event: 'tool/result', toolName: 'curl', privatePath: 'C:\\secret' })
  const report = evaluateMountProbe(input)
  assert.equal(report.status, 'failed')
  assert.ok(report.checks.some((entry) => entry.code === 'trace-tools' && !entry.ok))
  assert.ok(report.checks.some((entry) => entry.code === 'dto-safe' && !entry.ok))
})

test('probe policy is valid and stays under the model request cap', () => {
  const policy = JSON.parse(readFileSync('tests/fixtures/observer-m1b-probe-policy.json', 'utf8'))
  assert.doesNotThrow(() => validatePolicy(policy))
  assert.ok(policy.rules.length <= 40)
})
