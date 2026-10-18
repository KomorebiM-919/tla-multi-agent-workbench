// tests/bytecode-integration.test.mjs
//
// 真实子进程集成测试（**不调用真实模型子代理**，只启动本机的 python / PowerShell 进程）
//
// 目的：证明"编排层说的环境传递"在真实进程里确实生效，而不是报告里的一句自述。
//   1. 受控环境前缀 `$env:PYTHONDONTWRITEBYTECODE = '1'; ...` 真的到达 python 子进程；
//   2. 干净交付目录下用该前缀运行规范命令后，没有新生成 `__pycache__`；
//   3. 已存在的缓存文件在带前缀运行后不被重写（bytes / mtime_ms / sha256 全不变）；
//   4. 环境未设置或缓存发生写入时，编排层的运行期写入边界判定明确拒绝（不是"忽略"）。
//
// 判定用的是生产脚本里的同一套接口（tests/workflow-harness.mjs 直接加载 workflows/three-agent-mvp.js），
// 不是把判定逻辑抄一份到测试里。
//
// 注意：PowerShell 会把子进程的非零退出码折叠成 1，所以"环境是否到达"不靠退出码，
// 而是让子进程把自己的环境写进文件再读回文件（不经过管道，沙箱下也可用）。
//
// 运行：node tests/bytecode-integration.test.mjs
// 仅使用 Node 标准库，未安装任何依赖。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  REPO_ROOT, ENV_VAR, ENV_PREFIX, MODULE_SHA, TEST_SHA, baseArgs, happyPlan,
  makeRunner, preflightFor, verifyOk, reviewOk
} from './workflow-harness.mjs';

const runner = makeRunner();
const scenario = runner.scenario;

const WORK_ROOT_REL = 'tests/.scratch/bytecode-integration';
const OK_FOR_TWO = '..\n' +
  '----------------------------------------------------------------------\n' +
  'Ran 2 tests in 0.010s\n\nOK\n';

// 本机只保证有 Windows PowerShell；`pwsh` 若存在则优先（与 DSH 里的执行环境一致）。
function pickShell() {
  for (const candidate of ['pwsh', 'powershell.exe']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) { return candidate; }
  }
  throw new Error('找不到可用的 PowerShell 可执行文件（pwsh / powershell.exe）');
}

const PS_SHELL = pickShell();

// ---------------------------------------------------------------- 真实进程夹具

/** 建一个干净的交付目录（模块 + 测试），返回仓库内相对路径（正斜杠）。 */
function prepareDelivery(name) {
  const rel = WORK_ROOT_REL + '/' + name;
  const abs = path.join(REPO_ROOT, rel);
  fs.rmSync(abs, { recursive: true, force: true });
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'mod.py'), 'def add(a, b):\n    return a + b\n', 'utf8');
  fs.writeFileSync(path.join(abs, 'test_mod.py'), [
    'import unittest',
    '',
    'from mod import add',
    '',
    '',
    'class TestAdd(unittest.TestCase):',
    '    def test_add(self):',
    '        self.assertEqual(add(2, 3), 5)',
    '',
    '    def test_sub(self):',
    '        self.assertEqual(add(3, 3), 6)',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    ''
  ].join('\n'), 'utf8');
  return rel;
}

function canonicalFor(rel) {
  return 'python -m unittest discover -s ' + rel + ' -p "test_*.py"';
}

/**
 * 执行一条命令；只用 stdio:'ignore'（沙箱下管道捕获会 EPERM）。返回退出码。
 * 显式从子进程环境里**删掉** ENV_VAR：测试进程自身可能被外层（复核套件）设置了该变量，
 * 否则"不设前缀就会写缓存"的前提会被外层环境污染，场景退化成假通过/假失败。
 */
function runExitCode(command) {
  const env = Object.assign({}, process.env);
  delete env[ENV_VAR];
  const done = spawnSync(PS_SHELL, ['-NoProfile', '-Command', command], { cwd: REPO_ROOT, stdio: 'ignore', env: env });
  if (done.error) { throw new Error('无法启动子进程 ' + PS_SHELL + '：' + done.error.message); }
  return done.status;
}

