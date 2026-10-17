// orchestration/pricing.mjs
//
// 离线价格快照的读取、校验与查询。
//
// 设计约束（对应本轮授权范围）：
// 1. 快照必须是**离线文件**：不在运行时联网，不调用模型，不读凭据。
// 2. 每条价格必须带 provenance（来源文件/仓库/commit）与采集时间，才能说清"这个数字从哪来"。
// 3. 峰谷（off-peak）价格只有在来源里有明确字段时才算已知；否则写进 unknownFields，
//    不得用"估计值"或"固定折扣"冒充。
// 4. 币种不一致、快照过期、模型缺失，一律显式返回"未知/不可用"，不返回 0 或默认价。

import { readFileSync } from 'node:fs';
import { MoneyError, SUPPORTED_CURRENCIES, requireNonNegativeInteger } from './money.mjs';

export const PRICING_SCHEMA = 'tla.pricing-snapshot/v1';

export class PricingError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'PricingError';
    this.code = code;
    this.detail = detail;
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(text, label) {
  if (typeof text !== 'string' || !ISO_INSTANT_PATTERN.test(text)) {
    throw new PricingError('PRICING_INVALID', label + ' 必须是带时区的 ISO-8601 时刻');
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new PricingError('PRICING_INVALID', label + ' 不是合法时刻');
  return ms;
}

export function validateSnapshot(raw) {
  if (!raw || typeof raw !== 'object') throw new PricingError('PRICING_INVALID', '快照必须是对象');
  if (raw.schema !== PRICING_SCHEMA) {
    throw new PricingError('PRICING_INVALID', 'schema 必须是 ' + PRICING_SCHEMA);
  }
  for (const key of ['snapshotId', 'source', 'currency', 'entries']) {
    if (raw[key] === undefined) throw new PricingError('PRICING_INVALID', '缺少字段 ' + key);
  }
  if (typeof raw.snapshotId !== 'string' || raw.snapshotId.trim() === '') {
    throw new PricingError('PRICING_INVALID', 'snapshotId 不能为空');
  }
  if (typeof raw.currency !== 'string' || !CURRENCY_PATTERN.test(raw.currency)) {
    throw new PricingError('PRICING_INVALID', 'currency 必须是 3 位大写币种代码');
  }
  if (!SUPPORTED_CURRENCIES.includes(raw.currency)) {
    throw new PricingError('PRICING_INVALID', 'currency ' + raw.currency + ' 未受支持：金额刻度只实现了 1 主单位 = 100 最小单位');
  }
  const capturedMs = parseInstant(raw.capturedAt, 'capturedAt');
  const source = raw.source;
  if (!source || typeof source !== 'object') throw new PricingError('PRICING_INVALID', 'source 必须是对象');
  for (const key of ['repository', 'commit', 'license']) {
    if (typeof source[key] !== 'string' || source[key].trim() === '') {
      throw new PricingError('PRICING_INVALID', 'source.' + key + ' 不能为空');
    }
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    throw new PricingError('PRICING_INVALID', 'source.files 至少要列出一个来源文件');
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new PricingError('PRICING_INVALID', 'entries 不能为空');
  }
  const seen = new Set();
  const entries = raw.entries.map((entry, index) => {
    const where = 'entries[' + index + ']';
    if (!entry || typeof entry !== 'object') throw new PricingError('PRICING_INVALID', where + ' 必须是对象');
    for (const key of ['provider', 'model']) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
        throw new PricingError('PRICING_INVALID', where + '.' + key + ' 不能为空');
      }
    }
    const key = entry.provider + '/' + entry.model;
    if (seen.has(key)) throw new PricingError('PRICING_INVALID', '重复的价格条目 ' + key);
    seen.add(key);
    if (typeof entry.provenance !== 'string' || entry.provenance.trim() === '') {
      throw new PricingError('PRICING_INVALID', where + '.provenance 不能为空');
    }
    const prices = {
      inputMicroMinorPerMillion: requireNonNegativeInteger(
        entry.inputMicroMinorPerMillion, 'PRICING_INVALID', where + '.inputMicroMinorPerMillion'),
      outputMicroMinorPerMillion: requireNonNegativeInteger(
        entry.outputMicroMinorPerMillion, 'PRICING_INVALID', where + '.outputMicroMinorPerMillion'),
    };
    if (entry.cacheReadMicroMinorPerMillion !== undefined) {
      prices.cacheReadMicroMinorPerMillion = requireNonNegativeInteger(
        entry.cacheReadMicroMinorPerMillion, 'PRICING_INVALID', where + '.cacheReadMicroMinorPerMillion');
    }
    if (entry.cacheWriteMicroMinorPerMillion !== undefined) {
      prices.cacheWriteMicroMinorPerMillion = requireNonNegativeInteger(
        entry.cacheWriteMicroMinorPerMillion, 'PRICING_INVALID', where + '.cacheWriteMicroMinorPerMillion');
    }
    return {
      provider: entry.provider,
      model: entry.model,
      mode: typeof entry.mode === 'string' ? entry.mode : 'chat',
      prices,
      provenance: entry.provenance,
      unknownFields: Array.isArray(entry.unknownFields) ? [...entry.unknownFields] : [],
    };
  });
  return {
    schema: raw.schema,
    snapshotId: raw.snapshotId,
    capturedAt: raw.capturedAt,
    capturedMs,
    currency: raw.currency,
    minorUnit: typeof raw.minorUnit === 'string' ? raw.minorUnit : 'minor',
    source,
    notes: Array.isArray(raw.notes) ? [...raw.notes] : [],
    entries,
  };
}

