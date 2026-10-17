// tests/workflow-harness.mjs
//
// 两个离线测试共用的一套夹具与运行器：
//   - tests/workflow-logic.test.mjs           编排层判定逻辑回归（模拟子代理返回值）
//   - tests/preflight-claim-integration.test.mjs  真实排他创建工具的产物接进预检门禁
//
// 生产脚本只有一份 workflows/three-agent-mvp.js，两个测试都直接跑它，不复制任何判定逻辑。
// 仅使用 Node 标准库（node:vm / node:fs / node:path / node:url），未安装任何依赖。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_PATH = path.join(HERE, '..', 'workflows', 'three-agent-mvp.js');
export const SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');

/** 固定的"编排层启动时间"（生产脚本用 Date.now() 锚定运行起点）。 */
export const FIXED_NOW_MS = Date.parse('2026-10-16T04:00:00Z');

/**
 * 可推进的模拟时钟：Date.now() 返回当前模拟时间，其余（parse / new Date(ms) / toISOString）保持真实行为。
 * 必须注入：生产脚本会核对 runStartedAt 与编排层实际时间的差值，否则测试夹具里的
 * 2026-10-16 会被真实机器时间判成"伪造起点"，正常成功路径也会失败。
 * 可推进是为了验证"每个 Agent 返回后重新读取当前时间"：不重新读取时，
 * 一个跑了很久的运行会把诚实的阶段时间戳误判成未来时间。
 */
export let clockNowMs = FIXED_NOW_MS;
export function setClock(ms) { clockNowMs = ms; }
export function advanceClock(ms) { clockNowMs += ms; }
/** 当前模拟时钟的 ISO-8601（UTC），供"诚实的阶段时间戳"使用。 */
export function clockIso() { return new Date(clockNowMs).toISOString(); }

function makeFixedDate() {
  return class FixedDate extends Date {
    constructor(...parts) {
      if (parts.length === 0) { super(clockNowMs); } else { super(...parts); }
    }
    static now() { return clockNowMs; }
  };
}

/**
 * 把脚本正文包成 async 函数（脚本正文在 workflow 工具里是顶层代码，含顶层 return）。
 * sourceText 省略时使用仓库里的生产脚本；`tests/preflight-workflow-script.mjs` 传入
 * **待提交的脚本文本**，用的仍是同一条加载路径（不复制任何判定逻辑）。
 */
export function loadWorkflowBody(sourceText) {
  const body = typeof sourceText === 'string' ? sourceText : SOURCE;
  const wrapper =
    'async function __workflowBody(args, agent, log, phase, parallel, pipeline) {\n' +
    body +
    '\n}\n__workflowBody;';
  return vm.runInNewContext(wrapper, { console: console, Date: makeFixedDate() });
}
export const workflowBody = loadWorkflowBody();

// ---------------------------------------------------------------- 测试夹具

export const NOW = '2026-10-16T12:00:00+08:00';            // 对应 UTC 时间戳 20261016T040000Z
export const RUN_ID = 'test-run-20261016T040000Z';        // runId 必须以 -<UTC 时间戳> 结尾（原子防覆盖）
export const EVIDENCE_DIR = 'docs/evidence/' + RUN_ID;
export const TARGET_DIR = 'examples/text-stats';
// 夹具时间必须与注入的"编排层当前时间"同一瞬间，否则时钟锚定判定会把夹具判成伪造起点。
if (Date.parse(NOW) !== FIXED_NOW_MS) {
  throw new Error('测试夹具的 NOW 与 FIXED_NOW_MS 不是同一瞬间：' + Date.parse(NOW) + ' != ' + FIXED_NOW_MS);
}
// 仓库根从测试文件位置推导，不写死本机路径（否则换个检出位置就断言失败，也把作者机器路径带进公开仓库）。
export const REPO_ROOT = path.resolve(HERE, '..').replace(/\\/g, '/');
export const MODULE_SHA = 'a'.repeat(64);
export const TEST_SHA = 'b'.repeat(64);
export const CANONICAL = 'python -m unittest discover -s ' + TARGET_DIR + ' -p "test_*.py"';
// 受控环境前缀：与 workflows/three-agent-mvp.js 的 TEST_ENV_PREFIX 形状一致（同一命令上下文）。
export const ENV_VAR = 'PYTHONDONTWRITEBYTECODE';
export const ENV_PREFIX = '$env:' + ENV_VAR + " = '1'; ";
export const EXEC_COMMAND = ENV_PREFIX + CANONICAL;
export const CACHE_DIR = TARGET_DIR + '/__pycache__';
export const OK_OUTPUT = '...........\n' +
  '----------------------------------------------------------------------\n' +
  'Ran 44 tests in 0.021s\n\nOK\n';
export const FAILED_OUTPUT = 'F...\n' +
  '======================================================================\n' +
  'FAIL: test_trailing_newline (test_text_stats.TestCountText)\n' +
  '----------------------------------------------------------------------\n' +
  'Ran 44 tests in 0.030s\n\nFAILED (failures=1)\n';

export function criteria(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push({ criterion: 'AC-' + String(i + 1).padStart(2, '0'), satisfied: true, evidence: 'text_stats.py:' + (90 + i) });
  }
  return list;
}

