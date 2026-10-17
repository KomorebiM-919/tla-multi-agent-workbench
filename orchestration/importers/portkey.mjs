// orchestration/importers/portkey.mjs
//
// 把 portkey-models（MIT）的 pricing/*.json 转成 TLA 的离线价格快照。
//
// 为什么需要这一层：
// 1. 上游价格是"美分/token"的 JSON 数字，TLA 用"微-分/百万 token"的整数，
//    直接换算容易丢精度，所以集中在一个显式换算函数里，并断言结果确实是整数。
// 2. 上游文件没有时间戳、没有 source 字段，只有 git commit 可作溯源依据，
//    因此快照必须写入 repository/commit/license/采集时间。
// 3. 上游有 3 个文件存在重复顶层键（严格解析会失败），这里用显式重复键检测的
//    解析器：宁可拒绝也不静默取最后一个值。

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PRICING_SCHEMA, validateSnapshot } from '../pricing.mjs';

export const PORTKEY_ADAPTER_VERSION = 'tla.portkey-adapter/v1';
export const PORTKEY_PRICE_UNIT = 'cents-per-token';

export class ImportError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'ImportError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 带重复键检测的 JSON 解析器。JSON.parse 会静默丢掉重复键，这对价格数据是危险行为。
 * 只实现 RFC 8259 的子集：object/array/string/number/true/false/null。
 */
export function parseJsonStrict(text, label = 'json') {
  let index = 0;
  const fail = (message) => {
    throw new ImportError('PORTKEY_INVALID_JSON', label + ' @' + index + ': ' + message);
  };
  const skip = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };
  const parseValue = (path) => {
    skip();
    const ch = text[index];
    if (ch === '{') return parseObject(path);
    if (ch === '[') return parseArray(path);
    if (ch === '"') return parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (text.startsWith('true', index)) { index += 4; return true; }
    if (text.startsWith('false', index)) { index += 5; return false; }
    if (text.startsWith('null', index)) { index += 4; return null; }
    return fail('无法识别的值');
  };
  const parseString = () => {
    let out = '';
    index += 1;
    while (index < text.length) {
      const ch = text[index];
      if (ch === '"') { index += 1; return out; }
      if (ch === '\\') {
        const next = text[index + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (next === 'u') {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 转义非法');
          out += String.fromCharCode(parseInt(hex, 16));
          index += 6;
          continue;
        }
        if (!(next in map)) fail('非法转义 \\' + next);
        out += map[next];
        index += 2;
        continue;
      }
      out += ch;
      index += 1;
    }
    return fail('字符串未闭合');
  };
  const parseNumber = () => {
    const start = index;
    if (text[index] === '-') index += 1;
    while (index < text.length && /[0-9]/.test(text[index])) index += 1;
    if (text[index] === '.') {
      index += 1;
      while (index < text.length && /[0-9]/.test(text[index])) index += 1;
    }
    if (text[index] === 'e' || text[index] === 'E') {
      index += 1;
      if (text[index] === '+' || text[index] === '-') index += 1;
      while (index < text.length && /[0-9]/.test(text[index])) index += 1;
    }
    const raw = text.slice(start, index);
    const value = Number(raw);
    if (!Number.isFinite(value)) fail('数字非法 ' + raw);
    return value;
  };
  const parseObject = (path) => {
    const out = {};
    const seen = new Set();
    index += 1;
    skip();
    if (text[index] === '}') { index += 1; return out; }
    for (;;) {
      skip();
      if (text[index] !== '"') fail('对象键必须是字符串');
      const key = parseString();
      if (seen.has(key)) {
        throw new ImportError('PORTKEY_DUPLICATE_KEY', label + ': 重复键 ' + path + '.' + key);
      }
      seen.add(key);
      skip();
      if (text[index] !== ':') fail('缺少冒号');
      index += 1;
      out[key] = parseValue(path + '.' + key);
      skip();
      if (text[index] === ',') { index += 1; continue; }
      if (text[index] === '}') { index += 1; return out; }
      fail('对象未闭合');
    }
  };
  const parseArray = (path) => {
    const out = [];
    index += 1;
    skip();
    if (text[index] === ']') { index += 1; return out; }
    for (;;) {
      out.push(parseValue(path + '[' + out.length + ']'));
      skip();
      if (text[index] === ',') { index += 1; continue; }
      if (text[index] === ']') { index += 1; return out; }
      fail('数组未闭合');
    }
  };
  const value = parseValue('$');
  skip();
  if (index !== text.length) fail('尾部还有多余内容');
  return value;
}

/**
 * 美分/token → 微-分/百万 token。
 * 1 token 价 p（美分） → 1M token = p * 1e6 美分 = p * 1e6 * 1e6 微-分。
 * 结果必须是整数：无法用整数微-分表达的价格直接拒绝，不做四舍五入。
 */
