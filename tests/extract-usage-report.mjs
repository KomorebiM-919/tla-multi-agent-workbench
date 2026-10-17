#!/usr/bin/env node
/**
 * 离线用量提取器：只读 DSH 会话日志，汇总本次 workflow 的真实 token 用量。
 *
 * 为什么需要它（m10329 §二）：
 * - v0.2-run2 批准 8 次子代理调用、实际 10 次。要复盘"多花了多少"，必须能**离线、可复算**地
 *   按真实 childSessionId 汇总用量；靠人工抄聊天窗口里的数字不是证据。
 * - 宿主日志里没有 price/cost/billing 字段，所以本工具只报 token，不报货币成本（显示"未提供价格"）。
 *
 * 三条硬约束（都在代码里落实，不是注释口号）：
 * 1. 只读：不写会话日志、不联网、不读凭据、不调用模型。
 * 2. 不确定就说不确定：缺日志 / 坏帧 / 坏行 / 缺 usage → 覆盖不完整（INCOMPLETE），
 *    **绝不**输出"在预算内"。
 * 3. 确定性报告与易变元数据分开写：`usage-report.json` 不含提取时刻，同输入必得同字节；
 *    `extraction-metadata.json` 才放提取时间、耗时、文件指纹等易变信息。
 *
 * 用法：
 *   node tests/extract-usage-report.mjs \
 *     --run-id v0.2-run2-20261017T133204Z \
 *     --run-record docs/run-records/v0.2-run2-20261017T133204Z \
 *     --out-dir docs/run-records/v0.2-run2-20261017T133204Z/usage \
 *     [--session-root <dir>] [--declared-budget <json>] [--include-parent] [--json]
 *
 * 退出码：0 报告已生成（覆盖可能不完整，看 coverage.status）；4 参数错误；5 IO 错误。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const TOOL = 'tests/extract-usage-report.mjs';
const TOOL_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const DERIVATION_TOOL_NAMES = ['subagent', 'workflow', 'task', 'subagent_fork'];
const LOG_NAME = 'session.v4.jsonl.zstd';

// ---------------------------------------------------------------- 参数

function usage(message) {
  process.stderr.write(message + '\n');
  process.exit(4);
}

function parseArgs(argv) {
  const options = {
    runId: null, runRecord: null, evidenceDir: null, outDir: null,
    sessionRoot: null, declaredBudget: null, sessionMap: null,
    includeParent: false, json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = function () {
      const value = argv[i + 1];
      if (value === undefined) { usage('缺少 ' + flag + ' 的值'); }
      i += 1;
      return value;
    };
    if (flag === '--run-id') { options.runId = next(); }
    else if (flag === '--run-record') { options.runRecord = next(); }
    else if (flag === '--evidence-dir') { options.evidenceDir = next(); }
    else if (flag === '--out-dir') { options.outDir = next(); }
    else if (flag === '--session-root') { options.sessionRoot = next(); }
    else if (flag === '--declared-budget') { options.declaredBudget = next(); }
    else if (flag === '--session-map') { options.sessionMap = next(); }
    else if (flag === '--include-parent') { options.includeParent = true; }
    else if (flag === '--json') { options.json = true; }
    else { usage('未知参数：' + flag); }
  }
  if (!options.runId) { usage('必须给 --run-id'); }
  return options;
}

// ---------------------------------------------------------------- 日志解码

/** 逐帧解开 zstd 会话日志（帧头按魔数定位；尾部未写完的帧忽略但记录）。 */
function decompressAllFrames(buffer) {
  const offsets = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) { offsets.push(i); }
  }
  const parts = [];
  let failedFrames = 0;
  offsets.forEach(function (offset) {
    try { parts.push(zstdDecompressSync(buffer.subarray(offset))); } catch { failedFrames += 1; }
  });
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, failedFrames: failedFrames };
}

/**
 * 读一个会话日志：支持 zstd 多帧与纯 JSONL（合成日志用纯文本，便于测试）。
 * 坏行不丢弃静默：返回 badLines 让覆盖判定能把"不完整"说清楚。
 */
function readLog(file) {
  const raw = readFileSync(file);
  const looksZstd = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC);
  const decoded = looksZstd ? decompressAllFrames(raw) : { text: raw.toString('utf8'), frames: 0, failedFrames: 0 };
  const records = [];
  const badLines = [];
  decoded.text.split('\n').forEach(function (line, index) {
    const text = line.trim();
    if (text === '') { return; }
    try { records.push(JSON.parse(text)); } catch { badLines.push(index + 1); }
  });
  return {
    records: records, badLines: badLines, frames: decoded.frames, failedFrames: decoded.failedFrames,
    sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length, compressed: looksZstd
  };
}

