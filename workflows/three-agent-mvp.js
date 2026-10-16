/**
 * TLA V0.1 — three-agent MVP workflow: Requirement -> Coding -> Review.
 *
 * 由 DSH 的 `workflow` 工具执行的 JavaScript 编排脚本（本文件内容即 tool 的 `script` 参数）。
 * 角色提示词存放在 `agents/*.md`，脚本不复制提示词，而是要求每个子代理先读取自己的角色文件。
 *
 * 真实子代理调用（每一次都是独立上下文、独立执行实例）：
 *   1. Verifier（MODE=preflight）  环境预检：证据目录未被占用、路径落在仓库内、提示词文件齐全
 *   2. Requirement Agent           结构化需求 + 验收/边界条件一致性自检
 *   3. Coding Agent                在交付目录内实现代码与测试，并真实运行测试
 *   4. Verifier（MODE=verify）     独立复跑规范化测试命令，回传原始输出与文件哈希
 *   5. Review Agent                独立上下文读代码、独立复跑测试、逐条判定验收条件
 *   6.. 修订轮重复 3/4/5，直到通过或达到 maxCodingAttempts
 *
 * 执行顺序与结果传递由本脚本的编排逻辑保证（顺序 await + 上一阶段结构化结果原样注入）；
 * `phase()` 只用于进度展示，不产生执行依赖（见 2026-10-16 架构审核意见四）。
 *
 * 成功判定（本脚本的计算逻辑，不依赖任何单个 Agent 的自述；见审核意见一）：
 *   ok = true 当且仅当全部成立：
 *     A. 需求自检未报告冲突（consistency_check.conflicts 为空）；
 *     B. Coding Agent 自述测试通过（test_succeeded === true）；
 *     C. Verifier 回传的**原始输出**经本脚本解析为通过（退出码 0、`Ran N tests`、`OK` 标记、无 FAILED）；
 *     D. Review 结论为 APPROVED，且其**自己的**复跑结果也通过；
 *     E. Review 的 criteria_check 覆盖全部验收条件且逐条 satisfied === true。
 *   任一环节自述与外部证据矛盾 → 判定不通过（status = INCONSISTENT_EVIDENCE），进入修订流程，绝不放行。
 *
 * args 契约（全部可选，缺省即运行仓库内置的演示任务）：
 * {
 *   "runId": "v0.1-second-run",
 *   "evidenceDir": "docs/evidence/v0.1-second-run",
 *   "promptDir": "agents",
 *   "runStartedAt": "2026-10-16T19:40:00+08:00",
 *   "task": {
 *     "requirement": "<自然语言需求>",
 *     "targetDir": "examples/text-stats",
 *     "moduleFile": "text_stats.py",
 *     "testFile": "test_text_stats.py",
 *     "sampleFile": "sample_input.txt",
 *     "testCommand": "python -m unittest discover -s examples/text-stats -p \"test_*.py\"",
 *     "maxCodingAttempts": 2
 *   }
 * }
 *
 * 返回值：结构化运行结果（ok / status / 各阶段结构化输出 / 逐轮判定与原因），供编排代理归档与核验。
 */

// ================================================================ 参数解析与校验
// 纯函数区：不调用 agent()，由 tests/workflow-logic.test.mjs 用模拟返回值覆盖。

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PY_MODULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*\.py$/;
const PY_TEST_PATTERN = /^test_[A-Za-z0-9_-]*\.py$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TEST_COMMAND_PATTERN = /^python3? -m unittest discover -s [A-Za-z0-9._/-]+ -p "[A-Za-z0-9._*?-]+"( -v)?$/;
const MAX_ATTEMPTS_LIMIT = 5;
const EVIDENCE_ROOT = 'docs/evidence/';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function hasText(v) { return typeof v === 'string' && v.trim().length > 0; }
function hasItems(v) { return Array.isArray(v) && v.length > 0; }
function isInteger(v) { return typeof v === 'number' && Number.isInteger(v); }
function asString(v) { return typeof v === 'string' ? v.trim() : ''; }

/**
 * 相对路径安全校验：拒绝绝对路径、盘符、`..`、反斜杠、空段与首尾空白。
 * 返回归一化（去掉尾部 `/`）的路径；不合法时返回 null。
 */
function normalizeRelPath(raw) {
  const value = asString(raw);
  if (value === '') { return null; }
  if (value.indexOf('\\') !== -1) { return null; }
  if (value.charAt(0) === '/') { return null; }
  if (/^[A-Za-z]:/.test(value)) { return null; }
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed === '') { return null; }
  const segments = trimmed.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === '' || segment === '.' || segment === '..') { return null; }
  }
  return trimmed;
}

/** 文件名必须是纯 basename（不含任何路径分隔符），避免越出交付目录。 */
function normalizeBasename(raw) {
  const value = asString(raw);
  if (value === '' || value === '.' || value === '..') { return null; }
  if (value.indexOf('/') !== -1 || value.indexOf('\\') !== -1) { return null; }
  if (!BASENAME_PATTERN.test(value)) { return null; }
  return value;
}

function canonicalTestCommand(targetDir) {
  return 'python -m unittest discover -s ' + targetDir + ' -p "test_*.py"';
}

/** 测试命令只允许"规范化命令"本身（可带 -v），不接受来自参数的任何任意 shell 命令。 */
function isAllowedTestCommand(command, canonical) {
  const value = asString(command);
  if (value === '') { return false; }
  if (!TEST_COMMAND_PATTERN.test(value)) { return false; }
  return value === canonical || value === canonical + ' -v';
}

/**
 * 校验并归一化运行参数。任何不合法输入都返回结构化错误，不抛异常、不产生空对象访问。
 */
