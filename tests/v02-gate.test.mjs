// tests/v02-gate.test.mjs
//
// 启动闸门（budget gate）与"保护未验证即拒绝启动"的离线测试。
//
// 这组测试回答的是 2026-10-18 那次事故：预算插件的 apply 抛错时，宿主只打印
// `warning: 1 entry did not activate` 然后继续无预算运行。测试断言的不是"插件的
// 某个变量为真"，而是**真实请求有没有被挡住**——计数取自假上游服务端，而不是
// 取自闸门自己的状态字段。
//
// 边界（必须写在测试里，避免被误读）：
// - 这里的"宿主"是本地桩进程与夹具，不代表 DSH 真实宿主验收；
// - 上游是回环假服务，全程没有真实模型端点；
// - 闸门只在"宿主确实把请求发给它"时才算生效，所以每个拒绝场景都同时断言
//   假上游收到 0 条。

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBudgetGate } from '../orchestration/gate/gate.mjs';
import {
  checkBaseUrl,
  checkProtectionHeartbeat,
  decideStart,
} from '../orchestration/gate/preflight.mjs';
import { extractBaseUrlFromDump } from '../tools/gated-run.mjs';

const failures = [];
let checks = 0;
function check(condition, label, detail) {
  checks += 1;
  if (!condition) failures.push({ label, detail: detail === undefined ? null : detail });
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const gatedRun = join(repoRoot, 'tools', 'gated-run.mjs');

function scratchDir(name) {
  const dir = mkdtempSync(join(tmpdir(), 'tla-gate-' + name + '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function appendEvent(path, entry) {
  writeFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
}

async function startUpstream() {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ path: req.url, bytes: Buffer.concat(chunks).length });
      const text = JSON.stringify({ ok: true, from: 'fake-upstream', count: hits.length });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return {
    url: 'http://127.0.0.1:' + address.port,
    hits,
    count: () => hits.length,
    async close() {
      await new Promise((done) => server.close(done));
    },
  };
}

async function freePort() {
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function postMessage(baseUrl, index) {
  try {
    const response = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_notJson) {
      body = { raw: text };
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: { transport: String(error && error.message) } };
  }
}

function runLauncher(args, { timeoutMs = 20_000 } = {}) {
  // 受限沙箱下 Node 子进程不能用 pipe 捕获输出（EPERM / 命名管道），因此这里
  // 用 ignore，判据全部取自闸门写下的 JSON 证据文件。
  return new Promise((done) => {
    const child = spawn(process.execPath, [gatedRun, ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, stdout: '', stderr: '' });
    });
  });
}

const STUB_HOST = `import { readFileSync, writeFileSync } from 'node:fs';

const handshake = JSON.parse(readFileSync('./gate.json', 'utf8'));
const results = [];
for (let index = 0; index < 5; index += 1) {
  const response = await fetch(handshake.baseUrl + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ index }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_notJson) {
    body = { raw: text };
  }
  results.push({ index, status: response.status, body });
}
writeFileSync('./host-results.json', JSON.stringify(results, null, 2) + '\\n', 'utf8');
process.exit(0);
`;

// ---------------------------------------------------------------------------
// 1. 默认拒绝：没有租约时，闸门必须一条都不转发。
// ---------------------------------------------------------------------------
async function scenarioDenyByDefault() {
  const dir = scratchDir('deny');
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 3, logPath: join(dir, 'gate.jsonl') });
  const { baseUrl } = await gate.listen(0);

  const results = [];
  for (let index = 0; index < 3; index += 1) results.push(await postMessage(baseUrl, index));

  check(results.every((result) => result.status === 403), 'deny-by-default: every request is refused', results.map((r) => r.status));
  check(results.every((result) => result.body.error.code === 'TLA_GATE_DENIED'), 'deny-by-default: typed error code');
  check(results.every((result) => result.body.error.reason === 'NO_LEASE'), 'deny-by-default: reason is NO_LEASE', results.map((r) => r.body.error.reason));
  check(upstream.count() === 0, 'deny-by-default: upstream received 0 requests', upstream.count());
  check(gate.status().used === 0, 'deny-by-default: no budget consumed', gate.status().used);
  check(gate.status().rejects === 3, 'deny-by-default: rejects counted', gate.status().rejects);

  await gate.close();
  await upstream.close();
}

