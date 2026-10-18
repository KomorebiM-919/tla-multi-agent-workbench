// 返工闭环的离线状态机检查（不启动宿主）。
//
// 与 `v02-repair-rehearsal.test.mjs` 的区别：这里用的是**closure 实验修好的
// 40 条规则**，覆盖"权限预检 → 实现 → 返工 → 复审通过 → 收尾"整条链路，
// 并把每个真实失败分支都钉住：
//   - 建队失败 → 终止（不重试）
//   - 写文件失败 → 回读后重试一次（不是无限重试）
//   - 预检红 → 终止
//   - 空结果 / 工具报错 / 原地重复 → 一律不算推进
//
// 它证明的是**策略的有限推进**，不证明宿主真的这样调度。宿主实验仍是另一件事。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReactiveModel } from './lib/reactive-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(readFileSync(join(HERE, 'fixtures', 'repair-loop-policy.v2.json'), 'utf8'));

const TEAM = 'fixture-loop';
const failures = [];
let checks = 0;
function check(condition, label, detail = '') {
  checks += 1;
  if (!condition) failures.push(label + (detail === '' ? '' : ' — ' + String(detail)));
}

const CAPTAIN_TOOLS = ['agent_teams_create', 'agent_teams_status', 'agent_teams_create_task'];
const MEMBER_TOOLS = ['agent_teams_claim_task', 'agent_teams_update_task', 'read', 'write', 'pwsh'];

let counter = 0;
const nextId = () => 'toolu_loop_' + ++counter;
const turn = (name, text, { isError = false, input = {} } = {}) => {
  const id = nextId();
  return { calls: [{ id, name, input }], results: [{ id, text, isError }] };
};

function request({ role, prompt, turns }) {
  const messages = [
    { role: 'system', content: role === 'captain' ? `You are the captain of team ${TEAM}.` : `You are ${role}, a member of team ${TEAM}.` },
    { role: 'user', content: prompt },
  ];
  for (const t of turns) {
    messages.push({ role: 'assistant', content: t.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) });
    messages.push({
      role: 'user',
      content: t.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, is_error: r.isError, content: [{ type: 'text', text: r.text }] })),
    });
  }
  return { tools: (role === 'captain' ? CAPTAIN_TOOLS : MEMBER_TOOLS).map((name) => ({ name })), messages };
}

const CLAIM = (task, who, attempt, uuid) => `Task ${task} claimed by ${who} (attempt ${attempt}, attempt_id ${uuid}, status claimed).`;
const UPDATED = (task, attempt, status) => `Task ${task} attempt ${attempt} → ${status}\nOutput: ok`;
const WROTE = (p) => `<path>${p}</path>\n<type>file</type>\n<content>\nUpdated file\n</content>`;
const NOTE_TEXT = '<path>src/note.txt</path>\n<type>file</type>\n<content>\nPREFLIGHT-BASELINE\n</content>';
const STUB_TEXT = "<path>src/sum.mjs</path>\n<type>file</type>\n<content>\n// STUB: the implementation task has not been done yet.\nexport function sum(values) {\n  throw new Error('sum is not implemented yet');\n}\n</content>";
const RED = 'FAIL sum([1,-2,3]) === 2 (actual 4)\nsum tests: 2 passed, 1 failed';
const GREEN = 'PASS sum([]) === 0 (actual 0)\nPASS sum([1,-2,3]) === 2 (actual 2)\nPASS sum([0]) === 0 (actual 0)\nsum tests: 3 passed, 0 failed';

const captainPrompt = `You are the captain of team ${TEAM}.`;
const workerPrompt = `Task t1: implement sum() in src/sum.mjs. You are worker, a member of team ${TEAM}.`;
const repairPrompt = `Task t3: repair the rejected change. You are worker, a member of team ${TEAM}.`;
const reviewPrompt = `Task t2: review the sum() change. You are reviewer, a member of team ${TEAM}.`;
const reReviewPrompt = `Task t4: re-review the repaired change. You are reviewer, a member of team ${TEAM}.`;

const model = createReactiveModel(POLICY, { maxNoProgress: 3 });
const decisions = [];

