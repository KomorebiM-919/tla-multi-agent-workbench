#!/usr/bin/env node
// 启动前把"完整请求预算"算出来：不是估计，而是把同一份夹具在离线宿主里跑一遍，
// 数模型请求、工具轮询和状态变化。三种路径都要装进上限，否则这一轮就该先精简交互，
// 而不是把上限抬高。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { runRehearsal } from '../tests/lib/host-sim.mjs';

export const BUDGET_SCHEMA = 'tla.request-budget/v1';
export const REQUEST_CEILING = 40;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = join(HERE, '..', 'tests', 'fixtures', 'repair-loop-policy.v3.json');

export function readPolicy(policyPath = DEFAULT_POLICY) {
  return JSON.parse(readFileSync(policyPath, 'utf8'));
}

/**
 * shortest   —— 报告按时到达、成员不出错；
 * conservative—— 每条报告前先来一条"后台子代理结束"的结算通知（真实宿主常见）；
 * stressed   —— 再叠加重复投递的结算通知。
 */
export function planBudget({ policy, ceiling = REQUEST_CEILING } = {}) {
  const active = policy ?? readPolicy();
  const runs = {};
  for (const [name, options] of [
    ['shortest', {}],
    ['conservative', { settlementsBeforeMailbox: 1 }],
    ['stressed', { settlementsBeforeMailbox: 1, duplicateSettlements: 1 }],
    // 参考值：如果成员退回“一次回复只调一个工具”，宿主会每回复一次就唤醒队长，
    // 同一份夹具要 50 次请求——装不进 40。它不参与 fits 判定，只说明“别退回
    // 单调用回复”，而不是“把上限调大”。
    ['perReplyWakes', { perReplyWakes: true }]
  ]) {
    const result = runRehearsal({ policy: active, options });
    runs[name] = {
      ok: result.ok,
      closed: result.closed,
      requests: result.requests,
      idleWaits: result.stats.idleWaits,
      polls: result.stats.polls,
      stateChanges: result.stats.stateChanges,
      error: result.error
    };
  }
  const problems = [];
  for (const [name, run] of Object.entries(runs)) {
    if (run.ok !== true) problems.push(name + ' does not close: ' + (run.error === null ? 'unknown' : run.error.code + ': ' + run.error.message));
    if (name === 'perReplyWakes') continue;
    if (run.requests > ceiling) problems.push(name + ' needs ' + String(run.requests) + ' requests, above the ceiling of ' + String(ceiling));
  }
  const required = Math.max(...Object.entries(runs).filter(([name]) => name !== 'perReplyWakes').map(([, run]) => run.requests));
  return {
    schema: BUDGET_SCHEMA,
    ceiling,
    runs,
    required,
    fits: required <= ceiling && problems.length === 0,
    problems
  };
}

function main(argv) {
  const args = argv.slice(2);
  const policyPath = args.includes('--policy') ? args[args.indexOf('--policy') + 1] : DEFAULT_POLICY;
  const plan = planBudget({ policy: readPolicy(resolve(policyPath)) });
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  return plan.fits ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('budget-plan.mjs')) {
  process.exitCode = main(process.argv);
}
