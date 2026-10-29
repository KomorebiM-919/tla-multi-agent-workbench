// 运行期读取 M1B 观察者 lifecycle journal 的"前缀"。
//
// 与 orchestration/tool-observer/lifecycle.mjs 的分工：那边是信封内写手/收尾后的
// 完整读取，要求存在终态；这里给 supervisor 用——宿主仍在运行，journal 还在增长，
// 所以允许"还没有终态"，也允许最后一行只写了一半（读取时直接丢弃该行）。
//
// 三档结论必须分开，否则要么把"还没写"误判成失败，要么把"已被篡改"误判成正常：
//   pending  还没有 attached 记录（不代表失败）
//   attached / stopped / failed  日志如实记录的阶段
//   mismatch / invalid  与本次运行身份不符或结构矛盾（立刻停止，不再等待）
// 本模块只读文件内容，不执行插件代码、不写 run 目录。
import { readFileSync } from 'node:fs';
import { TRACE_ORIGINS, TraceError } from './tool-trace-contracts.mjs';
import { isId, isUuid } from './launch-receipts.mjs';

export const OBSERVER_ATTACH_WINDOW_MS = 10_000;
export const OBSERVER_WATCH_POLL_MS = 50;

const LIFECYCLE_SCHEMA = 'tla.observer-lifecycle/v1';
const PHASES = Object.freeze(['preparing', 'attached', 'stopping', 'stopped', 'failed']);
const RECORD_KEYS = ['schema', 'seq', 'phase', 'traceId', 'origin', 'runnerRunId', 'launchId', 'gateRunId', 'budgetRunId', 'observerPid', 'code', 'health'];
const LIFECYCLE_LIMITS = Object.freeze({ maxRecords: 16, maxBytes: 64 * 1024, maxRecordBytes: 4 * 1024 });
const CLEANUP_STATES = Object.freeze(['not-started', 'pending', 'settled', 'failed', 'timeout']);

function fail(detail) {
  throw new TraceError('JOURNAL_INVALID', detail);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys, label) {
  if (!plain(value)) fail(label + ' must be an object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(label + ' has an invalid field set');
  }
}

function validCode(value) {
  return value === null || (typeof value === 'string' && /^[A-Z_]+$/.test(value));
}

function validHealth(value) {
  if (value === null) return true;
  if (!plain(value)) return false;
  try {
    exact(value, ['writerOk', 'cleanupState', 'ownershipUncertain'], 'health');
    return (value.writerOk === null || typeof value.writerOk === 'boolean')
      && CLEANUP_STATES.includes(value.cleanupState)
      && typeof value.ownershipUncertain === 'boolean';
  } catch (_invalid) {
    return false;
  }
}

function isPid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xFFFFFFFF;
}

// 逐条校验：字段集、schema、序号、身份、阶段转移。与信封内读取器同一套规则，
// 唯一放宽的是"必须有终态"与"最后一行可以没写完"。
function parseRecord(line, index) {
  if (Buffer.byteLength(line, 'utf8') > LIFECYCLE_LIMITS.maxRecordBytes) fail('record ' + (index + 1) + ' exceeds 4 KiB');
  let value;
  try {
    value = JSON.parse(line);
  } catch (_notJson) {
    fail('record ' + (index + 1) + ' is not JSON');
  }
  exact(value, RECORD_KEYS, 'record');
  if (value.schema !== LIFECYCLE_SCHEMA) fail('record ' + (index + 1) + ' has an unknown schema');
  if (value.seq !== index + 1) fail('record ' + (index + 1) + ' breaks the sequence');
  if (!PHASES.includes(value.phase)) fail('record ' + (index + 1) + ' has an unknown phase');
  if (!validCode(value.code) || !validHealth(value.health)) fail('record ' + (index + 1) + ' has invalid code or health');
  if (!isPid(value.observerPid)) fail('record ' + (index + 1) + ' has an invalid observerPid');
  if (!isUuid(value.traceId)) fail('record ' + (index + 1) + ' has an invalid traceId');
  if (!TRACE_ORIGINS.includes(value.origin)) fail('record ' + (index + 1) + ' has an invalid origin');
  if (!isId(value.runnerRunId) || !isUuid(value.launchId) || !isId(value.gateRunId) || !isId(value.budgetRunId)) {
    fail('record ' + (index + 1) + ' has an invalid run identity');
  }
  if (value.gateRunId !== value.budgetRunId) fail('record ' + (index + 1) + ' lets gate and budget identity disagree');
  return value;
}

function identityOf(value) {
  return {
    traceId: value.traceId,
    origin: value.origin,
    runnerRunId: value.runnerRunId,
    launchId: value.launchId,
    gateRunId: value.gateRunId,
    budgetRunId: value.budgetRunId,
  };
}

function sameIdentity(left, right) {
  return left.traceId === right.traceId && left.origin === right.origin
    && left.runnerRunId === right.runnerRunId && left.launchId === right.launchId
    && left.gateRunId === right.gateRunId && left.budgetRunId === right.budgetRunId;
}

