/**
 * tests/preflight-workflow-script.mjs
 *
 * 真实运行**之前**的执行前校验（离线，0 次模型调用）：
 *   1. 把「准备提交给 workflow 工具的实际 script 字符串」与「固定提交里的仓库源码」逐字节比对；
 *   2. 用同一份实际脚本跑一次模拟运行，采集全部 5 个 schema，并按宿主实际支持子集逐条检查。
 *
 * 为什么需要它：workflow 工具只接受 `script` 字符串（`dsh-tool-workflow` 的入参只有
 * `script` / `meta` / `args`），脚本没有文件系统 API，无法 `require` 仓库文件；v0.3-run3 因
 * 手工转录漏掉 `REVIEW_SCHEMA.properties.issues.items.type`，宿主在第 5 次调用前拒绝，
 * 前 4 次调用白花。schema 的支持子集校验发生在 `agent()` 调用内部（宿主侧），
 * 因此**本地模拟检查不能替代宿主校验**——本工具只负责让"缺 type"这类错误在 0 次调用时暴露。
 *
 * 用法：
 *   node tests/preflight-workflow-script.mjs --payload <待提交脚本文件> --commit <固定提交 SHA>
 *        [--repo-root <dir>] [--repo-file workflows/three-agent-mvp.js] [--out <报告>] [--json]
 *
 * 退出码：0 通过 / 10 字节不一致 / 11 schema 不合法 / 12 两者都不合格 / 13 脚本跑不起来 / 4 参数错误 / 5 git 或 IO 失败
 *
 * 仅使用 Node 标准库（node:crypto / node:fs / node:path / node:child_process），不安装依赖、不调用模型。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { baseArgs, runSource } from './workflow-harness.mjs';
import { twoAttemptPlan } from './script-fingerprint.mjs';

const TOOL = 'tests/preflight-workflow-script.mjs';
const DEFAULT_REPO_FILE = 'workflows/three-agent-mvp.js';

// ------------------------------------------------------------ 宿主的 JSON Schema 支持子集
//
// 规则照抄宿主实现（@deepseek-ai/dsh-tools 的 assertSupportedJsonSchema / assertObjectJsonSchema）：
// 关键词只有 type/oneOf/properties/required/additionalProperties/items/enum/const + 注解；
// 任何对象节点都必须声明 type 或 oneOf，否则 properties/required/additionalProperties/items 无处附着。
// 这里**只做本地模拟**：宿主真正的拒绝发生在 agent() 调用内部，不能声称本工具通过了宿主校验。

const CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples'];
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
const KEYWORD_OWNER_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null']
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainArray(value) {
  return Array.isArray(value);
}

function scalarMatches(type, value) {
  if (type === 'null') { return value === null; }
  if (type === 'integer') { return typeof value === 'number' && Number.isInteger(value); }
  if (type === 'number') { return typeof value === 'number' && Number.isFinite(value); }
  return typeof value === type;
}

/**
 * 收集一份 schema 的全部违规（不抛异常，便于逐个报告）。
 * 消息文本与宿主保持一致，方便把本地结论和宿主报错对齐。
 */