// ---------------------------------------------------------------------------
// 2. 正常挂载：租约内放行 N 次，第 N+1 次在转发前被拒。
// ---------------------------------------------------------------------------
async function scenarioLeasedBudget() {
  const dir = scratchDir('leased');
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 2, logPath: join(dir, 'gate.jsonl') });
  const { baseUrl } = await gate.listen(0);
  gate.grantLease();

  const first = await postMessage(baseUrl, 1);
  const second = await postMessage(baseUrl, 2);
  const third = await postMessage(baseUrl, 3);

  check(first.status === 200 && second.status === 200, 'leased: first two requests allowed', [first.status, second.status]);
  check(third.status === 403, 'leased: third request refused', third.status);
  check(third.body.error.reason === 'BUDGET_EXHAUSTED', 'leased: reason is BUDGET_EXHAUSTED', third.body.error.reason);
  check(upstream.count() === 2, 'leased: upstream received exactly the allowed count', upstream.count());
  check(gate.status().remaining === 0, 'leased: remaining is 0', gate.status().remaining);

  await gate.close();
  await upstream.close();
}

// ---------------------------------------------------------------------------
// 3. 心跳超时（运行中保护失效）：租约过期后必须重新拒绝。
// ---------------------------------------------------------------------------
async function scenarioLeaseExpiry() {
  const dir = scratchDir('expiry');
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 5, leaseTtlMs: 150, logPath: join(dir, 'gate.jsonl') });
  const { baseUrl } = await gate.listen(0);
  const lease = gate.grantLease();

  const before = await postMessage(baseUrl, 1);
  gate.heartbeat(lease.id);
  await new Promise((done) => setTimeout(done, 250));
  const afterExpiry = await postMessage(baseUrl, 2);
  const renewed = gate.heartbeat(lease.id);
  const afterRenew = await postMessage(baseUrl, 3);

  check(before.status === 200, 'expiry: request inside lease allowed', before.status);
  check(afterExpiry.status === 403, 'expiry: request after TTL refused', afterExpiry.status);
  check(afterExpiry.body.error.reason === 'LEASE_EXPIRED', 'expiry: reason is LEASE_EXPIRED', afterExpiry.body.error.reason);
  check(renewed.ok === true && afterRenew.status === 200, 'expiry: heartbeat renewal restores the lease', renewed);
  check(upstream.count() === 2, 'expiry: upstream saw only allowed requests', upstream.count());

  await gate.close();
  await upstream.close();
}

// ---------------------------------------------------------------------------
// 4. 运行中撤销 + 闸门消失：之后的请求要么被拒，要么连不上，绝不外发。
// ---------------------------------------------------------------------------
async function scenarioRuntimeLoss() {
  const dir = scratchDir('loss');
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 9, logPath: join(dir, 'gate.jsonl') });
  const { baseUrl } = await gate.listen(0);
  const lease = gate.grantLease();

  const allowed = await postMessage(baseUrl, 1);
  gate.revoke('HEARTBEAT_LOST');
  const afterRevoke = await postMessage(baseUrl, 2);
  const statusBeforeClose = gate.status();
  await gate.close();
  const afterClose = await postMessage(baseUrl, 3);
  await new Promise((done) => setTimeout(done, 100));

  check(allowed.status === 200, 'runtime-loss: request before loss allowed', allowed.status);
  check(afterRevoke.status === 403, 'runtime-loss: request after revoke refused', afterRevoke.status);
  check(afterRevoke.body.error.reason === 'REVOKED', 'runtime-loss: reason is REVOKED', afterRevoke.body.error.reason);
  check(statusBeforeClose.state === 'leased' && statusBeforeClose.used === 1, 'runtime-loss: state visible before close', statusBeforeClose.state);
  check(afterClose.status === 0, 'runtime-loss: request after gate closed fails to connect', afterClose.status);
  check(upstream.count() === 1, 'runtime-loss: upstream saw only the one allowed request', upstream.count());

  await upstream.close();
}

