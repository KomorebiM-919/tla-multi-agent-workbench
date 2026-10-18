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
//
// 2026-10-18 独立审查后的修订：
// - `used` 允许"带着历史值"构造：进程重启后必须从持久化状态恢复，**不能**默认重置
//   额度；`used >= modelRequests` 也允许构造，表示"恢复后已经用尽"，此后每个请求
//   都被拒（fail-closed），而不是"额度又满了"。
// - 超限时先 `onReject(error, snapshot)` 再抛错，便于把拒绝落盘/记事件。

export const INTERCEPTOR_ID = 'tla-prelaunch-budget';
export const BUDGET_UNIT = 'modelRequests';

export class PrelaunchBudgetError extends Error {
  constructor(code, detail, snapshot) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'PrelaunchBudgetError';
    this.code = code;
    this.detail = detail;
    this.snapshot = snapshot;
  }
}

function requireNonNegativeInteger(value, where) {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new PrelaunchBudgetError('BUDGET_LIMIT_INVALID', where + ' 必须是非负安全整数，收到：' + String(value));
  }
  return value;
}

/**
 * @param {{modelRequests:number, used?:number, onReserve?:(snapshot:object)=>void, onReject?:(error:Error, snapshot:object)=>void}} options
 */
export function createRequestBudget(options) {
  const limit = requireNonNegativeInteger(options.modelRequests, 'modelRequests');
  if (limit < 1) {
    throw new PrelaunchBudgetError('BUDGET_LIMIT_INVALID', 'modelRequests 必须 >= 1，收到：' + String(limit));
  }
  const seeded = options.used === undefined ? 0 : requireNonNegativeInteger(options.used, 'used');
  let used = seeded;
  let rejected = 0;
  const onReject = typeof options.onReject === 'function' ? options.onReject : null;
  const onReserve = typeof options.onReserve === 'function' ? options.onReserve : null;

  const snapshot = () => ({
    unit: BUDGET_UNIT,
    limit,
    used,
    rejected,
    remaining: Math.max(0, limit - used),
    resumedFrom: seeded,
  });

  const reserve = (context) => {
    if (used >= limit) {
      rejected += 1;
      const error = new PrelaunchBudgetError(
        'MODEL_REQUEST_BUDGET_EXCEEDED',
        '模型请求上限 ' + limit + ' 已用尽（已预占 ' + used + ' 次），本次请求在发起前被拒绝',
        snapshot(),
      );
      if (onReject !== null) onReject(error, snapshot());
      throw error;
    }
    used += 1;
    // 预占成功也要立刻通知调用方落盘：崩溃不会让"已预占"这件事消失。
    if (onReserve !== null) onReserve(snapshot());
    return { ...snapshot(), context: context === undefined ? null : context };
  };

  return { limit, seed: seeded, reserve, snapshot, get used() { return used; } };
}

/**
 * 宿主形状的 `agent/request` 监听器。
 *
 * 注意：这里只计数"模型请求"，不计数"代理启动"。一次代理启动可能包含多次请求
 * （工具调用轮次），所以这两个数字不能互相替代。
 */
export function createAgentRequestListener(options) {
  const budget = createRequestBudget(options);
  const listener = (_config, next) => {
    // 同步预占：在任何 await 之前完成，保证并发请求不会同时看到"还剩一个额度"。
    budget.reserve({ phase: 'agent/request' });
    return next();
  };
  return {
    id: INTERCEPTOR_ID,
    event: 'agent/request',
    scope: null,
    listener,
    budget,
    snapshot: () => budget.snapshot(),
  };
}