export function loadSnapshotFromFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new PricingError('PRICING_UNREADABLE', filePath + ': ' + error.message);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PricingError('PRICING_INVALID', filePath + ': ' + error.message);
  }
  return validateSnapshot(raw);
}

export function snapshotAgeHours(snapshot, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new PricingError('PRICING_INVALID', 'nowMs 必须是毫秒时间戳');
  }
  return (nowMs - snapshot.capturedMs) / 3_600_000;
}

/**
 * @returns {{status:'fresh'|'stale'|'future', ageHours:number, maxAgeHours:number}}
 * 未来时间也按不可信处理：时钟错乱时不能说"还没过期"。
 */
export function checkFreshness(snapshot, { nowMs, maxAgeHours }) {
  const age = snapshotAgeHours(snapshot, nowMs);
  const limit = requireNonNegativeInteger(maxAgeHours, 'PRICING_INVALID', 'maxAgeHours');
  if (age < 0) return { status: 'future', ageHours: age, maxAgeHours: limit };
  return { status: age <= limit ? 'fresh' : 'stale', ageHours: age, maxAgeHours: limit };
}

export function lookupEntry(snapshot, provider, model) {
  return snapshot.entries.find((entry) => entry.provider === provider && entry.model === model) || null;
}

/**
 * 查询某角色要用的模型价格。返回"已知"时必须同时带 source/provenance；
 * 任何缺失都返回状态而不是 0。
 */
export function resolvePrice(snapshot, { provider, model, mode = 'chat' }) {
  const entry = snapshot.entries.find((candidate) =>
    candidate.provider === provider && candidate.model === model && candidate.mode === mode);
  if (!entry) {
    return {
      status: 'unknown',
      code: 'PRICE_UNKNOWN',
      detail: '快照 ' + snapshot.snapshotId + ' 中没有 ' + provider + '/' + model + '（mode=' + mode + '）的价格',
    };
  }
  return {
    status: 'known',
    provider,
    model,
    mode: entry.mode,
    currency: snapshot.currency,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    provenance: entry.provenance,
    prices: { ...entry.prices },
    unknownFields: [...entry.unknownFields],
  };
}

export function assertCurrencyMatch(priceCurrency, budgetCurrency, where) {
  if (priceCurrency !== budgetCurrency) {
    throw new PricingError(
      'CURRENCY_MISMATCH',
      (where === undefined ? '' : where + ': ') + '价格币种 ' + priceCurrency + ' 与预算币种 ' + budgetCurrency + ' 不同，且没有汇率依据',
    );
  }
}

export { MoneyError };
