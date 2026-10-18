// 离线宿主模拟器：把"真实宿主的调度"建成一个可复算的世界。
//
// 它模拟的**只有**调度形状，不模拟模型：
//   - 队长和成员各自是一个会话，一个回合内可以有多次请求（每次带工具结果）；
//   - 回复纯文本 = 结束回合；
//   - **成员每次请求之后，队长都会被唤醒一次**（第五次真实运行 15 次请求的实测形状）；
//   - 成员任务完成时投递 mailbox 报告，否则投递"后台子代理结束"的结算通知。
//
// 工具是真的：write 真的写磁盘、`pwsh node test/sum.test.mjs` 真的起子进程跑测试，
// 并且写操作和宿主一样要求"同会话先读后写"，否则拒绝。这样夹具的顺序错误会在这里
// 暴露，而不是等下一次宿主运行。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { createReactiveModel } from './reactive-model.mjs';

export const HOST_SIM_SCHEMA = 'tla.host-sim/v1';
export const TEAM_NAME = 'fixture-loop';

const CAPTAIN_TOOLS = ['agent_teams_create', 'agent_teams_create_task', 'agent_teams_status', 'agent_teams_send_message'];
const MEMBER_TOOLS = ['agent_teams_claim_task', 'agent_teams_update_task', 'agent_teams_status', 'agent_teams_send_message', 'read', 'write', 'pwsh'];

export const STUB_IMPLEMENTATION = "export function sum() {\n  throw new Error('sum() is not implemented yet');\n}\n";
export const TEST_SUITE = [
  "import { sum } from '../src/sum.mjs';",
  '',
  'const cases = [',
  "  { name: 'empty', actual: sum([]), expected: 0 },",
  "  { name: 'keeps the sign of negatives', actual: sum([1, 2, -3]), expected: 0 },",
  "  { name: 'adds positives', actual: sum([1, 2]), expected: 3 },",
  '];',
  '',
  'let passed = 0;',
  'let failed = 0;',
  'for (const item of cases) {',
  '  if (Object.is(item.actual, item.expected)) {',
  '    passed += 1;',
  '    console.log(`ok ${item.name}`);',
  '  } else {',
  '    failed += 1;',
  '    console.log(`not ok ${item.name}: expected ${item.expected} but got ${String(item.actual)}`);',
  '  }',
  '}',
  'console.log(`sum tests: ${passed} passed, ${failed} failed`);',
  'process.exitCode = failed === 0 ? 0 : 1;',
  ''
].join('\n');

const MAILBOX_TEMPLATE = (member, taskId, attemptId, status, content) =>
  'AgentTeams message from member ' + member + ':\n\n[Source task ' + taskId + ', attempt_id ' + attemptId + ', status=' + status + ']\n' + content;
const SETTLEMENT_TEMPLATE = (sessionId) =>
  'Background subagent ' + sessionId + ' finished and will do no further work unless you send it more.';

function fail(sim, code, message) {
  const error = new Error(code + ': ' + message);
  error.code = code;
  sim.error = error;
  throw error;
}

function normalizePath(relative) {
  const cleaned = normalize(String(relative).split('/').join(sep)).replace(/^([.]{2}(\\|\/))+/u, '');
  return cleaned.split(sep).join('/');
}

export function createWorld({ root }) {
  const files = new Map();
  const team = { name: TEAM_NAME, members: new Map(), tasks: new Map(), nextTask: 1, nextAttempt: 1 };
  const reported = new Set();
  return { root, files, team, writes: [], tests: [], reported };
}

export function seedProject(world) {
  writeFileSync(join(world.root, 'src', 'sum.mjs'), STUB_IMPLEMENTATION, 'utf8');
  writeFileSync(join(world.root, 'test', 'sum.test.mjs'), TEST_SUITE, 'utf8');
  world.files.set('src/sum.mjs', STUB_IMPLEMENTATION);
  world.files.set('test/sum.test.mjs', TEST_SUITE);
}

