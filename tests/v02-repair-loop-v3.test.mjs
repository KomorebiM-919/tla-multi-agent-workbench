// 按真实调度重建的离线闭环（不启动宿主）。
//
// 这一份测的不是"策略有多少条规则"，而是三件事：
//   1. 队长的等待方式变了：**结束回合等唤醒**，不再反复调 status（polls 必须为 0）；
//   2. 成员每结束一次回合，队长就被唤醒一次——和第五次真实运行记录的顺序一致；
//   3. 退化情况（报告迟到、重复结算通知、成员报错、没有状态变化）都以**有限**的
//      失败结束，而不是靠调大额度装作跑通。
//
// 工具是真的：write 真写磁盘、`pwsh node test/sum.test.mjs` 真起子进程跑测试，
// 写之前必须先读（和宿主契约一致）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRehearsal } from './lib/host-sim.mjs';
import { planBudget, REQUEST_CEILING } from '../tools/budget-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(readFileSync(join(HERE, 'fixtures', 'repair-loop-policy.v3.json'), 'utf8'));

const failures = [];
let checks = 0;
function check(condition, label, detail = '') {
  checks += 1;
  if (!condition) failures.push(label + (detail === '' ? '' : ' — ' + String(detail)));
}

function run(options = {}) {
  return runRehearsal({ policy: POLICY, options });
}

// ---- 1. 完整闭环 ---------------------------------------------------------

const closed = run();
check(closed.ok === true, 'the loop closes offline', JSON.stringify(closed.error));
check(closed.requests === 31, 'the closed path takes 31 model requests', String(closed.requests));
check(closed.stats.polls === 0, 'the captain never polls', String(closed.stats.polls));
check(closed.stats.idleWaits === 0, 'no idle wait was needed when reports arrive on time', String(closed.stats.idleWaits));
check(closed.world.tasks.length === 4, 'four tasks exist (implement, review, repair, re-review)', String(closed.world.tasks.length));
check(closed.world.tasks.every((task) => task.status === 'completed'), 'every task ends completed', JSON.stringify(closed.world.tasks.map((t) => t.status)));
check(closed.world.writes.filter((write) => write.session === 'worker').length === 2, 'the worker writes the implementation twice', String(closed.world.writes.length));
check(closed.world.tests.map((test) => test.exitCode).join(',') === '1,1,0,0', 'the suite goes red, red, green, green', JSON.stringify(closed.world.tests.map((t) => t.exitCode)));
check(closed.world.tests[2].text.includes('3 passed, 0 failed'), 'the repaired run is fully green', closed.world.tests[2].text);
check(closed.world.files['src/sum.mjs'].includes('total + value'), 'the fix keeps the sign of negatives', closed.world.files['src/sum.mjs']);

const reviewRejection = closed.trace.findIndex((step) => step.rule === 'reviewer-rejects-t2');
const repairDispatch = closed.trace.findIndex((step) => step.rule === 'captain-dispatches-repair');
const rereeviewDispatch = closed.trace.findIndex((step) => step.rule === 'captain-dispatches-rereview');
check(reviewRejection > 0 && repairDispatch > reviewRejection, 'a repair is dispatched only after the review rejected', String(reviewRejection) + '/' + String(repairDispatch));
check(rereeviewDispatch > repairDispatch, 'the re-review is dispatched after the repair', String(rereeviewDispatch));
check(closed.trace[closed.trace.length - 1].rule === 'captain-closes-the-loop', 'the captain closes the loop', closed.trace[closed.trace.length - 1].rule);

// ---- 2. 真实交错：成员每次回复之后队长被唤醒一次 --------------------------

// 批量回复的形状：成员一个回合里连着几次请求，回合结束后队长被唤醒一次。
let unwokenTurnEnds = 0;
for (let index = 0; index < closed.trace.length - 1; index += 1) {
  const current = closed.trace[index];
  const next = closed.trace[index + 1];
  if (current.session !== 'captain' && next.session !== 'captain' && current.rule === 'member-ends-after-report') unwokenTurnEnds += 1;
}
check(unwokenTurnEnds === 0, 'every member turn end is followed by a captain turn (batched shape)', String(unwokenTurnEnds));
const captainSteps = closed.trace.filter((step) => step.session === 'captain').length;
const memberSteps = closed.trace.length - captainSteps;
check(captainSteps === 9, 'nine captain requests', String(captainSteps));
check(memberSteps === 22, 'twenty-two member requests', String(memberSteps));

// 最悲观形状：宿主在成员每次回复后都唤醒队长，请求数 1:1 交替。
// 同一条策略仍然闭合，但要 50 次请求——所以"别退回单调用回复"是硬约束。
const perReply = run({ perReplyWakes: true });
check(perReply.ok === true, 'the per-reply-wake shape still closes', JSON.stringify(perReply.error));
check(perReply.requests === 50, 'the per-reply shape needs 50 requests', String(perReply.requests));
check(perReply.stats.idleWaits >= 16, 'the per-reply shape pays one idle wait per member reply', String(perReply.stats.idleWaits));
check(perReply.stats.polls === 0, 'even the pessimistic shape never polls', String(perReply.stats.polls));

// ---- 3. 报告迟到：仍然有限、仍然闭合 --------------------------------------

