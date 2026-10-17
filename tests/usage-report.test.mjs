// tests/usage-report.test.mjs
//
// 离线用量提取器（tests/extract-usage-report.mjs）的合成日志测试。
//
// 为什么用合成日志：真实日志不可构造"缺字段 / 明确 0 / 重复事件 / 累计口径 / 坏行"这些边界，
// 而这些边界正是"不能把不确定说成确定"的关键。合成日志是纯 JSONL（提取器同时支持 zstd 多帧与纯文本），
// 不联网、不调用模型、不读凭据。
//
// 覆盖（对应 m10329 第三节）：
// 1. 正常：父会话默认排除，子会话按归因汇总；
// 2. 缺字段：某条消息没有 usage → 覆盖不完整，不得判在预算内；
// 3. 明确的 0：cacheWriteTokens=0 与"字段缺失"必须区分；
// 4. 重复事件：重复 seq / 连续相同 totalTokens 要报出来，不能静默去重；
// 5. 累计口径：last == sum 时判 cumulative-likely，不做"相加即总量"的推断；
// 6. 不同 provider 语义：两个会话的字段状态分别统计，不合并成"provider 支持"的结论；
// 7. 缺子会话：归因集合里有、日志里没有 → 列出 missingSessionIds 并判不完整；
// 8. 再派生：父会话是本运行的子会话 → 单独列出并计入 runTotalTokens，但不并入已归因合计；
// 9. 坏日志：坏行、缺 session 头都要判不完整，且工具不能崩；
// 10. 预算：未声明 → NO_BUDGET_DECLARED；声明 2 次却观察到 3 个 → OVER_BUDGET；
// 11. 确定性：同一输入两次运行 usage-report.json 字节相同，extraction-metadata.json 各自带时间。
// 12. 尝试轮次：记录里没有 attempt 字段时按阶段名后缀 -revision-N（或标签 (revision N)）派生，
//     并按"轮次 + 阶段 + 代理 + 模型"分组汇总——否则多轮返工的花费会混在一起看不清。
//
// 运行：node tests/usage-report.test.mjs

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const TOOL = path.join(REPO_ROOT, 'tests', 'extract-usage-report.mjs');
const WORK = path.join(tmpdir(), 'tla-usage-report-test-' + process.pid);

const BASE_MS = Date.parse('2026-10-17T13:00:00.000Z');
const PARENT_ID = 'session-11111111-1111-4111-8111-111111111111';
const CALL_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CALL_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CALL_C = 'cccccccc-0000-4000-8000-000000000003';
const DERIVED = 'dddddddd-0000-4000-8000-000000000004';
const MISSING = 'eeeeeeee-0000-4000-8000-000000000005';

let checksPassed = 0;
const failures = [];
const scenarios = [];

function check(condition, label, detail) {
  if (condition) { checksPassed += 1; } else { failures.push(label + ' :: ' + (detail === undefined ? '断言失败' : String(detail))); }
  return condition;
}

function freshDir(name) {
  const dir = path.join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 生成一个会话日志（纯 JSONL）：一条 session 头 + 若干 assistant/message。 */
function sessionLog(header, messages) {
  const lines = [JSON.stringify({
    type: 'session', version: 4, id: header.id, createdAt: header.createdAt,
    cwd: 'C:/repo', parentSession: header.parentSession === undefined ? null : header.parentSession,
    isSeeded: false, origin: header.origin === undefined ? 'subagent' : header.origin,
    delegationDepth: header.delegationDepth === undefined ? 1 : header.delegationDepth,
    agentPreset: 'default'
  })];
  messages.forEach(function (message, index) {
    const record = {
      type: 'assistant/message',
      seq: message.seq === undefined ? index + 1 : message.seq,
      time: header.createdAt + 1000 * (index + 1),
      data: {
        turn: message.turn === undefined ? 1 : message.turn,
        step: message.step === undefined ? index + 1 : message.step,
        message: {
          role: 'assistant',
          content: message.content === undefined ? [{ type: 'text', text: 'ok' }] : message.content,
          source: { kind: 'model', provider: message.provider || 'deepseek-account', model: message.model || 'deepseek-flash' }
        }
      }
    };
    if (message.usage !== undefined) { record.data.usage = message.usage; }
    lines.push(JSON.stringify(record));
  });
  return lines.join('\n') + '\n';
}

/** 写一个会话目录：<root>/<group>/<session>/session.v4.jsonl（纯文本，提取器按 JSONL 读）。 */
function writeSession(root, group, id, content) {
  const dir = path.join(root, group, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'session.v4.jsonl'), content, 'utf8');
  return dir;
}

