// orchestration/estimate.mjs
//
// 用量/费用估算：把"角色 → 模型 → 价格 → 预计 token 数"算成一个整数微最小单位金额。
//
// 这是**估算**，不是账单，也不是强制扣费上限。三条边界必须写进输出：
// 1. token 数来自 config.estimates 的人工假设，不是历史实测；
// 2. 价格来自离线快照，可能与实际计费渠道（DSH 账户 / API / 订阅）不同；
// 3. 编排层只能限制"调用次数"，单个子代理内部的 token 消耗无法硬限制。
//
// 价格缺失的处理（一轮复审后收紧）：
// - 某个计费分量（输入 / 输出 / 缓存读 / 缓存写）没有价格时，**不拿别的价当上界**。
//   "缓存写按输入价计"没有供应商计费依据，把它称为上界是错的：缓存写可能更贵。
// - 默认结果是 unknown：不算出金额、不参与"预算内"结论，计划随之 blocked；
// - 只有在配置里显式选择 `estimates.assumptions.cachePriceEqualsInput: true` 时，
//   才用输入价代入，并标成 assumed（可信度 low），仍然不算 known —— 不能靠假设换来一个"就绪"。
// - 峰谷价缺失只记进 unknownFields（属于价格维度未知，不是把金额算错），状态为 partial。

import { costForTokens, requireNonNegativeInteger } from './money.mjs';
import { ConfigError } from './config.mjs';

export const ESTIMATE_BASIS = 'assumption';

export const ESTIMATE_STATUSES = ['known', 'partial', 'assumed', 'unknown'];

// 可信度与状态分开：known 高、partial 中（有维度未知，但金额是按真实单价算的）、
// assumed 低（有用输入价代替未知单价的假设）、unknown 无。
export const ESTIMATE_CONFIDENCE = {
  known: 'high',
  partial: 'medium',
  assumed: 'low',
  unknown: 'none',
};

export const ESTIMATE_ASSUMPTIONS = ['cachePriceEqualsInput'];

function normalizeAssumptions(assumptions) {
  if (assumptions === undefined || assumptions === null) return {};
  if (typeof assumptions !== 'object' || Array.isArray(assumptions)) {
    throw new ConfigError('ESTIMATES_INVALID', 'estimates.assumptions 必须是对象');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(assumptions)) {
    if (!ESTIMATE_ASSUMPTIONS.includes(key)) {
      throw new ConfigError('ESTIMATES_INVALID', '未知的估算假设: ' + key);
    }
    if (typeof value !== 'boolean') {
      throw new ConfigError('ESTIMATES_INVALID', 'estimates.assumptions.' + key + ' 必须是布尔值');
    }
    if (value) normalized[key] = true;
  }
  return normalized;
}

/**
 * @param {{price:object, perCall:object, calls:number, assumptions?:object}} input
 * @returns {{status:'known'|'partial'|'assumed'|'unknown', confidence:string,
 *   microMinor:{input:number,output:number,cacheRead:number,cacheWrite:number,total:number}|null,
 *   calls:number, perCall:object, assumedFields:string[], notes:string[], unknownFields:string[]}}
 */
