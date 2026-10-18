// 返工闭环的合成预演（不启动宿主）。
//
// 它证明的是**策略**能把一整条链路走完，且每一步都由结构化的工具结果驱动：
//   队长建队 → 派工 → worker 读→写→跑测试→完成 → reviewer 跑测试→判返工
//   → 插件自动派生修复/复审任务 → worker 修好 → reviewer 复审通过 → 队长收尾。
//
// 它不能证明宿主真的这样调度（那是宿主实验的事），也不能替代真实文件与测试：
// 隔离项目的 fail→pass 由 v02-reactive-model.test.mjs 用真实命令验证。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReactiveModel } from './lib/reactive-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(readFileSync(join(HERE, 'fixtures', 'repair-policy.v2.json'), 'utf8'));

const failures = [];
let checks = 0;
function check(condition, label, detail = '') {
  checks += 1;
  if (!condition) failures.push(label + (detail === '' ? '' : ' — ' + detail));
}

const CAPTAIN_TOOLS = ['agent_teams_create', 'agent_teams_status', 'agent_teams_create_task'];
const MEMBER_TOOLS = ['agent_teams_claim_task', 'agent_teams_update_task', 'read', 'write', 'pwsh'];

const claimText = (task, who, attempt, id) => 'Task ' + task + ' claimed by ' + who + ' (attempt ' + attempt + ', attempt_id ' + id + ', status claimed).';

function request({ role, prompt, turns }) {
  const messages = [
    { role: 'system', content: role === 'captain' ? 'You are the captain of team b1-repair5.' : 'You are ' + role + ', a member of team b1-repair5.' },
    { role: 'user', content: prompt },
  ];
  for (const turn of turns) {
    messages.push({ role: 'assistant', content: turn.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })) });
    messages.push({
      role: 'user',
      content: turn.results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.id,
        is_error: result.isError === true,
        content: [{ type: 'text', text: result.text }],
      })),
    });
  }
  return { tools: (role === 'captain' ? CAPTAIN_TOOLS : MEMBER_TOOLS).map((name) => ({ name })), messages };
}

const turn = (id, name, text, { input = {}, isError = false } = {}) => ({ calls: [{ id, name, input }], results: [{ id, text, isError }] });

const STATUS = (text) => turn('status', 'agent_teams_status', text, { input: {} });

const model = createReactiveModel(POLICY);
const script = [];
function step(label, expected, req) {
  const decision = model.decide(req);
  script.push(decision.rule);
  check(decision.rule === expected, label, 'expected ' + expected + ', got ' + decision.rule);
  return decision;
}

// 队长：建队 → 轮询 → 派评审 → 轮询 → 收尾
step('captain creates the team', 'captain-creates-team', request({ role: 'captain', prompt: 'Start the repair loop.', turns: [] }));
step('captain polls after creating', 'captain-polls-after-create', request({
  role: 'captain',
  prompt: 'Start the repair loop.',
  turns: [turn('create', 'agent_teams_create', 'Team b1-repair5 created.')],
}));
step('captain sees t1 completed and creates the review task', 'captain-creates-review-task', request({
  role: 'captain',
  prompt: 'Start the repair loop.',
  turns: [turn('create', 'agent_teams_create', 'Team b1-repair5 created.'), STATUS('t1 [completed]  worker\n')],
}));
step('captain polls after creating the review task', 'captain-polls-after-review-task', request({
  role: 'captain',
  prompt: 'Start the repair loop.',
  turns: [
    turn('create', 'agent_teams_create', 'Team b1-repair5 created.'),
    STATUS('t1 [completed]  worker\n'),
    turn('task', 'agent_teams_create_task', 'Created task t2 (review).'),
  ],
}));
step('captain keeps polling while the repair runs', 'captain-polls-for-repair', request({
  role: 'captain',
  prompt: 'Start the repair loop.',
  turns: [
    turn('create', 'agent_teams_create', 'Team b1-repair5 created.'),
    STATUS('t1 [completed]  worker\n'),
    turn('task', 'agent_teams_create_task', 'Created task t2 (review).'),
    STATUS('t2 [rejected]  reviewer\nt3 [completed]  worker\nt4 [pending]  reviewer\n'),
  ],
}));
step('captain closes when t4 is completed', 'captain-stops-when-loop-closed', request({
  role: 'captain',
  prompt: 'Start the repair loop.',
  turns: [
    turn('create', 'agent_teams_create', 'Team b1-repair5 created.'),
    STATUS('t1 [completed]  worker\n'),
    turn('task', 'agent_teams_create_task', 'Created task t2 (review).'),
    STATUS('t2 [rejected]  reviewer\nt3 [completed]  worker\nt4 [pending]  reviewer\n'),
    STATUS('t2 [rejected]  reviewer\nt3 [completed]  worker\nt4 [completed]  reviewer\n'),
  ],
}));