function usageOf(input, output, cacheRead, cacheWrite) {
  return {
    inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite
  };
}

function sessionMapFile(dir, sessions, extra) {
  const file = path.join(dir, 'session-map.json');
  const payload = Object.assign({
    parentSessionId: PARENT_ID,
    startedAt: new Date(BASE_MS).toISOString(),
    endedAt: new Date(BASE_MS + 600000).toISOString(),
    sessions: sessions
  }, extra || {});
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/** 跑一次提取器；stdout/stderr 写文件句柄（不经过管道，避免沙箱下的 EPERM）。 */
function runExtractor(args, dir) {
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [TOOL].concat(args), { cwd: REPO_ROOT, stdio: ['ignore', outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const read = function (file) { return existsSync(file) ? readFileSync(file, 'utf8') : ''; };
  return { status: result.status, signal: result.signal, stdout: read(outFile), stderr: read(errFile), error: result.error };
}

function readReport(dir) {
  const file = path.join(dir, 'usage-report.json');
  if (!existsSync(file)) { return null; }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function reportOf(report, sessionId) {
  if (!report) { return null; }
  const bare = String(sessionId).replace(/^session-/, '');
  return report.sessions.find(function (session) { return String(session.sessionId).replace(/^session-/, '') === bare; }) || null;
}

function scenario(title, body) {
  const before = failures.length;
  const entry = { title: title, notes: [] };
  scenarios.push(entry);
  try {
    body(entry);
  } catch (error) {
    failures.push(title + ' :: 抛出异常 ' + (error && error.stack ? error.stack : String(error)));
  }
  entry.status = failures.length === before ? 'PASS' : 'FAIL';
}

// ------------------------------------------------------------------ 场景 1 正常

scenario('正常：父会话默认排除，子会话按归因汇总', function (entry) {
  const dir = freshDir('normal');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', PARENT_ID, sessionLog({ id: PARENT_ID, createdAt: BASE_MS - 5000, parentSession: null, origin: 'cli', delegationDepth: 0 }, [
    { usage: usageOf(1000, 100, 5000, 0) }
  ]));
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: usageOf(10, 5, 100, 0) }, { usage: usageOf(20, 6, 200, 0) }
  ]));
  writeSession(root, 'g1', CALL_B, sessionLog({ id: CALL_B, createdAt: BASE_MS + 2000, parentSession: PARENT_ID }, [
    { usage: usageOf(30, 7, 300, 0) }
  ]));
  const map = sessionMapFile(dir, [
    { sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 },
    { sessionId: CALL_B, seq: 2, label: 'Verifier', phase: 'verify', attempt: 1 }
  ]);
  const run = runExtractor(['--run-id', 'synthetic-normal', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '正常场景退出码 0', 'exit=' + run.status + ' stderr=' + run.stderr);
  const report = readReport(dir);
  check(report !== null, '正常场景产出 usage-report.json');
  if (!report) { return; }
  check(report.sessions.length === 2, '父会话被默认排除（只统计 2 个子会话）', '实际 ' + report.sessions.length);
  check(report.coverage.status === 'complete', '覆盖完整', JSON.stringify(report.coverage.problems));
  check(report.scope.includeParent === false, 'includeParent 记录为 false', String(report.scope.includeParent));
  check(report.totals.totalTokens === 115 + 226 + 337, 'totalTokens 合计正确', String(report.totals.totalTokens));
  check(report.totals.messages === 3, '消息数 3', String(report.totals.messages));
  check(report.fieldSemantics.totalIdentity.mismatched === 0, 'totalTokens 恒等式全部成立', String(report.fieldSemantics.totalIdentity.mismatched));
  const a = reportOf(report, CALL_A);
  check(a !== null && a.label === 'Coding' && a.phase === 'coding', '归因 label/phase 来自调用记录', JSON.stringify(a && { label: a.label, phase: a.phase }));
  check(a !== null && a.provider === 'deepseek-account' && a.model === 'deepseek-flash', 'provider/model 取自消息 source', JSON.stringify(a && { provider: a.provider, model: a.model }));
  check(report.cost.status === 'NOT_PROVIDED' && report.cost.currency === null, '不输出货币成本（未提供价格）', JSON.stringify(report.cost));
  check(report.scope.attributedBy === 'session-map', '归因来源记录为 session-map', String(report.scope.attributedBy));
});