/** 让子进程把自己的环境变量写进文件（不靠 stdout/退出码）。返回读回的值。 */
function probeEnvViaFile(rel, withPrefix) {
  const script = [
    'import os, sys',
    'target = sys.argv[1]',
    'with open(target, "w", encoding="utf-8") as handle:',
    '    handle.write(os.environ.get("' + ENV_VAR + '", "<unset>"))',
    ''
  ].join('\n');
  const scriptAbs = path.join(REPO_ROOT, rel, 'probe_env.py');
  const outAbs = path.join(REPO_ROOT, rel, 'probe_env_out.txt');
  fs.writeFileSync(scriptAbs, script, 'utf8');
  fs.rmSync(outAbs, { force: true });
  const head = withPrefix ? ENV_PREFIX : '';
  const exitCode = runExitCode(head + 'python ' + rel + '/probe_env.py ' + rel + '/probe_env_out.txt');
  const value = fs.existsSync(outAbs) ? fs.readFileSync(outAbs, 'utf8') : '<未写出>';
  return { exitCode: exitCode, value: value };
}

/** 读取 `<rel>/__pycache__` 下的文件指纹（path / bytes / mtime_ms / sha256），按 path 排序。 */
function cacheEntries(rel) {
  const cacheAbs = path.join(REPO_ROOT, rel, '__pycache__');
  if (!fs.existsSync(cacheAbs)) { return []; }
  const out = [];
  const stack = [cacheAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const abs = path.join(current, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) { stack.push(abs); continue; }
      const bytes = fs.readFileSync(abs);
      out.push({
        path: path.relative(REPO_ROOT, abs).replace(/\\/g, '/'),
        bytes: bytes.length,
        mtime_ms: stat.mtimeMs,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      });
    }
  }
  out.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
  return out;
}

function scopeOf(rel, before, after, over) {
  return Object.assign({
    env_applied: true,
    env_variable: ENV_VAR,
    cache_dir: rel + '/__pycache__',
    entries_before: before,
    entries_after: after
  }, over || {});
}

/** 用临时交付目录拼一个"编排层看到"的 verify/review 返回值。 */
function evidenceFor(rel, command, scope) {
  const artifacts = [
    { path: rel + '/mod.py', sha256: MODULE_SHA, bytes: 1024 },
    { path: rel + '/test_mod.py', sha256: TEST_SHA, bytes: 2048 }
  ];
  return {
    verify: verifyOk({
      command: command, raw_output: OK_FOR_TWO, ran_tests: 2, result_marker: 'OK', artifacts: artifacts,
      bytecode_scope: scope
    }),
    review: reviewOk({
      independent_test_command: command, independent_test_output: OK_FOR_TWO, artifacts_after: artifacts,
      bytecode_scope: scope
    })
  };
}

function codingFor(rel, entries) {
  return {
    files_created: [{ path: rel + '/mod.py', purpose: '实现' }],
    implementation_summary: '实现 add',
    acceptance_criteria_addressed: ['AC-01'],
    test_command: canonicalFor(rel),
    test_succeeded: true,
    test_exit_code: '0',
    test_output_excerpt: OK_FOR_TWO,
    deviations_from_requirement: [],
    requirement_conflicts: [],
    report_file: 'docs/evidence/test/coding-report.json',
    // Coding 阶段不执行测试命令，前后清单都应等于启动前基线。
    bytecode_scope: scopeOf(rel, entries || [], entries || []),
    generated_at: '2026-10-16T12:00:00+08:00'
  };
}

/** 场景计划：预检夹具换成真实存在的临时交付目录。 */
function planFor(rel, over, entries) {
  return happyPlan(Object.assign({
    preflight: function () { return preflightFor(rel); },
    coding: function () { return codingFor(rel, entries); }
  }, over || {}));
}

function taskArgs(rel, entries) {
  return baseArgs({
    task: { targetDir: rel, moduleFile: 'mod.py', testFile: 'test_mod.py', maxCodingAttempts: 1,
      cacheBaseline: entries || [] }
  });
}

// ---------------------------------------------------------------- 1. 基线：环境确实到达子进程

