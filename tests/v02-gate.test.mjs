// tests/v02-gate.test.mjs
//
// 闸门（gate.mjs）+ 启动前判定（preflight.mjs）+ 启动器（tools/gated-run.mjs）的
// 离线测试。
//
// 边界声明（必须与代码一致）：
// - 这里的"宿主"是**本地夹具进程**（stub），不是真实 DSH；"上游"是本地回环假服务；
//   因此这些测试证明的是"闸门的判定与拒绝路径"，**不等于宿主级验收**。
// - 闸门只在"宿主真的把请求发给它"时才算保护生效；测试里由 stub 主动连闸门来模拟。
// - 不访问任何真实模型端点、不读凭据、不开公网端口。
//
// 2026-10-18 独立审查（P0-1/P0-2/P0-3/P0-4/P0-5、P1）后的反例覆盖：
//   A 未经认证的 /lease 不能获得租约；B revoke 后不能再 grant；
//   C 过期租约不能被迟到心跳复活；D 撤销后状态不得显示为 leased；
//   E 已 unmounted 时旧 mounted 不能放行；F 其他运行预写的 mounted 不能授权；
//   G runId 不匹配/日志损坏/事件顺序冲突默认拒绝；
//   H 配置输出不完整（半截 YAML）时启动器拒绝启动；
//   I 未知 provider / 嵌套 disabled / 异常 YAML 不得误判为覆盖率完整；
//   J 宿主存活但无心跳时 --timeout-ms 必须生效（不能无限等）；
//   K 子进程无响应时不能无限挂起（SIGKILL 升级）；
//   M 10 并发争 1 个额度只放行一次；N 正常路径在预算内完成请求。

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBudgetGate, GateError } from '../orchestration/gate/gate.mjs';
import {
  checkBaseUrl,
  checkProtectionHeartbeat,
  decideStart,
  evaluateMountProof,
  extractProviderCoverage,
  normalizeBaseUrl,
  parseDumpConfigStrict,
  REVIEWED_PLUGIN_EVIDENCE,
  fingerprintPluginDir,
  verifyInstalledPlugin,
  verifyPluginAgainst,
} from '../orchestration/gate/preflight.mjs';
import { parseArgs, UsageError, EXIT_OK, EXIT_PROTECTION_UNVERIFIED, terminateHost } from '../tools/gated-run.mjs';

const failures = [];
let checks = 0;
function check(condition, label, detail) {
  checks += 1;
  if (condition !== true) failures.push(label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
}

const scratch = mkdtempSync(join(tmpdir(), 'tla-gate-'));
const scratchDir = scratch;
// 启动器场景要在"某个 profile 里真的装着被引用的插件"这一前提下运行，
// 否则插件身份核对会（正确地）拒绝启动。这里造一个临时 DSH_HOME，
// 把本仓库的拦截器原样复制进去：指纹来自副本，不依赖本机隔离 profile。
const launcherHome = join(scratch, 'dsh-home');
mkdirSync(join(launcherHome, 'profiles', 'stage1', 'node_modules'), { recursive: true });
const launcherPluginDir = join(launcherHome, 'profiles', 'stage1', 'node_modules', 'tla-prelaunch-budget');
mkdirSync(join(launcherPluginDir, 'lib'), { recursive: true });
for (const rel of ['package.json', 'index.js', 'lib/budget.mjs']) {
  writeFileSync(join(launcherPluginDir, rel), readFileSync(resolve('orchestration/interceptor-plugin', rel)));
}
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function appendEvent(path, entry) {
  appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
}

async function startUpstream() {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, bytes: Buffer.concat(chunks).length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  return {
    url: 'http://127.0.0.1:' + port,
    hits,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function postMessage(baseUrl, path = '/v1/messages') {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_notJson) {
    body = null;
  }
  return { status: response.status, body };
}

async function postControl(baseUrl, path, method = 'POST') {
  const response = await fetch(baseUrl + path, { method });
  let body = null;
  try {
    body = await response.json();
  } catch (_notJson) {
    body = null;
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// 夹具：宿主 stub 两种角色
//   1) `--dump-config` 在 argv 里 → 把 STUB_DUMP_FILE 的内容写到 stdout 后退出；
//      也可用 STUB_DUMP_MODE=missing|partial|sleep|crash 模拟探测异常。
//   2) 否则扮演宿主：按 STUB_EVENTS_MODE 写运行事件（或什么都不写），连发 5 次请求，
//      把结果写到 ./host-results.json。
// 事件里的 runId 从启动器写的 ./gate.json 读——这样"证明"绑定的是**本次**运行。
// ---------------------------------------------------------------------------
const STUB_HOST = `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const dumpMode = process.env.STUB_DUMP_MODE || 'file';
if (argv.includes('--dump-config')) {
  if (dumpMode === 'missing') process.exit(0);
  if (dumpMode === 'sleep') { await new Promise((d) => setTimeout(d, 30000)); process.exit(0); }
  if (dumpMode === 'crash') process.exit(3);
  if (dumpMode === 'partial') { process.stdout.write("- id: llm-deepseek\\n  name: '@deepseek-ai/dsh-llm-deepseek-api-key'\\n  config:\\n"); process.exit(0); }
  process.stdout.write(readFileSync(process.env.STUB_DUMP_FILE, 'utf8'));
  process.exit(0);
}
const runDir = process.cwd();
const gate = JSON.parse(readFileSync(join(runDir, 'gate.json'), 'utf8'));
const mode = process.env.STUB_EVENTS_MODE || 'ok';
const events = process.env.STUB_EVENTS;
const writeEvent = (entry) => appendFileSync(events, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\\n', 'utf8');
if (mode === 'ok') { writeEvent({ event: 'mounted', runId: gate.runId }); writeEvent({ event: 'heartbeat', runId: gate.runId }); }
if (mode === 'probe-leak') { writeEvent({ event: 'mounted', runId: gate.runId + '-probe' }); writeEvent({ event: 'heartbeat', runId: gate.runId + '-probe' }); }
if (mode === 'foreign') writeEvent({ event: 'mounted', runId: 'other-run' });
if (mode === 'unmounted') { writeEvent({ event: 'mounted', runId: gate.runId }); writeEvent({ event: 'unmounted', runId: gate.runId }); }
if (mode === 'corrupt') { writeEvent({ event: 'mounted', runId: gate.runId }); appendFileSync(events, 'this is not json\\n', 'utf8'); }
if (mode === 'unordered') { writeEvent({ event: 'heartbeat', runId: gate.runId }); }
if (mode === 'stale') { writeEvent({ event: 'mounted', runId: gate.runId, at: new Date(Date.now() - 600000).toISOString() }); }
if (process.env.STUB_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
const beat = setInterval(() => { if (mode === 'ok') writeEvent({ event: 'heartbeat', runId: gate.runId }); }, 200);
if (typeof beat.unref === 'function') beat.unref();
if (mode === 'silent-long' || mode === 'ignore-sigterm') { await new Promise((d) => setTimeout(d, 20000)); process.exit(0); }
const results = [];
for (let i = 0; i < 5; i += 1) {
  const res = await fetch(gate.baseUrl + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  results.push(res.status);
}
writeFileSync(join(runDir, 'host-results.json'), JSON.stringify({ results }) + '\\n', 'utf8');
process.exit(0);
`;
const stubPath = join(scratch, 'stub-host.mjs');
writeFileSync(stubPath, STUB_HOST, 'utf8');

function writeDumpYaml(path, providers) {
  const lines = [];
  for (const provider of providers) {
    lines.push('- id: ' + provider.id);
    lines.push("  name: '" + provider.name + "'");
    if (provider.disabled === true) lines.push('  disabled: true');
    if (provider.config !== undefined) {
      lines.push('  config:');
      for (const [key, value] of Object.entries(provider.config)) {
        lines.push('    ' + key + ': ' + value);
      }
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

function runLauncher(args, { timeoutMs = 40000, env = {} } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve('tools/gated-run.mjs'), ...args], {
      stdio: 'ignore',
      env: { ...process.env, DSH_HOME: launcherHome, ...env },
    });
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_gone) {
        // 已经退出。
      }
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, elapsedMs: Date.now() - startedAt });
    });
  });
}

function baseLauncherArgs({ upstream, runDir, modelRequests, dumpFile, patch, extra = [] }) {
  return [
    '--upstream', upstream,
    '--model-requests', String(modelRequests),
    '--run-dir', runDir,
    '--heartbeat-file', join(runDir, 'plugin-events.jsonl'),
    '--heartbeat-max-age-ms', '3000',
    '--timeout-ms', '4000',
    '--dsh-exe', process.execPath,
    '--dsh-cli', stubPath,
    '--profile', 'stage1',
    '--patch', patch,
    '--prompt', 'stub prompt',
    ...extra,
  ];
}

// ---------------------------------------------------------------------------