function validateRunConfig(rawArgs) {
  const errors = [];
  if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs)) {
    return { ok: false, errors: ['args 必须是 JSON 对象，实际为 ' + typeof rawArgs], config: null };
  }
  const cfg = isObject(rawArgs) ? rawArgs : {};

  // runId 必填，不提供默认值：默认值会指向已归档的运行目录，存在覆盖历史证据的风险。
  const runId = asString(cfg.runId);
  if (!RUN_ID_PATTERN.test(runId)) {
    errors.push('runId 非法（只允许字母/数字/._-，长度 1-64，且不得以 . - _ 开头）：' + JSON.stringify(cfg.runId));
  }

  const evidenceDirRaw = cfg.evidenceDir === undefined ? EVIDENCE_ROOT + runId : cfg.evidenceDir;
  const evidenceDir = normalizeRelPath(evidenceDirRaw);
  if (evidenceDir === null) {
    errors.push('evidenceDir 非法（必须是仓库内相对路径，禁止绝对路径/盘符/`..`/反斜杠）：' + JSON.stringify(evidenceDirRaw));
  } else if (evidenceDir.indexOf(EVIDENCE_ROOT) !== 0) {
    errors.push('evidenceDir 必须位于 ' + EVIDENCE_ROOT + ' 之下：' + evidenceDir);
  } else if (evidenceDir.split('/').pop() !== runId) {
    errors.push('evidenceDir 的最后一级目录必须等于 runId（防止证据归档到别的运行目录）：' + evidenceDir + ' vs ' + runId);
  }

  const promptDirRaw = cfg.promptDir === undefined ? 'agents' : cfg.promptDir;
  const promptDir = normalizeRelPath(promptDirRaw);
  if (promptDir === null) {
    errors.push('promptDir 非法（必须是仓库内相对路径）：' + JSON.stringify(promptDirRaw));
  }

  const taskInput = cfg.task === undefined ? {} : cfg.task;
  let taskIsObject = true;
  if (!isObject(taskInput)) {
    taskIsObject = false;
    errors.push('task 必须是 JSON 对象，实际为 ' + (Array.isArray(taskInput) ? 'array' : typeof taskInput));
  }
  const task = taskIsObject ? taskInput : {};

  const targetDirRaw = task.targetDir === undefined ? 'examples/text-stats' : task.targetDir;
  const targetDir = normalizeRelPath(targetDirRaw);
  if (targetDir === null) {
    errors.push('targetDir 非法（必须是仓库内相对路径，禁止绝对路径/盘符/`..`/反斜杠）：' + JSON.stringify(targetDirRaw));
  }

  const moduleFile = task.moduleFile === undefined ? 'text_stats.py' : normalizeBasename(task.moduleFile);
  if (moduleFile === null || !PY_MODULE_PATTERN.test(moduleFile)) {
    errors.push('moduleFile 非法（必须是单层文件名且形如 x.py）：' + JSON.stringify(task.moduleFile));
  }

  const testFile = task.testFile === undefined ? 'test_text_stats.py' : normalizeBasename(task.testFile);
  if (testFile === null || !PY_TEST_PATTERN.test(testFile)) {
    errors.push('testFile 非法（必须是单层文件名且形如 test_x.py）：' + JSON.stringify(task.testFile));
  }

  const sampleFile = task.sampleFile === undefined ? 'sample_input.txt' : normalizeBasename(task.sampleFile);
  if (sampleFile === null) {
    errors.push('sampleFile 非法（必须是单层文件名）：' + JSON.stringify(task.sampleFile));
  }

  const canonicalCommand = targetDir === null ? null : canonicalTestCommand(targetDir);
  const testCommandRaw = task.testCommand === undefined ? canonicalCommand : asString(task.testCommand);
  if (canonicalCommand === null || !isAllowedTestCommand(testCommandRaw, canonicalCommand)) {
    errors.push('testCommand 被拒绝：只允许规范化命令 ' + JSON.stringify(canonicalCommand) +
      '（可带 -v），不接受任意 shell 命令。实际为 ' + JSON.stringify(task.testCommand));
  }

  let maxCodingAttempts = 2;
  if (task.maxCodingAttempts !== undefined) {
    if (!isInteger(task.maxCodingAttempts) || task.maxCodingAttempts < 1 || task.maxCodingAttempts > MAX_ATTEMPTS_LIMIT) {
      errors.push('maxCodingAttempts 非法（必须是 1..' + MAX_ATTEMPTS_LIMIT + ' 的整数）：' +
        JSON.stringify(task.maxCodingAttempts));
    } else {
      maxCodingAttempts = task.maxCodingAttempts;
    }
  }

  let runStartedAt = null;
  if (cfg.runStartedAt !== undefined) {
    const value = asString(cfg.runStartedAt);
    if (ISO_TIME_PATTERN.test(value)) { runStartedAt = value; }
    else { errors.push('runStartedAt 非法（必须是带时区的 ISO-8601 时间）：' + JSON.stringify(cfg.runStartedAt)); }
  }

  let requirementInput = null;
  if (task.requirement !== undefined) {
    if (typeof task.requirement !== 'string' || task.requirement.trim() === '') {
      errors.push('task.requirement 非法（必须是非空字符串）：' + JSON.stringify(task.requirement));
    } else {
      requirementInput = task.requirement.trim();
    }
  }

  const config = {
    runId: runId,
    evidenceDir: evidenceDir,
    promptDir: promptDir,
    requirementInput: requirementInput,
    targetDir: targetDir,
    moduleFile: moduleFile,
    testFile: testFile,
    sampleFile: sampleFile,
    testCommand: canonicalCommand,
    maxCodingAttempts: maxCodingAttempts,
    runStartedAt: runStartedAt
  };

  if (errors.length > 0) { return { ok: false, errors: errors, config: config }; }
  return { ok: true, errors: [], config: config };
}

// ================================================================ 证据判定（纯函数）

/**
 * 解析 `unittest` 的真实输出文本（Verifier/Review 回传的原始输出）。
 * 只认文本里的硬事实，不采信任何布尔自述。
 */
function parseUnittestOutput(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const ranMatch = /Ran (\d+) tests? in /.exec(text);
  const failedMatch = /(^|\n)FAILED[^\n]*/.exec(text);
  const okMatch = /(^|\n)OK( \([^\n]*\))?(\n|$)/.exec(text);
  return {
    ran: ranMatch ? parseInt(ranMatch[1], 10) : null,
    failedMarker: failedMatch ? failedMatch[0].trim() : null,
    okMarker: okMatch ? true : false,
    textPresent: text.trim().length > 0
  };
}

