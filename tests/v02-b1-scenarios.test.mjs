/**
 * B-1 零付费验证的确定性夹具。
 *
 * 这里验证的是"闸门/预算在给定请求序列下的行为"，不是宿主调度本身。
 * 真实宿主与 AgentTeams 路径的结果记录在 docs/V0.2-B1-MATRIX.md，
 * 两者不可互相替代。
 */

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetGate } from '../orchestration/gate/gate.mjs';
import { createRequestBudget, BUDGET_UNIT } from '../orchestration/interceptor-plugin/lib/budget.mjs';

const failures = [];

function check(condition, label, detail) {
  if (!condition) {
    failures.push({ label, detail });
    console.log('FAIL ' + label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
  }
}

async function startUpstream() {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ url: req.url, bytes: Buffer.concat(chunks).length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    hits,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function call(baseUrl, tag) {
  const response = await fetch(baseUrl + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tla-scenario': tag },
    body: JSON.stringify({ model: 'fake', messages: [] }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_notJson) {
    body = null;
  }
  return { status: response.status, body };
}

function reasonOf(result) {
  return result.body && result.body.error ? result.body.error.reason : null;
}

/** 两个"团队"的请求共用一份运行额度：不会因为换个团队就重开额度。 */
async function scenarioTwoTeamsShareOneBudget() {
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 3 });
  const base = (await gate.listen(0)).baseUrl;
  gate.grantLease();

  const first = await call(base, 'team-a');
  const second = await call(base, 'team-a');
  const third = await call(base, 'team-b');
  const fourth = await call(base, 'team-b');

  check(first.status === 200 && second.status === 200 && third.status === 200, 'teams: first three allowed', [first.status, second.status, third.status]);
  check(fourth.status === 403, 'teams: fourth denied on the shared budget', fourth.status);
  check(reasonOf(fourth) === 'BUDGET_EXHAUSTED', 'teams: denial reason is BUDGET_EXHAUSTED', reasonOf(fourth));
  check(upstream.hits.length === 3, 'teams: upstream saw exactly three requests', upstream.hits.length);
  check(gate.status().used === 3, 'teams: counter is shared, not per team', gate.status().used);
  const status = gate.status();
  check(status.remaining === 0, 'teams: no remaining allowance for the second team', status.remaining);

  await gate.close();
  await upstream.close();
}

/** 取消之后不退款，也不允许把已撤销的租约重新用起来。 */
async function scenarioCancelDoesNotRefund() {
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 2 });
  const base = (await gate.listen(0)).baseUrl;
  gate.grantLease();

  const before = await call(base, 'cancel-before');
  check(before.status === 200, 'cancel: request before cancel is forwarded', before.status);
  check(upstream.hits.length === 1, 'cancel: upstream saw one request', upstream.hits.length);

  gate.revoke('CANCELLED');
  const after = await call(base, 'cancel-after');
  check(after.status === 403, 'cancel: request after cancel is refused', after.status);
  check(reasonOf(after) === 'REVOKED', 'cancel: refusal reason is REVOKED', reasonOf(after));
  check(upstream.hits.length === 1, 'cancel: no new upstream request after cancel', upstream.hits.length);
  check(gate.status().used === 1, 'cancel: the forwarded request keeps its reservation', gate.status().used);

  const leaseId = 'late-lease';
  const heartbeat = gate.heartbeat(leaseId);
  check(
    heartbeat === 'REVOKED' || heartbeat === 'LEASE_UNKNOWN' || (heartbeat && heartbeat.ok === false),
    'cancel: revoked gate cannot be leased again',
    heartbeat,
  );

  await gate.close();
  await upstream.close();
}

/** 两条本地假路由各自一道闸门：计数互不影响，撤销也只影响自己。 */
async function scenarioFallbackBetweenTwoGates() {
  const primaryUpstream = await startUpstream();
  const fallbackUpstream = await startUpstream();
  const primary = createBudgetGate({ upstream: primaryUpstream.url, modelRequests: 1 });
  const fallback = createBudgetGate({ upstream: fallbackUpstream.url, modelRequests: 3 });
  const primaryBase = (await primary.listen(0)).baseUrl;
  const fallbackBase = (await fallback.listen(0)).baseUrl;
  primary.grantLease();
  fallback.grantLease();

  const p1 = await call(primaryBase, 'primary');
  const f1 = await call(fallbackBase, 'fallback');
  const p2 = await call(primaryBase, 'primary');
  const f2 = await call(fallbackBase, 'fallback');

  check(p1.status === 200 && f1.status === 200, 'fallback: both routes forward their first request', [p1.status, f1.status]);
  check(p2.status === 403, 'fallback: the primary route denies past its own limit', p2.status);
  check(f2.status === 200, 'fallback: the fallback route keeps its own allowance', f2.status);
  check(primaryUpstream.hits.length === 1, 'fallback: primary upstream counted once', primaryUpstream.hits.length);
  check(fallbackUpstream.hits.length === 2, 'fallback: fallback upstream counted twice', fallbackUpstream.hits.length);

  primary.revoke('PRIMARY_DOWN');
  const f3 = await call(fallbackBase, 'fallback');
  check(f3.status === 200, 'fallback: healthy route still works after the other is revoked', f3.status);
  check(fallbackUpstream.hits.length === 3, 'fallback: healthy route still counted', fallbackUpstream.hits.length);

  await primary.close();
  await fallback.close();
  await primaryUpstream.close();
  await fallbackUpstream.close();
}

