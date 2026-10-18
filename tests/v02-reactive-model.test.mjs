// 反应式引擎 v2 的反例测试。
//
// 这里的每个场景都对应一次真实事故或一种"看起来成功"的假信号。测试断言的是
// **拒绝推进**，而不是"返回了某个字符串"：引擎不能靠文本里出现文件名就判断
// 写入成功，也不能从历史里抓一个旧 UUID 当作本轮的 attempt。
//
// 运行：node tests/v02-reactive-model.test.mjs

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REACTIVE_SCHEMA,
  ReactiveRuleError,
  createReactiveModel,
  parseBody,
  validatePolicy,
  roleOf,
  sessionKeyOf,
} from './lib/reactive-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = JSON.parse(readFileSync(join(HERE, 'fixtures', 'repair-policy.v2.json'), 'utf8'));

let failures = 0;
let checks = 0;
function check(condition, label, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error('FAIL ' + label + (detail === '' ? '' : ' — ' + detail));
  }
}

function expectError(fn, code, label) {
  try {
    fn();
    check(false, label, 'expected ' + code + ' but nothing was thrown');
  } catch (error) {
    check(error instanceof ReactiveRuleError && error.code === code, label, 'expected ' + code + ', got ' + (error && error.code ? error.code : String(error)));
  }
}

const CAPTAIN_TOOLS = ['agent_teams_create', 'agent_teams_status', 'agent_teams_create_task'];
const MEMBER_TOOLS = ['agent_teams_claim_task', 'agent_teams_update_task', 'read', 'write', 'pwsh'];

const CLAIM_OK = (task, who, attempt, id) =>
  'Task ' + task + ' claimed by ' + who + ' (attempt ' + attempt + ', attempt_id ' + id + ', status claimed).\n' + task + ' body';

// 请求体构造器：可以精确控制 tool_use / tool_result 的配对与 is_error。
function body({ tools = MEMBER_TOOLS, turns = [], memberName = 'worker', prompt = 'Task t1 (work) — implement sum().' } = {}) {
  const messages = [
    { role: 'system', content: 'You are ' + memberName + ', a member of team b1-repair5. Follow the workflow.' },
    { role: 'user', content: prompt },
  ];
  for (const turn of turns) {
    messages.push({ role: 'assistant', content: turn.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })) });
    if (turn.results !== undefined) {
      messages.push({
        role: 'user',
        content: turn.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.id,
          is_error: result.isError === true,
          content: result.content === undefined ? [{ type: 'text', text: result.text ?? '' }] : result.content,
        })),
      });
    }
  }
  return { model: 'deepseek-flash', stream: true, tools: tools.map((name) => ({ name })), messages };
}

function textResult(id, text, isError = false) {
  return { id, text, isError };
}

// 按真实调用顺序重放：每一步都带上完整历史，模型只前进一格。
function replay(model, turns) {
  let last = null;
  for (let index = 0; index < turns.length; index += 1) {
    last = model.decide(body({ turns: turns.slice(0, index + 1) }));
  }
  return last;
}

const CLAIM_TURN = (task, id, who = 'worker') => ({
  calls: [{ id: 'claim', name: 'agent_teams_claim_task', input: { task_id: task } }],
  results: [textResult('claim', CLAIM_OK(task, who, 1, id))],
});
const IN_PROGRESS_TURN = (task) => ({
  calls: [{ id: 'start', name: 'agent_teams_update_task', input: {} }],
  results: [textResult('start', 'Task ' + task + ' attempt 1 → in_progress')],
});
const READ_OK_TURN = (content = 'BUG-SKIP-NEGATIVE') => ({
  calls: [{ id: 'read1', name: 'read', input: { file_path: 'src/sum.mjs' } }],
  results: [textResult('read1', '<path>src/sum.mjs</path>\n<type>file</type>\n<content>\n' + content + '\n</content>')],
});
const WRITE_OK_TURN = () => ({
  calls: [{ id: 'write1', name: 'write', input: { file_path: 'src/sum.mjs' } }],
  results: [textResult('write1', '<path>src/sum.mjs</path>\n<type>file</type>\n<content>\nUpdated file\n</content>')],
});
const GREEN_TEST_TURN = () => ({
  calls: [{ id: 'test1', name: 'pwsh', input: {} }],
  results: [textResult('test1', 'sum tests: 3 passed, 0 failed')],
});

