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
//   2. 由本运行器自己去读宿主**生效配置**（`--dump-config`），用结构化解析确认
//      **所有**模型 provider 实例的 baseURL 都指向闸门；任何一项不成立就拒绝启动
//      （此时宿主进程根本不存在）；
//   3. 启动宿主。宿主启动初期的请求全部被拒——这是刻意的：插件此时还没证明自己
//      挂上了；
//   4. 在超时窗口内等**本次运行（runId）**写出的 mounted/心跳。等不到 → 终止宿主、
//      退出码 3，期间外发请求数为 0（由闸门的默认拒绝保证，不是"期望"）；
//   5. 等到心跳 → 发放租约（预算 N），此后请求才被放行；心跳一旦过期 → 撤销租约
//      并终止宿主，避免宿主对着 403 无限重试。
//
// 运行级身份绑定（P0-3）：每次运行生成一个 runId，作为 `TLA_RUN_ID` 同时放进
// 探测与启动的环境；插件的生命周期事件必须带这个 runId，闸门只接受本次运行的
// 证明，旧会话预先写下的 mounted、别的 runId 的事件、损坏的事件行都不授权。
// 这不是密码学认证：能写事件文件的本地进程也能伪造 runId，该边界如实保留。
//
// 用法：
//   node tools/gated-run.mjs --upstream http://127.0.0.1:18777 \
//     --model-requests 3 --run-dir <dir> --heartbeat-file <plugin events.jsonl> \
//     --dsh-exe "<.../DeepSeek Harness.exe>" --dsh-cli "<.../dsh-desktop-host/lib/cli.js>" \
//     --profile stage1 --patch <overlay.yml> --prompt "<prompt>"
//
// 退出码：0 = 宿主正常退出；1 = 宿主失败；2 = 参数/环境错误；
//        3 = 保护未建立（已终止宿主，模型请求 0 次）；
//        4 = 运行中保护失效（已撤销租约并终止宿主）。

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createBudgetGate } from '../orchestration/gate/gate.mjs';
import {
  checkBaseUrl,
  checkProtectionHeartbeat,
  decideStart,
  extractProviderCoverage,
  REVIEWED_PLUGIN_NAMES,
  verifyInstalledPlugin,
  formatDecision,
  parseDumpConfigStrict,
  readGateStatus,
} from '../orchestration/gate/preflight.mjs';

export const EXIT_OK = 0;
export const EXIT_HOST_FAILED = 1;
export const EXIT_ENVIRONMENT = 2;
export const EXIT_PROTECTION_UNVERIFIED = 3;
export const EXIT_PROTECTION_LOST = 4;

export const RUN_ID_SCHEMA = 'tla.run-id/v1';
export const BLOCKED_FLAGS = ['--dump-config-from', '--allow-ungated-providers', '--on-loss'];

// `--dump-config` 的退出码：DSH 打印完配置后以 -1 退出（Node 侧观察到 255）。
// 只接受"能完整解析的配置 + 这两个码之一"，其余一律视为不可验证。
const ACCEPTABLE_DUMP_EXIT_CODES = new Set([0, 255, -1]);
const BINDING_ENV_KEYS = ['ELECTRON_RUN_AS_NODE', 'DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'TLA_RUN_ID'];
const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 900_000;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 生成一次运行的一次性标识。runId 会写进事件与租约，用于绑定"这次运行"。 */
export function buildRunId() {
  return 'tla-run-' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex');
}

/**
 * 配置探测阶段的运行身份。探测与正式启动共用 CLI/profile/patch/环境，但**不共用**
 * runId：探测阶段写下的任何事件都带 `-probe` 后缀，闸门只认正式 runId，因此
 * "探测阶段提前写出 mounted"无法授权正式运行。
 */
export function probeRunIdOf(runId) {
  return String(runId) + '-probe';
}

function requireIntWithin(label, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError('--' + label + ' must be an integer in [' + min + ', ' + max + '], received: ' + String(value));
  }
  return value;
}

