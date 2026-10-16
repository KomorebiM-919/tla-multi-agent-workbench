/**
 * TLA V0.1 — three-agent MVP workflow: Requirement -> Coding -> Review.
 *
 * 由 DSH 的 `workflow` 工具执行的 JavaScript 编排脚本（本文件内容即 tool 的 `script` 参数）。
 * 角色提示词存放在 `agents/*.md`，脚本不复制提示词，而是要求每个子代理先读取自己的角色文件。
 *
 * 执行顺序与结果传递由本脚本的编排逻辑保证（顺序 await + 上一阶段结构化结果原样注入）；
 * `phase()` 只用于进度展示，不产生执行依赖。
 *
 * args 契约（全部可选，缺省即运行仓库内置的演示任务）：
 * {
 *   "runId": "v0.1-first-run",
 *   "evidenceDir": "docs/evidence/v0.1-first-run",
 *   "promptDir": "agents",
 *   "task": {
 *     "requirement": "<自然语言需求>",
 *     "targetDir": "examples/text-stats",
 *     "moduleFile": "text_stats.py",
 *     "testFile": "test_text_stats.py",
 *     "testCommand": "python -m unittest discover -s examples/text-stats -p \"test_*.py\"",
 *     "maxCodingAttempts": 2
 *   }
 * }
 *
 * 返回值：结构化运行结果（ok / 各阶段结构化输出 / 最终审核结论），供编排代理归档与核验。
 */

// ---------------------------------------------------------------- 运行参数

const cfg = args || {};

const runId = cfg.runId || 'v0.1-first-run';
const evidenceDir = String(cfg.evidenceDir || 'docs/evidence/' + runId).replace(/\/+$/, '');
const promptDir = String(cfg.promptDir || 'agents').replace(/\/+$/, '');

const depsBoundary = '仅允许 Python 标准库（禁止引入任何第三方依赖）';

const taskInput = cfg.task || {};
const targetDir = String(taskInput.targetDir || 'examples/text-stats').replace(/\/+$/, '');
const moduleFile = taskInput.moduleFile || 'text_stats.py';
const testFile = taskInput.testFile || 'test_text_stats.py';
const sampleFile = taskInput.sampleFile || 'sample_input.txt';
const testCommand = taskInput.testCommand ||
  'python -m unittest discover -s ' + targetDir + ' -p "test_*.py"';
const maxCodingAttempts = taskInput.maxCodingAttempts || 2;

// 内置演示任务（工作流测试样例，不属于 TLA 工作台自身功能）
const demoRequirement = [
  '请为一个 Python 文本统计命令行工具编写需求说明与可检查的验收条件。',
  '工具需要读取一段文本（命令行参数给出文件路径；未给出路径时读取标准输入），并输出四项统计结果：',
  '1) 总字符数；2) 总行数；3) 非空行数；4) 英文单词数。',
  '请把边界条件明确到可以被逐条测试的程度，至少覆盖：空文本、以换行结尾的文本、只含空白行的文本、',
  '以及"英文单词"的判定规则（大小写、连字符、数字、非英文字符如何处理）。',
  '实现需要同时提供可被单元测试直接调用的纯函数接口与命令行入口。',
  '约束：只允许使用 Python 标准库，禁止引入任何第三方依赖。'
].join('\n');

const originalRequirement = taskInput.requirement || demoRequirement;

const promptPaths = {
  requirement: promptDir + '/requirement-agent.md',
  coding: promptDir + '/coding-agent.md',
  review: promptDir + '/review-agent.md'
};

/** 证据文件路径：第 1 轮用 <kind>.json，修订轮用 <kind>-revision-<n>.json */
function artifact(attempt, kind) {
  return evidenceDir + '/' + kind + (attempt > 1 ? '-revision-' + attempt : '') + '.json';
}

// ---------------------------------------------------------------- 输出 Schema

const REQUIREMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'scope_in', 'scope_out', 'acceptance_criteria', 'boundary_conditions'],
  properties: {
    goal: { type: 'string' },
    scope_in: { type: 'array', items: { type: 'string' } },
    scope_out: { type: 'array', items: { type: 'string' } },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    boundary_conditions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } }
  }
};

