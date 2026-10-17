// orchestration/host-catalog.mjs
//
// 宿主（DSH）侧"实际可用的模型与计费渠道"只读快照的校验与比对。
//
// 为什么需要它：价格快照只是某个渠道的报价，不能反推"宿主里到底有哪些 provider/model、
// 走哪个渠道计费"。本模块只做两件事：
//   1. 校验宿主目录快照的结构（纯函数，不读文件、不联网、不调模型）；
//   2. 把计划里的 (provider, model, channel) 与宿主目录逐条比对，输出差异清单。
//
// 它不改变金额计算，也不据此断言"这条路一定可用"：目录里有、不等于当前 profile 配了凭据。

export const HOST_CATALOG_SCHEMA = 'tla.host-catalog/v1';

export class HostCatalogError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'HostCatalogError';
    this.code = code;
    this.detail = detail;
  }
}

function invalid(detail) {
  throw new HostCatalogError('HOST_CATALOG_INVALID', detail);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function requireNonNegativeIntegerOrNull(value, where) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    invalid(where + ' 必须是非负安全整数或 null');
  }
  return value;
}

export function validateHostCatalog(raw) {
  if (!isPlainObject(raw)) invalid('宿主目录必须是对象');
  if (raw.schema !== HOST_CATALOG_SCHEMA) invalid('schema 必须是 ' + HOST_CATALOG_SCHEMA);
  if (!nonEmpty(raw.catalogId)) invalid('catalogId 不能为空');
  if (!nonEmpty(raw.capturedAt)) invalid('capturedAt 不能为空');
  if (raw.capturedFrom !== undefined && !isPlainObject(raw.capturedFrom)) {
    invalid('capturedFrom 必须是对象');
  }
  if (!Array.isArray(raw.routes) || raw.routes.length === 0) invalid('routes 不能为空');
  const routes = raw.routes.map((route, index) => {
    const where = 'routes[' + index + ']';
    if (!isPlainObject(route)) invalid(where + ' 必须是对象');
    for (const key of ['provider', 'adapter', 'billingChannel']) {
      if (!nonEmpty(route[key])) invalid(where + '.' + key + ' 不能为空');
    }
    return {
      provider: route.provider,
      adapter: route.adapter,
      billingChannel: route.billingChannel,
      billing: nonEmpty(route.billing) ? route.billing : null,
      wiredInThisInstall: nonEmpty(route.wiredInThisInstall) ? route.wiredInThisInstall : 'unverified',
    };
  });
  if (!Array.isArray(raw.models) || raw.models.length === 0) invalid('models 不能为空');
  const seen = new Set();
  const models = raw.models.map((model, index) => {
    const where = 'models[' + index + ']';
    if (!isPlainObject(model)) invalid(where + ' 必须是对象');
    for (const key of ['provider', 'model', 'channel']) {
      if (!nonEmpty(model[key])) invalid(where + '.' + key + ' 不能为空');
    }
    const key = model.provider + '/' + model.model + '/' + model.channel;
    if (seen.has(key)) invalid('重复的目录条目 ' + key);
    seen.add(key);
    if (typeof model.listedByDefault !== 'boolean') invalid(where + '.listedByDefault 必须是布尔值');
    let cost = null;
    if (model.costMicroMinorPerMillion !== null && model.costMicroMinorPerMillion !== undefined) {
      if (!isPlainObject(model.costMicroMinorPerMillion)) invalid(where + '.costMicroMinorPerMillion 必须是对象或 null');
      cost = {
        input: requireNonNegativeIntegerOrNull(model.costMicroMinorPerMillion.input, where + '.costMicroMinorPerMillion.input'),
        output: requireNonNegativeIntegerOrNull(model.costMicroMinorPerMillion.output, where + '.costMicroMinorPerMillion.output'),
        cacheRead: requireNonNegativeIntegerOrNull(model.costMicroMinorPerMillion.cacheRead, where + '.costMicroMinorPerMillion.cacheRead'),
        cacheWrite: requireNonNegativeIntegerOrNull(model.costMicroMinorPerMillion.cacheWrite, where + '.costMicroMinorPerMillion.cacheWrite'),
      };
      if (cost.input === null || cost.output === null) invalid(where + '.costMicroMinorPerMillion 至少要有输入与输出价');
    } else if (model.costMicroMinorPerMillion === undefined) {
      invalid(where + ' 缺少 costMicroMinorPerMillion（未知也要写 null）');
    }
    return {
      provider: model.provider,
      model: model.model,
      channel: model.channel,
      listedByDefault: model.listedByDefault,
      contextWindow: Number.isInteger(model.contextWindow) ? model.contextWindow : null,
      cost,
      priceSource: nonEmpty(model.priceSource) ? model.priceSource : null,
    };
  });
  return {
    schema: raw.schema,
    catalogId: raw.catalogId,
    capturedAt: raw.capturedAt,
    capturedFrom: raw.capturedFrom === undefined ? null : raw.capturedFrom,
    notes: Array.isArray(raw.notes) ? [...raw.notes] : [],
    routes,
    models,
  };
}

