// orchestration/plan.mjs
//
// 把"已校验配置 + 离线价格快照 + 后端探测结果"组装成可检查的运行计划。
//
// 这个模块**不启动任何代理**，也不写证据目录；它的输出是给人看的计划与阻断原因。
// 计划里每个角色都记录 model 来自 manual 选择，且没有可覆盖它的自动路由。
//
// 阻断（blocker）与警告（warning）分开：
// - blocker：计划不可执行（价格未知/过期、币种不一致、预算不足、后端不可用）；
// - warning：可以执行但结论有限（缓存价未知、峰谷价未知、后端自动唤醒无法计数）。

import { PLAN_SCHEMA, canonicalJson, digest } from './config.mjs';
import { ESTIMATE_LIMITATIONS, ESTIMATE_BASIS, estimateRoleCost } from './estimate.mjs';
import { formatMicro, microFromMinor } from './money.mjs';
import { checkFreshness, resolvePrice } from './pricing.mjs';

export const PLAN_LIMITATIONS = [
  ...ESTIMATE_LIMITATIONS,
  '本计划是配置与规划产物：不启动代理、不调用模型、不写证据、不安装插件。',
  '计划里的预算比例是分配方案，不是已扣金额；不构成付款、供应商余额或跨平台资金划拨。',
];

export const PLAN_NOT_PROOF_OF = [
  '没有证明任何模型可用、可计费或能完成真实任务',
  '没有证明第三方插件已安装、版本兼容或接口语义正确',
  '没有证明价格与供应商当前实际价格一致（快照有采集时间与来源，但不是实时）',
  '没有证明预算能强制扣费：编排层只能限制调用次数',
];

function blockersFromFreshness(freshness) {
  if (freshness.status === 'fresh') return [];
  if (freshness.status === 'future') {
    return [{ code: 'PRICE_SNAPSHOT_FUTURE', detail: '快照采集时间晚于当前时间（' + freshness.ageHours.toFixed(2) + ' 小时），时钟不可信，拒绝估算' }];
  }
  return [{ code: 'PRICE_STALE', detail: '快照已过期：' + freshness.ageHours.toFixed(2) + ' 小时 > 上限 ' + freshness.maxAgeHours + ' 小时' }];
}

/**
 * @param {{configResult:object, snapshot:object, nowMs:number, backend:object}} input
 * @returns {object} 计划（可直接 JSON 序列化）
 */
