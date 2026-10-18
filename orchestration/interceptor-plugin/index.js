// orchestration/interceptor-plugin/index.js
//
// 把"发起前预算拦截器"接到**真实宿主**上的插件入口（本地插件包，本阶段在隔离
// profile 里安装验证；不随 npm 发布）。
//
// 接线形状（与宿主随包代码一致）：
//   ctx.on('agent/request', listener, { prepend: true })
// 依据：cordis `waterfall()` 由外向内组合、监听器不调 `next()` 即否决
// （`@deepseek-ai/cordis/src/events.ts` waterfall）；`agent/request` 在
// `dsh-agent-loop/lib/index.js:1179` 于 `llm.prepareCall()` 之前触发，`prepend`
// 让拦截器成为最外层，先计数再放行。
//
// 关于"apply 是否抛错"（2026-10-18 审查 P1-7 更正）：
// - 本文件**不承诺** apply 永不抛错：配置校验失败、目录不可写、事件追加失败都会抛。
// - 实测宿主对"插件激活失败"只打印 `warning: 1 entry did not activate` 然后继续
//   运行（2026-10-18 实验，无预算跑到 2567 次请求）。因此**不能**把"装了插件"当作
//   保护生效的证据；保护强度由 tools/gated-run.mjs 的启动闸门 + 挂载证明 + 心跳
//   共同决定（见 docs/V0.2-PRELAUNCH-GATE.md）。
// - 唯一刻意不抛错的地方是"状态文件已存在"：那属于正常的重启场景，应读回计数继续，
//   而不是让宿主降级成无预算运行。
//
// 运行级标识（P0-3）：每次运行的 runId 来自 `TLA_RUN_ID`（启动器设置）或配置
// `runId`，写进每一条事件。闸门只接受**本次 runId** 的 mounted/心跳，旧会话预先
// 写下的 mounted 不会授权新运行。这不是密码学认证：能写事件文件的本地进程也能
// 伪造 runId，该边界如实保留。
//
// 进程重启语义（fail-closed）：
// - 状态文件存在且可读 → 读回 `used` 继续（`resumed`）。
// - 状态文件存在但读不出 → `used = modelRequests`（每个请求都被拒）。
// - 状态文件缺失、但事件里已有本 runId 的预占记录 → 视为状态丢失，
//   `used = modelRequests`（不默认重置额度）。
//
// 作用域：监听器注册在插件（根）上下文、不打标签，等于全局可见——本次实验的
// 团队队长与成员都覆盖，但同一宿主里的其他会话也会被计入。实验必须使用隔离
// DSH_HOME + 隔离 profile + 独立 headless 进程，避免误伤。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { PrelaunchBudgetError, createAgentRequestListener } from './lib/budget.mjs';

export const name = 'tla-prelaunch-budget';

/** 本插件不注入任何宿主服务，只监听一个公开事件。 */
export const inject = [];

export const Config = (() => {
  // `z` (Schemastery) is usually a loader-provided global, but a plain
  // `node` import of this file has no such global. Guarding keeps the module
  // loadable in both worlds; `apply` then validates config itself.
  const schema = globalThis.z;
  if (schema === undefined) return undefined;
  return schema.object({
    modelRequests: schema.natural().min(1).required(),
    stateFile: schema.string().required(),
    eventLog: schema.string().required(),
    runId: schema.string(),
    heartbeatIntervalMs: schema.natural().min(100),
  });
})();

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;

function requireLimit(value) {
  if (!Number.isInteger(value) || value < 1 || !Number.isSafeInteger(value)) {
    throw new PrelaunchBudgetError('BUDGET_LIMIT_INVALID', 'modelRequests 必须是正整数，收到：' + String(value));
  }
  return value;
}

function requireAbsolute(label, value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new PrelaunchBudgetError('BUDGET_PATH_INVALID', label + ' 必须是绝对路径，收到：' + String(value));
  }
  return value;
}

function requireRunId(config) {
  const value = typeof config.runId === 'string' && config.runId !== '' ? config.runId : process.env.TLA_RUN_ID;
  if (typeof value !== 'string' || value.trim() === '') {
    // 没有运行标识就无法把"证明"绑定到本次运行；宁可不挂载（宿主只警告 → 闸门
    // 没有证明 → 拒绝所有请求），也不要挂一个无法区分旧会话的监听器。
    throw new PrelaunchBudgetError('BUDGET_RUN_ID_MISSING', '缺少 runId（配置 runId 或环境变量 TLA_RUN_ID）');
  }
  return value.trim();
}

function appendEvent(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n', 'utf8');
}

/**
 * 读回已持久化的已预占数；读不出来返回 null（调用方据此 fail-closed）。
 *
 * @param {string} stateFile 状态文件路径
 * @returns {number|null} 已预占数
 */