// ------------------------------------------------------------------ 场景 2 缺 usage

scenario('缺 usage：一条消息没有 usage → 覆盖不完整，不判在预算内', function (entry) {
  const dir = freshDir('missing-usage');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: usageOf(10, 5, 100, 0) }, { usage: undefined }
  ]));
  const map = sessionMapFile(dir, [{ sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 }]);
  const budget = path.join(dir, 'budget.json');
  writeFileSync(budget, JSON.stringify({ maxAgentCalls: 8 }), 'utf8');
  const run = runExtractor(['--run-id', 'synthetic-missing-usage', '--session-map', map, '--session-root', root, '--out-dir', dir, '--declared-budget', budget], dir);
  check(run.status === 0, '缺 usage 场景仍退出 0（报告已生成）', 'exit=' + run.status);
  const report = readReport(dir);
  if (!report) { check(false, '缺 usage 场景产出报告'); return; }
  check(report.coverage.status === 'incomplete', '覆盖判为 incomplete', String(report.coverage.status));
  check(report.totals.messagesMissingUsage === 1, '缺 usage 的消息被计数', String(report.totals.messagesMissingUsage));
  check(report.budget.verdict === 'INCOMPLETE', '预算判为 INCOMPLETE（不得说"在预算内"）', String(report.budget.verdict));
  check(report.coverage.sessionsWithoutCompleteUsage.indexOf(CALL_A) !== -1, '缺 usage 的会话被点名', JSON.stringify(report.coverage.sessionsWithoutCompleteUsage));
});

// ------------------------------------------------------------------ 场景 3 明确的 0 vs 缺字段

scenario('明确的 0：cacheWriteTokens=0 与字段缺失分开统计', function (entry) {
  const dir = freshDir('zero-vs-absent');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 115 } }
  ]));
  writeSession(root, 'g1', CALL_B, sessionLog({ id: CALL_B, createdAt: BASE_MS + 2000, parentSession: PARENT_ID }, [
    { usage: { inputTokens: 20, outputTokens: 6, cacheReadTokens: 200, totalTokens: 226 } }
  ]));
  const map = sessionMapFile(dir, [
    { sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 },
    { sessionId: CALL_B, seq: 2, label: 'Verifier', phase: 'verify', attempt: 1 }
  ]);
  const run = runExtractor(['--run-id', 'synthetic-zero', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '0/缺失场景退出码 0', 'exit=' + run.status + ' ' + run.stderr);
  const report = readReport(dir);
  if (!report) { check(false, '0/缺失场景产出报告'); return; }
  const states = report.fieldSemantics.perFieldStates.cacheWriteTokens;
  check(states.zero === 1, '显式 0 记为 zero 一次', JSON.stringify(states));
  check(states.absent === 1, '缺字段记为 absent 一次（不是 0）', JSON.stringify(states));
  check(report.fieldSemantics.cacheWriteZero.interpretation.indexOf('不能推断') !== -1, 'cacheWrite 为 0 的解读必须给出"不能推断"的边界', report.fieldSemantics.cacheWriteZero.interpretation);
  check(report.fieldSemantics.cacheWriteZero.sessionsReportingZeroOnly === false, '混合场景不报"只上报 0"', String(report.fieldSemantics.cacheWriteZero.sessionsReportingZeroOnly));
});

// ------------------------------------------------------------------ 场景 4 重复事件

scenario('重复事件：重复 seq 与连续相同 totalTokens 要报出来', function (entry) {
  const dir = freshDir('duplicates');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { seq: 1, usage: usageOf(10, 5, 100, 0) },
    { seq: 1, usage: usageOf(10, 5, 100, 0) },
    { seq: 2, usage: usageOf(10, 5, 100, 0) }
  ]));
  const map = sessionMapFile(dir, [{ sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 }]);
  const run = runExtractor(['--run-id', 'synthetic-duplicates', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '重复事件场景退出码 0', 'exit=' + run.status);
  const report = readReport(dir);
  if (!report) { check(false, '重复事件场景产出报告'); return; }
  const session = reportOf(report, CALL_A);
  check(session.duplicates.duplicateSeq.indexOf(1) !== -1, '重复 seq 被报出', JSON.stringify(session.duplicates.duplicateSeq));
  check(session.duplicates.identicalConsecutiveTotals >= 1, '连续相同 totalTokens 被报出', String(session.duplicates.identicalConsecutiveTotals));
  check(report.fieldSemantics.perFieldStates.totalTokens.value === 3, '重复事件不被静默去重（仍计 3 条）', JSON.stringify(report.fieldSemantics.perFieldStates.totalTokens));
  check(report.fieldSemantics.usagePath.indexOf('assistant/message') !== -1, '字段语义记录 usage 路径', report.fieldSemantics.usagePath);
});