/** 递归列出会话目录下的日志文件（`<root>/<group>/<session>/session.v4.jsonl.zstd`）。 */
function listLogFiles(root) {
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.forEach(function (entry) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); return; }
      if (entry.isFile() && (entry.name === LOG_NAME || entry.name.endsWith('.jsonl'))) { files.push(full); }
    });
  }
  walk(root);
  return files.sort();
}

function sessionRootOf(options) {
  if (options.sessionRoot) { return options.sessionRoot; }
  const home = process.env.DSH_HOME || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : null);
  if (!home) { usage('没有 --session-root，也找不到 DSH_HOME'); }
  return join(home, 'sessions');
}

// ---------------------------------------------------------------- 路径脱敏

/**
 * 会话日志在用户主目录下（`<DSH_HOME>/sessions/<group>/<session>/session.v4.jsonl.zstd`），
 * 绝对路径里带着本机用户名；而 `<group>` 目录名是 DSH 按 cwd 编码出来的
 * （形如 `--C-Users-<用户名>-Documents-...`），它同时泄露用户名与其他工作区的名字。
 * 报告要提交进公开仓库，因此只保留能定位会话的部分：`<DSH_HOME>/sessions/<group>/session-<id>/文件名`
 * ——组名替换成占位符，会话 id 保留（归因与复算靠它，不靠目录名）。
 * 不在会话根之下的路径只保留文件名。
 */
function displayPath(file, sessionRoot) {
  const normalizedRoot = sessionRoot.split(sep).join('/');
  const normalizedFile = file.split(sep).join('/');
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/';
  if (normalizedFile.indexOf(prefix) === 0) {
    const parts = normalizedFile.slice(prefix.length).split('/');
    if (parts.length >= 2) {
      parts[0] = '<group>';
    }
    return '<DSH_HOME>/sessions/' + parts.join('/');
  }
  const parts = normalizedFile.split('/');
  return '<外部路径>/' + parts[parts.length - 1];
}

// ---------------------------------------------------------------- 字段语义辅助

/** 三态：缺字段 / null / 明确的 0 / 有值。0 与"没上报"绝不能混为一谈。 */
function stateOf(container, field) {
  if (!container || typeof container !== 'object') { return 'absent-container'; }
  if (!Object.prototype.hasOwnProperty.call(container, field)) { return 'absent'; }
  const value = container[field];
  if (value === null) { return 'null'; }
  if (value === 0) { return 'zero'; }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) { return 'value'; }
  return 'invalid';
}

function sumOf(list) {
  return list.reduce(function (total, value) { return total + value; }, 0);
}

function isoOf(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort();
}

/** 把 derived / unattributed 条目里的 usage 汇总（缺 usage 时按 0 计，但条目本身仍保留）。 */
function sumUsage(entries) {
  const usages = entries.map(function (entry) { return entry.usage || {}; });
  return {
    messages: sumOf(entries.map(function (entry) { return typeof entry.messages === 'number' ? entry.messages : 0; })),
    totalTokens: sumOf(usages.map(function (usage) { return typeof usage.totalTokens === 'number' ? usage.totalTokens : 0; }))
  };
}

// ---------------------------------------------------------------- 会话分析

/**
 * 汇总一个会话日志。
 * 口径：`assistant/message` 记录的 `data.usage` 是**每次模型响应**的用量（不是累计值）——
 * 但这一点必须由数据本身佐证：若 `sum === last`（多消息时），更像累计口径，标 unknown。
 */