export function findCatalogModels(catalog, provider, model) {
  return catalog.models.filter((entry) => entry.provider === provider && entry.model === model);
}

/**
 * 比对一条计划角色的路由：是否在宿主目录里、渠道是否一致、价格是否与目录价冲突。
 *
 * @returns {{
 *   status:'listed'|'unlisted',
 *   channelMatches:boolean|null,
 *   catalogChannel:string|null,
 *   priceConflict:boolean,
 *   catalogCost:object|null,
 *   detail:string
 * }}
 */
export function compareMemberRoute(catalog, { provider, model, channel, price }) {
  const candidates = findCatalogModels(catalog, provider, model);
  if (candidates.length === 0) {
    return {
      status: 'unlisted',
      channelMatches: null,
      catalogChannel: null,
      priceConflict: false,
      priceChannelDiffers: false,
      catalogCost: null,
      detail: '宿主目录里没有 ' + provider + '/' + model +
        '；宿主会把未列出的 id 当文本路由透传，但这只说明"可能能发"，不说明已配置或可计费',
    };
  }
  const entry = channel === null || channel === undefined
    ? (candidates.length === 1 ? candidates[0] : null)
    : (candidates.find((candidate) => candidate.channel === channel) || null);
  if (entry === null) {
    const channels = [...new Set(candidates.map((candidate) => candidate.channel))];
    return {
      status: 'listed',
      channelMatches: false,
      catalogChannel: channels.length === 1 ? channels[0] : null,
      priceConflict: false,
      priceChannelDiffers: false,
      catalogCost: null,
      detail: provider + '/' + model + ' 在宿主目录中的计费渠道是 ' + channels.join('、') +
        '，与请求的渠道 ' + (channel === null || channel === undefined ? '(未声明)' : channel) + ' 不一致',
    };
  }
  let priceConflict = false;
  let priceChannelDiffers = false;
  let detail = provider + '/' + model + ' 在宿主目录中已列出（渠道 ' + entry.channel + '）';
  if (price !== null && price !== undefined && price.status === 'known' && price.channel !== entry.channel) {
    // 渠道不同就不能比价：同一模型在不同渠道可以有完全不同的单价与扣费方式。
    priceChannelDiffers = true;
    detail += '；价格快照来自渠道 ' + (price.channel === null ? '(未声明)' : price.channel) +
      '，与宿主目录渠道不同，两者单价不可直接比较';
  }
  if (price !== null && price !== undefined && price.status === 'known' && entry.cost !== null && price.channel === entry.channel) {
    const snapshotInput = price.prices.inputMicroMinorPerMillion;
    const snapshotOutput = price.prices.outputMicroMinorPerMillion;
    if (snapshotInput !== entry.cost.input || snapshotOutput !== entry.cost.output) {
      priceConflict = true;
      detail += '；但价格快照的输入/输出单价（' + snapshotInput + '/' + snapshotOutput +
        ' 微-分/百万 token）与宿主目录价（' + entry.cost.input + '/' + entry.cost.output + '）不一致';
    }
  }
  return {
    status: 'listed',
    channelMatches: true,
    catalogChannel: entry.channel,
    priceConflict,
    priceChannelDiffers,
    catalogCost: entry.cost,
    detail,
  };
}

/**
 * 汇总多条路由的比对结果。
 *
 * @param {object} catalog 已校验的宿主目录
 * @param {Array<{role:string, provider:string, model:string, channel:string|null, price:object|null}>} entries
 */
export function comparePlanRoutes(catalog, entries) {
  const checked = entries.map((entry) => {
    const comparison = compareMemberRoute(catalog, {
      provider: entry.provider,
      model: entry.model,
      channel: entry.channel,
      price: entry.price,
    });
    return { role: entry.role, ...comparison };
  });
  return {
    catalogId: catalog.catalogId,
    capturedAt: catalog.capturedAt,
    checked,
    unlistedRoles: checked.filter((item) => item.status === 'unlisted').map((item) => item.role),
    channelMismatchRoles: checked.filter((item) => item.channelMatches === false).map((item) => item.role),
    priceConflictRoles: checked.filter((item) => item.priceConflict === true).map((item) => item.role),
  };
}