/** 判定 Verifier 独立复跑证据是否成立（命令必须是我们批准的那条）。 */
function judgeTestEvidence(evidence, canonicalCommand) {
  const reasons = [];
  if (!isObject(evidence)) { return { passed: false, reasons: ['Verifier 未返回结构化证据（子代理失败或输出不完整）'], parsed: null }; }
  const command = asString(evidence.command);
  if (command !== canonicalCommand) {
    reasons.push('Verifier 执行的不是规范化测试命令：' + JSON.stringify(command) + '，期望 ' + JSON.stringify(canonicalCommand));
  }
  const exitCode = asString(evidence.exit_code);
  if (exitCode !== '0') { reasons.push('Verifier 报告的退出码非 0：' + JSON.stringify(evidence.exit_code)); }
  const parsed = parseUnittestOutput(evidence.raw_output);
  if (!parsed.textPresent) { reasons.push('Verifier 未回传原始测试输出（不接受口头结论）'); }
  if (parsed.failedMarker) { reasons.push('原始输出含失败标记：' + parsed.failedMarker); }
  if (parsed.ran === null) { reasons.push('原始输出中没有 `Ran N tests` 行，无法确认测试真实执行'); }
  else if (parsed.ran < 1) { reasons.push('原始输出显示执行的用例数为 0'); }
  if (!parsed.okMarker) { reasons.push('原始输出中没有 `OK` 标记'); }

  const declaredRan = evidence.ran_tests;
  if (isInteger(declaredRan) && parsed.ran !== null && declaredRan !== parsed.ran) {
    reasons.push('Verifier 自述用例数（' + declaredRan + '）与原始输出（' + parsed.ran + '）不一致');
  }
  const declaredMarker = asString(evidence.result_marker);
  if (declaredMarker !== '' && parsed.failedMarker && declaredMarker.toUpperCase() !== 'FAILED') {
    reasons.push('Verifier 自述 ' + declaredMarker + ' 与原始输出中的失败标记不一致');
  }
  if (declaredMarker !== '' && !parsed.failedMarker && declaredMarker.toUpperCase() !== 'OK') {
    reasons.push('Verifier 自述 ' + declaredMarker + ' 与原始输出中的 OK 标记不一致');
  }
  if (!hasItems(evidence.artifacts)) { reasons.push('Verifier 未回传被验证文件的哈希清单'); }

  return { passed: reasons.length === 0, reasons: reasons, parsed: parsed };
}

/** 判定 Review 结论与其自身证据、与需求的一致性（审核意见一.2 / 一.3）。 */
function judgeReviewConsistency(review, expectedCriteria, canonicalCommand) {
  const reasons = [];
  if (!isObject(review)) {
    return { approved: false, allSatisfied: false, coversAll: false, ownTestsPassed: false,
      criteriaTotal: 0, criteriaSatisfied: 0, reasons: ['Review Agent 未返回结构化结论'] };
  }
  const verdict = asString(review.verdict);
  const approved = verdict === 'APPROVED';
  if (!approved) { reasons.push('Review 结论为 ' + (verdict === '' ? '(空)' : verdict)); }

  const checks = Array.isArray(review.criteria_check) ? review.criteria_check : [];
  let satisfied = 0;
  for (let i = 0; i < checks.length; i += 1) {
    if (isObject(checks[i]) && checks[i].satisfied === true) { satisfied += 1; }
  }
  const allSatisfied = checks.length > 0 && satisfied === checks.length;
  if (!allSatisfied) {
    reasons.push('验收条件未全部满足：' + satisfied + '/' + checks.length +
      '（未满足项：' + checks.filter(function (c) { return !isObject(c) || c.satisfied !== true; })
        .map(function (c) { return isObject(c) ? asString(c.criterion) : '(非法项)'; }).join(' | ') + '）');
  }
  const expected = isInteger(expectedCriteria) ? expectedCriteria : null;
  const coversAll = expected !== null && checks.length >= expected;
  if (!coversAll) {
    reasons.push('criteria_check 覆盖不全：' + checks.length + ' 条，需求中有 ' + expected + ' 条验收条件');
  }

  const ownCommand = asString(review.independent_test_command);
  if (ownCommand !== canonicalCommand) {
    reasons.push('Review 的独立复跑命令不是规范化命令：' + JSON.stringify(ownCommand));
  }
  const ownParsed = parseUnittestOutput(review.independent_test_output);
  let ownTestsPassed = ownParsed.textPresent && ownParsed.ran !== null && !ownParsed.failedMarker && ownParsed.okMarker;
  if (!ownTestsPassed) {
    reasons.push('Review 的独立复跑证据不成立（' + (ownParsed.failedMarker ? '输出含 ' + ownParsed.failedMarker :
      '缺少 Ran/OK 标记或原始输出为空') + '）');
  }
  if (asString(review.independent_test_exit_code) !== '0') {
    ownTestsPassed = false;
    reasons.push('Review 自述的复跑退出码非 0：' + JSON.stringify(review.independent_test_exit_code));
  }

  return { approved: approved, allSatisfied: allSatisfied, coversAll: coversAll, ownTestsPassed: ownTestsPassed,
    criteriaTotal: checks.length, criteriaSatisfied: satisfied, reasons: reasons };
}

/**
 * 单轮判定：只有"测试真实通过 + 审核结论为通过且其证据一致"才算通过。
 * 返回 { ok, status, reasons, selfReportVsVerified }。
 */
function judgeAttempt(codingReport, verification, review, expectedCriteria, canonicalCommand, codingOutputValid) {
  const reasons = [];
  let status = 'OK';

  const verified = judgeTestEvidence(verification, canonicalCommand);
  if (!verified.passed) { reasons.push('外部独立验证未通过：' + verified.reasons.join('；')); }

  const reviewEval = judgeReviewConsistency(review, expectedCriteria, canonicalCommand);
  if (!reviewEval.approved || !reviewEval.allSatisfied || !reviewEval.coversAll || !reviewEval.ownTestsPassed) {
    reasons.push('审核结论不可用：' + reviewEval.reasons.join('；'));
  }

  const codingExit = isObject(codingReport) ? asString(codingReport.test_exit_code) : '';
  const selfReportVsVerified = {
    coding_claimed_success: isObject(codingReport) ? codingReport.test_succeeded === true : null,
    coding_claimed_exit_code: codingExit === '' ? null : codingExit,
    verification_exit_code: isObject(verification) ? asString(verification.exit_code) : null,
    verification_ok: verified.passed,
    agreement: (isObject(codingReport) ? codingReport.test_succeeded === true : false) === verified.passed
  };

  if (!codingOutputValid) {
    status = 'CODING_OUTPUT_INVALID';
    reasons.push('Coding Agent 未返回可用的实现报告（files_created 缺失或子代理失败）');
  } else if (!selfReportVsVerified.agreement) {
    status = 'INCONSISTENT_EVIDENCE';
    reasons.push('Coding Agent 自述（test_succeeded=' + JSON.stringify(selfReportVsVerified.coding_claimed_success) +
      '，exit=' + JSON.stringify(selfReportVsVerified.coding_claimed_exit_code) +
      '）与外部独立验证（' + (verified.passed ? '通过' : '未通过') + '，exit=' +
      JSON.stringify(selfReportVsVerified.verification_exit_code) + '）矛盾：自述不能当作验证结果');
  } else if (!verified.passed) {
    status = 'TEST_NOT_VERIFIED';
  } else if (isObject(codingReport) && codingReport.test_succeeded !== true) {
    status = 'CODING_SELF_REPORTED_FAILURE';
    reasons.push('Coding Agent 自述测试未通过（test_succeeded=' + JSON.stringify(codingReport.test_succeeded) + '）');
  } else if (!reviewEval.ownTestsPassed) {
    status = 'INCONSISTENT_REVIEW';
  } else if (!reviewEval.approved) {
    status = 'REVIEW_NOT_APPROVED';
  } else if (!reviewEval.allSatisfied) {
    status = 'CRITERIA_NOT_SATISFIED';
  } else if (!reviewEval.coversAll) {
    status = 'CRITERIA_CHECK_INCOMPLETE';
  }

  return { ok: status === 'OK', status: status, reasons: reasons, reviewEval: reviewEval,
    verified: verified, selfReportVsVerified: selfReportVsVerified };
}