export function readSeededUsed(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (Number.isInteger(parsed?.used) && parsed.used >= 0 && Number.isSafeInteger(parsed.used)) return parsed.used;
    return null;
  } catch (_unreadable) {
    return null;
  }
}

/**
 * 事件日志里是否存在本次运行的预占/拒绝记录（用于识别"状态文件丢了"）。
 *
 * @param {string} eventLog
 * @param {string} runId
 * @returns {{readable:boolean, reserved:number}}
 */
export function readRunEventCounts(eventLog, runId) {
  let text;
  try {
    text = readFileSync(eventLog, 'utf8');
  } catch (_missing) {
    return { readable: true, reserved: 0 };
  }
  let reserved = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_badLine) {
      return { readable: false, reserved };
    }
    if (parsed === null || typeof parsed !== 'object') return { readable: false, reserved };
    if (parsed.runId !== runId) continue;
    if (parsed.event === 'reserved' || parsed.event === 'rejected') reserved += 1;
  }
  return { readable: true, reserved };
}

/**
 * 挂载拦截器。
 *
 * @param {object} ctx cordis 插件上下文（宿主提供）
 * @param {{modelRequests:number,stateFile:string,eventLog:string,runId?:string,heartbeatIntervalMs?:number}} config
 */
export function apply(ctx, config) {
  const modelRequests = requireLimit(config.modelRequests);
  const stateFile = requireAbsolute('stateFile', config.stateFile);
  const eventLog = requireAbsolute('eventLog', config.eventLog);
  const runId = requireRunId(config);
  const heartbeatIntervalMs = Number.isInteger(config.heartbeatIntervalMs) && config.heartbeatIntervalMs >= 100
    ? config.heartbeatIntervalMs
    : DEFAULT_HEARTBEAT_INTERVAL_MS;

  let seeded = 0;
  let resumeMode = 'fresh';
  const priorEvents = readRunEventCounts(eventLog, runId);
  if (priorEvents.readable !== true) {
    // 事件日志损坏：既无法证明这是新运行，也无法对账 → 按已用尽处理。
    seeded = modelRequests;
    resumeMode = 'event-log-unreadable-budget-exhausted';
  } else if (existsSync(stateFile)) {
    const previous = readSeededUsed(stateFile);
    if (previous === null) {
      seeded = modelRequests;
      resumeMode = 'state-unreadable-budget-exhausted';
    } else {
      seeded = previous;
      resumeMode = 'resumed';
    }
  } else if (priorEvents.reserved > 0) {
    // 状态文件不见了，但本次运行已经预占过：不能当成"额度重置"。
    seeded = modelRequests;
    resumeMode = 'state-lost-budget-exhausted';
  }

  const writeState = (snapshot) => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ ...snapshot, runId, at: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
  };

  const interceptor = createAgentRequestListener({
    modelRequests,
    used: seeded,
    onReserve(snapshot) {
      // 预占后立刻落盘：崩溃也不会让"已预占"这件事消失。
      writeState(snapshot);
      appendEvent(eventLog, { event: 'reserved', runId, ...snapshot });
    },
    onReject(_error, snapshot) {
      // 拒绝也要落盘，否则状态文件会显示 rejected: 0（实测缺陷）。
      writeState(snapshot);
      appendEvent(eventLog, { event: 'rejected', runId, ...snapshot });
    },
  });

  // 测试注入点（仅在隔离实验里用环境变量打开）：让监听器在预占前抛一个非预算
  // 错误，用来观察"拦截器自身出错时宿主是 fail-closed 还是静默继续"。默认关闭。
  const fault = process.env.TLA_PRELAUNCH_FAULT || '';
  const registered =
    fault === 'throw-before-reserve'
      ? () => {
          throw new Error('TLA_PRELAUNCH_FAULT: injected listener failure');
        }
      : interceptor.listener;

  ctx.on('agent/request', registered, { prepend: true });
  writeState(interceptor.snapshot());
  appendEvent(eventLog, {
    event: 'mounted',
    runId,
    listenerId: interceptor.id,
    limit: modelRequests,
    used: seeded,
    resumeMode,
    stateFile,
    heartbeatIntervalMs,
  });

  // 活跃心跳：证明"这个运行实例还活着"，而不是复用历史上的 reserved/rejected。
  // unref 让定时器不阻止宿主进程退出。
  const heartbeatTimer = setInterval(() => {
    appendEvent(eventLog, { event: 'heartbeat', runId, ...interceptor.snapshot() });
  }, heartbeatIntervalMs);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  const stopHeartbeat = () => clearInterval(heartbeatTimer);

  // 卸载/退出时落最终快照，便于与假模型服务端的请求日志对账。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      stopHeartbeat();
      appendEvent(eventLog, { event: 'unmounted', runId, ...interceptor.snapshot() });
    });
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', stopHeartbeat);
  }

  return interceptor;
}
