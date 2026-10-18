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
//     --dsh-exe "<.../DeepSeek Harness.exe>" --dsh-cli "<.../dsh-desktop-host/lib/cli.js>" \
//     --profile stage1 --patch <overlay.yml> --prompt "<prompt>"
//
// 生效配置由本运行器**自己**向同一个可执行文件、同一个 profile、同一个工作目录、
// 同一份环境变量请求（`--dump-config`），不接受手工预生成的配置文件；被检查的
// 配置与真正启动的实例因此由同一组参数派生（见 buildInvocation()）。
//
// 退出码：0 = 宿主正常退出；1 = 宿主失败；2 = 参数/环境错误；
//        3 = 保护未建立（已终止宿主，模型请求 0 次）；
//        4 = 运行中保护失效（已撤销租约并终止宿主）。

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { createBudgetGate } from '../orchestration/gate/gate.mjs';
import {
  checkBaseUrl,
  checkProtectionHeartbeat,
  decideStart,
  extractProviderCoverage,
  formatDecision,
  readGateStatus,
} from '../orchestration/gate/preflight.mjs';

export const EXIT_OK = 0;
export const EXIT_HOST_FAILED = 1;
export const EXIT_PROTECTION_UNVERIFIED = 3;
export const EXIT_PROTECTION_LOST = 4;

export function parseArgs(argv) {
  const options = { patches: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (name) => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new UsageError('--' + name + ' requires a value');
      return value;
    };
    if (arg === '--') {
      // 宿主命令行不再由调用方拼装：一旦允许自由拼接，被检查的配置和真正启动的
      // 实例就可能不是同一个 CLI/profile/工作目录。两条命令都由 buildInvocation()
      // 从同一组参数派生。
      throw new UsageError('host arguments after -- are not accepted; use --prompt');
    }
    switch (arg) {
      case '--upstream': options.upstream = next('upstream'); break;
      case '--model-requests': options.modelRequests = Number(next('model-requests')); break;
      case '--lease-ttl-ms': options.leaseTtlMs = Number(next('lease-ttl-ms')); break;
      case '--heartbeat-file': options.heartbeatFile = next('heartbeat-file'); break;
      case '--heartbeat-max-age-ms': options.heartbeatMaxAgeMs = Number(next('heartbeat-max-age-ms')); break;
      case '--timeout-ms': options.timeoutMs = next('timeout-ms'); break;
      case '--run-dir': options.runDir = next('run-dir'); break;
      case '--gate-port': options.gatePort = Number(next('gate-port')); break;
      case '--gate-log': options.gateLog = next('gate-log'); break;
      case '--dsh-exe': options.dshExe = next('dsh-exe'); break;
      case '--dsh-cli': options.dshCli = next('dsh-cli'); break;
      case '--profile': options.profile = next('profile'); break;
      case '--patch': options.patches.push(next('patch')); break;
      case '--prompt': options.prompt = next('prompt'); break;
      case '--dump-config-from':
        // 手工预生成的配置文件无法证明与真正启动的实例一致，一律拒绝。
        throw new UsageError('--dump-config-from is not accepted; the launcher fetches the effective config itself');
      case '--allow-ungated-providers':
        // 放宽覆盖率校验会让"保护"退回成调用方的说法，本实验明确禁止。
        throw new UsageError('--allow-ungated-providers is forbidden: every enabled provider instance must point at the gate');
      case '--on-loss': options.onLoss = next('on-loss'); break;
      case '--summary': options.summary = next('summary'); break;
      default: throw new UsageError('unknown argument: ' + arg);
    }
  }
  return options;
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
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

/**
 * 派生一次宿主调用。**生效配置探测与真正启动都走这里**：同一个可执行文件、同一个
 * cli.js、同一个 profile 与同一组 patch、同一个工作目录、同一份环境变量，只差叶子
 * 参数（`--dump-config` 与 prompt）。这条"同源派生"是可校验性的一部分：如果被检查
 * 的配置来自别处（手工文件、别的 profile），那它就只是调用方的说法。
 */
export function buildInvocation(options, leafArgs) {
  const args = ['--expose-internals', options.dshCli, '--profile', options.profile];
  for (const patch of options.patches) args.push('--patch', patch);
  args.push(...leafArgs);
  return {
    command: options.dshExe,
    args,
    cwd: options.scratchDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    leaf: leafArgs,
  };
}

