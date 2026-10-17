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
// 进程重启语义（fail-closed，但**不在 apply 里抛错**）：
// - 实测：`apply()` 抛错时宿主只打印 `warning: 1 entry did not activate` 然后
//   继续无预算运行（2026-10-18 实验，无预算跑到 2568 次请求）。因此激活阶段
//   绝不抛错，否则"装了拦截器"反而等于"没有预算且没人知道"。
// - 正确做法：状态文件存在时读回 `used` 继续计数（`resumed` 事件）；读不出来
//   就把可用额度置 0，使**每次**请求都在发起前被拒。额度耗尽不需要重启也成立。
// - 每次预占与每次拒绝都落盘 + 追加事件，因此崩溃后仍能对账。
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
  });
})();

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

function appendEvent(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
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
 * 挂载拦截器。
 *
 * @param {object} ctx cordis 插件上下文（宿主提供）
 * @param {{modelRequests:number,stateFile:string,eventLog:string}} config 插件配置
 */
export function apply(ctx, config) {
  const modelRequests = requireLimit(config.modelRequests);
  const stateFile = requireAbsolute('stateFile', config.stateFile);
  const eventLog = requireAbsolute('eventLog', config.eventLog);

  let seeded = 0;
  let resumeMode = 'fresh';
  if (existsSync(stateFile)) {
    const previous = readSeededUsed(stateFile);
    if (previous === null) {
      // 计数不可恢复：把可用额度置 0，使每次请求都被拒（fail-closed）。
      seeded = modelRequests;
      resumeMode = 'state-unreadable-budget-exhausted';
    } else {
      seeded = previous;
      resumeMode = 'resumed';
    }
  }

  const writeState = (snapshot) => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ ...snapshot, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  };

  const interceptor = createAgentRequestListener({
    modelRequests,
    used: seeded,
    onReserve(snapshot) {
      // 预占后立刻落盘：崩溃也不会让"已预占"这件事消失。
      writeState(snapshot);
      appendEvent(eventLog, { event: 'reserved', at: new Date().toISOString(), ...snapshot });
    },
    onReject(_error, snapshot) {
      // 拒绝也要落盘，否则状态文件会显示 rejected: 0（实测缺陷）。
      writeState(snapshot);
      appendEvent(eventLog, { event: 'rejected', at: new Date().toISOString(), ...snapshot });
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
    at: new Date().toISOString(),
    listenerId: interceptor.id,
    limit: modelRequests,
    used: seeded,
    resumeMode,
    stateFile,
  });

  // 卸载/退出时落最终快照，便于与假模型服务端的请求日志对账。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      appendEvent(eventLog, { event: 'unmounted', at: new Date().toISOString(), ...interceptor.snapshot() });
    });
  }

  return interceptor;
}