const late = run({ settlementsBeforeMailbox: 1 });
check(late.ok === true, 'a late report still closes', JSON.stringify(late.error));
check(late.requests === 35, 'a late report costs four extra captain requests', String(late.requests));
check(late.stats.idleWaits === 4, 'the four waits are counted as idle waits, not as progress', String(late.stats.idleWaits));
check(late.stats.polls === 0, 'a late report does not make the captain poll', String(late.stats.polls));

// ---- 4. 重复结算通知：仍然闭合，等待有上限 --------------------------------

const duplicate = run({ settlementsBeforeMailbox: 1, duplicateSettlements: 1 });
check(duplicate.ok === true, 'duplicate settlement notices still close', JSON.stringify(duplicate.error));
check(duplicate.requests === 38, 'duplicates cost 38 requests, still under the ceiling', String(duplicate.requests));

// ---- 5. 成员报错：不会假装完成 -------------------------------------------

const memberError = run({ memberErrorOnFirstReport: true });
check(memberError.ok === false, 'a member error does not close the loop', String(memberError.ok));
check(memberError.error !== null && memberError.error.code === 'NO_PROGRESS', 'a member error ends in NO_PROGRESS, not in a hang', JSON.stringify(memberError.error));
check(memberError.world.tasks[0].status === 'failed', 'the first task is recorded as failed', String(memberError.world.tasks[0].status));
check(memberError.trace.every((step) => step.rule !== 'captain-dispatches-review'), 'a failed task never triggers a review', '');

// ---- 6. 没有状态变化的重复唤醒：有限失败 ----------------------------------

const noChange = run({ startSettlements: 20 });
check(noChange.ok === false, 'repeated settlement notices without progress do not close', String(noChange.ok));
check(noChange.error !== null && noChange.error.code === 'NO_PROGRESS', 'bounded idle-wait ends in NO_PROGRESS', JSON.stringify(noChange.error));
check(noChange.requests < 20, 'the bounded path stops early instead of spinning', String(noChange.requests));

// ---- 7. 完整预算：三条路径都要装进 40 ------------------------------------

const budget = planBudget({ policy: POLICY });
check(budget.fits === true, 'every path fits in the request ceiling', JSON.stringify(budget.problems));
check(budget.required <= REQUEST_CEILING, 'the widest path stays under 40 requests', String(budget.required));
check(budget.runs.shortest.requests === 31 && budget.runs.conservative.requests === 35, 'budget reports the measured paths', JSON.stringify(budget.runs));
check(Object.values(budget.runs).every((item) => item.polls === 0), 'no path relies on polling', JSON.stringify(budget.runs));

// ---- 8. 策略里的工具参数必须符合真实宿主的 schema -------------------------
//
// 这份 schema 是第一次真实运行（exp-mvetu4cl-b631b01f）里宿主自己发来的工具清单，
// 不是手抄。0.2.1-rc.2 的 read/write 要 `file_path`、pwsh 要 `description`，
// 0.1.25 的 update_task 还要求回传 attempt_id——旧策略在这三处都会立刻失败。

const TOOL_SCHEMAS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'host-tool-schemas.dsh-0.2.1-rc.2.json'), 'utf8')).tools;
const policyCalls = [];
for (const rule of POLICY.rules) {
  for (const call of (rule.reply && rule.reply.toolCalls) || []) policyCalls.push({ rule: rule.name, call });
}
check(policyCalls.length > 0, 'the policy actually calls tools', String(policyCalls.length));
check(policyCalls.every(({ call }) => TOOL_SCHEMAS[call.name] !== undefined), 'every policy tool name exists in the host tool list', JSON.stringify(policyCalls.filter(({ call }) => TOOL_SCHEMAS[call.name] === undefined).map(({ call }) => call.name)));
const unknownCalls = policyCalls.filter(({ call }) => {
  const schema = TOOL_SCHEMAS[call.name];
  if (schema === undefined) return false;
  return Object.keys(call.input ?? {}).some((key) => !schema.properties.includes(key));
});
check(unknownCalls.length === 0, 'no policy tool argument is unknown to the host', JSON.stringify(unknownCalls.map(({ rule, call }) => rule + ':' + call.name + ':' + JSON.stringify(Object.keys(call.input ?? {})))));
const missingCalls = policyCalls.filter(({ call }) => {
  const schema = TOOL_SCHEMAS[call.name];
  if (schema === undefined) return false;
  return schema.required.some((key) => call.input === undefined || call.input[key] === undefined);
});
check(missingCalls.length === 0, 'every required host argument is present', JSON.stringify(missingCalls.map(({ rule, call }) => rule + ':' + call.name)));
check(policyCalls.filter(({ call }) => call.name === 'agent_teams_update_task' && call.input.status !== undefined).every(({ call }) => call.input.attempt_id !== undefined), 'every status update carries the current attempt_id');
check(policyCalls.filter(({ call }) => call.name === 'pwsh').every(({ call }) => typeof call.input.description === 'string' && call.input.description !== ''), 'every shell call carries a description');

// ---- 报告 ----------------------------------------------------------------

if (failures.length > 0) {
  console.error('FAILED ' + String(failures.length) + ' of ' + String(checks) + ' checks');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('v02-repair-loop-v3: ' + String(checks) + ' checks passed');
}
