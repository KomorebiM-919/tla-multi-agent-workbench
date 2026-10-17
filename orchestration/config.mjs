// orchestration/config.mjs
//
// V0.2 运行配置的校验、规范化与持久化。
//
// 校验策略：**收集全部问题再返回**（不是抛第一个错就停），这样一次运行就能看到
// "哪个角色的模型没填、哪个分配比例非法"。每条问题都有稳定的 code，便于测试断言。
//
// 拒绝而不是猜测的地方：
// - 角色模型未显式指定 → ROUTE_INCOMPLETE（不取默认模型、不路由到别的模型）；
// - selection 不是 manual → SELECTION_UNSUPPORTED（智能推荐尚未实现，不能靠字段名假装支持）；
// - 基点之和不为 10000 → ALLOCATION_SUM；浮点金额 → MONEY_NOT_INTEGER；
// - 自动路由/自动 fallback 未经验证 → ROUTER_UNSUPPORTED / FALLBACK_UNSUPPORTED。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MoneyError, SUPPORTED_CURRENCIES, allocateByBasisPoints, microFromMinor, requireNonNegativeInteger, requirePositiveInteger } from './money.mjs';

export const CONFIG_SCHEMA = 'tla.v02-run-config/v1';
export const PLAN_SCHEMA = 'tla.v02-plan/v1';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const BACKEND_KINDS = new Set(['workflow-script', 'agent-teams']);
const SUPPORTED_SELECTION = new Set(['manual']);
const REASONING_EFFORTS = new Set(['off', 'low', 'high', 'max']);

export class ConfigError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'ConfigError';
    this.code = code;
    this.detail = detail;
  }
}