function summarizeSession(entry, logInfo, relativePath) {
  const records = logInfo.records;
  const header = records.find(function (record) { return record && record.type === 'session'; }) || null;
  const messages = records.filter(function (record) { return record && record.type === 'assistant/message'; });
  const fieldStates = {};
  USAGE_FIELDS.forEach(function (field) { fieldStates[field] = { value: 0, zero: 0, null: 0, absent: 0, invalid: 0 }; });
  let missingUsage = 0;
  const inputTokens = [];
  const outputTokens = [];
  const cacheRead = [];
  const cacheWrite = [];
  const totals = [];
  const providers = [];
  const models = [];
  const turns = [];
  const steps = [];
  const timestamps = [];
  const ids = [];
  let identityChecked = 0;
  let identityMatched = 0;
  messages.forEach(function (record) {
    const data = record.data || {};
    const usageBlock = data.usage;
    if (!usageBlock || typeof usageBlock !== 'object') { missingUsage += 1; return; }
    USAGE_FIELDS.forEach(function (field) {
      const state = stateOf(usageBlock, field);
      const bucket = fieldStates[field];
      if (state === 'value') { bucket.value += 1; } else if (state === 'zero') { bucket.zero += 1; } else if (state === 'null') { bucket.null += 1; } else if (state === 'invalid') { bucket.invalid += 1; } else { bucket.absent += 1; }
    });
    if (typeof usageBlock.inputTokens === 'number') { inputTokens.push(usageBlock.inputTokens); }
    if (typeof usageBlock.outputTokens === 'number') { outputTokens.push(usageBlock.outputTokens); }
    if (typeof usageBlock.cacheReadTokens === 'number') { cacheRead.push(usageBlock.cacheReadTokens); }
    if (typeof usageBlock.cacheWriteTokens === 'number') { cacheWrite.push(usageBlock.cacheWriteTokens); }
    if (typeof usageBlock.totalTokens === 'number') { totals.push(usageBlock.totalTokens); }
    if (typeof usageBlock.inputTokens === 'number' && typeof usageBlock.totalTokens === 'number') {
      identityChecked += 1;
      const components = usageBlock.inputTokens + (usageBlock.cacheReadTokens || 0) + (usageBlock.cacheWriteTokens || 0) + (usageBlock.outputTokens || 0);
      if (components === usageBlock.totalTokens) { identityMatched += 1; }
    }
    const source = data.message && data.message.source;
    if (source && typeof source.provider === 'string') { providers.push(source.provider); }
    if (source && typeof source.model === 'string') { models.push(source.model); }
    if (typeof data.turn === 'number') { turns.push(data.turn); }
    if (typeof data.step === 'number') { steps.push(data.step); }
    if (typeof record.time === 'number') { timestamps.push(record.time); }
    const toolCalls = (data.message && Array.isArray(data.message.content))
      ? data.message.content.filter(function (part) { return part && part.type === 'tool-call'; })
      : [];
    toolCalls.forEach(function (call) { if (typeof call.id === 'string') { ids.push(call.id); } });
  });

  // 重复 / 重试信号：同一 (turn, step) 出现多次、tool-call id 重复、连续完全相同 usage。
  const turnStepSeen = new Map();
  const duplicateTurnStep = [];
  messages.forEach(function (record) {
    const data = record.data || {};
    const key = String(data.turn) + '/' + String(data.step);
    if (turnStepSeen.has(key)) { duplicateTurnStep.push(key); } else { turnStepSeen.set(key, true); }
  });
  const seqs = records.map(function (record) { return record.seq; }).filter(function (value) { return typeof value === 'number'; });
  const duplicateSeq = seqs.filter(function (value, index) { return seqs.indexOf(value) !== index; });
  const idCounts = new Map();
  ids.forEach(function (id) { idCounts.set(id, (idCounts.get(id) || 0) + 1); });
  const replayedToolCallIds = Array.from(idCounts.entries()).filter(function (pair) { return pair[1] > 1; }).map(function (pair) { return pair[0]; }).sort();
  let identicalConsecutive = 0;
  for (let i = 1; i < totals.length; i += 1) {
    if (totals[i] === totals[i - 1] && totals[i] > 0) { identicalConsecutive += 1; }
  }

  // 口径启发式：多消息时若 sum === last，更像累计；若单调不减且 sum 明显大于 last，更像逐请求。
  let nonDecreasing = true;
  for (let i = 1; i < totals.length; i += 1) { if (totals[i] < totals[i - 1]) { nonDecreasing = false; break; } }
  const sum = sumOf(totals);
  const last = totals.length > 0 ? totals[totals.length - 1] : 0;
  let heuristic = 'unknown';
  let heuristicNote = '消息数不足，无法从日志判断 usage 是逐请求还是累计';
  if (totals.length > 1) {
    if (sum === last) { heuristic = 'cumulative-likely'; heuristicNote = '最后一条的 totalTokens 等于总和，符合累计口径'; }
    else if (nonDecreasing && sum > last) { heuristic = 'per-request-likely'; heuristicNote = '单调不减且总和大于最后一条，符合逐请求口径'; }
    else { heuristicNote = '既不等于总和也不单调，口径不明'; }
  }

  const sequences = records
    .filter(function (record) { return record && record.type === 'assistant/message'; })
    .map(function (record) {
      const data = record.data || {};
      return { turn: data.turn === undefined ? null : data.turn, step: data.step === undefined ? null : data.step, totalTokens: data.usage && typeof data.usage.totalTokens === 'number' ? data.usage.totalTokens : null };
    });

  return {
    seq: entry.seq === undefined ? null : entry.seq,
    label: entry.label || null,
    phase: entry.phase || null,
    attempt: entry.attempt === undefined ? null : entry.attempt,
    attribution: entry.attribution || (entry.label ? 'recorded' : 'unknown'),
    sessionId: header && typeof header.id === 'string' ? header.id : entry.sessionId,
    parentSession: header && typeof header.parentSession === 'string' ? header.parentSession : null,
    origin: header && typeof header.origin === 'string' ? header.origin : null,
    delegationDepth: header && typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
    agentPreset: header && typeof header.agentPreset === 'string' ? header.agentPreset : null,
    createdAt: header ? isoOf(header.createdAt) : null,
    provider: providers.length > 0 ? sortedUnique(providers).join(',') : (entry.model && entry.model.provider) || null,
    model: models.length > 0 ? sortedUnique(models).join(',') : (entry.model && entry.model.model) || null,
    providers: sortedUnique(providers),
    models: sortedUnique(models),
    messages: messages.length,
    messagesWithUsage: messages.length - missingUsage,
    messagesMissingUsage: missingUsage,
    usage: {
      inputTokens: sumOf(inputTokens),
      outputTokens: sumOf(outputTokens),
      cacheReadTokens: sumOf(cacheRead),
      cacheWriteTokens: sumOf(cacheWrite),
      totalTokens: sumOf(totals)
    },
    fieldStates: fieldStates,
    usageSemantics: { heuristic: heuristic, note: heuristicNote, sumOfTotalTokens: sum, lastTotalTokens: last, nonDecreasing: nonDecreasing, sequence: sequences },
    duplicates: {
      duplicateSeq: sortedUnique(duplicateSeq),
      duplicateTurnStep: sortedUnique(duplicateTurnStep),
      replayedToolCallIds: replayedToolCallIds,
      identicalConsecutiveTotals: identicalConsecutive
    },
    identityCheck: { checked: identityChecked, matched: identityMatched, mismatched: identityChecked - identityMatched },
    firstMessageAt: timestamps.length > 0 ? isoOf(Math.min.apply(null, timestamps)) : null,
    lastMessageAt: timestamps.length > 0 ? isoOf(Math.max.apply(null, timestamps)) : null,
    log: { path: relativePath, bytes: logInfo.bytes, compressed: logInfo.compressed, frames: logInfo.frames, failedFrames: logInfo.failedFrames, badLines: logInfo.badLines.length, sha256: logInfo.sha256 },
    derivation: derivationOf(records)
  };
}