export function parseArgs(argv) {
  const options = { patches: [], requireFiles: [] };
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
      // 实例就可能不是同一个 CLI/profile/工作目录。
      throw new UsageError('host arguments after -- are not accepted; use --prompt');
    }
    if (BLOCKED_FLAGS.includes(arg)) {
      throw new UsageError(arg + ' is not accepted: it would let the caller weaken or bypass the protection check');
    }
    switch (arg) {
      case '--upstream': options.upstream = next('upstream'); break;
      case '--model-requests': options.modelRequests = Number(next('model-requests')); break;
      case '--lease-ttl-ms': options.leaseTtlMs = Number(next('lease-ttl-ms')); break;
      case '--heartbeat-file': options.heartbeatFile = next('heartbeat-file'); break;
      case '--heartbeat-max-age-ms': options.heartbeatMaxAgeMs = Number(next('heartbeat-max-age-ms')); break;
      case '--timeout-ms': options.timeoutMs = Number(next('timeout-ms')); break;
      case '--config-timeout-ms': options.configTimeoutMs = Number(next('config-timeout-ms')); break;
      case '--run-dir': options.runDir = next('run-dir'); break;
      case '--gate-port': options.gatePort = Number(next('gate-port')); break;
      case '--gate-log': options.gateLog = next('gate-log'); break;
      case '--dsh-exe': options.dshExe = next('dsh-exe'); break;
      case '--dsh-cli': options.dshCli = next('dsh-cli'); break;
      case '--profile': options.profile = next('profile'); break;
      case '--patch': options.patches.push(next('patch')); break;
      case '--prompt': options.prompt = next('prompt'); break;
      case '--project-cwd': options.projectCwd = next('project-cwd'); break;
      case '--require-file': options.requireFiles.push(next('require-file')); break;
      case '--upstream-health-url': options.upstreamHealthUrl = next('upstream-health-url'); break;
      case '--upstream-run-id': options.upstreamRunId = next('upstream-run-id'); break;
      case '--summary': options.summary = next('summary'); break;
      default: throw new UsageError('unknown argument: ' + arg);
    }
  }
  return options;
}

function fail(message) {
  process.stderr.write('gated-run: ' + message + '\n');
  process.exit(EXIT_ENVIRONMENT);
}

function sha256OfFile(path) {
  try {
    return { ok: true, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), bytes: readFileSync(path).length };
  } catch (error) {
    return { ok: false, reason: 'PATCH_UNREADABLE', detail: String(error && error.message) };
  }
}

function digestEnv(env) {
  // TLA_RUN_ID 是唯一被**刻意**排除的键：探测用 `<runId>-probe`、正式宿主用
  // `<runId>`，两者必须不同（否则探测期写下的挂载证明能授权正式运行）。其余
  // 环境变量必须完全一致，才说明"探测看到的配置"与"实际启动的实例"同源。
  const pairs = BINDING_ENV_KEYS.filter((key) => key !== 'TLA_RUN_ID' && env[key] !== undefined).map((key) => key + '=' + String(env[key]));
  return createHash('sha256').update(pairs.join('\n')).digest('hex');
}

/**
 * 派生一次宿主调用。**生效配置探测与真正启动都走这里**：同一个可执行文件、同一个
 * cli.js、同一个 profile 与同一组 patch、同一个工作目录、同一份环境变量（含同一个
 * runId），只差叶子参数（`--dump-config` 与 prompt）。
 */
export function buildInvocation(options, leafArgs) {
  const args = ['--expose-internals', options.dshCli, '--profile', options.profile];
  for (const patch of options.patches) args.push('--patch', patch);
  args.push(...leafArgs);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (options.runId !== undefined) env.TLA_RUN_ID = options.runId;
  return {
    command: options.dshExe,
    args,
    cwd: options.projectCwd === undefined ? options.scratchDir : options.projectCwd,
    env,
    leaf: leafArgs,
  };
}

/**
 * 受限沙箱里子进程不能用管道回传输出（`EPERM` / 命名管道），所以把 stdout 与
 * stderr 直接接到**文件描述符**上，再由本进程读文件。
 *
 * 返回值区分"正常结束""被信号终止""启动失败""超时"，调用方不得把它们混成
 * "反正有输出就继续"（P0-5）。
 */
