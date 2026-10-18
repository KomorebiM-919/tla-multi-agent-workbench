// orchestration/gate/preflight.mjs
//
// 启动前的"保护是否真的生效"判定。
//
// 这一层的存在理由：闸门（gate.mjs）只有在**宿主确实把模型请求发给它**时才算
// 保护生效。以下几种情况都会让闸门形同不存在：
//   1. 宿主生效配置里的 baseURL 被改回真实端点；
//   2. 拦截插件根本没挂上（apply 抛错 / 未安装 / 版本不兼容）；
//   3. 插件挂上了但从不心跳（进程卡住、配置写错路径）。
// 因此判定必须同时看三件事，而不是看某个布尔变量：
//   - 闸门在监听（能连上 status 接口）；
//   - 生效 baseURL 指向闸门；
//   - 插件确实写过 mounted + 心跳事件（文件里有新鲜记录）。
//
// 任何一项不成立都必须**阻止启动**（不是"先跑起来再看看"）。

import { readFileSync } from 'node:fs';
import { GateError } from './gate.mjs';

export const PREFLIGHT_SCHEMA = 'tla.gate-preflight/v1';
export const PREFLIGHT_BLOCKERS = ['GATE_NOT_READY', 'BASE_URL_MISMATCH', 'HEARTBEAT_MISSING', 'HEARTBEAT_STALE'];

export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch (_bad) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return url.protocol + '//' + url.host + path;
}

/**
 * 生效 baseURL 是否真的指向闸门。
 *
 * 注意前缀匹配用"路径边界"，否则 `http://127.0.0.1:18778` 会被
 * `http://127.0.0.1:1877` 误判为匹配。
 */
export function checkBaseUrl({ effectiveBaseUrl, gateBaseUrl }) {
  const effective = normalizeBaseUrl(effectiveBaseUrl);
  const gate = normalizeBaseUrl(gateBaseUrl);
  if (gate === null) return { ok: false, reason: 'GATE_URL_INVALID', effective, gate };
  if (effective === null) return { ok: false, reason: 'BASE_URL_INVALID', effective, gate };
  const ok = effective === gate || effective.startsWith(gate + '/');
  return { ok, reason: ok ? null : 'BASE_URL_MISMATCH', effective, gate };
}

/** 读取事件日志里最后一条指定类型的事件；没有则返回 null。 */
export function readLastEvent(eventLogPath, kinds) {
  let text;
  try {
    text = readFileSync(eventLogPath, 'utf8');
  } catch (_missing) {
    return null;
  }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_badLine) {
      continue;
    }
    if (kinds === undefined || kinds.includes(parsed.event)) return parsed;
  }
  return null;
}

/**
 * 插件挂载 + 心跳是否成立。
 *
 * @param {object} options
 * @param {string} options.eventLog 插件事件日志
 * @param {number} options.now 当前时间（毫秒）
 * @param {number} options.maxAgeMs 心跳允许的最大年龄
 */
export function checkProtectionHeartbeat({ eventLog, now, maxAgeMs, requireMounted = true }) {
  if (requireMounted) {
    const mounted = readLastEvent(eventLog, ['mounted']);
    if (mounted === null) return { ok: false, reason: 'HEARTBEAT_MISSING', mountedAt: null, lastEvent: null };
  }
  const heartbeat = readLastEvent(eventLog, ['mounted', 'reserved', 'rejected', 'heartbeat']);
  if (heartbeat === null) return { ok: false, reason: 'HEARTBEAT_MISSING', lastEvent: null };
  const at = Date.parse(heartbeat.at);
  if (!Number.isFinite(at)) return { ok: false, reason: 'HEARTBEAT_STALE', detail: '事件缺少可解析的 at', lastEvent: heartbeat.event };
  const age = now - at;
  if (age > maxAgeMs) return { ok: false, reason: 'HEARTBEAT_STALE', ageMs: age, maxAgeMs, lastEvent: heartbeat.event };
  if (age < -60_000) return { ok: false, reason: 'HEARTBEAT_STALE', detail: '心跳时间在未来（时钟异常）', ageMs: age, lastEvent: heartbeat.event };
  return { ok: true, reason: null, ageMs: age, lastEvent: heartbeat.event };
}

/**
 * 纯判定：三项全部成立才允许启动。
 *
 * @param {{gateReady:boolean, baseUrl:{ok:boolean, reason:(string|null)}, heartbeat:{ok:boolean, reason:(string|null)}}} input
 */
export function decideStart(input) {
  const blockers = [];
  if (input.gateReady !== true) blockers.push({ code: 'GATE_NOT_READY', detail: '闸门未在监听' });
  if (input.baseUrl === null || input.baseUrl.ok !== true) {
    blockers.push({ code: 'BASE_URL_MISMATCH', detail: (input.baseUrl && input.baseUrl.reason) || 'BASE_URL_INVALID' });
  }
  if (input.heartbeat === null || input.heartbeat.ok !== true) {
    const reason = (input.heartbeat && input.heartbeat.reason) || 'HEARTBEAT_MISSING';
    blockers.push({ code: reason === 'HEARTBEAT_STALE' ? 'HEARTBEAT_STALE' : 'HEARTBEAT_MISSING', detail: reason });
  }
  return { allow: blockers.length === 0, blockers };
}

/** 通过回环 HTTP 读取闸门状态；连不上即视为未就绪。 */
export async function readGateStatus(gateBaseUrl, { timeoutMs = 2_000 } = {}) {
  const url = normalizeBaseUrl(gateBaseUrl);
  if (url === null) throw new GateError('GATE_URL_INVALID', '闸门地址不可解析：' + String(gateBaseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url + '/__tla/gate/status', { signal: controller.signal });
    if (!response.ok) return { ok: false, reason: 'GATE_STATUS_HTTP_' + response.status, status: null };
    return { ok: true, reason: null, status: await response.json() };
  } catch (error) {
    return { ok: false, reason: 'GATE_UNREACHABLE', detail: String(error && error.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** 把判定结果写成给人看的一段话（也用于启动失败的错误反馈）。 */
export function formatDecision(decision) {
  if (decision.allow) return 'protection verified: gate reachable, baseURL points at gate, heartbeat fresh';
  return 'protection NOT verified -> refuse to start: ' + decision.blockers.map((b) => b.code + ' (' + b.detail + ')').join('; ');
}
