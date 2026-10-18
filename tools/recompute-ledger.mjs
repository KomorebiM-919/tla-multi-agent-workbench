// Recompute a per-run budget ledger from the raw logs of one gated run.
//
// Why this exists: the experiment reports quote "reserved / allowed / upstream"
// counts, and it is easy to add two runs that share one budget state file and
// mis-report the total. This tool only reads the artefacts a run already wrote
// (plugin event log, gate event log, upstream request log, gate-summary) and
// derives the deltas per run, so the numbers can be checked without trusting a
// hand-written table.
//
// It never talks to the network, never reads credentials, and never rewrites
// the logs it reads.
//
// Usage:
//   node tools/recompute-ledger.mjs <run-dir> [<run-dir> ...]
//   node tools/recompute-ledger.mjs --json <run-dir> [...]
//
// Expected files in a run dir (all optional; missing ones count as empty):
//   plugin-events.jsonl  (mounted/reserved/rejected/unmounted heartbeats)
//   gate-events.jsonl    (allowed/denied/lease-granted/lease-revoked)
//   upstream.jsonl       (what the fake model server actually accepted)
//   gate-summary.json    (launcher summary: hostStarted, result, blockers)
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const LEDGER_SCHEMA = 'tla.run-ledger/v1';

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}: line ${index + 1} is not JSON (${error.message})`);
      }
    });
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function measureRun(runDir, label = basename(runDir)) {
  const pluginEvents = readJsonl(join(runDir, 'plugin-events.jsonl'));
  const gateEvents = readJsonl(join(runDir, 'gate-events.jsonl'));
  // 上游日志的默认文件名是 upstream.jsonl；早期实验里假服务直接写 requests.jsonl，
  // 两者内容同构（每行一次真实收到的 HTTP 请求）。这里按顺序回退，并记录来源，
  // 避免"文件不在默认位置"被误读成"上游收到 0 个请求"。
  const upstreamPath = existsSync(join(runDir, 'upstream.jsonl'))
    ? 'upstream.jsonl'
    : (existsSync(join(runDir, 'requests.jsonl')) ? 'requests.jsonl' : null);
  const upstream = upstreamPath === null ? [] : readJsonl(join(runDir, upstreamPath));
  const summary = readJson(join(runDir, 'gate-summary.json'));

  const mounted = pluginEvents.find((event) => event.event === 'mounted') ?? null;
  const reserved = pluginEvents.filter((event) => event.event === 'reserved');
  const rejected = pluginEvents.filter((event) => event.event === 'rejected');
  const last = pluginEvents.length === 0 ? null : pluginEvents[pluginEvents.length - 1];

  const row = {
    schema: LEDGER_SCHEMA,
    run: label,
    hostStarted: summary === null ? null : summary.hostStarted === true,
    result: summary === null ? null : summary.result ?? null,
    resumeMode: mounted === null ? 'not-mounted' : mounted.resumeMode ?? 'fresh',
    usedBefore: mounted !== null && typeof mounted.used === 'number' ? mounted.used : null,
    reservedDelta: reserved.length,
    rejectedDelta: rejected.length,
    usedAfter: last !== null && typeof last.used === 'number' ? last.used : null,
    lastEvent: last === null ? null : last.event ?? null,
    gateAllowed: gateEvents.filter((event) => event.event === 'allowed').length,
    gateDenied: gateEvents.filter((event) => event.event === 'denied').length,
    upstreamAccepted: upstream.filter((event) => event.accepted === true).length,
    upstreamSource: upstreamPath,
    upstreamLines: upstream.length,
    sourceLines: {
      pluginEvents: pluginEvents.length,
      gateEvents: gateEvents.length,
      upstream: upstream.length,
    },
  };
  // 账本一致性：usedAfter 必须等于 usedBefore + 本次预占增量。resume 的两次运行
  // 共用同一个状态文件，所以 usedBefore 必须来自各自运行的第一条 mounted 事件，
  // 不能把上一轮留下的 used 当成这一轮的。
  row.ledgerConsistent = row.usedBefore === null ? null : row.usedAfter === row.usedBefore + row.reservedDelta;
  // 闸门是唯一出口：上游收到的请求不可能多于闸门放行的请求。
  row.upstreamWithinGate = row.upstreamAccepted <= row.gateAllowed;
  return row;
}

export function summarise(rows) {
  const counted = rows.filter((row) => row.hostStarted !== false);
  return {
    schema: LEDGER_SCHEMA,
    runs: rows.length,
    countedRuns: counted.length,
    reserved: counted.reduce((sum, row) => sum + row.reservedDelta, 0),
    rejected: counted.reduce((sum, row) => sum + row.rejectedDelta, 0),
    allowed: counted.reduce((sum, row) => sum + row.gateAllowed, 0),
    upstream: counted.reduce((sum, row) => sum + row.upstreamAccepted, 0),
    inconsistent: rows.filter((row) => row.ledgerConsistent === false).map((row) => row.run),
    upstreamOverGate: rows.filter((row) => row.upstreamWithinGate === false).map((row) => row.run),
  };
}

function main(argv) {
  const asJson = argv.includes('--json');
  const dirs = argv.filter((arg) => arg !== '--json');
  if (dirs.length === 0) {
    console.error('usage: node tools/recompute-ledger.mjs [--json] <run-dir> [<run-dir> ...]');
    return 2;
  }
  const rows = dirs.map((dir) => measureRun(dir));
  if (asJson) {
    console.log(JSON.stringify({ rows, totals: summarise(rows) }, null, 2));
    return 0;
  }
  for (const row of rows) {
    console.log(
      `${row.run}: resume=${row.resumeMode} usedBefore=${row.usedBefore} reserved=${row.reservedDelta} `
      + `rejected=${row.rejectedDelta} usedAfter=${row.usedAfter} allowed=${row.gateAllowed} `
      + `upstream=${row.upstreamAccepted} consistent=${row.ledgerConsistent} withinGate=${row.upstreamWithinGate}`,
    );
  }
  const totals = summarise(rows);
  console.log(`TOTAL reserved=${totals.reserved} rejected=${totals.rejected} allowed=${totals.allowed} upstream=${totals.upstream}`);
  return totals.inconsistent.length === 0 && totals.upstreamOverGate.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('recompute-ledger.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