function step(label, expected, req) {
  let decision;
  try {
    decision = model.decide(req);
  } catch (error) {
    failures.push(`${label} — threw ${error.code}: ${error.message}`);
    checks += 1;
    return null;
  }
  decisions.push({ label, rule: decision.rule, role: decision.role, state: decision.state });
  check(decision.rule === expected, label, `expected ${expected}, got ${decision.rule}`);
  return decision;
}

// ---------------------------------------------------------------- 完整链路

step('captain creates the team', 'captain-creates-team', request({ role: 'captain', prompt: captainPrompt, turns: [] }));
step('captain polls after creating', 'captain-polls-after-create', request({
  role: 'captain', prompt: captainPrompt, turns: [turn('agent_teams_create', `Team ${TEAM} created.`)],
}));
step('captain polls while the worker holds t1', 'captain-polls-while-members-work', request({
  role: 'captain', prompt: captainPrompt,
  turns: [
    turn('agent_teams_create', `Team ${TEAM} created.`),
    turn('agent_teams_status', 'Team "' + TEAM + '" — demo\nTasks (1):\n  - t1 [claimed] work attempt 1 seed T1 Implement sum() → worker\n'),
  ],
}));
step('captain creates the review after t1 failed', 'captain-creates-review-task', request({
  role: 'captain', prompt: captainPrompt,
  turns: [turn('agent_teams_create', `Team ${TEAM} created.`), turn('agent_teams_status', 't1 [failed] worker\n')],
}));
step('captain polls after creating the review', 'captain-polls-after-review-task', request({
  role: 'captain', prompt: captainPrompt,
  turns: [
    turn('agent_teams_create', `Team ${TEAM} created.`),
    turn('agent_teams_status', 't1 [failed] worker\n'),
    turn('agent_teams_create_task', 'Task t2 created.'),
  ],
}));
step('captain stops when t4 completed', 'captain-stops-when-loop-closed', request({
  role: 'captain', prompt: captainPrompt,
  turns: [
    turn('agent_teams_create', `Team ${TEAM} created.`),
    turn('agent_teams_status', 't1 [failed] worker\n'),
    turn('agent_teams_create_task', 'Task t2 created.'),
    turn('agent_teams_status', 't1 [failed]\nt2 [completed]\nt3 [completed]\nt4 [completed]\n'),
  ],
}));

// worker: implementation round, including the preflight write
const w1 = [turn('agent_teams_claim_task', CLAIM('t1', 'worker', 1, '11111111-1111-4111-8111-111111111111'))];
step('worker claims t1', 'worker-claims-task', request({ role: 'worker', prompt: workerPrompt, turns: [] }));
step('worker starts t1', 'worker-starts-task', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('agent_teams_update_task', UPDATED('t1', 1, 'in_progress')));
step('worker reads the source', 'worker-reads-source', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('read', STUB_TEXT, { input: { file_path: 'src/sum.mjs' } }));
step('worker reads the note it is about to overwrite', 'worker-reads-note-before-write', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('read', NOTE_TEXT, { input: { file_path: 'src/note.txt' } }));
step('worker writes the note after reading it', 'worker-preflight-writes-note', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('write', WROTE('src/note.txt'), { input: { file_path: 'src/note.txt' } }));
step('worker runs the preflight test', 'worker-runs-preflight-test', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('pwsh', 'PASS note.txt = "PREFLIGHT-OK"\npreflight tests: 1 passed, 0 failed', { input: { command: 'node test/preflight.test.mjs' } }));
step('worker re-reads the source after preflight', 'worker-reads-source-after-preflight', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('read', STUB_TEXT, { input: { file_path: 'src/sum.mjs' } }));
step('worker implements v1', 'worker-implements-v1', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('write', WROTE('src/sum.mjs'), { input: { file_path: 'src/sum.mjs' } }));
step('worker runs the test after v1', 'worker-runs-test-after-v1', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));
w1.push(turn('pwsh', RED, { input: { command: 'node test/sum.test.mjs' } }));
step('worker reports the red test', 'worker-reports-red-test', request({ role: 'worker', prompt: workerPrompt, turns: w1 }));

