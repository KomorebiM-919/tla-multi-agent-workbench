// 账本复算的正式回归：用合成日志证明 tools/recompute-ledger.mjs 的口径，
// 而不是靠人工表格。合成日志只写临时目录，不读本机真实运行记录。
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

function makeRun(dir, { resumeMode = 'fresh', usedBefore = 0, reserved = 0, rejected = 0, allowed = 0, upstream = 0, mounted = true }) {
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
  writeJsonl(join(dir, 'upstream.jsonl'), Array.from({ length: upstream }, () => ({ accepted: true })));
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
  check(freshRow.upstreamAccepted === 2, 'fresh: upstream accepted', freshRow.upstreamAccepted);
  check(freshRow.ledgerConsistent === true, 'fresh: ledger consistent', freshRow);
  check(freshRow.upstreamWithinGate === true, 'fresh: upstream within gate', freshRow);

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
  writeJsonl(join(broken, 'upstream.jsonl'), [{ accepted: true }]);
  writeFileSync(join(broken, 'gate-summary.json'), JSON.stringify({ hostStarted: true }), 'utf8');
  const brokenRow = measureRun(broken, 'broken');
  check(brokenRow.ledgerConsistent === false, 'broken: inconsistent ledger detected', brokenRow);

  // 未启动宿主的运行（配置探测拒绝启动）不计入总额。
  const refused = join(scratch, 'refused');
  mkdirSync(refused, { recursive: true });
  writeFileSync(join(refused, 'gate-summary.json'), JSON.stringify({ hostStarted: false, result: 'refused-before-host-start' }), 'utf8');
  const refusedRow = measureRun(refused, 'refused');
  check(refusedRow.hostStarted === false, 'refused: hostStarted false', refusedRow.hostStarted);
  check(refusedRow.resumeMode === 'not-mounted', 'refused: not mounted', refusedRow.resumeMode);

  const totals = summarise([freshRow, resumedRow, refusedRow]);
  check(totals.countedRuns === 2, 'totals: refused run excluded', totals.countedRuns);
  check(totals.reserved === 4, 'totals: reserved sum', totals.reserved);
  check(totals.rejected === 1, 'totals: rejected sum', totals.rejected);
  check(totals.allowed === 3, 'totals: allowed sum', totals.allowed);
  check(totals.upstream === 3, 'totals: upstream sum', totals.upstream);
  check(totals.inconsistent.length === 0, 'totals: no inconsistent rows', totals.inconsistent);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`v02-ledger: ${checks - failures}/${checks} checks passed, ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
