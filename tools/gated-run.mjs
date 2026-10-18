// tools/gated-run.mjs
//
// 带"启动闸门"的运行器：把"能不能发模型请求"从插件手里拿走。
//
// 事故背景：预算插件的 `apply()` 抛错时，宿主只打印
// `warning: 1 entry did not activate` 然后继续无预算运行（2026-10-18 实测，失控
// 到 2567 次请求）。所以"在宿主里检查保护"不可靠——这段检查本身可能不执行。
//
// 本运行器的做法是**默认拒绝 + 先启动后授权**：
//   1. 先在宿主之外启动闸门（gate.mjs），闸门此刻没有租约 → 一切模型请求被 403
//      拒绝，不会转发给上游；
//   2. 读宿主**生效配置**（--dump-config）确认 provider baseURL 指向闸门；不指向
//      就直接拒绝启动（此时宿主进程根本不存在）；
//   3. 启动宿主。宿主启动初期的请求全部被拒——这是刻意的：插件此时还没证明自己
//      挂上了；
//   4. 在超时窗口内等插件写出的 `mounted` 心跳。等不到 → 终止宿主、退出码 3，
//      期间外发请求数为 0（由闸门的默认拒绝保证，不是"期望"）；
//   5. 等到心跳 → 发放租约（预算 N），此后请求才被放行；心跳一旦过期 → 撤销租约
//      并终止宿主，避免宿主对着 403 无限重试。
//
// 这条链路里，插件失败（缺失/apply 抛错/超时/运行中失效）的结果都是"没有租约"，
// 而不是"没有预算但继续跑"。
//
// 用法：
//   node tools/gated-run.mjs --upstream http://127.0.0.1:18777 \
//     --model-requests 3 --run-dir <dir> --heartbeat-file <plugin events.jsonl> \
//     --dsh <path to dsh.cmd> --profile stage1 --patch <overlay.yml> -- "<prompt>"
//
// 退出码：0 = 宿主正常退出；1 = 宿主失败；2 = 参数/环境错误；
//        3 = 保护未建立（已终止宿主，模型请求 0 次）；
//        4 = 运行中保护失效（已撤销租约并终止宿主）。

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBudgetGate } from '../orchestration/gate/gate.mjs';
import {
  checkBaseUrl,
  checkProtectionHeartbeat,
  decideStart,
  formatDecision,
  readGateStatus,
} from '../orchestration/gate/preflight.mjs';

export const EXIT_OK = 0;
export const EXIT_HOST_FAILED = 1;
export const EXIT_PROTECTION_UNVERIFIED = 3;
export const EXIT_PROTECTION_LOST = 4;

export function parseArgs(argv) {
  const options = { hostArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options.hostArgs = argv.slice(index + 1);
      break;
    }
    const next = () => {
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case '--upstream': options.upstream = next(); break;
      case '--model-requests': options.modelRequests = Number(next()); break;
      case '--lease-ttl-ms': options.leaseTtlMs = Number(next()); break;
      case '--heartbeat-file': options.heartbeatFile = next(); break;
      case '--heartbeat-max-age-ms': options.heartbeatMaxAgeMs = Number(next()); break;
      case '--timeout-ms': options.timeoutMs = next(); break;
      case '--run-dir': options.runDir = next(); break;
      case '--gate-port': options.gatePort = Number(next()); break;
      case '--gate-log': options.gateLog = next(); break;
      case '--dsh': options.dsh = next(); break;
      case '--dsh-exe': options.dshExe = next(); break;
      case '--dsh-cli': options.dshCli = next(); break;
      case '--profile': options.profile = next(); break;
      case '--patch': options.patch = next(); break;
      case '--dump-config-from': options.dumpConfigFrom = next(); break;
      case '--on-loss': options.onLoss = next(); break;
      case '--summary': options.summary = next(); break;
      default: options.hostArgs.push(arg); break;
    }
  }
  return options;
}

function fail(message) {
  process.stderr.write('gated-run: ' + message + '\n');
  process.exit(2);
}