export function estimateRoleCost({ price, perCall, calls, assumptions }) {
  const chosen = normalizeAssumptions(assumptions);
  const callCount = requireNonNegativeInteger(calls, 'MONEY_NOT_INTEGER', 'calls');
  const inputTokens = requireNonNegativeInteger(perCall.inputTokens, 'MONEY_NOT_INTEGER', 'inputTokens');
  const outputTokens = requireNonNegativeInteger(perCall.outputTokens, 'MONEY_NOT_INTEGER', 'outputTokens');
  const cacheReadTokens = requireNonNegativeInteger(perCall.cacheReadTokens === undefined ? 0 : perCall.cacheReadTokens,
    'MONEY_NOT_INTEGER', 'cacheReadTokens');
  const cacheWriteTokens = requireNonNegativeInteger(perCall.cacheWriteTokens === undefined ? 0 : perCall.cacheWriteTokens,
    'MONEY_NOT_INTEGER', 'cacheWriteTokens');
  const tokensPerCall = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  if (price.status !== 'known') {
    return {
      status: 'unknown',
      confidence: ESTIMATE_CONFIDENCE.unknown,
      calls: callCount,
      perCall: tokensPerCall,
      microMinor: null,
      assumedFields: [],
      notes: ['没有该模型的价格，无法估算（不按 0 计，也不用同类模型代替）'],
      unknownFields: ['modelPrice'],
    };
  }
  const notes = [];
  const unknownFields = [...(price.unknownFields || [])];
  const assumedFields = [];
  const inputMicro = costForTokens(inputTokens * callCount, price.prices.inputMicroMinorPerMillion);
  const outputMicro = costForTokens(outputTokens * callCount, price.prices.outputMicroMinorPerMillion);

  // 四个计费分量里，只有输入/输出是必然有价的；缓存读/写各自独立定价。
  const components = [
    { key: 'cacheRead', tokens: cacheReadTokens, priceKey: 'cacheReadMicroMinorPerMillion' },
    { key: 'cacheWrite', tokens: cacheWriteTokens, priceKey: 'cacheWriteMicroMinorPerMillion' },
  ];
  const unpriceable = [];
  for (const component of components) {
    if (component.tokens === 0) continue;
    if (!Number.isInteger(price.prices[component.priceKey])) unpriceable.push(component);
  }
  if (unpriceable.length > 0 && chosen.cachePriceEqualsInput !== true) {
    return {
      status: 'unknown',
      confidence: ESTIMATE_CONFIDENCE.unknown,
      calls: callCount,
      perCall: tokensPerCall,
      microMinor: null,
      assumedFields: [],
      notes: unpriceable.map((component) =>
        '缺少 ' + component.key + ' 价格，且没有任何供应商计费依据可以把它折算成别的价：金额未知（不使用输入价冒充上界）'),
      unknownFields: [...new Set([...unknownFields, ...unpriceable.map((component) => component.key + 'Price')])],
    };
  }
  let cacheReadMicro = 0;
  let cacheWriteMicro = 0;
  for (const component of unpriceable) {
    assumedFields.push(component.key + 'Price');
    notes.push(component.key + ' 价格未知：按配置里显式选择的假设"缓存价 = 输入价"代入，这是用户选择的估算假设，不是供应商报价');
    if (component.key === 'cacheRead') cacheReadMicro = costForTokens(component.tokens * callCount, price.prices.inputMicroMinorPerMillion);
    else cacheWriteMicro = costForTokens(component.tokens * callCount, price.prices.inputMicroMinorPerMillion);
  }
  for (const component of components) {
    if (unpriceable.includes(component)) continue;
    if (component.tokens === 0) continue;
    const micro = costForTokens(component.tokens * callCount, price.prices[component.priceKey]);
    if (component.key === 'cacheRead') cacheReadMicro = micro;
    else cacheWriteMicro = micro;
  }
  const total = inputMicro + outputMicro + cacheReadMicro + cacheWriteMicro;
  let status = 'known';
  if (assumedFields.length > 0) status = 'assumed';
  else if (unknownFields.length > 0) status = 'partial';
  return {
    status,
    confidence: ESTIMATE_CONFIDENCE[status],
    calls: callCount,
    perCall: tokensPerCall,
    microMinor: { input: inputMicro, output: outputMicro, cacheRead: cacheReadMicro, cacheWrite: cacheWriteMicro, total },
    assumedFields,
    notes,
    unknownFields: [...new Set(unknownFields)],
  };
}

export const ESTIMATE_LIMITATIONS = [
  '费用是估算：token 数是人工假设（config.estimates），不是历史实测用量。',
  '价格来自离线快照，可能与实际计费渠道不同（DSH 账户 / API / 订阅 / 区域价）。',
  '缺少缓存价时金额记未知；只有配置显式声明假设时才会代入输入价，且可信度降为 low。',
  '编排层只能硬限制"代理启动次数"；模型请求次数与 token 用量都无法在发起前硬限制。',
  '预算分配是"计划上限"，不构成付款、余额或跨供应商资金划拨。',
];
