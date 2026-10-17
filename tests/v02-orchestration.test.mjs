#!/usr/bin/env node
// tests/v02-orchestration.test.mjs
//
// V0.2 编排原型的离线测试：配置校验、手动选择、金额守恒、价格未知/过期、
// 预算不足、后端不可用与调用计数边界、计划翻译、持久化往返、价格导入。
//
// 全部用例不联网、不调用模型、不安装依赖；适配层"无文件写入"用源码级断言验证。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_TEAMS_REVIEWED_VERSION,
  backendStatusForPlan,
  executePlan,
  probeAgentTeams,
  translatePlanToAgentTeams,
  workflowScriptBackendStatus,
} from '../orchestration/adapters/agent-teams.mjs';
import {
  canonicalJson,
  configDigest,
  loadConfigFromFile,
  saveConfig,
  validateConfig,
} from '../orchestration/config.mjs';
import { estimateRoleCost } from '../orchestration/estimate.mjs';
import {
  buildSnapshotFromPortkey,
  centsPerTokenToMicroMinorPerMillion,
  extractProviderEntries,
  parseJsonStrict,
} from '../orchestration/importers/portkey.mjs';
import {
  allocateByBasisPoints,
  costForTokens,
  divCeil,
  divRoundHalfUp,
  formatMicro,
  microFromMinor,
} from '../orchestration/money.mjs';
import { buildPlan } from '../orchestration/plan.mjs';
import { loadSnapshotFromFile, resolvePrice, validateSnapshot } from '../orchestration/pricing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXED_NOW = Date.parse('2026-10-17T18:00:00Z');

let scenarios = 0;
let checks = 0;
const failures = [];

function scenario(name) {
  scenarios += 1;
  process.stdout.write('scenario ' + scenarios + ': ' + name + '\n');
}

function check(condition, label, detail) {
  checks += 1;
  if (condition) return;
  failures.push({ label, detail });
  process.stdout.write('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail) + '\n');
}

function codes(raw) {
  const result = validateConfig(raw);
  return result.ok ? [] : result.problems.map((entry) => entry.code);
}

function hasCode(list, code) {
  return list.includes(code);
}

// ---------------------------------------------------------------- fixtures

function snapshotRaw(overrides = {}) {
  const base = {
    schema: 'tla.pricing-snapshot/v1',
    snapshotId: 'test-snapshot-1',
    currency: 'USD',
    capturedAt: '2026-10-17T17:00:00Z',
    source: {
      repository: 'portkey-models',
      commit: '72e1084840af7e14350ff6a12d33255a878bbec5',
      license: 'MIT',
      files: ['pricing/deepseek.json', 'pricing/moonshot.json'],
    },
    notes: ['test fixture'],
    entries: [
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        mode: 'chat',
        inputMicroMinorPerMillion: 43_500_000,
        outputMicroMinorPerMillion: 87_000_000,
        cacheReadMicroMinorPerMillion: 362_500,
        provenance: 'portkey-models@72e1084 pricing/deepseek.json pay_as_you_go',
        unknownFields: ['offPeakPricing'],
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        mode: 'chat',
        inputMicroMinorPerMillion: 14_000_000,
        outputMicroMinorPerMillion: 28_000_000,
        cacheReadMicroMinorPerMillion: 280_000,
        provenance: 'portkey-models@72e1084 pricing/deepseek.json pay_as_you_go',
        unknownFields: ['offPeakPricing'],
      },
      {
        provider: 'moonshot',
        model: 'moonshot-v1-8k',
        mode: 'chat',
        inputMicroMinorPerMillion: 20_000_000,
        outputMicroMinorPerMillion: 200_000_000,
        provenance: 'portkey-models@72e1084 pricing/moonshot.json pay_as_you_go',
        unknownFields: ['offPeakPricing', 'cacheReadPricing'],
      },
    ],
  };
  return { ...base, ...overrides };
}

function configRaw(overrides = {}) {
  const base = {
    schema: 'tla.v02-run-config/v1',
    runId: 'v0.2-test-20261018T000000Z',
    roles: {
      lead: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      worker: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      reviewer: { provider: 'moonshot', model: 'moonshot-v1-8k' },
    },
    ownerRole: 'lead',
    router: { enabled: false, policy: 'none' },
    budget: {
      currency: 'USD',
      totalMinor: 2500,
      allocations: [
        { role: 'lead', basisPoints: 4000 },
        { role: 'worker', basisPoints: 4000 },
        { role: 'reviewer', basisPoints: 2000 },
      ],
    },
    pricing: {
      snapshotPath: 'orchestration/data/pricing-snapshot.test.json',
      maxAgeHours: 168,
      providerAliases: { 'deepseek-official': 'deepseek' },
    },
    estimates: {
      perCall: { inputTokens: 20000, outputTokens: 4000, cacheReadTokens: 8000 },
      calls: { lead: 2, worker: 6, reviewer: 2 },
    },
    backend: {
      kind: 'workflow-script',
      workflow: 'three-agent-mvp',
      task: {
        targetDir: 'examples/text-stats',
        moduleFile: 'text_stats.py',
        testFile: 'test_text_stats.py',
        maxAgentCalls: 8,
      },
    },
  };
  return { ...base, ...overrides };
}