/** 需求自检结果：出现冲突就必须停止，不得让 Coding Agent 自选一套解释（审核意见三）。 */
function judgeRequirementConsistency(requirement) {
  if (!isObject(requirement)) { return { ok: false, conflicts: ['Requirement Agent 未返回结构化需求'] }; }
  const check = requirement.consistency_check;
  if (!isObject(check) || check.self_checked !== true) {
    return { ok: false, conflicts: ['Requirement Agent 未完成验收条件与边界条件的一致性自检（consistency_check.self_checked != true）'] };
  }
  const conflicts = Array.isArray(check.conflicts) ? check.conflicts : [];
  if (conflicts.length > 0) {
    return { ok: false, conflicts: conflicts.map(function (c) {
      return isObject(c) ? (asString(c.refs) + ' ' + asString(c.description)).trim() : String(c);
    }) };
  }
  return { ok: true, conflicts: [] };
}

/** 时间戳真实性：必须是 ISO-8601 且在运行起始时间窗口内（防止占位时间冒充真实记录）。 */
function judgeTimestamp(value, runStartedAt, windowHours) {
  const text = asString(value);
  if (!ISO_TIME_PATTERN.test(text)) { return { ok: false, reason: '时间戳不是带时区的 ISO-8601：' + JSON.stringify(value) }; }
  if (!runStartedAt) { return { ok: true, reason: '' }; }
  const parse = typeof Date === 'function' && typeof Date.parse === 'function' ? Date.parse : null;
  if (parse === null) { return { ok: true, reason: '' }; }
  const started = parse(runStartedAt);
  const stamp = parse(text);
  if (isNaN(started) || isNaN(stamp)) { return { ok: true, reason: '' }; }
  const windowMs = (isInteger(windowHours) ? windowHours : 6) * 3600 * 1000;
  if (stamp < started - 60000 || stamp > started + windowMs) {
    return { ok: false, reason: '时间戳 ' + text + ' 不在运行窗口内（起始 ' + runStartedAt + '，窗口 ' + (windowMs / 3600000) + ' 小时）：疑似占位时间' };
  }
  return { ok: true, reason: '' };
}

/** 生成失败结果（所有提前退出都走这里，保证返回结构一致）。 */
function failure(status, error, extra) {
  const base = { ok: false, status: status, error: error };
  if (isObject(extra)) {
    Object.keys(extra).forEach(function (key) { base[key] = extra[key]; });
  }
  return base;
}

// ================================================================ 输出 Schema

const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repo_root', 'evidence_dir_state', 'prompt_files', 'target_dir', 'generated_at'],
  properties: {
    repo_root: { type: 'string' },
    evidence_dir_state: { type: 'string', enum: ['missing', 'empty', 'exists'] },
    evidence_dir_entries: { type: 'array', items: { type: 'string' } },
    prompt_files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'exists'],
        properties: { path: { type: 'string' }, exists: { type: 'boolean' } }
      }
    },
    target_dir: { type: 'string' },
    target_dir_state: { type: 'string', enum: ['present', 'missing'] },
    resolved_paths: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
    generated_at: { type: 'string' }
  }
};

const REQUIREMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'scope_in', 'scope_out', 'acceptance_criteria', 'boundary_conditions', 'consistency_check', 'generated_at'],
  properties: {
    goal: { type: 'string' },
    scope_in: { type: 'array', items: { type: 'string' } },
    scope_out: { type: 'array', items: { type: 'string' } },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    boundary_conditions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    consistency_check: {
      type: 'object',
      additionalProperties: false,
      required: ['self_checked', 'conflicts'],
      properties: {
        self_checked: { type: 'boolean' },
        conflicts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['refs', 'description'],
            properties: { refs: { type: 'string' }, description: { type: 'string' } }
          }
        },
        notes: { type: 'string' }
      }
    },
    generated_at: { type: 'string' }
  }
};

const CODING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_created', 'implementation_summary', 'test_command', 'test_succeeded', 'test_exit_code', 'test_output_excerpt', 'report_file', 'generated_at'],
  properties: {
    files_created: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'purpose'],
        properties: { path: { type: 'string' }, purpose: { type: 'string' } }
      }
    },
    implementation_summary: { type: 'string' },
    acceptance_criteria_addressed: { type: 'array', items: { type: 'string' } },
    test_command: { type: 'string' },
    test_succeeded: { type: 'boolean' },
    test_exit_code: { type: 'string' },
    test_output_excerpt: { type: 'string' },
    deviations_from_requirement: { type: 'array', items: { type: 'string' } },
    report_file: { type: 'string' },
    generated_at: { type: 'string' }
  }
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'exit_code', 'raw_output', 'ran_tests', 'result_marker', 'artifacts', 'generated_at'],
  properties: {
    command: { type: 'string' },
    exit_code: { type: 'string' },
    raw_output: { type: 'string' },
    ran_tests: { type: 'integer' },
    result_marker: { type: 'string', enum: ['OK', 'FAILED'] },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256'],
        properties: { path: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' } }
      }
    },
    notes: { type: 'string' },
    generated_at: { type: 'string' }
  }
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'criteria_check', 'issues', 'independent_test_command', 'independent_test_exit_code', 'independent_test_output', 'summary', 'report_file', 'generated_at'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] },
    criteria_check: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'satisfied', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          satisfied: { type: 'boolean' },
          evidence: { type: 'string' }
        }
      }
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'problem', 'suggestion'],
        properties: {
          file: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' }
        }
      }
    },
    independent_test_command: { type: 'string' },
    independent_test_exit_code: { type: 'string' },
    independent_test_output: { type: 'string' },
    consistency_note: { type: 'string' },
    summary: { type: 'string' },
    report_file: { type: 'string' },
    generated_at: { type: 'string' }
  }
};