const CODING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_created', 'implementation_summary', 'test_command', 'test_succeeded', 'test_exit_code', 'test_output_excerpt', 'report_file'],
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
    report_file: { type: 'string' }
  }
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'criteria_check', 'issues', 'summary', 'report_file'],
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
    independent_test_result: { type: 'string' },
    summary: { type: 'string' },
    report_file: { type: 'string' }
  }
};

// ---------------------------------------------------------------- 校验工具

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function hasText(v) { return typeof v === 'string' && v.trim().length > 0; }
function hasItems(v) { return Array.isArray(v) && v.length > 0; }

// ---------------------------------------------------------------- 提示词构建

function requirementPrompt() {
  return [
    '你是 TLA 三 Agent 流水线中的第 1 个角色。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.requirement + '，并逐条遵守。',
    '',
    '【第二步】处理下面的原始需求，产出结构化需求。',
    '',
    '### 原始需求（自然语言）',
    originalRequirement,
    '',
    '### 运行期参数',
    '- run_id: ' + runId,
    '- 证据目录: ' + evidenceDir,
    '- 你必须写入的产物文件: ' + artifact(1, 'requirement'),
    '- 交付目录（你不写代码，仅用于界定范围）: ' + targetDir,
    '- 依赖边界: ' + depsBoundary,
    '',
    '【第三步】把结论写入产物文件（JSON 信封：run_id/agent/stage/generated_at/result），',
    '并返回与其中 result 完全一致的结构化结果。只返回结构化结果，不要附加解释文字。'
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
    '- 交付目录: ' + targetDir,
    '- 模块文件: ' + targetDir + '/' + moduleFile,
    '- 测试文件: ' + targetDir + '/' + testFile,
    '- 样例输入文件（按需求决定是否创建）: ' + targetDir + '/' + sampleFile,
    '- 规范化测试命令（必须用它运行测试）: ' + testCommand,
    '- 依赖边界: ' + depsBoundary,
    '',
    '### Requirement Agent 的结构化产出（JSON，原样传递）',
    '```json',
    JSON.stringify(requirement, null, 2),
    '```',
    '',
    '### 你要写入的证据文件',
    '- 产物文件: ' + artifact(attempt, 'coding-report'),
    '- JSON 信封字段 run_id/agent/stage/generated_at/result 必须齐全，result 字段见角色规范。'
  ];

  if (previousReview) {
    lines.push(
      '',
      '### 上一轮 Review Agent 的结论（必须先修复其中列出的问题）',
      '```json',
      JSON.stringify({
        verdict: previousReview.verdict,
        issues: previousReview.issues,
        summary: previousReview.summary
      }, null, 2),
      '```',
      '修复后重新运行测试，并在实现说明中写清修复了什么。不得通过放宽或删除测试来"通过"审核。'
    );
  }

  lines.push('', '【第三步】写入产物文件，并返回与 result 完全一致的结构化结果。只返回结构化结果。');
  return lines.join('\n');
}

function reviewPrompt(attempt, codingReport) {
  return [
    '你是 TLA 三 Agent 流水线中的第 3 个角色（Review Agent），在独立上下文中审核。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.review + '，并逐条遵守。',
    '',
    '【第二步】审核交付目录中的真实代码。',
    '',
    '### 交付目录',
    '- 交付目录: ' + targetDir,
    '- 模块文件: ' + targetDir + '/' + moduleFile,
    '- 测试文件: ' + targetDir + '/' + testFile,
    '- 规范化测试命令（请你自己独立执行一次）: ' + testCommand,
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
    '### 你要写入的证据文件',
    '- 产物文件: ' + artifact(attempt, 'review'),
    '- JSON 信封字段 run_id/agent/stage/generated_at/result 必须齐全，result 字段见角色规范。',
    '',
    '【第三步】以你亲眼读到的文件内容与你亲自运行的命令输出为唯一依据，逐条判定验收条件，',
    '给出 APPROVED 或 CHANGES_REQUESTED，写入产物文件并返回结构化结果。只返回结构化结果。'
  ].join('\n');
}

// ---------------------------------------------------------------- 编排

