// tests/preflight-script.test.mjs
//
// 执行前校验工具（tests/preflight-workflow-script.mjs）的离线测试：0 次真实模型调用。
//
// 为什么必须有它：v0.3-run3 内联脚本漏掉 `REVIEW_SCHEMA.properties.issues.items.type`，
// 宿主在第 5 次调用前拒绝，前 4 次付费调用白花。这里的每个场景都要求"在 0 次调用时发现问题"。
//
// 覆盖（对应 m11670 §2、§3）：
//   1. 逐字节相同 → 通过；
//   2. 只多一个末尾换行 → 按唯一规范化规则通过，同时保留原始与规范化哈希；
//   3. Review schema 缺 type → 判不通过，并指出 `requires type or oneOf`；
//   4. 判定代码改动 → 字节不一致，不通过（不做"语义等价"豁免）；
//   5. 脚本漏行 → 不通过；
//   6. 只改注释 → 不通过；
//   7. CRLF 换行 → 不通过（唯一允许的规范化只针对末尾换行）；
//   8. 纯函数层面：schema 校验器本身能抓出缺 type（与字节比对解耦）；
//   9. 缺少必填参数 → 退出码 4。
//
// 运行：node tests/preflight-script.test.mjs

import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseArgs, runSource } from './workflow-harness.mjs';
import { schemaViolations, readSourceAtCommit } from './preflight-workflow-script.mjs';
import { twoAttemptPlan } from './script-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const TOOL = path.join(REPO_ROOT, 'tests', 'preflight-workflow-script.mjs');
const REPO_FILE = 'workflows/three-agent-mvp.js';
const WORK = path.join(REPO_ROOT, 'tests', '.scratch', 'preflight-cases');

let checksPassed = 0;
const failures = [];
const scenarios = [];

function check(condition, label, detail) {
  if (condition) { checksPassed += 1; } else {
    failures.push(label + ' :: ' + (detail === undefined ? '断言失败' : String(detail)));
  }
  return condition;
}

async function scenario(title, body) {
  const before = failures.length;
  try { await body(); } catch (error) {
    failures.push(title + ' :: 抛出异常 ' + (error && error.message ? error.message : String(error)));
  }
  scenarios.push({ title: title, status: failures.length === before ? 'PASS' : 'FAIL' });
}

let outputCounter = 0;

/**
 * 跑一次工具。沙箱不允许管道捕获子进程输出，所以把 stdout 重定向到文件再读回。
 */
function runTool(args) {
  outputCounter += 1;
  const outFile = path.join(WORK, 'tool-out-' + outputCounter + '.txt');
  const errFile = path.join(WORK, 'tool-err-' + outputCounter + '.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [TOOL].concat(args), { cwd: REPO_ROOT, stdio: ['ignore', outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status: result.status,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8')
  };
}

/** 解析工具 `--json` 输出（纯 JSON，无其它行）。 */
function runJson(args) {
  const outcome = runTool(args.concat(['--json']));
  let report = null;
  try { report = JSON.parse(outcome.stdout); } catch (error) {
    throw new Error('工具输出不是 JSON：' + outcome.stdout.slice(0, 400));
  }
  return { status: outcome.status, report: report };
}

function payload(name, buffer) {
  const file = path.join(WORK, name);
  writeFileSync(file, buffer);
  return file;
}

function mutate(text, search, replacement) {
  const index = text.indexOf(search);
  if (index === -1) { throw new Error('变异锚点没有找到：' + JSON.stringify(search.slice(0, 60))); }
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}

// ------------------------------------------------------------------ 基线

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const pinned = readSourceAtCommit(REPO_ROOT, 'HEAD', REPO_FILE);
const BASE = pinned.bytes.toString('utf8');
const COMMIT = pinned.commit;
const COMMON = ['--commit', COMMIT, '--repo-file', REPO_FILE];

// ------------------------------------------------------------------ 场景