const envProbeRel = prepareDelivery('env-probe');
const envProbeWithPrefix = probeEnvViaFile(envProbeRel, true);
const envProbeWithoutPrefix = probeEnvViaFile(envProbeRel, false);
const envProbeEvidence = evidenceFor(envProbeRel, canonicalFor(envProbeRel), scopeOf(envProbeRel, [], []));

await scenario('受控环境前缀真的进入 python 子进程 → OK',
  planFor(envProbeRel, {
    verify: function () { return envProbeEvidence.verify; },
    review: function () { return envProbeEvidence.review; }
  }),
  taskArgs(envProbeRel),
  {
    status: 'OK', ok: true, attempts: 1, calls: 5,
    extra: function (result, outcome, expectCheck) {
      expectCheck('带前缀时子进程读到 ' + ENV_VAR + '=1', envProbeWithPrefix.value === '1',
        JSON.stringify(envProbeWithPrefix));
      expectCheck('不带前缀时子进程读不到该变量（不是靠继承）', envProbeWithoutPrefix.value === '<unset>',
        JSON.stringify(envProbeWithoutPrefix));
    }
  });

// 未设置环境的基线：真的会写出 __pycache__（后面"已存在缓存"场景用它构造前置状态）。
const dirtyRel = prepareDelivery('dirty-baseline');
const dirtyExit = runExitCode(canonicalFor(dirtyRel));
const dirtyEntries = cacheEntries(dirtyRel);

// A. 干净目录 + 受控环境前缀 → 不产生缓存，编排层判 OK（不得误拒）
const cleanRel = prepareDelivery('clean-prefixed');
const cleanBefore = cacheEntries(cleanRel);
const cleanCommand = ENV_PREFIX + canonicalFor(cleanRel);
const cleanExit = runExitCode(cleanCommand);
const cleanAfter = cacheEntries(cleanRel);
const cleanEvidence = evidenceFor(cleanRel, cleanCommand, scopeOf(cleanRel, cleanBefore, cleanAfter));

await scenario('干净目录用受控环境前缀运行规范命令 → 无新缓存且 OK',
  planFor(cleanRel, {
    verify: function () { return cleanEvidence.verify; },
    review: function () { return cleanEvidence.review; }
  }),
  taskArgs(cleanRel),
  {
    status: 'OK', ok: true, attempts: 1, calls: 5,
    extra: function (result, outcome, expectCheck) {
      expectCheck('带前缀的规范命令退出码 0', cleanExit === 0, '实际 ' + cleanExit);
      expectCheck('执行后 __pycache__ 不存在（无新缓存）', cleanAfter.length === 0, JSON.stringify(cleanAfter));
      expectCheck('finalDecision.bytecodeScopeOk 为 true',
        result.finalDecision && result.finalDecision.bytecodeScopeOk === true, JSON.stringify(result.finalDecision));
      expectCheck('返回值记录执行环境', result.testEnvironment && result.testEnvironment.variable === ENV_VAR,
        JSON.stringify(result.testEnvironment));
      expectCheck('返回值记录实际执行命令', typeof result.testExecutionCommand === 'string' &&
        result.testExecutionCommand.indexOf(ENV_PREFIX) === 0, String(result.testExecutionCommand));
    }
  });

// B. 已存在缓存 + 带前缀 → 缓存不被重写（bytes / mtime_ms / sha256 全不变）
const rewriteBefore = cacheEntries(dirtyRel);
const rewriteCommand = ENV_PREFIX + canonicalFor(dirtyRel);
const rewriteExit = runExitCode(rewriteCommand);
const rewriteAfter = cacheEntries(dirtyRel);
const rewriteEvidence = evidenceFor(dirtyRel, rewriteCommand, scopeOf(dirtyRel, rewriteBefore, rewriteAfter));