phase('requirement');
log('run_id=' + runId + ' | evidence_dir=' + evidenceDir + ' | target_dir=' + targetDir);
log('step 1/3: Requirement Agent -> ' + artifact(1, 'requirement'));

const requirement = await agent(requirementPrompt(), {
  label: 'Requirement Agent',
  phase: 'requirement',
  schema: REQUIREMENT_SCHEMA
});

if (!isObject(requirement) || !hasText(requirement.goal) ||
    !hasItems(requirement.acceptance_criteria) || !hasItems(requirement.boundary_conditions)) {
  log('Requirement Agent 未返回可用的结构化需求，工作流终止');
  return {
    ok: false,
    runId: runId,
    evidenceDir: evidenceDir,
    stage: 'requirement',
    error: 'Requirement Agent 输出不完整或子代理失败（goal/acceptance_criteria/boundary_conditions 缺失）',
    received: requirement
  };
}

log('Requirement Agent 完成：验收条件 ' + requirement.acceptance_criteria.length +
    ' 条、边界条件 ' + requirement.boundary_conditions.length + ' 条');

const codingReports = [];
let attempt = 1;
let previousReview = null;
let codingReport = null;
let review = null;

while (attempt <= maxCodingAttempts) {
  const revTag = attempt > 1 ? ' (revision ' + attempt + ')' : '';

  phase('coding' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 2/3: Coding Agent' + revTag + ' -> ' + artifact(attempt, 'coding-report'));

  codingReport = await agent(codingPrompt(attempt, previousReview), {
    label: 'Coding Agent' + revTag,
    phase: 'coding' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: CODING_SCHEMA
  });

  if (!isObject(codingReport) || !hasItems(codingReport.files_created)) {
    log('Coding Agent 未返回可用的实现报告（第 ' + attempt + ' 轮），工作流终止');
    return {
      ok: false,
      runId: runId,
      evidenceDir: evidenceDir,
      stage: 'coding',
      attempt: attempt,
      error: 'Coding Agent 输出不完整或子代理失败（files_created 缺失）',
      requirement: requirement,
      received: codingReport
    };
  }

  codingReports.push({ attempt: attempt, report: codingReport });
  log('Coding Agent' + revTag + ' 完成：文件 ' + codingReport.files_created.length +
      ' 个，测试 ' + (codingReport.test_succeeded ? '通过' : '未通过') +
      '（exit=' + codingReport.test_exit_code + '）');

  phase('review' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 3/3: Review Agent' + revTag + ' -> ' + artifact(attempt, 'review'));

  review = await agent(reviewPrompt(attempt, codingReport), {
    label: 'Review Agent' + revTag,
    phase: 'review' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: REVIEW_SCHEMA
  });

  if (!isObject(review) || (review.verdict !== 'APPROVED' && review.verdict !== 'CHANGES_REQUESTED')) {
    log('Review Agent 未返回合法结论（第 ' + attempt + ' 轮），工作流终止');
    return {
      ok: false,
      runId: runId,
      evidenceDir: evidenceDir,
      stage: 'review',
      attempt: attempt,
      error: 'Review Agent 输出不完整或子代理失败（verdict 必须是 APPROVED / CHANGES_REQUESTED）',
      requirement: requirement,
      codingReports: codingReports,
      received: review
    };
  }

  log('Review Agent' + revTag + ' 结论：' + review.verdict +
      '（问题 ' + (Array.isArray(review.issues) ? review.issues.length : 0) + ' 项）');

  if (review.verdict === 'APPROVED') { break; }
  if (attempt >= maxCodingAttempts) {
    log('已达到最大编码轮次（' + maxCodingAttempts + '），工作流以 CHANGES_REQUESTED 结束');
    break;
  }

  previousReview = review;
  attempt = attempt + 1;
}

return {
  ok: review.verdict === 'APPROVED',
  runId: runId,
  evidenceDir: evidenceDir,
  pipeline: ['Requirement Agent', 'Coding Agent', 'Review Agent'],
  targetDir: targetDir,
  testCommand: testCommand,
  attempts: attempt,
  originalRequirement: originalRequirement,
  requirement: requirement,
  codingReports: codingReports,
  finalReview: review,
  finalVerdict: review.verdict
};
