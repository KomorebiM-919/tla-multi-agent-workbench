// tests/workflow-logic.test.mjs
//
// 编排层逻辑回归测试（**不调用真实子代理**）
//
// 做法：用 node:vm 读取生产脚本 workflows/three-agent-mvp.js，把它包成一个函数后注入
// 模拟的 agent() / log() / phase() 钩子，断言编排层在各种"自述与真实证据不一致"场景下的判定。
// 生产脚本只有一份，测试直接跑它，不复制逻辑。
//
// 运行：node tests/workflow-logic.test.mjs
// 仅使用 Node 标准库（node:vm / node:fs / node:path / node:url），未安装任何依赖。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(HERE, '..', 'workflows', 'three-agent-mvp.js');
const SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');

/** 把生产脚本包成 async 函数（脚本正文在 workflow 工具里是顶层代码，含顶层 return）。 */
function loadWorkflowBody() {
  const wrapper =
    'async function __workflowBody(args, agent, log, phase, parallel, pipeline) {\n' +
    SOURCE +
    '\n}\n__workflowBody;';
  return vm.runInNewContext(wrapper, { console: console });
}
const workflowBody = loadWorkflowBody();

// ---------------------------------------------------------------- 测试夹具

const NOW = '2026-10-16T12:00:00+08:00';            // 对应 UTC 时间戳 20261016T040000Z
const RUN_ID = 'test-run-20261016T040000Z';          // runId 必须以 -<UTC 时间戳> 结尾（原子防覆盖）
const EVIDENCE_DIR = 'docs/evidence/' + RUN_ID;
const TARGET_DIR = 'examples/text-stats';
// 仓库根从测试文件位置推导，不写死本机路径（否则换个检出位置就断言失败，也把作者机器路径带进公开仓库）。
const REPO_ROOT = path.resolve(HERE, '..').replace(/\\/g, '/');
const MODULE_SHA = 'a'.repeat(64);
const TEST_SHA = 'b'.repeat(64);
const CANONICAL = 'python -m unittest discover -s ' + TARGET_DIR + ' -p "test_*.py"';
const OK_OUTPUT = '...........\n' +
  '----------------------------------------------------------------------\n' +
  'Ran 44 tests in 0.021s\n\nOK\n';
const FAILED_OUTPUT = 'F...\n' +
  '======================================================================\n' +
  'FAIL: test_trailing_newline (test_text_stats.TestCountText)\n' +
  '----------------------------------------------------------------------\n' +
  'Ran 44 tests in 0.030s\n\nFAILED (failures=1)\n';

function criteria(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push({ criterion: 'AC-' + String(i + 1).padStart(2, '0'), satisfied: true, evidence: 'text_stats.py:' + (90 + i) });
  }
  return list;
}

function preflightOk(over) {
  const base = {
    repo_root: REPO_ROOT,
    repo_root_realpath: REPO_ROOT,
    evidence_dir_state: 'missing',
    evidence_dir_entries: [],
    evidence_dir_realpath: REPO_ROOT + '/' + EVIDENCE_DIR,
    evidence_dir_claimed: true,
    owner_marker_path: EVIDENCE_DIR + '/.run-owner.json',
    link_components: [],
    prompt_files: ['requirement', 'coding', 'review', 'verifier'].map(function (n) {
      return { path: 'agents/' + n + '-agent.md', exists: true };
    }),
    target_dir: TARGET_DIR,
    target_dir_state: 'present',
    target_dir_realpath: REPO_ROOT + '/' + TARGET_DIR,
    resolved_paths: [REPO_ROOT + '/' + TARGET_DIR, REPO_ROOT + '/' + EVIDENCE_DIR],
    problems: [],
    generated_at: NOW
  };
  return Object.assign(base, over || {});
}