function problem(problems, code, detail, extra) {
  problems.push({ code, detail, ...(extra === undefined ? {} : { extra }) });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 稳定的 JSON 序列化：对象键排序、数组保序，保证同一配置两次序列化字节相同。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateRoles(roles, problems) {
  if (!isPlainObject(roles)) {
    problem(problems, 'ROLES_INVALID', 'roles 必须是对象');
    return [];
  }
  const names = Object.keys(roles);
  if (names.length === 0) problem(problems, 'ROLES_INVALID', 'roles 不能为空');
  return names.map((name) => {
    const role = roles[name];
    const where = 'roles.' + name;
    if (!isPlainObject(role)) {
      problem(problems, 'ROLES_INVALID', where + ' 必须是对象');
      return null;
    }
    if (!nonEmptyString(role.provider)) problem(problems, 'ROUTE_INCOMPLETE', where + '.provider 未指定（不设默认 provider）');
    if (!nonEmptyString(role.model)) problem(problems, 'ROUTE_INCOMPLETE', where + '.model 未指定（不设默认 model）');
    const selection = role.selection === undefined ? 'manual' : role.selection;
    if (!SUPPORTED_SELECTION.has(selection)) {
      problem(problems, 'SELECTION_UNSUPPORTED', where + '.selection=' + JSON.stringify(selection) +
        '：本阶段只支持 manual（智能推荐尚未实现）');
    }
    if (role.fallback !== undefined) {
      problem(problems, 'FALLBACK_UNSUPPORTED', where + '.fallback：自动 fallback 未经验证，本阶段不接受');
    }
    let reasoningEffort;
    if (role.reasoningEffort !== undefined) {
      if (!REASONING_EFFORTS.has(role.reasoningEffort)) {
        problem(problems, 'ROUTE_INVALID', where + '.reasoningEffort 必须是 off/low/high/max 之一，收到 ' + JSON.stringify(role.reasoningEffort));
      } else {
        reasoningEffort = role.reasoningEffort;
      }
    }
    return {
      name,
      provider: role.provider,
      model: role.model,
      selection: SUPPORTED_SELECTION.has(selection) ? selection : 'unsupported',
      reasoningEffort,
    };
  }).filter(Boolean);
}

function validateBudget(budget, roleNames, problems) {
  if (!isPlainObject(budget)) {
    problem(problems, 'BUDGET_INVALID', 'budget 必须是对象');
    return null;
  }
  if (typeof budget.currency !== 'string' || !CURRENCY_PATTERN.test(budget.currency)) {
    problem(problems, 'BUDGET_CURRENCY_INVALID', 'budget.currency 必须是 3 位大写币种代码');
  } else if (!SUPPORTED_CURRENCIES.includes(budget.currency)) {
    problem(problems, 'BUDGET_CURRENCY_INVALID', 'budget.currency ' + budget.currency + ' 未受支持：金额刻度只实现了 1 主单位 = 100 最小单位');
  }
  let totalMinor = null;
  try {
    requirePositiveInteger(budget.totalMinor, 'MONEY_NOT_INTEGER', 'budget.totalMinor');
    totalMinor = budget.totalMinor;
  } catch (error) {
    problem(problems, 'BUDGET_AMOUNT_INVALID', String(error.message));
  }
  const allocations = [];
  if (!Array.isArray(budget.allocations) || budget.allocations.length === 0) {
    problem(problems, 'ALLOCATION_EMPTY', 'budget.allocations 不能为空');
    return { currency: budget.currency, totalMinor, allocations, shares: null };
  }
  for (const item of budget.allocations) {
    if (!isPlainObject(item)) {
      problem(problems, 'ALLOCATION_INVALID', '分配项必须是对象');
      continue;
    }
    if (!roleNames.includes(item.role)) {
      problem(problems, 'ALLOCATION_ROLE_UNKNOWN', '分配项引用了未定义的角色 ' + JSON.stringify(item.role));
    }
    allocations.push({ role: item.role, basisPoints: item.basisPoints });
  }
  for (const roleName of roleNames) {
    if (!allocations.some((item) => item.role === roleName)) {
      problem(problems, 'ALLOCATION_ROLE_MISSING', '角色 ' + roleName + ' 没有分配比例（如需 0 也请显式写 0）');
    }
  }
  let shares = null;
  if (totalMinor !== null && allocations.length > 0) {
    try {
      shares = allocateByBasisPoints(microFromMinor(totalMinor), allocations);
    } catch (error) {
      if (error instanceof MoneyError) problem(problems, error.code, String(error.message));
      else throw error;
    }
  }
  return { currency: budget.currency, totalMinor, allocations, shares };
}

function validateEstimates(estimates, roleNames, problems) {
  if (estimates === undefined) return { perCall: { inputTokens: 0, outputTokens: 0 }, calls: {} };
  if (!isPlainObject(estimates)) {
    problem(problems, 'ESTIMATES_INVALID', 'estimates 必须是对象');
    return null;
  }
  const perCall = isPlainObject(estimates.perCall) ? estimates.perCall : {};
  const normalizedPerCall = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens']) {
    const value = perCall[key] === undefined ? 0 : perCall[key];
    try {
      normalizedPerCall[key] = requireNonNegativeInteger(value, 'MONEY_NOT_INTEGER', 'estimates.perCall.' + key);
    } catch (error) {
      problem(problems, 'ESTIMATES_INVALID', String(error.message));
    }
  }
  const calls = {};
  const rawCalls = estimates.calls === undefined ? {} : estimates.calls;
  if (!isPlainObject(rawCalls)) {
    problem(problems, 'ESTIMATES_INVALID', 'estimates.calls 必须是对象');
    return null;
  }
  for (const roleName of roleNames) {
    const value = rawCalls[roleName] === undefined ? 1 : rawCalls[roleName];
    try {
      calls[roleName] = requireNonNegativeInteger(value, 'MONEY_NOT_INTEGER', 'estimates.calls.' + roleName);
    } catch (error) {
      problem(problems, 'ESTIMATES_INVALID', String(error.message));
    }
  }
  for (const key of Object.keys(rawCalls)) {
    if (!roleNames.includes(key)) problem(problems, 'ESTIMATES_INVALID', 'estimates.calls 引用了未定义的角色 ' + key);
  }
  return { perCall: normalizedPerCall, calls };
}