// ---------------------------------------------------------------------------
// 5. 判定函数：三项必须同时成立。
// ---------------------------------------------------------------------------
async function scenarioDecisionFunctions() {
  const dir = scratchDir('decision');
  const emptyLog = join(dir, 'events-empty.jsonl');
  const freshLog = join(dir, 'events-fresh.jsonl');
  const staleLog = join(dir, 'events-stale.jsonl');
  writeFileSync(emptyLog, '', 'utf8');
  appendEvent(freshLog, { event: 'mounted', at: new Date().toISOString(), limit: 2, used: 0 });
  appendEvent(staleLog, { event: 'mounted', at: new Date(Date.now() - 600_000).toISOString(), limit: 2, used: 0 });

  const missing = checkProtectionHeartbeat({ eventLog: emptyLog, now: Date.now(), maxAgeMs: 30_000 });
  const stale = checkProtectionHeartbeat({ eventLog: staleLog, now: Date.now(), maxAgeMs: 30_000 });
  const fresh = checkProtectionHeartbeat({ eventLog: freshLog, now: Date.now(), maxAgeMs: 30_000 });

  check(missing.ok === false && missing.reason === 'HEARTBEAT_MISSING', 'decide: missing heartbeat rejected', missing.reason);
  check(stale.ok === false && stale.reason === 'HEARTBEAT_STALE', 'decide: stale heartbeat rejected', stale.reason);
  check(fresh.ok === true, 'decide: fresh heartbeat accepted', fresh);

  const match = checkBaseUrl({ effectiveBaseUrl: 'http://127.0.0.1:18881/', gateBaseUrl: 'http://127.0.0.1:18881' });
  const prefixTrap = checkBaseUrl({ effectiveBaseUrl: 'http://127.0.0.1:18881', gateBaseUrl: 'http://127.0.0.1:1888' });
  const mismatch = checkBaseUrl({ effectiveBaseUrl: 'https://api.deepseek.com/anthropic', gateBaseUrl: 'http://127.0.0.1:18881' });
  check(match.ok === true, 'decide: trailing slash counts as the same baseURL', match);
  check(prefixTrap.ok === false, 'decide: host prefix must not match a longer port', prefixTrap);
  check(mismatch.ok === false && mismatch.reason === 'BASE_URL_MISMATCH', 'decide: real endpoint is not the gate', mismatch.reason);

  const blocked = decideStart({ gateReady: true, baseUrl: match, heartbeat: missing });
  const open = decideStart({ gateReady: true, baseUrl: match, heartbeat: fresh });
  check(blocked.allow === false && blocked.blockers[0].code === 'HEARTBEAT_MISSING', 'decide: any failing check blocks start', blocked.blockers);
  check(open.allow === true, 'decide: all checks pass -> start allowed', open);

  const dump = JSON.stringify([{ id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:18881' } }]);
  const extracted = extractBaseUrlFromDump(dump);
  check(extracted.ok === true && extracted.baseURL === 'http://127.0.0.1:18881', 'decide: baseURL read from effective config', extracted);
  const noUrl = extractBaseUrlFromDump(JSON.stringify([{ id: 'llm-deepseek', config: {} }]));
  check(noUrl.ok === false && noUrl.reason === 'BASE_URL_NOT_SET', 'decide: default endpoint means no gate', noUrl.reason);
  const ambiguous = extractBaseUrlFromDump(JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:1' } },
    { id: 'llm-deepseek-account', config: { baseURL: 'http://127.0.0.1:2' } },
  ]));
  check(ambiguous.ok === true, 'decide: unrelated provider entry does not create ambiguity', ambiguous);
  const realAmbiguous = extractBaseUrlFromDump(JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:1' } },
    { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:2' } },
  ]));
  check(realAmbiguous.ok === false && realAmbiguous.reason === 'BASE_URL_AMBIGUOUS', 'decide: two baseURLs is ambiguous -> refuse', realAmbiguous.reason);
}