function makePlan({ config = configRaw(), snapshot = snapshotRaw(), nowMs = FIXED_NOW, backend } = {}) {
  const configResult = validateConfig(config);
  if (!configResult.ok) throw new Error('fixture config 无效: ' + JSON.stringify(configResult.problems));
  const normalizedSnapshot = validateSnapshot(snapshot);
  return buildPlan({
    configResult,
    snapshot: normalizedSnapshot,
    nowMs,
    backend: backend === undefined ? workflowScriptBackendStatus({ maxAgentCalls: 8 }) : backend,
  });
}

function blockerCodes(plan) {
  return plan.blockers.map((entry) => entry.code);
}

function planMember(plan, role) {
  return plan.members.find((entry) => entry.role === role);
}

// ------------------------------------------------------- 1. 手动选择不被覆盖

scenario('manual role/model selection is preserved and never re-routed');
{
  const config = configRaw();
  const plan = makePlan({ config });
  check(plan.status === 'ready', 'plan is ready with a verified backend', plan.status + ' ' + JSON.stringify(blockerCodes(plan)));
  check(plan.members.length === 3, 'three members planned', String(plan.members.length));
  for (const roleName of Object.keys(config.roles)) {
    const member = planMember(plan, roleName);
    check(member.provider === config.roles[roleName].provider, roleName + ' provider is exactly the configured one', member.provider);
    check(member.model === config.roles[roleName].model, roleName + ' model is exactly the configured one', member.model);
    check(member.selection === 'manual', roleName + ' selection is manual', member.selection);
    check(member.selectionSource === 'config (manual)', roleName + ' selectionSource is explicit', member.selectionSource);
  }
  check(planMember(plan, 'lead').isOwner === true, 'owner role is marked');
  check(planMember(plan, 'worker').isOwner === false, 'non-owner roles are not marked');
  check(planMember(plan, 'lead').reasoningEffort === 'high', 'reasoning effort is passed through', String(planMember(plan, 'lead').reasoningEffort));
  check(plan.routerGuard.mode === 'manual-pinned', 'router guard is manual-pinned', plan.routerGuard.mode);
  check(plan.routerGuard.autoRoutingEnabled === false, 'auto routing is off', String(plan.routerGuard.autoRoutingEnabled));
  check(plan.routerGuard.overridable === false, 'plan declares the route is not re-routed at runtime');
  check(plan.owner === 'lead', 'plan names the owner', plan.owner);
  const second = makePlan({ config });
  check(canonicalJson(second) === canonicalJson(plan), 'plan is deterministic for identical inputs');
}

scenario('automatic routing, fallback and non-manual selection are rejected outright');
{
  check(hasCode(codes(configRaw({ router: { enabled: true, policy: 'auto' } })), 'ROUTER_UNSUPPORTED'),
    'router.enabled=true is rejected');
  check(hasCode(codes(configRaw({ roles: { ...configRaw().roles, worker: { ...configRaw().roles.worker, fallback: { provider: 'moonshot', model: 'moonshot-v1-8k' } } } })),
    'FALLBACK_UNSUPPORTED'), 'per-role fallback is rejected');
  check(hasCode(codes(configRaw({ roles: { ...configRaw().roles, worker: { ...configRaw().roles.worker, selection: 'auto' } } })),
    'SELECTION_UNSUPPORTED'), 'non-manual selection is rejected');
  check(hasCode(codes(configRaw({ roles: { ...configRaw().roles, worker: { provider: 'deepseek-official' } } })),
    'ROUTE_INCOMPLETE'), 'provider without model is rejected');
  check(hasCode(codes(configRaw({ roles: { ...configRaw().roles, ghost: { provider: 'x', model: 'y' } } })),
    'ALLOCATION_ROLE_MISSING'), 'a role without an allocation is rejected');
  check(hasCode(codes(configRaw({ ownerRole: 'nobody' })), 'OWNER_UNKNOWN'), 'unknown owner role is rejected');
  check(hasCode(codes(configRaw({ ownerRole: undefined })), 'OWNER_MISSING'), 'missing owner role is rejected');
  check(hasCode(codes(configRaw({ pricing: { snapshotPath: 'x.json', providerAliases: { a: 'a' } } })),
    'PRICING_INVALID'), 'a self-mapping provider alias is rejected');
}

// ------------------------------------------------- 2. 比例校验与金额守恒