function requirementOk(criteriaCount, conflicts) {
  const acs = [];
  for (let i = 0; i < criteriaCount; i += 1) { acs.push('AC-' + String(i + 1).padStart(2, '0') + '（可检查描述）'); }
  return {
    goal: '交付文本统计 CLI',
    scope_in: ['count_text', 'main'],
    scope_out: ['词频统计'],
    acceptance_criteria: acs,
    boundary_conditions: ['BC-01 空文本', 'BC-02 以换行结尾', 'BC-03 空白行', 'BC-04 单词规则'],
    consistency_check: { self_checked: true, conflicts: conflicts || [], notes: '已交叉核对' },
    generated_at: NOW
  };
}

function codingOk(over) {
  const base = {
    files_created: [{ path: TARGET_DIR + '/text_stats.py', purpose: '实现' }],
    implementation_summary: '实现 count_text 与 CLI',
    acceptance_criteria_addressed: ['AC-01'],
    test_command: CANONICAL,
    test_succeeded: true,
    test_exit_code: '0',
    test_output_excerpt: OK_OUTPUT,
    deviations_from_requirement: [],
    requirement_conflicts: [],
    report_file: EVIDENCE_DIR + '/coding-report.json',
    generated_at: NOW
  };
  return Object.assign(base, over || {});
}

function verifyOk(over) {
  const base = {
    command: CANONICAL,
    exit_code: '0',
    raw_output: OK_OUTPUT,
    ran_tests: 44,
    result_marker: 'OK',
    artifacts: [
      { path: TARGET_DIR + '/text_stats.py', sha256: MODULE_SHA, bytes: 1024 },
      { path: TARGET_DIR + '/test_text_stats.py', sha256: TEST_SHA, bytes: 2048 }
    ],
    requirement_conflicts: [],
    notes: '',
    generated_at: NOW
  };
  return Object.assign(base, over || {});
}

function verifyFailed() {
  return verifyOk({ exit_code: '1', raw_output: FAILED_OUTPUT, result_marker: 'FAILED' });
}

function reviewOk(over) {
  const base = {
    verdict: 'APPROVED',
    criteria_check: criteria(3),
    issues: [],
    independent_test_command: CANONICAL,
    independent_test_exit_code: '0',
    independent_test_output: OK_OUTPUT,
    artifacts_after: [
      { path: TARGET_DIR + '/text_stats.py', sha256: MODULE_SHA, bytes: 1024 },
      { path: TARGET_DIR + '/test_text_stats.py', sha256: TEST_SHA, bytes: 2048 }
    ],
    requirement_conflicts: [],
    consistency_note: 'none',
    summary: '全部验收条件满足',
    report_file: EVIDENCE_DIR + '/review.json',
    generated_at: NOW
  };
  return Object.assign(base, over || {});
}

function baseArgs(over) {
  const o = over || {};
  const task = Object.assign({
    targetDir: TARGET_DIR,
    moduleFile: 'text_stats.py',
    testFile: 'test_text_stats.py',
    sampleFile: 'sample_input.txt',
    maxCodingAttempts: 2
  }, o.task || {});
  const args = { runId: RUN_ID, evidenceDir: EVIDENCE_DIR, promptDir: 'agents', task: task };
  ['runId', 'evidenceDir', 'promptDir', 'runStartedAt'].forEach(function (key) {
    if (o[key] !== undefined) { args[key] = o[key]; }
  });
  return args;
}

// ---------------------------------------------------------------- 运行夹具

function pickKey(label) {
  if (label.indexOf('Verifier (preflight)') === 0) { return 'preflight'; }
  if (label.indexOf('Requirement Agent') === 0) { return 'requirement'; }
  if (label.indexOf('Coding Agent') === 0) { return 'coding'; }
  if (label.indexOf('Verifier (verify)') === 0) { return 'verify'; }
  if (label.indexOf('Review Agent') === 0) { return 'review'; }
  return 'unknown';
}

