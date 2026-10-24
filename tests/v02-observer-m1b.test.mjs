import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { validateObserverPlan, renderObserverPatch, OBSERVER_PLAN_SCHEMA, OBSERVER_PLUGIN_NAME, OBSERVER_VERSION, OBSERVER_FILE_COUNT } from '../tools/lib/observer-plan.mjs'
import { buildHostArgs, validateSpec, stopOwnedProcess } from '../tools/experiment-runner.mjs'
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

function traceBody (identity, { failed = false, omitFooter = false, signal = null } = {}) {
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
  const processFact = { exitCode: failed ? 1 : 0, signal, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false }
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
  const receiptOrigin = overrides.receiptOrigin ?? 'simulated'
  const runner = runnerReceipt({ runnerRunId: identity.runnerRunId, launchId: identity.launchId, state: 'spawned', launcherPid: process.pid, command: 'node', args: ['gated-run.mjs'], origin: receiptOrigin })
  const gate = gateReceipt({ runnerRunId: identity.runnerRunId, launchId: identity.launchId, gateRunId: identity.gateRunId, budgetRunId: identity.budgetRunId, command: 'node', args: ['gated-run.mjs'], origin: receiptOrigin })
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
  const journalIdentity = { ...identity, launchId: overrides.journalLaunchId ?? identity.launchId }
  writeFileSync(paths.journal, [1, 2, 3, 4].map((seq) => journalLine(seq, ['preparing', 'attached', 'stopping', 'stopped'][seq - 1], journalIdentity)).join('\n') + '\n')
  writeFileSync(paths.trace, traceBody(identity, overrides.trace))
  writeFileSync(paths.runnerReceipt, JSON.stringify(runner))
  writeFileSync(paths.gateReceipt, JSON.stringify(gate))
  writeFileSync(paths.runnerSummary, JSON.stringify({
    runId: overrides.runnerRunId ?? identity.runnerRunId,
    status: overrides.runnerStatus ?? 'completed',
    treeProof: Object.hasOwn(overrides, 'treeProof') ? overrides.treeProof : 'tree-killed',
    hostStarted: overrides.runnerHostStarted ?? true,
    teardown: overrides.teardown ?? [
      { role: 'host', how: 'tree-killed', descendants: [], descendantsProof: 'collected', survivors: [] },
      { role: 'upstream', how: 'already-exited', survivors: [] },
      { role: 'ports', gateFree: true, upstreamFree: true }
    ]
  }))
  const gateDecision = overrides.gateDecision === undefined
    ? { allow: overrides.gateAllow ?? true, blockers: overrides.gateBlockers ?? [] }
    : overrides.gateDecision
  writeFileSync(paths.gateSummary, JSON.stringify({
    runId: overrides.gateRunId ?? identity.gateRunId,
    budgetRunId: overrides.budgetRunId ?? identity.budgetRunId,
    hostStarted: overrides.hostStarted ?? true,
    result: overrides.gateResult ?? 'host-ok',
    decision: gateDecision,
    exitCode: overrides.gateExitCode ?? 0
  }))
  writeFileSync(paths.budgetEvents, JSON.stringify(overrides.budgetEvent ?? { runId: identity.budgetRunId }) + '\n')
  writeFileSync(paths.ledger, JSON.stringify(overrides.ledger ?? { schema: 'tla.run-ledger/v2', complete: true, incompleteRuns: [], inconsistent: [], upstreamOverGate: [] }))
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
  const one = createMaterials({ budgetEvent: { runId: 'tla-run-other' } })
  try {
    const report = evaluateMountProbe(inputFor(one))
    assert.equal(report.status, 'failed')
  } finally { rmSync(one.dir, { recursive: true, force: true }) }
})