// ------------------------------------------------------------------ 场景 5 累计口径

scenario('累计口径：last == sum 时判 cumulative-likely 并给出说明', function (entry) {
  const dir = freshDir('cumulative');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } },
    { usage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 50 } }
  ]));
  const map = sessionMapFile(dir, [{ sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 }]);
  const run = runExtractor(['--run-id', 'synthetic-cumulative', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '累计口径场景退出码 0', 'exit=' + run.status);
  const report = readReport(dir);
  if (!report) { check(false, '累计口径场景产出报告'); return; }
  const session = reportOf(report, CALL_A);
  check(session.usageSemantics.heuristic === 'cumulative-likely', '判为 cumulative-likely', session.usageSemantics.heuristic);
  check(report.totals.componentsMatchTotalTokens === true, '恒等式仍成立', String(report.totals.componentsMatchTotalTokens));
  check(report.fieldSemantics.perRequestOrCumulative.indexOf('unknown') !== -1,
    '总体口径字段保持 "unknown-until-heuristic-says-otherwise"，不擅自断言', report.fieldSemantics.perRequestOrCumulative);
});

// ------------------------------------------------------------------ 场景 6 不同 provider 语义

scenario('不同 provider：字段状态按会话分别统计，不合并成结论', function (entry) {
  const dir = freshDir('provider-semantics');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { provider: 'deepseek-account', model: 'deepseek-flash', usage: usageOf(10, 5, 100, 0) }
  ]));
  writeSession(root, 'g1', CALL_B, sessionLog({ id: CALL_B, createdAt: BASE_MS + 2000, parentSession: PARENT_ID }, [
    { provider: 'llm-pi-ai/openai', model: 'gpt-x', usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } }
  ]));
  const map = sessionMapFile(dir, [
    { sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 },
    { sessionId: CALL_B, seq: 2, label: 'Verifier', phase: 'verify', attempt: 1 }
  ]);
  const run = runExtractor(['--run-id', 'synthetic-providers', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '多 provider 场景退出码 0', 'exit=' + run.status);
  const report = readReport(dir);
  if (!report) { check(false, '多 provider 场景产出报告'); return; }
  check(report.sessions.length === 2, '两个会话都统计', String(report.sessions.length));
  const a = reportOf(report, CALL_A);
  const b = reportOf(report, CALL_B);
  check(a.provider === 'deepseek-account' && b.provider === 'llm-pi-ai/openai', '各自 provider 分开记录', JSON.stringify({ a: a.provider, b: b.provider }));
  check(b.fieldStates.cacheWriteTokens.absent === 1, '缺 cacheWriteTokens 的 provider 记为 absent', JSON.stringify(b.fieldStates.cacheWriteTokens));
  check(a.fieldStates.cacheWriteTokens.zero === 1, '显式 0 的 provider 记为 zero', JSON.stringify(a.fieldStates.cacheWriteTokens));
  check(report.fieldSemantics.inputCacheReadIndependence === 'unknown', '不假设 input 与 cacheRead 互不重叠', report.fieldSemantics.inputCacheReadIndependence);
});

// ------------------------------------------------------------------ 场景 7 缺子会话

scenario('缺子会话：归因集合里有、日志里没有 → 点名并判不完整', function (entry) {
  const dir = freshDir('missing-session');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: usageOf(10, 5, 100, 0) }
  ]));
  const map = sessionMapFile(dir, [
    { sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 },
    { sessionId: MISSING, seq: 2, label: 'Verifier', phase: 'verify', attempt: 1 }
  ]);
  const run = runExtractor(['--run-id', 'synthetic-missing-session', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '缺子会话场景退出码 0', 'exit=' + run.status);
  const report = readReport(dir);
  if (!report) { check(false, '缺子会话场景产出报告'); return; }
  check(report.coverage.status === 'incomplete', '覆盖判为 incomplete', String(report.coverage.status));
  check(report.coverage.missingSessionIds.indexOf(MISSING) !== -1, '缺失的 sessionId 被点名', JSON.stringify(report.coverage.missingSessionIds));
  check(report.coverage.problems.join(' ').indexOf('缺少日志') !== -1, '问题说明指出缺少日志', JSON.stringify(report.coverage.problems));
});