async function scenarioControlPlaneReadOnly() {
  const upstream = await startUpstream();
  const log = join(scratch, 'control-gate.jsonl');
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 3, leaseTtlMs: 5000, logPath: log });
  const { baseUrl } = await gate.listen(0);
  try {
    // A：HTTP 上没有任何"发租约"的入口，也不存在"回环即授权"。
    const leaseAttempt = await postControl(baseUrl, '/__tla/gate/lease');
    check(leaseAttempt.status === 405, 'control: POST /lease is not an endpoint', leaseAttempt);
    check(leaseAttempt.body && leaseAttempt.body.error && leaseAttempt.body.error.code === 'GATE_CONTROL_READ_ONLY', 'control: /lease answers READ_ONLY', leaseAttempt.body);
    const heartbeatAttempt = await postControl(baseUrl, '/__tla/gate/heartbeat');
    check(heartbeatAttempt.status === 405, 'control: POST /heartbeat is not an endpoint', heartbeatAttempt.status);
    const revokeAttempt = await postControl(baseUrl, '/__tla/gate/revoke');
    check(revokeAttempt.status === 405, 'control: POST /revoke is not an endpoint', revokeAttempt.status);
    const statusAfter = await postControl(baseUrl, '/__tla/gate/status', 'GET');
    check(statusAfter.status === 200, 'control: status remains readable', statusAfter.status);
    check(statusAfter.body && statusAfter.body.lease === null, 'control: unauthenticated control calls granted no lease', statusAfter.body && statusAfter.body.lease);

    const denied = [];
    for (let i = 0; i < 3; i += 1) denied.push(await postMessage(baseUrl));
    check(denied.every((result) => result.status === 403), 'control: no lease -> every request denied', denied.map((r) => r.status));
    check(denied.every((result) => result.body.error.reason === 'NO_LEASE'), 'control: deny reason is NO_LEASE', denied[1].body.error);
    check(upstream.hits.length === 0, 'control: upstream received nothing', upstream.hits.length);
  } finally {
    await gate.close();
    await upstream.close();
  }
}

async function scenarioLeasedBudget() {
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 2, leaseTtlMs: 5000, logPath: join(scratch, 'budget-gate.jsonl') });
  const { baseUrl } = await gate.listen(0);
  try {
    gate.grantLease();
    const first = await postMessage(baseUrl);
    const second = await postMessage(baseUrl);
    const third = await postMessage(baseUrl);
    check(first.status === 200 && second.status === 200, 'budget: two leased requests forwarded', [first.status, second.status]);
    check(third.status === 403 && third.body.error.reason === 'BUDGET_EXHAUSTED', 'budget: third denied as BUDGET_EXHAUSTED', third.status);
    check(upstream.hits.length === 2, 'budget: upstream saw exactly the allowed requests', upstream.hits.length);
    check(gate.status().used === 2 && gate.status().remaining === 0, 'budget: usage accounted', gate.status());
  } finally {
    await gate.close();
    await upstream.close();
  }
}

async function scenarioExpiryCannotBeRevived() {
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 5, leaseTtlMs: 120, logPath: join(scratch, 'expiry-gate.jsonl') });
  const { baseUrl } = await gate.listen(0);
  try {
    const lease = gate.grantLease();
    await sleep(220);
    // C：迟到的续期不能复活已过期的租约。
    const late = gate.heartbeat(lease.id);
    check(late.ok === false && late.reason === 'LEASE_EXPIRED', 'expiry: late heartbeat is rejected', late);
    const status = gate.status();
    check(status.lease && status.lease.state === 'expired', 'expiry: status reports expired', status.lease);
    const denied = await postMessage(baseUrl);
    check(denied.status === 403 && denied.body.error.reason === 'LEASE_EXPIRED', 'expiry: request denied with LEASE_EXPIRED', denied.status);
    // 过期后可以显式换新租约，但已消耗的计数不重置。
    const before = gate.status().used;
    const fresh = gate.grantLease();
    check(typeof fresh.id === 'string' && gate.status().used === before, 'expiry: new lease does not reset the counter', gate.status());
    check((await postMessage(baseUrl)).status === 200, 'expiry: new lease works again');
    check(upstream.hits.length === 1, 'expiry: only the authorized request reached upstream', upstream.hits.length);
  } finally {
    await gate.close();
    await upstream.close();
  }
}

async function scenarioRevokeIsPermanent() {
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 5, leaseTtlMs: 5000, logPath: join(scratch, 'revoke-gate.jsonl') });
  const { baseUrl } = await gate.listen(0);
  try {
    const lease = gate.grantLease();
    gate.revoke('TEST_REVOKE');
    // D：撤销后状态必须如实显示，且不能再被当作正常 leased。
    const status = gate.status();
    check(status.lease && status.lease.state === 'revoked', 'revoke: status reports revoked', status.lease);
    check(status.state === 'revoked', 'revoke: gate state reports revoked', status.state);
    // B：撤销是永久的，即使调用同进程的收租入口也不能恢复。
    let thrown = null;
    try {
      gate.grantLease();
    } catch (error) {
      thrown = error;
    }
    check(thrown !== null && thrown.code === 'GATE_REVOKED', 'revoke: grantLease throws GATE_REVOKED', thrown && thrown.code);
    const renewed = gate.heartbeat(lease.id);
    check(renewed.ok === false && renewed.reason === 'REVOKED', 'revoke: heartbeat rejected after revoke', renewed);
    const denied = await postMessage(baseUrl);
    check(denied.status === 403 && denied.body.error.reason === 'REVOKED', 'revoke: request denied with REVOKED', denied.status);
    check(upstream.hits.length === 0, 'revoke: nothing forwarded', upstream.hits.length);
    await gate.close();
    // 关闭后既不发租约，也不再接受连接。
    let closedThrown = null;
    try {
      gate.grantLease();
    } catch (error) {
      closedThrown = error;
    }
    check(closedThrown !== null && (closedThrown.code === 'GATE_CLOSING' || closedThrown.code === 'GATE_REVOKED'), 'revoke: no lease after close', closedThrown && closedThrown.code);
    let connectFailed = false;
    try {
      await postMessage(baseUrl);
    } catch (_refused) {
      connectFailed = true;
    }
    check(connectFailed, 'revoke: closed gate refuses connections');
  } finally {
    await upstream.close();
  }
}

