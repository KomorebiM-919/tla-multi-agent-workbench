// Recompute a per-run budget ledger from the raw logs of one gated run.
//
// Why this exists: the experiment reports quote "reserved / allowed / upstream"
// counts, and it is easy to add two runs that share one budget state file and
// mis-report the total. This tool only reads the artefacts a run already wrote
// (plugin event log, gate event log, upstream request log, gate-summary) and
// derives the deltas per run, so the numbers can be checked without trusting a
// hand-written table.
//
// The four stages are deliberately separate numbers, because they answer
// different questions:
//   reserved   the plugin counted the request against the budget before sending
//   attempted  the gate let the request through towards the upstream
//   received   the upstream server logged that the request arrived
//   completed  the upstream server finished writing the response
//
// A run whose upstream log is missing, empty while the host started, truncated
// or written before this distinction existed cannot prove "received" or
// "completed". Those fields are reported as the string 'unknown' and the run is
// marked INCOMPLETE: an unverifiable zero is never reported as a clean
// reconciliation.
//
// It never talks to the network, never reads credentials, and never rewrites
// the logs it reads.
//
// Usage:
//   node tools/recompute-ledger.mjs <run-dir> [<run-dir> ...]
//   node tools/recompute-ledger.mjs --json <run-dir> [...]
//
// Expected files in a run dir (all optional; missing ones make the run
// INCOMPLETE rather than silently empty):
//   plugin-events.jsonl  (mounted/reserved/rejected/unmounted/heartbeat)
//   gate-events.jsonl    (allowed/denied/lease-granted/lease-revoked)
//   upstream.jsonl       (fake model server: arrived/responded/legacy accepted)
//   gate-summary.json    (launcher summary: hostStarted, result, blockers)
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const LEDGER_SCHEMA = 'tla.run-ledger/v2';
export const UNKNOWN = 'unknown';

function readJsonl(path) {
  if (!existsSync(path)) return { ok: false, reason: 'missing', entries: [] };
  const text = readFileSync(path, 'utf8');
  const entries = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      // A truncated final line is the signature of a crashed writer. Report the
      // run as unverifiable instead of dropping the line and looking clean.
      return { ok: false, reason: `unparseable line ${index + 1}: ${error.message}`, entries };
    }
  }
  return { ok: true, reason: null, entries };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { __unparseable: error.message };
  }
}

