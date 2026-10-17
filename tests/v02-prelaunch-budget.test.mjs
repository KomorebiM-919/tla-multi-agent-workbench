#!/usr/bin/env node
// tests/v02-prelaunch-budget.test.mjs
//
// 启动前预算拦截器的离线夹具测试。
//
// ⚠️ 这个文件里的 "host" 是本仓库**模拟**的 cordis 瀑布 + agent-loop 循环，
// 依据是随包代码的只读阅读（见 orchestration/interceptors/prelaunch-budget.mjs 顶部注释）。
// 它证明的是"拦在 agent/request 上、同步预占、否决即不发请求"这套逻辑自洽，
// **不证明真实宿主验收通过**：真实安装、真实插件生命周期、真实 retry/abort 仍需隔离实验。

import { createAgentRequestListener, PrelaunchBudgetError } from '../orchestration/interceptors/prelaunch-budget.mjs';

let scenarios = 0;
let checks = 0;
const failures = [];

function scenario(name) {
  scenarios += 1;
  process.stdout.write('scenario ' + scenarios + ': ' + name + '\n');
}

function check(condition, label, detail) {
  checks += 1;
  if (condition) return;
  failures.push({ label, detail });
  process.stdout.write('  FAIL ' + label + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)) + '\n');
}

// ---------------------------------------------------------------- 模拟宿主

function createFakeHost() {
  const hooks = [];
  const transports = [];
  return {
    on(event, listener, { prepend = false } = {}) {
      if (event !== 'agent/request') throw new Error('夹具只模拟 agent/request');
      if (prepend) hooks.unshift(listener);
      else hooks.push(listener);
    },
    /**
     * 对应 cordis `waterfall()`：由外向内组合，任一监听器不调用 next() 即否决。
     */
    async waterfall(config) {
      let index = -1;
      const dispatch = (previous) => {
        index += 1;
        if (index >= hooks.length) return Promise.resolve(previous);
        const next = () => dispatch(previous);
        return hooks[index](previous, next);
      };
      return dispatch(config);
    },
    transport(agentKey) {
      transports.push(agentKey);
      return { agentKey, sent: true };
    },
    sent() {
      return transports.slice();
    },
  };
}

/**
 * 对应 dsh-agent-loop step()：while(true) 顶部先 prepareRequest；抛错 → turn error；
 * "retry" → continue 回到顶部，因此会**再次进入** agent/request 瀑布。
 */
async function runTurn(host, { agentKey, attempts = 1 }) {
  const outcome = { agentKey, attempts: 0, results: [], turnError: null };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    outcome.attempts += 1;
    let config;
    try {
      config = await host.waterfall({ agentKey, messages: [] });
    } catch (error) {
      outcome.turnError = error;
      return outcome;
    }
    if (outcome.attempts < attempts) {
      outcome.results.push('retry');
      continue;
    }
    outcome.results.push(host.transport(agentKey));
    return outcome;
  }
  throw new Error('模拟循环次数异常');
}

// ---------------------------------------------------------------- cases