async function scenarioMountProofRunBinding() {
  const upstream = await startUpstream();
  const runDir = join(scratch, 'mount-binding');
  mkdirSync(runDir, { recursive: true });
  const events = join(runDir, 'plugin-events.jsonl');
  const gate = createBudgetGate({
    upstream: upstream.url,
    modelRequests: 3,
    leaseTtlMs: 5000,
    logPath: join(runDir, 'gate.jsonl'),
    mountProof: { eventLog: events, runId: 'run-A', maxAgeMs: 3000 },
  });
  const { baseUrl } = await gate.listen(0);
  try {
    // F（纯判定）：别的运行预先写下的 mounted（即使新鲜）不得授权本次运行。
    const foreignFile = join(runDir, 'foreign.jsonl');
    appendEvent(foreignFile, { event: 'mounted', runId: 'run-OLD' });
    const foreignProof = evaluateMountProof({ eventLog: foreignFile, runId: 'run-A', now: Date.now(), maxAgeMs: 3000 });
    check(foreignProof.ok === false && foreignProof.reason === 'PROOF_FOREIGN_RUN', 'mount: foreign runId proof rejected', foreignProof.reason);

    // G：事件顺序冲突（第一条不是 mounted）默认拒绝。
    const outOfOrder = join(runDir, 'unordered.jsonl');
    appendEvent(outOfOrder, { event: 'heartbeat', runId: 'run-A' });
    const outOfOrderProof = evaluateMountProof({ eventLog: outOfOrder, runId: 'run-A', now: Date.now(), maxAgeMs: 3000 });
    check(outOfOrderProof.ok === false && outOfOrderProof.reason === 'PROOF_UNORDERED', 'mount: unordered proof rejected', outOfOrderProof.reason);

    // G：损坏行默认拒绝（不跳过）。
    const corrupt = join(runDir, 'corrupt.jsonl');
    appendEvent(corrupt, { event: 'mounted', runId: 'run-A' });
    appendFileSync(corrupt, 'not json\n', 'utf8');
    const corruptProof = evaluateMountProof({ eventLog: corrupt, runId: 'run-A', now: Date.now(), maxAgeMs: 3000 });
    check(corruptProof.ok === false && corruptProof.reason === 'PROOF_UNREADABLE', 'mount: corrupt log rejected', corruptProof.reason);

    // F2（配置探测泄漏）：探测阶段写下的 mounted 带 `<runId>-probe`，正式运行不认。
    const probeFile = join(runDir, 'probe-leak.jsonl');
    appendEvent(probeFile, { event: 'mounted', runId: 'run-A-probe' });
    appendEvent(probeFile, { event: 'heartbeat', runId: 'run-A-probe' });
    const probeProof = evaluateMountProof({ eventLog: probeFile, runId: 'run-A', now: Date.now(), maxAgeMs: 60000 });
    check(probeProof.ok === false && probeProof.reason === 'PROOF_FOREIGN_RUN', 'mount: probe-phase proof cannot authorize the host run', probeProof.reason);

    // F3（启动前预写）：同 runId 的 mounted 若早于本次宿主启动时刻，也不授权。
    const prestartFile = join(runDir, 'prestart.jsonl');
    appendEvent(prestartFile, { event: 'mounted', runId: 'run-A' });
    appendEvent(prestartFile, { event: 'heartbeat', runId: 'run-A' });
    const prestartProof = evaluateMountProof({ eventLog: prestartFile, runId: 'run-A', now: Date.now(), maxAgeMs: 60000, notBefore: Date.now() + 5_000 });
    check(prestartProof.ok === false && prestartProof.reason === 'PROOF_PRE_START', 'mount: proof written before host start is rejected', prestartProof.reason);

    // F4（只有 mounted、没有心跳）：说明写事件的东西没有持续运行，不授权。
    const mountOnly = join(runDir, 'mount-only.jsonl');
    appendEvent(mountOnly, { event: 'mounted', runId: 'run-A' });
    const mountOnlyProof = evaluateMountProof({ eventLog: mountOnly, runId: 'run-A', now: Date.now(), maxAgeMs: 6000, requireHeartbeat: true });
    check(mountOnlyProof.ok === false && mountOnlyProof.reason === 'PROOF_NO_HEARTBEAT', 'mount: a mount without a heartbeat is rejected', mountOnlyProof.reason);

    // 本次运行的 mounted → 允许一次（共享给后续请求），随后 E：unmounted 终止证明。
    appendEvent(events, { event: 'mounted', runId: 'run-A' });
    const allowed = await postMessage(baseUrl);
    check(allowed.status === 200, 'mount: fresh run-bound mount authorizes the first request', allowed.status);
    const second = await postMessage(baseUrl);
    check(second.status === 200, 'mount: lease continues after mount grant', second.status);
    appendEvent(events, { event: 'unmounted', runId: 'run-A' });
    const ended = await postMessage(baseUrl);
    check(ended.status === 403, 'mount: unmounted ends the proof', ended.status);
    check(upstream.hits.length === 2, 'mount: upstream only saw the two authorized requests', upstream.hits.length);

    // 心跳判定：陈旧事件不新鲜、缺失即缺失。
    // 注意 mounted 的年龄不再参与运行期判定——这里构造的是"心跳本身陈旧"。
    const staleFile = join(runDir, 'stale.jsonl');
    appendEvent(staleFile, { event: 'mounted', runId: 'run-A', at: new Date(Date.now() - 60000).toISOString() });
    appendEvent(staleFile, { event: 'heartbeat', runId: 'run-A', at: new Date(Date.now() - 30000).toISOString() });
    const stale = checkProtectionHeartbeat({ eventLog: staleFile, runId: 'run-A', now: Date.now(), maxAgeMs: 2000 });
    check(stale.ok === false && stale.reason === 'HEARTBEAT_STALE', 'heartbeat: staleness detected', stale.reason);

    // 长期健康运行：mounted 很旧，但最新心跳很新 → 仍应判活（复审问题 1）。
    const longRunFile = join(runDir, 'long-run.jsonl');
    appendEvent(longRunFile, { event: 'mounted', runId: 'run-long', at: new Date(Date.now() - 60_000).toISOString() });
    appendEvent(longRunFile, { event: 'heartbeat', runId: 'run-long', at: new Date(Date.now() - 5).toISOString() });
    const longRunBeat = checkProtectionHeartbeat({ eventLog: longRunFile, runId: 'run-long', now: Date.now(), maxAgeMs: 2000 });
    check(longRunBeat.ok === true, 'heartbeat: old mount with fresh heartbeat stays alive', longRunBeat);
    const longRunProof = evaluateMountProof({ eventLog: longRunFile, runId: 'run-long', now: Date.now(), requireHeartbeat: true });
    check(longRunProof.ok === true, 'heartbeat: mount proof does not expire with the mount age', longRunProof);

    // 卸载终态：unmounted 之后迟到的心跳不能复活（复审问题 2）。
    const revivedFile = join(runDir, 'revived.jsonl');
    const t0 = Date.now();
    appendEvent(revivedFile, { event: 'mounted', runId: 'run-revived', at: new Date(t0 - 3000).toISOString() });
    appendEvent(revivedFile, { event: 'unmounted', runId: 'run-revived', at: new Date(t0 - 2000).toISOString() });
    appendEvent(revivedFile, { event: 'heartbeat', runId: 'run-revived', at: new Date(t0 - 5).toISOString() });
    const revivedBeat = checkProtectionHeartbeat({ eventLog: revivedFile, runId: 'run-revived', now: Date.now(), maxAgeMs: 2000 });
    check(revivedBeat.ok === false && revivedBeat.reason === 'RUN_ENDED', 'heartbeat: late heartbeat after unmount is rejected', revivedBeat);
    const revivedProof = evaluateMountProof({ eventLog: revivedFile, runId: 'run-revived', now: Date.now(), requireHeartbeat: true });
    check(revivedProof.ok === false && revivedProof.reason === 'PROOF_AFTER_UNMOUNT', 'heartbeat: unmount is terminal for the mount proof', revivedProof);

    // 重复 mounted：同一 runId 内第二次挂载需要新的运行身份。
    const dupFile = join(runDir, 'dup.jsonl');
    appendEvent(dupFile, { event: 'mounted', runId: 'run-dup', at: new Date(t0 - 3000).toISOString() });
    appendEvent(dupFile, { event: 'heartbeat', runId: 'run-dup', at: new Date(t0 - 2500).toISOString() });
    appendEvent(dupFile, { event: 'mounted', runId: 'run-dup', at: new Date(t0 - 1000).toISOString() });
    const dupProof = evaluateMountProof({ eventLog: dupFile, runId: 'run-dup', now: Date.now(), requireHeartbeat: false });
    check(dupProof.ok === false && dupProof.reason === 'PROOF_DUPLICATE_MOUNT', 'heartbeat: duplicate mount is rejected', dupProof);

    // 时间倒序：事件时间回退说明日志不可信。
    const orderFile = join(runDir, 'reversed.jsonl');
    appendEvent(orderFile, { event: 'mounted', runId: 'run-order', at: new Date(t0 - 1000).toISOString() });
    appendEvent(orderFile, { event: 'heartbeat', runId: 'run-order', at: new Date(t0 - 2000).toISOString() });
    const reversed = evaluateMountProof({ eventLog: orderFile, runId: 'run-order', now: Date.now() });
    check(reversed.ok === false && reversed.reason === 'PROOF_TIME_ORDER', 'heartbeat: reversed timestamps are rejected', reversed);

    // 损坏日志：一行坏 JSON 就让整份证明不可用。
    const corruptFile = join(runDir, 'corrupt.jsonl');
    appendEvent(corruptFile, { event: 'mounted', runId: 'run-corrupt', at: new Date(t0 - 1000).toISOString() });
    appendFileSync(corruptFile, '{not json\n');
    const corruptRead = checkProtectionHeartbeat({ eventLog: corruptFile, runId: 'run-corrupt', now: Date.now(), maxAgeMs: 2000 });
    check(corruptRead.ok === false, 'heartbeat: corrupt log is rejected', corruptRead);
    const missing = checkProtectionHeartbeat({ eventLog: join(runDir, 'nope.jsonl'), runId: 'run-A', now: Date.now(), maxAgeMs: 3000 });
    check(missing.ok === false && missing.reason === 'HEARTBEAT_MISSING', 'heartbeat: missing log detected', missing.reason);
  } finally {
    await gate.close();
    await upstream.close();
  }
}

async function scenarioConcurrencyLastSlot() {
  const upstream = await startUpstream();
  const gate = createBudgetGate({ upstream: upstream.url, modelRequests: 1, leaseTtlMs: 5000, logPath: join(scratch, 'concurrent-gate.jsonl') });
  const { baseUrl } = await gate.listen(0);
  try {
    gate.grantLease();
    // M：10 个并发请求争 1 个额度。
    const results = await Promise.all(Array.from({ length: 10 }, () => postMessage(baseUrl)));
    const okCount = results.filter((result) => result.status === 200).length;
    const deniedCount = results.filter((result) => result.status === 403).length;
    check(okCount === 1, 'concurrency: exactly one request allowed', okCount);
    check(deniedCount === 9, 'concurrency: the rest denied', deniedCount);
    check(results.filter((r) => r.status === 403).every((r) => r.body.error.reason === 'BUDGET_EXHAUSTED'), 'concurrency: denials are BUDGET_EXHAUSTED');
    check(upstream.hits.length === 1, 'concurrency: upstream saw exactly one request', upstream.hits.length);
    check(gate.status().used === 1, 'concurrency: counter is one', gate.status().used);
  } finally {
    await gate.close();
    await upstream.close();
  }
}

