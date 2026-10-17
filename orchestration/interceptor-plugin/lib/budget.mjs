// orchestration/interceptor-plugin/lib/budget.mjs
//
// 宿主侧"发起前"预算拦截器的核心实现（纯逻辑，无 I/O、无宿主 API）。
//
// 事实依据（只读核对 DSH 0.2.0-rc.2 随包代码）：
// - `dsh-agent-loop/lib/index.js` 的 `step()` 在每次尝试的 `while (true)` 顶部
//   `await this.prepareRequest(...)`；`prepareRequest()` 先跑
//   `dispatch.waterfall("agent/request", { turn, step, signal }, () => seedConfig)`，
//   之后才 `llm.prepareCall()` 真正发请求。
// - 因此在这个瀑布里抛错＝**请求没有发出**，错误冒到 turn 级 catch，该 turn 以 error 结束。
// - 重试路径是 `continue` 回到 `while` 顶部，所以每次重试都会**再次进入**这个瀑布。
// - cordis `waterfall()` 由外向内组合，监听器不调用 `next()` 即否决；监听器签名为
//   `(payload, next)`，`next()` 返回解析后的请求配置（见宿主
//   `dsh-agent/lib/types/model-selection.js` 的同名监听器写法）。
//
// 由此得到的语义（本模块就是按这个语义实现的）：
// - 在这里能同步、原子地预占的是"**模型请求**"次数，不是"代理启动"次数；
//   一次代理启动内部可能产生多次请求（工具轮次、重试），宿主没有公开"agent 启动"接缝。
// - 预占必须发生在第一个 `await` 之前：本模块的 listener 是同步函数，先计数再返回 `next()`。
// - 并发安全：JS 单线程 + 同步预占，两个并发 turn 不会同时读到同一个旧计数。
// - 中止（abort）可能在预占之后发生：此时计数已加但请求没发，属于**多计**；
//   多计不会让预算超支，但会让"剩余额度"偏小，报告里必须如实说明。

export const INTERCEPTOR_ID = 'tla-prelaunch-budget';

export class PrelaunchBudgetError extends Error {
  constructor(code, detail, snapshot) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'PrelaunchBudgetError';
    this.code = code;
    this.detail = detail;
    this.snapshot = snapshot;
  }
}

function requirePositiveInteger(value, where) {
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new PrelaunchBudgetError('BUDGET_LIMIT_INVALID', where + ' 必须是正整数');
  }
  return value;
}

/**
 * 创建一个"模型请求"计数器。
 *
 * @param {{modelRequests:number, used?:number, onReject?:(error:Error,snapshot:object)=>void}} options
 *   modelRequests：允许同步预占的最大请求数（严格上限，不含事后补救）
 *   used：从已持久化的状态恢复的已预占数（不得大于 limit 时仍要能构造，用于"用尽后拒绝"）
 */
export function createRequestBudget({ modelRequests, used: seeded = 0, onReject }) {
  requirePositiveInteger(modelRequests, 'modelRequests');
  if (!Number.isInteger(seeded) || seeded < 0 || !Number.isSafeInteger(seeded)) {
    throw new PrelaunchBudgetError('BUDGET_STATE_INVALID', 'used 必须是非负整数');
  }
  let used = seeded;
  let rejected = 0;
  const events = seeded === 0 ? [] : [{ kind: 'resumed', at: 0, used: seeded }];
  return {
    /** 同步预占一次请求；超限抛错（调用方不得 catch 后继续发请求）。 */
    reserve(context) {
      if (used >= modelRequests) {
        rejected += 1;
        events.push({ kind: 'rejected', at: events.length, context: context || null });
        const snapshot = this.snapshot();
        const error = new PrelaunchBudgetError(
          'MODEL_REQUEST_BUDGET_EXCEEDED',
          '模型请求上限 ' + modelRequests + ' 已用尽（已预占 ' + used + ' 次），本次请求在发起前被拒绝',
          snapshot,
        );
        if (typeof onReject === 'function') onReject(error, snapshot);
        throw error;
      }
      used += 1;
      events.push({ kind: 'reserved', at: events.length, context: context || null });
      return used;
    },
    snapshot() {
      return {
        unit: 'modelRequests',
        limit: modelRequests,
        used,
        rejected,
        remaining: Math.max(0, modelRequests - used),
        resumedFrom: seeded,
      };
    },
    events() {
      return events.slice();
    },
  };
}

/**
 * 生成一个符合宿主 `agent/request` 瀑布形状的监听器。
 *
 * 宿主侧的等价注册（见 `index.js` 的真实接线）：
 *   ctx.on('agent/request', listener, { prepend: true })
 *
 * 监听器签名按 DSH 的瀑布约定：`(payload, next) => Promise<config>`；
 * 本实现忽略 `payload`，只做计数与放行/否决。
 *
 * @param {{modelRequests:number, used?:number, onReserve?:(snapshot:object)=>void, onReject?:(error:Error,snapshot:object)=>void}} options
 */
export function createAgentRequestListener({ modelRequests, used = 0, onReserve, onReject }) {
  const budget = createRequestBudget({ modelRequests, used, onReject });
  // 注意：这里刻意写成同步函数——预占在第一个 await 之前完成。
  function listener(_payload, next) {
    budget.reserve({ phase: 'agent/request' });
    if (typeof onReserve === 'function') onReserve(budget.snapshot());
    return next();
  }
  return {
    id: INTERCEPTOR_ID,
    event: 'agent/request',
    // 未打标签 = 全局可见（dsh-scope README: "an untagged listener is admitted"）。
    scope: null,
    listener,
    budget,
    snapshot() {
      return budget.snapshot();
    },
  };
}
