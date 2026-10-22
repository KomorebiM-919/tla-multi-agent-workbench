import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { validateObserverPlan, renderObserverPatch, OBSERVER_PLAN_SCHEMA, OBSERVER_PLUGIN_NAME, OBSERVER_VERSION, OBSERVER_FILE_COUNT } from '../tools/lib/observer-plan.mjs'
import { buildHostArgs, validateSpec } from '../tools/experiment-runner.mjs'
import { evaluateMountProbe, MOUNT_PROBE_INPUT_SCHEMA } from '../tools/lib/observer-mount-probe.mjs'
import { gateReceipt, runnerReceipt } from '../tools/lib/launch-receipts.mjs'
import { validatePolicy } from './lib/reactive-model.mjs'

const repo = resolve('.')
const packageRoot = resolve('orchestration/tool-observer')
const digest = 'dc68af4508722c8452e84f4538dc215126c649771ea49d479f10be948e16f619'

function plan (overrides = {}) {
  return {
    schema: OBSERVER_PLAN_SCHEMA,
    plugin: OBSERVER_PLUGIN_NAME,
    packageRoot: repo,
    version: OBSERVER_VERSION,
    fileCount: OBSERVER_FILE_COUNT,
    digest,
    limits: { maxBytes: 131072, maxObservations: 10, maxPending: 2 },
    cleanupTimeoutMs: 100,
    ...overrides
  }
}

function journalLine (seq, phase, identity) {
  return JSON.stringify({
    schema: 'tla.observer-lifecycle/v1',
    seq,
    phase,
    traceId: identity.traceId,
    origin: 'host-notification',
    runnerRunId: identity.runnerRunId,
    launchId: identity.launchId,
    gateRunId: identity.gateRunId,
    budgetRunId: identity.budgetRunId,
    observerPid: process.pid,
    code: null,
    health: phase === 'stopped' ? { writerOk: true, cleanupState: 'settled', ownershipUncertain: false } : null
  })
}

function traceLine (value) {
  return JSON.stringify(value)
}

function observation (receiptSeq, input) {
  return {
    kind: 'observation',
    receiptSeq,
    source: input.event === 'call' ? 'session/event' : 'tools/result',
    event: input.event,
    sessionId: 'session-1',
    callId: input.callId,
    rootCallId: input.callId,
    toolName: input.toolName,
    sourceSeq: receiptSeq - 1,
    outcome: input.event === 'call' ? 'unknown' : (input.outcome ?? 'success'),
    valueState: input.event === 'call' ? 'absent' : 'present',
    process: input.process ?? null
  }
}

function traceBody (identity, { failed = false, omitFooter = false } = {}) {
  const header = {
    schema: 'tla.tool-metadata-trace/v1',
    kind: 'header',
    traceId: identity.traceId,
    origin: 'host-notification',
    scope: 'tool-metadata-only',
    bindingClaim: {
      runnerRunId: identity.runnerRunId,
      launchId: identity.launchId,
      gateRunId: identity.gateRunId,
      budgetRunId: identity.budgetRunId
    },
    order: 'observer-delivery-only',
    coverage: 'unknown'
  }
  const processFact = { exitCode: failed ? 1 : 0, signal: null, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false }
  const lines = [traceLine(header)]
  lines.push(traceLine(observation(1, { event: 'call', callId: 'call-read', toolName: 'read' })))
  lines.push(traceLine(observation(2, { event: 'result', callId: 'call-read', toolName: 'read', outcome: failed ? 'error' : 'success' })))
  lines.push(traceLine(observation(3, { event: 'call', callId: 'call-pwsh', toolName: 'pwsh' })))
  lines.push(traceLine(observation(4, { event: 'result', callId: 'call-pwsh', toolName: 'pwsh', outcome: 'success', process: processFact })))
  if (!omitFooter) {
    lines.push(traceLine({
      kind: 'footer',
      traceId: identity.traceId,
      observationsWritten: 4,
      captureState: 'finalized',
      diagnostics: [],
      diagnosticsDropped: 0
    }))
  }
  return lines.join('\n') + '\n'
}