export function schemaViolations(schema, rootPath) {
  const violations = [];
  const root = rootPath || 'schema';

  function visit(node, at) {
    if (!isPlainObject(node)) {
      violations.push(at + ' must be a schema object');
      return;
    }
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.indexOf(key) !== -1) { continue; }
      if (ANNOTATION_KEYWORDS.indexOf(key) !== -1) {
        if (key === 'description' && typeof node.description !== 'string') {
          violations.push(at + '.description must be a string');
        }
        if (key === 'title' && typeof node.title !== 'string') {
          violations.push(at + '.title must be a string');
        }
        continue;
      }
      violations.push(at + '.' + key + ' is not a supported keyword ' +
        '(subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)');
    }
    const hasType = Object.prototype.hasOwnProperty.call(node, 'type');
    const hasOneOf = Object.prototype.hasOwnProperty.call(node, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(at + ' cannot declare both type and oneOf');
      return;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          violations.push(at + '.' + key + ' requires type or oneOf');
        }
      }
      return;
    }
    if (hasOneOf) {
      const oneOf = node.oneOf;
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          violations.push(at + '.' + key + ' is not supported beside oneOf');
        }
      }
      if (!isPlainArray(oneOf) || oneOf.length < 2) {
        violations.push(at + '.oneOf must be an array of at least two schemas');
      } else {
        oneOf.forEach(function (entry, index) { visit(entry, at + '.oneOf[' + index + ']'); });
      }
      return;
    }
    const type = node.type;
    if (typeof type !== 'string' || SCHEMA_TYPES.indexOf(type) === -1) {
      violations.push(isPlainArray(type)
        ? at + '.type must be a single type string (type arrays are not supported)'
        : at + '.type must be one of ' + SCHEMA_TYPES.join('/'));
      return;
    }
    for (const key of Object.keys(KEYWORD_OWNER_TYPES)) {
      if (Object.prototype.hasOwnProperty.call(node, key) && KEYWORD_OWNER_TYPES[key].indexOf(type) === -1) {
        violations.push(at + '.' + key + ' is not supported on type "' + type + '"');
      }
    }
    if (type === 'object') {
      if (Object.prototype.hasOwnProperty.call(node, 'properties')) {
        if (!isPlainObject(node.properties)) {
          violations.push(at + '.properties must be an object of schemas');
        } else {
          for (const name of Object.keys(node.properties)) {
            visit(node.properties[name], at + '.properties.' + name);
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(node, 'required')) {
        const required = node.required;
        if (!isPlainArray(required) || required.some(function (entry) { return typeof entry !== 'string'; })) {
          violations.push(at + '.required must be an array of strings');
        } else {
          const declared = isPlainObject(node.properties) ? node.properties : {};
          for (const name of required) {
            if (!Object.prototype.hasOwnProperty.call(declared, name)) {
              violations.push(at + '.required names "' + name + '" which is not in properties');
            }
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(at + '.additionalProperties must be a boolean');
      }
      return;
    }
    if (type === 'array') {
      if (Object.prototype.hasOwnProperty.call(node, 'items')) {
        visit(node.items, at + '.items');
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(node, 'enum')) {
      const allowed = node.enum;
      const valid = isPlainArray(allowed) && allowed.length > 0 &&
        allowed.every(function (entry) { return scalarMatches(type, entry); });
      if (!valid) { violations.push(at + '.enum must be a non-empty array of ' + type + ' values'); }
    }
    if (Object.prototype.hasOwnProperty.call(node, 'const') && !scalarMatches(type, node.const)) {
      violations.push(at + '.const must be a ' + type + ' value');
    }
  }

  visit(schema, root);
  return violations;
}

// ------------------------------------------------------------ 字节比对

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 唯一的末尾换行规范化规则：去掉结尾所有换行符，再补一个 "\n"。 */
export function normalizeTrailingNewline(text) {
  return text.replace(/[\r\n]+$/, '') + '\n';
}

function trailingNewlines(text) {
  const match = /[\r\n]+$/.exec(text);
  return match === null ? 0 : match[0].length;
}

function firstDifference(payloadBuffer, sourceBuffer) {
  const limit = Math.min(payloadBuffer.length, sourceBuffer.length);
  for (let index = 0; index < limit; index += 1) {
    if (payloadBuffer[index] !== sourceBuffer[index]) {
      return { offset: index, line: lineNumberAt(payloadBuffer, index), byte: payloadBuffer[index], expectedByte: sourceBuffer[index] };
    }
  }
  if (payloadBuffer.length === sourceBuffer.length) { return null; }
  return {
    offset: limit,
    line: lineNumberAt(payloadBuffer, Math.min(limit, payloadBuffer.length)),
    byte: limit < payloadBuffer.length ? payloadBuffer[limit] : null,
    expectedByte: limit < sourceBuffer.length ? sourceBuffer[limit] : null
  };
}

function lineNumberAt(buffer, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < buffer.length; index += 1) {
    if (buffer[index] === 10) { line += 1; }
  }
  return line;
}

// ------------------------------------------------------------ git
//
// 沙箱不允许通过管道捕获子进程输出（spawnSync 的默认 stdio: 'pipe' 会 EPERM），
// 因此把 git 的 stdout 重定向到**文件描述符**再读回：只用文件，不用管道。

let gitTempCounter = 0;

function gitCapture(repoRoot, args) {
  const temp = path.join(os.tmpdir(), 'preflight-git-' + process.pid + '-' + (gitTempCounter += 1) + '.bin');
  const fd = openSync(temp, 'w');
  let result;
  try {
    result = spawnSync('git', ['-C', repoRoot].concat(args), { stdio: ['ignore', fd, 'inherit'] });
  } finally {
    closeSync(fd);
  }
  try {
    if (result.error) { throw new Error('无法执行 git：' + result.error.message); }
    if (result.status !== 0) { throw new Error('git ' + args.join(' ') + ' 失败（exit ' + result.status + '）'); }
    return readFileSync(temp);
  } finally {
    try { unlinkSync(temp); } catch (error) { /* 临时文件清理失败不影响结论 */ }
  }
}

/** 取出固定提交里该文件的原始字节：比较对象是"准备提交的文本"，不是执行副本自己。 */
export function readSourceAtCommit(repoRoot, commit, repoFile) {
  const fullCommit = String(gitCapture(repoRoot, ['rev-parse', commit + '^{commit}'])).trim();
  const bytes = gitCapture(repoRoot, ['show', fullCommit + ':' + repoFile]);
  return { commit: fullCommit, bytes: bytes };
}

// ------------------------------------------------------------ 主流程

function parseArgs(argv) {
  const options = {
    payload: null, commit: null, repoRoot: process.cwd(), repoFile: DEFAULT_REPO_FILE,
    out: null, json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--payload') { options.payload = next; index += 1; }
    else if (flag === '--commit') { options.commit = next; index += 1; }
    else if (flag === '--repo-root') { options.repoRoot = next; index += 1; }
    else if (flag === '--repo-file') { options.repoFile = next; index += 1; }
    else if (flag === '--out') { options.out = next; index += 1; }
    else if (flag === '--json') { options.json = true; }
    else { throw new UsageError('未知参数：' + flag); }
  }
  if (options.payload === null) { throw new UsageError('缺少 --payload（准备提交给 workflow 工具的脚本文本文件）'); }
  if (options.commit === null) { throw new UsageError('缺少 --commit（固定版本的提交 SHA）'); }
  return options;
}

class UsageError extends Error {}

async function preflight(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const payloadBuffer = readFileSync(options.payload);
  const payloadText = payloadBuffer.toString('utf8');
  let source;
  try {
    source = readSourceAtCommit(repoRoot, options.commit, options.repoFile);
  } catch (error) {
    const failure = new Error(String(error && error.message ? error.message : error));
    failure.code = 'GIT';
    throw failure;
  }
  const sourceText = source.bytes.toString('utf8');

  const comparison = {
    rawIdentical: payloadBuffer.equals(source.bytes),
    normalizedIdentical: normalizeTrailingNewline(payloadText) === normalizeTrailingNewline(sourceText),
    firstDifference: payloadBuffer.equals(source.bytes) ? null : firstDifference(payloadBuffer, source.bytes),
    byteDelta: payloadBuffer.length - source.bytes.length
  };

  // schema 检查：把**待提交的实际文本**放进模拟运行器跑一遍（0 次真实调用），采集每次调用的 schema。
  const captured = [];
  let payloadError = null;
  try {
    const outcome = await runSource(payloadText, twoAttemptPlan(), baseArgs({ task: { maxAgentCalls: 8 } }), { capture: captured });
    if (!outcome.result || outcome.result.status !== 'OK') {
      payloadError = '模拟运行没有跑到 OK：' + (outcome.result && (outcome.result.status + ' / ' + outcome.result.error));
    }
  } catch (error) {
    payloadError = '脚本在模拟运行中抛出：' + (error && error.message ? error.message : String(error));
  }

  const checked = [];
  const bySchema = {};
  for (const call of captured) {
    if (typeof call.schema === 'undefined') { continue; }
    const text = JSON.stringify(call.schema);
    if (bySchema[text] === undefined) {
      bySchema[text] = {
        label: call.label,
        labels: [call.label],
        phase: call.phase,
        sha256: sha256(Buffer.from(text, 'utf8')),
        violations: schemaViolations(call.schema, 'schema')
      };
      checked.push(bySchema[text]);
    } else if (bySchema[text].labels.indexOf(call.label) === -1) {
      // 同一 schema 被多个阶段复用（如两轮修订）时只检查一次，但保留全部 label 便于核对覆盖。
      bySchema[text].labels.push(call.label);
    }
  }
  const schemaInvalid = checked.filter(function (item) { return item.violations.length > 0; });
  const allValid = payloadError === null && checked.length === 5 && schemaInvalid.length === 0;

  let verdict = 'PASS';
  if (payloadError !== null) { verdict = 'PAYLOAD_ERROR'; }
  else if (!comparison.rawIdentical && !comparison.normalizedIdentical) { verdict = 'MISMATCH'; }
  if (!allValid && payloadError === null) {
    verdict = verdict === 'MISMATCH' ? 'MISMATCH_AND_SCHEMA_INVALID' : 'SCHEMA_INVALID';
  }

  return {
    tool: TOOL,
    commit: source.commit,
    repoFile: options.repoFile,
    payload: {
      path: options.payload.replace(/\\/g, '/'),
      bytes: payloadBuffer.length,
      sha256Raw: sha256(payloadBuffer),
      sha256Normalized: sha256(Buffer.from(normalizeTrailingNewline(payloadText), 'utf8')),
      trailingNewlines: trailingNewlines(payloadText)
    },
    source: {
      bytes: source.bytes.length,
      sha256Raw: sha256(source.bytes),
      sha256Normalized: sha256(Buffer.from(normalizeTrailingNewline(sourceText), 'utf8')),
      trailingNewlines: trailingNewlines(sourceText)
    },
    comparison,
    bytePolicy: {
      rule: '唯一允许的规范化：去掉结尾所有换行符后补一个 "\\n"',
      identical: '逐字节相同',
      normalizedOnly: '仅末尾换行差异 → 记为 normalized-identical，同时保留原始与规范化哈希',
      anythingElse: '注释、空行、缩进、判定代码只要变一个字节就是不通过（不尝试"语义等价"判断）'
    },
    schemas: {
      capturedCalls: captured.length,
      distinct: checked.length,
      checked: checked,
      invalid: schemaInvalid.map(function (item) { return item.label; }),
      allValid: allValid,
      payloadError: payloadError
    },
    // 宿主能力的边界必须与本地结论分开写：本地"通过"不等于宿主"通过"。
    hostCapabilities: {
      machineScriptTransfer: 'unsupported-by-tool-schema',
      machineScriptTransferDetail: 'workflow 工具入参只有 script(string) / meta(object) / args(object)；' +
        '引擎 API ctx.workflowEngine.start({ script, meta, args }) 同样接收脚本文本。没有任何"从文件路径读取脚本"的参数。',
      zeroCallSchemaValidation: 'unavailable',
      zeroCallSchemaValidationDetail: 'schema 支持子集校验发生在 agent() 调用内部（宿主侧 readAgentOptions），' +
        '没有"先校验再启动"的零调用接口；本工具的 schema 检查是本地模拟，规则照抄宿主实现，但结论只代表本地。',
      agentCalls: { real: 0, simulated: captured.length }
    },
    verdict: verdict
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tests/preflight-workflow-script.mjs');
if (invokedDirectly) {
  let report;
  try {
    report = await preflight(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error('用法错误：' + error.message);
      console.error('usage: node ' + TOOL + ' --payload <file> --commit <sha> [--repo-root <dir>] [--repo-file <path>] [--out <file>] [--json]');
      process.exit(4);
    }
    console.error('执行前校验失败：' + (error && error.message ? error.message : String(error)));
    process.exit(5);
  }
  const text = JSON.stringify(report, null, 2);
  if (process.argv.includes('--json')) { console.log(text); }
  else {
    console.log('执行前校验：' + report.verdict);
    console.log('固定提交：' + report.commit + '  ' + report.repoFile);
    console.log('载荷：' + report.payload.bytes + ' 字节 sha256=' + report.payload.sha256Raw);
    console.log('源码：' + report.source.bytes + ' 字节 sha256=' + report.source.sha256Raw);
    console.log('逐字节相同：' + report.comparison.rawIdentical + ' / 规范化后相同：' + report.comparison.normalizedIdentical +
      ' / 字节差：' + report.comparison.byteDelta);
    console.log('schema：' + report.schemas.distinct + ' 个（模拟调用 ' + report.schemas.capturedCalls + ' 次），全部合法：' + report.schemas.allValid);
    for (const item of report.schemas.checked) {
      console.log('  ' + (item.violations.length === 0 ? 'OK  ' : 'FAIL') + ' ' + item.label + (item.violations.length === 0 ? '' : ' :: ' + item.violations.join(' | ')));
    }
    if (report.schemas.payloadError !== null) { console.log('  PAYLOAD_ERROR ' + report.schemas.payloadError); }
  }
  const outIndex = process.argv.indexOf('--out');
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    writeFileSync(process.argv[outIndex + 1], JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (report.verdict === 'PASS') { process.exit(0); }
  if (report.verdict === 'MISMATCH') { process.exit(10); }
  if (report.verdict === 'SCHEMA_INVALID') { process.exit(11); }
  if (report.verdict === 'MISMATCH_AND_SCHEMA_INVALID') { process.exit(12); }
  process.exit(13);
}