await scenario('已存在缓存用受控环境前缀运行 → 缓存不被重写且 OK',
  planFor(dirtyRel, {
    verify: function () { return rewriteEvidence.verify; },
    review: function () { return rewriteEvidence.review; }
  }, rewriteBefore),
  taskArgs(dirtyRel, rewriteBefore),
  {
    status: 'OK', ok: true, attempts: 1, calls: 5,
    extra: function (result, outcome, expectCheck) {
      expectCheck('基线用未设置环境的命令确实建出了缓存', dirtyExit === 0 && dirtyEntries.length > 0,
        'exit=' + dirtyExit + ' entries=' + JSON.stringify(dirtyEntries));
      expectCheck('带前缀重跑退出码 0', rewriteExit === 0, '实际 ' + rewriteExit);
      expectCheck('缓存清单（bytes/mtime/sha256）逐字段未变',
        JSON.stringify(rewriteBefore) === JSON.stringify(rewriteAfter),
        JSON.stringify({ before: rewriteBefore, after: rewriteAfter }));
    }
  });

// C. 报告自述"环境已设置"但真实运行仍写出缓存 → 运行期写入边界必须拒绝
const writeRel = prepareDelivery('write-unprefixed');
const writeBefore = cacheEntries(writeRel);
const writeCommand = canonicalFor(writeRel);
const writeExit = runExitCode(writeCommand);
const writeAfter = cacheEntries(writeRel);
// 这里故意让报告自述 env_applied=true：子代理声称加了前缀，文件指纹却证明缓存被写出。
const writeEvidence = evidenceFor(writeRel, writeCommand,
  scopeOf(writeRel, writeBefore, writeAfter, { env_applied: true }));

await scenario('未设置环境的真实运行新生成了 __pycache__ → BYTECODE_CACHE_WRITTEN（不得 ok）',
  planFor(writeRel, {
    verify: function () { return writeEvidence.verify; },
    review: function () { return writeEvidence.review; }
  }, writeBefore),
  taskArgs(writeRel, writeBefore),
  {
    status: 'BYTECODE_CACHE_WRITTEN', ok: false, attempts: 1, calls: 5, errorIncludes: '运行期写入边界',
    extra: function (result, outcome, expectCheck) {
      expectCheck('未设置环境的命令确实写入了缓存', writeExit === 0 && writeAfter.length > writeBefore.length,
        'exit=' + writeExit + ' before=' + writeBefore.length + ' after=' + writeAfter.length);
      expectCheck('finalDecision.bytecodeScopeStatus 为写入',
        result.finalDecision && result.finalDecision.bytecodeScopeStatus === 'BYTECODE_CACHE_WRITTEN',
        JSON.stringify(result.finalDecision));
    }
  });

// D. 报告 env_applied=false → 明确判"环境未应用"（不能因为没看见缓存就放过）
const unsetRel = prepareDelivery('env-reported-not-applied');
const unsetEvidence = evidenceFor(unsetRel, ENV_PREFIX + canonicalFor(unsetRel),
  scopeOf(unsetRel, [], [], { env_applied: false }));

await scenario('报告 env_applied=false（环境未到达测试进程）→ BYTECODE_ENV_NOT_APPLIED（不得 ok）',
  planFor(unsetRel, {
    verify: function () { return unsetEvidence.verify; },
    review: function () { return unsetEvidence.review; }
  }),
  taskArgs(unsetRel),
  { status: 'BYTECODE_ENV_NOT_APPLIED', ok: false, attempts: 1, calls: 5, errorIncludes: 'PYTHONDONTWRITEBYTECODE' });

// E. 完全没有交回运行期边界证据 → 判"证据不完整"（不能当成"没有写入"）
const missingRel = prepareDelivery('scope-missing');
const missingEvidence = evidenceFor(missingRel, ENV_PREFIX + canonicalFor(missingRel), scopeOf(missingRel, [], []));
delete missingEvidence.verify.bytecode_scope;
delete missingEvidence.review.bytecode_scope;

await scenario('两阶段都没有交回 bytecode_scope → BYTECODE_SCOPE_UNMEASURED（不得 ok）',
  planFor(missingRel, {
    verify: function () { return missingEvidence.verify; },
    review: function () { return missingEvidence.review; }
  }),
  taskArgs(missingRel),
  { status: 'BYTECODE_SCOPE_UNMEASURED', ok: false, attempts: 1, calls: 5, errorIncludes: '证据不完整' });

runner.finish('运行期写入边界集成测试（真实 python 子进程）');
