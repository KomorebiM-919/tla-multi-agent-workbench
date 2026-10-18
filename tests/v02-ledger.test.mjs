// 账本复算的正式回归：用合成日志证明 tools/recompute-ledger.mjs 的口径，
// 而不是靠人工表格。合成日志只写临时目录，不读本机真实运行记录。
//
// 覆盖四类"看起来是 0、其实是未知"的场景：
//   缺上游日志、日志被截断、服务崩溃留下空文件、旧格式只有一行 accepted。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureRun, summarise } from '../tools/recompute-ledger.mjs';

let failures = 0;
let checks = 0;
function check(condition, label, detail) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  }
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function stagedUpstream(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ seq: i + 1, event: 'arrived', accepted: true });
    rows.push({ seq: i + 1, event: 'responded', stopReason: 'end_turn' });
  }
  return rows;
}

function makeRun(dir, {
  resumeMode = 'fresh', usedBefore = 0, reserved = 0, rejected = 0, allowed = 0, upstream = 0,
  mounted = true, upstreamFile = 'upstream.jsonl', upstreamRows = null,
} = {}) {
  mkdirSync(dir, { recursive: true });
  const events = [];
  if (mounted) events.push({ event: 'mounted', runId: 'tla-run-x', resumeMode, used: usedBefore });
  for (let i = 0; i < reserved; i += 1) events.push({ event: 'reserved', runId: 'tla-run-x', used: usedBefore + i + 1 });
  for (let i = 0; i < rejected; i += 1) events.push({ event: 'rejected', runId: 'tla-run-x', rejected: i + 1 });
  events.push({ event: 'unmounted', runId: 'tla-run-x', used: usedBefore + reserved });
  writeJsonl(join(dir, 'plugin-events.jsonl'), events);
  writeJsonl(join(dir, 'gate-events.jsonl'), [
    ...Array.from({ length: allowed }, () => ({ event: 'allowed' })),
    ...Array.from({ length: Math.max(0, reserved - allowed) }, () => ({ event: 'denied', reason: 'BUDGET_EXHAUSTED' })),
  ]);
  if (upstreamFile !== null) {
    writeJsonl(join(dir, upstreamFile), upstreamRows ?? stagedUpstream(upstream));
  }
  writeFileSync(join(dir, 'gate-summary.json'), JSON.stringify({ hostStarted: true, result: 'host-ok' }), 'utf8');
}

const scratch = mkdtempSync(join(tmpdir(), 'tla-ledger-'));

