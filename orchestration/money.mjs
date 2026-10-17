// orchestration/money.mjs
//
// 金额运算的唯一入口：整数最小单位（minor unit）+ 微单位（micro-minor）两级刻度。
//
// 为什么不用浮点：预算分配要"各项之和恰好等于总额"，0.1 + 0.2 !== 0.3 之类的误差会让
// "比例校验通过"变成假象。这里所有金额都是整数：预算以最小单位（如美分）声明，
// 单价以"每 100 万 token 多少微最小单位"声明，换算一律用整数除法并显式取整。
//
// 刻度：
//   minor        最小单位（USD 下 = 美分），预算声明用它；
//   micro-minor  1e-6 个最小单位，单价与估算用它（足以表示 0.000001 美分的精度）。

export const MICRO_PER_MINOR = 1_000_000;
export const MINOR_PER_MAJOR = 100;
export const SUPPORTED_CURRENCIES = ['USD', 'CNY', 'EUR'];
export const TOKENS_PER_PRICE_BASIS = 1_000_000;
export const BASIS_POINTS_TOTAL = 10_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'MoneyError';
    this.code = code;
    this.detail = detail;
  }
}

export function requireInteger(value, code, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MoneyError(code, label + ' 必须是整数，收到 ' + JSON.stringify(value));
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(code, label + ' 超出安全整数范围');
  }
  return value;
}

export function requireNonNegativeInteger(value, code, label) {
  requireInteger(value, code, label);
  if (value < 0) throw new MoneyError(code, label + ' 不得为负数');
  return value;
}

export function requirePositiveInteger(value, code, label) {
  requireInteger(value, code, label);
  if (value < 1) throw new MoneyError(code, label + ' 必须是正整数');
  return value;
}

/** 整数除法，四舍五入（half-up）。denominator 必须为正。 */
export function divRoundHalfUp(numerator, denominator) {
  requireInteger(numerator, 'MONEY_NOT_INTEGER', 'numerator');
  requirePositiveInteger(denominator, 'MONEY_NOT_INTEGER', 'denominator');
  const sign = numerator < 0 ? -1 : 1;
  const magnitude = Math.abs(numerator);
  // 2 * magnitude 也必须落在安全整数范围内：否则浮点已经丢失精度，
  // 再“四舍五入”只会给出一个看似精确的错值。
  const scaled = magnitude * 2 + denominator;
  if (!Number.isSafeInteger(scaled) || !Number.isSafeInteger(denominator * 2)) {
    throw new MoneyError('MONEY_OVERFLOW', '除法中间量超出安全整数范围');
  }
  const quotient = Math.floor(scaled / (2 * denominator));
  const result = sign * quotient;
  if (!Number.isSafeInteger(result)) throw new MoneyError('MONEY_OVERFLOW', '除法结果溢出');
  return result;
}

/** 整数除法，向上取整（ceil）。denominator 必须为正；用于费用估算，保证估算不低于理论值。 */
export function divCeil(numerator, denominator) {
  requireNonNegativeInteger(numerator, 'MONEY_NOT_INTEGER', 'numerator');
  requirePositiveInteger(denominator, 'MONEY_NOT_INTEGER', 'denominator');
  // 必须先判断再加：`numerator + denominator - 1` 在 2^53 附近会分两步静默舍入回
  // 安全整数（例如 MAX_SAFE_INTEGER + 2 先舍成 2^53，再减 1 回到 MAX_SAFE_INTEGER），
  // 事后再查 `Number.isSafeInteger` 已经看不出溢出，只会得到一个偏小的错值。
  const maxNumerator = Number.MAX_SAFE_INTEGER - (denominator - 1);
  if (numerator > maxNumerator) throw new MoneyError('MONEY_OVERFLOW', '向上取整中间量溢出');
  const plus = numerator + denominator - 1;
  if (!Number.isSafeInteger(plus)) throw new MoneyError('MONEY_OVERFLOW', '向上取整中间量溢出');
  const result = Math.floor(plus / denominator);
  if (!Number.isSafeInteger(result)) throw new MoneyError('MONEY_OVERFLOW', '除法结果溢出');
  return result;
}

/**
 * token 数 × 每 100 万 token 的微最小单位单价 → 微最小单位金额。
 *
 * 使用**向上取整**：估算是上界，任何非零用量都不会被算成 0，也不会因舍入低于按价目
 * 计算的理论值。向下取整（含四舍五入到更小值）会让"预算内"结论变成低估。
 */