await scenario('逐字节相同的载荷：通过，且确认为 0 次真实调用', function () {
  const file = payload('identical.js', pinned.bytes);
  const outcome = runJson(['--payload', file].concat(COMMON));
  check(outcome.status === 0, '退出码应为 0', outcome.status);
  check(outcome.report.verdict === 'PASS', 'verdict 应为 PASS', outcome.report.verdict);
  check(outcome.report.comparison.rawIdentical === true, '应判逐字节相同', JSON.stringify(outcome.report.comparison));
  check(outcome.report.comparison.normalizedIdentical === true, '规范化后也应相同', null);
  check(outcome.report.payload.sha256Raw === outcome.report.source.sha256Raw, '原始哈希应相同', null);
  check(outcome.report.schemas.allValid === true, '5 个 schema 应全部合法', JSON.stringify(outcome.report.schemas.invalid));
  check(outcome.report.schemas.distinct === 5, '应检查 5 个不同 schema', outcome.report.schemas.distinct);
  check(outcome.report.schemas.capturedCalls === 8, '模拟运行应采集 8 次调用的 schema', outcome.report.schemas.capturedCalls);
  check(outcome.report.hostCapabilities.agentCalls.real === 0, '真实模型调用应为 0', JSON.stringify(outcome.report.hostCapabilities.agentCalls));
  check(outcome.report.hostCapabilities.machineScriptTransfer === 'unsupported-by-tool-schema',
    '应如实记录宿主没有文件传递路径', outcome.report.hostCapabilities.machineScriptTransfer);
  check(outcome.report.hostCapabilities.zeroCallSchemaValidation === 'unavailable',
    '应如实记录宿主没有零调用 schema 校验接口', outcome.report.hostCapabilities.zeroCallSchemaValidation);
});

await scenario('只多一个末尾换行：按唯一规范化规则通过，原始哈希仍不同', function () {
  const file = payload('trailing.js', pinned.bytes.toString('utf8') + '\n');
  const outcome = runJson(['--payload', file].concat(COMMON));
  check(outcome.status === 0, '退出码应为 0', outcome.status);
  check(outcome.report.comparison.rawIdentical === false, '原始字节应不同', null);
  check(outcome.report.comparison.normalizedIdentical === true, '规范化后应相同', JSON.stringify(outcome.report.comparison));
  check(outcome.report.payload.sha256Raw !== outcome.report.source.sha256Raw, '原始哈希应不同', null);
  check(outcome.report.payload.sha256Normalized === outcome.report.source.sha256Normalized, '规范化哈希应相同', null);
  check(outcome.report.payload.trailingNewlines === outcome.report.source.trailingNewlines + 1,
    '末尾换行数应相差 1', outcome.report.payload.trailingNewlines + ' vs ' + outcome.report.source.trailingNewlines);
  check(outcome.report.comparison.byteDelta === 1, '字节差应为 1', outcome.report.comparison.byteDelta);
});

await scenario('Review schema 缺 type：判不通过并指出 requires type or oneOf', function () {
  const broken = mutate(BASE,
    "        type: 'object',\n        additionalProperties: false,\n        required: ['file', 'problem', 'suggestion'],",
    "        additionalProperties: false,\n        required: ['file', 'problem', 'suggestion'],");
  const file = payload('missing-type.js', broken);
  const outcome = runJson(['--payload', file].concat(COMMON));
  check(outcome.status === 12, '字节不一致且 schema 不合法应退出 12', outcome.status);
  check(outcome.report.verdict === 'MISMATCH_AND_SCHEMA_INVALID', 'verdict 应指出两者都不合格', outcome.report.verdict);
  check(outcome.report.schemas.allValid === false, 'schema 应判不合法', JSON.stringify(outcome.report.schemas.invalid));
  check(outcome.report.schemas.invalid.indexOf('Review Agent') !== -1, '应点名 Review Agent', JSON.stringify(outcome.report.schemas.invalid));
  const review = outcome.report.schemas.checked.filter(function (item) { return item.labels.indexOf('Review Agent') !== -1; })[0];
  const text = review === undefined ? '' : review.violations.join(' | ');
  check(text.indexOf('requires type or oneOf') !== -1, '违规信息应含 requires type or oneOf', text);
  check(text.indexOf('issues') !== -1, '违规信息应指向 issues', text);
});

await scenario('判定代码改动：字节不一致即不通过（不做语义等价豁免）', function () {
  const changed = mutate(BASE, 'if (!decision.ok) {', 'if (decision.ok === false) {');
  const file = payload('logic-change.js', changed);
  const outcome = runJson(['--payload', file].concat(COMMON));
  check(outcome.status === 10, '应退出 10', outcome.status);
  check(outcome.report.verdict === 'MISMATCH', 'verdict 应为 MISMATCH', outcome.report.verdict);
  check(outcome.report.schemas.allValid === true, 'schema 仍合法（问题在字节）', JSON.stringify(outcome.report.schemas.invalid));
  check(outcome.report.comparison.firstDifference !== null, '应给出首个差异位置', JSON.stringify(outcome.report.comparison.firstDifference));
});