scenario('basis points must sum to exactly 10000 and allocations conserve the total');
{
  check(hasCode(codes(configRaw({
    budget: {
      currency: 'USD',
      totalMinor: 2500,
      allocations: [
        { role: 'lead', basisPoints: 4000 },
        { role: 'worker', basisPoints: 4001 },
        { role: 'reviewer', basisPoints: 2000 },
      ],
    },
  })), 'ALLOCATION_SUM'), 'basis points summing to 10001 are rejected');
  check(hasCode(codes(configRaw({
    budget: { currency: 'USD', totalMinor: 2500, allocations: [{ role: 'lead', basisPoints: 4000 }] },
  })), 'ALLOCATION_ROLE_MISSING'), 'incomplete allocation coverage is rejected');
  check(hasCode(codes(configRaw({ budget: { currency: 'USD', totalMinor: 2500, allocations: [] } })),
    'ALLOCATION_EMPTY'), 'empty allocation list is rejected');

  // 总额刻意不能被 3 整除，才能验证"余数补偿"而不是恰好整除的假象。
  const total = microFromMinor(1000) + 7;
  const shares = allocateByBasisPoints(total, [
    { role: 'a', basisPoints: 3333 },
    { role: 'b', basisPoints: 3333 },
    { role: 'c', basisPoints: 3334 },
  ]);
  const values = [...shares.values()];
  check(values.reduce((acc, value) => acc + value, 0) === total, 'shares sum to the total exactly (no rounding drift)');
  const basisPoints = [3333, 3333, 3334];
  const withinOneOfExact = values.every((value, index) => Math.abs(value - (total * basisPoints[index]) / 10000) < 1);
  check(withinOneOfExact, 'each share is within one micro unit of its exact ratio', values.join(','));

  const odd = microFromMinor(7);
  const oddShares = allocateByBasisPoints(odd, [
    { role: 'x', basisPoints: 5001 },
    { role: 'y', basisPoints: 4999 },
  ]);
  check([...oddShares.values()].reduce((acc, value) => acc + value, 0) === odd, 'odd totals still conserve exactly');
  check([...oddShares.values()].every((value) => Number.isSafeInteger(value)), 'share values are integers');

  const plan = makePlan();
  const plannedSum = plan.members.reduce((acc, member) => acc + member.allocationMicroMinor, 0);
  check(plannedSum === plan.totals.allocationMicroMinor, 'member allocations sum to the plan total', plannedSum + ' vs ' + plan.totals.allocationMicroMinor);
  check(plan.totals.allocationMicroMinor === microFromMinor(2500), 'plan total equals the declared budget');
  check(planMember(plan, 'lead').allocationMicroMinor === microFromMinor(1000), 'lead gets 40% of the budget');
  check(planMember(plan, 'reviewer').allocationMicroMinor === microFromMinor(500), 'reviewer gets 20% of the budget');
  check(plan.members.every((member) => member.withinAllocation === true), 'all estimates are within their allocation');
  check(plan.budgetEnforcement === 'allocation-plan-only', 'budget is declared as a plan, not a charge', plan.budgetEnforcement);
}

// ------------------------------------- 3. 价格未知、过期、缺项与估算边界

scenario('unknown and stale prices block the plan instead of guessing');
{
  const unknownModel = makePlan({ config: configRaw({
    roles: { ...configRaw().roles, worker: { provider: 'deepseek-official', model: 'deepseek-v9-unreleased' } },
  }) });
  check(hasCode(blockerCodes(unknownModel), 'PRICE_UNKNOWN'), 'unknown model blocks the plan');
  check(planMember(unknownModel, 'worker').priceStatus === 'unknown', 'member price status is unknown');
  check(planMember(unknownModel, 'worker').estimatedMicroMinor === null, 'unknown price yields no estimate (never 0)');
  check(unknownModel.status === 'blocked', 'plan status is blocked');

  const stale = makePlan({ config: configRaw({ pricing: { snapshotPath: 'x.json', maxAgeHours: 1 } }), nowMs: FIXED_NOW + 3 * 3600 * 1000 });
  check(hasCode(blockerCodes(stale), 'PRICE_STALE'), 'stale snapshot blocks the plan');

  const future = makePlan({ snapshot: snapshotRaw({ capturedAt: '2026-10-19T00:00:00Z' }) });
  check(hasCode(blockerCodes(future), 'PRICE_SNAPSHOT_FUTURE'), 'snapshot from the future blocks the plan');

  const mismatch = makePlan({ snapshot: snapshotRaw({ currency: 'CNY' }) });
  check(hasCode(blockerCodes(mismatch), 'CURRENCY_MISMATCH'), 'currency mismatch blocks the plan');

  const plan = makePlan();
  const reviewer = planMember(plan, 'reviewer');
  check(reviewer.unknownFields.includes('cacheRead'), 'unknown cache price is declared per member', reviewer.unknownFields.join(','));
  check(reviewer.estimatedMicroMinor.total === 2_720_000, 'missing cache price is estimated at the input price (upper bound)', String(reviewer.estimatedMicroMinor.total));
  check(plan.warnings.some((entry) => entry.code === 'ESTIMATE_NOTE' && entry.role === 'reviewer'), 'the conservative upper bound is surfaced as a warning');
  check(planMember(plan, 'lead').estimatedMicroMinor.total === 2_441_800, 'lead estimate matches the offline arithmetic', String(planMember(plan, 'lead').estimatedMicroMinor.total));
  check(planMember(plan, 'worker').estimatedMicroMinor.total === 2_365_440, 'worker estimate matches the offline arithmetic', String(planMember(plan, 'worker').estimatedMicroMinor.total));
  check(plan.totals.estimatedComplete === true, 'all roles are estimated');
  check(plan.pricing.freshness === 'fresh', 'fresh snapshot is reported as fresh', plan.pricing.freshness);
  check(resolvePrice(validateSnapshot(snapshotRaw()), { provider: 'deepseek', model: 'deepseek-v4-pro' }).status === 'known',
    'alias target provider resolves');
  check(resolvePrice(validateSnapshot(snapshotRaw()), { provider: 'deepseek-official', model: 'deepseek-v4-pro' }).status === 'unknown',
    'no implicit alias: the DSH provider id alone does not resolve');
  check(planMember(plan, 'lead').priceLookup.aliased === true, 'the aliased lookup is recorded in the plan');
  check(planMember(plan, 'lead').priceLookup.provider === 'deepseek', 'the plan records which provider key was used for pricing');
  check(costForTokens(20000, 43_500_000) === 870_000, 'token cost uses integer micro units', String(costForTokens(20000, 43_500_000)));
  check(estimateRoleCost({
    price: { status: 'unknown', code: 'PRICE_UNKNOWN', detail: 'x' },
    perCall: { inputTokens: 1, outputTokens: 1 },
    calls: 1,
  }).microMinor === null, 'estimating an unknown price returns null, not zero');
}