function validateBackend(backend, problems) {
  if (!isPlainObject(backend)) {
    problem(problems, 'BACKEND_INVALID', 'backend 必须是对象');
    return null;
  }
  if (!BACKEND_KINDS.has(backend.kind)) {
    problem(problems, 'BACKEND_UNSUPPORTED', 'backend.kind 必须是 workflow-script 或 agent-teams，收到 ' + JSON.stringify(backend.kind));
    return null;
  }
  if (backend.kind === 'workflow-script') {
    if (!nonEmptyString(backend.workflow)) problem(problems, 'BACKEND_INVALID', 'workflow-script 需要 backend.workflow');
    const task = backend.task;
    if (!isPlainObject(task)) problem(problems, 'BACKEND_INVALID', 'workflow-script 需要 backend.task');
    else {
      for (const key of ['targetDir', 'moduleFile', 'testFile']) {
        if (!nonEmptyString(task[key])) problem(problems, 'BACKEND_INVALID', 'backend.task.' + key + ' 不能为空');
      }
      try {
        requirePositiveInteger(task.maxCodingAttempts === undefined ? 2 : task.maxCodingAttempts, 'MONEY_NOT_INTEGER', 'backend.task.maxCodingAttempts');
      } catch (error) {
        problem(problems, 'BACKEND_INVALID', String(error.message));
      }
      try {
        const calls = task.maxAgentCalls === undefined ? 8 : task.maxAgentCalls;
        requirePositiveInteger(calls, 'MONEY_NOT_INTEGER', 'backend.task.maxAgentCalls');
      } catch (error) {
        problem(problems, 'BACKEND_INVALID', String(error.message));
      }
    }
  }
  if (backend.kind === 'agent-teams' && backend.options !== undefined && !isPlainObject(backend.options)) {
    problem(problems, 'BACKEND_INVALID', 'backend.options 必须是对象');
  }
  return backend;
}

function validateRouter(router, problems) {
  if (router === undefined) return { enabled: false, policy: 'none' };
  if (!isPlainObject(router)) {
    problem(problems, 'ROUTER_UNSUPPORTED', 'router 必须是对象');
    return { enabled: false, policy: 'none' };
  }
  const enabled = router.enabled === true;
  const policy = router.policy === undefined ? 'none' : router.policy;
  if (policy !== 'none') {
    problem(problems, 'ROUTER_UNSUPPORTED', 'router.policy=' + JSON.stringify(policy) +
      '：智能路由未实现，本阶段只接受 none');
  }
  if (enabled) {
    problem(problems, 'ROUTER_UNSUPPORTED', 'router.enabled=true：没有经过验证的路由扩展点，手动指定的模型必须保持生效');
  }
  return { enabled: false, policy: 'none' };
}

/**
 * 校验并规范化配置。返回 { ok, config, problems }，不抛异常（除非输入不是对象）。
 */
