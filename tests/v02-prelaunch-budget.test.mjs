#!/usr/bin/env node
// tests/v02-prelaunch-budget.test.mjs
//
// 启动前预算拦截器的离线夹具测试。
//
// ⚠️ 这个文件里的 "host" 是本仓库**模拟**的 cordis 瀑布 + agent-loop 循环，
// 依据是随包代码的只读阅读（见 orchestration/interceptors/prelaunch-budget.mjs 顶部注释）。
// 它证明的是"拦在 agent/request 上、同步预占、否决即不发请求"这套逻辑自洽，
// **不证明真实宿主验收通过**：真实安装、真实插件生命周期、真实 retry/abort 仍需隔离实验。

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAgentRequestListener, PrelaunchBudgetError } from '../orchestration/interceptors/prelaunch-budget.mjs';
import { apply as applyPlugin, readRunEventCounts } from '../orchestration/interceptor-plugin/index.js';

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

// ---------------------------------------------------------------- 插件接线夹具

/**
 * 最小 cordis 上下文：只实现插件用到的 `on` 与 `effect`。
 * `apply()` 的一切真实副作用（状态文件、事件日志、心跳定时器、卸载清理）都走真实代码，
 * 这里只提供宿主形状，不替代宿主。
 */
function pluginContext(host) {
  const cleanups = [];
  return {
    ctx: {
      on(event, listener, options) {
        if (event === 'agent/request') host.on('agent/request', listener, options || {});
        return () => {};
      },
      effect(factory) {
        const cleanup = factory();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
        return () => {};
      },
    },
    disposeAll() {
      while (cleanups.length > 0) cleanups.pop()();
    },
  };
}

