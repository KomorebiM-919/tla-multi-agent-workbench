// orchestration/interceptors/prelaunch-budget.mjs
//
// 宿主侧"发起前"预算拦截器的最小实现（**尚未在真实宿主里安装或验收**）。
//
// 事实依据（只读核对 DSH 0.2.0-rc.2 随包代码）：
// - `dsh-agent-loop/lib/index.js` 的 `step()` 在每次尝试的 `while (true)` 顶部
//   `await this.prepareRequest(...)`；`prepareRequest()` 先跑
//   `dispatch.waterfall("agent/request", { turn, step, signal }, () => seedConfig)`，
//   之后才 `llm.prepareCall()` 真正发请求。
// - 因此在这个瀑布里抛错＝**请求没有发出**，错误冒到 turn 级 catch，该 turn 以 error 结束。
// - 重试路径是 `continue` 回到 `while` 顶部，所以每次重试都会**再次进入**这个瀑布。
// - cordis `waterfall()` 由外向内组合，监听器不调用 `next()` 即否决。
//
// 由此得到的语义（本模块就是按这个语义实现的）：
// - 在这里能同步、原子地预占的是"**模型请求**"次数，不是"代理启动"次数；
//   一次代理启动内部可能产生多次请求（工具轮次、重试），宿主没有公开"agent 启动"接缝。
// - 预占必须发生在第一个 `await` 之前：本模块的 listener 是同步函数，先计数再返回 `next()`。
// - 并发安全：JS 单线程 + 同步预占，两个并发 turn 不会同时读到同一个旧计数。
// - 中止（abort）可能在预占之后发生：此时计数已加但请求没发，属于**多计**；
//   多计不会让预算超支，但会让"剩余额度"偏小，报告里必须如实说明。
//
// 明确不做：不写文件、不联网、不调用模型、不读凭据、不修改宿主配置。

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
 * @param {{modelRequests:number, clockOffsetMs?:number}} options
 *   modelRequests：允许同步预占的最大请求数（严格上限，不含事后补救）
 */
export function createRequestBudget({ modelRequests }) {
  requirePositiveInteger(modelRequests, 'modelRequests');
  let used = 0;
  let rejected = 0;
  const events = [];
  return {
    /** 同步预占一次请求；超限抛错（调用方不得 catch 后继续发请求）。 */
    reserve(context) {
      if (used >= modelRequests) {
        rejected += 1;
        const snapshot = this.snapshot();
        events.push({ kind: 'rejected', at: events.length, context: context || null });
        throw new PrelaunchBudgetError(
          'MODEL_REQUEST_BUDGET_EXCEEDED',
          '模型请求上限 ' + modelRequests + ' 已用尽（已预占 ' + used + ' 次），本次请求在发起前被拒绝',
          snapshot,
        );
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
        remaining: modelRequests - used,
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
 * 宿主侧的等价注册（**未验证**，本阶段不执行）：
 *   ctx.on('agent/request', listener, { prepend: true })
 *
 * 监听器签名按 DSH 的瀑布约定：`(config, next) => Promise<config>`；
 * 本实现忽略 `config`，只做计数与放行/否决。
 */
export function createAgentRequestListener({ modelRequests }) {
  const budget = createRequestBudget({ modelRequests });
  // 注意：这里刻意写成同步函数——预占在第一个 await 之前完成。
  function listener(_config, next) {
    budget.reserve({ phase: 'agent/request' });
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

/**
 * 宿主安装形状的类型契约（**未实现**）。
 *
 * 真正的 `apply(ctx, config)` 需要 cordis Context 与插件生命周期，本轮没有安装验证，
 * 因此这里只声明形状并明确抛出"未实现"，避免被误当成可用集成。
 */
export function apply() {
  throw new PrelaunchBudgetError(
    'INTERCEPTOR_NOT_WIRED',
    '拦截器尚未接入宿主：需要在一个隔离 profile 里安装并验证（见 docs/V0.2-INTEGRATION-PLAN.md）',
  );
}