// ================================================================ 提示词构建

function envelopeNote(artifactPath) {
  return [
    '### 你必须写入的产物文件',
    '- 产物文件路径: ' + artifactPath,
    '- JSON 信封字段：run_id / agent / stage / generated_at / result（result 内也要有同样的 generated_at）。',
    '- `generated_at` 必须是**你本次运行中真实取得**的时间：先执行命令取当前时间（例如 PowerShell `Get-Date -Format o`，或 python `datetime.now().astimezone().isoformat()`），',
    '  不得使用记忆里的、占位的或猜测的时间戳；本脚本会校验时间戳必须落在本次运行窗口内。'
  ].join('\n');
}

function preflightPrompt(artifactPath) {
  return [
    '你是 TLA 流水线中的 **Verifier Agent**，本次以 `MODE=preflight`（环境预检）执行，在独立上下文中工作。',
    '',
    '【第一步】完整读取你的角色规范文件：' + C.promptDir + '/verifier-agent.md，并逐条遵守。',
    '',
    '【第二步】只做只读检查，**不要创建、修改或删除任何文件**，并逐项报告事实：',
    '1. 当前工作目录（仓库根）的绝对路径，写入 `repo_root`。',
    '2. 证据目录 `' + C.evidenceDir + '` 的状态：不存在 → `missing`；存在且为空 → `empty`；存在且有内容 → `exists`，',
    '   并把已有条目名写入 `evidence_dir_entries`（这是"不得覆盖历史证据"的判定依据，必须如实报告）。',
    '3. 三个角色提示词文件是否存在：' + promptPaths.requirement + '、' + promptPaths.coding + '、' + promptPaths.review + '，写入 `prompt_files`。',
    '4. 交付目录 `' + C.targetDir + '` 是否存在（present/missing），以及它解析后的绝对路径。',
    '5. 把它能核实的绝对路径写入 `resolved_paths`（至少包含交付目录与证据目录的解析结果）。',
    '6. 任何与本次 run_id `' + C.runId + '` 冲突、或可能越出仓库目录的问题，写入 `problems`。',
    '',
    '【第三步】只报告你亲自核实的事实，不得推测；不得读取任何凭据文件、不得访问网络。',
    '返回结构化结果（见 schema），并写入产物文件：',
    envelopeNote(artifactPath)
  ].join('\n');
}

function requirementPrompt(artifactPath) {
  return [
    '你是 TLA 三 Agent 流水线中的第 1 个角色（Requirement Agent）。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.requirement + '，并逐条遵守。',
    '',
    '【第二步】处理下面的原始需求，产出结构化需求。',
    '',
    '### 原始需求（自然语言）',
    originalRequirement,
    '',
    '### 运行期参数',
    '- run_id: ' + C.runId,
    '- 证据目录: ' + C.evidenceDir,
    '- 交付目录（你不写代码，仅用于界定范围）: ' + C.targetDir,
    '- 依赖边界: ' + depsBoundary,
    '- 上一轮运行发现的需求缺陷（真实案例，必须避免重犯；不要照抄其中的错误断言）:',
    priorConflictNote,
    '',
    '【第三步】写完验收条件后，必须执行**一致性自检**（角色规范第 3.1 节）：',
    '- 逐条把 `acceptance_criteria` 与 `boundary_conditions` 对照：对同一个输入，两条规则是否给出**可同时成立**的期望值；',
    '- 只要存在无法同时成立的组合（例如同一输入在两条规则下期望值不同、或某条断言与其自身依据的规则矛盾），',
    '  必须写入 `consistency_check.conflicts`（标明涉及的条目编号与冲突原因），**不得把它们当作断言写进验收条件**；',
    '- 自检通过时 `consistency_check.self_checked = true` 且 `conflicts` 为空数组。',
    '  一旦报告冲突，工作流会立即停止并要求人工澄清，不会交给 Coding Agent 自行选择解释。',
    '',
    '【第四步】返回与产物文件 result 完全一致的结构化结果。只返回结构化结果。',
    '',
    envelopeNote(artifactPath)
  ].join('\n');
}

function codingPrompt(attempt, previousReview) {
  const lines = [
    '你是 TLA 三 Agent 流水线中的第 2 个角色（Coding Agent）。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.coding + '，并逐条遵守。',
    '',
    '【第二步】按下述需求在指定交付目录内实现代码与单元测试，并真实运行测试。',
    '',
    '### 交付目录与文件名约定',
    '- 交付目录（仓库内相对路径，不得越出仓库）: ' + C.targetDir,
    '- 模块文件: ' + C.targetDir + '/' + C.moduleFile,
    '- 测试文件: ' + C.targetDir + '/' + C.testFile,
    '- 样例输入文件（按需求决定是否创建）: ' + C.targetDir + '/' + C.sampleFile,
    '- 规范化测试命令（**必须用它**运行测试）: ' + C.testCommand,
    '- 依赖边界: ' + depsBoundary,
    '',
    '### Requirement Agent 的结构化产出（JSON，原样传递）',
    '```json',
    JSON.stringify(requirement, null, 2),
    '```',
    '',
    '### 本轮的独立验证约定（重要）',
    '- 你报告 `test_succeeded` / `test_exit_code` 之后，Verifier Agent 会**独立复跑同一条命令**并回传原始输出；',
    '- 你自述的结果与它的原始输出必须一致，否则本轮判定为不通过（`INCONSISTENT_EVIDENCE`）：',
    '  因此必须如实填写，且在你最后一次修改文件之后运行测试。'
  ];

  if (previousReview) {
    lines.push(
      '',
      '### 上一轮判定未通过的原因（必须先修复）',
      '```json',
      JSON.stringify({
        verdict: previousReview.verdict,
        issues: previousReview.issues,
        criteria_check: previousReview.criteria_check,
        summary: previousReview.summary
      }, null, 2),
      '```',
      '修复后重新运行测试，并在实现说明中写清修复了什么。不得通过放宽或删除测试来"通过"审核。'
    );
  }

  lines.push('', '【第三步】返回与产物文件 result 完全一致的结构化结果。只返回结构化结果。', '',
    envelopeNote(artifact(attempt, 'coding-report')));
  return lines.join('\n');
}