// worker: repair round (a new claim changes the session key)
const w2 = [turn('agent_teams_claim_task', CLAIM('t3', 'worker', 1, '33333333-3333-4333-8333-333333333333'))];
step('repair claims t3', 'worker-claims-task', request({ role: 'worker', prompt: repairPrompt, turns: [] }));
step('repair starts t3', 'worker-starts-task', request({ role: 'worker', prompt: workerPrompt, turns: w2 }));
w2.push(turn('agent_teams_update_task', UPDATED('t3', 1, 'in_progress')));
step('repair reads the source', 'worker-reads-source', request({ role: 'worker', prompt: workerPrompt, turns: w2 }));
w2.push(turn('read', STUB_TEXT.replace('STUB: the implementation task has not been done yet.', 'FIX-V1'), { input: { file_path: 'src/sum.mjs' } }));
step('repair rewrites the source after reading it', 'worker-rewrites-source-after-read', request({ role: 'worker', prompt: workerPrompt, turns: w2 }));
w2.push(turn('write', WROTE('src/sum.mjs'), { input: { file_path: 'src/sum.mjs' } }));
step('repair runs the test', 'worker-runs-test-after-v2', request({ role: 'worker', prompt: workerPrompt, turns: w2 }));
w2.push(turn('pwsh', GREEN, { input: { command: 'node test/sum.test.mjs' } }));
step('repair completes t3', 'worker-completes-repair', request({ role: 'worker', prompt: workerPrompt, turns: w2 }));

// reviewer: first review rejects, re-review passes
const r1 = [turn('agent_teams_claim_task', CLAIM('t2', 'reviewer', 1, '22222222-2222-4222-8222-222222222222'))];
step('review claims t2', 'reviewer-claims-task', request({ role: 'reviewer', prompt: reviewPrompt, turns: [] }));
step('review starts t2', 'reviewer-starts-review', request({ role: 'reviewer', prompt: reviewPrompt, turns: r1 }));
r1.push(turn('agent_teams_update_task', UPDATED('t2', 1, 'in_progress')));
step('review runs the test', 'reviewer-runs-test', request({ role: 'reviewer', prompt: reviewPrompt, turns: r1 }));
r1.push(turn('pwsh', RED, { input: { command: 'node test/sum.test.mjs' } }));
step('review rejects the red result', 'reviewer-rejects', request({ role: 'reviewer', prompt: reviewPrompt, turns: r1 }));

const r2 = [turn('agent_teams_claim_task', CLAIM('t4', 'reviewer', 1, '44444444-4444-4444-8444-444444444444'))];
step('re-review claims t4', 'reviewer-claims-task', request({ role: 'reviewer', prompt: reReviewPrompt, turns: [] }));
step('re-review starts t4', 'reviewer-starts-review', request({ role: 'reviewer', prompt: reReviewPrompt, turns: r2 }));
r2.push(turn('agent_teams_update_task', UPDATED('t4', 1, 'in_progress')));
step('re-review runs the test', 'reviewer-runs-test', request({ role: 'reviewer', prompt: reReviewPrompt, turns: r2 }));
r2.push(turn('pwsh', GREEN, { input: { command: 'node test/sum.test.mjs' } }));
step('re-review passes the green result', 'reviewer-passes', request({ role: 'reviewer', prompt: reReviewPrompt, turns: r2 }));

// ---------------------------------------------------------------- 计数

const captainPolls = decisions.filter((d) => d.rule.startsWith('captain-polls-')).length;
const memberResponses = decisions.filter((d) => d.role !== 'captain').length;
const captainResponses = decisions.filter((d) => d.role === 'captain').length;
check(decisions.length === 30, 'the whole loop fits in 30 decisions', decisions.length);
check(captainPolls === 3, 'captain polls are counted separately from member work', captainPolls);
check(captainResponses === 6, 'captain decisions are 6 (create, 3 polls, review task, stop)', captainResponses);
check(memberResponses === 24, 'member decisions are 24 and never include polling', memberResponses);
check(memberResponses + captainResponses === decisions.length, 'every decision has exactly one side', memberResponses + captainResponses);
check(decisions.some((d) => d.rule === 'reviewer-rejects'), 'the red review branch is exercised', 'missing reviewer-rejects');
check(decisions.some((d) => d.rule === 'reviewer-passes'), 'the green re-review branch is exercised', 'missing reviewer-passes');