function createMaterials (overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm1b-mount-'))
  const identity = {
    runnerRunId: 'exp-mount-1',
    launchId: randomUUID(),
    gateRunId: 'tla-run-mount-1',
    budgetRunId: 'tla-run-mount-1',
    traceId: randomUUID()
  }
  const runner = runnerReceipt({ runnerRunId: identity.runnerRunId, launchId: identity.launchId, state: 'spawned', launcherPid: process.pid, command: 'node', args: ['gated-run.mjs'], origin: 'simulated' })
  const gate = gateReceipt({ runnerRunId: identity.runnerRunId, launchId: identity.launchId, gateRunId: identity.gateRunId, budgetRunId: identity.budgetRunId, command: 'node', args: ['gated-run.mjs'], origin: 'simulated' })
  const paths = {
    journal: join(dir, 'lifecycle.jsonl'),
    trace: join(dir, 'trace.jsonl'),
    runnerReceipt: join(dir, 'runner-receipt.json'),
    gateReceipt: join(dir, 'gate-receipt.json'),
    runnerSummary: join(dir, 'runner-summary.json'),
    gateSummary: join(dir, 'gate-summary.json'),
    budgetEvents: join(dir, 'budget-events.jsonl'),
    ledger: join(dir, 'ledger.json')
  }
  writeFileSync(paths.journal, [1, 2, 3, 4].map((seq) => journalLine(seq, ['preparing', 'attached', 'stopping', 'stopped'][seq - 1], identity)).join('\n') + '\n')
  writeFileSync(paths.trace, traceBody(identity, overrides.trace))
  writeFileSync(paths.runnerReceipt, JSON.stringify(runner))
  writeFileSync(paths.gateReceipt, JSON.stringify(gate))
  writeFileSync(paths.runnerSummary, JSON.stringify({ runId: overrides.runnerRunId ?? identity.runnerRunId }))
  writeFileSync(paths.gateSummary, JSON.stringify({ runId: overrides.gateRunId ?? identity.gateRunId, budgetRunId: overrides.budgetRunId ?? identity.budgetRunId }))
  writeFileSync(paths.budgetEvents, JSON.stringify({ runId: overrides.budgetEventsId ?? identity.budgetRunId }) + '\n')
  writeFileSync(paths.ledger, JSON.stringify(overrides.ledger ?? { schema: 'tla.run-ledger/v2', complete: true, incompleteRuns: [], inconsistent: [] }))
  return { dir, paths, identity }
}

function inputFor (materials) {
  return { schema: MOUNT_PROBE_INPUT_SCHEMA, materials: materials.paths }
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

test('mount probe accepts complete production-format synthetic materials', () => {
  const materials = createMaterials()
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'probe-passed')
    assert.equal(report.hostVerified, false)
    assert.equal(report.coverage, 'unknown')
    assert.equal(report.closed, false)
    assert.equal(report.binding.status, 'unproven')
    assert.ok(report.limitations.some((value) => /ledger/i.test(value)))
  } finally {
    rmSync(materials.dir, { recursive: true, force: true })
  }
})

test('empty receipts, phase-only journal, footerless trace and failed tools do not pass', () => {
  const materials = createMaterials({ trace: { failed: true, omitFooter: true } })
  try {
    writeFileSync(materials.paths.journal, '{"phase":"preparing"}\n')
    writeFileSync(materials.paths.runnerReceipt, '{}')
    writeFileSync(materials.paths.gateReceipt, '{}')
    writeFileSync(materials.paths.runnerSummary, '{}')
    writeFileSync(materials.paths.gateSummary, '{}')
    writeFileSync(materials.paths.budgetEvents, '\n')
    const report = evaluateMountProbe(inputFor(materials))
    assert.notEqual(report.status, 'probe-passed')
    assert.notEqual(report.status, 'consistent')
    assert.equal(report.hostVerified, false)
  } finally {
    rmSync(materials.dir, { recursive: true, force: true })
  }
})

test('each required material missing is incomplete, not success', () => {
  for (const key of ['journal', 'trace', 'runnerReceipt', 'gateReceipt', 'runnerSummary', 'gateSummary', 'budgetEvents', 'ledger']) {
    const materials = createMaterials()
    try {
      unlinkSync(materials.paths[key])
      const report = evaluateMountProbe(inputFor(materials))
      assert.match(report.status, /incomplete|failed/u, key)
      assert.notEqual(report.status, 'probe-passed', key)
    } finally {
      rmSync(materials.dir, { recursive: true, force: true })
    }
  }
})

test('run identity conflict and cross-run budget borrowing are failed', () => {
  const one = createMaterials({ budgetEventsId: 'tla-run-other' })
  try {
    const report = evaluateMountProbe(inputFor(one))
    assert.equal(report.status, 'failed')
  } finally { rmSync(one.dir, { recursive: true, force: true }) }
})

