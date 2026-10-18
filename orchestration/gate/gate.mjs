// orchestration/gate/gate.mjs
//
// 预算闸门（enforcement plane）——**独立于被保护插件**的请求阻断点。
//
// 为什么需要它：2026-10-18 的实测表明，宿主对插件激活失败只打印
// `warning: 1 entry did not activate` 然后**继续运行**。也就是说，只要"保护"
// 由插件实现，插件没挂上就等于没有保护，而且没人知道。本模块把"能不能发请求"
// 从插件搬到网络上：宿主（或任何客户端）的模型请求必须**先经过这里**，而这里
// **默认拒绝**——没有有效租约就不转发、不建连接，请求根本到不了模型端。
//
// 与插件的关系：插件只负责"心跳/授权请求"，不是保护机制本身。插件缺失、apply
// 抛错、心跳缺失、运行中失效，结果都是"没有租约"→ 请求被拒（0 次外发），不会
// 降级成"无预算继续跑"。
//
// 安全边界：
// - 只监听回环地址；上游只允许回环（本阶段禁止把流量转去任何真实端点）。
// - 不读取任何凭据；转发的请求头原样透传，但闸门自己不注入、不打印凭据值。
// - 控制面（/__tla/gate/*）只接受回环来源。
//
// 限制（必须如实声明）：这是**隔离实验里**的强制点，不是宿主级强制。若把宿主
// 的 baseURL 改回真实端点，闸门就不在路径上了——所以启动前必须验证"生效配置
// 确实指向闸门"，见 preflight.mjs。

import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readLastEvent } from './preflight.mjs';

export const GATE_SCHEMA = 'tla.budget-gate/v1';
export const GATE_DENY_CODES = ['NO_LEASE', 'LEASE_EXPIRED', 'BUDGET_EXHAUSTED', 'REVOKED', 'GATE_CLOSING'];
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

export class GateError extends Error {
  constructor(code, detail) {
    super(code + ': ' + detail);
    this.name = 'GateError';
    this.code = code;
    this.detail = detail;
  }
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.includes(hostname) || hostname === '::ffff:127.0.0.1';
}

export function assertLoopbackUpstream(upstream) {
  let url;
  try {
    url = new URL(upstream);
  } catch (_bad) {
    throw new GateError('GATE_UPSTREAM_INVALID', '上游不是合法 URL：' + String(upstream));
  }
  if (url.protocol !== 'http:') {
    throw new GateError('GATE_UPSTREAM_NOT_LOOPBACK', '本阶段只允许 http 回环上游，收到：' + url.protocol);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new GateError('GATE_UPSTREAM_NOT_LOOPBACK', '上游必须是回环地址，收到：' + url.hostname);
  }
  return url;
}

function requirePositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1 || !Number.isSafeInteger(value)) {
    throw new GateError('GATE_LIMIT_INVALID', label + ' 必须是正整数，收到：' + String(value));
  }
  return value;
}

/**
 * 创建预算闸门（尚未开始监听）。
 *
 * @param {object} options
 * @param {string} options.upstream 回环上游基址，例如 http://127.0.0.1:18777
 * @param {number} options.modelRequests 允许放行的模型请求数
 * @param {number} [options.leaseTtlMs] 租约有效期（需心跳续期）
 * @param {string} [options.logPath] 事件日志（JSONL）
 * @param {() => number} [options.now] 时钟注入，便于测试
 */