function verifyPrompt(artifactPath) {
  return [
    '你是 TLA 流水线中的 **Verifier Agent**，本次以 `MODE=verify`（独立验证）执行，在独立上下文中工作。',
    '',
    '【第一步】完整读取你的角色规范文件：' + C.promptDir + '/verifier-agent.md，并逐条遵守。',
    '',
    '【第二步】独立复跑验收测试，并回传**原始输出**：',
    '- 必须执行的命令（不得改写、不得增删参数）: ' + C.testCommand,
    '- 在交付目录 `' + C.targetDir + '` 存在的前提下，从仓库根目录执行它；',
    '- 把命令的完整输出（含 `Ran N tests` 与 `OK`/`FAILED` 行）原样放进 `raw_output`；不得摘要、不得改写、不得为了让结果好看而重跑别的命令；',
    '- `exit_code` 填真实退出码；`ran_tests` 填原始输出里的用例数；`result_marker` 填 `OK` 或 `FAILED`；',
    '- 同时给出被验证文件的 sha256 与字节数（模块文件与测试文件），写入 `artifacts`；',
    '- 不要修改任何交付文件，不要修复任何缺陷（发现问题只需如实报告）。',
    '',
    '【第三步】返回结构化结果并写入产物文件（只报告原始事实，不做通过/不通过的最终裁定；裁定由编排脚本按原始输出计算）：',
    envelopeNote(artifactPath)
  ].join('\n');
}

function reviewPrompt(attempt, codingReport, verification, artifactPath) {
  return [
    '你是 TLA 三 Agent 流水线中的第 3 个角色（Review Agent），在独立上下文中审核。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.review + '，并逐条遵守。',
    '',
    '【第二步】审核交付目录中的真实代码。',
    '',
    '### 交付目录',
    '- 交付目录: ' + C.targetDir,
    '- 模块文件: ' + C.targetDir + '/' + C.moduleFile,
    '- 测试文件: ' + C.targetDir + '/' + C.testFile,
    '- 规范化测试命令（**请你自己独立执行一次**）: ' + C.testCommand,
    '- 依赖边界: ' + depsBoundary,
    '',
    '### Requirement Agent 的结构化产出（审核依据）',
    '```json',
    JSON.stringify(requirement, null, 2),
    '```',
    '',
    '### Coding Agent 的报告（线索，不是证据）',
    '```json',
    JSON.stringify(codingReport, null, 2),
    '```',
    '',
    '### Verifier Agent 的独立验证证据（原始输出，供你核对；仍需自己复跑一次）',
    '```json',
    JSON.stringify(verification, null, 2),
    '```',
    '',
    '### 结论一致性要求（强制）',
    '- `criteria_check` 必须**覆盖全部 ' + requirement.acceptance_criteria.length + ' 条验收条件**，每条都要有 `satisfied` 与证据；',
    '- **只要有任意一条 `satisfied: false`，`verdict` 就必须是 `CHANGES_REQUESTED`**；',
    '- `verdict: APPROVED` 必须同时满足：全部验收条件 satisfied、你自己复跑的测试退出码为 0 且输出含 `OK`；',
    '- 若你发现 Coding Agent 的自述、Verifier 的原始输出、你自己的复跑结果三者之间存在矛盾，',
    '  必须在 `consistency_note` 中写明矛盾点，并把 `verdict` 判为 `CHANGES_REQUESTED`。',
    '  编排脚本会独立重算这些判定：矛盾结论不会被当作通过。',
    '',
    '【第三步】以你亲眼读到的文件内容与你亲自运行的命令输出为唯一依据，',
    '写入产物文件并返回结构化结果。只返回结构化结果。',
    '',
    envelopeNote(artifactPath)
  ].join('\n');
}

// ================================================================ 运行期装配

const validated = validateRunConfig(args);
if (!validated.ok) {
  phaseStatic('validation');
  log('输入参数校验失败，工作流未启动任何子代理');
  return failure('INVALID_ARGS', '运行参数校验失败，未启动任何子代理', { errors: validated.errors, received: args === undefined ? null : args });
}
const C = validated.config;

// 内置演示任务（工作流测试样例，不属于 TLA 工作台自身功能）
const demoRequirement = [
  '请为一个 Python 文本统计命令行工具编写需求说明与可检查的验收条件（在既有实现基础上改进，不要重写）。',
  '工具读取一段文本（命令行参数给出文件路径；未给出路径时读取标准输入），输出四项统计结果：',
  '1) 总字符数；2) 总行数；3) 非空行数；4) 英文单词数。',
  '需要明确到可以被逐条测试的程度，至少覆盖：空文本、以换行结尾的文本、只含空白行的文本、',
  '以及"英文单词"的判定规则（大小写、连字符、数字、非 ASCII 字符如何处理）。',
  '已知需要一并修正的既有缺陷（来自上一次运行的真实记录）：',
  'a) 行数口径曾出现矛盾：请给出唯一、无歧义的定义（例如按 Python splitlines 语义：以换行结尾不产生额外的空行）；',
  'b) 提供多个多余位置参数时，argparse 目前以退出码 2 退出，但需求约定应为 1；',
  'c) 模块内有一个仅做单行转发的冗余函数，应删除并由命令行入口直接调用主函数；',
  'd) 文档中描述连接符时使用了两个外观相同的引号字符，其中之一其实是 U+2019，需改为可辨认的写法。',
  '实现需要同时提供可被单元测试直接调用的纯函数接口与命令行入口。',
  '约束：只允许使用 Python 标准库，禁止引入任何第三方依赖。'
].join('\n');

const originalRequirement = hasText(C.requirementInput) ? C.requirementInput : demoRequirement;
const depsBoundary = '仅允许 Python 标准库（禁止引入任何第三方依赖）';
const priorConflictNote = [
  '- 上一次运行（v0.1-first-run）中，"总行数"曾同时出现两种互斥断言（换行结尾计 3 行 vs 计 2 行），',
  '  "cafe\\u0301" 的单词数也曾同时出现 1 与 2 两种断言：这属于需求缺陷，必须自检并避免。'
].join('\n');

const promptPaths = {
  requirement: C.promptDir + '/requirement-agent.md',
  coding: C.promptDir + '/coding-agent.md',
  review: C.promptDir + '/review-agent.md',
  verifier: C.promptDir + '/verifier-agent.md'
};