// ------------------------------------------------------------------ 场景 8 再派生

scenario('再派生：单独列出并计入运行总用量，但不并入已归因合计', function (entry) {
  const dir = freshDir('derived');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: usageOf(10, 5, 100, 0) }
  ]));
  writeSession(root, 'g1', DERIVED, sessionLog({ id: DERIVED, createdAt: BASE_MS + 3000, parentSession: CALL_A, delegationDepth: 2 }, [
    { usage: usageOf(700, 70, 7000, 0) }
  ]));
  const map = sessionMapFile(dir, [{ sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 }]);
  const run = runExtractor(['--run-id', 'synthetic-derived', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '再派生场景退出码 0', 'exit=' + run.status);
  const report = readReport(dir);
  if (!report) { check(false, '再派生场景产出报告'); return; }
  check(report.coverage.derivedSessions.length === 1, '再派生会话被单独列出', String(report.coverage.derivedSessions.length));
  check(report.sessions.length === 1, '已归因合计不含再派生会话', String(report.sessions.length));
  check(report.totals.totalTokens === 115, '已归因合计只含 1 次调用', String(report.totals.totalTokens));
  check(report.totals.runTotalTokens === 115 + 7770, '运行总用量含再派生会话', String(report.totals.runTotalTokens));
  check(report.coverage.status === 'incomplete', '有再派生即判不完整（无法归因到某次调用）', String(report.coverage.status));
  check(report.coverage.problems.join(' ').indexOf('再派生') !== -1, '问题说明点出再派生', JSON.stringify(report.coverage.problems));
});

// ------------------------------------------------------------------ 场景 9 坏日志

scenario('坏日志：坏行与缺 session 头都判不完整，工具不崩', function (entry) {
  const dir = freshDir('bad-logs');
  const root = path.join(dir, 'sessions');
  const goodLog = sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [{ usage: usageOf(10, 5, 100, 0) }]);
  writeSession(root, 'g1', CALL_A, goodLog + '{"type":"assistant/message", 这不是 JSON\n');
  writeSession(root, 'g1', CALL_B, JSON.stringify({ type: 'request/header', time: BASE_MS + 500 }) + '\n');
  const map = sessionMapFile(dir, [{ sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 }]);
  const run = runExtractor(['--run-id', 'synthetic-bad-logs', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '坏日志场景退出码 0（不崩）', 'exit=' + run.status + ' stderr=' + run.stderr);
  const report = readReport(dir);
  if (!report) { check(false, '坏日志场景产出报告'); return; }
  check(report.coverage.status === 'incomplete', '覆盖判为 incomplete', String(report.coverage.status));
  const reasonText = report.coverage.badLogs.map(function (item) { return item.reason; }).join(' | ');
  check(reasonText.indexOf('session 头') !== -1, '缺 session 头的日志被点名', reasonText);
  const session = reportOf(report, CALL_A);
  check(session !== null && session.log.badLines >= 1, '坏行被计数而不是静默跳过', String(session && session.log.badLines));
});

// ------------------------------------------------------------------ 场景 10 预算

