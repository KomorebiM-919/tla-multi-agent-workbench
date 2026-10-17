#!/usr/bin/env node
/**
 * tests/extract-native-events.mjs
 *
 * 从 DSH 会话日志里提取**一次工作流运行**的原生执行证据（白名单字段）。
 *
 * 为什么需要它：`docs/review/<sha>/native-events.json` 那类文件是编排层自己打印的派生摘要，
 * 不是原生证据。宿主把每次 workflow 运行与每次 `agent()` 调用都写进了父会话日志
 * （`tool-workflow/run-start|agent-start|agent-end|run-end`），子代理各自还有独立会话日志。
 * 本工具只读这些日志，抽出身份、角色、模型、时间、调用关系与"哪个会话产出了哪个阶段产物"。
 *
 * 隐私边界：不导出消息正文、系统提示词、工具结果载荷、shell 命令原文或凭据。对 shell 调用
 * 只记录"该调用是否提到某个已知产物文件名"，用于归因，不记录命令内容。
 *
 * 数据来源：`$DSH_HOME/sessions/<group>/<session>/session.v4.jsonl.zstd`
 * （JSONL 流被切成许多 zstd 帧；逐帧按魔数定位后解开）。
 *
 * 用法（仓库根目录）：
 *   node tests/extract-native-events.mjs \
 *        --parent session-3f96bf08-83ae-48d6-a239-0223d4b1c12c \
 *        --workflow-name tla-v02-run1 \
 *        --since 2026-10-17T20:14:45+08:00 \
 *        --evidence-dir docs/evidence/v0.2-run1-20261017T121445Z \
 *        --out docs/run-records/v0.2-run1-20261017T121445Z/native-events.json
 *
 * 复算：同一条命令重跑即可（日志是宿主写入的只读产物，本工具不写 sessions 目录）。
 * 退出码：0 = 派生检查全过；1 = 有检查失败（结果仍写盘）；2 = 参数或日志结构问题。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const ARTIFACT_KINDS = ['preflight', 'requirement', 'coding-report', 'verify', 'review'];
const OWNER_MARKER = '.run-owner.json';
/** 产出文件内容的工具名（不同版本命名略有差异，全部视为强归因）。 */
const WRITE_TOOL_NAMES = ['write', 'create', 'create_file', 'apply_patch', 'edit', 'multi_edit', 'str_replace_editor'];
/** 通过 shell 写文件的调用只能弱归因：只记录它提到了哪个产物文件，不记录命令原文。 */
const SHELL_TOOL_NAMES = ['pwsh', 'bash', 'shell', 'exec', 'run'];

function parseArgs(argv) {
  const out = { home: process.env.DSH_HOME || null, parent: null, workflowName: null, since: null, evidenceDir: null, scriptFile: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--home') out.home = argv[++i];
    else if (key === '--parent') out.parent = argv[++i];
    else if (key === '--workflow-name') out.workflowName = argv[++i];
    else if (key === '--since') out.since = argv[++i];
    else if (key === '--evidence-dir') out.evidenceDir = argv[++i];
    else if (key === '--script-file') out.scriptFile = argv[++i];
    else if (key === '--out') out.out = argv[++i];
    else throw new Error('unknown argument: ' + key);
  }
  if (!out.home || !out.parent || !out.workflowName || !out.since || !out.evidenceDir || !out.out) {
    throw new Error('usage: --parent <session> --workflow-name <name> --since <ISO> --evidence-dir <dir> --out <file> [--home <dir>]');
  }
  return out;
}

/** 逐帧解开一个会话日志（帧头按 zstd 魔数定位）。 */
function decompressAllFrames(buffer) {
  const offsets = [];
  for (let i = 0; i <= buffer.length - 4; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i);
  }
  const parts = [];
  for (const offset of offsets) {
    try { parts.push(zstdDecompressSync(buffer.subarray(offset))); } catch { /* 未写完的尾帧 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

function readRecords(file) {
  const text = decompressAllFrames(readFileSync(file));
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* 撕裂的尾行 */ }
  }
  return records;
}

function normalizePath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : null;
}

/** 只保留仓库相对形态，绝不导出用户主目录或账号标识。 */
function scrubPath(value, cwd) {
  if (typeof value !== 'string') return null;
  let out = normalizePath(value);
  const cwdPosix = normalizePath(cwd || '');
  if (cwdPosix) {
    out = out.split(cwdPosix).join('<repo>');
    out = out.split(normalizePath(process.cwd())).join('<repo>');
  }
  return out.replace(/^[A-Za-z]:\/+Users\/+[^/]+/i, '<home>');
}