/** 证据文件路径：第 1 轮用 <kind>.json，修订轮用 <kind>-revision-<n>.json */
function artifact(attempt, kind) {
  return C.evidenceDir + '/' + kind + (attempt > 1 ? '-revision-' + attempt : '') + '.json';
}

function phaseStatic(label) {
  if (typeof phase === 'function') { phase(label); }
}

function reportProblems(context, reasons) {
  if (hasItems(reasons)) { log(context + '：' + reasons.join('；')); }
}

// ================================================================ 编排

phaseStatic('preflight');
log('run_id=' + C.runId + ' | evidence_dir=' + C.evidenceDir + ' | target_dir=' + C.targetDir);
log('step 1/5: Verifier (preflight) -> ' + artifact(1, 'preflight'));

const preflight = await agent(preflightPrompt(artifact(1, 'preflight')), {
  label: 'Verifier (preflight)',
  phase: 'preflight',
  schema: PREFLIGHT_SCHEMA
});

if (!isObject(preflight)) {
  return failure('PREFLIGHT_FAILED', '环境预检子代理失败（返回空结果），工作流终止', { runId: C.runId, evidenceDir: C.evidenceDir });
}
const preflightTime = judgeTimestamp(preflight.generated_at, C.runStartedAt, 6);
if (!preflightTime.ok) {
  return failure('INVALID_TIMESTAMP', '环境预检的时间戳不可信：' + preflightTime.reason,
    { runId: C.runId, evidenceDir: C.evidenceDir, preflight: preflight });
}
if (preflight.evidence_dir_state === 'exists') {
  log('证据目录已存在且有内容，拒绝覆盖（保护历史运行证据）');
  return failure('EVIDENCE_EXISTS',
    '证据目录 ' + C.evidenceDir + ' 已存在且有内容；请使用全新的 runId 与 evidenceDir，历史证据不会被覆盖',
    { runId: C.runId, evidenceDir: C.evidenceDir, existingEntries: preflight.evidence_dir_entries || [] });
}
const missingPrompts = (Array.isArray(preflight.prompt_files) ? preflight.prompt_files : [])
  .filter(function (f) { return !isObject(f) || f.exists !== true; })
  .map(function (f) { return isObject(f) ? asString(f.path) : '(非法项)'; });
if (missingPrompts.length > 0) {
  return failure('PROMPT_MISSING', '角色提示词文件缺失：' + missingPrompts.join(', '),
    { runId: C.runId, promptDir: C.promptDir });
}
const repoRoot = asString(preflight.repo_root).replace(/[\\/]+$/, '');
const resolvedPaths = Array.isArray(preflight.resolved_paths) ? preflight.resolved_paths : [];
function insideRepo(suffix) {
  const normalizedRoot = repoRoot.replace(/\\/g, '/').toLowerCase();
  for (let i = 0; i < resolvedPaths.length; i += 1) {
    const p = asString(resolvedPaths[i]).replace(/\\/g, '/').toLowerCase();
    if (p.indexOf(normalizedRoot) === 0 && p.indexOf(suffix.toLowerCase()) !== -1) { return true; }
  }
  return false;
}
if (repoRoot === '' || !insideRepo(C.targetDir)) {
  return failure('TARGET_DIR_OUTSIDE_REPO',
    '交付目录未能确认落在仓库内（' + C.targetDir + '；预检报告的仓库根为 ' + repoRoot + '）',
    { runId: C.runId, resolvedPaths: resolvedPaths, preflight: preflight });
}
log('环境预检通过：repo_root=' + repoRoot + ' | 证据目录状态=' + preflight.evidence_dir_state +
  ' | 交付目录状态=' + preflight.target_dir_state);

phaseStatic('requirement');
log('step 2/5: Requirement Agent -> ' + artifact(1, 'requirement'));

const requirement = await agent(requirementPrompt(artifact(1, 'requirement')), {
  label: 'Requirement Agent',
  phase: 'requirement',
  schema: REQUIREMENT_SCHEMA
});

if (!isObject(requirement) || !hasText(requirement.goal) ||
    !hasItems(requirement.acceptance_criteria) || !hasItems(requirement.boundary_conditions)) {
  return failure('REQUIREMENT_OUTPUT_INVALID',
    'Requirement Agent 输出不完整或子代理失败（goal/acceptance_criteria/boundary_conditions 缺失）',
    { runId: C.runId, evidenceDir: C.evidenceDir, received: requirement });
}
const requirementTime = judgeTimestamp(requirement.generated_at, C.runStartedAt, 6);
if (!requirementTime.ok) {
  return failure('INVALID_TIMESTAMP', '需求阶段的时间戳不可信：' + requirementTime.reason,
    { runId: C.runId, evidenceDir: C.evidenceDir, requirement: requirement });
}
const requirementConsistency = judgeRequirementConsistency(requirement);
if (!requirementConsistency.ok) {
  log('需求自检报告冲突，停止实施并等待人工澄清（不会交给 Coding Agent 自行选择解释）');
  return failure('REQUIREMENT_CONFLICT',
    'Requirement Agent 的一致性自检发现无法同时满足的规则，工作流停止实施，等待人工澄清',
    { runId: C.runId, evidenceDir: C.evidenceDir, requirement: requirement, conflicts: requirementConsistency.conflicts });
}
log('Requirement Agent 完成：验收条件 ' + requirement.acceptance_criteria.length +
  ' 条、边界条件 ' + requirement.boundary_conditions.length + ' 条、自检冲突 0 条');

const requirementItemCount = requirement.acceptance_criteria.length;
const attemptsDetail = [];
let previousReview = null;
let attempt = 1;
let lastDecision = null;