export function captureInvocation(invocation, outPath, errPath, timeoutMs = 120_000) {
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  try {
    // 这里必须用 spawnSync：需要"同步拿到退出原因"，且输出已定向到文件，
    // 不涉及管道。
    const result = spawnSync(invocation.command, invocation.args, {
      stdio: ['ignore', outFd, errFd],
      cwd: invocation.cwd,
      env: invocation.env,
      timeout: timeoutMs,
    });
    const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT') || result.signal === 'SIGTERM';
    return {
      exitCode: typeof result.status === 'number' ? result.status : null,
      signal: result.signal || null,
      error: result.error ? String(result.error.message) : null,
      errorCode: result.error && result.error.code ? String(result.error.code) : null,
      timedOut,
    };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

/**
 * 从 `--dump-config` 输出里取生效 baseURL。
 *
 * 只接受能**完整结构化解析**的输出；解析不出就返回失败，由调用方拒绝启动。
 * 不再用"逐行找 baseURL"的正则：那种做法会把注释、示例、别的插件的同名字段
 * 混进来（P0-4）。
 */
export function extractBaseUrlFromDump(dump) {
  const parsed = parseDumpConfigStrict(typeof dump === 'string' ? dump : JSON.stringify(dump));
  if (parsed.ok !== true) return { ok: false, reason: parsed.code, detail: parsed.detail };
  const candidates = [];
  for (const entry of parsed.entries) {
    const name = entry.name;
    if (typeof name !== 'string') continue;
    if (!name.startsWith('@deepseek-ai/dsh-llm-')) continue;
    if (name === '@deepseek-ai/dsh-llm-retry' || name === '@deepseek-ai/dsh-llm') continue;
    if (name === '@deepseek-ai/dsh-llm-pi-ai') continue; // 聚合路由由覆盖率单独判定
    if (entry.disabled === true) continue;
    const config = entry.config;
    const baseURL = config && typeof config === 'object' && typeof config.baseURL === 'string' ? config.baseURL.trim() : null;
    if (baseURL !== null && baseURL !== '') candidates.push({ id: entry.id, baseURL });
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'BASE_URL_NOT_SET', note: '宿主使用默认端点时闸门不在路径上，等于没有保护' };
  }
  const unique = [...new Set(candidates.map((candidate) => candidate.baseURL))];
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
  return { ok: true, baseURL: unique[0], id: candidates[0].id };
}

/**
 * 由启动器自己去问宿主"生效配置是什么"，并**证明这段字节可以被完整解析**。
 *
 * 失败分类（不再"stdout 非空就继续"）：
 *   CONFIG_SPAWN_FAILED / CONFIG_TIMEOUT / CONFIG_SIGNALED /
 *   CONFIG_EXIT_NONZERO / CONFIG_UNPARSEABLE / CONFIG_UNREADABLE
 */
/**
 * 从宿主 profile 的 node_modules 读已登记插件的真实身份（安装版本 + 构建指纹）。
 * 配置里声明的 version 不参与判断：那只是文本，包被换掉也照样写着旧版本号。
 */
export function verifyPluginIdentities(entries, options) {
  const names = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (!REVIEWED_PLUGIN_NAMES.has(entry.name)) continue;
    if (!names.includes(entry.name)) names.push(entry.name);
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  const profileRoot = realpathSync(join(home, 'profiles', String(options.profile)));
  const modulesDir = join(profileRoot, 'node_modules');
  return names.map((name) => {
    let pkgDir = null;
    let insideProfileRoot = null;
    try {
      pkgDir = realpathSync(join(modulesDir, name));
      // 宿主按 profile 的 node_modules 解析包名；pnpm 会把它链到 profile 内的
      // .pnpm 目录。解析后的真实路径必须仍在该 profile 根下，否则"同名包"
      // 可能只是另一个位置的副本，不能当成实际加载对象。
      const normalized = pkgDir.replace(/\\/g, '/');
      insideProfileRoot = normalized === profileRoot.replace(/\\/g, '/') || normalized.startsWith(profileRoot.replace(/\\/g, '/') + '/');
    } catch (_missing) {
      pkgDir = null;
    }
    if (pkgDir !== null && insideProfileRoot !== true) {
      const identity = verifyInstalledPlugin({ name, pkgDir: null });
      return {
        ...identity,
        resolvedRoot: pkgDir,
        profileRoot,
        insideProfileRoot: false,
        detail: '解析到的包目录不在该 profile 根下，无法证明它就是宿主实际加载的对象：' + pkgDir,
      };
    }
    return { ...verifyInstalledPlugin({ name, pkgDir }), resolvedRoot: pkgDir, profileRoot, insideProfileRoot };
  });
}

export function fetchEffectiveConfig(options, { runDir }) {
  const dumpPath = join(runDir, 'effective-config.yml');
  const errPath = join(runDir, 'effective-config.stderr.txt');
  // 探测用**另一个**运行身份：探测阶段即使有插件被激活（实测不会，见文档），
  // 它写出的事件也带 `<runId>-probe`，与正式宿主的 runId 不同 → 闸门按外来证明拒绝。
  // 这样"探测阶段写下的挂载证明"在结构上就不可能授权正式运行。
  const probeOptions = { ...options, runId: probeRunIdOf(options.runId) };
  const invocation = buildInvocation(probeOptions, ['--dump-config']);
  const timeoutMs = options.configTimeoutMs === undefined ? 20_000 : options.configTimeoutMs;
  const capture = captureInvocation(invocation, dumpPath, errPath, timeoutMs);
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
  const patchHashes = options.patches.map((patch) => ({ name: basename(patch), ...sha256OfFile(patch) }));
  const binding = {
    schema: 'tla.config-binding/v1',
    source: 'launcher-fetched',
    commandName: basename(invocation.command),
    cliName: basename(options.dshCli),
    cliPathDigest: createHash('sha256').update(String(options.dshCli)).digest('hex'),
    profile: options.profile,
    patches: patchHashes.map((patch) => ({ name: patch.name, sha256: patch.ok ? patch.sha256 : null })),
    patchBytes: patchHashes.reduce((sum, patch) => sum + (patch.ok ? patch.bytes : 0), 0),
    cwdIsRunDir: true,
    envKeys: BINDING_ENV_KEYS.filter((key) => invocation.env[key] !== undefined),
    envDigest: digestEnv(invocation.env),
    runId: invocation.env.TLA_RUN_ID === undefined ? null : invocation.env.TLA_RUN_ID,
    hostRunIdForComparison: options.runId,
    dumpFile: basename(dumpPath),
    stderrFile: basename(errPath),
    dumpExitCode: capture.exitCode,
    dumpSignal: capture.signal,
    dumpSpawnError: capture.error,
    dumpTimedOut: capture.timedOut,
  };

  const unreadable = (reason, detail) => ({ ok: false, reason, detail, binding, capture, text: '', stderrTail: stderrText.slice(-300) });
  if (capture.error !== null && capture.errorCode !== null && capture.errorCode !== 'ETIMEDOUT') return unreadable('CONFIG_SPAWN_FAILED', capture.error);
  if (capture.timedOut === true) return unreadable('CONFIG_TIMEOUT', 'effective-config probe exceeded ' + timeoutMs + 'ms');
  if (capture.signal !== null) return unreadable('CONFIG_SIGNALED', 'probe terminated by signal ' + capture.signal);
  if (!ACCEPTABLE_DUMP_EXIT_CODES.has(capture.exitCode)) {
    return unreadable('CONFIG_EXIT_NONZERO', 'probe exited with ' + String(capture.exitCode) + (stderrText.trim() === '' ? '' : '; stderr: ' + stderrText.trim().slice(-200)));
  }
  if (text.trim() === '') return unreadable('CONFIG_UNREADABLE', (stderrText.trim() || 'no output').slice(0, 300));

  // 完整解析：任何无法归类的残留都会被拒绝，因此"半截 YAML"不会混过去。
  const parsed = parseDumpConfigStrict(text);
  if (parsed.ok !== true) return unreadable(parsed.code === 'CONFIG_SHAPE_INVALID' ? 'CONFIG_SHAPE_INVALID' : 'CONFIG_UNPARSEABLE', parsed.detail);

  return {
    ok: true,
    text,
    entries: parsed.entries,
    path: dumpPath,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    binding,
    capture,
  };
}

/**
 * 终止宿主进程：SIGTERM → 等待宽限 → SIGKILL → 仍不退则（Windows）taskkill /T /F。
 * 所有等待都有上限，绝不"无限期等它自己退出"（P1-4/P1-5）。
 */
export async function terminateHost(child, { graceMs = 5_000, killWaitMs = 2_000, treeWaitMs = 2_000, win32 = process.platform === 'win32', pseudo = null } = {}) {
  const state = { exited: false, escalated: false, treeAttempted: false, treeKilled: false, waitedMs: 0 };
  if (child === null || child === undefined) return state;
  if (pseudo !== null && typeof pseudo.exitCode === 'number') {
    state.exited = true;
    return state;
  }
  if (typeof child.exitCode === 'number' && child.exitCode !== null) {
    state.exited = true;
    return state;
  }
  const exited = typeof child.onceExit === 'function' ? child.onceExit() : waitForExit(child);
  const wait = async (ms) => {
    const result = await Promise.race([exited.then(() => true), new Promise((done) => setTimeout(() => done(false), ms))]);
    state.waitedMs += ms;
    return result;
  };
  try {
    child.kill('SIGTERM');
  } catch (_alreadyGone) {
    // 已经退出。
  }
  if (await wait(graceMs)) {
    state.exited = true;
    return state;
  }
  try {
    child.kill('SIGKILL');
    state.escalated = true;
  } catch (_alreadyGone) {
    // 已经退出。
  }
  if (await wait(killWaitMs)) {
    state.exited = true;
    return state;
  }
  if (win32 === true && typeof child.pid === 'number') {
    state.treeAttempted = true;
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    const killed = await new Promise((done) => killer.on('exit', (code) => done(code === 0 || code === 1)));
    if (killed) state.treeKilled = true;
    if (await wait(treeWaitMs)) state.exited = true;
  }
  return state;
}

function waitForExit(child) {
  return new Promise((done) => {
    if (typeof child.exitCode === 'number' && child.exitCode !== null) {
      done(child.exitCode);
      return;
    }
    child.once('exit', (code) => done(code));
  });
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
  try {
    requireIntWithin('model-requests', options.modelRequests, 1, 1_000_000);
    options.leaseTtlMs = requireIntWithin('lease-ttl-ms', options.leaseTtlMs === undefined ? 10_000 : options.leaseTtlMs, 100, TIMEOUT_MAX_MS);
    options.timeoutMs = requireIntWithin('timeout-ms', options.timeoutMs === undefined ? 20_000 : options.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
    options.heartbeatMaxAgeMs = requireIntWithin('heartbeat-max-age-ms', options.heartbeatMaxAgeMs === undefined ? 8_000 : options.heartbeatMaxAgeMs, 100, TIMEOUT_MAX_MS);
    options.configTimeoutMs = requireIntWithin('config-timeout-ms', options.configTimeoutMs === undefined ? 20_000 : options.configTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
    if (options.gatePort !== undefined) requireIntWithin('gate-port', options.gatePort, 0, 65_535);
  } catch (error) {
    fail(error.message);
    return;
  }
  if (options.dshExe === undefined) fail('--dsh-exe is required (the launcher must fetch the effective config itself)');
  if (options.dshCli === undefined) fail('--dsh-cli is required (the launcher must fetch the effective config itself)');
  if (options.profile === undefined) fail('--profile is required');
  if (options.prompt === undefined) fail('--prompt is required');
  if (options.projectCwd === undefined) {
    options.projectCwd = options.runDir;
  }
  try {
    if (!statSync(options.projectCwd).isDirectory()) fail('--project-cwd is not a directory: ' + options.projectCwd);
  } catch (error) {
    fail('--project-cwd does not exist: ' + options.projectCwd + ' (' + error.code + ')');
  }
  for (const required of options.requireFiles) {
    const candidate = resolve(options.projectCwd, required);
    try {
      statSync(candidate);
    } catch (error) {
      fail('required project file is missing before start: ' + required + ' (' + error.code + ')');
    }
  }
  if (options.heartbeatFile === undefined) fail('--heartbeat-file is required (mount proof must be bound to this run)');

  const runDir = resolve(options.runDir || '.');
  mkdirSync(runDir, { recursive: true });
  options.scratchDir = runDir;
  options.runId = options.runId || buildRunId();

  const gateLog = options.gateLog || join(runDir, 'gate-events.jsonl');
  const summaryPath = options.summary || join(runDir, 'gate-summary.json');
  const record = {
    schema: 'tla.gated-run/v1',
    runId: options.runId,
    startedAt: new Date().toISOString(),
    upstream: options.upstream,
    limit: options.modelRequests,
    timeoutMs: options.timeoutMs,
    heartbeatMaxAgeMs: options.heartbeatMaxAgeMs,
    leaseTtlMs: options.leaseTtlMs,
  };

  const patchChecks = options.patches.map((patch) => ({ name: basename(patch), ...sha256OfFile(patch) }));
  const unreadablePatch = patchChecks.find((patch) => patch.ok !== true);
  if (unreadablePatch !== undefined) {
    record.result = 'refused-before-host-start';
    record.decision = { allow: false, blockers: [{ code: 'PATCH_UNREADABLE', detail: unreadablePatch.detail }] };
    writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fail('patch file is unreadable: ' + String(unreadablePatch.name));
    return;
  }

  // notBefore 在宿主真正启动后写入（见步骤 4）：早于启动时刻的 mounted 只可能来自
  // 配置探测阶段或旧运行，不得授权本次运行。requireHeartbeat 要求 mounted 之后
  // 还有持续心跳，单条 mounted 不足以证明"当前实例仍在运行"。
  const mountProof = { eventLog: options.heartbeatFile, runId: options.runId, maxAgeMs: options.heartbeatMaxAgeMs, notBefore: undefined, requireHeartbeat: true };
  const gate = createBudgetGate({
    upstream: options.upstream,
    modelRequests: options.modelRequests,
    leaseTtlMs: options.leaseTtlMs,
    logPath: gateLog,
    mountProof,
  });

  let child = null;
  let renewTimer = null;
  let stopped = false;
  try {
    const { baseUrl } = await gate.listen(options.gatePort === undefined ? 0 : options.gatePort);
    record.gateBaseUrl = baseUrl;
    writeFileSync(
      join(runDir, 'gate.json'),
      JSON.stringify({ schema: 'tla.gate-handshake/v1', runId: options.runId, baseUrl, pid: process.pid, limit: options.modelRequests, startedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );

    // ---- 步骤 1：闸门可达 ----
    const gateStatus = await readGateStatus(baseUrl);
    // ---- 步骤 2：启动器自己取生效配置，并证明可完整解析 ----
    const configProbe = fetchEffectiveConfig(options, { runDir });
    record.config = {
      source: configProbe.binding.source,
      binding: configProbe.binding,
      bytes: configProbe.ok ? configProbe.bytes : 0,
      sha256: configProbe.ok ? configProbe.sha256 : null,
      reason: configProbe.ok ? null : configProbe.reason,
      detail: configProbe.ok ? null : configProbe.detail,
    };

    const extracted = configProbe.ok ? extractBaseUrlFromDump(configProbe.text) : { ok: false, reason: configProbe.reason };
    const effectiveBaseUrl = extracted.ok === true ? extracted.baseURL : null;
    const baseUrlCheck = checkBaseUrl({ effectiveBaseUrl, gateBaseUrl: baseUrl });
    if (extracted.ok !== true) baseUrlCheck.detail = extracted.reason + (extracted.detail === undefined ? '' : ' (' + extracted.detail + ')');
    const coverage = configProbe.ok && configProbe.entries ? extractProviderCoverage(configProbe.entries, baseUrl) : null;
    record.coverage = coverage;
    // 已登记插件的"版本 + 构建指纹"必须从宿主实际解析到的包目录读出来核对，
    // 配置里声明的版本不作数（那只是文本）。
    const pluginIdentities = configProbe.ok && configProbe.entries ? verifyPluginIdentities(configProbe.entries, options) : [];
    record.pluginIdentities = pluginIdentities;

    // ---- 步骤 3：判定。任一不成立就拒绝启动（宿主进程根本不存在） ----
    // 配置读不到/解析不出时只报这一个原因：把"缺输入"同时说成"地址错、覆盖率不明"
    // 会让报告失真，也会掩盖真正的第一故障。
    const decision = configProbe.ok !== true
      ? { allow: false, blockers: [{ code: configProbe.reason, detail: String(configProbe.detail) }] }
      : decideStart({
          gateReady: gateStatus.ok === true,
          baseUrl: baseUrlCheck,
          heartbeat: { ok: true, reason: null, note: 'checked after host start' },
          coverage,
          pluginIdentities,
        });
    record.decision = {
      ...decision,
      effectiveBaseUrl,
      gateBaseUrl: baseUrl,
      dumpReason: extracted.ok === true ? null : extracted.reason,
      configSha256: configProbe.ok ? configProbe.sha256 : null,
    };
    if (record.decision.blockers.length > 0) {
      record.result = 'refused-before-host-start';
      record.hostStarted = false;
      record.gate = gate.status();
      writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
      process.stderr.write('gated-run: ' + formatDecision(record.decision) + '\n');
      process.stderr.write('gated-run: host NOT started; model requests must be 0\n');
      return EXIT_PROTECTION_UNVERIFIED;
    }

    // ---- 步骤 4：启动宿主（此刻没有租约） ----
    const hostInvocation = buildInvocation(options, [options.prompt]);
    record.invocation = {
      schema: 'tla.config-binding/v1',
      commandName: basename(hostInvocation.command),
      cliName: basename(options.dshCli),
      profile: options.profile,
      patches: patchChecks.map((patch) => patch.name),
      cwdIsRunDir: hostInvocation.cwd === runDir,
      sameCommandAsProbe: basename(hostInvocation.command) === configProbe.binding.commandName,
      sameProfileAsProbe: options.profile === configProbe.binding.profile,
      samePatchesAsProbe: JSON.stringify(patchChecks.map((patch) => patch.sha256)) === JSON.stringify(configProbe.binding.patches.map((patch) => patch.sha256)),
      sameEnvAsProbe: digestEnv(hostInvocation.env) === configProbe.binding.envDigest,
      // 探测与正式宿主**必须**用不同的运行身份：探针 id 是 `<runId>-probe`，
      // 正式宿主是 `<runId>`。相同反而说明两阶段混用身份，要拒绝。
      runIdSeparatedFromProbe: configProbe.binding.runId === probeRunIdOf(options.runId) && hostInvocation.env.TLA_RUN_ID === options.runId,
      hostRunId: options.runId,
      probeRunId: configProbe.binding.runId,
      dumpLeaf: configProbe.binding.dumpFile,
      hostLeaf: 'prompt',
    };
    if (record.invocation.sameCommandAsProbe !== true || record.invocation.sameProfileAsProbe !== true || record.invocation.samePatchesAsProbe !== true || record.invocation.sameEnvAsProbe !== true || record.invocation.runIdSeparatedFromProbe !== true) {
      record.result = 'refused-before-host-start';
      record.hostStarted = false;
      record.decision = { allow: false, blockers: [{ code: 'INVOCATION_MISMATCH', detail: 'probe and host invocation differ; refusing to start' }] };
      writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
      return EXIT_PROTECTION_UNVERIFIED;
    }

    let spawnError = null;
    // 假上游必须先用健康检查证明"它就是本轮的服务"：端口被别人占着、
    // 或者读到的 PID/runId 与预期不符时，不启动宿主，也不复用旧服务。
    if (options.upstreamHealthUrl !== undefined) {
      let health = null;
      try {
        const response = await fetch(options.upstreamHealthUrl, { signal: AbortSignal.timeout(3_000) });
        health = { status: response.status, body: await response.json() };
      } catch (error) {
        health = { error: String(error && error.message) };
      }
      record.upstreamHealth = health;
      const expected = options.upstreamRunId;
      const healthy = health !== null && health.status === 200 && health.body && health.body.ok === true;
      const matchesRun = expected === undefined || (health.body && health.body.runId === expected);
      if (!healthy || !matchesRun) {
        record.result = 'refused-before-host-start';
        record.hostStarted = false;
        record.decision = { allow: false, blockers: [{ code: 'UPSTREAM_UNHEALTHY', detail: matchesRun ? 'upstream health check failed: ' + JSON.stringify(health) : 'upstream belongs to another run: ' + JSON.stringify(health.body) }] };
        writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
        return EXIT_PROTECTION_UNVERIFIED;
      }
    }
    // 先记下"宿主启动时刻"再 spawn：闸门用它拒绝早于本次启动的挂载证明。
    mountProof.notBefore = Date.now();
    child = spawn(hostInvocation.command, hostInvocation.args, { stdio: 'inherit', env: hostInvocation.env, cwd: hostInvocation.cwd });
    child.on('error', (error) => {
      spawnError = error;
      appendFileSync(join(runDir, 'gate-events.jsonl'), JSON.stringify({ event: 'host-spawn-error', at: new Date().toISOString(), message: String(error && error.message) }) + '\n', 'utf8');
    });
    record.hostStarted = true;
    record.hostPid = child.pid === undefined ? null : child.pid;
    record.phase = 'awaiting-heartbeat';

    let hostExited = false;
    let hostExitCode = null;
    const exited = new Promise((done) => {
      child.once('exit', (code, signal) => {
        hostExited = true;
        hostExitCode = signal === null ? (typeof code === 'number' ? code : 1) : 1;
        done(hostExitCode);
      });
    });

    // ---- 步骤 5：等本次 runId 的 mount + 心跳（超时即终止） ----
    const deadline = Date.now() + options.timeoutMs;
    let heartbeat = checkProtectionHeartbeat({ eventLog: options.heartbeatFile, runId: options.runId, now: Date.now(), maxAgeMs: options.heartbeatMaxAgeMs });
    while (heartbeat.ok !== true && hostExited !== true && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
      heartbeat = checkProtectionHeartbeat({ eventLog: options.heartbeatFile, runId: options.runId, now: Date.now(), maxAgeMs: options.heartbeatMaxAgeMs });
    }
    record.heartbeat = { ok: heartbeat.ok, reason: heartbeat.reason === undefined ? null : heartbeat.reason, lastEvent: heartbeat.lastEvent === undefined ? null : heartbeat.lastEvent, waitedMs: options.timeoutMs - Math.max(0, deadline - Date.now()) };

    if (heartbeat.ok !== true) {
      // 保护没建立：无论宿主是自己退出还是正在撞 403，结论都一样——不授权。
      record.result = hostExited ? 'host-exited-before-protection' : 'protection-not-established';
      record.decision = {
        allow: false,
        blockers: [{ code: heartbeat.reason === 'HEARTBEAT_STALE' ? 'HEARTBEAT_STALE' : 'HEARTBEAT_MISSING', detail: String(heartbeat.reason || 'no run-bound mounted event within timeout') }],
        effectiveBaseUrl,
        gateBaseUrl: baseUrl,
      };
      record.hostStarted = true;
      if (hostExited !== true) {
        record.termination = await terminateHost(child, { pseudo: { exitCode: null } });
        hostExited = record.termination.exited === true;
      }
      record.gate = gate.status();
      record.exitCode = hostExitCode;
      writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
      process.stderr.write('gated-run: protection NOT established (' + record.decision.blockers.map((blocker) => blocker.code).join(',') + '); model requests denied at the gate\n');
      return EXIT_PROTECTION_UNVERIFIED;
    }

    // ---- 步骤 6：授权（租约 + 预算） ----
    const lease = gate.grantLease();
    record.lease = { id: lease.id, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt };
    record.phase = 'leased';
    record.decision = {
      allow: true,
      blockers: [],
      effectiveBaseUrl,
      gateBaseUrl: baseUrl,
      coverage: coverage === null ? null : { guarded: coverage.guarded, unguarded: coverage.unguarded, unknown: coverage.unknown, providers: coverage.providers },
      heartbeat: { ok: true, lastEvent: heartbeat.lastEvent },
    };

    // ---- 步骤 7：续期；心跳丢失即撤销并终止宿主（有上限，不无限等） ----
    let lost = false;
    const lossReason = { value: null };
    renewTimer = setInterval(() => {
      if (stopped) return;
      // 宿主已经退出时心跳自然停止，这不是"保护丢失"，而是运行结束。
      if (hostExited) return;
      const current = checkProtectionHeartbeat({ eventLog: options.heartbeatFile, runId: options.runId, now: Date.now(), maxAgeMs: options.heartbeatMaxAgeMs });
      if (current.ok === true) {
        const renewed = gate.heartbeat(lease.id);
        if (renewed.ok !== true) {
          lost = true;
          lossReason.value = renewed.reason;
          gate.revoke('LEASE_RENEWAL_FAILED');
        }
        return;
      }
      lost = true;
      lossReason.value = current.reason;
      gate.revoke('HEARTBEAT_LOST');
      appendFileSync(join(runDir, 'gate-events.jsonl'), JSON.stringify({ event: 'protection-lost', at: new Date().toISOString(), reason: current.reason }) + '\n', 'utf8');
    }, Math.max(50, Math.floor(options.leaseTtlMs / 3)));

    const firstExit = await Promise.race([exited.then((code) => ({ kind: 'exit', code })), new Promise((done) => setTimeout(() => done({ kind: 'still-running' }), Math.max(100, options.timeoutMs)))]);
    stopped = true;
    clearInterval(renewTimer);
    renewTimer = null;

    if (lost === true) {
      record.result = 'protection-lost';
      record.lossReason = lossReason.value;
      record.termination = await terminateHost(child, { pseudo: { exitCode: firstExit.kind === 'exit' ? firstExit.code : null } });
      record.exitCode = firstExit.kind === 'exit' ? firstExit.code : null;
      record.gate = gate.status();
      writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
      process.stderr.write('gated-run: protection lost (' + String(lossReason.value) + '); lease revoked and host terminated\n');
      return EXIT_PROTECTION_LOST;
    }

    // 宿主还在跑但已经过了运行窗口：按 P1-5 主动终止，不留后台进程。
    if (firstExit.kind !== 'exit') {
      record.termination = await terminateHost(child, { pseudo: { exitCode: null } });
      record.result = 'host-terminated-by-timeout';
      record.exitCode = null;
      record.gate = gate.status();
      writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
      return EXIT_PROTECTION_LOST;
    }

    if (spawnError !== null) {
      record.result = 'host-spawn-failed';
      record.spawnError = String(spawnError.message);
      record.gate = gate.status();
      writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
      return EXIT_ENVIRONMENT;
    }

    record.result = firstExit.code === 0 ? 'host-ok' : 'host-failed';
    record.exitCode = firstExit.code;
    record.gate = gate.status();
    writeFileSync(summaryPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return firstExit.code === 0 ? EXIT_OK : EXIT_HOST_FAILED;
  } finally {
    stopped = true;
    if (renewTimer !== null) clearInterval(renewTimer);
    try {
      await gate.close();
    } catch (_closeFailed) {
      // 关闭失败不掩盖主结论；summary 里已有 gate 状态。
    }
    if (child !== null && child.exitCode === null && child.killed !== true) {
      try {
        child.kill('SIGKILL');
      } catch (_alreadyGone) {
        // 已退出。
      }
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('gated-run.mjs');
if (invokedDirectly) {
  main().then((code) => {
    process.exit(typeof code === 'number' ? code : 0);
  }).catch((error) => {
    process.stderr.write('gated-run: ' + String(error && error.stack ? error.stack : error) + '\n');
    process.exit(EXIT_ENVIRONMENT);
  });
}