/**
 * 从 CLI 的 `--dump-config` 输出里取宿主生效的 provider baseURL。
 *
 * 关键点：必须读**生效配置**，不能接受调用方自报——否则"baseURL 指向闸门"
 * 就只是调用方的说法。`--dump-config` 输出的是 YAML（不是 JSON），所以这里
 * 同时支持两种形态：JSON（测试夹具）与逐行的 `- id:` / `baseURL:` 结构。
 */
export function extractBaseUrlFromDump(dump) {
  const text = typeof dump === 'string' ? dump : JSON.stringify(dump);
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = typeof dump === 'string' ? JSON.parse(dump) : dump;
    } catch (_notJson) {
      return { ok: false, reason: 'DUMP_NOT_JSON' };
    }
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
    if (entries === null) return { ok: false, reason: 'DUMP_SHAPE_UNKNOWN' };
    const candidates = [];
    for (const entry of entries) {
      const id = entry && entry.id;
      const config = (entry && entry.config) || {};
      if (id === 'llm-deepseek' || id === 'llm-deepseek-api-key') candidates.push({ id, baseURL: config.baseURL });
    }
    return summarizeCandidates(candidates);
  }

  // YAML 形态：只认 `- id: <provider>` 块内的 baseURL，避免把别的插件的同名字段
  // 当成 provider 端点。
  const candidates = [];
  let currentId = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const idMatch = /^-\s+id:\s*(\S+)\s*$/.exec(line);
    if (idMatch) {
      currentId = idMatch[1];
      continue;
    }
    const urlMatch = /^\s+baseURL:\s*(\S+)\s*$/.exec(line);
    if (urlMatch && (currentId === 'llm-deepseek' || currentId === 'llm-deepseek-api-key')) {
      candidates.push({ id: currentId, baseURL: urlMatch[1].replace(/^['"]|['"]$/g, '') });
    }
  }
  return summarizeCandidates(candidates);
}

function summarizeCandidates(candidates) {
  if (candidates.length === 0) return { ok: false, reason: 'PROVIDER_ENTRY_NOT_FOUND' };
  const withUrl = candidates.filter((candidate) => typeof candidate.baseURL === 'string' && candidate.baseURL !== '');
  if (withUrl.length === 0) {
    return { ok: false, reason: 'BASE_URL_NOT_SET', note: '宿主使用默认端点时闸门不在路径上，等于没有保护' };
  }
  const unique = [...new Set(withUrl.map((candidate) => candidate.baseURL))];
  if (unique.length > 1) {
    return {
      ok: false,
      reason: 'BASE_URL_AMBIGUOUS',
      hosts: unique.map((value) => {
        try {
          return new URL(value).host;
        } catch (_bad) {
          return 'unparseable';
        }
      }),
    };
  }
  return { ok: true, baseURL: unique[0], id: withUrl[0].id };
}

export function dumpConfig(options) {
  if (options.dumpConfigFrom !== undefined) {
    try {
      return { text: readFileSync(options.dumpConfigFrom, 'utf8') };
    } catch (error) {
      return { error: 'dump file unreadable: ' + String(error && error.message) };
    }
  }
  if (options.dsh === undefined && options.dshExe === undefined) return { error: 'no --dsh/--dsh-exe or --dump-config-from given' };
  const args = ['--profile', options.profile || 'desktop'];
  if (options.patch !== undefined) args.push('--patch', options.patch);
  args.push('--dump-config');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  // Windows 上 `dsh.cmd` 不能直接 spawn（需要 shell，而 shell 又会把带空格的
  // 安装路径拆开）。优先用"Desktop 可执行文件 + asar 内 cli.js"的形式调用。
  const command = options.dshExe === undefined ? options.dsh : options.dshExe;
  const commandArgs = options.dshExe === undefined ? args : ['--expose-internals', options.dshCli, ...args];
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', env, shell: options.dshExe === undefined && process.platform === 'win32' });
  const text = String(result.stdout || '');
  // `--dump-config` 打印完配置后以非零码退出（实测 exit -1），因此判据是"有没有
  // 输出"，不是退出码；没输出才当作失败。
  if (text.trim() === '') {
    return { error: 'dump-config produced no output: ' + String(result.stderr || result.error || '').slice(0, 300) };
  }
  const start = text.search(/^(\[|- id:|\{)/m);
  return { text: start >= 0 ? text.slice(start) : text };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.upstream === undefined) fail('--upstream is required');
  if (!Number.isInteger(options.modelRequests)) fail('--model-requests must be an integer');
  if (options.hostArgs.length === 0) fail('no host command given after --');
  const runDir = resolve(options.runDir || '.');
  mkdirSync(runDir, { recursive: true });
  const gateLog = options.gateLog || join(runDir, 'gate-events.jsonl');
  const summaryPath = options.summary || join(runDir, 'gate-summary.json');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000;
  const heartbeatMaxAgeMs = Number.isFinite(options.heartbeatMaxAgeMs) ? options.heartbeatMaxAgeMs : 30_000;
  const leaseTtlMs = Number.isFinite(options.leaseTtlMs) ? options.leaseTtlMs : 10_000;

  const gate = createBudgetGate({
    upstream: options.upstream,
    modelRequests: options.modelRequests,
    leaseTtlMs,
    logPath: gateLog,
    mountProof: options.heartbeatFile ? { eventLog: options.heartbeatFile, maxAgeMs: heartbeatMaxAgeMs } : null,
  });
  const { baseUrl } = await gate.listen(Number.isInteger(options.gatePort) ? options.gatePort : 0);
  writeFileSync(
    join(runDir, 'gate.json'),
    JSON.stringify({ schema: 'tla.gate-handshake/v1', baseUrl, pid: process.pid, limit: options.modelRequests, startedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );

  const record = {
    schema: 'tla.gated-run/v1',
    startedAt: new Date().toISOString(),
    gateBaseUrl: baseUrl,
    upstream: options.upstream,
    limit: options.modelRequests,
  };

  const gateStatus = await readGateStatus(baseUrl);
  const dump = dumpConfig(options);
  const extracted = dump.text === undefined ? { ok: false, reason: dump.error || 'DUMP_MISSING' } : extractBaseUrlFromDump(dump.text);
  const effectiveBaseUrl = extracted.ok === true ? extracted.baseURL : null;
  const baseUrlCheck = checkBaseUrl({ effectiveBaseUrl, gateBaseUrl: baseUrl });
  if (extracted.ok !== true) baseUrlCheck.detail = extracted.reason;

  // 步骤 2：闸门在不在路径上。不在就不启动宿主（结构性 0 请求）。
  if (gateStatus.ok !== true || baseUrlCheck.ok !== true) {
    record.decision = {
      allow: false,
      blockers: [
        ...(gateStatus.ok !== true ? [{ code: 'GATE_NOT_READY', detail: gateStatus.reason || 'status unreachable' }] : []),
        { code: 'BASE_URL_MISMATCH', detail: baseUrlCheck.reason === 'BASE_URL_MISMATCH' ? 'effective baseURL is ' + String(effectiveBaseUrl) : String(baseUrlCheck.detail || baseUrlCheck.reason) },
      ],
      effectiveBaseUrl,
      gateBaseUrl: baseUrl,
      dumpReason: extracted.ok === true ? null : extracted.reason,
    };
    record.result = 'refused-before-host-start';
    record.hostStarted = false;
    record.gate = gate.status();
    writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    process.stderr.write('gated-run: ' + formatDecision(record.decision) + '\n');
    process.stderr.write('gated-run: host NOT started; model requests must be 0\n');
    await gate.close();
    process.exit(EXIT_PROTECTION_UNVERIFIED);
  }

  // 步骤 3：启动宿主。此刻没有租约，任何模型请求都会被闸门 403 拒掉。
  const child = spawn(options.hostArgs[0], options.hostArgs.slice(1), {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: runDir,
  });
  record.hostStarted = true;
  record.hostPid = child.pid;
  record.phase = 'awaiting-heartbeat';

  let hostExited = false;
  let hostExitCode = null;
  const exited = new Promise((done) => {
    child.on('exit', (code, signal) => {
      hostExited = true;
      hostExitCode = signal === null ? code || 0 : 1;
      done(hostExitCode);
    });
  });

  // 步骤 4：等插件心跳（挂载证明）。等不到 → 终止宿主。
  const deadline = Date.now() + timeoutMs;
  let heartbeat = checkProtectionHeartbeat({ eventLog: options.heartbeatFile, now: Date.now(), maxAgeMs: heartbeatMaxAgeMs });
  let lease = null;
  while (!heartbeat.ok && !hostExited && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    heartbeat = checkProtectionHeartbeat({ eventLog: options.heartbeatFile, now: Date.now(), maxAgeMs: heartbeatMaxAgeMs });
  }

  if (lease === null && heartbeat.ok) {
    const decision = decideStart({ gateReady: true, baseUrl: baseUrlCheck, heartbeat });
    if (!decision.allow) {
      record.decision = decision;
      record.result = 'refused-after-heartbeat';
    } else {
      lease = gate.grantLease();
      record.lease = { id: lease.id, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt };
      record.phase = 'leased';
      record.decision = { ...decision, effectiveBaseUrl, gateBaseUrl: baseUrl, heartbeat: { ok: true, lastEvent: heartbeat.lastEvent } };
    }
  }

  if (lease === null) {
    // 保护没建立：无论宿主是自己退出还是一直在撞 403，结论都一样——不授权。
    record.result = hostExited ? 'host-exited-before-protection' : 'protection-not-established';
    record.decision = {
      allow: false,
      blockers: [
        {
          code: heartbeat.ok ? 'GATE_NOT_READY' : heartbeat.reason === 'HEARTBEAT_STALE' ? 'HEARTBEAT_STALE' : 'HEARTBEAT_MISSING',
          detail: heartbeat.reason || 'no mounted event within timeout',
        },
      ],
      effectiveBaseUrl,
      gateBaseUrl: baseUrl,
    };
    if (!hostExited) {
      try {
        child.kill('SIGTERM');
      } catch (_alreadyGone) {
        // 已经退出就没什么可终止的。
      }
      await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
    }
    record.gate = gate.status();
    record.exitCode = hostExitCode;
    writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    process.stderr.write('gated-run: protection NOT established (' + record.decision.blockers.map((blocker) => blocker.code).join(',') + '); model requests denied at the gate\n');
    await gate.close();
    process.exit(EXIT_PROTECTION_UNVERIFIED);
  }

  // 步骤 5：租约期内按心跳续期；心跳丢失即撤销并终止宿主。
  let lost = false;
  let stopped = false;
  const renewTimer = setInterval(() => {
    if (stopped) return;
    const current = checkProtectionHeartbeat({ eventLog: options.heartbeatFile, now: Date.now(), maxAgeMs: heartbeatMaxAgeMs });
    if (current.ok) {
      gate.heartbeat(lease.id);
      return;
    }
    lost = true;
    gate.revoke('HEARTBEAT_LOST');
    appendFileSync(join(runDir, 'gate-events.jsonl'), JSON.stringify({ event: 'protection-lost', at: new Date().toISOString(), reason: current.reason }) + '\n', 'utf8');
    if ((options.onLoss || 'kill') === 'kill') {
      try {
        child.kill('SIGTERM');
      } catch (_alreadyGone) {
        // 已经退出。
      }
    }
  }, Math.max(100, Math.floor(leaseTtlMs / 3)));

  const exitCode = await exited;
  stopped = true;
  clearInterval(renewTimer);

  record.result = lost ? 'protection-lost' : exitCode === 0 ? 'host-ok' : 'host-failed';
  record.exitCode = exitCode;
  record.gate = gate.status();
  writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  await gate.close();

  if (lost) process.exit(EXIT_PROTECTION_LOST);
  process.exit(exitCode === 0 ? EXIT_OK : EXIT_HOST_FAILED);
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('gated-run.mjs');
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write('gated-run: ' + String(error && error.stack ? error.stack : error) + '\n');
    process.exit(2);
  });
}