// ------------------------------------------------------- 4. 预算不足

scenario('an estimate above its allocation blocks the plan');
{
  const plan = makePlan({
    config: configRaw({
      budget: {
        currency: 'USD',
        totalMinor: 3,
        allocations: [
          { role: 'lead', basisPoints: 3334 },
          { role: 'worker', basisPoints: 3333 },
          { role: 'reviewer', basisPoints: 3333 },
        ],
      },
    }),
  });
  check(hasCode(blockerCodes(plan), 'BUDGET_INSUFFICIENT'), 'insufficient allocation blocks the plan');
  check(plan.status === 'blocked', 'plan is blocked');
  check(plan.members.some((member) => member.withinAllocation === false), 'the offending member is flagged');
  check(plan.totals.withinTotalBudget === false, 'the total is flagged as over budget');
  check(plan.members.every((member) => typeof member.allocationMicroMinor === 'number'), 'every member still has an explicit allocation');
}

// --------------------------------------- 5. 后端可用性与调用计数边界

scenario('backend probing is explicit and never pretends to be executable');
{
  const notInstalled = probeAgentTeams({ hostVersion: '0.2.0-rc.2' });
  check(notInstalled.status === 'unavailable', 'uninstalled plugin is unavailable');
  check(notInstalled.reason === 'BACKEND_NOT_INSTALLED', 'uninstalled reason is explicit', notInstalled.reason);
  check(notInstalled.compatibility.recommendedHost === '0.2.1-rc.1', 'recommended host is recorded from compatibility.json');

  const allGood = {
    hostVersion: '0.2.0-rc.2',
    pluginInstalled: true,
    pluginVersion: AGENT_TEAMS_REVIEWED_VERSION,
    exports: ['name', 'inject', 'Config', 'usageSectionText', 'apply'],
    services: ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'],
  };
  const compatible = probeAgentTeams(allGood);
  check(compatible.status === 'compatible', 'matching host/version/exports is compatible', compatible.reason || compatible.detail);
  check(compatible.compatibility.hostTrack === 'legacy', 'the legacy track is recorded for 0.2.0-rc.2', compatible.compatibility.hostTrack);
  check(compatible.execution.implementation === 'not-implemented', 'compatibility does not imply an execution adapter');
  const mapped = backendStatusForPlan(compatible);
  check(mapped.status === 'compatible', 'compatibility is preserved instead of being flattened to unavailable', mapped.status);
  check(mapped.reason === 'BACKEND_EXECUTION_NOT_IMPLEMENTED', 'the blocking reason names the missing adapter', mapped.reason);
  check(mapped.execution.implementation === 'not-implemented', 'the execution dimension stays not-implemented');

  check(probeAgentTeams({ ...allGood, pluginVersion: '0.1.23' }).reason === 'BACKEND_VERSION_UNVERIFIED',
    'an unverified plugin version is rejected');
  check(probeAgentTeams({ ...allGood, hostVersion: '0.2.0-rc.1' }).reason === 'BACKEND_HOST_UNSUPPORTED',
    'an unlisted host version is rejected');
  check(probeAgentTeams({ ...allGood, exports: ['name'] }).reason === 'BACKEND_INTERFACE_UNVERIFIABLE',
    'a missing public export is rejected');
  check(probeAgentTeams({ ...allGood, services: ['tools'] }).reason === 'BACKEND_INTERFACE_UNVERIFIABLE',
    'missing injected services are rejected');

  const workflow = workflowScriptBackendStatus({ maxAgentCalls: 8 });
  check(workflow.status === 'ready', 'the verified workflow backend is ready');
  check(workflow.callAccounting.hardCapApplicable === true, 'the workflow backend has a real synchronous cap');
  check(workflow.callAccounting.synchronousLimit === 8, 'the cap matches maxAgentCalls', String(workflow.callAccounting.synchronousLimit));

  const agentTeamsPlan = makePlan({ backend: backendStatusForPlan(probeAgentTeams(allGood)) });
  check(hasCode(blockerCodes(agentTeamsPlan), 'BACKEND_EXECUTION_NOT_IMPLEMENTED'), 'agent-teams plans are blocked on the missing adapter');
  check(agentTeamsPlan.warnings.some((entry) => entry.code === 'CALL_CAP_PARTIAL'), 'the missing global call cap is surfaced as a warning');
  const accounting = agentTeamsPlan.callAccounting;
  check(accounting.hardCapApplicable === false, 'agent-teams accounting declares no hard cap');
  check(accounting.synchronousLimit === null, 'no synchronous limit is claimed for agent-teams');
  check(agentTeamsPlan.status === 'blocked', 'agent-teams plan is blocked');
  check(Array.isArray(agentTeamsPlan.notProofOf) && agentTeamsPlan.notProofOf.length > 0,
    'the plan states what it does not prove');

  const workflowPlan = makePlan();
  check(workflowPlan.warnings.every((entry) => entry.code !== 'CALL_CAP_PARTIAL'),
    'the workflow backend does not raise the partial-cap warning');
  check(workflowPlan.callAccounting.synchronousLimit === 8, 'the workflow plan carries the real cap');

  const executed = executePlan(agentTeamsPlan);
  check(executed.status === 'unavailable', 'executePlan never reports success');
  check(executed.code === 'BACKEND_EXECUTION_NOT_IMPLEMENTED', 'executePlan names the missing adapter', executed.code);
  check(executed.executedModelCalls === 0, 'executePlan performs zero model calls');
}