function isoOf(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : null; }

/** 找出所有会话日志文件（不依赖分组目录名）。 */
function listSessionFiles(home) {
  const root = join(home, 'sessions');
  const files = [];
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const sessionDir of readdirSync(groupDir)) {
      const candidate = join(groupDir, sessionDir, 'session.v4.jsonl.zstd');
      try { if (statSync(candidate).isFile()) files.push(candidate); } catch { /* 该目录没有会话日志 */ }
    }
  }
  return files;
}

/** 只保留白名单字段的会话摘要。 */
function summarizeSession(records, cwd, artifactNames) {
  let model = null;
  let sandbox = null;
  let approval = null;
  let title = null;
  let firstTime = null;
  let lastTime = null;
  const turns = new Set();
  const steps = new Set();
  const toolCalls = [];
  for (const record of records) {
    if (typeof record.time === 'number') {
      firstTime = firstTime === null ? record.time : Math.min(firstTime, record.time);
      lastTime = lastTime === null ? record.time : Math.max(lastTime, record.time);
    }
    const data = record.data || {};
    if (record.type === 'request/context') {
      model = { provider: data.provider ?? null, model: data.model ?? null, contextWindow: data.contextWindow ?? null };
    } else if (record.type === 'sandbox/mode') {
      sandbox = { mode: data.mode ?? null, source: data.source ?? null };
    } else if (record.type === 'approval/policy') {
      approval = { policy: data.policy ?? null, source: data.source ?? null };
    } else if (record.type === 'session/title' && typeof data.title === 'string') {
      title = data.title.slice(0, 60);
    } else if (record.type === 'turn/start') {
      turns.add(data.turn);
    } else if (record.type === 'step/start') {
      steps.add(String(data.turn) + '/' + String(data.step));
    } else if (record.type === 'tool/call') {
      const raw = typeof data.arguments === 'string' ? data.arguments : '';
      let target = null;
      try {
        const parsed = JSON.parse(raw || '{}');
        const pathLike = parsed.file_path ?? parsed.path ?? null;
        if (typeof pathLike === 'string') target = scrubPath(pathLike, cwd);
      } catch { target = null; }
      // shell 调用只保留"提到了哪些已知产物"，不保留命令原文
      const mentions = SHELL_TOOL_NAMES.indexOf(data.name) === -1
        ? []
        : artifactNames.filter(function (name) { return raw.indexOf(name) !== -1; });
      toolCalls.push({
        callId: data.callId ?? null,
        name: data.name ?? null,
        at: isoOf(record.time),
        target: target,
        artifactMentions: mentions
      });
    }
  }
  return {
    model: model, sandbox: sandbox, approval: approval, titlePrefix: title,
    firstEventAt: isoOf(firstTime), lastEventAt: isoOf(lastTime),
    turnCount: turns.size, stepCount: steps.size, toolCallCount: toolCalls.length,
    toolCalls: toolCalls
  };
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sinceMs = Date.parse(args.since);
  if (Number.isNaN(sinceMs)) throw new Error('invalid --since: ' + args.since);

  const artifactNames = ARTIFACT_KINDS.map(function (kind) { return kind + '.json'; }).concat([OWNER_MARKER]);
  const files = listSessionFiles(args.home);
  const byId = new Map();
  for (const file of files) {
    let records;
    try { records = readRecords(file); } catch { continue; }
    const header = records.find(function (r) { return r.type === 'session'; });
    if (!header || typeof header.id !== 'string') continue;
    byId.set(header.id, { header: header, records: records });
  }

  const parentEntry = byId.get(args.parent);
  if (!parentEntry) throw new Error('parent session not found: ' + args.parent);
  const parentCwd = parentEntry.header.cwd ?? '';

  // 1. 父会话里的工作流运行：按名字 + 时间窗挑出**唯一**一次运行。
  const runStarts = parentEntry.records.filter(function (r) {
    return r.type === 'tool-workflow/run-start' && r.data && r.data.name === args.workflowName &&
      typeof r.time === 'number' && r.time >= sinceMs;
  });
  if (runStarts.length !== 1) {
    throw new Error('期望恰好 1 次名为 ' + args.workflowName + ' 的运行，实际 ' + runStarts.length + ' 次');
  }
  const runStart = runStarts[0];
  const runId = runStart.data.runId;
  const runEnd = parentEntry.records.find(function (r) {
    return r.type === 'tool-workflow/run-end' && r.data && r.data.runId === runId;
  });
  const agentStarts = parentEntry.records.filter(function (r) {
    return r.type === 'tool-workflow/agent-start' && r.data && r.data.runId === runId;
  });
  const agentEnds = parentEntry.records.filter(function (r) {
    return r.type === 'tool-workflow/agent-end' && r.data && r.data.runId === runId;
  });

  // 1b. 脚本指纹：从父会话里 workflow 工具的调用参数算哈希，不导出脚本文本。
  const invocations = parentEntry.records.filter(function (r) {
    return r.type === 'tool/call' && r.data && r.data.name === 'workflow' &&
      typeof r.time === 'number' && r.time <= runStart.time;
  });
  let invocation = null;
  let invocationScriptText = null;
  for (let i = invocations.length - 1; i >= 0 && invocation === null; i -= 1) {
    let parsed;
    try { parsed = JSON.parse(invocations[i].data.arguments ?? '{}'); } catch { continue; }
    if (!parsed || typeof parsed.script !== 'string') continue;
    const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
    if (meta.name !== args.workflowName) continue;
    const scriptBuffer = Buffer.from(parsed.script, 'utf8');
    invocationScriptText = parsed.script;
    invocation = {
      callId: invocations[i].data.callId ?? null,
      at: isoOf(invocations[i].time),
      metaName: meta.name ?? null,
      scriptBytes: scriptBuffer.length,
      scriptLines: parsed.script.split('\n').length,
      scriptSha256: createHash('sha256').update(scriptBuffer).digest('hex'),
      argsKeys: parsed.args && typeof parsed.args === 'object' ? Object.keys(parsed.args).sort() : [],
      argsSha256: parsed.args && typeof parsed.args === 'object'
        ? createHash('sha256').update(JSON.stringify(parsed.args)).digest('hex') : null,
      matchesRepoScript: null
    };
  }
  if (invocation && args.scriptFile) {
    const repoBuffer = readFileSync(args.scriptFile);
    const repoText = repoBuffer.toString('utf8');
    const sha = function (value) { return createHash('sha256').update(value).digest('hex'); };
    const trimOneNewline = function (value) { return value.endsWith('\n') ? value.slice(0, -1) : value; };
    invocation.repoScriptBytes = repoBuffer.length;
    invocation.repoScriptLines = repoText.split('\n').length;
    invocation.repoScriptSha256 = sha(repoBuffer);
    invocation.matchesRepoScriptExact = invocation.repoScriptSha256 === invocation.scriptSha256;
    invocation.matchesRepoScriptIgnoringTrailingNewline =
      sha(trimOneNewline(repoText)) === sha(trimOneNewline(invocationScriptText));
    invocation.byteDelta = invocation.scriptBytes - invocation.repoScriptBytes;
    invocation.matchesRepoScript =
      invocation.matchesRepoScriptExact || invocation.matchesRepoScriptIgnoringTrailingNewline;
  }

  // 2. 每次 agent() 调用 → 子会话；核对父会话与角色。
  const calls = agentStarts.slice().sort(function (a, b) { return a.data.seq - b.data.seq; }).map(function (start) {
    const end = agentEnds.find(function (e) { return e.data.seq === start.data.seq; });
    const child = byId.get(start.data.childId);
    const header = child ? child.header : null;
    const summary = child ? summarizeSession(child.records, header.cwd ?? parentCwd, artifactNames) : null;
    const strongWrites = summary ? summary.toolCalls.filter(function (c) {
      return WRITE_TOOL_NAMES.indexOf(c.name) !== -1 && typeof c.target === 'string' &&
        normalizePath(c.target).indexOf(args.evidenceDir) !== -1;
    }) : [];
    const shellMentions = summary ? summary.toolCalls.filter(function (c) {
      return c.artifactMentions.length > 0;
    }) : [];
    return {
      seq: start.data.seq,
      label: start.data.label ?? null,
      phase: start.data.phase ?? null,
      childSessionId: start.data.childId ?? null,
      startedAt: isoOf(start.time),
      endedAt: end ? isoOf(end.time) : null,
      outcome: end && end.data ? (end.data.outcome ?? null) : null,
      childFound: Boolean(child),
      childParentSession: header ? (header.parentSession ?? null) : null,
      childParentMatches: header ? header.parentSession === args.parent : false,
      childDelegationDepth: header ? (header.delegationDepth ?? null) : null,
      childAgentPreset: header ? (header.agentPreset ?? null) : null,
      childCreatedAt: header ? isoOf(header.createdAt) : null,
      model: summary ? summary.model : null,
      sandbox: summary ? summary.sandbox : null,
      approval: summary ? summary.approval : null,
      turnCount: summary ? summary.turnCount : null,
      stepCount: summary ? summary.stepCount : null,
      toolCallCount: summary ? summary.toolCallCount : null,
      writesInEvidenceDir: strongWrites.map(function (c) { return { name: c.name, target: c.target, at: c.at }; }),
      shellArtifactMentions: shellMentions.map(function (c) {
        return { name: c.name, at: c.at, artifacts: c.artifactMentions };
      })
    };
  });

  // 3. 再派生检查：子会话自己有没有再起子代理。
  const childIds = calls.map(function (c) { return c.childSessionId; }).filter(Boolean);
  const grandchildren = [];
  for (const [id, entry] of byId.entries()) {
    if (childIds.indexOf(entry.header.parentSession) !== -1) {
      grandchildren.push({ sessionId: id, parentSession: entry.header.parentSession });
    }
  }

  // 4. 阶段产物：文件指纹 + 归因（强：写工具调用；次强：mtime 落入唯一子会话活动区间）。
  const artifactPaths = ARTIFACT_KINDS.map(function (kind) { return args.evidenceDir + '/' + kind + '.json'; })
    .concat([args.evidenceDir + '/' + OWNER_MARKER]);
  const artifacts = artifactPaths.map(function (rel) {
    let sha256 = null;
    let bytes = null;
    let mtimeMs = null;
    try {
      sha256 = sha256File(rel);
      const stat = statSync(rel);
      bytes = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch { /* 文件缺失时留 null，由检查项报告 */ }
    const strong = calls.filter(function (c) {
      return c.writesInEvidenceDir.some(function (w) { return normalizePath(w.target).endsWith(rel); });
    });
    const windowMatches = mtimeMs === null ? [] : calls.filter(function (c) {
      const start = Date.parse(c.startedAt);
      const end = Date.parse(c.endedAt);
      return Number.isFinite(start) && Number.isFinite(end) && mtimeMs >= start && mtimeMs <= end;
    });
    let mechanism = 'unattributed';
    let writers = [];
    if (strong.length === 1) {
      mechanism = 'write-tool';
      writers = strong;
    } else if (strong.length === 0 && windowMatches.length === 1) {
      mechanism = 'time-window';
      writers = windowMatches;
    }
    return {
      path: rel, sha256: sha256, bytes: bytes,
      mtimeUtc: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      attribution: mechanism,
      writtenBy: writers.map(function (c) {
        return { seq: c.seq, label: c.label, childSessionId: c.childSessionId };
      })
    };
  });

  const checks = [
    { id: 'run.single', ok: runStarts.length === 1, detail: args.workflowName + ' 运行次数 = ' + runStarts.length },
    { id: 'run.completed', ok: Boolean(runEnd) && runEnd.data.stopReason === 'completed',
      detail: 'stopReason = ' + (runEnd && runEnd.data ? String(runEnd.data.stopReason) : '无 run-end') },
    { id: 'calls.count', ok: calls.length === agentStarts.length, detail: 'agent-start = ' + agentStarts.length },
    { id: 'calls.parentMatches', ok: calls.every(function (c) { return c.childParentMatches === true; }),
      detail: calls.filter(function (c) { return c.childParentMatches !== true; }).map(function (c) { return c.childSessionId; }).join(',') || '全部匹配' },
    { id: 'calls.depth', ok: calls.every(function (c) { return c.childDelegationDepth === 1; }),
      detail: calls.map(function (c) { return String(c.childDelegationDepth); }).join(',') },
    { id: 'calls.noGrandchildren', ok: grandchildren.length === 0,
      detail: grandchildren.length === 0 ? '无再派生会话' : JSON.stringify(grandchildren) },
    { id: 'calls.uniqueChildren', ok: new Set(childIds).size === childIds.length,
      detail: '子会话数 = ' + new Set(childIds).size },
    { id: 'invocation.scriptDigest', ok: Boolean(invocation) && invocation.scriptBytes > 0,
      detail: invocation ? invocation.scriptSha256 + ' (' + invocation.scriptBytes + ' B)' : '未找到 workflow 工具调用参数' },
    { id: 'invocation.scriptMatchesRepo', ok: invocation !== null && invocation.matchesRepoScript === true,
      detail: invocation === null ? '未找到 workflow 工具调用参数'
        : (invocation.matchesRepoScriptExact ? '与 ' + args.scriptFile + ' 逐字节一致'
          : (invocation.matchesRepoScriptIgnoringTrailingNewline
            ? '与 ' + args.scriptFile + ' 仅差末尾换行（脚本 ' + invocation.scriptBytes + ' B vs 文件 ' + invocation.repoScriptBytes + ' B）'
            : '与仓库脚本不一致（脚本 ' + invocation.scriptBytes + ' B vs 文件 ' + invocation.repoScriptBytes + ' B）')) },
    { id: 'artifacts.writtenByChild', ok: artifacts.every(function (a) {
      return a.sha256 !== null && a.writtenBy.length === 1;
    }), detail: artifacts.filter(function (a) { return a.writtenBy.length !== 1 || a.sha256 === null; })
      .map(function (a) { return a.path + '(writers=' + a.writtenBy.length + ',sha=' + (a.sha256 === null ? 'missing' : 'ok') + ')'; })
      .join(',') || '每个产物恰由一个子会话产出' }
  ];

  const document = {
    description: '一次工作流运行的原生执行证据（DSH 会话日志白名单提取）',
    source: 'DSH 会话日志：$DSH_HOME/sessions/<group>/<session>/session.v4.jsonl.zstd（宿主写入，本工具只读）',
    extraction: {
      script: 'tests/extract-native-events.mjs',
      method: '逐帧解 zstd；只保留身份/角色/模型/沙箱/审批/时间/turn-step 计数/工具调用名与目标路径/产物归因',
      parentSession: args.parent,
      workflowName: args.workflowName,
      since: args.since,
      evidenceDir: args.evidenceDir,
      attributionRules: {
        'write-tool': '子会话的写文件工具调用，其目标路径位于证据目录内（强归因）',
        'time-window': '文件 mtime 落入唯一一个子会话的活动区间（次强归因，适用于经 shell 写出的产物）',
        unattributed: '两种证据都没有，或同时命中多个子会话；检查项会失败'
      },
      excludedByDesign: [
        '用户与助手消息正文',
        '系统提示词与角色指令正文',
        '工具结果载荷与 shell 命令原文',
        'DSH 凭据存储中的任何内容'
      ]
    },
    workflowRun: {
      runId: runId,
      name: runStart.data.name,
      startedAt: isoOf(runStart.time),
      endedAt: runEnd ? isoOf(runEnd.time) : null,
      stopReason: runEnd && runEnd.data ? (runEnd.data.stopReason ?? null) : null,
      agentCallCount: calls.length
    },
    invocation: invocation,
    agentCalls: calls,
    artifacts: artifacts,
    derivedChecks: checks,
    checksAllPassed: checks.every(function (c) { return c.ok; })
  };

  writeFileSync(args.out, JSON.stringify(document, null, 2) + '\n', 'utf8');
  for (const c of calls) {
    console.log(c.seq + '  ' + c.label + '  ' + c.startedAt + ' → ' + c.endedAt + '  ' +
      (c.model ? c.model.model + '/' + c.model.provider : 'model?') + '  child=' + c.childSessionId);
  }
  for (const artifact of artifacts) {
    console.log('  ' + artifact.path + '  ' + String(artifact.bytes) + 'B  ' + artifact.attribution + '  ' +
      artifact.writtenBy.map(function (w) { return '#' + w.seq + ' ' + w.label; }).join(';'));
  }
  for (const check of checks) {
    if (!check.ok) console.log('FAIL ' + check.id + ' :: ' + check.detail);
  }
  console.log('wrote ' + args.out + '  (checks ' + checks.filter(function (c) { return c.ok; }).length + '/' + checks.length + ')');
  if (!document.checksAllPassed) process.exitCode = 1;
}

main();