export function centsPerTokenToMicroMinorPerMillion(price, label) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    throw new ImportError('PORTKEY_INVALID_PRICE', label + ' 不是非负数字');
  }
  const scaled = price * 1e12;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-3) {
    throw new ImportError(
      'PORTKEY_PRICE_NOT_INTEGRAL',
      label + ' = ' + price + ' 美分/token 无法精确表示为整数微-分/百万 token',
    );
  }
  return rounded;
}

function requirePath(object, path, label) {
  let cursor = object;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) {
      throw new ImportError('PORTKEY_MISSING_FIELD', label + ' 缺少 ' + path);
    }
    cursor = cursor[part];
  }
  return cursor;
}

function readPayAsYouGo(entry, label) {
  const payg = entry.pricing_config && entry.pricing_config.pay_as_you_go;
  if (!payg || typeof payg !== 'object') {
    throw new ImportError('PORTKEY_UNPRICED', label + ' 没有 pricing_config.pay_as_you_go（免费/未定价/自定义计价）');
  }
  return payg;
}

/** 从单个 provider 文件里取若干 model 的价格条目。 */
export function extractProviderEntries({
  text,
  filePath,
  provider,
  models,
  repository,
  commit,
  currency,
  repoPath,
  channel,
}) {
  const parsed = parseJsonStrict(text, filePath);
  const fileCurrency = parsed.default && typeof parsed.default.currency === 'string' ? parsed.default.currency : currency;
  if (fileCurrency !== currency) {
    throw new ImportError(
      'PORTKEY_CURRENCY_MISMATCH',
      filePath + ' 币种 ' + fileCurrency + ' 与快照币种 ' + currency + ' 不同',
    );
  }
  const repoPathLabel = typeof repoPath === 'string' && repoPath !== '' ? repoPath : 'pricing/' + basename(filePath);
  const entries = [];
  for (const model of models) {
    const label = filePath + '#' + model;
    if (!Object.hasOwn(parsed, model)) throw new ImportError('PORTKEY_MODEL_MISSING', label + ' 不存在');
    const payg = readPayAsYouGo(parsed[model], label);
    const input = requirePath(payg, 'request_token.price', label);
    const output = requirePath(payg, 'response_token.price', label);
    const entry = {
      provider,
      model,
      mode: 'chat',
      ...(typeof channel === 'string' && channel !== '' ? { channel } : {}),
      inputMicroMinorPerMillion: centsPerTokenToMicroMinorPerMillion(input, label + '.request_token'),
      outputMicroMinorPerMillion: centsPerTokenToMicroMinorPerMillion(output, label + '.response_token'),
      provenance: 'portkey-models@' + commit.slice(0, 7) + ' ' + repoPathLabel + ' pay_as_you_go',
      unknownFields: ['offPeakPricing'],
    };
    if (payg.cache_read_input_token && typeof payg.cache_read_input_token.price === 'number') {
      entry.cacheReadMicroMinorPerMillion = centsPerTokenToMicroMinorPerMillion(
        payg.cache_read_input_token.price, label + '.cache_read_input_token');
    } else {
      entry.unknownFields.push('cacheReadPricing');
    }
    if (payg.cache_write_input_token && typeof payg.cache_write_input_token.price === 'number') {
      entry.cacheWriteMicroMinorPerMillion = centsPerTokenToMicroMinorPerMillion(
        payg.cache_write_input_token.price, label + '.cache_write_input_token');
    } else {
      entry.unknownFields.push('cacheWritePricing');
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * 生成快照对象。sources 每项 {filePath, provider, models}，全部从磁盘读。
 */
export function buildSnapshotFromPortkey({
  sources,
  repository,
  commit,
  license,
  capturedAt,
  snapshotId,
  currency = 'USD',
  channel,
  notes = [],
}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new ImportError('PORTKEY_SOURCES_EMPTY', 'sources 不能为空');
  }
  const entries = [];
  const files = [];
  for (const source of sources) {
    let text;
    try {
      text = readFileSync(source.filePath, 'utf8');
    } catch (error) {
      throw new ImportError('PORTKEY_UNREADABLE', source.filePath + ': ' + error.message);
    }
    files.push(source.repoPath === undefined || source.repoPath === '' ? 'pricing/' + basename(source.filePath) : source.repoPath);
    entries.push(...extractProviderEntries({
      text,
      filePath: source.filePath,
      provider: source.provider,
      models: source.models,
      repository,
      commit,
      currency,
      repoPath: source.repoPath,
      channel,
    }));
  }
  const raw = {
    schema: PRICING_SCHEMA,
    snapshotId,
    capturedAt,
    currency,
    minorUnit: 'cent',
    source: { repository, commit, license, files },
    notes: [
      'Prices imported from portkey-models, where prices are cents per token (README: "Prices are in cents per token, not dollars").',
      'Converted with $/1M = price * 10000 and stored as integer micro-minor (1e-6 cent) per million tokens.',
      'The upstream data carries no source URL, no updated_at and no off-peak fields; freshness must be judged from the git commit date.',
      ...notes,
    ],
    entries,
  };
  // 用同一套校验器验证磁盘格式；返回未归一化的对象，保证写入文件的就是被校验的字节形状。
  validateSnapshot(raw);
  return raw;
}