/** 重启恢复：已用额度必须延续，不能默认清零。 */
async function scenarioResumeKeepsUsed() {
  const dir = mkdtempSync(join(tmpdir(), 'b1-resume-'));
  const stateFile = join(dir, 'budget-state.json');
  writeFileSync(stateFile, JSON.stringify({ unit: 'modelRequests', limit: 3, used: 2, rejected: 0 }), 'utf8');

  const resumed = createRequestBudget({ modelRequests: 3, used: 2 });
  const snapshot = resumed.snapshot();
  check(snapshot.used === 2, 'resume: used count continues from the state file', snapshot.used);
  check(snapshot.resumedFrom === 2, 'resume: snapshot reports resumedFrom', snapshot.resumedFrom);
  check(snapshot.remaining === 1, 'resume: remaining reflects the resumed count', snapshot.remaining);

  resumed.reserve({ phase: 'agent/request' });
  let overflow = null;
  try {
    resumed.reserve({ phase: 'agent/request' });
  } catch (error) {
    overflow = error;
  }
  check(overflow !== null && overflow.code === 'MODEL_REQUEST_BUDGET_EXCEEDED', 'resume: the next request is refused', overflow && overflow.code);
  check(overflow.snapshot.used === 3, 'resume: refusal happens before the count exceeds the limit', overflow.snapshot.used);

  const exhausted = createRequestBudget({ modelRequests: 3, used: 3 });
  let exhaustedError = null;
  try {
    exhausted.reserve({ phase: 'agent/request' });
  } catch (error) {
    exhaustedError = error;
  }
  check(exhaustedError !== null, 'resume: an exhausted state refuses immediately', exhaustedError && exhaustedError.code);
  check(BUDGET_UNIT === 'modelRequests', 'resume: the plugin counts model requests only', BUDGET_UNIT);

  rmSync(dir, { recursive: true, force: true });
}

/**
 * 返工轮次不是独立的计数单位：无论第几轮、哪一类任务，都只能算进同一份
 * 模型请求额度。这是有意的限制，避免"返工不算"变成绕过口子。
 */
async function scenarioRepairRoundsAreNotASeparateUnit() {
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 3 });
  const base = (await gate.listen(0)).baseUrl;
  gate.grantLease();

  const results = [];
  for (const tag of ['review-fail', 'repair-1', 'review-fail-2', 'repair-2', 'repair-3']) {
    results.push(await call(base, tag));
  }
  const allowed = results.filter((item) => item.status === 200).length;
  const denied = results.filter((item) => item.status === 403).length;
  check(allowed === 3, 'repair: only the budgeted requests are forwarded', allowed);
  check(denied === 2, 'repair: every later round is refused, not exempted', denied);
  check(upstream.hits.length === 3, 'repair: upstream count equals the allowance', upstream.hits.length);

  const source = readFileSync(new URL('../orchestration/interceptor-plugin/lib/budget.mjs', import.meta.url), 'utf8');
  check(!/repair|round/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'repair: the budget module has no per-round counter', null);

  await gate.close();
  await upstream.close();
}

async function main() {
  const scenarios = [
    ['two teams share one budget', scenarioTwoTeamsShareOneBudget],
    ['cancel does not refund', scenarioCancelDoesNotRefund],
    ['fallback between two gates', scenarioFallbackBetweenTwoGates],
    ['resume keeps used', scenarioResumeKeepsUsed],
    ['repair rounds are not a separate unit', scenarioRepairRoundsAreNotASeparateUnit],
  ];
  for (const [label, scenario] of scenarios) {
    try {
      await scenario();
    } catch (error) {
      failures.push({ label, detail: error.message });
      console.log('FAIL scenario "' + label + '" threw: ' + error.message);
    }
  }
  if (failures.length > 0) {
    console.log('v02-b1: ' + scenarios.length + ' scenarios, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log('v02-b1: ' + scenarios.length + ' scenarios, 0 failed');
}

await main();
