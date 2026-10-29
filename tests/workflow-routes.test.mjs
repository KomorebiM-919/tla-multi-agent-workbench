// tests/workflow-routes.test.mjs
//
// 工作流阶段路由（args.routes）接线回归测试（**不调用真实子代理**）
//
// 做法与 tests/workflow-logic.test.mjs 相同：tests/workflow-harness.mjs 用 node:vm
// 读取生产脚本 workflows/three-agent-mvp.js，注入模拟的 agent() 钩子；本文件只声明场景。
// 每个模拟调用都会记录实际收到的 provider/model —— 这能证明"参数按宿主形状传进去了"，
// **不能**证明模型真的按该路由执行（离线替身没有 LLM 层）。
//
// 运行：node tests/workflow-routes.test.mjs
// 仅使用 Node 标准库，未安装任何依赖。

import {
  FAILED_OUTPUT, baseArgs, codingOk, happyPlan, makeRunner, reviewOk, verifyFailed, verifyOk
} from './workflow-harness.mjs';

const runner = makeRunner();
const scenario = runner.scenario;

const PHASES = ['preflight', 'requirement', 'coding', 'verify', 'review'];

/** 一份完整、有效的五阶段路由。 */
function fullRoutes() {
  const routes = {};
  PHASES.forEach(function (phase) {
    routes[phase] = { provider: 'provider-' + phase, model: 'model-' + phase };
  });
  return routes;
}

function argsWithRoutes(routes) {
  const args = baseArgs();
  args.routes = routes;
  return args;
}

/** 每个模拟调用实际收到的 {label, phase, provider, model}。 */
function callOptions(captured) {
  return captured.map(function (call) {
    return { label: call.label, phase: call.phase, provider: call.provider, model: call.model };
  });
}

/** 断言：每个阶段调用的 provider/model 与路由表一致（修订轮沿用本阶段路由）。 */
function expectRoutesFrom(captured, routes, check) {
  const wrong = [];
  captured.forEach(function (call) {
    const base = PHASES.filter(function (phase) {
      return typeof call.phase === 'string' && (call.phase === phase || call.phase.indexOf(phase + '-revision-') === 0);
    })[0];
    if (base === undefined) {
      wrong.push(call.label + '：阶段 ' + call.phase + ' 不在五键路由表内');
      return;
    }
    if (call.provider !== routes[base].provider || call.model !== routes[base].model) {
      wrong.push(call.label + '（' + call.phase + '）收到 ' + JSON.stringify({ provider: call.provider, model: call.model }) +
        '，期望 ' + JSON.stringify(routes[base]));
    }
  });
  check('每次调用都带上对应阶段的路由', wrong.length === 0, wrong.join('；'));
}

// ---------------------------------------------------------------- 正例

// 1. 省略 routes：保持父会话继承（不得凭空塞 provider/model）
{
  const captured = [];
  await scenario('省略 routes → 保持父会话继承，五个调用都不带 provider/model',
    happyPlan(),
    baseArgs(),
    {
      status: 'OK',
      ok: true,
      attempts: 1,
      calls: 5,
      extra: function (result, outcome, check) {
        const leaked = callOptions(captured).filter(function (call) {
          return call.provider !== undefined || call.model !== undefined;
        });
        check('没有调用被写入 provider/model', leaked.length === 0, JSON.stringify(leaked));
        check('结果里的 requested 路由为空', result.routing && result.routing.requested === null,
          JSON.stringify(result.routing));
      }
    },
    { capture: captured });
}

// 2. 完整 routes：五个阶段各用自己的 provider/model
{
  const captured = [];
  const routes = fullRoutes();
  await scenario('完整 routes → 五个阶段各用自己阶段的路由',
    happyPlan(),
    argsWithRoutes(routes),
    {
      status: 'OK',
      ok: true,
      attempts: 1,
      calls: 5,
      extra: function (result, outcome, check) {
        check('恰好 5 次调用', captured.length === 5, '实际 ' + captured.length);
        expectRoutesFrom(captured, routes, check);
        check('结果记录请求的路由', result.routing && result.routing.requested !== null &&
          result.routing.requested.coding.provider === routes.coding.provider, JSON.stringify(result.routing));
        check('结果不声称路由已生效', result.routing && result.routing.effective === 'unverified',
          JSON.stringify(result.routing));
      }
    },
    { capture: captured });
}

// 3. 返工轮沿用对应阶段路由（第二轮 coding/verify/review 仍是本阶段路由）
{
  const captured = [];
  const routes = fullRoutes();
  await scenario('返工轮沿用阶段路由：第二轮 coding/verify/review 仍用本阶段 provider/model',
    happyPlan({
      review: function (attempt) {
        if (attempt === 1) {
          return reviewOk({ verdict: 'CHANGES_REQUESTED', issues: [{ file: 'text_stats.py', problem: '需要修改', suggestion: '修复' }] });
        }
        return reviewOk();
      },
      coding: function (attempt) { return codingOk({ implementation_summary: '第 ' + attempt + ' 轮实现' }); }
    }),
    argsWithRoutes(routes),
    {
      status: 'OK',
      ok: true,
      attempts: 2,
      calls: 8,
      extra: function (result, outcome, check) {
        expectRoutesFrom(captured, routes, check);
        const revisions = callOptions(captured).filter(function (call) {
          return typeof call.phase === 'string' && call.phase.indexOf('-revision-') !== -1;
        });
        check('存在修订轮调用', revisions.length === 3, JSON.stringify(revisions.map(function (c) { return c.phase; })));
        check('修订轮的阶段名与路由键分开', revisions.every(function (call) {
          return /^(coding|verify|review)-revision-2$/.test(call.phase);
        }), JSON.stringify(revisions.map(function (c) { return c.phase; })));
      }
    },
    { capture: captured });
}