function scenarioDecisionFunctions() {
  const gateUrl = 'http://127.0.0.1:18778';
  check(checkBaseUrl({ effectiveBaseUrl: gateUrl, gateBaseUrl: gateUrl }).ok === true, 'decision: exact baseURL matches');
  check(checkBaseUrl({ effectiveBaseUrl: gateUrl + '/', gateBaseUrl: gateUrl }).ok === true, 'decision: trailing slash tolerated');
  check(checkBaseUrl({ effectiveBaseUrl: 'http://127.0.0.1:1877', gateBaseUrl: gateUrl }).ok === false, 'decision: port prefix does not match');
  check(checkBaseUrl({ effectiveBaseUrl: 'https://api.deepseek.com/anthropic', gateBaseUrl: gateUrl }).reason === 'BASE_URL_MISMATCH', 'decision: real endpoint rejected');
  check(checkBaseUrl({ effectiveBaseUrl: null, gateBaseUrl: gateUrl }).reason === 'BASE_URL_INVALID', 'decision: missing baseURL rejected');
  check(normalizeBaseUrl('http://127.0.0.1:18778/') === gateUrl, 'decision: normalize strips trailing slash');

  const entries = parseDumpConfigStrict(
    [
      '- id: llm-deepseek',
      "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
      '  config:',
      '    baseURL: ' + gateUrl,
      '- id: llm-deepseek-account',
      "  name: '@deepseek-ai/dsh-llm-deepseek-account'",
      '  config:',
      '    baseURL: ' + gateUrl,
    ].join('\n'),
  );
  check(entries.ok === true, 'decision: yaml parses', entries);
  const coverage = extractProviderCoverage(entries.entries, gateUrl);
  check(coverage.guarded.length === 2 && coverage.unguarded.length === 0, 'decision: both providers guarded', coverage);

  const perfect = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage });
  check(perfect.allow === true, 'decision: full coverage allows start', perfect.blockers);

  const unguardedCoverage = extractProviderCoverage(
    parseDumpConfigStrict(
      [
        '- id: llm-deepseek',
        "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
        '  config:',
        '    baseURL: ' + gateUrl,
        '- id: llm-deepseek-account',
        "  name: '@deepseek-ai/dsh-llm-deepseek-account'",
      ].join('\n'),
    ).entries,
    gateUrl,
  );
  const unguardedDecision = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage: unguardedCoverage });
  check(unguardedDecision.allow === false && unguardedDecision.blockers.some((b) => b.code === 'PROVIDER_NOT_GATED'), 'decision: unguarded provider blocks start', unguardedDecision.blockers);

  // 没有覆盖率信息不能启动（不能"默认当作没事"）。
  const unknownCoverageDecision = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage: null });
  check(unknownCoverageDecision.allow === false && unknownCoverageDecision.blockers.some((b) => b.code === 'COVERAGE_UNVERIFIABLE'), 'decision: missing coverage blocks start', unknownCoverageDecision.blockers);

  const noGuardDecision = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage: { guarded: [], unguarded: [], unknown: [] } });
  check(noGuardDecision.allow === false && noGuardDecision.blockers.some((b) => b.code === 'NO_GATED_PROVIDER'), 'decision: zero guarded providers blocks start', noGuardDecision.blockers);
}

function scenarioYamlStrictness() {
  const gateUrl = 'http://127.0.0.1:18778';
  const base = [
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
    '  config:',
    '    baseURL: ' + gateUrl,
  ].join('\n');
  check(parseDumpConfigStrict(base).ok === true, 'yaml: baseline accepted');

  // 缩进不同的列表、嵌套 disabled、重复 id、缺 name、未知 provider、pi-ai 聚合。
  const nested = [
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
    '  config:',
    '    baseURL: ' + gateUrl,
    '    disabled: true',
  ].join('\n');
  const nestedParsed = parseDumpConfigStrict(nested);
  check(nestedParsed.ok === true, 'yaml: nested block parses', nestedParsed);
  const nestedCoverage = extractProviderCoverage(nestedParsed.entries, gateUrl);
  check(nestedCoverage.disabled.length === 1 && nestedCoverage.guarded.length === 0, 'yaml: nested disabled not counted as guarded', nestedCoverage);

  const duplicateId = parseDumpConfigStrict(base + '\n' + base.split('\n').slice(0, 1).join('\n'));
  check(duplicateId.ok === false && duplicateId.code === 'CONFIG_DUPLICATE_ID', 'yaml: duplicate id rejected', duplicateId.code);

  const duplicateKey = parseDumpConfigStrict(
    ['- id: llm-deepseek', "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'", '  config:', '    baseURL: ' + gateUrl, '    baseURL: ' + gateUrl].join('\n'),
  );
  check(duplicateKey.ok === false && duplicateKey.code === 'CONFIG_DUPLICATE_KEY', 'yaml: duplicate key rejected', duplicateKey.code);

  const missingName = parseDumpConfigStrict(['- id: llm-deepseek', '  config:', '    baseURL: ' + gateUrl].join('\n'));
  check(missingName.ok === true && missingName.entries[0].name === null, 'yaml: entry without name parses but is not a provider');
  check(extractProviderCoverage(missingName.entries, gateUrl).guarded.length === 0, 'yaml: nameless entry cannot count as guarded');
  // 缺 name 的条目不能"跳过"了事：它可能是会发请求的插件，必须记 unknown。
  check(
    extractProviderCoverage(missingName.entries, gateUrl).unknown.length === 1,
    'yaml: nameless entry is classified unknown rather than skipped',
    extractProviderCoverage(missingName.entries, gateUrl),
  );

  // 未知第三方组件（名字不带 dsh-llm 前缀，但完全可能自己发模型请求）不能被静默跳过。
  const thirdPartyRouter = parseDumpConfigStrict(
    [
      '- id: llm-deepseek',
      "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
      '  config:',
      '    baseURL: ' + gateUrl,
      '- id: acme-router',
      "  name: '@acme/router'",
      '  config:',
      '    baseURL: https://router.example.com',
    ].join('\n'),
  );
  const routerCoverage = extractProviderCoverage(thirdPartyRouter.entries, gateUrl);
  check(routerCoverage.unknown.includes('acme-router'), 'yaml: unknown third-party component surfaced', routerCoverage);
  check(routerCoverage.guarded.length === 1, 'yaml: only the gated provider counts as guarded', routerCoverage);
  const routerDecision = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage: routerCoverage });
  check(routerDecision.allow === false && routerDecision.blockers.some((b) => b.code === 'PROVIDER_UNKNOWN'), 'yaml: unknown third-party component blocks start', routerDecision.blockers);

  // 已审查的自家拦截器不算未知组件；其它插件仍算未知。
  const reviewedPlugin = extractProviderCoverage(
    parseDumpConfigStrict(
      [
        '- id: llm-deepseek',
        "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
        '  config:',
        '    baseURL: ' + gateUrl,
        '- id: tla-prelaunch-budget',
        "  name: 'tla-prelaunch-budget'",
      ].join('\n'),
    ).entries,
    gateUrl,
  );
  check(reviewedPlugin.unknown.length === 0 && reviewedPlugin.plumbing.includes('tla-prelaunch-budget'), 'yaml: reviewed interceptor plugin is plumbing', reviewedPlugin);
  check(
    extractProviderCoverage(
      parseDumpConfigStrict(['- id: other-plugin', "  name: '@acme/other-plugin'"].join('\n')).entries,
      gateUrl,
    ).unknown.includes('other-plugin'),
    'yaml: other third-party plugin stays unknown',
  );

  const unknownProvider = parseDumpConfigStrict(
    ['- id: mystery', "  name: '@deepseek-ai/dsh-llm-mystery'", '  config:', '    baseURL: ' + gateUrl].join('\n'),
  );
  const unknownCoverage = extractProviderCoverage(unknownProvider.entries, gateUrl);
  check(unknownCoverage.unknown.length === 1, 'yaml: unknown adapter surfaced', unknownCoverage);
  const unknownDecision = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage: unknownCoverage });
  check(unknownDecision.allow === false && unknownDecision.blockers.some((b) => b.code === 'PROVIDER_UNKNOWN'), 'yaml: unknown adapter blocks start', unknownDecision.blockers);

  const aggregatorConfigured = extractProviderCoverage(
    parseDumpConfigStrict(
      ['- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  config:', '    providers:', '      - id: openrouter'].join('\n'),
    ).entries,
    gateUrl,
  );
  check(aggregatorConfigured.unguarded.length === 1, 'yaml: configured aggregator is unguarded', aggregatorConfigured);

  const aggregatorIdle = extractProviderCoverage(
    parseDumpConfigStrict(['- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'"].join('\n')).entries,
    gateUrl,
  );
  check(aggregatorIdle.notConfigured.length === 1, 'yaml: idle aggregator is not-configured', aggregatorIdle);

  // 白名单只证明"组件在默认 profile 里存在"，不能证明"它不调用模型"。
  // 随包里有两个自带模型端点的组件，默认指向真实 api.deepseek.com：
  //   web-search-deepseek  → POST ${baseURL}/messages
  //   deepseek-account-platform → inferenceOrigin（本机代理再转发）
  // 它们必须按"端点是否指向闸门"判定，而不是按白名单放过。
  const webSearchDefault = extractProviderCoverage(
    parseDumpConfigStrict(
      [
        '- id: llm-deepseek',
        "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
        '  config:',
        '    baseURL: ' + gateUrl,
        '- id: web-search-deepseek',
        "  name: '@deepseek-ai/dsh-web-search-deepseek'",
        '  config:',
        '    apiKeyEnv: DEEPSEEK_API_KEY',
      ].join('\n'),
    ).entries,
    gateUrl,
  );
  check(webSearchDefault.unguarded.includes('web-search-deepseek'), 'yaml: web search with default endpoint is unguarded', webSearchDefault);
  const webSearchBlocked = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage: webSearchDefault });
  check(webSearchBlocked.allow === false && webSearchBlocked.blockers.some((b) => b.code === 'PROVIDER_NOT_GATED'), 'yaml: ungated web search blocks start', webSearchBlocked.blockers);

  const webSearchGated = extractProviderCoverage(
    parseDumpConfigStrict(
      [
        '- id: web-search-deepseek',
        "  name: '@deepseek-ai/dsh-web-search-deepseek'",
        '  config:',
        '    baseURL: ' + gateUrl,
      ].join('\n'),
    ).entries,
    gateUrl,
  );
  check(webSearchGated.guarded.includes('web-search-deepseek'), 'yaml: web search pointed at the gate counts as guarded', webSearchGated);

  const accountUngated = extractProviderCoverage(
    parseDumpConfigStrict(
      [
        '- id: deepseek-account',
        "  name: '@deepseek-ai/dsh-deepseek-account-platform'",
        '  config:',
        '    platformOrigin: https://platform.deepseek.com',
      ].join('\n'),
    ).entries,
    gateUrl,
  );
  check(accountUngated.unguarded.includes('deepseek-account'), 'yaml: account platform is unguarded while inferenceOrigin is default', accountUngated);

  const accountGated = extractProviderCoverage(
    parseDumpConfigStrict(
      [
        '- id: deepseek-account',
        "  name: '@deepseek-ai/dsh-deepseek-account-platform'",
        '  config:',
        '    inferenceOrigin: ' + gateUrl,
      ].join('\n'),
    ).entries,
    gateUrl,
  );
  check(accountGated.guarded.includes('deepseek-account'), 'yaml: account platform pointed at the gate counts as guarded', accountGated);

  const webSearchDisabled = extractProviderCoverage(
    parseDumpConfigStrict(
      [
        '- id: web-search-deepseek',
        "  name: '@deepseek-ai/dsh-web-search-deepseek'",
        '  config:',
        '    apiKeyEnv: DEEPSEEK_API_KEY',
        '  disabled: true',
      ].join('\n'),
    ).entries,
    gateUrl,
  );
  check(webSearchDisabled.disabled.includes('web-search-deepseek'), 'yaml: disabled web search neither guarded nor unguarded', webSearchDisabled);

  // I：异常 YAML 不能被"跳过坏行"当成覆盖率完整。
  const tab = parseDumpConfigStrict('- id: llm-deepseek\n\tname: x\n');
  check(tab.ok === false, 'yaml: tab indentation rejected', tab.code);
  const flow = parseDumpConfigStrict('- id: llm-deepseek\n  name: x\n  config: {baseURL: ' + gateUrl + '}\n');
  check(flow.ok === false, 'yaml: flow style rejected', flow.code);
  const trailing = parseDumpConfigStrict(base + '\nthis trailing line is not yaml\n');
  check(trailing.ok === false, 'yaml: trailing garbage rejected', trailing.code);
  const partial = parseDumpConfigStrict('- id: llm-deepseek\n  name: x\n  config:\n');
  check(partial.ok === false, 'yaml: partial config rejected', partial.code);
  const dup = parseDumpConfigStrict(base + '\n- id: llm-deepseek\n');
  check(dup.ok === false && dup.code === 'CONFIG_DUPLICATE_ID', 'yaml: duplicate id rejected (repeat)', dup.code);
}