// ---------------------------------------------------------------------------
// 6. 运行器集成：baseURL 不在闸门上 → 连宿主都不启动；
//    插件缺失 / 心跳陈旧（apply 抛错的后果）→ 宿主启动但请求全被拒（0 外发），
//    运行器随后终止宿主并返回 3。
// ---------------------------------------------------------------------------
async function scenarioLauncherRefusals() {
  const upstream = await startUpstream();

  // 6a baseURL 指向真实端点：闸门不在路径上，必须在启动前拒绝。
  {
    const dir = scratchDir('launcher-realurl');
    const port = await freePort();
    writeJson(join(dir, 'dump.json'), [{ id: 'llm-deepseek', config: { baseURL: 'https://api.deepseek.com/anthropic' } }]);
    const log = join(dir, 'events.jsonl');
    appendEvent(log, { event: 'mounted', at: new Date().toISOString(), limit: 2, used: 0 });
    const stub = join(dir, 'stub-host.mjs');
    writeFileSync(stub, STUB_HOST, 'utf8');
    const result = await runLauncher([
      '--upstream', upstream.url,
      '--model-requests', '2',
      '--gate-port', String(port),
      '--run-dir', dir,
      '--heartbeat-file', log,
      '--dump-config-from', join(dir, 'dump.json'),
      '--timeout-ms', '800',
      '--',
      process.execPath, stub,
    ]);
    const summary = JSON.parse(readFileSync(join(dir, 'gate-summary.json'), 'utf8'));
    check(result.code === 3, 'launcher-realurl: exit 3', result.code);
    check(summary.hostStarted === false, 'launcher-realurl: host never started');
    check(existsSync(join(dir, 'host-results.json')) === false, 'launcher-realurl: stub host never ran');
    check(summary.decision.blockers.some((blocker) => blocker.code === 'BASE_URL_MISMATCH'), 'launcher-realurl: BASE_URL_MISMATCH');
  }

  // 6b 插件缺失：没有 event log。宿主照常启动，但每条请求都被闸门拒绝。
  // 6c apply 抛错：event log 里只有更早那次的陈旧 mounted。
  const afterStart = [
    { name: 'plugin-missing', heartbeat: 'absent', expect: 'HEARTBEAT_MISSING' },
    { name: 'apply-throw-stale-heartbeat', heartbeat: 'stale', expect: 'HEARTBEAT_STALE' },
  ];
  for (const testCase of afterStart) {
    const dir = scratchDir('launcher-' + testCase.name);
    const port = await freePort();
    writeJson(join(dir, 'dump.json'), [{ id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:' + port } }]);
    const log = join(dir, 'events.jsonl');
    if (testCase.heartbeat === 'absent') {
      // 不创建文件：模拟插件根本没挂载。
    } else {
      appendEvent(log, { event: 'mounted', at: new Date(Date.now() - 600_000).toISOString(), limit: 2, used: 0 });
    }
    const stub = join(dir, 'stub-host.mjs');
    writeFileSync(stub, STUB_HOST, 'utf8');
    const result = await runLauncher([
      '--upstream', upstream.url,
      '--model-requests', '2',
      '--gate-port', String(port),
      '--run-dir', dir,
      '--heartbeat-file', log,
      '--dump-config-from', join(dir, 'dump.json'),
      '--timeout-ms', '1200',
      '--',
      process.execPath, stub,
    ]);
    const summary = JSON.parse(readFileSync(join(dir, 'gate-summary.json'), 'utf8'));
    const hostResults = existsSync(join(dir, 'host-results.json')) ? JSON.parse(readFileSync(join(dir, 'host-results.json'), 'utf8')) : null;
    check(result.code === 3, 'launcher-unprotected (' + testCase.name + '): exit 3', result.code);
    check(summary.hostStarted === true, 'launcher-unprotected (' + testCase.name + '): host did start');
    check(summary.decision.allow === false, 'launcher-unprotected (' + testCase.name + '): decision blocks');
    check(summary.decision.blockers.some((blocker) => blocker.code === testCase.expect), 'launcher-unprotected (' + testCase.name + '): blocker ' + testCase.expect, summary.decision.blockers);
    check(hostResults !== null && hostResults.every((entry) => entry.status === 403), 'launcher-unprotected (' + testCase.name + '): every host request was refused', hostResults && hostResults.map((entry) => entry.status));
    check(summary.gate.used === 0, 'launcher-unprotected (' + testCase.name + '): no budget consumed', summary.gate.used);
  }

  check(upstream.count() === 0, 'launcher-refusal: upstream received 0 requests across all unprotected runs', upstream.count());
  await upstream.close();
}

// ---------------------------------------------------------------------------
// 7. 运行器集成：保护成立 → 放行预算内请求，超出即拒，且宿主能读到拒绝原因。
// ---------------------------------------------------------------------------
async function scenarioLauncherLeased() {
  const dir = scratchDir('launcher-ok');
  const upstream = await startUpstream();
  const port = await freePort();
  writeJson(join(dir, 'dump.json'), [{ id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:' + port } }]);
  const heartbeat = join(dir, 'events.jsonl');
  appendEvent(heartbeat, { event: 'mounted', at: new Date().toISOString(), limit: 2, used: 0 });
  const stub = join(dir, 'stub-host.mjs');
  writeFileSync(stub, STUB_HOST, 'utf8');

  const result = await runLauncher([
    '--upstream', upstream.url,
    '--model-requests', '2',
    '--gate-port', String(port),
    '--run-dir', dir,
    '--heartbeat-file', heartbeat,
    '--dump-config-from', join(dir, 'dump.json'),
    '--lease-ttl-ms', '5000',
    '--timeout-ms', '5000',
    '--',
    process.execPath, stub,
  ]);

  const results = JSON.parse(readFileSync(join(dir, 'host-results.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(join(dir, 'gate-summary.json'), 'utf8'));
  const statuses = results.map((entry) => entry.status);

  check(result.code === 0, 'launcher-leased: launcher exits 0', { code: result.code, stderr: result.stderr.slice(0, 400) });
  check(statuses.join(',') === '200,200,403,403,403', 'launcher-leased: stub host sees 2 allowed then 3 denied', statuses);
  check(results[2].body.error.reason === 'BUDGET_EXHAUSTED', 'launcher-leased: denial reason reaches the host', results[2].body.error.reason);
  check(upstream.count() === 2, 'launcher-leased: upstream received exactly the budget', upstream.count());
  check(summary.result === 'host-ok' && summary.hostStarted === true, 'launcher-leased: summary records a started host', summary.result);
  check(summary.gate.used === 2 && summary.gate.rejects === 3, 'launcher-leased: gate counters match the server log', summary.gate);

  await upstream.close();
}

async function main() {
  await scenarioDenyByDefault();
  await scenarioLeasedBudget();
  await scenarioLeaseExpiry();
  await scenarioRuntimeLoss();
  await scenarioDecisionFunctions();
  await scenarioLauncherRefusals();
  await scenarioLauncherLeased();

  const scenarios = 7;
  for (const failure of failures) {
    process.stdout.write('FAIL ' + failure.label + (failure.detail === null ? '' : ' :: ' + JSON.stringify(failure.detail)) + '\n');
  }
  process.stdout.write('v02-gate: ' + scenarios + ' scenarios, ' + checks + ' checks, ' + failures.length + ' failed\n');
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write('FAIL uncaught :: ' + String(error && error.stack ? error.stack : error) + '\n');
  process.exit(1);
});