// 4. 预算与成功判据不因路由改变：超预算仍按预算中止，且已启动次数与之前一致
{
  const captured = [];
  const routes = fullRoutes();
  await scenario('带 routes 时预算仍然生效 → AGENT_CALL_BUDGET_EXCEEDED',
    happyPlan(),
    Object.assign(baseArgs({ task: { maxAgentCalls: 3 } }), { routes: routes }),
    {
      status: 'AGENT_CALL_BUDGET_EXCEEDED',
      ok: false,
      calls: 3,
      extra: function (result, outcome, check) {
        check('预算台账与之前一致', result.agentCallBudget && result.agentCallBudget.limit === 3,
          JSON.stringify(result.agentCallBudget));
        check('未启动的调用没有被写入 provider/model', callOptions(captured).length === 3, '实际 ' + captured.length);
      }
    },
    { capture: captured });
}

// ---------------------------------------------------------------- 反例：必须在首次 agent() 之前拒绝

function invalidScenario(name, routes, expectText) {
  const captured = [];
  return scenario(name,
    happyPlan(),
    argsWithRoutes(routes),
    {
      status: 'INVALID_ARGS',
      ok: false,
      calls: 0,
      errorIncludes: expectText,
      extra: function (result, outcome, check) {
        check('没有启动任何子代理', captured.length === 0, '实际启动了 ' + captured.length + ' 次');
      }
    },
    { capture: captured });
}

await invalidScenario('缺项（只有四个阶段）→ INVALID_ARGS',
  (function () { const routes = fullRoutes(); delete routes.review; return routes; })(),
  'routes');

await invalidScenario('未知阶段键 → INVALID_ARGS',
  Object.assign(fullRoutes(), { planning: { provider: 'p', model: 'm' } }),
  'routes');

await invalidScenario('阶段内出现未知字段 cwd → INVALID_ARGS（不得静默丢弃）',
  Object.assign(fullRoutes(), { coding: { provider: 'p', model: 'm', cwd: 'D:/tmp' } }),
  'cwd');

await invalidScenario('阶段内出现 reasoningEffort → INVALID_ARGS',
  Object.assign(fullRoutes(), { verify: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
  'reasoningEffort');

await invalidScenario('provider 为空字符串 → INVALID_ARGS',
  Object.assign(fullRoutes(), { preflight: { provider: '', model: 'm' } }),
  'routes');

await invalidScenario('model 为 null → INVALID_ARGS',
  Object.assign(fullRoutes(), { requirement: { provider: 'p', model: null } }),
  'routes');

await invalidScenario('provider 不是字符串 → INVALID_ARGS',
  Object.assign(fullRoutes(), { review: { provider: 7, model: 'm' } }),
  'routes');

await invalidScenario('阶段值不是对象 → INVALID_ARGS',
  Object.assign(fullRoutes(), { coding: 'provider-x' }),
  'routes');

// routes 显式给 null：不视为"省略"，必须拒绝
{
  const captured = [];
  await scenario('routes 为 null → INVALID_ARGS（显式提供就必须完整有效）',
    happyPlan(),
    argsWithRoutes(null),
    {
      status: 'INVALID_ARGS',
      ok: false,
      calls: 0,
      errorIncludes: 'routes',
      extra: function (result, outcome, check) {
        check('没有启动任何子代理', captured.length === 0, '实际 ' + captured.length + ' 次');
      }
    },
    { capture: captured });
}

// routes 不是对象
{
  const captured = [];
  await scenario('routes 为数组 → INVALID_ARGS',
    happyPlan(),
    argsWithRoutes(['preflight']),
    {
      status: 'INVALID_ARGS',
      ok: false,
      calls: 0,
      errorIncludes: 'routes',
      extra: function (result, outcome, check) {
        check('没有启动任何子代理', captured.length === 0, '实际 ' + captured.length + ' 次');
      }
    },
    { capture: captured });
}

// 5. 反例：无效路由不得改变成功判据 —— 一次合法的完整 routes 运行仍然 OK
{
  const captured = [];
  await scenario('合法 routes 不影响成功判据（回归）',
    happyPlan({
      coding: function () { return codingOk({ test_succeeded: false, test_exit_code: '1', test_output_excerpt: FAILED_OUTPUT }); },
      verify: function () { return verifyFailed(); },
      review: function () { return reviewOk({ independent_test_exit_code: '1', independent_test_output: FAILED_OUTPUT }); }
    }),
    Object.assign(baseArgs({ task: { maxCodingAttempts: 1 } }), { routes: fullRoutes() }),
    {
      status: 'TEST_NOT_VERIFIED',
      ok: false,
      calls: 5,
      extra: function (result, outcome, check) {
        check('路由没有掩盖验证失败', result.finalDecision.testsIndependentlyVerified === false,
          JSON.stringify(result.finalDecision.testsIndependentlyVerified));
      }
    },
    { capture: captured });
}

runner.finish('工作流阶段路由（args.routes）回归');