function scenarioArgsValidation() {
  const bad = (args) => {
    try {
      parseArgs(args);
      return null;
    } catch (error) {
      return error;
    }
  };
  check(bad(['--dump-config-from', 'x']) instanceof UsageError, 'args: --dump-config-from rejected');
  check(bad(['--allow-ungated-providers']) instanceof UsageError, 'args: --allow-ungated-providers rejected');
  check(bad(['--on-loss', 'ignore']) instanceof UsageError, 'args: --on-loss rejected');
  check(bad(['--', 'x']) instanceof UsageError, 'args: free-form host args rejected');
  check(bad(['--nope']) instanceof UsageError, 'args: unknown flag rejected');
  const parsed = parseArgs(['--upstream', 'http://127.0.0.1:1', '--model-requests', '1', '--patch', 'a', '--patch', 'b']);
  check(parsed.patches.length === 2, 'args: --patch is repeatable', parsed.patches);
}

async function scenarioLifecycleAtGate() {
  const upstream = await startUpstream();
  const runDir = join(scratch, 'lifecycle-gate');
  mkdirSync(runDir, { recursive: true });
  const nowIso = (ms) => new Date(ms).toISOString();

  // 1) 长跑健康：mounted 是 2 分钟前，心跳是 5 毫秒前。
  //    闸门必须仍然放行，并用上游请求数证明"真的转发了"，而不只是判定函数说 ok。
  const longRun = join(runDir, 'long.jsonl');
  appendEvent(longRun, { event: 'mounted', runId: 'run-long', at: nowIso(Date.now() - 120_000) });
  appendEvent(longRun, { event: 'heartbeat', runId: 'run-long', at: nowIso(Date.now() - 5) });
  const longGate = createBudgetGate({
    upstream: upstream.url,
    modelRequests: 2,
    leaseTtlMs: 5000,
    logPath: join(runDir, 'long-gate.jsonl'),
    mountProof: { eventLog: longRun, runId: 'run-long', maxAgeMs: 5000, requireHeartbeat: true },
  });
  const longBase = (await longGate.listen(0)).baseUrl;
  try {
    const allowed = await postMessage(longBase);
    check(allowed.status === 200, 'lifecycle: long run with fresh heartbeat is authorized at the gate', allowed.status);
    check(upstream.hits.length === 1, 'lifecycle: long run request actually reached upstream', upstream.hits.length);

    // 2) 卸载后迟到心跳：闸门必须拒绝，且上游计数不变（区分"判定被误接受"与"真的转发"）。
    const revived = join(runDir, 'revived.jsonl');
    appendEvent(revived, { event: 'mounted', runId: 'run-revived', at: nowIso(Date.now() - 3000) });
    appendEvent(revived, { event: 'unmounted', runId: 'run-revived', at: nowIso(Date.now() - 2000) });
    appendEvent(revived, { event: 'heartbeat', runId: 'run-revived', at: nowIso(Date.now() - 5) });
    const revivedGate = createBudgetGate({
      upstream: upstream.url,
      modelRequests: 2,
      leaseTtlMs: 5000,
      logPath: join(runDir, 'revived-gate.jsonl'),
      mountProof: { eventLog: revived, runId: 'run-revived', maxAgeMs: 5000, requireHeartbeat: true },
    });
    const revivedBase = (await revivedGate.listen(0)).baseUrl;
    try {
      const denied = await postMessage(revivedBase);
      check(denied.status === 403, 'lifecycle: unmounted run cannot be revived at the gate', denied.status);
      check(upstream.hits.length === 1, 'lifecycle: revived request never reached upstream', upstream.hits.length);
      // 拒绝原因允许 NO_LEASE 或 REVOKED：闸门读到 unmounted 会直接永久撤销，
      // 两条路径的结果都是"不发请求"，这里只断言"被拒"这一事实。
      check(
        denied.body && denied.body.error && (denied.body.error.reason === 'NO_LEASE' || denied.body.error.reason === 'REVOKED'),
        'lifecycle: revival denial is NO_LEASE or REVOKED',
        denied.body,
      );

      // 3) 同一 runId 重复 mounted：同样不授权（需要新的运行身份）。
      const dup = join(runDir, 'dup.jsonl');
      appendEvent(dup, { event: 'mounted', runId: 'run-dup', at: nowIso(Date.now() - 3000) });
      appendEvent(dup, { event: 'heartbeat', runId: 'run-dup', at: nowIso(Date.now() - 2500) });
      appendEvent(dup, { event: 'mounted', runId: 'run-dup', at: nowIso(Date.now() - 10) });
      const dupGate = createBudgetGate({
        upstream: upstream.url,
        modelRequests: 2,
        leaseTtlMs: 5000,
        logPath: join(runDir, 'dup-gate.jsonl'),
        mountProof: { eventLog: dup, runId: 'run-dup', maxAgeMs: 5000 },
      });
      const dupBase = (await dupGate.listen(0)).baseUrl;
      try {
        const dupDenied = await postMessage(dupBase);
        check(dupDenied.status === 403, 'lifecycle: duplicate mount does not authorize a lease', dupDenied.status);
        check(upstream.hits.length === 1, 'lifecycle: duplicate-mount request never reached upstream', upstream.hits.length);
      } finally {
        await dupGate.close();
      }
    } finally {
      await revivedGate.close();
    }
  } finally {
    await longGate.close();
    await upstream.close();
  }
}