export function createBudgetGate(options) {
  const upstream = assertLoopbackUpstream(options.upstream);
  const modelRequests = requirePositiveInteger('modelRequests', options.modelRequests);
  const leaseTtlMs = options.leaseTtlMs === undefined ? 30_000 : requirePositiveInteger('leaseTtlMs', options.leaseTtlMs);
  const logPath = options.logPath || null;
  const now = options.now || (() => Date.now());
  const mountProof = options.mountProof || null;
  const mountMaxAgeMs = mountProof === null ? 0 : requirePositiveInteger('mountProof.maxAgeMs', mountProof.maxAgeMs);

  let seq = 0;
  let used = 0;
  let rejected = 0;
  let deniedByReason = Object.fromEntries(GATE_DENY_CODES.map((code) => [code, 0]));
  let lease = null;
  let closing = false;
  let server = null;
  let baseUrl = null;
  let mountConsumedAt = null;
  let permanentRevoke = false;

  const writeEvent = (entry) => {
    if (!logPath) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify({ ...entry, at: new Date(now()).toISOString() }) + '\n', 'utf8');
    } catch (_unwritable) {
      // 日志写不进去不能成为放行理由：只影响可观测性，不影响判定。
    }
  };

  const remaining = () => Math.max(0, modelRequests - used);
  const leaseActive = () => lease !== null && lease.expiresAt > now();

  const denyReason = () => {
    if (closing) return 'GATE_CLOSING';
    if (lease === null) return 'NO_LEASE';
    if (lease.revoked === true) return 'REVOKED';
    if (lease.expiresAt <= now()) return 'LEASE_EXPIRED';
    if (remaining() <= 0) return 'BUDGET_EXHAUSTED';
    return null;
  };

  const status = () => ({
    schema: GATE_SCHEMA,
    state: closing ? 'closing' : lease === null ? 'armed' : leaseActive() ? 'leased' : 'lease-expired',
    used,
    rejects: rejected,
    limit: modelRequests,
    remaining: remaining(),
    deniedByReason: { ...deniedByReason },
    mountProof: mountProof === null ? { enabled: false } : { enabled: true, consumedAt: mountConsumedAt },
    lease: lease === null ? null : { id: lease.id, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt, revoked: lease.revoked === true },
  });

  const grantLease = () => {
    lease = { id: randomUUID(), issuedAt: now(), expiresAt: now() + leaseTtlMs, revoked: false };
    writeEvent({ event: 'lease-granted', seq: ++seq, ...status() });
    return { ...lease };
  };

  const heartbeat = (leaseId) => {
    if (lease === null || lease.id !== leaseId || lease.revoked === true) {
      writeEvent({ event: 'heartbeat-rejected', seq: ++seq, leaseId: String(leaseId) });
      return { ok: false, reason: 'LEASE_UNKNOWN' };
    }
    lease.expiresAt = now() + leaseTtlMs;
    writeEvent({ event: 'heartbeat', seq: ++seq, leaseId: lease.id, expiresAt: lease.expiresAt, used });
    return { ok: true, expiresAt: lease.expiresAt };
  };

  const revoke = (reason) => {
    if (lease !== null) lease.revoked = true;
    permanentRevoke = true;
    writeEvent({ event: 'lease-revoked', seq: ++seq, reason: reason || 'MANUAL' });
    return status();
  };

  // 挂载证明：宿主启动即发首个请求时，启动器还来不及读到心跳并发租约。
  // 因此把"插件已在本次会话挂载成功"的证据交给闸门自己判断：无租约时同步读心跳文件，
  // 只有看到新鲜 mounted 事件才当场授权；同一事件只消费一次，撤销后不再重新授权。
  const tryMountGrant = () => {
    if (mountProof === null || permanentRevoke) return false;
    if (lease !== null && lease.revoked === true) return false;
    const mounted = readLastEvent(mountProof.eventLog, ['mounted']);
    if (mounted === null) return false;
    const at = Date.parse(mounted.at);
    if (!Number.isFinite(at)) return false;
    const age = now() - at;
    if (age < -5_000 || age > mountMaxAgeMs) return false;
    if (mountConsumedAt === mounted.at) return false;
    mountConsumedAt = mounted.at;
    lease = { id: randomUUID(), issuedAt: now(), expiresAt: now() + leaseTtlMs, revoked: false };
    writeEvent({ event: 'lease-from-mount', seq: ++seq, mountedAt: mounted.at, ...status() });
    return true;
  };

  const respondJson = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-tla-gate': 'denied' });
    res.end(text);
  };

  const handleControl = (req, res, pathname) => {
    const remote = req.socket.remoteAddress || '';
    if (!isLoopbackHost(remote)) {
      respondJson(res, 403, { error: { code: 'GATE_CONTROL_LOCAL_ONLY' } });
      return true;
    }
    if (pathname === '/__tla/gate/status' && req.method === 'GET') {
      respondJson(res, 200, status());
      return true;
    }
    if (pathname === '/__tla/gate/lease' && req.method === 'POST') {
      if (closing) {
        respondJson(res, 409, { error: { code: 'GATE_CLOSING' } });
        return true;
      }
      const granted = grantLease();
      respondJson(res, 200, { ok: true, lease: granted, status: status() });
      return true;
    }
    if (pathname === '/__tla/gate/heartbeat' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let leaseId = null;
        try {
          leaseId = JSON.parse(body || '{}').leaseId;
        } catch (_bad) {
          leaseId = null;
        }
        respondJson(res, 200, { ok: true, heartbeat: heartbeat(leaseId) });
      });
      return true;
    }
    if (pathname === '/__tla/gate/revoke' && req.method === 'POST') {
      respondJson(res, 200, { ok: true, status: revoke('CONTROL') });
      return true;
    }
    return false;
  };

  const forward = (req, res, body) => {
    const target = new URL(upstream.href);
    target.pathname = req.url.startsWith('/') ? req.url : '/' + req.url;
    const headers = { ...req.headers, host: target.host };
    const upstreamReq = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: target.pathname,
        headers,
        timeout: 120_000,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (error) => {
      writeEvent({ event: 'upstream-error', seq: ++seq, message: String(error && error.message) });
      if (!res.headersSent) respondJson(res, 502, { error: { code: 'GATE_UPSTREAM_ERROR', detail: String(error && error.message) } });
      else res.end();
    });
    upstreamReq.end(body);
  };

  const server_ = createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname.startsWith('/__tla/gate/')) {
      if (!handleControl(req, res, pathname)) respondJson(res, 404, { error: { code: 'GATE_CONTROL_UNKNOWN', pathname } });
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let reason = denyReason();
      if (reason === 'NO_LEASE' && tryMountGrant()) reason = denyReason();
      if (reason !== null) {
        rejected += 1;
        deniedByReason[reason] += 1;
        writeEvent({ event: 'denied', seq: ++seq, reason, path: pathname, used, remaining: remaining(), bytes: body.length });
        respondJson(res, 403, {
          error: {
            type: 'tla_gate_denied',
            code: 'TLA_GATE_DENIED',
            reason,
            used,
            limit: modelRequests,
            remaining: remaining(),
            hint: '预算闸门未授权本次请求；这不是模型端错误，请先确认保护机制已生效。',
          },
        });
        return;
      }
      used += 1;
      writeEvent({ event: 'allowed', seq: ++seq, path: pathname, used, remaining: remaining(), bytes: body.length });
      forward(req, res, body);
    });
  });

  return {
    async listen(port = 0, host = '127.0.0.1') {
      if (!isLoopbackHost(host)) throw new GateError('GATE_BIND_NOT_LOOPBACK', '闸门只能绑定回环地址，收到：' + host);
      await new Promise((resolve, reject) => {
        server_.once('error', reject);
        server_.listen(port, host, resolve);
      });
      server = server_;
      const address = server.address();
      baseUrl = 'http://' + (address.family === 'IPv6' ? '[' + address.address + ']' : address.address) + ':' + address.port;
      writeEvent({ event: 'listening', seq: ++seq, baseUrl, upstream: upstream.href, limit: modelRequests, leaseTtlMs });
      return { baseUrl, port: address.port };
    },
    get baseUrl() {
      return baseUrl;
    },
    status,
    grantLease,
    heartbeat,
    revoke,
    async close() {
      closing = true;
      if (server === null) return;
      await new Promise((resolve) => server.close(resolve));
      server = null;
      writeEvent({ event: 'closed', seq: ++seq, ...status() });
    },
  };
}