// --------------------------------------------------------- 6. 计划翻译

scenario('plan translation matches the agent-teams create contract without side effects');
{
  const plan = makePlan();
  const options = {
    teamName: 'demo-team',
    approval: 'required',
    tasks: [
      { id: 'T1', subject: 'implement', assignee: 'worker' },
      { id: 'T2', subject: 'review', assignee: 'reviewer', dependencies: ['T1'] },
    ],
  };
  const before = canonicalJson(plan);
  const call = translatePlanToAgentTeams(plan, options);
  check(canonicalJson(plan) === before, 'translation does not mutate the plan');
  check(Object.keys(call).sort().join(',') === 'approval,description,name,plan', 'top-level create fields are exact', Object.keys(call).join(','));
  check(call.name === 'demo-team', 'team name is carried over');
  check(call.approval === 'required', 'approval mode is carried over');
  check(call.plan.members.length === 3, 'all members are translated');
  const lead = call.plan.members.find((member) => member.name === 'lead');
  check(lead.provider === 'deepseek-official' && lead.model === 'deepseek-v4-pro', 'member route is preserved verbatim');
  check(lead.reasoning_effort === 'high', 'reasoning effort uses the plugin field name');
  check(!('fallback' in lead), 'no fallback is invented');
  check(call.plan.members.every((member) => Object.keys(member).every((key) =>
    ['name', 'role', 'provider', 'model', 'reasoning_effort'].includes(key))), 'members only carry known create fields');
  check(call.plan.tasks[1].dependencies[0] === 'T1', 'task dependencies are preserved');

  let missingTasks = null;
  try {
    translatePlanToAgentTeams(plan, { teamName: 'x', approval: 'required' });
  } catch (error) {
    missingTasks = error.code;
  }
  check(missingTasks === 'TASKS_MISSING', 'missing tasks are rejected', String(missingTasks));

  let badApproval = null;
  try {
    translatePlanToAgentTeams(plan, { teamName: 'x', approval: 'auto', tasks: [{ id: 'T1', subject: 's' }] });
  } catch (error) {
    badApproval = error.code;
  }
  check(badApproval === 'APPROVAL_INVALID', 'invalid approval mode is rejected', String(badApproval));

  let badPlan = null;
  try {
    translatePlanToAgentTeams({ schema: 'nope' }, options);
  } catch (error) {
    badPlan = error.code;
  }
  check(badPlan === 'PLAN_INVALID', 'a foreign plan schema is rejected', String(badPlan));

  const adapterSource = readFileSync(path.join(ROOT, 'orchestration', 'adapters', 'agent-teams.mjs'), 'utf8');
  check(!adapterSource.includes("from 'node:fs'"), 'the adapter does not import the filesystem module');
  check(!/writeFileSync|mkdirSync|appendFileSync|rmSync/.test(adapterSource), 'the adapter contains no filesystem write call');

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'tla-v02-nofs-'));
  try {
    const cwd = process.cwd();
    process.chdir(sandbox);
    try {
      translatePlanToAgentTeams(plan, options);
      executePlan(plan);
    } finally {
      process.chdir(cwd);
    }
    check(readdirSync(sandbox).length === 0, 'translation and executePlan write nothing to disk');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- 7. 持久化往返

scenario('configuration persistence is byte-stable and reloads to the same plan');
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tla-v02-config-'));
  try {
    const target = path.join(dir, 'nested', 'run-config.json');
    const configResult = validateConfig(configRaw());
    const saved = saveConfig(target, configResult.config);
    const bytes = readFileSync(target);
    check(createHash('sha256').update(bytes).digest('hex') === saved.fileDigest, 'the file digest covers the written bytes');
    check(saved.bytes === bytes.length, 'the reported byte count matches the file');
    const reloaded = loadConfigFromFile(target);
    check(configDigest(reloaded.config) === saved.configDigest, 'the reloaded config has the same config digest');
    check(canonicalJson(reloaded.config) === canonicalJson(configResult.config), 'the reloaded config is byte-identical after normalization');
    const text = readFileSync(target, 'utf8');
    check(text.endsWith('\n'), 'the saved file ends with a newline');
    check(canonicalJson(JSON.parse(text)) === canonicalJson(reloaded.config), 'the file content is the canonical form');

    const shuffled = JSON.parse(text);
    const reordered = JSON.parse(canonicalJson(shuffled));
    check(canonicalJson(reordered) === canonicalJson(reloaded.config), 'key order in the source file does not change the digest');
    check(configDigest(reordered) === configDigest(reloaded.config), 'digest is independent of JSON key order');

    const planFromFile = buildPlan({
      configResult: reloaded,
      snapshot: loadSnapshotFromFile(path.join(ROOT, 'orchestration', 'data', 'pricing-snapshot.portkey-72e1084.json')),
      nowMs: FIXED_NOW,
      backend: workflowScriptBackendStatus({ maxAgentCalls: 8 }),
    });
    check(planFromFile.runId === configRaw().runId, 'the reloaded config keeps the run id');
    check(planFromFile.members.length === 3, 'the reloaded config produces the same member count');

    let rejected = null;
    try {
      saveConfig(path.join(dir, 'bad.json'), { schema: 'nope' });
    } catch (error) {
      rejected = error.code;
    }
    check(rejected === 'CONFIG_INVALID', 'invalid configuration is never written', String(rejected));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------- 8. 价格导入

scenario('portkey importer converts units and refuses ambiguous data');
{
  const deepseekText = JSON.stringify({
    default: { currency: 'USD' },
    'deepseek-v4-flash': {
      pricing_config: {
        pay_as_you_go: {
          request_token: { price: 0.000014 },
          response_token: { price: 0.000028 },
          cache_read_input_token: { price: 0.00000028 },
        },
      },
    },
  });
  check(centsPerTokenToMicroMinorPerMillion(0.000014) === 14_000_000, 'cents per token converts to micro units per million',
    String(centsPerTokenToMicroMinorPerMillion(0.000014)));
  check(centsPerTokenToMicroMinorPerMillion(0.00000028) === 280_000, 'cache price keeps its own scale', String(centsPerTokenToMicroMinorPerMillion(0.00000028)));
  check(Number.isInteger(centsPerTokenToMicroMinorPerMillion(0.0000435)), 'a fractional cents value stays an integer');

  let notIntegral = null;
  try {
    centsPerTokenToMicroMinorPerMillion(1e-13);
  } catch (error) {
    notIntegral = error.code;
  }
  check(notIntegral === 'PORTKEY_PRICE_NOT_INTEGRAL', 'a price finer than one micro unit is rejected', String(notIntegral));

  let duplicate = null;
  try {
    parseJsonStrict('{"a":1,"a":2}', 'dup.json');
  } catch (error) {
    duplicate = error.code;
  }
  check(duplicate === 'PORTKEY_DUPLICATE_KEY', 'duplicate JSON keys are rejected instead of silently collapsing', String(duplicate));

  const entries = extractProviderEntries({
    text: deepseekText,
    filePath: 'pricing/deepseek.json',
    provider: 'deepseek',
    models: ['deepseek-v4-flash'],
    repository: 'portkey-models',
    commit: '72e1084840af7e14350ff6a12d33255a878bbec5',
    currency: 'USD',
  });
  check(entries.length === 1, 'one entry per requested model');
  check(entries[0].inputMicroMinorPerMillion === 14_000_000, 'input price is carried over');
  check(entries[0].unknownFields.includes('offPeakPricing'), 'off-peak pricing is marked unknown when the source has no field');

  let currencyMismatch = null;
  try {
    extractProviderEntries({
      text: deepseekText,
      filePath: 'pricing/deepseek.json',
      provider: 'deepseek',
      models: ['deepseek-v4-flash'],
      repository: 'portkey-models',
      commit: '72e1084840af7e14350ff6a12d33255a878bbec5',
      currency: 'CNY',
    });
  } catch (error) {
    currencyMismatch = error.code;
  }
  check(currencyMismatch === 'PORTKEY_CURRENCY_MISMATCH', 'a currency mismatch is rejected', String(currencyMismatch));

  let unpriced = null;
  try {
    extractProviderEntries({
      text: JSON.stringify({ default: { currency: 'USD' }, 'x': { pricing_config: {} } }),
      filePath: 'pricing/x.json',
      provider: 'x',
      models: ['x'],
      repository: 'portkey-models',
      commit: '72e1084840af7e14350ff6a12d33255a878bbec5',
      currency: 'USD',
    });
  } catch (error) {
    unpriced = error.code;
  }
  check(unpriced === 'PORTKEY_UNPRICED', 'a model without pay-as-you-go pricing is rejected', String(unpriced));

  const dir = mkdtempSync(path.join(os.tmpdir(), 'tla-v02-pricing-'));
  try {
    const filePath = path.join(dir, 'deepseek.json');
    writeFileSync(filePath, deepseekText, 'utf8');
    const built = buildSnapshotFromPortkey({
      sources: [{ filePath, provider: 'deepseek', models: ['deepseek-v4-flash'] }],
      repository: 'portkey-models',
      commit: '72e1084840af7e14350ff6a12d33255a878bbec5',
      license: 'MIT',
      capturedAt: '2026-10-17T17:00:00Z',
      snapshotId: 'imported-1',
    });
    const validated = validateSnapshot(built);
    check(validated.entries.length === 1, 'the importer produces a snapshot that passes validation', String(validated.entries.length));
    check(validated.entries[0].provider === 'deepseek', 'the imported entry keeps its provider key');
    check(validated.source.repository === 'portkey-models', 'the imported snapshot records its source repository');
    check(validated.source.commit === '72e1084840af7e14350ff6a12d33255a878bbec5', 'the imported snapshot records the source commit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const shipped = validateSnapshot(loadSnapshotFileRaw());
  check(shipped.currency === 'USD', 'the shipped snapshot is USD');
  check(shipped.entries.length === 6, 'the shipped snapshot keeps six pinned entries', String(shipped.entries.length));
  check(shipped.source.commit === '72e1084840af7e14350ff6a12d33255a878bbec5', 'the shipped snapshot records the source commit');
  check(shipped.entries.every((entry) => Number.isInteger(entry.prices.inputMicroMinorPerMillion)), 'all shipped input prices are integers');
  check(shipped.entries.every((entry) => !/^[A-Za-z]:|\\/.test(entry.provenance)),
    'shipped provenance uses repository paths, never local absolute paths');
  check(shipped.entries.every((entry) => entry.unknownFields.includes('offPeakPricing')),
    'the shipped snapshot marks off-peak pricing as unknown');
  const shippedText = readFileSync(path.join(ROOT, 'orchestration', 'data', 'pricing-snapshot.portkey-72e1084.json'), 'utf8');
  check(!/[A-Za-z]:\\/.test(shippedText) && !/[A-Za-z]:\/(?!\/)/.test(shippedText) && !shippedText.includes('Clone Repository'),
    'the shipped snapshot file contains no local absolute path');
  check(shipped.source.files.length === 3 && shipped.source.files.every((file) => file.startsWith('pricing/')),
    'shipped source files are repository-relative', JSON.stringify(shipped.source.files));
  check(formatMicro('USD', 2_500_000_000) === 'USD 25', 'micro units format to whole major units', formatMicro('USD', 2_500_000_000));
  check(formatMicro('USD', 44_180) === 'USD 0.0004418', 'micro units keep sub-cent precision', formatMicro('USD', 44_180));
}

function loadSnapshotFileRaw() {
  return JSON.parse(readFileSync(path.join(ROOT, 'orchestration', 'data', 'pricing-snapshot.portkey-72e1084.json'), 'utf8'));
}

// ------------------- 9. 复审回归：五维就绪、向上取整、缓存写价格

scenario('review regressions: readiness dimensions, ceiling costs and cache-write pricing');
{
  const workflowPlan = makePlan();
  check(workflowPlan.readiness.configValid === true, 'config dimension is reported separately');
  check(workflowPlan.readiness.estimatesAvailable === true, 'estimate dimension is reported separately');
  check(workflowPlan.readiness.backendCompatible === true, 'compatibility dimension is reported separately');
  check(workflowPlan.readiness.executionImplemented === true, 'the verified workflow backend counts as implemented');
  check(workflowPlan.readiness.budgetProtection === 'call-count-hard-cap', 'the workflow backend has a real pre-call cap', String(workflowPlan.readiness.budgetProtection));
  check(workflowPlan.executable === true && workflowPlan.status === 'ready', 'a fully implemented backend is executable');
  check(workflowPlan.missingForExecution.length === 0, 'nothing is missing for execution on the workflow backend');

  const allGood = {
    hostVersion: '0.2.0-rc.2',
    pluginInstalled: true,
    pluginVersion: AGENT_TEAMS_REVIEWED_VERSION,
    exports: ['name', 'inject', 'Config', 'usageSectionText', 'apply'],
    services: ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'],
  };
  const compatible = probeAgentTeams(allGood);
  const agentTeamsPlan = makePlan({ backend: backendStatusForPlan(compatible) });
  check(agentTeamsPlan.readiness.backendCompatible === true, 'agent-teams records compatibility as its own dimension');
  check(agentTeamsPlan.readiness.executionImplemented === false, 'compatibility never implies an implemented adapter');
  check(agentTeamsPlan.readiness.budgetProtection === 'allocation-plan-only', 'agent-teams can only offer a plan allocation', String(agentTeamsPlan.readiness.budgetProtection));
  check(agentTeamsPlan.executable === false, 'agent-teams is not executable');
  check(agentTeamsPlan.missingForExecution.includes('BACKEND_EXECUTION_NOT_IMPLEMENTED'), 'the missing adapter is a named readiness gap');
  check(agentTeamsPlan.missingForExecution.includes('CALL_CAP_NOT_ENFORCEABLE'), 'the missing pre-call counter is a named readiness gap');
  check(agentTeamsPlan.status === 'blocked', 'agent-teams stays blocked');

  const directProbePlan = makePlan({ backend: compatible });
  check(directProbePlan.executable === false, 'a compatible probe alone must never be executable (the old code said ready)');
  check(directProbePlan.status === 'blocked', 'feeding the raw probe result still blocks the plan');
  check(hasCode(blockerCodes(directProbePlan), 'BACKEND_EXECUTION_NOT_IMPLEMENTED'),
    'the raw probe path still reports the missing adapter');

  check(divRoundHalfUp(1, 1_000_000) === 0, 'half-up truncates a single micro unit to zero (the old defect)');
  check(costForTokens(1, 1) === 1, 'a single token is charged at least one micro unit (ceiling)');
  check(costForTokens(3, 1) === 1, 'three tokens are not rounded down to zero');
  check(divCeil(1, 1_000_000) === 1, 'ceiling division never returns zero for a positive numerator');
  check(costForTokens(20_000, 43_500_000) === 870_000, 'integral products are unchanged by the ceiling');
  check(costForTokens(3, 28_000_000) === 84, 'in-range products stay exact');

  const badInputs = [
    ['costForTokens(-1, 1)', () => costForTokens(-1, 1), 'MONEY_NOT_INTEGER'],
    ['costForTokens(1, -1)', () => costForTokens(1, -1), 'MONEY_NOT_INTEGER'],
    ['costForTokens(1.5, 1)', () => costForTokens(1.5, 1), 'MONEY_NOT_INTEGER'],
    ['costForTokens(NaN, 1)', () => costForTokens(NaN, 1), 'MONEY_NOT_INTEGER'],
    ['costForTokens(Infinity, 1)', () => costForTokens(Infinity, 1), 'MONEY_NOT_INTEGER'],
    ['costForTokens(MAX_SAFE_INTEGER, 2)', () => costForTokens(Number.MAX_SAFE_INTEGER, 2), 'MONEY_OVERFLOW'],
    ['divCeil(MAX_SAFE_INTEGER, 2)', () => divCeil(Number.MAX_SAFE_INTEGER, 2), 'MONEY_OVERFLOW'],
    ['divRoundHalfUp(2**52+1, 1)', () => divRoundHalfUp(2 ** 52 + 1, 1), 'MONEY_OVERFLOW'],
  ];
  for (const [label, run, expected] of badInputs) {
    let code = null;
    try { run(); } catch (error) { code = error.code; }
    check(code === expected, label + ' is rejected with ' + expected, String(code));
  }

  const pricedPrice = {
    status: 'known',
    prices: { inputMicroMinorPerMillion: 14_000_000, outputMicroMinorPerMillion: 28_000_000, cacheReadMicroMinorPerMillion: 280_000 },
    provenance: 'test-fixture',
    unknownFields: [],
  };
  const writeUnknown = estimateRoleCost({
    price: { ...pricedPrice, unknownFields: ['cacheWritePricing'] },
    perCall: { inputTokens: 20000, outputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 10000 },
    calls: 1,
  });
  check(writeUnknown.microMinor.cacheWrite === 140_000, 'unknown cache-write price is estimated at the input price (upper bound)', String(writeUnknown.microMinor.cacheWrite));
  check(writeUnknown.microMinor.total === 532_000, 'cache-write cost is part of the total', String(writeUnknown.microMinor.total));
  check(writeUnknown.conservative === true && writeUnknown.unknownFields.includes('cacheWrite'), 'the upper bound is declared, not hidden');

  const writeKnown = estimateRoleCost({
    price: { ...pricedPrice, prices: { ...pricedPrice.prices, cacheWriteMicroMinorPerMillion: 0 } },
    perCall: { inputTokens: 20000, outputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 10000 },
    calls: 1,
  });
  check(writeKnown.microMinor.cacheWrite === 0, 'a known zero cache-write price stays zero');
  check(writeKnown.unknownFields.includes('cacheWrite') === false, 'a known cache-write price is not reported as unknown');
  check(writeKnown.status === 'known', 'expenses without unknown prices are complete', writeKnown.status);

  const cacheWriteText = JSON.stringify({
    default: { currency: 'USD' },
    'cache-model': {
      pricing_config: {
        pay_as_you_go: {
          request_token: { price: 0.000014 },
          response_token: { price: 0.000028 },
          cache_write_input_token: { price: 0.0000001 },
        },
      },
    },
  });
  const importedWithWrite = extractProviderEntries({
    text: cacheWriteText,
    filePath: 'pricing/cache.json',
    provider: 'cache',
    models: ['cache-model'],
    repository: 'portkey-models',
    commit: '72e1084840af7e14350ff6a12d33255a878bbec5',
    currency: 'USD',
  });
  check(importedWithWrite[0].cacheWriteMicroMinorPerMillion === 100_000, 'cache_write_input_token is imported, not dropped', String(importedWithWrite[0].cacheWriteMicroMinorPerMillion));
  check(importedWithWrite[0].unknownFields.includes('cacheWritePricing') === false, 'an imported cache-write price is not unknown');

  const importedWithoutWrite = extractProviderEntries({
    text: JSON.stringify({
      default: { currency: 'USD' },
      'no-cache-model': { pricing_config: { pay_as_you_go: { request_token: { price: 0.000014 }, response_token: { price: 0.000028 } } } },
    }),
    filePath: 'pricing/no-cache.json',
    provider: 'nocache',
    models: ['no-cache-model'],
    repository: 'portkey-models',
    commit: '72e1084840af7e14350ff6a12d33255a878bbec5',
    currency: 'USD',
  });
  check(importedWithoutWrite[0].unknownFields.includes('cacheWritePricing'), 'a missing cache-write price is declared unknown');

  const tied = allocateByBasisPoints(5, [
    { role: 'a', basisPoints: 2500 },
    { role: 'b', basisPoints: 2500 },
    { role: 'c', basisPoints: 2500 },
    { role: 'd', basisPoints: 2500 },
  ]);
  check(tied.get('a') === 2 && tied.get('b') === 1 && tied.get('c') === 1 && tied.get('d') === 1,
    'equal remainders break ties by declaration order', JSON.stringify([...tied]));
  check([...tied.values()].reduce((sum, value) => sum + value, 0) === 5, 'the tied allocation still conserves the total');
  const reordered = allocateByBasisPoints(5, [
    { role: 'd', basisPoints: 2500 },
    { role: 'c', basisPoints: 2500 },
    { role: 'b', basisPoints: 2500 },
    { role: 'a', basisPoints: 2500 },
  ]);
  check(reordered.get('d') === 2 && reordered.get('a') === 1, 'reordering the input moves the remainder deterministically');
  check([...reordered.values()].reduce((sum, value) => sum + value, 0) === 5, 'reordering never breaks conservation');
}

// ---------------------------------------------------------------- report

process.stdout.write('\n' + scenarios + ' scenarios, ' + checks + ' checks, ' + failures.length + ' failure(s)\n');
if (failures.length > 0) {
  for (const failure of failures) {
    process.stdout.write('FAILED: ' + failure.label + (failure.detail === undefined ? '' : ' — ' + failure.detail) + '\n');
  }
  process.exitCode = 1;
}