// ---------------------------------------------------------------- 失败分支

function decideOr(fn) {
  try {
    return { decision: fn(), error: null };
  } catch (error) {
    return { decision: null, error };
  }
}

// 建队失败 → 终止，不重试
{
  const failureModel = createReactiveModel(POLICY, { maxNoProgress: 3 });
  const { decision } = decideOr(() => failureModel.decide(request({
    role: 'captain', prompt: captainPrompt,
    turns: [turn('agent_teams_create', 'Error: team "fixture-loop" already exists', { isError: true })],
  })));
  check(decision !== null && decision.rule === 'captain-create-failed', 'a failed team creation stops instead of retrying', decision && decision.rule);
  check(decision !== null && /stop|FAILED/i.test(JSON.stringify(decision.reply)), 'the stop reply says why', decision && JSON.stringify(decision.reply).slice(0, 80));
}

// 写文件失败（未读过）→ 回读后重试一次，而不是原地重试
{
  const retryModel = createReactiveModel(POLICY, { maxNoProgress: 3 });
  const base = [
    turn('agent_teams_claim_task', CLAIM('t1', 'worker', 1, '11111111-1111-4111-8111-111111111111')),
    turn('agent_teams_update_task', UPDATED('t1', 1, 'in_progress')),
    turn('read', STUB_TEXT, { input: { file_path: 'src/sum.mjs' } }),
  ];
  retryModel.decide(request({ role: 'worker', prompt: workerPrompt, turns: base.slice(0, 1) }));
  retryModel.decide(request({ role: 'worker', prompt: workerPrompt, turns: base.slice(0, 2) }));
  retryModel.decide(request({ role: 'worker', prompt: workerPrompt, turns: base.slice(0, 3) }));
  const writeError = turn('write', 'Error: cannot modify "src/note.txt": file has not been read — read the file, then retry', { isError: true, input: { file_path: 'src/note.txt' } });
  const { decision } = decideOr(() => retryModel.decide(request({ role: 'worker', prompt: workerPrompt, turns: [...base, writeError] })));
  check(decision !== null && decision.rule === 'worker-preflight-write-failed', 'a refused write goes back to reading, not to retrying blindly', decision && (decision.rule || decision));
  const reply = decision ? JSON.stringify(decision.reply) : '';
  check(/"name":"read"/.test(reply), 'the retry is a read', reply.slice(0, 90));

  // 同一失败重复出现：规则用完即终止，而不是无限重试
  let exhausted = null;
  for (let attempt = 0; attempt < 3 && exhausted === null; attempt += 1) {
    const again = decideOr(() => retryModel.decide(request({ role: 'worker', prompt: workerPrompt, turns: [...base, writeError] })));
    if (again.error !== null) exhausted = again.error;
  }
  check(exhausted !== null && /NO_PROGRESS|RULE_EXHAUSTED|MAX_USES/.test(exhausted.code + exhausted.message), 'repeating the same failure is bounded by maxUses', exhausted && exhausted.code);
}

// 预检红 → 终止
{
  const redModel = createReactiveModel(POLICY, { maxNoProgress: 3 });
  const base = [
    turn('agent_teams_claim_task', CLAIM('t1', 'worker', 1, '11111111-1111-4111-8111-111111111111')),
    turn('agent_teams_update_task', UPDATED('t1', 1, 'in_progress')),
    turn('read', STUB_TEXT, { input: { file_path: 'src/sum.mjs' } }),
    turn('read', NOTE_TEXT, { input: { file_path: 'src/note.txt' } }),
    turn('write', WROTE('src/note.txt'), { input: { file_path: 'src/note.txt' } }),
  ];
  for (let index = 1; index <= base.length; index += 1) redModel.decide(request({ role: 'worker', prompt: workerPrompt, turns: base.slice(0, index) }));
  const { decision } = decideOr(() => redModel.decide(request({
    role: 'worker', prompt: workerPrompt,
    turns: [...base, turn('pwsh', 'FAIL note.txt = "WRONG"\npreflight tests: 0 passed, 1 failed', { input: { command: 'node test/preflight.test.mjs' } })],
  })));
  check(decision !== null && decision.rule === 'worker-preflight-test-red', 'a red preflight stops the member', decision && (decision.rule || decision));
  check(decision !== null && !/in_progress|completed/.test(JSON.stringify(decision.reply)), 'the red preflight does not report completion', decision && JSON.stringify(decision.reply).slice(0, 80));
}