await scenario('脚本漏行：不通过', function () {
  const dropped = mutate(BASE, "  log('step 5/5: Review Agent' + revTag + ' -> ' + artifact(attempt, 'review'));\n", '');
  const file = payload('missing-line.js', dropped);
  const outcome = runJson(['--payload', file].concat(COMMON));
  check(outcome.status === 10, '应退出 10', outcome.status);
  check(outcome.report.comparison.byteDelta < 0, '字节数应减少', outcome.report.comparison.byteDelta);
});

await scenario('只改注释：不通过', function () {
  const commented = mutate(BASE, '// ================================================================ 编排',
    '// ================================================================ 编排（注释改动）');
  const file = payload('comment-change.js', commented);
  const outcome = runJson(['--payload', file].concat(COMMON));
  check(outcome.status === 10, '应退出 10', outcome.status);
  check(outcome.report.comparison.rawIdentical === false, '原始字节应不同', null);
  check(outcome.report.comparison.normalizedIdentical === false, '规范化后也应不同', null);
});

await scenario('CRLF 换行：不通过', function () {
  const crlf = payload('crlf.js', BASE.replace(/\n/g, '\r\n'));
  const outcome = runJson(['--payload', crlf].concat(COMMON));
  check(outcome.status === 10, '应退出 10', outcome.status);
  check(outcome.report.comparison.normalizedIdentical === false, '换行风格变化不在规范化规则内', null);
});

await scenario('纯函数：schema 校验器能抓出缺 type（与字节比对解耦）', async function () {
  const captured = [];
  await runSource(BASE, twoAttemptPlan(), baseArgs({ task: { maxAgentCalls: 8 } }), { capture: captured });
  const reviewCall = captured.filter(function (item) { return item.label === 'Review Agent'; })[0];
  check(reviewCall !== undefined, '应采集到 Review 的 schema', captured.map(function (item) { return item.label; }).join(','));
  const brokenSchema = JSON.parse(JSON.stringify(reviewCall.schema));
  delete brokenSchema.properties.issues.items.type;
  const violations = schemaViolations(brokenSchema, 'schema');
  check(violations.some(function (line) { return line.indexOf('schema.properties.issues.items.required requires type or oneOf') !== -1; }),
    '应报出 required requires type or oneOf', violations.join(' | '));
  check(violations.some(function (line) { return line.indexOf('schema.properties.issues.items.additionalProperties requires type or oneOf') !== -1; }),
    '应报出 additionalProperties requires type or oneOf', violations.join(' | '));
  check(violations.some(function (line) { return line.indexOf('schema.properties.issues.items.properties requires type or oneOf') !== -1; }),
    '应报出 properties requires type or oneOf', violations.join(' | '));
  const clean = schemaViolations(reviewCall.schema, 'schema');
  check(clean.length === 0, '未改动的 Review schema 应无违规', clean.join(' | '));
});

await scenario('缺少必填参数：退出码 4', function () {
  const outcome = runTool(['--payload', path.join(WORK, 'identical.js')]);
  check(outcome.status === 4, '缺 --commit 应退出 4', outcome.status);
  check((outcome.stdout + outcome.stderr).indexOf('--commit') !== -1, '提示里应指出缺少 --commit', (outcome.stdout + outcome.stderr).slice(0, 200));
});

// ------------------------------------------------------------------ 收尾

// 工具输出文件是测试自身的中间产物，跑完清掉；payload 文件保留在 .scratch 便于人工复核。
for (let index = 1; index <= outputCounter; index += 1) {
  try { rmSync(path.join(WORK, 'tool-out-' + index + '.txt'), { force: true }); } catch (error) { /* 清理失败不影响结论 */ }
}

console.log('执行前校验工具测试（tests/preflight-workflow-script.mjs）');
console.log('固定提交：' + COMMIT);
console.log('');
scenarios.forEach(function (item) {
  console.log((item.status === 'PASS' ? 'PASS' : 'FAIL') + '  ' + item.title);
  failures.filter(function (line) { return line.indexOf(item.title + ' ::') === 0; })
    .forEach(function (line) { console.log('       - ' + line); });
});
console.log('');
if (failures.length > 0) {
  console.log('结果：' + scenarios.filter(function (item) { return item.status === 'PASS'; }).length + '/' + scenarios.length +
    ' 场景，' + checksPassed + '/' + (checksPassed + failures.length) + ' 断言');
  process.exit(1);
}
console.log('结果：' + scenarios.length + '/' + scenarios.length + ' 场景，' + checksPassed + ' 项断言全部通过');