try {
  const fresh = join(scratch, 'fresh');
  makeRun(fresh, { reserved: 3, allowed: 2, upstream: 2 });
  const freshRow = measureRun(fresh, 'fresh');
  check(freshRow.usedBefore === 0, 'fresh: usedBefore is 0', freshRow.usedBefore);
  check(freshRow.reservedDelta === 3, 'fresh: reserved delta', freshRow.reservedDelta);
  check(freshRow.usedAfter === 3, 'fresh: usedAfter', freshRow.usedAfter);
  check(freshRow.gateAllowed === 2, 'fresh: gate allowed', freshRow.gateAllowed);
  check(freshRow.upstreamReceived === 2, 'fresh: upstream received', freshRow.upstreamReceived);
  check(freshRow.upstreamCompleted === 2, 'fresh: upstream completed', freshRow.upstreamCompleted);
  check(freshRow.ledgerConsistent === true, 'fresh: ledger consistent', freshRow);
  check(freshRow.upstreamWithinGate === true, 'fresh: upstream within gate', freshRow);
  check(freshRow.completeness === 'COMPLETE', 'fresh: complete', freshRow);

  // 关键反例：resume 的第二次运行必须用自己 mounted 事件里的 usedBefore，
  // 不能把上一轮留下的 used 相加成 2 倍。
  const resumed = join(scratch, 'resumed');
  makeRun(resumed, { resumeMode: 'resumed', usedBefore: 3, reserved: 1, rejected: 1, allowed: 1, upstream: 1 });
  const resumedRow = measureRun(resumed, 'resumed');
  check(resumedRow.resumeMode === 'resumed', 'resumed: resumeMode recorded', resumedRow.resumeMode);
  check(resumedRow.usedBefore === 3, 'resumed: usedBefore comes from its own mount', resumedRow.usedBefore);
  check(resumedRow.usedAfter === 4, 'resumed: usedAfter is before + delta', resumedRow.usedAfter);
  check(resumedRow.ledgerConsistent === true, 'resumed: ledger consistent', resumedRow);

  // 反例：上游收到的比闸门放行的多 → 账本必须报出来，而不是当成正常。
  const overGate = join(scratch, 'over-gate');
  makeRun(overGate, { reserved: 1, allowed: 1, upstream: 2 });
  const overRow = measureRun(overGate, 'over-gate');
  check(overRow.upstreamWithinGate === false, 'over-gate: upstream over gate is flagged', overRow);

  // 反例：usedAfter 与 usedBefore + 增量 不符 → 标记不一致。
  const broken = join(scratch, 'broken');
  mkdirSync(broken, { recursive: true });
  writeJsonl(join(broken, 'plugin-events.jsonl'), [
    { event: 'mounted', runId: 'r', resumeMode: 'fresh', used: 1 },
    { event: 'reserved', runId: 'r', used: 2 },
    { event: 'unmounted', runId: 'r', used: 9 },
  ]);
  writeJsonl(join(broken, 'gate-events.jsonl'), [{ event: 'allowed' }]);
  writeJsonl(join(broken, 'upstream.jsonl'), stagedUpstream(1));
  writeFileSync(join(broken, 'gate-summary.json'), JSON.stringify({ hostStarted: true }), 'utf8');
  const brokenRow = measureRun(broken, 'broken');
  check(brokenRow.ledgerConsistent === false, 'broken: inconsistent ledger detected', brokenRow);
  check(brokenRow.completeness === 'INCOMPLETE', 'broken: incomplete', brokenRow.completeness);

  // 未启动宿主的运行（配置探测拒绝启动）不计入总额。
  const refused = join(scratch, 'refused');
  mkdirSync(refused, { recursive: true });
  writeFileSync(join(refused, 'gate-summary.json'), JSON.stringify({ hostStarted: false, result: 'refused-before-host-start' }), 'utf8');
  const refusedRow = measureRun(refused, 'refused');
  check(refusedRow.hostStarted === false, 'refused: hostStarted false', refusedRow.hostStarted);
  check(refusedRow.resumeMode === 'not-mounted', 'refused: not mounted', refusedRow.resumeMode);

  // 反例 1：宿主启动了，但上游日志完全不存在 → 不能报"收到 0"，必须 unknown。
  const noLog = join(scratch, 'no-log');
  makeRun(noLog, { reserved: 2, allowed: 2, upstreamFile: null });
  const noLogRow = measureRun(noLog, 'no-log');
  check(noLogRow.upstreamReceived === 'unknown', 'no-log: received unknown', noLogRow);
  check(noLogRow.upstreamCompleted === 'unknown', 'no-log: completed unknown', noLogRow);
  check(noLogRow.completeness === 'INCOMPLETE', 'no-log: incomplete', noLogRow.completeness);
  check(noLogRow.incompleteReasons.some((reason) => reason.includes('upstream: missing')), 'no-log: reason names the missing file', noLogRow.incompleteReasons);

  // 反例 2：日志被截断（写一半就崩）→ unknown，而不是丢掉坏行后看起来干净。
  const truncated = join(scratch, 'truncated');
  makeRun(truncated, { reserved: 2, allowed: 2, upstream: 2 });
  const truncatedPath = join(truncated, 'upstream.jsonl');
  writeFileSync(truncatedPath, '{"seq":1,"event":"arrived","accepted":true}\n{"seq":2,"event":"arr', 'utf8');
  const truncatedRow = measureRun(truncated, 'truncated');
  check(truncatedRow.completeness === 'INCOMPLETE', 'truncated: incomplete', truncatedRow.completeness);
  check(truncatedRow.incompleteReasons.some((reason) => reason.includes('unparseable line')), 'truncated: reason names the bad line', truncatedRow.incompleteReasons);
  check(truncatedRow.upstreamReceived === 'unknown', 'truncated: received unknown', truncatedRow.upstreamReceived);

  // 反例 3：服务崩溃留下空文件（目录存在但一行未写）→ 收到 0 也不能当作完成的证据。
  const crashed = join(scratch, 'crashed');
  makeRun(crashed, { reserved: 1, allowed: 1, upstreamFile: null });
  writeFileSync(join(crashed, 'upstream.jsonl'), '', 'utf8');
  const crashedRow = measureRun(crashed, 'crashed');
  check(crashedRow.upstreamReceived === 0, 'crashed: empty log reads as zero arrivals', crashedRow.upstreamReceived);
  check(crashedRow.upstreamCompleted === 'unknown', 'crashed: completion unknown, not zero', crashedRow.upstreamCompleted);
  check(crashedRow.stageMismatch.some((item) => item.includes('never saw')), 'crashed: allowed-but-unseen is a mismatch', crashedRow.stageMismatch);

  // 反例 4：旧格式只有一行 accepted → 只能证明到达，不能证明响应完成。
  const legacy = join(scratch, 'legacy');
  makeRun(legacy, { reserved: 1, allowed: 1, upstreamRows: [{ accepted: true }] });
  const legacyRow = measureRun(legacy, 'legacy');
  check(legacyRow.upstreamStages === 'legacy-accepted-only', 'legacy: format recorded', legacyRow.upstreamStages);
  check(legacyRow.upstreamReceived === 1, 'legacy: arrival counted', legacyRow.upstreamReceived);
  check(legacyRow.upstreamCompleted === 'unknown', 'legacy: completion unknown', legacyRow.upstreamCompleted);
  check(legacyRow.completeness === 'INCOMPLETE', 'legacy: incomplete', legacyRow.completeness);

  const totals = summarise([freshRow, resumedRow, refusedRow]);
  check(totals.countedRuns === 2, 'totals: refused run excluded', totals.countedRuns);
  check(totals.reserved === 4, 'totals: reserved sum', totals.reserved);
  check(totals.rejected === 1, 'totals: rejected sum', totals.rejected);
  check(totals.allowed === 3, 'totals: allowed sum', totals.allowed);
  check(totals.upstreamReceived === 3, 'totals: received sum', totals.upstreamReceived);
  check(totals.upstreamCompleted === 3, 'totals: completed sum', totals.upstreamCompleted);
  check(totals.inconsistent.length === 0, 'totals: no inconsistent rows', totals.inconsistent);
  check(totals.complete === true, 'totals: complete', totals);

  const mixed = summarise([freshRow, noLogRow]);
  check(mixed.complete === false, 'totals: incomplete run poisons the total', mixed);
  check(mixed.incompleteRuns.includes('no-log'), 'totals: incomplete run named', mixed.incompleteRuns);
  check(mixed.unknown.upstreamReceived.includes('no-log'), 'totals: unknown stage named', mixed.unknown);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`v02-ledger: ${checks - failures}/${checks} checks passed, ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