/** 检测本会话内是否又派生了子代理：能发现"再派生"这件事本身，但不解析其会话 id。 */
function derivationOf(records) {
  const calls = records.filter(function (record) { return record && record.type === 'tool/call' && record.data && DERIVATION_TOOL_NAMES.indexOf(record.data.name) !== -1; });
  return {
    possible: calls.length > 0,
    count: calls.length,
    tools: sortedUnique(calls.map(function (record) { return record.data.name; })),
    note: calls.length > 0 ? '本会话内出现派生工具调用；其子会话 id 未在日志中解析，若存在则本报告未计入' : null
  };
}

// ---------------------------------------------------------------- 归因来源

/** 会话 id 归一化：日志头里的 parentSession 带 `session-` 前缀，子代理 id 不带。 */
function bareSessionId(value) {
  if (typeof value !== 'string') { return null; }
  return value.replace(/^session-/, '');
}

/** 读运行记录里的 native-events.json：真实 childSessionId → label/phase/seq。 */
function readRunRecord(runRecordDir) {
  const file = join(runRecordDir, 'native-events.json');
  if (!existsSync(file)) { return null; }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const calls = Array.isArray(parsed.agentCalls) ? parsed.agentCalls : [];
  const bySession = new Map();
  calls.forEach(function (call) {
    if (call && typeof call.childSessionId === 'string') {
      bySession.set(bareSessionId(call.childSessionId), {
        seq: call.seq, label: call.label, phase: call.phase, model: call.model,
        parentSession: call.childParentSession, attribution: 'native-events'
      });
    }
  });
  return {
    file: file,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    workflowName: parsed.workflowRun && parsed.workflowRun.name ? parsed.workflowRun.name : null,
    runId: parsed.workflowRun && parsed.workflowRun.runId ? parsed.workflowRun.runId : null,
    parentSession: parsed.extraction && parsed.extraction.parentSession ? parsed.extraction.parentSession : null,
    startedAt: parsed.workflowRun ? parsed.workflowRun.startedAt || null : null,
    endedAt: parsed.workflowRun ? parsed.workflowRun.endedAt || null : null,
    agentCallCount: calls.length,
    bySession: bySession
  };
}

