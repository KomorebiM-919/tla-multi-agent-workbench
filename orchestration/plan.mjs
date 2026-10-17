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
import { comparePlanRoutes } from './host-catalog.mjs';
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
  '没有证明预算能强制扣费：编排层最多只能同步限制"代理启动次数"，不限制模型请求次数与 token 用量',
];

function blockersFromFreshness(freshness) {
  if (freshness.status === 'fresh') return [];
  if (freshness.status === 'future') {
    return [{ code: 'PRICE_SNAPSHOT_FUTURE', detail: '快照采集时间晚于当前时间（' + freshness.ageHours.toFixed(2) + ' 小时），时钟不可信，拒绝估算' }];
  }
  return [{ code: 'PRICE_STALE', detail: '快照已过期：' + freshness.ageHours.toFixed(2) + ' 小时 > 上限 ' + freshness.maxAgeHours + ' 小时' }];
}

/**
 * @param {{configResult:object, snapshot:object, nowMs:number, backend:object, hostCatalog?:object}} input
 * @returns {object} 计划（可直接 JSON 序列化）
 */
export function buildPlan({ configResult, snapshot, nowMs, backend, hostCatalog }) {
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
  const catalogEntries = [];
  const members = roles.map((roleName) => {
    const role = config.roles[roleName];
    // 价格快照用的是供应商自己的 provider 名（portkey 文件名），DSH 的 provider id 可能不同；
    // 只有配置里显式声明 providerAliases 时才换名查价，且计划里如实记录查价用的 provider。
    const aliases = config.pricing.providerAliases || {};
    const lookupProvider = aliases[role.provider] === undefined ? role.provider : aliases[role.provider];
    // channel 是计费渠道：只有价格确实来自该渠道时才能用于该角色的预算判断。
    const price = resolvePrice(snapshot, { provider: lookupProvider, model: role.model, channel: role.channel });
    const estimate = estimateRoleCost({
      price,
      perCall: estimates.perCall,
      calls: estimates.calls[roleName] === undefined ? 1 : estimates.calls[roleName],
      assumptions: estimates.assumptions,
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
    if (estimate.status === 'assumed') {
      warnings.push({
        code: 'ESTIMATE_ASSUMED',
        role: roleName,
        detail: '该角色金额依赖配置声明的假设（' + estimate.assumedFields.join(', ') + '），可信度 low，不能当作"预算内"的证明',
      });
    }
    if (estimate.status === 'partial') {
      warnings.push({
        code: 'ESTIMATE_PARTIAL',
        role: roleName,
        detail: '有价格维度未知（' + estimate.unknownFields.join(', ') + '），金额是按已知单价算的，不是完整口径',
      });
    }
    if (price.status === 'known' && price.channelSpecified !== true) {
      warnings.push({
        code: 'PRICE_CHANNEL_UNSPECIFIED',
        role: roleName,
        detail: '角色没有声明计费渠道，价格来自快照中的唯一渠道 ' + (price.channel === null ? '(未声明)' : price.channel) +
          '；如果实际按另一渠道计费，这个金额不能作为预算依据',
      });
    }
    catalogEntries.push({
      role: roleName,
      // 宿主目录比对的必须是**实际执行**的 provider/model，而不是查价用的别名 provider，
      // 否则会把"宿主里有没有这个模型"问成"价格快照里有没有这个文件"。
      provider: role.provider,
      model: role.model,
      channel: role.channel === undefined ? null : role.channel,
      price,
    });
    return {
      role: roleName,
      provider: role.provider,
      model: role.model,
      channel: role.channel === undefined ? null : role.channel,
      selection: role.selection,
      selectionSource: 'config (manual)',
      reasoningEffort: role.reasoningEffort === undefined ? null : role.reasoningEffort,
      isOwner: roleName === config.ownerRole,
      priceStatus: price.status,
      priceProvenance: price.status === 'known' ? price.provenance : null,
      priceLookup: {
        provider: lookupProvider,
        model: role.model,
        channel: price.status === 'known' ? price.channel : null,
        aliased: lookupProvider !== role.provider,
      },
      estimateStatus: estimate.status,
      estimateConfidence: estimate.confidence,
      assumedFields: estimate.assumedFields || [],
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
  // 依赖假设算出来的金额不能用来宣布"预算内"：那种结论需要真实单价，不是用户选的假设。
  const assumedRoles = members.filter((member) => member.estimateStatus === 'assumed').map((member) => member.role);
  // 宿主目录（可选）：只回答"宿主里有没有这个 provider/model、走的是哪个计费渠道、
  // 价格快照与宿主目录价是否冲突"。没有提供就明确标 provided:false，绝不假装比对过。
  const missing = [];
  let hostCatalogSection = { provided: false, note: '未提供宿主目录快照：本计划没有核对宿主实际模型与计费渠道' };
  let hostRouteVerified = null;
  if (hostCatalog) {
    const comparison = comparePlanRoutes(hostCatalog, catalogEntries);
    for (const item of comparison.checked) {
      if (item.status === 'unlisted') {
        warnings.push({ code: 'HOST_CATALOG_MODEL_UNLISTED', role: item.role, detail: item.detail });
      } else if (item.channelMatches === false) {
        warnings.push({ code: 'HOST_CATALOG_CHANNEL_MISMATCH', role: item.role, detail: item.detail });
      }
      if (item.priceConflict === true) {
        warnings.push({ code: 'PRICE_DIVERGES_FROM_HOST_CATALOG', role: item.role, detail: item.detail });
      } else if (item.priceChannelDiffers === true) {
        warnings.push({ code: 'HOST_CATALOG_PRICE_CHANNEL_DIFFERS', role: item.role, detail: item.detail });
      }
    }
    // 宿主目录里根本没有的模型，无法核对"能不能发、按哪个渠道计费"：
    // 这是就绪维度上的缺口，不能只当提示。同渠道价格与目录价不一致同理——
    // 预算依据本身就是错的，不能让计划继续宣称"预算内"。
    hostRouteVerified = comparison.unlistedRoles.length === 0;
    if (comparison.unlistedRoles.length > 0) {
      blockers.push({
        code: 'HOST_CATALOG_MODEL_UNLISTED',
        detail: '宿主目录里没有这些角色的 provider/model: ' + comparison.unlistedRoles.join(', ') +
          '；未列出的 id 只会被当文本路由透传，无法确认已配置或可计费',
      });
      missing.push('HOST_ROUTE_UNVERIFIED');
    }
    if (comparison.priceConflictRoles.length > 0) {
      blockers.push({
        code: 'PRICE_DIVERGES_FROM_HOST_CATALOG',
        detail: '这些角色的价格与宿主目录同渠道目录价不一致: ' + comparison.priceConflictRoles.join(', ') +
          '；预算依据不可信，需先确认实际单价',
      });
    }
    hostCatalogSection = {
      provided: true,
      catalogId: comparison.catalogId,
      capturedAt: comparison.capturedAt,
      unlistedRoles: comparison.unlistedRoles,
      channelMismatchRoles: comparison.channelMismatchRoles,
      priceConflictRoles: comparison.priceConflictRoles,
      checked: comparison.checked.map((item) => ({
        role: item.role,
        status: item.status,
        channelMatches: item.channelMatches,
        priceConflict: item.priceConflict,
      })),
    };
  }
  const budgetMicro = config.budget.totalMinor === null ? null : microFromMinor(config.budget.totalMinor);
  const backendStatus = backend || { kind: config.backend === null ? 'unknown' : config.backend.kind, status: 'unavailable', reason: 'BACKEND_NOT_PROBED' };
  const backendUsable = backendStatus.status === 'ready' || backendStatus.status === 'compatible';
  if (!backendUsable) {
    blockers.push({ code: backendStatus.reason || 'BACKEND_UNAVAILABLE', detail: backendStatus.detail || '后端不可用' });
  }
  // 五个维度分开列：配置有效、估算可用、后端兼容、执行实现、预算保护。
  // 任何必要项缺失，计划就不得叫 ready —— 尤其是"插件装了、兼容探测通过"不等于"能执行"。
  // 估算"可用"只接受 known / partial：partial 的未知维度只会影响口径完整性，
  // 金额本身仍按真实单价算；assumed 是拿输入价顶替未知单价，必须继续算缺口。
  const estimatesAvailable = members.every((member) => member.estimateStatus === 'known' || member.estimateStatus === 'partial');
  const confidenceRank = { high: 3, medium: 2, low: 1, none: 0 };
  const estimateConfidence = members.reduce((worst, member) =>
    confidenceRank[member.estimateConfidence] < confidenceRank[worst] ? member.estimateConfidence : worst, 'high');
  const backendCompatible = backendUsable;
  const executionImplemented = Boolean(backendStatus.execution)
    && backendStatus.execution.implementation === 'implemented';
  const hardCallCap = Boolean(backendStatus.callAccounting)
    && backendStatus.callAccounting.hardCapApplicable === true;
  const readiness = {
    configValid: true,
    estimatesAvailable,
    estimateConfidence,
    backendCompatible,
    executionImplemented,
    budgetProtection: hardCallCap ? 'call-count-hard-cap' : 'allocation-plan-only',
    // null = 没提供宿主目录，没核对过；false = 核对过且发现模型不在目录里。
    hostRouteVerified,
  };
  if (!estimatesAvailable) {
    missing.push('ESTIMATES_INCOMPLETE');
    blockers.push({
      code: 'ESTIMATES_INCOMPLETE',
      detail: '缺少价格、无法给出金额的角色: ' + members
        .filter((member) => member.estimatedMicroMinor === null)
        .map((member) => member.role + '(' + member.unknownFields.join('|') + ')')
        .join(', ') + '；金额未知时不做"预算内"判断',
    });
  }
  if (assumedRoles.length > 0) {
    if (!blockers.some((blocker) => blocker.code === 'ESTIMATES_ASSUMED')) {
      blockers.push({
        code: 'ESTIMATES_ASSUMED',
        detail: '角色 ' + assumedRoles.join(', ') + ' 的金额依赖配置声明的估算假设，不能作为"预算内"的依据',
      });
    }
  }
  if (!backendCompatible) missing.push('BACKEND_UNAVAILABLE');
  if (backendCompatible && !executionImplemented) {
    missing.push('BACKEND_EXECUTION_NOT_IMPLEMENTED');
    if (!blockers.some((blocker) => blocker.code === 'BACKEND_EXECUTION_NOT_IMPLEMENTED')) {
      blockers.push({
        code: 'BACKEND_EXECUTION_NOT_IMPLEMENTED',
        detail: (backendStatus.execution && backendStatus.execution.detail) || '后端执行适配未实现',
      });
    }
  }
  // 调用计数是独立缺口：即使执行适配还没实现，也能确定该后端不提供"调用前同步计数"，
  // 所以这一项照样列进 missing，不能被"执行未实现"掩盖过去。
  if (backendCompatible && !hardCallCap) {
    missing.push('CALL_CAP_NOT_ENFORCEABLE');
    blockers.push({
      code: 'CALL_CAP_NOT_ENFORCEABLE',
      detail: '后端无法在每次模型调用前同步计数：预算保护只能是计划分配，不能当强制限制',
    });
  }
  const executable = missing.length === 0 && blockers.length === 0;
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
      assumptionBasedRoles: assumedRoles,
      unestimatedRoles: unestimated,
      remainingMicroMinor: budgetMicro === null ? null : budgetMicro - estimatedTotal,
      withinTotalBudget: unestimated.length === 0 && assumedRoles.length === 0 && budgetMicro !== null
        ? estimatedTotal <= budgetMicro
        : null,
      // "两个不同模型"和"两个不同 provider"是两件事：同一 provider 下的两个模型
      // 不能用来声称跨 provider 协作，所以两个计数分开给出。
      distinctModels: new Set(members.map((member) => member.provider + '/' + member.model)).size,
      distinctProviders: new Set(members.map((member) => member.provider)).size,
      coverage: {
        multiModel: new Set(members.map((member) => member.model)).size >= 2,
        multiProvider: new Set(members.map((member) => member.provider)).size >= 2,
      },
    },
    backend: backendStatus,
    callAccounting: {
      mode: backendStatus.callAccounting ? backendStatus.callAccounting.mode : 'unknown',
      hardCapApplicable: backendStatus.callAccounting ? backendStatus.callAccounting.hardCapApplicable === true : false,
      synchronousLimit: backendStatus.callAccounting ? backendStatus.callAccounting.synchronousLimit : null,
      // 计数单位必须分开命名，不能用一个"调用次数"概括：
      // 成员创建、代理轮次、模型请求、重试、token 用量是五个不同的量，
      // 其中只有"代理启动次数"在 workflow-script 后端有启动前同步计数。
      units: {
        memberCreates: { label: '成员创建次数', enforced: false, note: '建成员本身不发起模型请求，未单独计数' },
        agentStarts: {
          label: '代理启动次数',
          enforced: hardCallCap,
          limit: hardCallCap ? backendStatus.callAccounting.synchronousLimit : null,
          note: hardCallCap ? '启动前同步检查，超限返回 AGENT_CALL_BUDGET_EXCEEDED' : '该后端没有启动前同步计数',
        },
        modelRequests: {
          label: '模型请求次数',
          enforced: false,
          limit: null,
          note: '一次代理启动内部可能产生多次请求（重试、工具轮次），宿主未提供逐请求同步计数',
        },
        retries: { label: '重试次数', enforced: false, limit: null, note: '重试是否单独计次未核实' },
        tokens: { label: 'token 用量', enforced: false, limit: null, note: '只能在运行后按会话日志复算，不能在发起前限制' },
      },
    },
    budgetEnforcement: 'allocation-plan-only',
    hostCatalog: hostCatalogSection,
    readiness,
    missingForExecution: missing,
    executable,
    status: executable ? 'ready' : 'blocked',
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