export function validateConfig(raw) {
  const problems = [];
  if (!isPlainObject(raw)) {
    throw new ConfigError('CONFIG_INVALID', '配置必须是 JSON 对象');
  }
  if (raw.schema !== CONFIG_SCHEMA) problem(problems, 'CONFIG_SCHEMA', 'schema 必须是 ' + CONFIG_SCHEMA);
  if (typeof raw.runId !== 'string' || !RUN_ID_PATTERN.test(raw.runId)) {
    problem(problems, 'RUN_ID_INVALID', 'runId 必须匹配 ' + RUN_ID_PATTERN);
  }
  const roles = validateRoles(raw.roles, problems);
  const roleNames = roles.map((role) => role.name);
  let ownerRole = raw.ownerRole;
  if (!nonEmptyString(ownerRole)) problem(problems, 'OWNER_MISSING', '必须显式指定 ownerRole（负责人）');
  else if (!roleNames.includes(ownerRole)) problem(problems, 'OWNER_UNKNOWN', 'ownerRole 未在 roles 中定义: ' + ownerRole);
  const budget = validateBudget(raw.budget, roleNames, problems);
  const estimates = validateEstimates(raw.estimates, roleNames, problems);
  const backend = validateBackend(raw.backend, problems);
  const router = validateRouter(raw.router, problems);
  const pricing = isPlainObject(raw.pricing) ? raw.pricing : null;
  if (!pricing) problem(problems, 'PRICING_INVALID', 'pricing 必须是对象');
  else {
    if (!nonEmptyString(pricing.snapshotPath)) problem(problems, 'PRICING_INVALID', 'pricing.snapshotPath 不能为空');
    try {
      requirePositiveInteger(pricing.maxAgeHours === undefined ? 168 : pricing.maxAgeHours, 'MONEY_NOT_INTEGER', 'pricing.maxAgeHours');
    } catch (error) {
      problem(problems, 'PRICING_INVALID', String(error.message));
    }
    if (pricing.providerAliases !== undefined) {
      if (!isPlainObject(pricing.providerAliases)) {
        problem(problems, 'PRICING_INVALID', 'pricing.providerAliases 必须是对象（配置 provider → 快照 provider）');
      } else {
        for (const [from, to] of Object.entries(pricing.providerAliases)) {
          if (!nonEmptyString(from) || !nonEmptyString(to)) {
            problem(problems, 'PRICING_INVALID', 'pricing.providerAliases 的键和值都必须是非空字符串');
          }
          if (from === to) {
            problem(problems, 'PRICING_INVALID', 'pricing.providerAliases 里 ' + from + ' 指向自己，属于多余映射');
          }
        }
      }
    }
  }
  const config = {
    schema: CONFIG_SCHEMA,
    runId: raw.runId,
    roles: Object.fromEntries(roles.map((role) => [role.name, {
      provider: role.provider,
      model: role.model,
      selection: role.selection,
      ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
    }])),
    ownerRole,
    router,
    budget: budget === null ? null : {
      currency: budget.currency,
      totalMinor: budget.totalMinor,
      allocations: budget.allocations,
    },
    pricing: pricing === null ? null : {
      snapshotPath: pricing.snapshotPath,
      maxAgeHours: pricing.maxAgeHours === undefined ? 168 : pricing.maxAgeHours,
      providerAliases: isPlainObject(pricing.providerAliases) ? pricing.providerAliases : {},
    },
    estimates: raw.estimates === undefined ? null : estimates,
    backend,
  };
  return { ok: problems.length === 0, config, problems, shares: budget === null ? null : budget.shares };
}

export function loadConfigFromFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError('CONFIG_UNREADABLE', filePath + ': ' + error.message);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError('CONFIG_INVALID', filePath + ': ' + error.message);
  }
  const result = validateConfig(raw);
  if (!result.ok) {
    const summary = result.problems.map((entry) => entry.code).join(', ');
    throw new ConfigError('CONFIG_INVALID', '配置校验失败: ' + summary);
  }
  return result;
}

/** 写入配置文件；只接受校验通过的配置，避免把非法配置落盘。 */
export function saveConfig(filePath, raw) {
  const result = validateConfig(raw);
  if (!result.ok) {
    throw new ConfigError('CONFIG_INVALID', '拒绝保存非法配置: ' + result.problems.map((entry) => entry.code).join(', '));
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  const text = canonicalJson(result.config) + '\n';
  writeFileSync(filePath, text, 'utf8');
  // 两个摘要含义不同，必须分开命名：fileDigest 是落盘字节（含结尾换行），
  // configDigest 是规范化配置本身的摘要（跨文件格式稳定）。混用会让"同一配置两个哈希"看起来像不一致。
  return { path: filePath, bytes: Buffer.byteLength(text), fileDigest: digest(text), configDigest: configDigest(result.config) };
}

export function configDigest(config) {
  return digest(canonicalJson(config));
}