function applyPhase(state, value, index) {
  if (index === 0) {
    if (value.phase !== 'preparing' || value.code !== null || value.health !== null) fail('first record must be preparing');
  } else if (value.phase === 'preparing') {
    fail('preparing appears again');
  }
  if (state.final) fail('record after a final phase');
  if (value.phase === 'attached') {
    if (state.attached || state.failed) fail('attached transition is invalid');
    if (value.code !== null || value.health !== null) fail('attached record carries failure fields');
    state.attached = true;
  } else if (value.phase === 'stopping') {
    if (!state.attached || state.stopped || state.failed) fail('stopping transition is invalid');
    if (value.code !== null || value.health !== null) fail('stopping record carries failure fields');
    state.stopping = true;
  } else if (value.phase === 'stopped') {
    if (!state.attached || !state.stopping || state.stopped || state.failed) fail('stopped transition is invalid');
    if (value.code !== null || value.health === null || value.health.writerOk !== true
      || value.health.cleanupState !== 'settled' || value.health.ownershipUncertain !== false) {
      fail('stopped record lacks terminal health');
    }
    state.stopped = true;
    state.final = true;
  } else if (value.phase === 'failed') {
    state.failed = true;
    state.final = true;
  }
}

/**
 * 读取 journal 的已完成行。尾部半行（写到一半）被丢弃并标记 waiting，
 * 既不当作记录，也不当作矛盾。
 */
export function readJournalPrefix(bytes) {
  if (bytes === null || bytes === undefined) {
    return { schema: LIFECYCLE_SCHEMA, records: [], identity: null, phase: null, waiting: false };
  }
  if (!(bytes instanceof Uint8Array)) fail('journal must be bytes');
  if (bytes.length > LIFECYCLE_LIMITS.maxBytes) fail('journal exceeds 64 KiB');
  const text = new TextDecoder('utf-8').decode(bytes);
  const cut = text.lastIndexOf('\n');
  const waiting = cut < text.length - 1;
  const complete = cut < 0 ? '' : text.slice(0, cut + 1);
  const lines = complete === '' ? [] : complete.slice(0, -1).split('\n');
  if (lines.length > LIFECYCLE_LIMITS.maxRecords) fail('journal exceeds 16 records');
  if (lines.some((line) => line.length === 0)) fail('blank line is not allowed');
  const records = [];
  let identity = null;
  const state = { attached: false, stopping: false, stopped: false, failed: false, final: false };
  for (let index = 0; index < lines.length; index += 1) {
    const value = parseRecord(lines[index], index);
    const current = identityOf(value);
    if (identity === null) identity = current;
    else if (!sameIdentity(identity, current)) fail('identity changes between records');
    applyPhase(state, value, index);
    records.push(value);
  }
  return { schema: LIFECYCLE_SCHEMA, records, identity, phase: records.length === 0 ? null : records.at(-1).phase, waiting };
}

function describeMismatch(identity, expected) {
  if (expected === undefined || expected === null) return null;
  for (const key of ['runnerRunId', 'launchId', 'gateRunId', 'budgetRunId']) {
    if (expected[key] === undefined) continue;
    if (identity[key] !== expected[key]) return 'journal ' + key + ' belongs to another run';
  }
  return null;
}

/**
 * 把 journal 前缀折算成监视状态。expected 是本次运行的身份（receipts + gate runId）。
 */
export function evaluateObserverJournal(bytes, expected) {
  let view;
  try {
    view = readJournalPrefix(bytes);
  } catch (error) {
    return { state: 'invalid', detail: String(error && error.message ? error.message : error) };
  }
  if (view.records.length === 0) {
    return {
      state: 'pending',
      detail: view.waiting === true ? 'incomplete trailing line; journal has no complete record yet' : 'journal has no records yet',
    };
  }
  const mismatch = describeMismatch(view.identity, expected);
  if (mismatch !== null) return { state: 'mismatch', detail: mismatch };
  const phase = view.phase;
  if (phase === 'failed') return { state: 'failed', detail: 'journal reported a failed phase' };
  if (phase === 'stopped') return { state: 'stopped', detail: 'journal reached stopped' };
  if (phase === 'attached' || phase === 'stopping') return { state: 'attached', detail: 'journal reached ' + phase };
  return {
    state: 'pending',
    detail: view.waiting === true ? 'incomplete trailing line; journal has no complete record yet' : 'journal has not reached attached',
  };
}

function defaultPause(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function readBytesOrNull(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 有界 attached 等待：窗口不超过 windowMs，也不越过整体宿主超时 deadline。
 * 窗口到点仍在 pending 记 timeout（"刚 spawn 还没写"不是失败依据，但超窗口是）；
 * 宿主先退出记 host-exited；身份矛盾/结构错误立刻返回，不浪费窗口。
 */
export async function awaitObserverAttachment({
  lifecycleFile = null,
  read = null,
  expected,
  windowMs = OBSERVER_ATTACH_WINDOW_MS,
  deadline = undefined,
  pollMs = OBSERVER_WATCH_POLL_MS,
  now = Date.now,
  pause = defaultPause,
  stillRunning = () => true,
} = {}) {
  const startedAt = now();
  const limit = deadline === undefined ? startedAt + windowMs : Math.min(deadline, startedAt + windowMs);
  const observe = () => {
    let bytes;
    try {
      bytes = read === null ? readBytesOrNull(lifecycleFile) : read();
    } catch (error) {
      return { state: 'invalid', detail: String(error && error.message ? error.message : error) };
    }
    return evaluateObserverJournal(bytes, expected);
  };
  let view = observe();
  let polls = 0;
  while (view.state === 'pending' && stillRunning() === true && now() < limit) {
    await pause(Math.min(pollMs, Math.max(1, limit - now())));
    view = observe();
    polls += 1;
  }
  if (view.state === 'pending') {
    if (stillRunning() !== true) view = { state: 'host-exited', detail: 'host exited before the observer attached' };
    else if (now() >= limit) view = { state: 'timeout', detail: 'no attached record within ' + (limit - startedAt) + ' ms' };
  }
  return { ...view, waitedMs: Math.max(0, now() - startedAt), polls };
}