export function preflightOk(over) {
  const base = {
    repo_root: REPO_ROOT,
    repo_root_realpath: REPO_ROOT,
    evidence_dir_state: 'missing',
    evidence_dir_state_before: 'missing',
    evidence_dir_entries: [],
    evidence_dir_realpath: REPO_ROOT + '/' + EVIDENCE_DIR,
    evidence_dir_claimed: true,
    claim_tool: 'tools/claim_evidence_dir.py',
    claim_created: true,
    claim_exit_code: 0,
    claimed_at: NOW,
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

/** 预检夹具：目标目录换成调用方指定的目录（集成测试用临时交付目录）。 */
export function preflightFor(targetDirRel) {
  return preflightOk({
    target_dir: targetDirRel,
    target_dir_realpath: REPO_ROOT + '/' + targetDirRel,
    resolved_paths: [REPO_ROOT + '/' + targetDirRel, REPO_ROOT + '/' + EVIDENCE_DIR]
  });
}

export function requirementOk(criteriaCount, conflicts) {
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

export function codingOk(over) {
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
    bytecode_scope: bytecodeScope(),
    generated_at: NOW
  };
  return Object.assign(base, over || {});
}

// 缓存条目夹具：path 必须是 cache_dir 下的相对路径，mtime_ms 为毫秒时间戳，sha256 为 64 位十六进制。
export function cacheEntry(over) {
  const base = {
    path: CACHE_DIR + '/text_stats.cpython-313.pyc',
    bytes: 1024,
    mtime_ms: 1760000000000,
    sha256: 'c'.repeat(64)
  };
  return Object.assign(base, over || {});
}

export function bytecodeScope(over) {
  const base = {
    env_applied: true,
    env_variable: ENV_VAR,
    cache_dir: CACHE_DIR,
    entries_before: [],
    entries_after: []
  };
  return Object.assign(base, over || {});
}

export function verifyOk(over) {
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
    bytecode_scope: bytecodeScope(),
    requirement_conflicts: [],
    notes: '',
    generated_at: NOW
  };
  return Object.assign(base, over || {});
}

export function verifyFailed() {
  return verifyOk({ exit_code: '1', raw_output: FAILED_OUTPUT, result_marker: 'FAILED' });
}

export function reviewOk(over) {
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
    bytecode_scope: bytecodeScope(),
    requirement_conflicts: [],
    consistency_note: 'none',
    summary: '全部验收条件满足',
    report_file: EVIDENCE_DIR + '/review.json',
    generated_at: NOW
  };
  return Object.assign(base, over || {});
}

export function baseArgs(over) {
  const o = over || {};
  const task = Object.assign({
    targetDir: TARGET_DIR,
    moduleFile: 'text_stats.py',
    testFile: 'test_text_stats.py',
    sampleFile: 'sample_input.txt',
    maxCodingAttempts: 2,
    cacheBaseline: []
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

/**
 * plan: { preflight, requirement, coding, verify, review } 每项为 (attempt, label) => 返回值
 * options.resetClock === false 时保留调用方设置的时钟（集成测试要用真实当前时间，
 * 因为认领工具写的是真实时钟，固定时钟会让工具产物落在时间窗之外）。
 */
export async function runWith(plan, args, options) {
  return runSource(SOURCE, plan, args, options);
}

/**
 * 用**任意脚本文本**跑一次模拟运行（离线、0 次真实模型调用）。
 * `tests/preflight-workflow-script.mjs` 用它把"待提交的实际脚本文本"跑一遍并采集全部 schema，
 * 从而在启动真实运行之前发现宿主不支持的结构（v0.3-run3 的教训）。
 */
export async function runSource(sourceText, plan, args, options) {
  const opts = options || {};
  if (opts.resetClock !== false) {
    setClock(FIXED_NOW_MS); // 每个场景都从固定的启动时钟开始，推进时钟的场景不会污染后面的场景
  }
  const body = loadWorkflowBody(sourceText);
  const calls = [];
  const logs = [];
  // 可选的调用捕获：记录每次调用收到的提示词与 schema（供 tests/script-fingerprint.mjs 计算指纹）。
  const captured = Array.isArray(opts.capture) ? opts.capture : null;
  const agent = async function (prompt, opts) {
    const label = opts && typeof opts.label === 'string' ? opts.label : '(无 label)';
    calls.push(label);
    if (captured !== null) {
      captured.push({ label: label, phase: opts.phase, prompt: prompt, schema: opts.schema });
    }
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
  const result = await body(args, agent, log, phase, undefined, undefined);
  return { result: result, calls: calls, logs: logs };
}

/** 简化的"默认成功计划"，场景只需覆盖个别阶段。 */
export function happyPlan(over) {
  return Object.assign({
    preflight: function () { return preflightOk(); },
    requirement: function () { return requirementOk(3); },
    coding: function () { return codingOk(); },
    verify: function () { return verifyOk(); },
    review: function () { return reviewOk(); }
  }, over || {});
}

// ---------------------------------------------------------------- 断言框架

/** 一个测试文件一个 runner：统计断言与场景，最后由 finish() 统一打印与设置退出码。 */
export function makeRunner() {
  let checksPassed = 0;
  const failures = [];
  const scenarios = [];

  async function scenario(name, plan, args, expect, options) {
    let outcome = null;
    try {
      outcome = await runWith(plan, args, options);
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

  function finish(title) {
    const passed = scenarios.filter(function (s) { return s.status === 'PASS'; }).length;
    console.log(title);
    console.log('生产脚本：' + path.relative(process.cwd(), WORKFLOW_PATH));
    console.log('');
    scenarios.forEach(function (s) {
      console.log((s.status === 'PASS' ? 'PASS' : 'FAIL') + '  ' + s.name);
    });
    console.log('');
    console.log('场景：' + passed + '/' + scenarios.length + ' 通过；断言：' + checksPassed + ' 项通过，' + failures.length + ' 项失败');
    if (failures.length > 0) {
      console.log('');
      failures.forEach(function (f) { console.log('  ✗ ' + f); });
      process.exitCode = 1;
    }
  }

  return { scenario: scenario, finish: finish, failures: failures };
}