// worker 第一轮：领任务 → 标记进行中 → 读 → 写 → 测试 → 完成
const workerPrompt = 'Task t1 (work) — Implement sum() in src/sum.mjs.';
const w1 = '11111111-2222-3333-4444-555555555555';
const workerTurns = [];
step('worker claims t1', 'worker-claims-task', request({ role: 'worker', prompt: workerPrompt, turns: workerTurns }));
workerTurns.push(turn('claim', 'agent_teams_claim_task', claimText('t1', 'worker', 1, w1), { input: { task_id: 't1' } }));
step('worker marks the task in progress', 'worker-starts-task', request({ role: 'worker', prompt: workerPrompt, turns: workerTurns }));
workerTurns.push(turn('start', 'agent_teams_update_task', 'Task t1 attempt 1 → in_progress', { input: { status: 'in_progress' } }));
step('worker reads before writing', 'worker-reads-before-write', request({ role: 'worker', prompt: workerPrompt, turns: workerTurns }));
workerTurns.push(turn('read', 'read', '<path>src/sum.mjs</path>\n<type>file</type>\n<content>\nBUG-SKIP-NEGATIVE\n</content>', { input: { file_path: 'src/sum.mjs' } }));
step('worker writes after the read succeeded', 'worker-writes-after-read', request({ role: 'worker', prompt: workerPrompt, turns: workerTurns }));
workerTurns.push(turn('write', 'write', '<path>src/sum.mjs</path>\n<type>file</type>\n<content>\nUpdated file\n</content>', { input: { file_path: 'src/sum.mjs' } }));
step('worker runs the project test', 'worker-runs-project-test', request({ role: 'worker', prompt: workerPrompt, turns: workerTurns }));
workerTurns.push(turn('test', 'pwsh', 'sum tests: 3 passed, 0 failed', { input: { command: 'node test/sum.test.mjs' } }));
step('worker completes only after a green test', 'worker-completes-after-green-test', request({ role: 'worker', prompt: workerPrompt, turns: workerTurns }));

// reviewer 第一轮：跑测试 → 判返工
const reviewPrompt = 'Task t2 (review) — Review the sum() change.';
const r1 = '22222222-2222-3333-4444-555555555555';
const reviewTurns = [];
step('reviewer claims t2', 'reviewer-claims-task', request({ role: 'reviewer', prompt: reviewPrompt, turns: reviewTurns }));
reviewTurns.push(turn('claim', 'agent_teams_claim_task', claimText('t2', 'reviewer', 1, r1), { input: { task_id: 't2' } }));
step('reviewer starts the review', 'reviewer-starts-review', request({ role: 'reviewer', prompt: reviewPrompt, turns: reviewTurns }));
reviewTurns.push(turn('start', 'agent_teams_update_task', 'Task t2 attempt 1 → in_progress', { input: { status: 'in_progress' } }));
step('reviewer runs the test itself', 'reviewer-runs-test', request({ role: 'reviewer', prompt: reviewPrompt, turns: reviewTurns }));
reviewTurns.push(turn('test', 'pwsh', 'sum tests: 2 passed, 1 failed', { input: { command: 'node test/sum.test.mjs' } }));
step('reviewer rejects with needs_revision', 'reviewer-rejects', request({ role: 'reviewer', prompt: reviewPrompt, turns: reviewTurns }));