scenario('预算：未声明 → NO_BUDGET_DECLARED；声明 2 次实测 3 个 → OVER_BUDGET', function (entry) {
  const dir = freshDir('budget');
  const root = path.join(dir, 'sessions');
  [CALL_A, CALL_B, CALL_C].forEach(function (id, index) {
    writeSession(root, 'g1', id, sessionLog({ id: id, createdAt: BASE_MS + 1000 * (index + 1), parentSession: PARENT_ID }, [
      { usage: usageOf(10, 5, 100, 0) }
    ]));
  });
  const map = sessionMapFile(dir, [
    { sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 },
    { sessionId: CALL_B, seq: 2, label: 'Verifier', phase: 'verify', attempt: 1 },
    { sessionId: CALL_C, seq: 3, label: 'Review', phase: 'review', attempt: 1 }
  ]);
  const noBudgetDir = path.join(dir, 'no-budget');
  mkdirSync(noBudgetDir, { recursive: true });
  const run1 = runExtractor(['--run-id', 'synthetic-no-budget', '--session-map', map, '--session-root', root, '--out-dir', noBudgetDir], noBudgetDir);
  check(run1.status === 0, '未声明预算场景退出码 0', 'exit=' + run1.status);
  const report1 = readReport(noBudgetDir);
  check(report1 !== null && report1.budget.verdict === 'NO_BUDGET_DECLARED', '未声明预算 → NO_BUDGET_DECLARED（不是 WITHIN_BUDGET）', String(report1 && report1.budget.verdict));
  check(report1 !== null && report1.budget.declared === false, 'declared=false', String(report1 && report1.budget.declared));

  const overDir = path.join(dir, 'over-budget');
  mkdirSync(overDir, { recursive: true });
  const budgetFile = path.join(dir, 'budget-2.json');
  writeFileSync(budgetFile, JSON.stringify({ maxAgentCalls: 2 }), 'utf8');
  const run2 = runExtractor(['--run-id', 'synthetic-over', '--session-map', map, '--session-root', root, '--out-dir', overDir, '--declared-budget', budgetFile], overDir);
  check(run2.status === 0, '超预算场景退出码 0', 'exit=' + run2.status);
  const report2 = readReport(overDir);
  check(report2 !== null && report2.budget.verdict === 'OVER_BUDGET', '声明 2 次实测 3 个 → OVER_BUDGET', String(report2 && report2.budget.verdict));
  check(report2 !== null && report2.budget.reasons.join(' ').indexOf('超过声明上限 2') !== -1, '超限理由写明上限与超出量', JSON.stringify(report2 && report2.budget.reasons));
});

// ------------------------------------------------------------------ 场景 11 确定性

scenario('确定性：同输入两次报告的 usage-report.json 字节相同，元数据各自独立', function (entry) {
  const dir = freshDir('deterministic');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: usageOf(10, 5, 100, 0) }
  ]));
  const map = sessionMapFile(dir, [{ sessionId: CALL_A, seq: 1, label: 'Coding', phase: 'coding', attempt: 1 }]);
  const firstDir = path.join(dir, 'first');
  const secondDir = path.join(dir, 'second');
  mkdirSync(firstDir, { recursive: true });
  mkdirSync(secondDir, { recursive: true });
  const first = runExtractor(['--run-id', 'synthetic-deterministic', '--session-map', map, '--session-root', root, '--out-dir', firstDir], firstDir);
  const second = runExtractor(['--run-id', 'synthetic-deterministic', '--session-map', map, '--session-root', root, '--out-dir', secondDir], secondDir);
  check(first.status === 0 && second.status === 0, '两次运行都退出 0', first.status + '/' + second.status);
  const report1 = readFileSync(path.join(firstDir, 'usage-report.json'));
  const report2 = readFileSync(path.join(secondDir, 'usage-report.json'));
  check(report1.equals(report2), 'usage-report.json 逐字节相同');
  const meta1 = JSON.parse(readFileSync(path.join(firstDir, 'extraction-metadata.json'), 'utf8'));
  const meta2 = JSON.parse(readFileSync(path.join(secondDir, 'extraction-metadata.json'), 'utf8'));
  check(meta1.reportSha256 === meta2.reportSha256, '元数据里的 reportSha256 一致', meta1.reportSha256 + ' vs ' + meta2.reportSha256);
  check(typeof meta1.extractedAt === 'string' && typeof meta2.extractedAt === 'string', '元数据各自带提取时间', meta1.extractedAt);
  check(meta1.inputs.logFiles.length === 1, '元数据记录日志来源指纹', JSON.stringify(meta1.inputs.logFiles));
  const report = JSON.parse(report1.toString('utf8'));
  check(Object.prototype.hasOwnProperty.call(report, 'extractedAt') === false, '确定性报告里没有提取时刻', Object.keys(report).join(','));
});

// ------------------------------------------------------------------ 场景 12 参数错误

scenario('参数错误：缺 --run-id 退出 4，不写报告', function (entry) {
  const dir = freshDir('bad-args');
  const run = runExtractor(['--out-dir', dir], dir);
  check(run.status === 4, '缺 --run-id 退出码 4', 'exit=' + run.status);
  check(run.stderr.indexOf('--run-id') !== -1, '错误信息点出 --run-id', run.stderr.trim());
  check(existsSync(path.join(dir, 'usage-report.json')) === false, '参数错误时不写报告');
});