test('a journal that names another valid launchId is failed even with consistent local-runtime receipts', () => {
  const materials = createMaterials({ journalLaunchId: randomUUID(), receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.equal(report.binding.status, 'consistent')
    assert.ok(report.checks.some((entry) => entry.code === 'identity-journal-launch' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('gate hostStarted=false is failed even with consistent local-runtime receipts', () => {
  const materials = createMaterials({ hostStarted: false, receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.equal(report.binding.status, 'consistent')
    assert.ok(report.checks.some((entry) => entry.code === 'gate-host-started' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('runner cleanup-anomaly is failed even with consistent local-runtime receipts', () => {
  const materials = createMaterials({ runnerStatus: 'cleanup-anomaly', receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.equal(report.binding.status, 'consistent')
    assert.ok(report.checks.some((entry) => entry.code === 'runner-completed' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('ledger upstreamOverGate is failed even when complete=true and receipts agree', () => {
  const materials = createMaterials({ ledger: { schema: 'tla.run-ledger/v2', complete: true, incompleteRuns: [], inconsistent: [], upstreamOverGate: ['run-x'] }, receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.equal(report.binding.status, 'consistent')
    assert.ok(report.checks.some((entry) => entry.code === 'ledger-upstream-over-gate' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('a budget event with conflicting role aliases is failed even with consistent receipts', () => {
  const materials = createMaterials({ budgetEvent: { runId: 'tla-run-one', budgetRunId: 'tla-run-two' }, receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.equal(report.binding.status, 'consistent')
    assert.ok(report.issues.some((entry) => entry.code === 'IDENTITY_CONFLICT' || entry.code === 'BUDGET_IDENTITY_CONFLICT'))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('a complete local-runtime fixture may be probe-passed but still cannot claim host coverage', () => {
  const materials = createMaterials({ receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'probe-passed')
    assert.equal(report.binding.status, 'consistent')
    assert.equal(report.hostVerified, false)
    assert.equal(report.coverage, 'unknown')
    assert.equal(report.closed, false)
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('hostStarted=true is not protection when gate refused with a blocker', () => {
  const materials = createMaterials({
    hostStarted: true,
    gateResult: 'protection-not-established',
    gateAllow: false,
    gateBlockers: [{ code: 'HEARTBEAT_MISSING', detail: 'no run-bound mount' }],
    gateExitCode: 3,
    receiptOrigin: 'local-runtime'
  })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.equal(report.binding.status, 'consistent')
    assert.ok(report.checks.some((entry) => entry.code === 'gate-result' && entry.ok === false))
    assert.ok(report.checks.some((entry) => entry.code === 'gate-allow' && entry.ok === false))
    assert.ok(report.checks.some((entry) => entry.code === 'gate-blockers' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('runner completed cannot hide a surviving host descendant', () => {
  const materials = createMaterials({
    teardown: [
      { role: 'host', how: 'descendants-survived', descendants: [4242], descendantsProof: 'collected', survivors: [4242] },
      { role: 'upstream', how: 'already-exited', survivors: [] },
      { role: 'ports', gateFree: true, upstreamFree: true }
    ],
    receiptOrigin: 'local-runtime'
  })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.ok(report.checks.some((entry) => entry.code === 'runner-survivors-host' && entry.ok === false))
    assert.ok(report.checks.some((entry) => entry.code === 'runner-how-host' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('runner completed cannot hide an unreleased port', () => {
  const materials = createMaterials({
    teardown: [
      { role: 'host', how: 'tree-killed', descendants: [], descendantsProof: 'collected', survivors: [] },
      { role: 'upstream', how: 'already-exited', survivors: [] },
      { role: 'ports', gateFree: false, upstreamFree: true }
    ],
    receiptOrigin: 'local-runtime'
  })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.ok(report.checks.some((entry) => entry.code === 'runner-ports-free' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('a pwsh exit 0 with a terminating signal is not foreground success', () => {
  const materials = createMaterials({ trace: { signal: 'SIGTERM' }, receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'failed')
    assert.ok(report.checks.some((entry) => entry.code === 'trace-pwsh-foreground' && entry.ok === false))
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('missing teardown records are incomplete, not success', () => {
  const materials = createMaterials({ teardown: [], receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, 'incomplete')
    assert.notEqual(report.status, 'probe-passed')
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})

test('missing gate decision and invalid teardown survivor types are incomplete', () => {
  const noDecision = createMaterials({ gateDecision: null, receiptOrigin: 'local-runtime' })
  const badType = createMaterials({
    teardown: [
      { role: 'host', how: 'tree-killed', survivors: 'not-an-array' },
      { role: 'upstream', how: 'already-exited', survivors: [] },
      { role: 'ports', gateFree: true, upstreamFree: true }
    ],
    receiptOrigin: 'local-runtime'
  })
  try {
    assert.equal(evaluateMountProbe(inputFor(noDecision)).status, 'incomplete')
    assert.equal(evaluateMountProbe(inputFor(badType)).status, 'incomplete')
  } finally {
    rmSync(noDecision.dir, { recursive: true, force: true })
    rmSync(badType.dir, { recursive: true, force: true })
  }
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
  const failed = createMaterials({ budgetEvent: { runId: 'tla-run-other' } })
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


// Match stopOwnedProcess/runner output, not a second cleanup implementation.
function cleanTeardown () {
  return [
    { role: 'host', how: 'tree-killed', descendants: [], descendantsProof: 'collected', survivors: [] },
    { role: 'upstream', how: 'terminated', descendants: [], descendantsProof: 'skipped', survivors: [] },
    { role: 'ports', gateFree: true, upstreamFree: true }
  ]
}

function assertTeardown (teardown, status, code) {
  const materials = createMaterials({ teardown, receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, status, JSON.stringify(report.checks.filter(entry => !entry.ok)))
    if (code) assert.ok(report.checks.some(entry => entry.code === code && !entry.ok), code)
    assert.equal(report.hostVerified, false)
    assert.equal(report.coverage, 'unknown')
    return report
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
}

for (const role of ['host', 'upstream', 'ports']) {
  test('teardown requires its own ' + role + ' record', () => {
    assertTeardown(cleanTeardown().filter(entry => entry.role !== role), 'incomplete', 'runner-teardown-' + role)
  })
  for (const shape of ['identical', 'failure-last', 'failure-first']) {
    test('duplicate ' + role + ' teardown is failed: ' + shape, () => {
      const entries = cleanTeardown()
      const duplicate = { ...entries.find(entry => entry.role === role) }
      if (shape !== 'identical') {
        if (role === 'ports') duplicate.gateFree = false
        else { duplicate.how = 'descendants-survived'; duplicate.survivors = [4242] }
      }
      if (shape === 'failure-first') entries.unshift(duplicate)
      else entries.push(duplicate)
      const report = assertTeardown(entries, 'failed', 'runner-teardown-' + role)
      if (shape !== 'identical') {
        const code = role === 'ports' ? 'runner-ports-free' : 'runner-survivors-' + role
        assert.ok(report.checks.some(entry => entry.code === code && !entry.ok))
      }
    })
  }
}

for (const role of ['host', 'upstream']) {
  for (const how of ['already-exited', 'terminated', 'tree-killed', 'killed']) {
    test('producer cleanup outcome preserves role-specific proof: ' + role + '/' + how, () => {
      const entries = cleanTeardown()
      entries.find(entry => entry.role === role).how = how
      assertTeardown(entries, role === 'host' && how === 'already-exited' ? 'incomplete' : 'probe-passed')
    })
  }
  for (const [how, status] of [['still-alive', 'failed'], ['descendants-survived', 'failed'], ['none', 'incomplete'], ['future-how', 'incomplete']]) {
    test('non-success cleanup is not accepted: ' + role + '/' + how, () => {
      const entries = cleanTeardown()
      entries.find(entry => entry.role === role).how = how
      assertTeardown(entries, status, 'runner-how-' + role)
    })
  }
}

test('teardown array order is immaterial', () => {
  assertTeardown(cleanTeardown().reverse(), 'probe-passed')
})

for (const entry of [null, 7, {}, { role: 'other', how: 'still-alive' }]) {
  test('uninterpretable teardown record blocks success: ' + JSON.stringify(entry), () => {
    assertTeardown([...cleanTeardown(), entry], 'incomplete', 'runner-teardown-record')
  })
}

for (const role of ['host', 'upstream']) {
  test('non-array survivors are incomplete for ' + role, () => {
    const entries = cleanTeardown()
    entries.find(entry => entry.role === role).survivors = null
    assertTeardown(entries, 'incomplete', 'runner-survivors-' + role)
  })
}

for (const value of [undefined, null, 'true', 1]) {
  test('port-free evidence requires booleans: ' + String(value), () => {
    const entries = cleanTeardown()
    entries.find(entry => entry.role === 'ports').upstreamFree = value
    assertTeardown(entries, 'incomplete', 'runner-ports-free')
  })
}

test('mount probe accepts the actual producer result for a stopped local child', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  try {
    await once(child, 'spawn')
    const result = await stopOwnedProcess(child, { descendants: false, graceMs: 1000, killMs: 1000 })
    assert.ok(['terminated', 'tree-killed', 'killed'].includes(result.how), result.how)
    assert.deepEqual(result.survivors, [])
    const entries = cleanTeardown()
    entries[1] = { role: 'upstream', ...result }
    assertTeardown(entries, 'probe-passed')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
})


test('teardown CLI preserves passed/incomplete/failed exit codes', () => {
  const duplicate = cleanTeardown()
  duplicate.push({ role: 'ports', gateFree: false, upstreamFree: true })
  for (const [teardown, status, exitCode] of [
    [cleanTeardown(), 'probe-passed', 0],
    [cleanTeardown().filter(entry => entry.role !== 'upstream'), 'incomplete', 1],
    [duplicate, 'failed', 2]
  ]) {
    const materials = createMaterials({ teardown, receiptOrigin: 'local-runtime' })
    try {
      const input = join(materials.dir, 'input.json')
      writeFileSync(input, JSON.stringify(inputFor(materials)))
      const child = spawnSync(process.execPath, ['tools/check-observer-mount-probe.mjs', '--input', input, '--json'], { cwd: repo, encoding: 'utf8', timeout: 10000 })
      assert.equal(child.status, exitCode, child.stderr)
      assert.equal(JSON.parse(child.stdout).status, status)
    } finally { rmSync(materials.dir, { recursive: true, force: true }) }
  }
})


function assertHostTree (changes, treeProof, status, code) {
  const teardown = cleanTeardown()
  Object.assign(teardown[0], changes)
  const materials = createMaterials({ teardown, treeProof, receiptOrigin: 'local-runtime' })
  try {
    const report = evaluateMountProbe(inputFor(materials))
    assert.equal(report.status, status, JSON.stringify(report.checks.filter(entry => !entry.ok)))
    if (code) assert.ok(report.checks.some(entry => entry.code === code && !entry.ok), code)
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
}

test('an already-exited host cannot prove its descendants even with no survivors', () => {
  assertHostTree({ how: 'already-exited', descendantsProof: 'skipped' }, 'exited-before-teardown', 'incomplete', 'runner-host-descendants-proof')
})

test('tree-killed summary cannot replace unavailable host descendant evidence', () => {
  assertHostTree({ descendantsProof: 'unavailable' }, 'tree-killed', 'incomplete', 'runner-host-descendants-proof')
})

for (const proof of [undefined, null, 'skipped', 'unavailable', 7, 'future-proof']) {
  test('host descendant proof must be collected: ' + String(proof), () => {
    assertHostTree({ descendantsProof: proof }, 'tree-killed', 'incomplete', 'runner-host-descendants-proof')
  })
}

for (const treeProof of [undefined, null, 'exited-before-teardown', 'descendants-unverified', 'cleanup-failed', 7, 'future-proof']) {
  test('unknown or missing tree summary cannot pass: ' + String(treeProof), () => {
    assertHostTree({}, treeProof, 'incomplete', 'runner-tree-proof')
  })
}

for (const descendants of [undefined, null, 'none', [0], [-1], [1.5], ['42'], [42, 42]]) {
  test('host descendant identities must be a valid snapshot: ' + JSON.stringify(descendants), () => {
    assertHostTree({ descendants }, 'tree-killed', 'incomplete', 'runner-host-descendants')
  })
}

test('a collected non-empty host snapshot joins its descendant cleanup summary', () => {
  assertHostTree({ how: 'terminated', descendants: [4242], descendantsProof: 'collected' }, 'descendants-killed', 'probe-passed')
})

test('a known tree summary cannot contradict the collected snapshot', () => {
  assertHostTree({ descendants: [4242] }, 'tree-killed', 'failed', 'runner-tree-proof')
  assertHostTree({ descendants: [] }, 'descendants-killed', 'failed', 'runner-tree-proof')
})

test('failed cleanup still wins over unavailable host descendant evidence', () => {
  assertHostTree({ how: 'descendants-survived', descendantsProof: 'unavailable', survivors: [4242] }, 'descendants-unverified', 'failed')
})

test('upstream single-process cleanup needs no host tree proof of its own', () => {
  const teardown = cleanTeardown()
  Object.assign(teardown[1], { how: 'already-exited', descendants: [], descendantsProof: 'skipped' })
  assertTeardown(teardown, 'probe-passed')
})

test('CLI reports unavailable host descendants as incomplete', () => {
  const teardown = cleanTeardown()
  teardown[0].descendantsProof = 'unavailable'
  const materials = createMaterials({ teardown, receiptOrigin: 'local-runtime' })
  try {
    const input = join(materials.dir, 'input.json')
    writeFileSync(input, JSON.stringify(inputFor(materials)))
    const child = spawnSync(process.execPath, ['tools/check-observer-mount-probe.mjs', '--input', input, '--json'], { cwd: repo, encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 1, child.stderr)
    assert.equal(JSON.parse(child.stdout).status, 'incomplete')
  } finally { rmSync(materials.dir, { recursive: true, force: true }) }
})