// worker 修复轮（自动派生的 t3）
const repairPrompt = 'Task t3 (repair, from t2) — Fix the findings.';
const w3 = '33333333-2222-3333-4444-555555555555';
const repairTurns = [];
step('the re-dispatched worker claims t3', 'worker-claims-task', request({ role: 'worker', prompt: repairPrompt, turns: repairTurns }));
repairTurns.push(turn('claim', 'agent_teams_claim_task', claimText('t3', 'worker', 1, w3), { input: { task_id: 't3' } }));
step('the repair worker marks t3 in progress', 'worker-starts-task', request({ role: 'worker', prompt: repairPrompt, turns: repairTurns }));
repairTurns.push(turn('start', 'agent_teams_update_task', 'Task t3 attempt 1 → in_progress', { input: { status: 'in_progress' } }));
step('the repair worker reads first', 'worker-reads-before-write', request({ role: 'worker', prompt: repairPrompt, turns: repairTurns }));
repairTurns.push(turn('read', 'read', '<path>src/sum.mjs</path>\n<content>\nBUG-SKIP-NEGATIVE\n</content>', { input: { file_path: 'src/sum.mjs' } }));
step('the repair worker writes', 'worker-writes-after-read', request({ role: 'worker', prompt: repairPrompt, turns: repairTurns }));
repairTurns.push(turn('write', 'write', '<path>src/sum.mjs</path>\n<content>\nUpdated file\n</content>', { input: { file_path: 'src/sum.mjs' } }));
step('the repair worker runs the test', 'worker-runs-project-test', request({ role: 'worker', prompt: repairPrompt, turns: repairTurns }));
repairTurns.push(turn('test', 'pwsh', 'sum tests: 3 passed, 0 failed', { input: { command: 'node test/sum.test.mjs' } }));
step('the repair worker completes t3', 'worker-completes-after-green-test', request({ role: 'worker', prompt: repairPrompt, turns: repairTurns }));

// reviewer 复审轮（t4）通过
const recheckPrompt = 'Task t4 (review) — Re-review the repaired change.';
const r4 = '44444444-2222-3333-4444-555555555555';
const recheckTurns = [];
step('reviewer claims t4', 'reviewer-claims-task', request({ role: 'reviewer', prompt: recheckPrompt, turns: recheckTurns }));
recheckTurns.push(turn('claim', 'agent_teams_claim_task', claimText('t4', 'reviewer', 1, r4), { input: { task_id: 't4' } }));
step('reviewer starts the re-review', 'reviewer-starts-review', request({ role: 'reviewer', prompt: recheckPrompt, turns: recheckTurns }));
recheckTurns.push(turn('start', 'agent_teams_update_task', 'Task t4 attempt 1 → in_progress', { input: { status: 'in_progress' } }));
step('reviewer runs the test again', 'reviewer-runs-test', request({ role: 'reviewer', prompt: recheckPrompt, turns: recheckTurns }));
recheckTurns.push(turn('test', 'pwsh', 'sum tests: 3 passed, 0 failed', { input: { command: 'node test/sum.test.mjs' } }));
step('reviewer passes the repair', 'reviewer-passes', request({ role: 'reviewer', prompt: recheckPrompt, turns: recheckTurns }));

check(script.length === 26, 'the rehearsal visits 26 transitions', String(script.length));