function readEvents(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (_missing) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function scenarioPluginRunBinding() {
  scenario('the mount proof is bound to this runId and never invented');
  const dir = mkdtempSync(join(tmpdir(), 'tla-budget-run-'));
  const host = createFakeHost();
  const env = pluginContext(host);
  const stateFile = join(dir, 'budget-state.json');
  const eventLog = join(dir, 'events.jsonl');
  try {
    let missing = null;
    try {
      applyPlugin(env.ctx, { modelRequests: 2, stateFile, eventLog });
    } catch (error) {
      missing = error;
    }
    check(missing !== null && missing.code === 'BUDGET_RUN_ID_MISSING', 'apply without runId refuses to mount', missing && missing.code);

    applyPlugin(env.ctx, { modelRequests: 2, stateFile, eventLog, runId: 'run-A', heartbeatIntervalMs: 100 });
    const mounted = readEvents(eventLog).filter((entry) => entry.event === 'mounted');
    check(mounted.length === 1 && mounted[0].runId === 'run-A', 'mounted event carries the runId', mounted);
    check(mounted[0].resumeMode === 'fresh', 'first mount starts fresh', mounted[0].resumeMode);

    const turn = await runTurn(host, { agentKey: 'captain' });
    check(turn.turnError === null && host.sent().length === 1, 'budgeted request still goes through', host.sent());
    check(readRunEventCounts(eventLog, 'run-A').reserved === 1, 'reserved event is attributable to run-A');
    check(readRunEventCounts(eventLog, 'run-B').reserved === 0, 'another runId sees none of it');

    await delay(260);
    const heartbeats = readEvents(eventLog).filter((entry) => entry.event === 'heartbeat' && entry.runId === 'run-A');
    check(heartbeats.length >= 1, 'active heartbeat proves the instance is alive', heartbeats.length);

    env.disposeAll();
    const finalEvents = readEvents(eventLog);
    check(finalEvents[finalEvents.length - 1].event === 'unmounted', 'dispose writes unmounted', finalEvents[finalEvents.length - 1].event);
    const afterDispose = heartbeats.length;
    await delay(200);
    const laterHeartbeats = readEvents(eventLog).filter((entry) => entry.event === 'heartbeat');
    check(laterHeartbeats.length === afterDispose, 'heartbeat stops after unmount', laterHeartbeats.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function scenarioPluginResumeSemantics() {
  scenario('restart, corruption and lost state all fail closed');
  const dir = mkdtempSync(join(tmpdir(), 'tla-budget-resume-'));
  try {
    const stateFile = join(dir, 'state.json');
    const eventLog = join(dir, 'events.jsonl');

    writeFileSync(stateFile, JSON.stringify({ used: 2, limit: 2 }) + '\n', 'utf8');
    const resumedHost = createFakeHost();
    const resumedEnv = pluginContext(resumedHost);
    applyPlugin(resumedEnv.ctx, { modelRequests: 2, stateFile, eventLog, runId: 'run-resume', heartbeatIntervalMs: 1000 });
    const mounted = readEvents(eventLog).filter((entry) => entry.event === 'mounted').pop();
    check(mounted.resumeMode === 'resumed', 'readable state resumes', mounted.resumeMode);
    const resumedTurn = await runTurn(resumedHost, { agentKey: 'after-restart' });
    check(resumedTurn.turnError !== null && resumedTurn.turnError.code === 'MODEL_REQUEST_BUDGET_EXCEEDED', 'exhausted allowance rejects the first request');
    check(resumedHost.sent().length === 0, 'no request is sent after restart', resumedHost.sent());
    resumedEnv.disposeAll();

    writeFileSync(stateFile, 'not json at all\n', 'utf8');
    const corruptHost = createFakeHost();
    const corruptEnv = pluginContext(corruptHost);
    applyPlugin(corruptEnv.ctx, { modelRequests: 2, stateFile, eventLog, runId: 'run-corrupt', heartbeatIntervalMs: 1000 });
    const corruptMounted = readEvents(eventLog).filter((entry) => entry.event === 'mounted' && entry.runId === 'run-corrupt').pop();
    check(corruptMounted.resumeMode === 'state-unreadable-budget-exhausted', 'unreadable state is treated as exhausted', corruptMounted.resumeMode);
    const corruptTurn = await runTurn(corruptHost, { agentKey: 'corrupt' });
    check(corruptTurn.turnError !== null && corruptHost.sent().length === 0, 'corrupt state sends nothing', corruptHost.sent());
    corruptEnv.disposeAll();

    const lostDir = mkdtempSync(join(tmpdir(), 'tla-budget-lost-'));
    const lostLog = join(lostDir, 'events.jsonl');
    mkdirSync(dirname(lostLog), { recursive: true });
    writeFileSync(lostLog, JSON.stringify({ event: 'reserved', runId: 'run-lost', used: 1 }) + '\n', 'utf8');
    const lostHost = createFakeHost();
    const lostEnv = pluginContext(lostHost);
    applyPlugin(lostEnv.ctx, { modelRequests: 2, stateFile: join(lostDir, 'state.json'), eventLog: lostLog, runId: 'run-lost', heartbeatIntervalMs: 1000 });
    const lostMounted = readEvents(lostLog).filter((entry) => entry.event === 'mounted').pop();
    check(lostMounted.resumeMode === 'state-lost-budget-exhausted', 'missing state with prior reserves is exhausted', lostMounted.resumeMode);
    const lostTurn = await runTurn(lostHost, { agentKey: 'lost' });
    check(lostTurn.turnError !== null && lostHost.sent().length === 0, 'lost state sends nothing', lostHost.sent());
    lostEnv.disposeAll();
    rmSync(lostDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function scenarioPluginWriteFailure() {
  scenario('apply is allowed to throw on IO failure — it is not claimed to be safe');
  const dir = mkdtempSync(join(tmpdir(), 'tla-budget-io-'));
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const host = createFakeHost();
    const env = pluginContext(host);
    let threw = null;
    try {
      applyPlugin(env.ctx, {
        modelRequests: 1,
        stateFile: join(blocker, 'nested', 'state.json'),
        eventLog: join(dir, 'events.jsonl'),
        runId: 'run-io',
      });
    } catch (error) {
      threw = error;
    }
    check(threw !== null, 'unwritable state path makes apply throw', threw && threw.code);
    check(host.sent().length === 0, 'no request was made during the failed mount', host.sent());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  await scenarioPluginRunBinding();
  await scenarioPluginResumeSemantics();
  await scenarioPluginWriteFailure();

  process.stdout.write('\n' + scenarios + ' scenarios, ' + checks + ' checks, ' + failures.length + ' failures\n');
  if (failures.length > 0) process.exitCode = 1;
}

await main();