while (attempt <= C.maxCodingAttempts) {
  const revTag = attempt > 1 ? ' (revision ' + attempt + ')' : '';

  phaseStatic('coding' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 3/5: Coding Agent' + revTag + ' -> ' + artifact(attempt, 'coding-report'));

  const codingReport = await agent(codingPrompt(attempt, previousReview), {
    label: 'Coding Agent' + revTag,
    phase: 'coding' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: CODING_SCHEMA
  });
  const codingOutputValid = isObject(codingReport) && hasItems(codingReport.files_created);
  if (codingOutputValid) {
    const codingTime = judgeTimestamp(codingReport.generated_at, C.runStartedAt, 6);
    if (!codingTime.ok) {
      return failure('INVALID_TIMESTAMP', '编码阶段的时间戳不可信：' + codingTime.reason,
        { runId: C.runId, evidenceDir: C.evidenceDir, attempt: attempt, received: codingReport });
    }
    log('Coding Agent' + revTag + ' 完成：文件 ' + codingReport.files_created.length +
      ' 个，自述测试 ' + (codingReport.test_succeeded ? '通过' : '未通过') + '（exit=' + codingReport.test_exit_code + '）');
  } else {
    log('Coding Agent' + revTag + ' 未返回可用的实现报告（继续走独立验证与审核，最终判定为不通过）');
  }

  phaseStatic('verify' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 4/5: Verifier (verify)' + revTag + ' -> ' + artifact(attempt, 'verify'));

  const verification = await agent(verifyPrompt(artifact(attempt, 'verify')), {
    label: 'Verifier (verify)' + revTag,
    phase: 'verify' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: VERIFY_SCHEMA
  });
  const verificationJudge = judgeTestEvidence(verification, C.testCommand);
  if (isObject(verification)) {
    const verifyTime = judgeTimestamp(verification.generated_at, C.runStartedAt, 6);
    if (!verifyTime.ok) { verificationJudge.passed = false; verificationJudge.reasons.push(verifyTime.reason); }
  }
  log('Verifier' + revTag + ' 判定：' + (verificationJudge.passed ? '测试通过（外部独立验证）' : '未通过'));

  phaseStatic('review' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 5/5: Review Agent' + revTag + ' -> ' + artifact(attempt, 'review'));

  const review = await agent(reviewPrompt(attempt, codingReport, verification, artifact(attempt, 'review')), {
    label: 'Review Agent' + revTag,
    phase: 'review' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: REVIEW_SCHEMA
  });
  if (isObject(review)) {
    const reviewTime = judgeTimestamp(review.generated_at, C.runStartedAt, 6);
    if (!reviewTime.ok) {
      review.consistency_note = asString(review.consistency_note) + ' [编排层：' + reviewTime.reason + ']';
      review.verdict = 'CHANGES_REQUESTED';
    }
  }

  const decision = judgeAttempt(codingReport, verification, review, requirementItemCount, C.testCommand, codingOutputValid);
  if (!decision.ok) { reportProblems('第 ' + attempt + ' 轮判定未通过', decision.reasons); }
  log('第 ' + attempt + ' 轮判定：' + (decision.ok ? 'PASS' : decision.status));

  attemptsDetail.push({
    attempt: attempt,
    codingReport: codingReport,
    verification: verification,
    review: review,
    decision: decision
  });
  lastDecision = decision;

  if (decision.ok) { break; }
  if (attempt >= C.maxCodingAttempts) {
    log('已达到最大编码轮次（' + C.maxCodingAttempts + '），工作流以不通过结束并保留全部证据');
    break;
  }

  previousReview = isObject(review) ? review : { verdict: 'CHANGES_REQUESTED', issues: [], summary: 'Review Agent 未返回有效结论（子代理失败）' };
  if (isObject(review) && !Array.isArray(review.issues)) { previousReview.issues = []; }
  if (!isObject(review)) {
    previousReview.issues = [{ file: '(unknown)', location: '-',
      problem: 'Review Agent 本次未返回结构化结论', suggestion: '重新运行审核并确认输出符合 schema' }];
  }
  if (hasItems(decision.reasons)) {
    previousReview.issues = (Array.isArray(previousReview.issues) ? previousReview.issues : []).concat([
      { file: '(编排层判定)', location: '第 ' + attempt + ' 轮',
        problem: decision.reasons.join('；'), suggestion: '按上述原因修复后重新提交本轮证据' }
    ]);
  }
  attempt = attempt + 1;
}

const finalAttempt = attemptsDetail[attemptsDetail.length - 1];
const finalOk = isObject(finalAttempt) && finalAttempt.decision.ok === true;
const verifiedFinal = isObject(finalAttempt) ? finalAttempt.decision.verified : { passed: false, reasons: ['无有效轮次'] };
const reviewFinal = isObject(finalAttempt) ? finalAttempt.decision.reviewEval : { approved: false, allSatisfied: false, coversAll: false, ownTestsPassed: false, criteriaTotal: 0, criteriaSatisfied: 0, reasons: ['无有效轮次'] };
let status = finalOk ? 'OK' : (isObject(finalAttempt) ? finalAttempt.decision.status : 'NO_ATTEMPT');
if (!finalOk && C.maxCodingAttempts > 1 && attemptsDetail.length >= C.maxCodingAttempts) {
  status = 'MAX_ATTEMPTS_' + status;
}

return {
  ok: finalOk,
  status: status,
  runId: C.runId,
  evidenceDir: C.evidenceDir,
  runStartedAt: C.runStartedAt,
  pipeline: ['Verifier(preflight)', 'Requirement Agent', 'Coding Agent', 'Verifier(verify)', 'Review Agent'],
  targetDir: C.targetDir,
  testCommand: C.testCommand,
  maxCodingAttempts: C.maxCodingAttempts,
  attempts: attemptsDetail.length,
  originalRequirement: originalRequirement,
  requirement: requirement,
  requirementSelfCheck: isObject(requirement) ? requirement.consistency_check : null,
  preflight: preflight,
  attemptsDetail: attemptsDetail.map(function (d) {
    return {
      attempt: d.attempt,
      codingReport: d.codingReport,
      verification: d.verification,
      review: d.review,
      decision: { ok: d.decision.ok, status: d.decision.status, reasons: d.decision.reasons },
      selfReportVsVerified: d.decision.selfReportVsVerified
    };
  }),
  finalVerdict: isObject(finalAttempt) && isObject(finalAttempt.review) ? finalAttempt.review.verdict : null,
  finalReview: isObject(finalAttempt) ? finalAttempt.review : null,
  finalDecision: {
    ok: finalOk,
    status: status,
    testsIndependentlyVerified: verifiedFinal.passed === true,
    testsVerificationReasons: verifiedFinal.reasons,
    reviewApproved: reviewFinal.approved === true,
    criteriaSatisfied: reviewFinal.criteriaSatisfied,
    criteriaTotal: reviewFinal.criteriaTotal,
    allCriteriaSatisfied: reviewFinal.allSatisfied === true,
    criteriaCheckCoversAll: reviewFinal.coversAll === true,
    reviewIndependentTestsPassed: reviewFinal.ownTestsPassed === true
  }
};