// 空结果不算推进
{
  const emptyModel = createReactiveModel(POLICY, { maxNoProgress: 3 });
  let emptyError = null;
  try {
    emptyModel.decide(request({ role: 'worker', prompt: workerPrompt, turns: [turn('read', '', { input: { file_path: 'src/sum.mjs' } })] }));
  } catch (error) {
    emptyError = error;
  }
  check(emptyError !== null && /RESULT_EMPTY|NO_PROGRESS/.test(emptyError.code), 'an empty tool result is not progress', emptyError && emptyError.code);
}

// 原地重复（同一状态同一结果）→ NO_PROGRESS，而不是无限轮询
{
  const loopModel = createReactiveModel(POLICY, { maxNoProgress: 3 });
  const pollTurn = turn('agent_teams_status', 't1 [claimed] worker\n');
  const createTurn = turn('agent_teams_create', `Team ${TEAM} created.`);
  loopModel.decide(request({ role: 'captain', prompt: captainPrompt, turns: [] }));
  loopModel.decide(request({ role: 'captain', prompt: captainPrompt, turns: [createTurn] }));
  let loopError = null;
  for (let attempt = 0; attempt < 9 && loopError === null; attempt += 1) {
    const result = decideOr(() => loopModel.decide(request({ role: 'captain', prompt: captainPrompt, turns: [createTurn, pollTurn] })));
    if (result.error !== null) loopError = result.error;
  }
  check(loopError !== null && /NO_PROGRESS/.test(loopError.code + loopError.message), 'identical polling results run out of progress', loopError && loopError.code);
}

// ---------------------------------------------------------------- 规则自身的边界

const rules = POLICY.rules;
check(rules.every((rule) => typeof rule.maxUses === 'number' && rule.maxUses >= 1), 'every rule has a finite maxUses');
check(rules.every((rule) => typeof rule.state === 'string' && rule.state.length > 0), 'every rule declares the state it matches');
check(rules.filter((rule) => rule.progressExempt === true).every((rule) => rule.maxUses <= 6), 'polling rules are the only progress-exempt ones and stay bounded');

// 工具报错绝不产生 completed
const completedRules = rules.filter((rule) => /status":"completed|status: completed/.test(JSON.stringify(rule.reply)) || /"status":"completed"/.test(JSON.stringify(rule.reply)));
check(completedRules.every((rule) => rule.match.isError !== true), 'no rule completes a task from an errored tool result', completedRules.map((rule) => rule.name).join(','));
check(!rules.some((rule) => rule.match.isError === true && /completed/.test(JSON.stringify(rule.reply))), 'no errored branch marks completion');

// 审核通过只在测试全绿时出现
const passRules = rules.filter((rule) => /PASS|passes/.test(rule.name) || /reviewer-passes/.test(rule.name));
check(passRules.length > 0, 'the pass rule exists', passRules.length);
const reviewerPass = rules.find((rule) => rule.name === 'reviewer-passes');
check(reviewerPass !== undefined && /0 failed/.test(String(reviewerPass.match.resultMatches || '')), 'review pass requires an explicit all-green test line', reviewerPass && reviewerPass.match.resultMatches);
check(reviewerPass !== undefined && reviewerPass.match.isError !== true, 'review pass cannot be reached from an error result');

// 修复完成只在测试全绿时出现
const completeRepair = rules.find((rule) => rule.name === 'worker-completes-repair');
check(completeRepair !== undefined && /0 failed/.test(String(completeRepair.match.resultMatches || '')), 'repair completion requires the all-green test line', completeRepair && completeRepair.match.resultMatches);

process.stdout.write(`v02-repair-loop: ${checks} checks, ${failures.length} failures\n`);
for (const failure of failures) process.stdout.write('  FAIL ' + failure + '\n');
if (failures.length > 0) process.exitCode = 1;
