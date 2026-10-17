// orchestration/estimate.mjs
//
// 用量/费用估算：把"角色 → 模型 → 价格 → 预计 token 数"算成一个整数微最小单位金额。
//
// 这是**估算**，不是账单，也不是强制扣费上限。三条边界必须写进输出：
// 1. token 数来自 config.estimates 的人工假设，不是历史实测；
// 2. 价格来自离线快照，可能与实际计费渠道（DSH 账户 / API / 订阅）不同；
// 3. 编排层只能限制"调用次数"，单个子代理内部的 token 消耗无法硬限制。
//
// 未知字段的处理：
// - 缓存价缺失但预计有缓存读 token → 用普通输入价按**上界**计算并标记 conservative，
//   绝不按 0 计；
// - 峰谷价缺失 → 记进 unknownFields，不假设折扣。

import { costForTokens, requireNonNegativeInteger } from './money.mjs';

export const ESTIMATE_BASIS = 'assumption';

/**
 * @param {{price:object, perCall:{inputTokens:number,outputTokens:number,cacheReadTokens?:number}, calls:number}} input
 * @returns {{status:'known'|'partial'|'unknown', microMinor:{input:number,output:number,cacheRead:number,total:number}, calls:number, perCall:object, notes:string[], unknownFields:string[]}}
 */
export function estimateRoleCost({ price, perCall, calls }) {
  const callCount = requireNonNegativeInteger(calls, 'MONEY_NOT_INTEGER', 'calls');
  const inputTokens = requireNonNegativeInteger(perCall.inputTokens, 'MONEY_NOT_INTEGER', 'inputTokens');
  const outputTokens = requireNonNegativeInteger(perCall.outputTokens, 'MONEY_NOT_INTEGER', 'outputTokens');
  const cacheReadTokens = requireNonNegativeInteger(perCall.cacheReadTokens === undefined ? 0 : perCall.cacheReadTokens,
    'MONEY_NOT_INTEGER', 'cacheReadTokens');
  if (price.status !== 'known') {
    return {
      status: 'unknown',
      calls: callCount,
      perCall: { inputTokens, outputTokens, cacheReadTokens },
      microMinor: null,
      notes: ['没有该模型的价格，无法估算（不做"按 0 计"或"按同类模型代替"）'],
      unknownFields: ['input', 'output'],
    };
  }
  const notes = [];
  const unknownFields = [...(price.unknownFields || [])];
  const inputMicro = costForTokens(inputTokens * callCount, price.prices.inputMicroMinorPerMillion);
  const outputMicro = costForTokens(outputTokens * callCount, price.prices.outputMicroMinorPerMillion);
  let cacheReadMicro = 0;
  let conservative = false;
  if (cacheReadTokens > 0) {
    if (Number.isInteger(price.prices.cacheReadMicroMinorPerMillion)) {
      cacheReadMicro = costForTokens(cacheReadTokens * callCount, price.prices.cacheReadMicroMinorPerMillion);
    } else {
      cacheReadMicro = costForTokens(cacheReadTokens * callCount, price.prices.inputMicroMinorPerMillion);
      conservative = true;
      unknownFields.push('cacheRead');
      notes.push('缓存读价格未知：按普通输入价计为上界（conservative），不是实际账单');
    }
  }
  const total = inputMicro + outputMicro + cacheReadMicro;
  return {
    status: unknownFields.length === 0 ? 'known' : 'partial',
    calls: callCount,
    perCall: { inputTokens, outputTokens, cacheReadTokens },
    microMinor: { input: inputMicro, output: outputMicro, cacheRead: cacheReadMicro, total },
    conservative,
    notes,
    unknownFields: [...new Set(unknownFields)],
  };
}

export const ESTIMATE_LIMITATIONS = [
  '费用是估算：token 数是人工假设（config.estimates），不是历史实测用量。',
  '价格来自离线快照，可能与实际计费渠道不同（DSH 账户 / API / 订阅 / 区域价）。',
  '编排层只能硬限制调用次数；单个子代理内部的 token 消耗无法硬限制。',
  '预算分配是"计划上限"，不构成付款、余额或跨供应商资金划拨。',
];