/** 兼容合成测试：直接给 {parentSessionId, sessions:[{sessionId,label,phase,attempt}]}。 */
function readSessionMap(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map();
  (parsed.sessions || []).forEach(function (item) {
    map.set(bareSessionId(item.sessionId), {
      seq: item.seq, label: item.label || null, phase: item.phase || null, attempt: item.attempt,
      model: item.model || null, parentSession: parsed.parentSessionId || null, attribution: 'session-map'
    });
  });
  return {
    parentSession: parsed.parentSessionId || null, bySession: map,
    agentCallCount: (parsed.sessions || []).length, workflowName: parsed.workflowName || null,
    startedAt: parsed.startedAt || null, endedAt: parsed.endedAt || null
  };
}

// ---------------------------------------------------------------- 预算判定

/**
 * 预算判定：只有"运行前已声明的预算"才能做事后超限判断。
 * 未声明 → NO_BUDGET_DECLARED（不是"在预算内"）；覆盖不完整 → INCOMPLETE（也不等于在预算内）。
 * 调用次数超限是可从记录直接判定的事实，即使覆盖不完整也照样报 OVER_BUDGET。
 */
function budgetSection(declared, counts, coverageComplete) {
  if (!declared) {
    return {
      declared: false, verdict: 'NO_BUDGET_DECLARED',
      reasons: ['运行前没有声明预算：事后无法判定"是否超限"，只能报用量'],
      declaredBudget: null
    };
  }
  const reasons = [];
  let over = false;
  if (typeof declared.maxAgentCalls === 'number') {
    const started = counts.observedCallSessions;
    if (started > declared.maxAgentCalls) {
      over = true;
      reasons.push('观察到的子会话数 ' + started + ' 超过声明上限 ' + declared.maxAgentCalls +
        '（超出 ' + (started - declared.maxAgentCalls) + ' 个）');
    } else {
      reasons.push('观察到的子会话数 ' + started + ' 未超过声明上限 ' + declared.maxAgentCalls);
    }
    if (typeof counts.recordedCalls === 'number' && counts.recordedCalls !== started) {
      reasons.push('调用记录里有 ' + counts.recordedCalls + ' 次调用，但找到 ' + started + ' 个子会话日志：两者不一致，以日志为准并判覆盖不完整');
    }
  } else {
    reasons.push('声明里没有 maxAgentCalls：调用次数未受预算约束');
  }
  if (typeof declared.maxTotalTokens === 'number') {
    if (!coverageComplete) {
      reasons.push('覆盖不完整，token 总量不能与声明上限比较');
    } else if (counts.runTotalTokens > declared.maxTotalTokens) {
      over = true;
      reasons.push('token 总量 ' + counts.runTotalTokens + ' 超过声明上限 ' + declared.maxTotalTokens);
    } else {
      reasons.push('token 总量 ' + counts.runTotalTokens + ' 未超过声明上限 ' + declared.maxTotalTokens);
    }
  } else {
    reasons.push('声明里没有 maxTotalTokens：只判定调用次数，不判定 token 量');
  }
  let verdict;
  if (over) { verdict = 'OVER_BUDGET'; }
  else if (!coverageComplete) { verdict = 'INCOMPLETE'; reasons.push('覆盖不完整：不得判定为在预算内'); }
  else { verdict = 'WITHIN_BUDGET'; }
  return { declared: true, verdict: verdict, reasons: reasons, declaredBudget: declared };
}

// ---------------------------------------------------------------- 主流程