test('failed read or missing footer cannot pass', () => {
  const failed = createMaterials({ trace: { failed: true } })
  const footerless = createMaterials({ trace: { omitFooter: true } })
  try {
    assert.notEqual(evaluateMountProbe(inputFor(failed)).status, 'probe-passed')
    assert.notEqual(evaluateMountProbe(inputFor(footerless)).status, 'probe-passed')
  } finally {
    rmSync(failed.dir, { recursive: true, force: true })
    rmSync(footerless.dir, { recursive: true, force: true })
  }
})

test('unsafe DTO or extra tool is rejected', () => {
  const materials = createMaterials()
  try {
    writeFileSync(materials.paths.trace, traceBody(materials.identity).replace('"toolName":"read"', '"toolName":"curl"'))
    const report = evaluateMountProbe(inputFor(materials))
    assert.notEqual(report.status, 'probe-passed')
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('actual gate path renders the receipt-bound observer patch before host start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm1b-gate-'))
  try {
    const runDir = join(dir, 'run')
    mkdirSync(runDir)
    const planPath = join(runDir, 'observer-plan.json')
    writeFileSync(planPath, JSON.stringify(plan(), null, 2) + '\n')
    const fakeCli = join(dir, 'fake-cli.mjs')
    writeFileSync(fakeCli, 'process.exit(1)\n')
    const launchId = randomUUID()
    const result = spawnSync(process.execPath, [
      'tools/gated-run.mjs',
      '--upstream', 'http://127.0.0.1:1',
      '--model-requests', '1',
      '--run-dir', runDir,
      '--gate-port', '0',
      '--heartbeat-file', join(runDir, 'heartbeat.jsonl'),
      '--dsh-exe', process.execPath,
      '--dsh-cli', fakeCli,
      '--profile', 'stage1',
      '--prompt', 'x',
      '--observer-plan', planPath,
      '--receipt-runner-id', 'exp-gate-test',
      '--receipt-launch-id', launchId,
      '--receipt-file', join(runDir, 'gate-receipt.json'),
      '--config-timeout-ms', '1000',
      '--timeout-ms', '1000'
    ], { cwd: repo, encoding: 'utf8', timeout: 30_000 })
    assert.notEqual(result.status, 0)
    const patchPath = join(runDir, 'observer-launch.patch.yml')
    assert.ok(existsSync(patchPath), result.stderr)
    const summary = JSON.parse(readFileSync(join(runDir, 'gate-summary.json'), 'utf8'))
    const patch = readFileSync(patchPath, 'utf8')
    assert.match(patch, new RegExp('gateRunId: "' + summary.runId + '"', 'u'))
    const receipt = JSON.parse(readFileSync(join(runDir, 'gate-receipt.json'), 'utf8'))
    assert.equal(receipt.gateRunId, summary.runId)
    assert.equal(receipt.runnerRunId, 'exp-gate-test')
    assert.equal(receipt.launchId, launchId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mount-probe CLI uses 0/1/2 for passed/incomplete/failed', () => {
  const good = createMaterials()
  const incomplete = createMaterials()
  const failed = createMaterials({ budgetEventsId: 'tla-run-other' })
  try {
    unlinkSync(incomplete.paths.journal)
    const writeInput = (materials, name) => {
      const path = join(materials.dir, name)
      writeFileSync(path, JSON.stringify(inputFor(materials)))
      return path
    }
    const goodPath = writeInput(good, 'input-good.json')
    const incompletePath = writeInput(incomplete, 'input-incomplete.json')
    const failedPath = writeInput(failed, 'input-failed.json')
    const run = (path) => spawnSync(process.execPath, ['tools/check-observer-mount-probe.mjs', '--input', path], { cwd: repo, encoding: 'utf8' })
    assert.equal(run(goodPath).status, 0)
    assert.equal(run(incompletePath).status, 1)
    assert.equal(run(failedPath).status, 2)
  } finally {
    rmSync(good.dir, { recursive: true, force: true })
    rmSync(incomplete.dir, { recursive: true, force: true })
    rmSync(failed.dir, { recursive: true, force: true })
  }
})

test('probe policy declares the three-response request budget under the existing cap', () => {
  const policy = JSON.parse(readFileSync('tests/fixtures/observer-m1b-probe-policy.json', 'utf8'))
  assert.doesNotThrow(() => validatePolicy(policy))
  assert.equal(policy.modelRequests, 3)
  assert.ok(policy.modelRequests <= 40)
})