export function buildPlan({ configResult, snapshot, nowMs, backend }) {
  if (!configResult || configResult.ok !== true) {
    throw new Error('buildPlan 需要校验通过的配置');
  }
  const config = configResult.config;
  const shares = configResult.shares;
  const freshness = checkFreshness(snapshot, { nowMs, maxAgeHours: config.pricing.maxAgeHours });
  const blockers = [];
  const warnings = [];
  if (freshness.status !== 'fresh') blockers.push(...blockersFromFreshness(freshness));
  if (snapshot.currency !== config.budget.currency) {
    blockers.push({
      code: 'CURRENCY_MISMATCH',
      detail: '价格快照币种 ' + snapshot.currency + ' 与预算币种 ' + config.budget.currency + ' 不同，且没有汇率依据',
    });
  }
  const roles = Object.keys(config.roles);
  const estimates = config.estimates || { perCall: { inputTokens: 0, outputTokens: 0 }, calls: {} };
  const members = roles.map((roleName) => {
    const role = config.roles[roleName];
    // 价格快照用的是供应商自己的 provider 名（portkey 文件名），DSH 的 provider id 可能不同；
    // 只有配置里显式声明 providerAliases 时才换名查价，且计划里如实记录查价用的 provider。
    const aliases = config.pricing.providerAliases || {};
    const lookupProvider = aliases[role.provider] === undefined ? role.provider : aliases[role.provider];
    const price = resolvePrice(snapshot, { provider: lookupProvider, model: role.model });
    const estimate = estimateRoleCost({
      price,
      perCall: estimates.perCall,
      calls: estimates.calls[roleName] === undefined ? 1 : estimates.calls[roleName],
    });
    const allocation = shares === null ? null : shares.get(roleName);
    const withinAllocation = allocation === null || allocation === undefined || estimate.microMinor === null
      ? null
      : estimate.microMinor.total <= allocation;
    if (price.status !== 'known') {
      blockers.push({ code: price.code, role: roleName, detail: price.detail });
    }
    if (withinAllocation === false) {
      blockers.push({
        code: 'BUDGET_INSUFFICIENT',
        role: roleName,
        detail: '估算 ' + formatMicro(snapshot.currency, estimate.microMinor.total) +
          ' 超过该角色分配 ' + formatMicro(config.budget.currency, allocation),
      });
    }
    for (const note of estimate.notes || []) warnings.push({ code: 'ESTIMATE_NOTE', role: roleName, detail: note });
    return {
      role: roleName,
      provider: role.provider,
      model: role.model,
      selection: role.selection,
      selectionSource: 'config (manual)',
      reasoningEffort: role.reasoningEffort === undefined ? null : role.reasoningEffort,
      isOwner: roleName === config.ownerRole,
      priceStatus: price.status,
      priceProvenance: price.status === 'known' ? price.provenance : null,
      priceLookup: { provider: lookupProvider, model: role.model, aliased: lookupProvider !== role.provider },
      calls: estimate.calls,
      estimatedMicroMinor: estimate.microMinor,
      allocationMicroMinor: allocation === undefined ? null : allocation,
      withinAllocation,
      unknownFields: estimate.unknownFields || [],
    };
  });
  const known = members.filter((member) => member.estimatedMicroMinor !== null);
  const estimatedTotal = known.reduce((acc, member) => acc + member.estimatedMicroMinor.total, 0);
  const unestimated = members.filter((member) => member.estimatedMicroMinor === null).map((member) => member.role);
  const budgetMicro = config.budget.totalMinor === null ? null : microFromMinor(config.budget.totalMinor);
  const backendStatus = backend || { kind: config.backend === null ? 'unknown' : config.backend.kind, status: 'unavailable', reason: 'BACKEND_NOT_PROBED' };
  if (backendStatus.status !== 'ready') {
    blockers.push({ code: backendStatus.reason || 'BACKEND_UNAVAILABLE', detail: backendStatus.detail || '后端不可用' });
  }
  if (backendStatus.callAccounting && backendStatus.callAccounting.hardCapApplicable !== true) {
    warnings.push({
      code: 'CALL_CAP_PARTIAL',
      detail: '后端 ' + backendStatus.kind + '：' +
        (backendStatus.callAccounting.note || '无法证明每次实际模型调用都被计数'),
    });
  }
  const plan = {
    schema: PLAN_SCHEMA,
    runId: config.runId,
    generatedFrom: { configDigest: digest(canonicalJson(config)), estimateBasis: ESTIMATE_BASIS },
    currency: config.budget.currency,
    pricing: {
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      ageHours: Number(freshness.ageHours.toFixed(3)),
      freshness: freshness.status,
      source: snapshot.source,
    },
    routerGuard: {
      mode: 'manual-pinned',
      autoRoutingEnabled: false,
      overridable: false,
      note: '本阶段没有任何自动路由/自动 fallback：每个角色的 provider/model 只能来自配置，且配置校验拒绝 router.enabled=true。',
    },
    owner: config.ownerRole,
    members,
    totals: {
      allocationMicroMinor: budgetMicro,
      estimatedKnownMicroMinor: estimatedTotal,
      estimatedComplete: unestimated.length === 0,
      unestimatedRoles: unestimated,
      remainingMicroMinor: budgetMicro === null ? null : budgetMicro - estimatedTotal,
      withinTotalBudget: unestimated.length === 0 && budgetMicro !== null ? estimatedTotal <= budgetMicro : null,
    },
    backend: backendStatus,
    callAccounting: {
      mode: backendStatus.callAccounting ? backendStatus.callAccounting.mode : 'unknown',
      hardCapApplicable: backendStatus.callAccounting ? backendStatus.callAccounting.hardCapApplicable === true : false,
      synchronousLimit: backendStatus.callAccounting ? backendStatus.callAccounting.synchronousLimit : null,
    },
    budgetEnforcement: 'allocation-plan-only',
    status: blockers.length === 0 ? 'ready' : 'blocked',
    blockers,
    warnings,
    limitations: [...PLAN_LIMITATIONS, ...(backendStatus.limitations || [])],
    notProofOf: [...PLAN_NOT_PROOF_OF, ...(backendStatus.notProofOf || [])],
  };
  return plan;
}

export function planDigest(plan) {
  return digest(canonicalJson(plan));
}