async function scenarioLauncherConfigBinding() {
  const upstream = await startUpstream();
  const gateUrl = 'http://127.0.0.1:18778';
  const runDir = join(scratch, 'launcher-binding');
  mkdirSync(runDir, { recursive: true });
  const patch = join(runDir, 'overlay.yml');
  writeFileSync(patch, '- insert:\n    - id: tla-prelaunch-budget\n      name: tla-prelaunch-budget\n      config: {}\n', 'utf8');

  // I：存在未指向闸门的 provider 实例 → 拒绝启动（宿主根本没起来）。
  const unguardedDump = writeDumpYaml(join(runDir, 'dump-unguarded.yml'), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: gateUrl } },
    { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
  ]);
  const unguardedRun = join(scratch, 'run-unguarded');
  mkdirSync(unguardedRun, { recursive: true });
  const unguardedResult = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir: unguardedRun, modelRequests: 2, dumpFile: unguardedDump, patch, extra: ['--gate-port', String(await freePort())] }),
    { env: { STUB_DUMP_FILE: unguardedDump } },
  );
  const unguardedSummary = JSON.parse(readFileSync(join(unguardedRun, 'gate-summary.json'), 'utf8'));
  check(unguardedResult.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: unguarded provider -> exit 3', unguardedResult.code);
  check(unguardedSummary.decision.blockers.some((b) => b.code === 'PROVIDER_NOT_GATED'), 'launcher: blocker names PROVIDER_NOT_GATED', unguardedSummary.decision.blockers);
  check(existsSync(join(unguardedRun, 'host-results.json')) === false, 'launcher: host never started', existsSync(join(unguardedRun, 'host-results.json')));
  check(unguardedSummary.result === 'refused-before-host-start', 'launcher: summary says refused-before-host-start', unguardedSummary.result);
  check(unguardedSummary.config.source === 'launcher-fetched', 'launcher: config was fetched by the launcher', unguardedSummary.config.source);

  // H：探测输出不完整（半截 YAML）→ 拒绝启动，且不能谎报 baseURL 错。
  const partialRun = join(scratch, 'run-partial');
  mkdirSync(partialRun, { recursive: true });
  const partialResult = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir: partialRun, modelRequests: 2, dumpFile: unguardedDump, patch, extra: ['--gate-port', String(await freePort())] }),
    { env: { STUB_DUMP_FILE: unguardedDump, STUB_DUMP_MODE: 'partial' } },
  );
  const partialSummary = JSON.parse(readFileSync(join(partialRun, 'gate-summary.json'), 'utf8'));
  check(partialResult.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: partial config -> exit 3', partialResult.code);
  check(partialSummary.config.reason === 'CONFIG_UNPARSEABLE', 'launcher: partial config reported as CONFIG_UNPARSEABLE', partialSummary.config.reason);
  check(partialSummary.decision.blockers.length === 1 && partialSummary.decision.blockers[0].code === 'CONFIG_UNPARSEABLE', 'launcher: only the real blocker is reported', partialSummary.decision.blockers);

  // P0-5：探测超时（宿主卡住）→ 拒绝启动。
  const timeoutRun = join(scratch, 'run-probe-timeout');
  mkdirSync(timeoutRun, { recursive: true });
  const timeoutResult = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir: timeoutRun, modelRequests: 2, dumpFile: unguardedDump, patch, extra: ['--gate-port', String(await freePort()), '--config-timeout-ms', '1500'] }),
    { env: { STUB_DUMP_FILE: unguardedDump, STUB_DUMP_MODE: 'sleep' }, timeoutMs: 40000 },
  );
  const timeoutSummary = JSON.parse(readFileSync(join(timeoutRun, 'gate-summary.json'), 'utf8'));
  check(timeoutResult.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: probe timeout -> exit 3', timeoutResult.code);
  check(timeoutSummary.config.reason === 'CONFIG_TIMEOUT', 'launcher: probe timeout reported', timeoutSummary.config.reason);

  // P0-5：探测进程异常退出 → 拒绝启动。
  const crashRun = join(scratch, 'run-probe-crash');
  mkdirSync(crashRun, { recursive: true });
  const crashResult = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir: crashRun, modelRequests: 2, dumpFile: unguardedDump, patch, extra: ['--gate-port', String(await freePort())] }),
    { env: { STUB_DUMP_FILE: unguardedDump, STUB_DUMP_MODE: 'crash' } },
  );
  const crashSummary = JSON.parse(readFileSync(join(crashRun, 'gate-summary.json'), 'utf8'));
  check(crashResult.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: probe crash -> exit 3', crashResult.code);
  check(crashSummary.config.reason === 'CONFIG_EXIT_NONZERO', 'launcher: nonzero probe exit reported', crashSummary.config.reason);

  await upstream.close();
}

async function scenarioLauncherLeased() {
  const upstream = await startUpstream();
  const runDir = join(scratch, 'launcher-ok');
  mkdirSync(runDir, { recursive: true });
  const patch = join(runDir, 'overlay.yml');
  writeFileSync(patch, '- insert:\n    - id: tla-prelaunch-budget\n      name: tla-prelaunch-budget\n      config: {}\n', 'utf8');
  const port = await freePort();
  const dumpFile = writeDumpYaml(join(runDir, 'dump-ok.yml'), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: 'http://127.0.0.1:' + port } },
  ]);
  const result = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir, modelRequests: 2, dumpFile, patch, extra: ['--gate-port', String(port)] }),
    { env: { STUB_DUMP_FILE: dumpFile, STUB_EVENTS: join(runDir, 'plugin-events.jsonl'), STUB_EVENTS_MODE: 'ok' } },
  );
  const summary = JSON.parse(readFileSync(join(runDir, 'gate-summary.json'), 'utf8'));
  const hostResults = JSON.parse(readFileSync(join(runDir, 'host-results.json'), 'utf8'));
  // N：正常路径——有效挂载 + 租约，预算内请求放行。
  check(result.code === EXIT_OK, 'launcher: normal run exits 0', result.code);
  check(summary.result === 'host-ok', 'launcher: summary host-ok', summary.result);
  check(hostResults.results.slice(0, 2).every((status) => status === 200), 'launcher: first two requests allowed', hostResults.results);
  check(hostResults.results.slice(2).every((status) => status === 403), 'launcher: later requests denied by budget', hostResults.results);
  check(upstream.hits.length === 2, 'launcher: upstream saw exactly the budgeted requests', upstream.hits.length);
  check(summary.invocation.sameCommandAsProbe === true, 'launcher: probe and host use the same command', summary.invocation);
  check(summary.invocation.sameProfileAsProbe === true, 'launcher: same profile', summary.invocation.sameProfileAsProbe);
  check(summary.invocation.samePatchesAsProbe === true, 'launcher: same patch content', summary.invocation.samePatchesAsProbe);
  check(summary.invocation.sameEnvAsProbe === true, 'launcher: same environment', summary.invocation.sameEnvAsProbe);
  check(summary.invocation.runIdSeparatedFromProbe === true, 'launcher: probe and host use different runIds', summary.invocation);
  check(typeof summary.runId === 'string' && summary.runId.startsWith('tla-run-'), 'launcher: runId recorded', summary.runId);
  check(summary.coverage.guarded.length === 1, 'launcher: coverage recorded', summary.coverage);
  await upstream.close();
}

async function scenarioLauncherWithoutProof() {
  const upstream = await startUpstream();
  const gateUrl = 'http://127.0.0.1:18778';
  const patchRun = join(scratch, 'launcher-noproof');
  mkdirSync(patchRun, { recursive: true });
  const patch = join(patchRun, 'overlay.yml');
  writeFileSync(patch, '- insert:\n    - id: tla-prelaunch-budget\n      name: tla-prelaunch-budget\n      config: {}\n', 'utf8');
  const port = await freePort();
  const dumpFile = writeDumpYaml(join(patchRun, 'dump.yml'), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: 'http://127.0.0.1:' + port } },
  ]);

  // J：宿主存活但从不写心跳 → --timeout-ms 生效，宿主被终止，退出码 3。
  const silentRun = join(scratch, 'run-silent');
  mkdirSync(silentRun, { recursive: true });
  const silentResult = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir: silentRun, modelRequests: 2, dumpFile, patch, extra: ['--gate-port', String(port)] }),
    { env: { STUB_DUMP_FILE: dumpFile, STUB_EVENTS: join(silentRun, 'plugin-events.jsonl'), STUB_EVENTS_MODE: 'silent-long' }, timeoutMs: 40000 },
  );
  const silentSummary = JSON.parse(readFileSync(join(silentRun, 'gate-summary.json'), 'utf8'));
  check(silentResult.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: no heartbeat -> exit 3', silentResult.code);
  check(silentResult.elapsedMs < 15000, 'launcher: timeout enforced (did not hang)', silentResult.elapsedMs);
  check(silentSummary.result === 'protection-not-established', 'launcher: summary names protection-not-established', silentSummary.result);
  check(upstream.hits.length === 0, 'launcher: no proof -> upstream 0', upstream.hits.length);
  check(silentSummary.termination && silentSummary.termination.exited === true, 'launcher: host terminated', silentSummary.termination);

  // K：子进程忽略 SIGTERM → 必须升级到 SIGKILL，不能无限挂起。
  const killRun = join(scratch, 'run-kill');
  mkdirSync(killRun, { recursive: true });
  const killResult = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir: killRun, modelRequests: 2, dumpFile, patch, extra: ['--gate-port', String(port)] }),
    { env: { STUB_DUMP_FILE: dumpFile, STUB_EVENTS: join(killRun, 'plugin-events.jsonl'), STUB_EVENTS_MODE: 'ignore-sigterm', STUB_IGNORE_SIGTERM: '1' }, timeoutMs: 60000 },
  );
  const killSummary = JSON.parse(readFileSync(join(killRun, 'gate-summary.json'), 'utf8'));
  check(killResult.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: ignoring SIGTERM still exits 3', killResult.code);
  check(killResult.elapsedMs < 40000, 'launcher: escalation bounded in time', killResult.elapsedMs);
  check(killSummary.termination && killSummary.termination.exited === true, 'launcher: escalation kill ended the host', killSummary.termination);
  // Windows 上 Node 的 child.kill('SIGTERM') 直接走 TerminateProcess，进程一定死，
  // 观察不到"忽略 SIGTERM"的情形；升级逻辑本身由 scenarioTerminationEscalation 覆盖。
  if (process.platform !== 'win32') {
    check(killSummary.termination.escalated === true, 'launcher: SIGKILL escalation recorded', killSummary.termination);
  }
  check(killSummary.termination.waitedMs <= 20_000, 'launcher: termination wait is bounded', killSummary.termination.waitedMs);

  // F2（端到端）：探测阶段泄漏写下的 `<runId>-probe` 挂载证明，不能授权正式运行。
  const upstreamHitsBeforeLeak = upstream.hits.length;
  const leakRun = join(scratch, 'run-probe-leak');
  mkdirSync(leakRun, { recursive: true });
  const leakPort = await freePort();
  const leakDump = writeDumpYaml(join(leakRun, 'dump.yml'), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: 'http://127.0.0.1:' + leakPort } },
  ]);
  const leakResult = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir: leakRun, modelRequests: 2, dumpFile: leakDump, patch, extra: ['--gate-port', String(leakPort)] }),
    { env: { STUB_DUMP_FILE: leakDump, STUB_EVENTS: join(leakRun, 'plugin-events.jsonl'), STUB_EVENTS_MODE: 'probe-leak' }, timeoutMs: 40000 },
  );
  const leakSummary = JSON.parse(readFileSync(join(leakRun, 'gate-summary.json'), 'utf8'));
  check(leakResult.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: probe-phase proof does not authorize the host run', leakResult.code);
  check(leakSummary.result === 'host-exited-before-protection', 'launcher: probe leak ends as protection-not-established', leakSummary.result);
  check(upstream.hits.length === upstreamHitsBeforeLeak, 'launcher: upstream saw no request from the probe-leak run', upstream.hits.length - upstreamHitsBeforeLeak);
  await upstream.close();
}