// ------------------------------------------------------------------ 场景 12 尝试轮次

scenario('尝试轮次：记录里没有 attempt 字段时从阶段名后缀派生，并按轮次分组汇总', function (entry) {
  const dir = freshDir('attempts');
  const root = path.join(dir, 'sessions');
  writeSession(root, 'g1', CALL_A, sessionLog({ id: CALL_A, createdAt: BASE_MS + 1000, parentSession: PARENT_ID }, [
    { usage: usageOf(10, 5, 100, 0) }
  ]));
  writeSession(root, 'g1', CALL_B, sessionLog({ id: CALL_B, createdAt: BASE_MS + 2000, parentSession: PARENT_ID }, [
    { usage: usageOf(20, 6, 200, 0) }
  ]));
  writeSession(root, 'g1', CALL_C, sessionLog({ id: CALL_C, createdAt: BASE_MS + 3000, parentSession: PARENT_ID }, [
    { usage: usageOf(30, 7, 300, 0) }
  ]));
  // 刻意不给 attempt：真实 native-events.json 的 agentCalls 就没有这个字段。
  const map = sessionMapFile(dir, [
    { sessionId: CALL_A, seq: 1, label: 'Coding Agent', phase: 'coding' },
    { sessionId: CALL_B, seq: 2, label: 'Coding Agent (revision 2)', phase: 'coding-revision-2' },
    { sessionId: CALL_C, seq: 3, label: 'Review Agent (revision 3)', phase: 'review-revision-3' }
  ]);
  const run = runExtractor(['--run-id', 'synthetic-attempts', '--session-map', map, '--session-root', root, '--out-dir', dir], dir);
  check(run.status === 0, '尝试轮次场景退出码 0', 'exit=' + run.status + ' stderr=' + run.stderr);
  const report = readReport(dir);
  if (!report) { check(false, '尝试轮次场景产出报告'); return; }
  const attempts = report.sessions.map(function (session) { return session.attempt; }).sort(function (a, b) { return a - b; });
  check(JSON.stringify(attempts) === JSON.stringify([1, 2, 3]), '每个会话的 attempt 由阶段名派生', JSON.stringify(attempts));
  check(JSON.stringify(report.totals.attempts) === JSON.stringify([1, 2, 3]), '报告列出出现过的轮次', JSON.stringify(report.totals.attempts));
  check(report.totals.byAttempt.length === 3, '按轮次 + 阶段 + 代理 + 模型分组', String(report.totals.byAttempt.length));
  const firstRound = report.totals.byAttempt[0];
  const revision2 = report.totals.byAttempt[1];
  check(firstRound.attempt === 1 && firstRound.totalTokens === 115, '第 1 轮分组只含首轮用量', JSON.stringify(firstRound && firstRound.totalTokens));
  check(revision2.attempt === 2 && revision2.phase === 'coding-revision-2', '第 2 轮分组保留阶段名', JSON.stringify(revision2 && revision2.phase));
  check(revision2.totalTokens === 226, '第 2 轮分组用量独立累加', JSON.stringify(revision2 && revision2.totalTokens));
  check(report.limitations.join(' ').indexOf('名字派生') !== -1, '局限里写明轮次是名字派生的', JSON.stringify(report.limitations));
});

// ------------------------------------------------------------------ 收尾

try { rmSync(WORK, { recursive: true, force: true }); } catch (error) { /* 清理失败不影响结论 */ }

console.log('离线用量提取器合成日志测试（tests/extract-usage-report.mjs）');
console.log('');
scenarios.forEach(function (item) {
  const failed = failures.filter(function (line) { return line.indexOf(item.title + ' ::') === 0; });
  console.log((item.status === 'PASS' ? 'PASS' : 'FAIL') + '  ' + item.title);
  failed.forEach(function (line) { console.log('       - ' + line); });
});
console.log('');
if (failures.length > 0) {
  failures.forEach(function (line) { console.log('失败：' + line); });
  console.log('');
  console.log('结果：' + (scenarios.length - scenarios.filter(function (s) { return s.status === 'FAIL'; }).length) + '/' + scenarios.length +
    ' 场景，' + checksPassed + '/' + (checksPassed + failures.length) + ' 断言');
  process.exit(1);
}
console.log('结果：' + scenarios.length + '/' + scenarios.length + ' 场景，' + checksPassed + ' 项断言全部通过');