export function runRehearsal({ policy, maxRequests = 80, options = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'tla-host-sim-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  const world = createWorld({ root });
  seedProject(world);

  const sim = {
    schema: HOST_SIM_SCHEMA,
    root,
    world,
    policy,
    maxRequests,
    options,
    error: null,
    requests: 0,
    trace: [],
    closed: false,
    states: {},
  };

  const engine = createReactiveModel(policy);
  const sessions = new Map();
  const queue = [];

  function sessionOf(name) {
    if (!sessions.has(name)) {
      const captain = name === 'captain';
      sessions.set(name, {
        name,
        role: captain ? 'captain' : name,
        tools: captain ? CAPTAIN_TOOLS.slice() : MEMBER_TOOLS.slice(),
        messages: [],
        observed: new Map(),
        attemptId: null,
        promptTaskId: null,
        completedThisTurn: null,
      });
    }
    return sessions.get(name);
  }

  function pushUserText(session, text) {
    session.messages.push({ role: 'user', content: text });
  }

  function bodyOf(session) {
    return { model: 'deepseek-flash', system: 'fixture turn', tools: session.tools.map((name) => ({ name })), messages: session.messages };
  }

  function enqueueWake(kind, text, extra = {}) {
    queue.push({ kind, text, ...extra });
  }

  function startMemberTurn(memberName, taskId) {
    const session = sessionOf(memberName);
    session.observed.clear();
    session.attemptId = null;
    session.promptTaskId = taskId;
    const task = world.team.tasks.get(taskId);
    pushUserText(session, 'You are ' + memberName + ', a member of team ' + TEAM_NAME + '. Task ' + taskId + ': ' + task.subject + '.');
    queue.push({ memberTurn: memberName });
  }

  // ---- 工具执行 -----------------------------------------------------------

  function toolRead(session, input) {
    const path = normalizePath(input.path);
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      return { isError: true, text: 'Error: no such file: ' + path };
    }
    const content = readFileSync(absolute, 'utf8');
    world.files.set(path, content);
    session.observed.set(path, content);
    return { isError: false, text: '<path>' + path + '</path>\n<type>file</type>\n<content>\n' + content + '\n</content>', filePath: path, fileOutcome: 'read' };
  }

  function toolWrite(session, input) {
    const path = normalizePath(input.path);
    if (!session.observed.has(path)) {
      return {
        isError: true,
        text: 'Error: cannot modify "' + path + '": file has not been read — read the file, then retry'
      };
    }
    const absolute = join(root, path);
    if (!existsSync(dirname(absolute))) mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, String(input.content ?? ''), 'utf8');
    world.files.set(path, String(input.content ?? ''));
    world.writes.push({ session: session.name, path, bytes: Buffer.byteLength(String(input.content ?? '')) });
    session.observed.set(path, String(input.content ?? ''));
    return {
      isError: false,
      text: '<path>' + path + '</path>\n<type>file</type>\n<content>\nUpdated file\n</content>',
      filePath: path,
      fileOutcome: 'updated'
    };
  }

  function toolPwsh(input) {
    const command = String(input.command ?? '').trim();
    if (command !== 'node test/sum.test.mjs') {
      return { isError: true, text: 'Error: the fixture only allows "node test/sum.test.mjs", got: ' + command };
    }
    const out = join(root, 'test-output.txt');
    const fd = openSync(out, 'w');
    const result = spawnSync(process.execPath, [join(root, 'test', 'sum.test.mjs')], { cwd: root, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    const text = readFileSync(out, 'utf8').trim();
    world.tests.push({ command, exitCode: result.status, text });
    return { isError: result.status !== 0, text };
  }

  function toolClaim(session, input) {
    const taskId = String(input.task_id ?? '');
    const task = world.team.tasks.get(taskId);
    if (task === undefined) {
      return { isError: true, text: 'Error: no task "' + taskId + '" in team "' + TEAM_NAME + '" — use agent_teams_status to list tasks' };
    }
    if (task.assignee !== session.name) {
      return { isError: true, text: 'Error: task "' + taskId + '" is assigned to "' + task.assignee + '", not to "' + session.name + '"' };
    }
    if (task.status !== 'pending') {
      return { isError: true, text: 'Error: task "' + taskId + '" is already ' + task.status };
    }
    task.status = 'in_progress';
    task.attempt = (task.attempt ?? 0) + 1;
    // 形状要和宿主一致：CLAIM_RE 只认 8 位以上的十六进制 attempt id。
    // attempt id 必须全局唯一，否则同一个 attempt 号在不同任务上会撞成同一个会话、把状态带过去。
    task.attemptId = '0000aaaa-bbbb-cccc-dddd-eeeeffff' + String(world.team.nextAttempt).padStart(4, '0');
    world.team.nextAttempt += 1;
    session.attemptId = task.attemptId;
    return {
      isError: false,
      text: 'Task ' + taskId + ' claimed by ' + session.name + ' (attempt ' + task.attempt + ', attempt_id ' + task.attemptId + ', status claimed).'
    };
  }

  function toolUpdate(session, input) {
    const taskId = String(input.task_id ?? '');
    const task = world.team.tasks.get(taskId);
    if (task === undefined) return { isError: true, text: 'Error: no task "' + taskId + '"' };
    if (task.attemptId !== null && task.attemptId !== session.attemptId) {
      return { isError: true, text: 'Error: task "' + taskId + '" is claimed by another attempt' };
    }
    const status = String(input.status ?? '');
    if (!['in_progress', 'completed', 'failed'].includes(status)) {
      return { isError: true, text: 'Error: unsupported status "' + status + '"' };
    }
    // 反例：成员把任务报成失败（工具坏了、跑不动），而不是"完成"。
    const forced = options.memberErrorOnFirstReport === true && status === 'completed' && world.forcedFailure === undefined;
    const effective = forced ? 'failed' : status;
    if (forced) world.forcedFailure = taskId;
    task.status = effective;
    task.output = String(input.output ?? '');
    if (effective === 'completed') session.completedThisTurn = taskId;
    if (effective === 'failed') session.failedThisTurn = taskId;
    return { isError: false, text: 'Task ' + taskId + ' attempt ' + String(task.attempt ?? 1) + ' → ' + effective + '\nOutput: ' + task.output };
  }

  function toolCreateTask(input) {
    const id = 't' + String(world.team.nextTask);
    world.team.nextTask += 1;
    const assignee = String(input.assignee ?? '');
    world.team.tasks.set(id, {
      id,
      subject: String(input.subject ?? ''),
      assignee,
      status: 'pending',
      attempt: 0,
      attemptId: null,
      output: ''
    });
    return { isError: false, text: 'Created task ' + id + ' (' + String(input.subject ?? '') + ') assigned to ' + assignee + '.' };
  }

  function toolCreateTeam(input) {
    const plan = input.plan ?? {};
    for (const member of plan.members ?? []) {
      world.team.members.set(member.name, { name: member.name, role: member.role ?? 'engineer' });
    }
    for (const task of plan.tasks ?? []) {
      const id = String(task.id ?? 't1');
      world.team.tasks.set(id, {
        id,
        subject: String(task.subject ?? ''),
        assignee: String(task.assignee ?? ''),
        status: 'pending',
        attempt: 0,
        attemptId: null,
        output: ''
      });
      const numeric = Number(id.slice(1));
      if (Number.isInteger(numeric) && numeric >= world.team.nextTask) world.team.nextTask = numeric + 1;
    }
    return { isError: false, text: 'Team "' + TEAM_NAME + '" created with ' + String(world.team.members.size) + ' members and ' + String(world.team.tasks.size) + ' task(s).' };
  }

  function execute(session, call) {
    const input = call.input ?? {};
    switch (call.name) {
      case 'read': return toolRead(session, input);
      case 'write': return toolWrite(session, input);
      case 'pwsh': return toolPwsh(input);
      case 'agent_teams_claim_task': return toolClaim(session, input);
      case 'agent_teams_update_task': return toolUpdate(session, input);
      case 'agent_teams_create_task': return toolCreateTask(input);
      case 'agent_teams_create': return toolCreateTeam(input);
      case 'agent_teams_status':
        return { isError: false, text: 'Team ' + TEAM_NAME + ': ' + [...world.team.tasks.values()].map((t) => t.id + ' (' + t.assignee + ') ' + t.status).join(', ') };
      case 'agent_teams_send_message': return { isError: false, text: 'Message delivered.' };
      default:
        return { isError: true, text: 'Error: the fixture does not implement ' + call.name };
    }
  }

  // ---- 回合 ---------------------------------------------------------------

  function runTurn(job) {
    const session = job.memberTurn === undefined ? sessionOf('captain') : sessionOf(job.memberTurn);
    if (job.memberTurn === undefined && job.kind === 'mailbox') {
      pushUserText(session, job.text);
    } else if (job.memberTurn === undefined && job.kind === 'settlement') {
      pushUserText(session, job.text);
    }
    session.completedThisTurn = null;
    session.failedThisTurn = null;

    for (let step = 0; step < maxRequests; step += 1) {
      if (sim.requests >= maxRequests) fail(sim, 'REQUEST_LIMIT', '超过 ' + String(maxRequests) + ' 次请求仍未结束');
      sim.requests += 1;
      const body = bodyOf(session);
      let decision;
      try {
        decision = engine.decide(body);
      } catch (error) {
        sim.states = engine.states();
        fail(sim, error.code ?? 'ENGINE_ERROR', String(error.message));
        return;
      }
      sim.trace.push({
        seq: sim.requests,
        session: session.name,
        rule: decision.rule,
        kind: decision.kind,
        state: decision.previousState,
        next: decision.state,
        wake: job.memberTurn === undefined && job.kind !== undefined ? job.kind : null
      });
      const reply = decision.reply;
      if (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) {
        const calls = reply.toolCalls.map((call, index) => ({
          id: 'call-' + String(sim.requests) + '-' + String(index),
          name: call.name,
          input: call.input ?? {}
        }));
        session.messages.push({ role: 'assistant', content: calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })) });
        const parts = [];
        for (const call of calls) {
          const outcome = execute(session, call);
          parts.push({ type: 'tool_result', tool_use_id: call.id, is_error: outcome.isError, content: [{ type: 'text', text: outcome.text }] });
        }
        session.messages.push({ role: 'user', content: parts });
        // 真实宿主在成员**每次回复**之后都会唤醒队长（第五次运行 15 次请求的形状）。
        // 这个模式下成员一次只走一步，队长每次都被叫醒一次（用 idle-wait 结束回合）。
        if (options.perReplyWakes === true && session.role !== 'captain') {
          // 一次回复就是一次回合结束：先投递结果（如果这次完成了任务），再唤醒队长。
          const finished = session.completedThisTurn ?? session.failedThisTurn;
          if (finished !== undefined && finished !== null) {
            const task = world.team.tasks.get(finished);
            world.reported.add(finished);
            enqueueWake('mailbox', MAILBOX_TEMPLATE(session.name, task.id, String(task.attemptId), task.status, task.output));
          }
          enqueueWake('settlement', SETTLEMENT_TEMPLATE('session-' + session.name));
          queue.push({ memberTurn: session.name, resume: true });
          return null;
        }
        continue;
      }
      const text = String(reply.text ?? '');
      session.messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
      return finishTurn(session, decision);
    }
    fail(sim, 'REQUEST_LIMIT', '单个回合超过 ' + String(maxRequests) + ' 次请求');
    return null;
  }

  function finishTurn(session, decision) {
    if (decision.state === 'closed' && session.role === 'captain') sim.closed = true;
    if (session.role === 'captain') return;
    const memberName = session.name;
    const completed = session.completedThisTurn;
    const failed = session.failedThisTurn;
    const task = completed === null ? (failed === null ? null : world.team.tasks.get(failed)) : world.team.tasks.get(completed);
    if (task !== null && task !== undefined && !world.reported.has(task.id)) {
      // 反例：报告迟到（先来一条结算通知），或者宿主把同一条通知重复投递。
      for (let index = 0; index < (options.settlementsBeforeMailbox ?? 0); index += 1) {
        enqueueWake('settlement', SETTLEMENT_TEMPLATE('session-' + memberName));
      }
      enqueueWake('mailbox', MAILBOX_TEMPLATE(memberName, task.id, String(task.attemptId), task.status, task.output));
      for (let index = 0; index < (options.duplicateSettlements ?? 0); index += 1) {
        enqueueWake('settlement', SETTLEMENT_TEMPLATE('session-' + memberName));
      }
      return;
    }
    if (options.quietMembers === true) return;
    enqueueWake('settlement', SETTLEMENT_TEMPLATE('session-' + memberName));
  }

  // ---- 主循环 -------------------------------------------------------------

  try {
    const captain = sessionOf('captain');
    pushUserText(captain, 'You are the captain of team ' + TEAM_NAME + '. Create the team, dispatch the tasks, and keep polling until the review task is completed.');
    queue.push({ captain: true });
    // 反例：没有任何状态变化的结算通知（宿主重复唤醒）。
    for (let index = 0; index < (options.startSettlements ?? 0); index += 1) {
      enqueueWake('settlement', SETTLEMENT_TEMPLATE('session-captain'));
    }
    while (queue.length > 0) {
      const job = queue.shift();
      if (job.memberTurn !== undefined) {
        runTurn(job);
      } else {
        runTurn(job);
      }
      // 队长派工后需要启动对应成员的回合。
      for (const task of world.team.tasks.values()) {
        if (task.status === 'pending' && task.assignee !== '' && task.attempt === 0) {
          task.attempt = 0;
          const already = queue.some((item) => item.memberTurn === task.assignee);
          if (!already) startMemberTurn(task.assignee, task.id);
        }
      }
      if (sim.closed) break;
    }
    sim.states = engine.states();
    return {
      schema: HOST_SIM_SCHEMA,
      ok: sim.closed,
      closed: sim.closed,
      requests: sim.requests,
      stats: engine.stats(),
      trace: sim.trace,
      world: {
        tasks: [...world.team.tasks.values()].map((task) => ({ id: task.id, subject: task.subject, assignee: task.assignee, status: task.status, output: task.output })),
        files: Object.fromEntries(world.files),
        writes: world.writes,
        tests: world.tests
      },
      error: null
    };
  } catch (error) {
    return {
      schema: HOST_SIM_SCHEMA,
      ok: false,
      closed: false,
      requests: sim.requests,
      stats: engine.stats(),
      trace: sim.trace,
      world: {
        tasks: [...world.team.tasks.values()].map((task) => ({ id: task.id, status: task.status })),
        files: Object.fromEntries(world.files),
        writes: world.writes,
        tests: world.tests
      },
      error: { code: error.code ?? 'ENGINE_ERROR', message: String(error.message) }
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