/** plan: { preflight, requirement, coding, verify, review } 每项为 (attempt, label) => 返回值 */
async function runWith(plan, args) {
  const calls = [];
  const logs = [];
  const agent = async function (prompt, opts) {
    const label = opts && typeof opts.label === 'string' ? opts.label : '(无 label)';
    calls.push(label);
    const key = pickKey(label);
    const responder = plan[key];
    if (typeof responder !== 'function') {
      throw new Error('模拟环境未提供 ' + key + ' 的返回值（实际调用：' + label + '）');
    }
    const match = /revision (\d+)/.exec(label);
    return await responder(match ? Number(match[1]) : 1, label);
  };
  const log = function (message) { logs.push(String(message)); };
  const phase = function () {};
  const result = await workflowBody(args, agent, log, phase, undefined, undefined);
  return { result: result, calls: calls, logs: logs };
}

/** 简化的"默认成功计划"，场景只需覆盖个别阶段。 */
function happyPlan(over) {
  return Object.assign({
    preflight: function () { return preflightOk(); },
    requirement: function () { return requirementOk(3); },
    coding: function () { return codingOk(); },
    verify: function () { return verifyOk(); },
    review: function () { return reviewOk(); }
  }, over || {});
}

// ---------------------------------------------------------------- 断言框架

let checksPassed = 0;
const failures = [];
const scenarios = [];

function check(name, condition, detail) {
  if (condition) { checksPassed += 1; } else { failures.push(name + ' :: ' + (detail || '断言失败')); }
}

async function scenario(name, plan, args, expect) {
  let outcome = null;
  try {
    outcome = await runWith(plan, args);
  } catch (error) {
    failures.push(name + ' :: 运行抛出异常 ' + (error && error.message ? error.message : String(error)));
    scenarios.push({ name: name, status: 'THROW' });
    return;
  }
  const result = outcome.result;
  const notes = [];
  function expectCheck(label, condition, detail) {
    if (condition) { checksPassed += 1; } else { failures.push(name + ' / ' + label + ' :: ' + (detail || '断言失败')); }
    notes.push((condition ? '✓' : '✗') + ' ' + label);
  }
  expectCheck('返回结构含 status', result && typeof result.status === 'string', 'status=' + (result && result.status));
  if (expect.status) { expectCheck('status=' + expect.status, result.status === expect.status, '实际 ' + result.status); }
  if (expect.ok !== undefined) { expectCheck('ok=' + expect.ok, result.ok === expect.ok, '实际 ' + result.ok); }
  if (expect.attempts !== undefined) { expectCheck('attempts=' + expect.attempts, result.attempts === expect.attempts, '实际 ' + result.attempts); }
  if (expect.calls !== undefined) {
    expectCheck('子代理调用次数=' + expect.calls, outcome.calls.length === expect.calls, '实际 ' + outcome.calls.length + ' 次：' + outcome.calls.join(' > '));
  }
  if (expect.errorIncludes) {
    const text = String(result.error || '') + ' | ' + JSON.stringify(result.errors || []);
    expectCheck('错误信息包含「' + expect.errorIncludes + '」', text.indexOf(expect.errorIncludes) !== -1, '实际：' + text);
  }
  if (expect.finalFlag) {
    expectCheck('finalDecision.' + expect.finalFlag, result.finalDecision && result.finalDecision[expect.finalFlag] === expect.finalFlagValue,
      '实际 ' + JSON.stringify(result.finalDecision));
  }
  if (typeof expect.extra === 'function') { expect.extra(result, outcome, expectCheck); }
  scenarios.push({ name: name, status: failures.some(function (f) { return f.indexOf(name + ' ') === 0 || f.indexOf(name + ' /') === 0; }) ? 'FAIL' : 'PASS', notes: notes });
}

// ---------------------------------------------------------------- 场景

// 1. 正常成功路径
await scenario('正常成功 → OK（必须同时满足外部验证与全部验收条件）',
  happyPlan(),
  baseArgs(),
  { status: 'OK', ok: true, attempts: 1, calls: 5, finalFlag: 'testsIndependentlyVerified', finalFlagValue: true });