export function measureRun(runDir, label = basename(runDir)) {
  const plugin = readJsonl(join(runDir, 'plugin-events.jsonl'));
  const gate = readJsonl(join(runDir, 'gate-events.jsonl'));
  const upstreamFile = existsSync(join(runDir, 'upstream.jsonl'))
    ? 'upstream.jsonl'
    : (existsSync(join(runDir, 'requests.jsonl')) ? 'requests.jsonl' : null);
  const upstream = upstreamFile === null
    ? { ok: false, reason: 'missing', entries: [] }
    : readJsonl(join(runDir, upstreamFile));
  const summary = readJson(join(runDir, 'gate-summary.json'));

  const pluginEvents = plugin.entries;
  const gateEvents = gate.entries;
  const upstreamEvents = upstream.entries;

  const mounted = pluginEvents.find((event) => event.event === 'mounted') ?? null;
  const reserved = pluginEvents.filter((event) => event.event === 'reserved');
  const rejected = pluginEvents.filter((event) => event.event === 'rejected');
  const last = pluginEvents.length === 0 ? null : pluginEvents[pluginEvents.length - 1];

  const hostStarted = summary === null ? null : summary.hostStarted === true;
  // The hardened server writes explicit `arrived` / `responded` events. Older
  // logs only have one accepted line per request, which proves arrival at most.
  const staged = upstreamEvents.some((event) => event.event === 'arrived' || event.event === 'responded');
  const arrived = upstreamEvents.filter((event) => event.event === 'arrived');
  const responded = upstreamEvents.filter((event) => event.event === 'responded');
  const acceptedLegacy = upstreamEvents.filter((event) => event.accepted === true);

  const incompleteReasons = [];
  if (!plugin.ok) incompleteReasons.push(`plugin-events: ${plugin.reason}`);
  if (!gate.ok) incompleteReasons.push(`gate-events: ${gate.reason}`);
  if (summary === null) incompleteReasons.push('gate-summary missing');
  else if (summary.__unparseable !== undefined) incompleteReasons.push(`gate-summary: ${summary.__unparseable}`);
  if (!upstream.ok) incompleteReasons.push(`upstream: ${upstream.reason}`);

  const received = !upstream.ok ? UNKNOWN : (staged ? arrived.length : acceptedLegacy.length);
  let completed;
  if (!upstream.ok) completed = UNKNOWN;
  else if (staged) completed = responded.length;
  else completed = UNKNOWN; // legacy single-line logs cannot prove completion

  const row = {
    schema: LEDGER_SCHEMA,
    run: label,
    hostStarted,
    result: summary === null || summary.__unparseable !== undefined ? null : summary.result ?? null,
    resumeMode: mounted === null ? 'not-mounted' : mounted.resumeMode ?? 'fresh',
    usedBefore: mounted !== null && typeof mounted.used === 'number' ? mounted.used : null,
    reservedDelta: reserved.length,
    rejectedDelta: rejected.length,
    usedAfter: last !== null && typeof last.used === 'number' ? last.used : null,
    lastEvent: last === null ? null : last.event ?? null,
    gateAllowed: gateEvents.length === 0 ? UNKNOWN : gateEvents.filter((event) => event.event === 'allowed').length,
    gateDenied: gateEvents.length === 0 ? UNKNOWN : gateEvents.filter((event) => event.event === 'denied').length,
    upstreamReceived: received,
    upstreamCompleted: completed,
    upstreamStages: staged ? 'arrived/responded' : (upstream.ok ? 'legacy-accepted-only' : UNKNOWN),
    upstreamSource: upstreamFile,
    upstreamLines: upstreamEvents.length,
    sourceLines: {
      pluginEvents: pluginEvents.length,
      gateEvents: gateEvents.length,
      upstream: upstreamEvents.length,
    },
  };

  // 关联 ID：闸门给每条放行请求生成一个，服务端把收到的那个记下来。
  // 用它做逐请求配对 —— 只用于观测，不声称是身份认证。
  const allowedIds = gateEvents.filter((event) => event.event === 'allowed').map((event) => event.correlationId ?? null);
  const upstreamIds = upstreamEvents.filter((event) => event.event === 'arrived' || event.accepted !== undefined).map((event) => event.correlationId ?? null);
  const counts = new Map();
  for (const id of upstreamIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  row.correlation = {
    gateIds: allowedIds.length,
    upstreamIds: upstreamIds.length,
    allowedWithoutId: allowedIds.filter((id) => id === null).length,
    upstreamWithoutId: upstreamIds.filter((id) => id === null).length,
    missingAtUpstream: allowedIds.filter((id) => id !== null && !counts.has(id)).length,
    duplicatedAtUpstream: allowedIds.filter((id) => id !== null && (counts.get(id) ?? 0) > 1).length,
    unknownAtUpstream: upstreamIds.filter((id) => id !== null && !allowedIds.includes(id)).length,
  };
  row.correlation.ok = row.correlation.allowedWithoutId === 0
    && row.correlation.upstreamWithoutId === 0
    && row.correlation.missingAtUpstream === 0
    && row.correlation.duplicatedAtUpstream === 0
    && row.correlation.unknownAtUpstream === 0;

  // Budget arithmetic: usedAfter must be usedBefore + this run's reservations.
  // A resumed run shares the state file, so usedBefore has to come from that
  // run's own first `mounted` event.
  row.ledgerConsistent = row.usedBefore === null ? UNKNOWN
    : row.usedAfter === row.usedBefore + row.reservedDelta;
  // The gate is the only exit: the upstream cannot see more than it let through.
  if (row.gateAllowed === UNKNOWN || row.upstreamReceived === UNKNOWN) {
    row.upstreamWithinGate = UNKNOWN;
  } else {
    row.upstreamWithinGate = row.upstreamReceived <= row.gateAllowed;
  }

  // A run is only COMPLETE when every stage is a number and the stages agree
  // with each other. Anything else stays INCOMPLETE with named reasons.
  const stageMismatch = [];
  if (typeof row.reservedDelta === 'number' && row.gateAllowed !== UNKNOWN && row.gateAllowed > row.reservedDelta) {
    stageMismatch.push('gate allowed more requests than the plugin reserved');
  }
  if (row.gateAllowed !== UNKNOWN && row.upstreamReceived !== UNKNOWN && row.upstreamReceived > row.gateAllowed) {
    stageMismatch.push('upstream received more requests than the gate allowed');
  }
  if (row.upstreamReceived !== UNKNOWN && row.upstreamCompleted !== UNKNOWN && row.upstreamCompleted > row.upstreamReceived) {
    stageMismatch.push('upstream completed more responses than it received');
  }
  if (row.upstreamReceived !== UNKNOWN && row.upstreamCompleted !== UNKNOWN && row.upstreamCompleted < row.upstreamReceived) {
    stageMismatch.push('upstream received requests it never finished answering');
  }
  if (row.gateAllowed !== UNKNOWN && row.upstreamReceived !== UNKNOWN && row.upstreamReceived < row.gateAllowed) {
    stageMismatch.push('the gate allowed requests the upstream never saw');
  }
  if (row.ledgerConsistent === false) stageMismatch.push('budget counter does not match the reservations');
  // 关联 ID 对不上（缺、重复、或上游出现了闸门没发过的 id）同样让账本不完整。
  if (row.correlation.allowedWithoutId > 0) stageMismatch.push('the gate did not stamp a correlation id on every allowed request');
  if (row.correlation.upstreamWithoutId > 0) stageMismatch.push('the upstream recorded requests without a correlation id');
  if (row.correlation.missingAtUpstream > 0) stageMismatch.push('the gate allowed requests the upstream recorded under a different correlation id');
  if (row.correlation.duplicatedAtUpstream > 0) stageMismatch.push('the upstream saw the same correlation id more than once');
  if (row.correlation.unknownAtUpstream > 0) stageMismatch.push('the upstream saw correlation ids the gate never issued');
  row.stageMismatch = stageMismatch;
  row.unknownFields = [
    row.upstreamReceived === UNKNOWN ? 'upstreamReceived' : null,
    row.upstreamCompleted === UNKNOWN ? 'upstreamCompleted' : null,
    row.gateAllowed === UNKNOWN ? 'gateAllowed' : null,
  ].filter((value) => value !== null);
  row.completeness = incompleteReasons.length === 0 && stageMismatch.length === 0 && row.unknownFields.length === 0 ? 'COMPLETE' : 'INCOMPLETE';
  row.incompleteReasons = incompleteReasons;
  return row;
}

export function summarise(rows) {
  const counted = rows.filter((row) => row.hostStarted !== false);
  const sum = (key) => {
    let total = 0;
    const unknownRuns = [];
    for (const row of counted) {
      if (typeof row[key] === 'number') total += row[key];
      else unknownRuns.push(row.run);
    }
    return { total, unknownRuns };
  };
  const reserved = sum('reservedDelta');
  const rejected = sum('rejectedDelta');
  const allowed = sum('gateAllowed');
  const received = sum('upstreamReceived');
  const completed = sum('upstreamCompleted');
  return {
    schema: LEDGER_SCHEMA,
    runs: rows.length,
    countedRuns: counted.length,
    reserved: reserved.total,
    rejected: rejected.total,
    allowed: allowed.total,
    upstreamReceived: received.total,
    upstreamCompleted: completed.total,
    unknown: {
      reserved: reserved.unknownRuns,
      rejected: rejected.unknownRuns,
      allowed: allowed.unknownRuns,
      upstreamReceived: received.unknownRuns,
      upstreamCompleted: completed.unknownRuns,
    },
    incompleteRuns: rows.filter((row) => row.completeness !== 'COMPLETE').map((row) => row.run),
    inconsistent: rows.filter((row) => row.ledgerConsistent === false).map((row) => row.run),
    upstreamOverGate: rows.filter((row) => row.upstreamWithinGate === false).map((row) => row.run),
    complete: counted.every((row) => row.completeness === 'COMPLETE'),
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
      + `received=${row.upstreamReceived} completed=${row.upstreamCompleted} `
      + `consistent=${row.ledgerConsistent} withinGate=${row.upstreamWithinGate} ${row.completeness}`,
    );
    if (row.incompleteReasons.length > 0) {
      console.log(`  incomplete: ${row.incompleteReasons.join('; ')}`);
    }
    if (row.stageMismatch.length > 0) {
      console.log(`  mismatch: ${row.stageMismatch.join('; ')}`);
    }
  }
  const totals = summarise(rows);
  console.log(
    `TOTAL reserved=${totals.reserved} rejected=${totals.rejected} allowed=${totals.allowed} `
    + `received=${totals.upstreamReceived} completed=${totals.upstreamCompleted} complete=${totals.complete}`,
  );
  return totals.complete && totals.inconsistent.length === 0 && totals.upstreamOverGate.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('recompute-ledger.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