export function costForTokens(tokens, priceMicroMinorPerMillion) {
  requireNonNegativeInteger(tokens, 'MONEY_NOT_INTEGER', 'tokens');
  requireNonNegativeInteger(priceMicroMinorPerMillion, 'MONEY_NOT_INTEGER', 'price');
  const product = tokens * priceMicroMinorPerMillion;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError('MONEY_OVERFLOW', 'tokens × price 超出安全整数范围');
  }
  return divCeil(product, TOKENS_PER_PRICE_BASIS);
}

/**
 * 按基点分配总额，保证各项之和**恰好**等于总额。
 *
 * 规则：先按 floor(total × bp / 10000) 分配，再把剩余微单位按"小数余数从大到小、
 * 同余数按声明顺序"逐个补给前面的角色。这样分配结果只取决于输入（确定性），
 * 且守恒性可被断言，不需要浮点容差。
 *
 * @param {number} totalMicro 总额（微最小单位，非负整数）
 * @param {Array<{role:string, basisPoints:number}>} allocations
 * @returns {Map<string, number>} role → 微最小单位
 */
export function allocateByBasisPoints(totalMicro, allocations) {
  requireNonNegativeInteger(totalMicro, 'MONEY_NOT_INTEGER', 'totalMicro');
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new MoneyError('ALLOCATION_EMPTY', '至少需要一个分配项');
  }
  const seen = new Set();
  let sum = 0;
  const rows = allocations.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new MoneyError('ALLOCATION_INVALID', '分配项必须是对象');
    const role = entry.role;
    if (typeof role !== 'string' || role.trim() === '') throw new MoneyError('ALLOCATION_INVALID', '分配项缺少 role');
    if (seen.has(role)) throw new MoneyError('ALLOCATION_DUPLICATE_ROLE', '角色重复: ' + role);
    seen.add(role);
    const bp = requireNonNegativeInteger(entry.basisPoints, 'ALLOCATION_INVALID', role + '.basisPoints');
    if (bp > BASIS_POINTS_TOTAL) throw new MoneyError('ALLOCATION_INVALID', role + '.basisPoints 不得超过 10000');
    sum += bp;
    const exact = totalMicro * bp;
    if (!Number.isSafeInteger(exact)) throw new MoneyError('MONEY_OVERFLOW', '分配乘法溢出');
    const base = Math.floor(exact / BASIS_POINTS_TOTAL);
    return { role, bp, base, remainder: exact % BASIS_POINTS_TOTAL, index };
  });
  if (sum !== BASIS_POINTS_TOTAL) {
    throw new MoneyError('ALLOCATION_SUM', '基点之和必须恰好为 10000，实际 ' + sum);
  }
  const shares = new Map(rows.map((row) => [row.role, row.base]));
  let leftover = totalMicro - rows.reduce((acc, row) => acc + row.base, 0);
  const order = [...rows].sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));
  for (const row of order) {
    if (leftover <= 0) break;
    shares.set(row.role, shares.get(row.role) + 1);
    leftover -= 1;
  }
  if (leftover !== 0) throw new MoneyError('ALLOCATION_SUM', '分配后仍有剩余微单位 ' + leftover);
  return shares;
}

/**
 * 微最小单位 → 人类可读金额字符串（仅用于展示，不参与计算）。
 *
 * 只支持"1 主单位 = 100 最小单位"的币种（USD/CNY/EUR 等 exponent=2）。
 * 不支持的币种（如 JPY）必须在校验阶段拒绝，不能在展示层悄悄按两位小数处理。
 */
export function formatMicro(currency, microMinor) {
  requireInteger(microMinor, 'MONEY_NOT_INTEGER', 'microMinor');
  const sign = microMinor < 0 ? '-' : '';
  const magnitude = Math.abs(microMinor);
  const perMajor = MICRO_PER_MINOR * MINOR_PER_MAJOR;
  const major = Math.floor(magnitude / perMajor);
  const fraction = String(magnitude % perMajor).padStart(String(perMajor).length - 1, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return sign + currency + ' ' + String(major) + (trimmed === '' ? '' : '.' + trimmed);
}

export function microFromMinor(minor) {
  requireNonNegativeInteger(minor, 'MONEY_NOT_INTEGER', 'minor');
  const micro = minor * MICRO_PER_MINOR;
  if (!Number.isSafeInteger(micro)) throw new MoneyError('MONEY_OVERFLOW', 'minor × 1e6 溢出');
  return micro;
}

export function minorFromMicroCeil(microMinor) {
  requireNonNegativeInteger(microMinor, 'MONEY_NOT_INTEGER', 'microMinor');
  return Math.ceil(microMinor / MICRO_PER_MINOR);
}

export { MAX_SAFE };