function stableReport(input) {
  // 键顺序固定（不用 sort_keys 的等价物，直接按构建顺序序列化），保证同输入同字节。
  return JSON.stringify(input, null, 2) + '\n';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const outDir = options.outDir || join('docs', 'run-records', options.runId, 'usage');
  const sessionRoot = sessionRootOf(options);

  let attribution = null;
  if (options.sessionMap) { attribution = readSessionMap(options.sessionMap); }
  else if (options.runRecord) { attribution = readRunRecord(options.runRecord); }

  const logFiles = listLogFiles(sessionRoot);
  const sessions = [];
  const derived = [];
  const unattributed = [];
  const badLogs = [];
  const seenIds = new Set();
  const childIds = attribution ? new Set(attribution.bySession.keys()) : new Set();
  const parentId = attribution ? bareSessionId(attribution.parentSession) : null;
  // 父会话同时承载别的任务，所以"父会话是本运行父会话"不足以证明属于本运行——
  // 还必须落在运行窗口内（前后各留 60 秒余量），否则会把这台机器上别的子代理算进来。
  const WINDOW_SLACK_MS = 60000;
  const windowStartMs = attribution && attribution.startedAt ? Date.parse(attribution.startedAt) : NaN;
  const windowEndMs = attribution && attribution.endedAt ? Date.parse(attribution.endedAt) : NaN;
  const windowKnown = Number.isFinite(windowStartMs) && Number.isFinite(windowEndMs);
  function withinRunWindow(createdAtMs) {
    if (!windowKnown || typeof createdAtMs !== 'number') { return false; }
    return createdAtMs >= windowStartMs - WINDOW_SLACK_MS && createdAtMs <= windowEndMs + WINDOW_SLACK_MS;
  }
  let ignoredSessions = 0;

  logFiles.forEach(function (file) {
    let logInfo;
    try { logInfo = readLog(file); } catch (error) {
      badLogs.push({ path: displayPath(file, sessionRoot), reason: '读取失败：' + error.message });
      return;
    }
    const header = logInfo.records.find(function (record) { return record && record.type === 'session'; });
    if (!header || typeof header.id !== 'string') {
      badLogs.push({ path: displayPath(file, sessionRoot), reason: '日志没有 session 头（无法确定会话 id）' });
      return;
    }
    const sessionId = bareSessionId(header.id);
    if (seenIds.has(sessionId)) { badLogs.push({ path: displayPath(file, sessionRoot), reason: '同一会话 id 出现两个日志文件' }); return; }
    seenIds.add(sessionId);
    const relativePath = displayPath(file, sessionRoot);
    const known = attribution && attribution.bySession.get(sessionId);
    const isParent = parentId !== null && sessionId === parentId;
    const parentOfThis = header.parentSession ? bareSessionId(header.parentSession) : null;
    const createdAtMs = typeof header.createdAt === 'number' ? header.createdAt : NaN;
    const derivedFromRun = parentOfThis !== null && childIds.has(parentOfThis);
    const childOfRunParent = parentOfThis !== null && parentOfThis === parentId;
    // 作用域：本运行的父会话、已归因的子会话、以及落在运行窗口内的再派生/漏记会话。
    const inScope = isParent || known !== undefined || derivedFromRun ||
      (childOfRunParent && withinRunWindow(createdAtMs));
    if (!inScope) { ignoredSessions += 1; return; }
    if (isParent && !options.includeParent) { return; }
    if (isParent) {
      const parentSummary = summarizeSession({ sessionId: header.id, attribution: 'parent-session' }, logInfo, relativePath);
      parentSummary.countedInRun = false;
      sessions.push(parentSummary);
      return;
    }
    if (known) {
      sessions.push(summarizeSession(Object.assign({ sessionId: header.id, attribution: 'native-events' }, known), logInfo, relativePath));
      return;
    }
    // 未归因但在作用域内：父会话是某个子会话 → 再派生；父会话就是本运行父会话且在窗口内 → 漏记的调用。
    const entry = {
      sessionId: header.id, parentSession: header.parentSession || null,
      createdAt: isoOf(header.createdAt), origin: header.origin || null,
      delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
      attribution: 'unknown'
    };
    const bucket = derivedFromRun ? derived : unattributed;
    // 再派生与漏记会话也必须计入用量，否则"实际花了多少"会被低估：标 unknown 归因，单独列出。
    const summary = summarizeSession({
      sessionId: header.id, attribution: derivedFromRun ? 'derived' : 'unattributed',
      seq: null, label: null, phase: null, model: null
    }, logInfo, relativePath);
    summary.countedInRun = true;
    entry.usage = summary.usage;
    entry.messages = summary.messages;
    bucket.push(entry);
  });

  sessions.sort(function (a, b) {
    const seqA = a.seq === null ? 1e9 : a.seq;
    const seqB = b.seq === null ? 1e9 : b.seq;
    if (seqA !== seqB) { return seqA - seqB; }
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  const missingSessions = attribution
    ? Array.from(attribution.bySession.keys()).filter(function (id) { return !seenIds.has(id); }).sort()
    : [];
  const withoutUsage = sessions.filter(function (session) { return session.messagesWithUsage === 0 || session.messagesMissingUsage > 0; })
    .map(function (session) { return session.sessionId; });
  const problems = [];
  if (badLogs.length > 0) { problems.push('有日志无法解析：' + badLogs.length + ' 个'); }
  if (logFiles.length === 0) { problems.push('会话目录下没有任何日志文件'); }
  if (missingSessions.length > 0) { problems.push('已归因的子会话缺少日志：' + missingSessions.join(', ')); }
  if (withoutUsage.length > 0) { problems.push('有会话缺少 usage 或部分消息缺 usage：' + withoutUsage.join(', ')); }
  if (!attribution) { problems.push('没有归因来源（--run-record 或 --session-map）：无法确认这些会话属于本次运行'); }
  if (unattributed.length > 0) { problems.push('有属于本运行但未在调用记录里的子会话：' + unattributed.length + ' 个（用量单独列出，未并入已归因合计）'); }
  if (derived.length > 0) { problems.push('存在再派生子会话：' + derived.length + ' 个（用量单独列出，无法归因到某次调用）'); }
  if (attribution && !windowKnown) { problems.push('运行记录里没有可用的起止时间：无法判断未归因会话是否属于本次运行'); }
  const coverageComplete = problems.length === 0;
  const derivedUsage = sumUsage(derived);
  const unattributedUsage = sumUsage(unattributed);

  const declared = options.declaredBudget ? JSON.parse(readFileSync(options.declaredBudget, 'utf8')) : null;
  const totals = {
    sessions: sessions.length,
    messages: sumOf(sessions.map(function (session) { return session.messages; })),
    messagesWithUsage: sumOf(sessions.map(function (session) { return session.messagesWithUsage; })),
    messagesMissingUsage: sumOf(sessions.map(function (session) { return session.messagesMissingUsage; })),
    inputTokens: sumOf(sessions.map(function (session) { return session.usage.inputTokens; })),
    outputTokens: sumOf(sessions.map(function (session) { return session.usage.outputTokens; })),
    cacheReadTokens: sumOf(sessions.map(function (session) { return session.usage.cacheReadTokens; })),
    cacheWriteTokens: sumOf(sessions.map(function (session) { return session.usage.cacheWriteTokens; })),
    totalTokens: sumOf(sessions.map(function (session) { return session.usage.totalTokens; }))
  };
  totals.sumOfComponents = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  totals.componentsMatchTotalTokens = totals.sumOfComponents === totals.totalTokens;
  // 三种归因分开报：并入前两类会让"某次调用的用量"与"本次运行的真实总花费"混为一谈。
  totals.buckets = {
    attributed: { sessions: sessions.length, messages: totals.messages, totalTokens: totals.totalTokens },
    derived: { sessions: derived.length, messages: sumUsage(derived).messages, totalTokens: derivedUsage.totalTokens },
    unattributed: { sessions: unattributed.length, messages: unattributedUsage.messages, totalTokens: unattributedUsage.totalTokens }
  };
  totals.runTotalTokens = totals.totalTokens + derivedUsage.totalTokens + unattributedUsage.totalTokens;

  const identity = {
    checked: sumOf(sessions.map(function (session) { return session.identityCheck.checked; })),
    matched: sumOf(sessions.map(function (session) { return session.identityCheck.matched; }))
  };
  identity.mismatched = identity.checked - identity.matched;

  const cacheWriteStates = sessions.map(function (session) { return session.fieldStates.cacheWriteTokens; });
  const cacheWriteReportedZeroOnly = cacheWriteStates.length > 0 && cacheWriteStates.every(function (state) { return state.value === 0 && state.absent === 0 && state.null === 0; });

  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    run: {
      runId: options.runId,
      workflowName: attribution ? attribution.workflowName || null : null,
      evidenceDir: options.evidenceDir || null,
      runRecordDir: options.runRecord || null,
      parentSessionId: parentId,
      agentCallCountFromRecord: attribution ? attribution.agentCallCount : null
    },
    scope: {
      sessionRoot: '<DSH_HOME>/sessions',
      includeParent: options.includeParent,
      attributedBy: attribution ? (options.sessionMap ? 'session-map' : 'native-events') : 'none',
      attributionSourceSha256: attribution && attribution.sha256 ? attribution.sha256 : null
    },
    coverage: {
      status: coverageComplete ? 'complete' : 'incomplete',
      problems: problems,
      logFiles: logFiles.length,
      sessionsCounted: sessions.length,
      ignoredSessions: ignoredSessions,
      runWindow: windowKnown
        ? { start: new Date(windowStartMs).toISOString(), end: new Date(windowEndMs).toISOString(), slackMs: WINDOW_SLACK_MS,
          basis: '父会话同时承载其他任务，只有落在窗口内且父会话是本运行会话的未归因会话才算漏记' }
        : { start: null, end: null, slackMs: WINDOW_SLACK_MS, basis: '运行窗口未知：只统计已归因会话，未归因会话无法判断归属' },
      expectedSessionIds: attribution ? Array.from(attribution.bySession.keys()).sort() : [],
      missingSessionIds: missingSessions,
      sessionsWithoutCompleteUsage: withoutUsage,
      badLogs: badLogs,
      derivedSessions: derived,
      unattributedSessions: unattributed,
      note: coverageComplete
        ? '每个已归因的子会话都有可解析日志，且每条 assistant/message 都带 usage'
        : '覆盖不完整：本报告的合计值只覆盖已解析部分，不能当作本次运行的全部用量'
    },
    fieldSemantics: {
      usagePath: 'assistant/message → data.usage',
      fields: USAGE_FIELDS,
      perFieldStates: aggregateFieldStates(sessions),
      totalIdentity: {
        rule: 'totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens',
        checked: identity.checked, matched: identity.matched, mismatched: identity.mismatched
      },
      perRequestOrCumulative: 'unknown-until-heuristic-says-otherwise',
      heuristicNote: '逐会话给出 heuristic（per-request-likely / cumulative-likely / unknown）；证据不足时保持 unknown',
      cacheWriteZero: {
        sessionsReportingZeroOnly: cacheWriteReportedZeroOnly,
        interpretation: '0 是"显式上报的 0"，不能推断 provider 不支持上报该字段，也不能推断缓存写入不产生费用'
      },
      inputCacheReadIndependence: 'unknown',
      inputCacheReadNote: '不假设 inputTokens 与 cacheReadTokens 互不重叠：本报告同时给出分项与 totalTokens 合计，两者是否可加由字段语义决定，未核实前不自行相加冒充真实总量',
      costFieldsPresent: false,
      costNote: '日志里没有 price/cost/billing 字段'
    },
    totals: totals,
    budget: budgetSection(declared, {
      observedCallSessions: sessions.filter(function (session) { return session.attribution !== 'parent-session'; }).length +
        derived.length + unattributed.length,
      recordedCalls: attribution ? attribution.agentCallCount : null,
      attributedTotalTokens: totals.totalTokens,
      runTotalTokens: totals.runTotalTokens
    }, coverageComplete),
    cost: { status: 'NOT_PROVIDED', currency: null, note: '未提供价格：价格与渠道计费未核实，本工具不输出人民币成本' },
    sessions: sessions,
    limitations: [
      '只读日志推断：日志缺字段/坏帧/缺日志时判 INCOMPLETE，不输出"在预算内"',
      'usage 是逐请求还是累计由启发式判断；未知时不做加减推断',
      'cacheWriteTokens 为 0 只表示"上报了 0"，不代表 provider 不支持该字段',
      '再派生会话单独列出：若某个子代理内部又派生了代理，其用量不在本报告的 sessions 里',
      '没有价格信息，因此没有货币成本；token 数不等于费用',
      '父会话默认排除：父会话包含与本次运行无关的对话，混入会高估用量'
    ]
  };

  const deterministic = stableReport(report);
  const metadata = stableReport({
    tool: TOOL, toolVersion: TOOL_VERSION,
    extractedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    node: process.version,
    platform: process.platform,
    // 不写本机绝对路径：仓库路径里可能带用户名，报告会进公开仓库。工作区名字足够复现。
    workspaceName: basename(process.cwd()),
    outDir: outDir,
    inputs: {
      sessionRoot: '<DSH_HOME>/sessions',
      runRecord: options.runRecord || null,
      declaredBudget: options.declaredBudget || null,
      sessionMap: options.sessionMap || null,
      logFiles: logFiles.map(function (file) {
        let size = null;
        try { size = statSync(file).size; } catch { size = null; }
        return { path: displayPath(file, sessionRoot), bytes: size };
      })
    },
    reportSha256: createHash('sha256').update(deterministic).digest('hex')
  });

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'usage-report.json'), deterministic, 'utf8');
    writeFileSync(join(outDir, 'extraction-metadata.json'), metadata, 'utf8');
  } catch (error) {
    process.stderr.write('error: 写报告失败：' + error.message + '\n');
    process.exit(5);
  }
  if (options.json) { process.stdout.write(deterministic); }
  else {
    process.stdout.write('usage-report.json: ' + sessions.length + ' 个会话，' +
      totals.messages + ' 条消息，totalTokens=' + totals.totalTokens +
      '，coverage=' + report.coverage.status + '，budget=' + report.budget.verdict + '\n');
  }
  return 0;
}

function aggregateFieldStates(sessions) {
  const aggregate = {};
  USAGE_FIELDS.forEach(function (field) {
    aggregate[field] = { value: 0, zero: 0, null: 0, absent: 0, invalid: 0 };
    sessions.forEach(function (session) {
      const state = session.fieldStates[field];
      Object.keys(aggregate[field]).forEach(function (key) { aggregate[field][key] += state[key]; });
    });
  });
  return aggregate;
}

process.exitCode = main();