/** K：终止升级逻辑本身（平台无关）。真实宿主在 Windows 上观察不到"忽略 SIGTERM"。 */
async function scenarioTerminationEscalation() {
  const stubborn = simulateChild({ exitOn: 'SIGKILL' });
  const escalated = await terminateHost(stubborn, { graceMs: 50, killWaitMs: 300, win32: false });
  check(escalated.escalated === true, 'termination: stubborn child escalates to SIGKILL', escalated);
  check(escalated.exited === true, 'termination: escalation ends the child', escalated);
  check(stubborn.signals.join(',') === 'SIGTERM,SIGKILL', 'termination: signal order is TERM then KILL', stubborn.signals.join(','));

  const polite = simulateChild({ exitOn: 'SIGTERM' });
  const graceful = await terminateHost(polite, { graceMs: 300, killWaitMs: 300, win32: false });
  check(graceful.exited === true && graceful.escalated === false, 'termination: cooperative child needs no escalation', graceful);
  check(polite.signals.join(',') === 'SIGTERM', 'termination: cooperative child gets only SIGTERM', polite.signals.join(','));

  const gone = await terminateHost(null, {});
  check(gone.exited === false, 'termination: null child is a no-op', gone);
  const alreadyExited = await terminateHost({ exitCode: 0, kill() { throw new Error('must not be called'); } }, {});
  check(alreadyExited.exited === true && alreadyExited.escalated === false, 'termination: already-exited child is not signalled', alreadyExited);
}

function simulateChild({ exitOn }) {
  let resolveExit;
  const exited = new Promise((done) => { resolveExit = done; });
  const child = {
    exitCode: null,
    pid: undefined,
    signals: [],
    kill(signal) {
      child.signals.push(signal);
      if (signal === exitOn) {
        setTimeout(() => { child.exitCode = 1; resolveExit(1); }, 5);
      }
    },
    onceExit() { return exited; },
  };
  return child;
}

async function scenarioLauncherForeignProof() {  const upstream = await startUpstream();
  const runDir = join(scratch, 'launcher-foreign');
  mkdirSync(runDir, { recursive: true });
  const patch = join(runDir, 'overlay.yml');
  writeFileSync(patch, '- insert:\n    - id: tla-prelaunch-budget\n      name: tla-prelaunch-budget\n      config: {}\n', 'utf8');
  const port = await freePort();
  const dumpFile = writeDumpYaml(join(runDir, 'dump.yml'), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: 'http://127.0.0.1:' + port } },
  ]);
  // F：旧会话（别的 runId）的 mounted 即使新鲜也不能授权本次运行。
  const pre = join(runDir, 'plugin-events.jsonl');
  appendEvent(pre, { event: 'mounted', runId: 'tla-run-previous' });
  const result = await runLauncher(
    baseLauncherArgs({ upstream: upstream.url, runDir, modelRequests: 2, dumpFile, patch, extra: ['--gate-port', String(port)] }),
    { env: { STUB_DUMP_FILE: dumpFile, STUB_EVENTS: pre, STUB_EVENTS_MODE: 'foreign' }, timeoutMs: 40000 },
  );
  const summary = JSON.parse(readFileSync(join(runDir, 'gate-summary.json'), 'utf8'));
  check(result.code === EXIT_PROTECTION_UNVERIFIED, 'launcher: foreign mount -> exit 3', result.code);
  check(upstream.hits.length === 0, 'launcher: foreign mount -> upstream 0', upstream.hits.length);
  check(summary.heartbeat && summary.heartbeat.ok === false, 'launcher: heartbeat not accepted for this run', summary.heartbeat);
  await upstream.close();
}