async function main() {
  scenario('untagged listener sees every agent (captain and members alike)');
  {
    const host = createFakeHost();
    const interceptor = createAgentRequestListener({ modelRequests: 3 });
    host.on('agent/request', interceptor.listener, { prepend: true });
    const captain = await runTurn(host, { agentKey: 'captain' });
    const member = await runTurn(host, { agentKey: 'member-a' });
    check(captain.turnError === null && member.turnError === null, '两个 agent 的请求都被放行');
    check(interceptor.snapshot().used === 2, '两次请求各预占一次', interceptor.snapshot());
    check(host.sent().length === 2, '两次请求都真的发出', host.sent());
    check(interceptor.event === 'agent/request' && interceptor.scope === null, '监听器未打标签 = 全局可见');
  }

  scenario('over-limit request is rejected before it is sent');
  {
    const host = createFakeHost();
    const interceptor = createAgentRequestListener({ modelRequests: 2 });
    host.on('agent/request', interceptor.listener, { prepend: true });
    await runTurn(host, { agentKey: 'a' });
    await runTurn(host, { agentKey: 'b' });
    const third = await runTurn(host, { agentKey: 'c' });
    check(third.turnError instanceof PrelaunchBudgetError, '第 3 次请求抛类型化错误');
    check(third.turnError !== null && third.turnError.code === 'MODEL_REQUEST_BUDGET_EXCEEDED', '错误码正确', third.turnError && third.turnError.code);
    check(host.sent().length === 2, '超限后零新增发送', host.sent());
    check(interceptor.snapshot().rejected === 1, '拒绝次数被记录', interceptor.snapshot());
    check(interceptor.snapshot().remaining === 0, '剩余额度为 0');
    check(third.turnError.snapshot.used === 2, '错误里带当时的计数快照', third.turnError.snapshot);
  }

  scenario('retries re-enter the waterfall, so each retry reserves separately');
  {
    const host = createFakeHost();
    const interceptor = createAgentRequestListener({ modelRequests: 2 });
    host.on('agent/request', interceptor.listener, { prepend: true });
    const outcome = await runTurn(host, { agentKey: 'retrying', attempts: 3 });
    check(outcome.turnError instanceof PrelaunchBudgetError, '第 3 次尝试被拒绝', outcome.results);
    check(outcome.attempts === 3, '循环尝试了 3 次', outcome.attempts);
    check(host.sent().length === 0, '被拒绝的那次没有发送请求', host.sent());
    check(interceptor.snapshot().used === 2, '两次预占 = 两次真实尝试', interceptor.snapshot());
  }

  scenario('concurrent requests reserve atomically (single thread + synchronous reserve)');
  {
    const host = createFakeHost();
    const interceptor = createAgentRequestListener({ modelRequests: 3 });
    host.on('agent/request', interceptor.listener, { prepend: true });
    const outcomes = await Promise.all(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((agentKey) => runTurn(host, { agentKey })),
    );
    const ok = outcomes.filter((outcome) => outcome.turnError === null).length;
    const rejected = outcomes.filter((outcome) => outcome.turnError !== null).length;
    check(ok === 3 && rejected === 2, '并发 5 个请求恰好 3 放行 2 拒绝', { ok, rejected });
    check(host.sent().length === 3, '只发出 3 个请求', host.sent());
  }

  scenario('returning a config is not a veto — only throwing is');
  {
    const host = createFakeHost();
    host.on('agent/request', () => ({ provider: 'x', model: 'y' }), { prepend: false });
    const outcome = await runTurn(host, { agentKey: 'vetoed' });
    check(outcome.turnError === null, '不调 next() 时宿主不报错');
    check(host.sent().length === 1, '传输仍然发生：否决必须靠抛错', host.sent());
  }

  scenario('invalid limits are rejected instead of treated as unlimited');
  {
    let error = null;
    try {
      createAgentRequestListener({ modelRequests: 0 });
    } catch (caught) {
      error = caught;
    }
    check(error !== null && error.code === 'BUDGET_LIMIT_INVALID', 'modelRequests=0 被拒绝', error && error.code);
    let error2 = null;
    try {
      createAgentRequestListener({ modelRequests: 1.5 });
    } catch (caught) {
      error2 = caught;
    }
    check(error2 !== null && error2.code === 'BUDGET_LIMIT_INVALID', '非整数上限被拒绝');
  }

  scenario('resuming from persisted state does not silently reset the allowance');
  {
    // 真实宿主实测反例：激活时抛错，宿主只警告一句就继续无预算运行
    // （2026-10-18：无预算跑到 2568 次请求）。所以恢复必须**不抛错**，
    // 而是把已预占数读回来；读不出来就把额度视为用尽。
    const host = createFakeHost();
    const interceptor = createAgentRequestListener({ modelRequests: 2, used: 2 });
    host.on('agent/request', interceptor.listener, { prepend: true });
    const outcome = await runTurn(host, { agentKey: 'after-restart' });
    check(outcome.turnError !== null && outcome.turnError.code === 'MODEL_REQUEST_BUDGET_EXCEEDED', '额度已用尽时首个请求即被拒');
    check(host.sent().length === 0, '重启后零新增发送', host.sent());
    check(interceptor.snapshot().used === 2, '已用数保持 2，没有归零', interceptor.snapshot());
    check(interceptor.snapshot().resumedFrom === 2, '快照记录了恢复起点', interceptor.snapshot());

    const partially = createFakeHost();
    const resumed = createAgentRequestListener({ modelRequests: 3, used: 2 });
    partially.on('agent/request', resumed.listener, { prepend: true });
    const one = await runTurn(partially, { agentKey: 'remaining' });
    const two = await runTurn(partially, { agentKey: 'over' });
    check(one.turnError === null, '恢复后剩余 1 次仍可放行');
    check(two.turnError !== null && partially.sent().length === 1, '第 2 次被拒且只有 1 次真实发送', partially.sent());

    let rejectedEvents = 0;
    const rejecting = createAgentRequestListener({
      modelRequests: 1,
      onReject: () => {
        rejectedEvents += 1;
      },
    });
    try {
      rejecting.budget.reserve({});
    } catch (_expected) {
      // expected
    }
    try {
      rejecting.budget.reserve({});
    } catch (_expected) {
      // expected
    }
    check(rejectedEvents === 1, '拒绝时回调被调用（用于把 rejected 落盘）', rejectedEvents);
    check(rejecting.snapshot().rejected === 1, '拒绝计数可读', rejecting.snapshot());
  }

  process.stdout.write('\n' + scenarios + ' scenarios, ' + checks + ' checks, ' + failures.length + ' failures\n');
  if (failures.length > 0) process.exitCode = 1;
}

await main();