try {
  // 0. 正式 policy 必须通过校验。
  check(validatePolicy(POLICY) === POLICY, 'the shipped repair policy validates');
  check(POLICY.schema === REACTIVE_SCHEMA, 'policy schema is tla.reactive-model/v2');

  // 1. 失败文本里出现文件名 ≠ 写入成功（真实事故：repair4）。
  {
    const model = createReactiveModel(POLICY);
    const id = '11111111-2222-3333-4444-555555555555';
    const failedWrite = {
      calls: [{ id: 'write1', name: 'write', input: { file_path: 'src/sum.mjs' } }],
      results: [textResult('write1', 'Error: cannot modify "src/sum.mjs": file has not been read — read the file, then retry', true)],
    };
    const decision = replay(model, [CLAIM_TURN('t1', id), IN_PROGRESS_TURN('t1'), READ_OK_TURN(), failedWrite]);
    check(decision.rule === 'worker-retries-write', 'a failed write goes to the recovery rule, not to "completed"', decision.rule);
    check(decision.facts.fileOutcome === null, 'a failed write leaves no file outcome', String(decision.facts.fileOutcome));
    check(decision.state === 'read', 'the failed write returns to the read state', decision.state);
  }

  // 2. 文本看起来是成功、但 is_error=true：仍然不是成功。
  {
    const parsed = parseBody(body({
      turns: [{ calls: [{ id: 'c1', name: 'write', input: {} }], results: [{ id: 'c1', text: 'Created file', isError: true }] }],
    }));
    check(parsed.turnResults[0].isError === true, 'is_error is carried through parsing');
    const model = createReactiveModel(POLICY);
    expectError(() => model.decide(body({
      turns: [{ calls: [{ id: 'c1', name: 'write', input: {} }], results: [{ id: 'c1', text: 'Created file', isError: true }] }],
    })), 'NO_PROGRESS', 'a success-looking text with is_error=true cannot advance the state machine');
  }

  // 3. 历史里的旧 attempt 不能被当成当前 attempt。
  {
    const model = createReactiveModel(POLICY);
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const decision = replay(model, [CLAIM_TURN('t1', id), IN_PROGRESS_TURN('t1'), READ_OK_TURN()]);
    check(decision.rule === 'worker-writes-after-read', 'the read step advanced the machine', decision.rule);
    check(decision.facts.currentAttemptId === null, 'currentAttemptId stays null when this turn has no claim result');
    check(decision.facts.claimAttemptId === id, 'the session identity still knows the claimed attempt');

    // 只认"本轮"的规则：模板变量 currentAttemptId 没有值时必须报错，不能借用历史。
    const strict = createReactiveModel({
      schema: REACTIVE_SCHEMA,
      rules: [{
        name: 'uses-current-attempt',
        role: 'worker',
        state: 'new',
        match: { tool: 'read', isError: false },
        maxUses: 1,
        reply: { text: 'attempt {{currentAttemptId}}' },
      }],
    });
    // 手工把状态推到 read：先用同一条规则前的空状态不行，所以直接构造一个新模型并在同一轮里只放 read。
    expectError(() => strict.decide(body({ turns: [READ_OK_TURN()] })), 'TEMPLATE_UNRESOLVED', 'a rule that needs the current attempt cannot borrow a stale one from history');
  }

  // 4. 一条消息里多个 tool_result：按 tool_use_id 各归其位。
  {
    const parsed = parseBody(body({
      turns: [{
        calls: [
          { id: 'w1', name: 'write', input: { file_path: 'src/sum.mjs' } },
          { id: 'r1', name: 'read', input: { file_path: 'src/sum.mjs' } },
        ],
        results: [
          { id: 'w1', text: 'Error: cannot modify', isError: true },
          { id: 'r1', text: '<path>src/sum.mjs</path>\n<content>\nBUG-SKIP-NEGATIVE\n</content>', isError: false },
        ],
      }],
    }));
    check(parsed.turnResults.length === 2, 'both results are kept');
    check(parsed.turnResults[0].toolName === 'write' && parsed.turnResults[0].isError === true, 'the write error keeps its own identity');
    check(parsed.turnResults[1].toolName === 'read' && parsed.turnResults[1].isError === false, 'the read result keeps its own identity');
  }

  // 5. 空结果数组是错误，不是"成功"。
  {
    expectError(() => parseBody(body({
      turns: [{ calls: [{ id: 'c1', name: 'read', input: {} }], results: [{ id: 'c1', content: [] }] }],
    })), 'RESULT_EMPTY', 'an empty content array is rejected');
  }

  // 6. read 失败：只允许重试 read，不允许直接 write。
  {
    const model = createReactiveModel(POLICY);
    const id = 'bbbbbbbb-1111-2222-3333-444444444444';
    const failedRead = {
      calls: [{ id: 'read1', name: 'read', input: { file_path: 'src/sum.mjs' } }],
      results: [textResult('read1', 'Error: ENOENT', true)],
    };
    const decision = replay(model, [CLAIM_TURN('t1', id), IN_PROGRESS_TURN('t1'), failedRead]);
    check(decision.rule === 'worker-retries-read', 'a failed read retries the read', decision.rule);
    check(decision.reply.toolCalls[0].name === 'read', 'it never jumps to write');
  }

  // 7. 测试非零：进入失败分支，不标记 completed。
  {
    const model = createReactiveModel(POLICY);
    const id = 'cccccccc-1111-2222-3333-444444444444';
    const red = { calls: [{ id: 'test1', name: 'pwsh', input: {} }], results: [textResult('test1', 'sum tests: 2 passed, 1 failed')] };
    const decision = replay(model, [CLAIM_TURN('t1', id), IN_PROGRESS_TURN('t1'), READ_OK_TURN(), WRITE_OK_TURN(), red]);
    check(decision.rule === 'worker-reports-red-test', 'a red test goes to the failure branch', decision.rule);
    check(decision.reply.toolCalls[0].input.status === 'failed', 'the task is marked failed, not completed');
    check(decision.reply.toolCalls[0].input.verdict === 'needs_revision', 'the verdict carries needs_revision');
  }

  // 8. 第一次成员请求（还没有任何工具结果）才领任务；重复的同一请求不会重发；
  //    提示里没有任务号时模板必须报错，不能猜。
  {
    const model = createReactiveModel(POLICY);
    const first = model.decide(body({ turns: [] }));
    check(first.rule === 'worker-claims-task', 'the first member request claims a task', first.rule);
    check(first.reply.toolCalls[0].input.task_id === 't1', 'the claim target comes from the dispatch prompt', JSON.stringify(first.reply.toolCalls[0].input));
    expectError(() => model.decide(body({ turns: [] })), 'NO_PROGRESS', 'the same request is not answered twice by a single-use rule');
    const noTask = createReactiveModel(POLICY);
    expectError(() => noTask.decide(body({ turns: [], prompt: 'Please help the team.' })), 'TEMPLATE_UNRESOLVED', 'a prompt without a task id cannot produce a claim call');
  }

  // 9. 两个成员会话（不同 attempt）不共享状态与计数。
  {
    const model = createReactiveModel(POLICY);
    const workerA = body({ turns: [CLAIM_TURN('t1', 'dddddddd-1111-2222-3333-444444444444')] });
    const workerB = body({ turns: [CLAIM_TURN('t3', 'eeeeeeee-1111-2222-3333-444444444444')] });
    const a = model.decide(workerA);
    const b = model.decide(workerB);
    check(a.sessionKey === 'member:worker:dddddddd-1111-2222-3333-444444444444', 'worker A has its own session key', a.sessionKey);
    check(b.sessionKey === 'member:worker:eeeeeeee-1111-2222-3333-444444444444', 'worker B has its own session key', b.sessionKey);
    check(a.rule === 'worker-starts-task' && b.rule === 'worker-starts-task', 'each session used its own single-use rule');
    check(Object.keys(model.counts()).length === 2, 'counts are per session, not global', JSON.stringify(model.counts()));
  }

  // 10. 未知内容块形态：明确报错。
  {
    expectError(() => parseBody(body({
      turns: [{ calls: [{ id: 'c1', name: 'read', input: {} }], results: [{ id: 'c1', content: [{ type: 'mystery', value: 1 }] }] }],
    })), 'RESULT_SHAPE_UNKNOWN', 'an unknown result block type is rejected');
  }

  // 11. tool_result 指向不存在的 tool_use：不静默当成成功。
  {
    const model = createReactiveModel(POLICY);
    const request = body({ turns: [{ calls: [{ id: 'c1', name: 'read', input: {} }], results: [{ id: 'ghost', text: '<path>src/sum.mjs</path>' }] }] });
    const parsed = parseBody(request);
    check(parsed.turnResults[0].toolName === null, 'an orphan result has no tool name');
    expectError(() => model.decide(request), 'NO_PROGRESS', 'an orphan result cannot satisfy a tool rule');
  }

  // 12. policy 校验：maxUses 必须显式、匹配键受支持、名字唯一。
  {
    expectError(() => validatePolicy({ schema: REACTIVE_SCHEMA, rules: [{ name: 'x', role: 'captain', state: 'new', match: { noToolResult: true }, reply: { text: 'x' } }] }), 'POLICY_INVALID', 'maxUses is mandatory');
    expectError(() => validatePolicy({ schema: REACTIVE_SCHEMA, rules: [{ name: 'x', role: 'captain', state: 'new', match: { lastToolContains: 'x' }, maxUses: 1, reply: { text: 'x' } }] }), 'POLICY_INVALID', 'unknown match keys are rejected');
    expectError(() => validatePolicy({ schema: REACTIVE_SCHEMA, rules: [
      { name: 'x', role: 'captain', state: 'new', match: { noToolResult: true }, maxUses: 1, reply: { text: 'x' } },
      { name: 'x', role: 'captain', state: 'new', match: { noToolResult: true }, maxUses: 1, reply: { text: 'x' } },
    ] }), 'POLICY_INVALID', 'duplicate rule names are rejected');
  }

  // 13. 状态机整链：claim→in_progress→read→write→test→completed，且每条规则只走一次。
  {
    const model = createReactiveModel(POLICY);
    const id = 'ffffffff-1111-2222-3333-444444444444';
    const turns = [CLAIM_TURN('t1', id), IN_PROGRESS_TURN('t1'), READ_OK_TURN(), WRITE_OK_TURN(), GREEN_TEST_TURN()];
    const seen = [];
    for (let index = 0; index < turns.length; index += 1) {
      seen.push(model.decide(body({ turns: turns.slice(0, index + 1) })).rule);
    }
    check(
      seen.join(',') === 'worker-starts-task,worker-reads-before-write,worker-writes-after-read,worker-runs-project-test,worker-completes-after-green-test',
      'the whole worker chain advances exactly once per step',
      seen.join(','),
    );
    expectError(() => model.decide(body({ turns })), 'NO_PROGRESS', 'an exhausted single-use transition does not repeat');
    const lastBody = body({ turns });
    const parsedLast = parseBody(lastBody);
    check(roleOf(parsedLast, { memberRole: 'worker' }) === 'worker', 'role comes from the claim result, not from tool counts');
    check(sessionKeyOf(parsedLast, { memberRole: 'worker', attemptId: id }) === 'member:worker:' + id, 'session key binds role and attempt');
  }

  // 14. 隔离小项目：缺陷版失败，修复版通过（同一命令、同一目录）。
  {
    const root = mkdtempSync(join(tmpdir(), 'tla-reactive-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'test'), { recursive: true });
      const broken = readFileSync(join(HERE, 'fixtures', 'repair-project', 'src', 'sum.broken.mjs'), 'utf8');
      writeFileSync(join(root, 'src', 'sum.mjs'), broken);
      writeFileSync(join(root, 'test', 'sum.test.mjs'), readFileSync(join(HERE, 'fixtures', 'repair-project', 'test', 'sum.test.mjs'), 'utf8'));
      const before = spawnSync(process.execPath, [join(root, 'test', 'sum.test.mjs')], { cwd: root, stdio: 'ignore', timeout: 20000 });
      check(before.status === 1, 'the defective project fails its own test', String(before.status));
      const writer = POLICY.rules.find((rule) => rule.name === 'worker-writes-after-read');
      writeFileSync(join(root, 'src', 'sum.mjs'), writer.reply.toolCalls[0].input.content);
      const after = spawnSync(process.execPath, [join(root, 'test', 'sum.test.mjs')], { cwd: root, stdio: 'ignore', timeout: 20000 });
      check(after.status === 0, 'the repaired project passes the same test command', String(after.status));
      writeFileSync(join(root, 'src', 'sum.mjs'), broken);
      const again = spawnSync(process.execPath, [join(root, 'test', 'sum.test.mjs')], { cwd: root, stdio: 'ignore', timeout: 20000 });
      check(again.status === 1, 'the failure is reproducible, not a one-off', String(again.status));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  console.log('v02-reactive-model: ' + checks + ' checks, ' + failures + ' failures');
  if (failures > 0) process.exitCode = 1;
}