async function scenarioReviewedPluginEvidence() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-reviewed-'));
  const gateBase = 'http://127.0.0.1:59991';
  const dump = writeDumpYaml(join(dir, 'dump.yml'), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: gateBase } },
    { id: 'agent-teams', name: '@nanmicoder/dsh-agent-teams' },
    { id: 'rogue', name: '@acme/router' },
  ]);
  const parsed = parseDumpConfigStrict(readFileSync(dump, 'utf8'));
  check(parsed.ok === true, 'reviewed: dump parses', parsed.reason);
  const coverage = extractProviderCoverage(parsed.entries, gateBase);
  check(coverage.guarded.includes('llm-deepseek'), 'reviewed: provider guarded', coverage.guarded);
  check(coverage.plumbing.includes('agent-teams'), 'reviewed: registered plugin is plumbing', coverage.plumbing);
  check(coverage.unknown.includes('rogue'), 'reviewed: unregistered plugin stays unknown', coverage.unknown);
  const evidence = REVIEWED_PLUGIN_EVIDENCE['@nanmicoder/dsh-agent-teams'];
  check(evidence && evidence.version === '0.1.25', 'reviewed: entry names the fixed version', evidence);
  check(Array.isArray(evidence.evidence) && evidence.evidence.length >= 4, 'reviewed: entry carries evidence lines', evidence && evidence.evidence.length);
  const blocked = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage });
  check(blocked.allow === false, 'reviewed: unregistered plugin still blocks start', blocked);
  check(blocked.blockers.some((b) => b.code === 'PROVIDER_UNKNOWN'), 'reviewed: blocker names PROVIDER_UNKNOWN', blocked.blockers);
  const clean = writeDumpYaml(join(dir, 'clean.yml'), [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: gateBase } },
    { id: 'agent-teams', name: '@nanmicoder/dsh-agent-teams' },
  ]);
  const parsedClean = parseDumpConfigStrict(readFileSync(clean, 'utf8'));
  const coverageClean = extractProviderCoverage(parsedClean.entries, gateBase);
  const allowed = decideStart({ gateReady: true, baseUrl: { ok: true }, heartbeat: { ok: true }, coverage: coverageClean });
  check(allowed.allow === true, 'reviewed: registered plugin alone does not block', allowed);
  rmSync(dir, { recursive: true, force: true });
}
// 插件身份：登记的版本号必须与**实际安装包**一致，且构建内容未变。
// 这里不看配置里写的 version（那只是文本）；四个分支都要有反例。
async function scenarioPluginIdentity() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-identity-'));
  const pkgDir = join(dir, 'plugin');
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.23' }) + '\n');
  writeFileSync(join(pkgDir, 'lib', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(pkgDir, 'lib', 'b.js'), 'export const b = 2;\n');

  const fingerprint = fingerprintPluginDir(pkgDir);
  check(fingerprint.ok === true, 'identity: fixture fingerprint reads', fingerprint);
  check(fingerprint.version === '0.1.23' && fingerprint.fileCount === 3, 'identity: fingerprint covers package.json and lib files', fingerprint);
  const expected = { version: '0.1.23', buildDigest: fingerprint.buildDigest };

  const verified = verifyPluginAgainst({ name: 'demo-plugin', pkgDir, expected });
  check(verified.status === 'verified', 'identity: matching build verifies', verified);
  check(verified.installedVersion === '0.1.23', 'identity: reports installed version', verified);

  // 同名不同版本
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.24' }) + '\n');
  const newer = verifyPluginAgainst({ name: 'demo-plugin', pkgDir, expected });
  check(newer.status === 'version-mismatch', 'identity: same name newer version is refused', newer);
  check(newer.installedVersion === '0.1.24' && newer.expectedVersion === '0.1.23', 'identity: mismatch names both versions', newer);

  // 同版本但构建内容被改
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.23' }) + '\n');
  writeFileSync(join(pkgDir, 'lib', 'b.js'), 'export const b = 3;\n');
  const tampered = verifyPluginAgainst({ name: 'demo-plugin', pkgDir, expected });
  check(tampered.status === 'build-mismatch', 'identity: same version with changed bytes is refused', tampered);
  check(tampered.buildDigest !== tampered.expectedBuildDigest, 'identity: build mismatch shows two digests', tampered);

  // 独立复核反例：只改 bundle 覆盖层 YAML，旧口径（只算 js/mjs/cjs/json）
  // 指纹不变、核对仍然通过。新口径必须覆盖 manifest 与 YAML。
  writeFileSync(join(pkgDir, 'lib', 'b.js'), 'export const b = 2;\n');
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- insert: []\n');
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '0.1.23', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
  );
  const withBundle = fingerprintPluginDir(pkgDir);
  check(withBundle.ok === true, 'identity: bundle patch is readable', withBundle);
  check(withBundle.fileCount === 4, 'identity: bundle patch counts as a reviewed file', withBundle);
  check(withBundle.bundlePatch !== null && withBundle.bundlePatch.path === 'cordis.patch.yml', 'identity: bundle patch path is recorded', withBundle);
  const expectedWithBundle = { version: '0.1.23', buildDigest: withBundle.buildDigest };
  const bundleVerified = verifyPluginAgainst({ name: 'demo-plugin', pkgDir, expected: expectedWithBundle });
  check(bundleVerified.status === 'verified', 'identity: bundle patch fixture verifies', bundleVerified);
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- insert: [{ id: sneaky }]\n');
  const yamlTampered = verifyPluginAgainst({ name: 'demo-plugin', pkgDir, expected: expectedWithBundle });
  check(yamlTampered.status === 'build-mismatch', 'identity: changing only the bundle patch YAML is refused', yamlTampered);
  check(yamlTampered.buildDigest !== yamlTampered.expectedBuildDigest, 'identity: YAML tamper changes the digest', yamlTampered);

  // 入口缺失 / 越出包根：不能静默忽略
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- insert: []\n');
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '0.1.23', dsh: { bundle: { patch: './missing.yml' } } }) + '\n',
  );
  const missingEntry = fingerprintPluginDir(pkgDir);
  check(missingEntry.ok === false && missingEntry.reason === 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY', 'identity: missing bundle entry is unsupported', missingEntry);
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '0.1.23', dsh: { bundle: { patch: '../escape.yml' } } }) + '\n',
  );
  const escapingEntry = fingerprintPluginDir(pkgDir);
  check(escapingEntry.ok === false && escapingEntry.reason === 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY', 'identity: escaping bundle entry is unsupported', escapingEntry);

  // 包内符号链接：不跟随、不跳过
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '0.1.23', dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n',
  );
  const linkTarget = join(dir, 'outside.js');
  writeFileSync(linkTarget, 'export const outside = 1;\n');
  const linkPath = join(pkgDir, 'lib', 'linked.js');
  let linkCreated = false;
  try {
    symlinkSync(linkTarget, linkPath);
    linkCreated = true;
  } catch (_noSymlink) {
    linkCreated = false;
  }
  if (linkCreated) {
    const linked = fingerprintPluginDir(pkgDir);
    check(linked.ok === false && linked.reason === 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY', 'identity: symlinked file is unsupported', linked);
    check(String(linked.detail).includes('符号链接'), 'identity: symlink refusal names the entry', linked);
    rmSync(linkPath, { force: true });
  }

  // 身份读不出 / 包不存在
  const missing = verifyInstalledPlugin({ name: '@nanmicoder/dsh-agent-teams', pkgDir: join(dir, 'nope') });
  check(missing.status === 'identity-unreadable', 'identity: missing package is unreadable', missing);
  const unregistered = verifyInstalledPlugin({ name: '@acme/router', pkgDir });
  check(unregistered.status === 'unregistered', 'identity: unregistered name has no evidence', unregistered);

  // 登记表里也必须有指纹，否则等于"只登记名字"
  for (const [name, entry] of Object.entries(REVIEWED_PLUGIN_EVIDENCE)) {
    check(/^[0-9a-f]{64}$/.test(String(entry.buildDigest)), 'identity: ' + name + ' carries a build digest', entry.buildDigest);
    check(Number.isInteger(entry.fileCount) && entry.fileCount > 0, 'identity: ' + name + ' carries a file count', entry.fileCount);
  }

  // 未通过身份核对时，判定必须拒绝启动
  const denied = decideStart({
    gateReady: true,
    baseUrl: { ok: true },
    heartbeat: { ok: true },
    coverage: { guarded: ['llm-deepseek'], unguarded: [], unknown: [], providers: [] },
    pluginIdentities: [newer],
  });
  check(denied.allow === false, 'identity: mismatch blocks startup', denied);
  check(denied.blockers.some((b) => b.code === 'PLUGIN_NOT_VERIFIED'), 'identity: blocker names PLUGIN_NOT_VERIFIED', denied.blockers);
  const accepted = decideStart({
    gateReady: true,
    baseUrl: { ok: true },
    heartbeat: { ok: true },
    coverage: { guarded: ['llm-deepseek'], unguarded: [], unknown: [], providers: [] },
    pluginIdentities: [verified],
  });
  check(accepted.allow === true, 'identity: verified plugin does not block', accepted);

  // 真实安装包：只在显式给出隔离 profile 时核对（不隐式依赖本机环境，
  // 否则同一提交在不同机器上断言数不同——这正是独立复核看到的 176/178 差异）。
  const realProfileBase = process.env.TLA_REAL_PROFILE || null;
  if (realProfileBase !== null) {
    const realProfile = join(realProfileBase, 'profiles', 'stage1', 'node_modules', '@nanmicoder', 'dsh-agent-teams');
    if (existsSync(realProfile)) {
      const real = verifyInstalledPlugin({ name: '@nanmicoder/dsh-agent-teams', pkgDir: realProfile });
      check(real.status === 'verified', 'identity: installed agent-teams matches the reviewed build', real);
      check(real.buildDigest === REVIEWED_PLUGIN_EVIDENCE['@nanmicoder/dsh-agent-teams'].buildDigest, 'identity: installed digest equals registered digest', real.buildDigest);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// 项目工作区与运行证据目录必须分开，而且缺目录/缺目标文件时要在启动宿主之前失败。
async function scenarioLauncherProjectPreflight() {
  const upstream = await startUpstream();
  const runDir = mkdtempSync(join(scratch, 'project-run-'));
  const dump = join(scratch, 'project-dump.yml');
  writeDumpYaml(dump, [{ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { baseURL: 'PLACEHOLDER' } }]);
  const patch = join(scratch, 'project.patch.yml');
  writeFileSync(patch, '- id: llm-deepseek\n  config: {}\n', 'utf8');
  try {
    const missingProject = join(scratch, 'nope-project-' + Date.now());
    const withoutProject = await runLauncher(
      baseLauncherArgs({ upstream: upstream.url, runDir, modelRequests: 2, dumpFile: dump, patch, extra: ['--project-cwd', missingProject] }),
    );
    check(withoutProject.code === 2, 'project preflight: missing project cwd is rejected before any host starts', withoutProject.code);
    check(existsSync(join(runDir, 'gate-summary.json')) === false, 'project preflight: no summary means the host never started', true);

    const projectDir = mkdtempSync(join(scratch, 'project-ok-'));
    const missingFile = await runLauncher(
      baseLauncherArgs({ upstream: upstream.url, runDir, modelRequests: 2, dumpFile: dump, patch, extra: ['--project-cwd', projectDir, '--require-file', 'test/sum.test.mjs'] }),
    );
    check(missingFile.code === 2, 'project preflight: missing required file is rejected before any host starts', missingFile.code);
  } finally {
    await upstream.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}

async function main() {
  const scenarios = [
    ['control plane is read-only', scenarioControlPlaneReadOnly],
    ['leased budget', scenarioLeasedBudget],
    ['lease expiry is final', scenarioExpiryCannotBeRevived],
    ['revoke is permanent', scenarioRevokeIsPermanent],
    ['mount proof is run-bound', scenarioMountProofRunBinding],
    ['concurrent last slot', scenarioConcurrencyLastSlot],
    ['decision functions', scenarioDecisionFunctions],
    ['yaml strictness and coverage', scenarioYamlStrictness],
    ['run lifecycle at the gate', scenarioLifecycleAtGate],
    ['argument validation', scenarioArgsValidation],
    ['launcher project preflight', scenarioLauncherProjectPreflight],
    ['launcher config binding', scenarioLauncherConfigBinding],
    ['launcher normal run', scenarioLauncherLeased],
    ['launcher without proof', scenarioLauncherWithoutProof],
    ['launcher rejects foreign proof', scenarioLauncherForeignProof],
    ['termination escalation', scenarioTerminationEscalation],
    ['reviewed plugin evidence', scenarioReviewedPluginEvidence],
    ['plugin identity', scenarioPluginIdentity],
  ];
  for (const [label, scenario] of scenarios) {
    try {
      await scenario();
    } catch (error) {
      failures.push('scenario "' + label + '" threw: ' + String(error && error.stack ? error.stack : error));
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (_cleanupFailed) {
    // 清理失败不影响结论。
  }
  if (failures.length > 0) {
    console.error(failures.length + ' check(s) failed:');
    for (const failure of failures) console.error('  - ' + failure);
    process.exit(1);
  }
  console.log('v02-gate: ' + scenarios.length + ' scenarios, ' + checks + ' checks, 0 failures');
}

await main();