/**
 * 受限沙箱里子进程不能用管道回传输出（`EPERM` / 命名管道），所以把 stdout 与
 * stderr 直接接到**文件描述符**上，再由本进程读文件。
 */
export function captureInvocation(invocation, outPath, errPath, timeoutMs = 120_000) {
  // stdout 与 stderr 分开落盘：生效配置只能取自 stdout。否则宿主写到 stderr 的
  // 警告/堆栈会被当成配置内容解析，把"读不到配置"误判成"配置不匹配"。
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  try {
    const result = spawnSync(invocation.command, invocation.args, {
      stdio: ['ignore', outFd, errFd],
      cwd: invocation.cwd,
      env: invocation.env,
      timeout: timeoutMs,
    });
    return {
      exitCode: typeof result.status === 'number' ? result.status : null,
      signal: result.signal || null,
      error: result.error ? String(result.error.message) : null,
    };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

const BINDING_ENV_KEYS = ['ELECTRON_RUN_AS_NODE', 'DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR'];

/**
 * 由启动器自己去问宿主"生效配置是什么"。之后所有判断都基于这段字节，不再读任何
 * 调用方预先写好的配置文件。
 */
export function fetchEffectiveConfig(options, { runDir }) {
  const dumpPath = join(runDir, 'effective-config.yml');
  const errPath = join(runDir, 'effective-config.stderr.txt');
  const invocation = buildInvocation(options, ['--dump-config']);
  const capture = captureInvocation(invocation, dumpPath, errPath);
  let text = '';
  let stderrText = '';
  try {
    text = readFileSync(dumpPath, 'utf8');
  } catch (_missingOut) {
    text = '';
  }
  try {
    stderrText = readFileSync(errPath, 'utf8');
  } catch (_missingErr) {
    stderrText = '';
  }
  const binding = {
    schema: 'tla.config-binding/v1',
    source: 'launcher-fetched',
    commandName: basename(invocation.command),
    cliName: basename(options.dshCli),
    profile: options.profile,
    patches: options.patches.map((patch) => basename(patch)),
    cwdIsRunDir: true,
    envKeys: BINDING_ENV_KEYS.filter((key) => invocation.env[key] !== undefined),
    dumpFile: basename(dumpPath),
    stderrFile: basename(errPath),
    // `--dump-config` 打印完配置后以非零码退出（实测 -1），判据是"有没有输出"。
    dumpExitCode: capture.exitCode,
    dumpSpawnError: capture.error,
  };
  // 裁剪到第一个真正像配置的位置：宿主在配置前后可能夹带无关行。
  const start = text.search(/^(\[|- id:|\{)/m);
  const body = start >= 0 ? text.slice(start) : text;
  if (body.trim() === '') {
    const detail = (capture.error || stderrText.trim() || 'no output').slice(0, 300);
    return { ok: false, reason: 'CONFIG_UNREADABLE', detail, binding, text: '' };
  }
  return {
    ok: true,
    text: body,
    path: dumpPath,
    bytes: Buffer.byteLength(body, 'utf8'),
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    binding,
    capture,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error && error.message ? error.message : 'invalid arguments');
    return;
  }
  if (options.upstream === undefined) fail('--upstream is required');
  if (!Number.isInteger(options.modelRequests)) fail('--model-requests must be an integer');
  if (options.dshExe === undefined) fail('--dsh-exe is required (the launcher must fetch the effective config itself)');
  if (options.dshCli === undefined) fail('--dsh-cli is required (the launcher must fetch the effective config itself)');
  if (options.profile === undefined) fail('--profile is required');
  if (options.prompt === undefined) fail('--prompt is required');
  const runDir = resolve(options.runDir || '.');
  mkdirSync(runDir, { recursive: true });
  // 生效配置探测与真正启动用同一个工作目录。
  options.scratchDir = runDir;
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
  // 启动器自己去取生效配置：同一个可执行文件、同一个 profile、同一个工作目录、
  // 同一份环境变量。取不到就拒绝启动，绝不退回"调用方给的配置文件"。
  const configProbe = fetchEffectiveConfig(options, { runDir });
  record.config = {
    source: configProbe.binding.source,
    binding: configProbe.binding,
    bytes: configProbe.ok ? configProbe.bytes : 0,
    sha256: configProbe.ok ? configProbe.sha256 : null,
    reason: configProbe.ok ? null : configProbe.reason,
    detail: configProbe.ok ? null : configProbe.detail,
  };
  const dumpText = configProbe.ok ? configProbe.text : '';
  const extracted = configProbe.ok ? extractBaseUrlFromDump(dumpText) : { ok: false, reason: configProbe.reason };
  const effectiveBaseUrl = extracted.ok === true ? extracted.baseURL : null;
  const baseUrlCheck = checkBaseUrl({ effectiveBaseUrl, gateBaseUrl: baseUrl });
  if (extracted.ok !== true) baseUrlCheck.detail = extracted.reason;
  const coverage = configProbe.ok ? extractProviderCoverage(dumpText, baseUrl) : null;
  record.coverage = coverage;
  // 没有任何 provider 被确认指向闸门，等于"保护只存在于调用方的话里"。
  const noGuardedProvider = coverage === null || coverage.guarded.length === 0;
  const unguardedProviders = coverage === null ? [] : coverage.unguarded;

  // 步骤 2：闸门在不在路径上。不在就不启动宿主（结构性 0 请求）。
  // 覆盖判定同样在这里：任何未指向闸门的 provider 实例都意味着存在绕过路径。
  if (gateStatus.ok !== true || configProbe.ok !== true || baseUrlCheck.ok !== true || unguardedProviders.length > 0 || noGuardedProvider) {
    record.decision = {
      allow: false,
      blockers: [
        ...(gateStatus.ok !== true ? [{ code: 'GATE_NOT_READY', detail: gateStatus.reason || 'status unreachable' }] : []),
        ...(configProbe.ok !== true ? [{ code: 'CONFIG_UNREADABLE', detail: String(configProbe.detail || configProbe.reason) }] : []),
        ...(configProbe.ok && coverage === null ? [{ code: 'CONFIG_COVERAGE_UNKNOWN', detail: '生效配置无法解析出 provider 覆盖率' }] : []),
        ...(configProbe.ok && coverage !== null && noGuardedProvider ? [{ code: 'NO_GATED_PROVIDER', detail: '生效配置里没有任何指向闸门的 provider 实例' }] : []),
        // 只有在真的读到配置、且里面的地址不对时才谈 BASE_URL_MISMATCH；读不到
        // 配置时把它一起报出来会把"缺输入"说成"地址错"。
        ...(configProbe.ok === true && baseUrlCheck.ok !== true ? [{ code: 'BASE_URL_MISMATCH', detail: baseUrlCheck.reason === 'BASE_URL_MISMATCH' ? 'effective baseURL is ' + String(effectiveBaseUrl) : String(baseUrlCheck.detail || baseUrlCheck.reason) }] : []),
        ...(unguardedProviders.length > 0 ? [{ code: 'PROVIDER_NOT_GATED', detail: '未指向闸门的 provider 实例：' + coverage.unguarded.join(',') }] : []),
      ],
      effectiveBaseUrl,
      gateBaseUrl: baseUrl,
      dumpReason: extracted.ok === true ? null : extracted.reason,
      configSha256: configProbe.ok ? configProbe.sha256 : null,
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
  // 启动用的调用由 buildInvocation() 派生，与上面探测配置时同源。
  const hostInvocation = buildInvocation(options, [options.prompt]);
  const child = spawn(hostInvocation.command, hostInvocation.args, {
    stdio: 'inherit',
    env: hostInvocation.env,
    cwd: hostInvocation.cwd,
  });
  record.invocation = {
    schema: 'tla.config-binding/v1',
    commandName: basename(hostInvocation.command),
    cliName: basename(options.dshCli),
    profile: options.profile,
    patches: options.patches.map((patch) => basename(patch)),
    cwdIsRunDir: hostInvocation.cwd === runDir,
    sameCommandAsProbe: basename(hostInvocation.command) === configProbe.binding.commandName,
    sameProfileAsProbe: options.profile === configProbe.binding.profile,
    samePatchesAsProbe: options.patches.length === configProbe.binding.patches.length,
    dumpLeaf: configProbe.binding.dumpFile,
    hostLeaf: 'prompt',
  };
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
    const decision = decideStart({ gateReady: true, baseUrl: baseUrlCheck, heartbeat, coverage });
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
