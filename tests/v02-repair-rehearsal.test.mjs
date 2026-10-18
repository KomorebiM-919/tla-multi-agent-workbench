// 返工序列的合成预演 + 隔离项目上的真实 fail→pass 验证。
//
// 这个测试不启动宿主，也不冒充宿主验证：它证明的是
//   1) 反应式引擎能从真实工具结果里提取 attempt_id / taskId，按规则消耗；
//   2) 规则耗尽或无匹配时抛错（fail-closed），不会默认返回成功；
//   3) 隔离项目里的测试命令确实从失败变成成功（真实文件、真实命令）。

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReactiveModel, contextOf, factsOf, validatePolicy, ReactiveRuleError } from './lib/reactive-model.mjs';

const failures = [];
function check(condition, label, detail) {
  if (!condition) failures.push({ label, detail });
}

const policy = {
  schema: 'tla.reactive-model/v1',
  rules: [
    { name: 'captain-creates-team', match: { noToolResult: true, toolCountAtLeast: 30 }, reply: { toolCalls: [{ name: 'agent_teams_create', input: { name: 'rehearsal' } }] } },
    { name: 'captain-assigns', match: { lastToolContains: 'team created', toolCountAtLeast: 30 }, reply: { toolCalls: [{ name: 'agent_teams_status', input: {} }] } },
    { name: 'worker-claims', match: { lastToolContains: 'Task: t1', toolCountAtMost: 30 }, maxUses: 1, reply: { toolCalls: [{ name: 'agent_teams_claim_task', input: { task_id: 't1' } }] } },
    { name: 'worker-writes', match: { lastToolContains: 'claimed task t1' }, maxUses: 1, reply: { toolCalls: [{ name: 'write', input: { file_path: 'project/src/sum.mjs' } }] } },
    { name: 'worker-tests', match: { lastToolContains: 'wrote project/src/sum.mjs' }, maxUses: 1, reply: { toolCalls: [{ name: 'pwsh', input: { command: 'node --test project/test/sum.test.mjs' } }] } },
    { name: 'worker-completes', match: { lastToolContains: 'tests passed' }, maxUses: 1, reply: { toolCalls: [{ name: 'agent_teams_update_task', input: { task_id: 't1', status: 'completed' } }] } },
    { name: 'reviewer-rejects', match: { lastToolContains: 'needs_revision' }, reply: { toolCalls: [{ name: 'agent_teams_update_task', input: { task_id: 't2', status: 'failed' } }] } },
    { name: 'reviewer-approves', match: { lastToolContains: 'all tests pass' }, terminal: true, reply: { text: 'approved' } },
  ],
};

const body = (toolText, toolCount, extra = {}) => ({
  tools: Array.from({ length: toolCount }, (_, i) => ({ name: 'tool' + i })),
  messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'working' },
    { role: 'user', content: [{ type: 'tool_result', content: toolText }] },
  ],
  ...extra,
});

// --- 1. 合成预演：真实工具结果的字面内容驱动规则 ---------------------------
const model = createReactiveModel(policy);
const steps = [
  ['captain-creates-team', body('', 38)],
  ['captain-assigns', body('team created: rehearsal', 38)],
  ['worker-claims', body('Task: t1 — implement sum()', 26)],
  ['worker-writes', body('claimed task t1', 26)],
  ['worker-tests', body('wrote project/src/sum.mjs', 26)],
  ['worker-completes', body('tests passed: 3/3', 26)],
];
for (const [expected, payload] of steps) {
  const decision = model.decide(payload);
  check(decision.rule === expected, 'rehearsal step ' + expected, JSON.stringify(decision.rule));
}

const uuid = '3f0f5c62-3f2a-4b1e-9d5a-2d1f9b1c6e77';
const facts = factsOf(contextOf(body('attempt ' + uuid + ' finished for t2', 26)));
check(facts.attemptId === uuid, 'attempt_id is taken from the tool result', JSON.stringify(facts));
check(facts.taskId === 't2', 'task id is normalised to lower case', JSON.stringify(facts));

const spent = createReactiveModel({ ...policy, rules: policy.rules.map((rule) => (rule.name === 'captain-assigns' ? { ...rule, maxUses: 1 } : rule)) });
spent.decide(body('team created: rehearsal', 38));
let exhausted = null;
try {
  spent.decide(body('team created: rehearsal', 38));
} catch (error) {
  exhausted = error;
}
check(exhausted instanceof ReactiveRuleError && exhausted.code === 'NO_PROGRESS', 'maxUses exhaustion fails closed', String(exhausted));

let unknownMatcher = null;
try {
  validatePolicy({ rules: [{ name: 'x', match: { whatever: 1 }, terminal: true, reply: { text: 'x' } }] });
} catch (error) {
  unknownMatcher = error;
}
check(unknownMatcher?.code === 'POLICY_INVALID', 'unknown matcher is rejected at validation time', String(unknownMatcher));

// --- 2. 隔离项目：真实文件、真实测试命令，从失败到成功 -----------------------
const root = mkdtempSync(join(tmpdir(), 'tla-rehearsal-'));
mkdirSync(join(root, 'project', 'src'), { recursive: true });
mkdirSync(join(root, 'project', 'test'), { recursive: true });
writeFileSync(join(root, 'project', 'src', 'sum.mjs'), 'export function sum(values) {\n  if (values.length === 0) throw new Error("empty");\n  return values.reduce((a, b) => a + b, 0);\n}\n', 'utf8');
writeFileSync(
  join(root, 'project', 'test', 'sum.test.mjs'),
  'import assert from "node:assert/strict";\nimport { sum } from "../src/sum.mjs";\n\nassert.equal(sum([]), 0);\nassert.equal(sum([1, -2, 3]), 2);\nassert.equal(sum([0]), 0);\nconsole.log("tests passed: 3/3");\n',
  'utf8',
);

// 用单进程脚本而不是 node --test：测试运行器会 spawn 子进程，沙箱里必然 EPERM，
// 那会让"修好了但跑不起来"和"没修好"看起来一模一样。
function runProjectTest() {
  try {
    execFileSync(process.execPath, ['project/test/sum.test.mjs'], { cwd: root, stdio: 'ignore' });
    return 0;
  } catch (error) {
    return typeof error.status === 'number' ? error.status : 1;
  }
}

const before = runProjectTest();
check(before !== 0, 'the defective project fails its own tests before the repair', String(before));

// 这一步就是 worker 要做的事：用 write 替换文件内容，再跑同一条命令。
writeFileSync(join(root, 'project', 'src', 'sum.mjs'), 'export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n', 'utf8');
const after = runProjectTest();
check(after === 0, 'the same command passes after the file is fixed', String(after));

const source = readFileSync(join(root, 'project', 'src', 'sum.mjs'), 'utf8');
check(!source.includes('throw new Error("empty")'), 'the repair actually removed the defect', source.slice(0, 40));

if (failures.length > 0) {
  console.error('v02-repair-rehearsal: ' + failures.length + ' failure(s)');
  for (const failure of failures) console.error('  - ' + failure.label + (failure.detail === undefined ? '' : ' :: ' + failure.detail));
  process.exit(1);
}
console.log('v02-repair-rehearsal: rehearsal sequence and isolated fail-to-pass ok');