// 2. Coding 自述失败 + 外部验证失败，即使 Review 判 APPROVED 也不得 ok（第一类漏洞）
await scenario('测试失败但 Review APPROVED → TEST_NOT_VERIFIED（不得 ok）',
  happyPlan({
    coding: function () { return codingOk({ test_succeeded: false, test_exit_code: '1', test_output_excerpt: FAILED_OUTPUT }); },
    verify: function () { return verifyFailed(); },
    review: function () { return reviewOk({ independent_test_exit_code: '1', independent_test_output: FAILED_OUTPUT }); }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'TEST_NOT_VERIFIED', ok: false, attempts: 1, calls: 5 });

// 3. 自述"测试通过"但外部独立验证输出为 FAILED → 自述与证据矛盾（第一类漏洞之核心）
await scenario('自述成功但独立验证失败 → INCONSISTENT_EVIDENCE（不得 ok）',
  happyPlan({
    coding: function () { return codingOk({ test_succeeded: true, test_exit_code: '0' }); },
    verify: function () { return verifyFailed(); },
    review: function () { return reviewOk({ independent_test_exit_code: '1', independent_test_output: FAILED_OUTPUT }); }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'INCONSISTENT_EVIDENCE', ok: false, calls: 5 });

// 4. 某条验收条件未满足但 Review 仍判 APPROVED → 不得 ok
await scenario('有验收条件未满足但 APPROVED → CRITERIA_NOT_SATISFIED',
  happyPlan({
    review: function () {
      const list = criteria(3);
      list[1].satisfied = false;
      return reviewOk({ criteria_check: list });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'CRITERIA_NOT_SATISFIED', ok: false, calls: 5 });

// 5. criteria_check 覆盖面不足
await scenario('criteria_check 未覆盖全部验收条件 → CRITERIA_CHECK_INCOMPLETE',
  happyPlan({ review: function () { return reviewOk({ criteria_check: criteria(2) }); } }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'CRITERIA_CHECK_INCOMPLETE', ok: false, calls: 5 });

// 6. Review 自述退出码 0 但原始输出含 FAILED → 审核自述与证据矛盾
await scenario('Review 自述 exit 0 但原始输出含 FAILED → INCONSISTENT_REVIEW',
  happyPlan({
    review: function () {
      return reviewOk({ independent_test_exit_code: '0', independent_test_output: FAILED_OUTPUT });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'INCONSISTENT_REVIEW', ok: false, calls: 5 });

// 7. 审核不通过 → 自动修订 → 第二轮通过
await scenario('审核不通过后自动修订 → 第二轮 APPROVED 且 ok',
  happyPlan({
    review: function (attempt) {
      if (attempt === 1) {
        return reviewOk({
          verdict: 'CHANGES_REQUESTED',
          issues: [{ file: TARGET_DIR + '/text_stats.py', location: 'text_stats.py:155', problem: '退出码应为 1', suggestion: '捕获 SystemExit' }]
        });
      }
      return reviewOk();
    },
    coding: function (attempt) {
      return codingOk({ implementation_summary: '第 ' + attempt + ' 轮实现' });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 3 } }),
  { status: 'OK', ok: true, attempts: 2, calls: 8 });

// 8. 达到最大修订次数仍不通过
await scenario('达到最大轮次仍不通过 → MAX_ATTEMPTS_REVIEW_NOT_APPROVED',
  happyPlan({
    review: function () {
      return reviewOk({ verdict: 'CHANGES_REQUESTED', issues: [{ file: TARGET_DIR + '/text_stats.py', problem: '仍有缺陷', suggestion: '修复' }] });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 2 } }),
  { status: 'MAX_ATTEMPTS_REVIEW_NOT_APPROVED', ok: false, attempts: 2, calls: 8 });

// 9. 重复 runId：证据目录已存在 → 拒绝覆盖，且不启动任何角色子代理
await scenario('证据目录已存在 → EVIDENCE_EXISTS 且不覆盖（仅预检被调用）',
  happyPlan({ preflight: function () { return preflightOk({ evidence_dir_state: 'exists', evidence_dir_entries: ['requirement.json'] }); } }),
  baseArgs(),
  { status: 'EVIDENCE_EXISTS', ok: false, calls: 1, errorIncludes: '历史证据不会被覆盖' });

// 10. 非法目标目录（路径穿越）
await scenario('targetDir 路径穿越 → INVALID_ARGS（0 次子代理调用）',
  happyPlan(),
  baseArgs({ task: { targetDir: '../outside-repo' } }),
  { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: '未启动任何子代理' });

// 11. 预检报告的**解算真实路径**不在其声明的仓库根之下
await scenario('预检显示交付目录真实路径在仓库根之外 → TARGET_DIR_OUTSIDE_REPO',
  happyPlan({
    preflight: function () {
      return preflightOk({ target_dir_realpath: 'D:/Windows/Temp/' + TARGET_DIR });
    }
  }),
  baseArgs(),
  { status: 'TARGET_DIR_OUTSIDE_REPO', ok: false, calls: 1 });

// 11b. 预检没有回报交付目录的真实路径 → 同样拒绝继续（fail-closed）
await scenario('预检未回报交付目录 realpath → TARGET_DIR_OUTSIDE_REPO（fail-closed）',
  happyPlan({ preflight: function () { return preflightOk({ target_dir_realpath: '' }); } }),
  baseArgs(),
  { status: 'TARGET_DIR_OUTSIDE_REPO', ok: false, calls: 1 });

// 11d. 证据目录的真实路径越出仓库 → 同样拒绝（证据不得落到仓库之外）
await scenario('预检显示证据目录真实路径在仓库根之外 → TARGET_DIR_OUTSIDE_REPO',
  happyPlan({ preflight: function () { return preflightOk({ evidence_dir_realpath: 'D:/Windows/Temp/ev' }); } }),
  baseArgs(),
  { status: 'TARGET_DIR_OUTSIDE_REPO', ok: false, calls: 1 });

// 11e. 路径分量中的重解析点（软链接 / 目录联接）解算后越出仓库
await scenario('预检发现链接解算到仓库之外 → LINK_ESCAPE',
  happyPlan({ preflight: function () { return preflightOk({ link_components: ['C:/Windows/Temp/link-to-examples'] }); } }),
  baseArgs(),
  { status: 'LINK_ESCAPE', ok: false, calls: 1 });

// 11f. 证据目录没有被认领成功（同一目录可能被并发运行覆盖）→ 拒绝继续
await scenario('预检未完成证据目录认领 → EVIDENCE_NOT_CLAIMED',
  happyPlan({ preflight: function () { return preflightOk({ evidence_dir_claimed: false }); } }),
  baseArgs(),
  { status: 'EVIDENCE_NOT_CLAIMED', ok: false, calls: 1 });

// 11c. 预检未回报仓库根 → 拒绝继续
await scenario('预检未回报仓库根 → TARGET_DIR_OUTSIDE_REPO（fail-closed）',
  happyPlan({ preflight: function () { return preflightOk({ repo_root: '' }); } }),
  baseArgs(),
  { status: 'TARGET_DIR_OUTSIDE_REPO', ok: false, calls: 1 });

// 11g. 预检未回报仓库根的真实路径 → 同样拒绝（新口径只认 realpath）
await scenario('预检未回报仓库根 realpath → TARGET_DIR_OUTSIDE_REPO（fail-closed）',
  happyPlan({ preflight: function () { return preflightOk({ repo_root_realpath: '' }); } }),
  baseArgs(),
  { status: 'TARGET_DIR_OUTSIDE_REPO', ok: false, calls: 1 });

// 12. 非法 maxCodingAttempts（三个取值都要给出明确错误且不崩溃）
for (const bad of [0, 'abc', 99, 2.5]) {
  await scenario('非法 maxCodingAttempts=' + JSON.stringify(bad) + ' → INVALID_ARGS 且不抛异常',
    happyPlan(),
    baseArgs({ task: { maxCodingAttempts: bad } }),
    { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: 'maxCodingAttempts' });
}

// 13. 非法 runId / evidenceDir / testCommand
await scenario('runId 含路径穿越 → INVALID_ARGS', happyPlan(),
  baseArgs({ runId: '../evil', evidenceDir: 'docs/evidence/evil' }),
  { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: 'runId' });

await scenario('evidenceDir 不在 docs/evidence/ 之下 → INVALID_ARGS', happyPlan(),
  baseArgs({ evidenceDir: 'somewhere/else' }),
  { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: 'evidenceDir' });

await scenario('evidenceDir 末段与 runId 不一致 → INVALID_ARGS', happyPlan(),
  baseArgs({ evidenceDir: 'docs/evidence/other-run' }),
  { status: 'INVALID_ARGS', ok: false, calls: 0 });

await scenario('任意 shell 测试命令 → INVALID_ARGS（只接受规范化命令）', happyPlan(),
  baseArgs({ task: { testCommand: 'python -m pytest -q' } }),
  { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: 'testCommand' });

await scenario('testCommand 带 -v → 允许（等价于规范化命令）', happyPlan(),
  baseArgs({ task: { testCommand: CANONICAL + ' -v' } }),
  { status: 'OK', ok: true, calls: 5 });

// 14. 提示词文件缺失
await scenario('角色提示词文件缺失 → PROMPT_MISSING',
  happyPlan({
    preflight: function () {
      return preflightOk({
        prompt_files: [
          { path: 'agents/requirement-agent.md', exists: true },
          { path: 'agents/verifier-agent.md', exists: false }
        ]
      });
    }
  }),
  baseArgs(),
  { status: 'PROMPT_MISSING', ok: false, calls: 1, errorIncludes: 'verifier-agent.md' });

// 15. 占位/过期时间戳
await scenario('占位时间戳（不在运行窗口内）→ INVALID_TIMESTAMP',
  happyPlan({ preflight: function () { return preflightOk({ generated_at: '2024-01-01T00:00:00Z' }); } }),
  baseArgs({ runStartedAt: NOW }),
  { status: 'INVALID_TIMESTAMP', ok: false, calls: 1, errorIncludes: '时间戳' });

// 16. 需求自检发现冲突 → 立即停止实施，不进入编码阶段
await scenario('需求自检报告冲突 → REQUIREMENT_CONFLICT（不启动 Coding Agent）',
  happyPlan({
    requirement: function () {
      return requirementOk(3, [{ refs: 'AC-02 / BC-03', description: '以换行结尾的行数无法同时为 3 与 2' }]);
    }
  }),
  baseArgs(),
  { status: 'REQUIREMENT_CONFLICT', ok: false, calls: 2, errorIncludes: '等待人工澄清' });

// 17. 需求自检缺失 / 需求产物不完整
await scenario('需求未完成一致性自检 → REQUIREMENT_CONFLICT',
  happyPlan({
    requirement: function () {
      const req = requirementOk(3);
      delete req.consistency_check.self_checked;
      return req;
    }
  }),
  baseArgs(),
  { status: 'REQUIREMENT_CONFLICT', ok: false, calls: 2 });

await scenario('需求缺少验收条件 → REQUIREMENT_OUTPUT_INVALID',
  happyPlan({ requirement: function () { return { goal: '只有目标' }; } }),
  baseArgs(),
  { status: 'REQUIREMENT_OUTPUT_INVALID', ok: false, calls: 2 });

// 18. Coding 报告不可用
await scenario('Coding 未返回实现报告 → CODING_OUTPUT_INVALID（仍走完验证与审核）',
  happyPlan({ coding: function () { return {}; } }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'CODING_OUTPUT_INVALID', ok: false, calls: 5 });

// 19. 参数整体缺失时不得抛异常，也不得默认去跑已归档的 v0.1-first-run
await scenario('args 缺失 → INVALID_ARGS（不得默认使用已归档 runId）', happyPlan(), undefined,
  { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: 'runId' });

// 20. 空对象参数同样给出明确错误
await scenario('args={} → INVALID_ARGS 且列出全部问题', happyPlan(), {},
  { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: '未启动任何子代理' });

// 21. 显式指向已归档证据目录 → 拒绝覆盖
await scenario('runId 指向已归档运行 → EVIDENCE_EXISTS（不覆盖历史证据）',
  happyPlan({ preflight: function () { return preflightOk({ evidence_dir_state: 'exists', evidence_dir_entries: ['requirement.json', 'review.json'] }); } }),
  baseArgs(),
  { status: 'EVIDENCE_EXISTS', ok: false, calls: 1, errorIncludes: '历史证据不会被覆盖' });

// 21b. 原子防覆盖：runId 必须以 -<UTC 时间戳> 结尾，且与 runStartedAt 同一秒
await scenario('runId 缺少 UTC 时间戳后缀 → INVALID_ARGS（防覆盖命名约束）',
  happyPlan(),
  baseArgs({ runId: 'test-run-plain', evidenceDir: 'docs/evidence/test-run-plain', runStartedAt: NOW }),
  { status: 'INVALID_ARGS', ok: false, calls: 0, errorIncludes: 'UTC' });

await scenario('runId 时间戳与 runStartedAt 不同秒 → INVALID_ARGS',
  happyPlan(),
  baseArgs({ runId: 'test-run-20260101T000000Z', evidenceDir: 'docs/evidence/test-run-20260101T000000Z', runStartedAt: NOW }),
  { status: 'INVALID_ARGS', ok: false, calls: 0 });

// 22. 复审意见四：需求自检为空 + Review 报告冲突但仍 APPROVED → 最终必须失败
await scenario('Review 报告需求冲突却仍 APPROVED → STAGE_REPORTS_REQUIREMENT_CONFLICT（不得 ok）',
  happyPlan({
    review: function () {
      return reviewOk({ requirement_conflicts: [{ refs: 'AC-12 / BC-12', description: '同一调用的标准输出期望互斥（4 行统计 vs 仅 True 0 int）' }] });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'STAGE_REPORTS_REQUIREMENT_CONFLICT', ok: false, attempts: 1, calls: 5, errorIncludes: '需求冲突' });

// 22b. Verifier 报告未解决需求冲突 → 同样不得成功
await scenario('Verifier 报告需求冲突 → STAGE_REPORTS_REQUIREMENT_CONFLICT（不得 ok）',
  happyPlan({
    verify: function () {
      return verifyOk({ requirement_conflicts: [{ refs: 'BC-02 / BC-03', description: 'U+2028 是否算行边界互斥' }] });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'STAGE_REPORTS_REQUIREMENT_CONFLICT', ok: false, attempts: 1, calls: 5 });

// 22c. Coding 报告未解决需求冲突 → 同样不得成功
await scenario('Coding 报告需求冲突 → STAGE_REPORTS_REQUIREMENT_CONFLICT（不得 ok）',
  happyPlan({
    coding: function () {
      return codingOk({ requirement_conflicts: [{ refs: 'AC-05 / BC-03', description: '同一输入的行数期望互斥' }] });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'STAGE_REPORTS_REQUIREMENT_CONFLICT', ok: false, attempts: 1, calls: 5 });

// 22d. 冲突优先于次要原因：Coding 报告不可用 + Verifier 报告冲突 → 必须报冲突状态
await scenario('Coding 未返回报告且 Verifier 报告冲突 → STAGE_REPORTS_REQUIREMENT_CONFLICT（冲突优先）',
  happyPlan({
    coding: function () { return {}; },
    verify: function () {
      return verifyOk({ requirement_conflicts: [{ refs: 'BC-03 / BC-04', description: '空白行示例互斥：同一输入被同时写成 2 行与 3 行' }] });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'STAGE_REPORTS_REQUIREMENT_CONFLICT', ok: false, attempts: 1, calls: 5, errorIncludes: '需求冲突' });

// 23. 验收条件 ID 逐项核对：缺失 / 重复
await scenario('验收条件缺少 ID → REQUIREMENT_IDS_INVALID',
  happyPlan({
    requirement: function () {
      const req = requirementOk(3);
      req.acceptance_criteria[1] = '（这条验收条件没有编号）';
      return req;
    }
  }),
  baseArgs(),
  { status: 'REQUIREMENT_IDS_INVALID', ok: false, calls: 2 });

await scenario('验收条件 ID 重复 → REQUIREMENT_IDS_INVALID',
  happyPlan({
    requirement: function () {
      const req = requirementOk(3);
      req.acceptance_criteria[1] = 'AC-01（与第一条重复）';
      return req;
    }
  }),
  baseArgs(),
  { status: 'REQUIREMENT_IDS_INVALID', ok: false, calls: 2 });

// 24. Review 的 criteria_check ID 集合：未知 / 重复 / 缺失
await scenario('Review 的 criteria_check 出现未知 ID → CRITERIA_CHECK_UNKNOWN_IDS',
  happyPlan({
    review: function () {
      const list = criteria(3);
      list[2].criterion = 'AC-99';
      return reviewOk({ criteria_check: list });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'CRITERIA_CHECK_UNKNOWN_IDS', ok: false, calls: 5 });

await scenario('Review 的 criteria_check 出现重复 ID → CRITERIA_CHECK_DUPLICATE_IDS',
  happyPlan({
    review: function () {
      const list = criteria(3);
      list[2].criterion = 'AC-01';
      return reviewOk({ criteria_check: list });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'CRITERIA_CHECK_DUPLICATE_IDS', ok: false, calls: 5 });

await scenario('Review 的 criteria_check 少一条 ID → CRITERIA_CHECK_INCOMPLETE（按 ID 逐项核对）',
  happyPlan({ review: function () { return reviewOk({ criteria_check: criteria(2) }); } }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'CRITERIA_CHECK_INCOMPLETE', ok: false, calls: 5 });

// 25. 验证前后文件指纹必须一致
await scenario('验证前后文件指纹不一致 → ARTIFACT_FINGERPRINT_MISMATCH',
  happyPlan({
    review: function () {
      return reviewOk({
        artifacts_after: [
          { path: TARGET_DIR + '/text_stats.py', sha256: 'c'.repeat(64), bytes: 1024 },
          { path: TARGET_DIR + '/test_text_stats.py', sha256: TEST_SHA, bytes: 2048 }
        ]
      });
    }
  }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'ARTIFACT_FINGERPRINT_MISMATCH', ok: false, calls: 5 });

await scenario('Review 未回传 artifacts_after → ARTIFACT_FINGERPRINT_MISMATCH',
  happyPlan({ review: function () { return reviewOk({ artifacts_after: [] }); } }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'ARTIFACT_FINGERPRINT_MISMATCH', ok: false, calls: 5 });

// 26. Review 必须原样执行规范化命令（否则"独立复跑"不算数）
await scenario('Review 的独立复跑命令被换掉 → INCONSISTENT_REVIEW（不得 ok）',
  happyPlan({ review: function () { return reviewOk({ independent_test_command: 'python -m pytest -q' }); } }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'INCONSISTENT_REVIEW', ok: false, calls: 5 });

// 27. Verifier 的时间窗门禁必须生效（曾因判定被重算而成为死代码）
await scenario('Verifier 证据时间戳越出运行窗口 → INVALID_TIMESTAMP（不得 ok）',
  happyPlan({ verify: function () { return verifyOk({ generated_at: '2024-01-01T00:00:00Z' }); } }),
  baseArgs({ task: { maxCodingAttempts: 1 } }),
  { status: 'INVALID_TIMESTAMP', ok: false, calls: 5 });

// ---------------------------------------------------------------- 结果

const passedScenarios = scenarios.filter(function (s) { return s.status === 'PASS'; }).length;
console.log('编排层逻辑回归测试（模拟子代理返回值）');
console.log('生产脚本：' + path.relative(process.cwd(), WORKFLOW_PATH));
console.log('');
scenarios.forEach(function (s) {
  console.log((s.status === 'PASS' ? 'PASS' : 'FAIL') + '  ' + s.name);
});
console.log('');
console.log('场景：' + passedScenarios + '/' + scenarios.length + ' 通过；断言：' + checksPassed + ' 项通过，' + failures.length + ' 项失败');
if (failures.length > 0) {
  console.log('');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exitCode = 1;
}