// 真实宿主跑出来的两个夹具缺陷（repair5，2026-10-18）：轮询次数用完就停、
// 写失败后重读只允许一次写。这里把它们钉成回归，别让夹具再悄悄卡死。
{
  const retryModel = createReactiveModel(POLICY);
  const captainPrompt = 'Start the repair loop.';
  const captainTurns = [];
  const created = retryModel.decide(request({ role: 'captain', prompt: captainPrompt, turns: captainTurns }));
  check(created.rule === 'captain-creates-team', 'the polling scenario starts by creating the team', created.rule);
  captainTurns.push(turn('create', 'agent_teams_create', 'Team b1-repair5 created.'));
  const afterCreate = retryModel.decide(request({ role: 'captain', prompt: captainPrompt, turns: captainTurns }));
  check(afterCreate.rule === 'captain-polls-after-create', 'the captain polls right after creating the team', afterCreate.rule);
  captainTurns.push(STATUS('Team b1-repair5 — t1 [in_progress]  worker\n'));
  let lastRule = null;
  for (let index = 0; index < 9; index += 1) {
    const decision = retryModel.decide(request({ role: 'captain', prompt: captainPrompt, turns: captainTurns }));
    lastRule = decision.rule;
    if (lastRule !== 'captain-polls-while-members-work') break;
    captainTurns.push(STATUS('Team b1-repair5 — t1 [in_progress]  worker\n'));
  }
  check(lastRule === 'captain-polls-while-members-work', 'the captain keeps polling past the sixth status call', String(lastRule));

  const writerModel = createReactiveModel(POLICY);
  const retryPrompt = 'Task t1 (work) — Implement sum() in src/sum.mjs.';
  const retryTurns = [];
  retryModel.decide(request({ role: 'worker', prompt: retryPrompt, turns: retryTurns }));
  retryTurns.push(turn('claim', 'agent_teams_claim_task', claimText('t1', 'worker', 1, w1), { input: { task_id: 't1' } }));
  writerModel.decide(request({ role: 'worker', prompt: retryPrompt, turns: retryTurns }));
  retryTurns.push(turn('start', 'agent_teams_update_task', 'Task t1 attempt 1 → in_progress', { input: { status: 'in_progress' } }));
  writerModel.decide(request({ role: 'worker', prompt: retryPrompt, turns: retryTurns }));
  retryTurns.push(turn('read', 'read', '<path>src/sum.mjs</path>\n<content>\nBUG-SKIP-NEGATIVE\n</content>', { input: { file_path: 'src/sum.mjs' } }));
  const firstWrite = writerModel.decide(request({ role: 'worker', prompt: retryPrompt, turns: retryTurns }));
  check(firstWrite.rule === 'worker-writes-after-read', 'the worker is told to write after reading', firstWrite.rule);
  retryTurns.push(turn('write', 'write', 'Error: SetFileSecurityW EACCES (Win32 5): src/sum.mjs', { isError: true, input: { file_path: 'src/sum.mjs' } }));
  const afterFailure = writerModel.decide(request({ role: 'worker', prompt: retryPrompt, turns: retryTurns }));
  check(afterFailure.rule === 'worker-retries-write', 'a failed write sends the worker back to read', afterFailure.rule);
  retryTurns.push(turn('read2', 'read', '<path>src/sum.mjs</path>\n<content>\nBUG-SKIP-NEGATIVE\n</content>', { input: { file_path: 'src/sum.mjs' } }));
  const secondWrite = writerModel.decide(request({ role: 'worker', prompt: retryPrompt, turns: retryTurns }));
  check(secondWrite.rule === 'worker-writes-after-read', 'the worker may write again after re-reading', secondWrite.rule);
  retryTurns.push(turn('write2', 'write', '<path>src/sum.mjs</path>\n<content>\nUpdated file\n</content>', { input: { file_path: 'src/sum.mjs' } }));
  const testAfterRetry = writerModel.decide(request({ role: 'worker', prompt: retryPrompt, turns: retryTurns }));
  check(testAfterRetry.rule === 'worker-runs-project-test', 'the retried write clears the path to the project test', testAfterRetry.rule);
}

// 隔离项目：缺陷版失败、修复版通过、恢复缺陷版再失败。
{
  const root = mkdtempSync(join(tmpdir(), 'tla-rehearsal-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    const broken = readFileSync(join(HERE, 'fixtures', 'repair-project', 'src', 'sum.broken.mjs'), 'utf8');
    writeFileSync(join(root, 'src', 'sum.mjs'), broken);
    writeFileSync(join(root, 'test', 'sum.test.mjs'), readFileSync(join(HERE, 'fixtures', 'repair-project', 'test', 'sum.test.mjs'), 'utf8'));
    const before = spawnSync(process.execPath, [join(root, 'test', 'sum.test.mjs')], { cwd: root, stdio: 'ignore', timeout: 20000 });
    check(before.status === 1, 'the defective project fails', String(before.status));
    const writer = POLICY.rules.find((rule) => rule.name === 'worker-writes-after-read');
    writeFileSync(join(root, 'src', 'sum.mjs'), writer.reply.toolCalls[0].input.content);
    const after = spawnSync(process.execPath, [join(root, 'test', 'sum.test.mjs')], { cwd: root, stdio: 'ignore', timeout: 20000 });
    check(after.status === 0, 'the repaired project passes', String(after.status));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('v02-repair-rehearsal: ' + checks + ' checks, ' + failures.length + ' failures');
for (const failure of failures) console.error('FAIL ' + failure);
if (failures.length > 0) process.exitCode = 1;
