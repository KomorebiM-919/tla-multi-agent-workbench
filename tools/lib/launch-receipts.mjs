// B0 launch receipts: strict, dependency-free record construction and validation.
// A receipt is local correlation evidence, not authentication.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';

export const RUNNER_RECEIPT_SCHEMA = 'tla.runner-launch-receipt/v1';
export const GATE_RECEIPT_SCHEMA = 'tla.gate-launch-receipt/v1';
export const RECEIPT_ORIGINS = Object.freeze(['local-runtime', 'simulated']);
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function isPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function newLaunchId() {
  return randomUUID();
}

export function invocationDigest(command, args) {
  if (typeof command !== 'string' || command === '' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('invocation digest needs a command string and string args');
  }
  return createHash('sha256').update(JSON.stringify({ command, args })).digest('hex');
}

export function runnerReceipt({ runnerRunId, launchId, state, launcherPid, command, args, origin = 'local-runtime' }) {
  if (!isId(runnerRunId)) throw new Error('runnerRunId is invalid');
  if (!isUuid(launchId)) throw new Error('launchId is invalid');
  if (state !== 'spawned' && state !== 'spawn-failed') throw new Error('state is invalid');
  if (state === 'spawned' ? !isPid(launcherPid) : launcherPid !== null) throw new Error('launcherPid/state mismatch');
  if (!RECEIPT_ORIGINS.includes(origin)) throw new Error('origin is invalid');
  return {
    schema: RUNNER_RECEIPT_SCHEMA,
    origin,
    runnerRunId,
    launchId,
    state,
    launcherPid,
    launcherInvocationSha256: invocationDigest(command, args)
  };
}

export function gateReceipt({ runnerRunId, launchId, gateRunId, budgetRunId, command, args, origin = 'local-runtime' }) {
  if (!isId(runnerRunId) || !isUuid(launchId) || !isId(gateRunId) || !isId(budgetRunId)) {
    throw new Error('gate receipt identity is invalid');
  }
  if (!RECEIPT_ORIGINS.includes(origin)) throw new Error('origin is invalid');
  return {
    schema: GATE_RECEIPT_SCHEMA,
    origin,
    runnerRunId,
    launchId,
    launcherPid: process.pid,
    launcherInvocationSha256: invocationDigest(command, args),
    gateRunId,
    budgetRunId
  };
}

function exact(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

export function validateRunnerReceipt(value) {
  exact(value, ['schema', 'origin', 'runnerRunId', 'launchId', 'state', 'launcherPid', 'launcherInvocationSha256'], 'runner receipt');
  if (value.schema !== RUNNER_RECEIPT_SCHEMA) throw new Error('runner receipt schema is unsupported');
  if (!RECEIPT_ORIGINS.includes(value.origin)) throw new Error('runner receipt origin is invalid');
  if (!isId(value.runnerRunId) || !isUuid(value.launchId)) throw new Error('runner receipt identity is invalid');
  if (value.state !== 'spawned' && value.state !== 'spawn-failed') throw new Error('runner receipt state is invalid');
  if (value.state === 'spawned' ? !isPid(value.launcherPid) : value.launcherPid !== null) {
    throw new Error('runner receipt pid/state mismatch');
  }
  if (!isHash(value.launcherInvocationSha256)) throw new Error('runner receipt invocation digest is invalid');
  return value;
}

export function validateGateReceipt(value) {
  exact(value, ['schema', 'origin', 'runnerRunId', 'launchId', 'launcherPid', 'launcherInvocationSha256', 'gateRunId', 'budgetRunId'], 'gate receipt');
  if (value.schema !== GATE_RECEIPT_SCHEMA) throw new Error('gate receipt schema is unsupported');
  if (!RECEIPT_ORIGINS.includes(value.origin)) throw new Error('gate receipt origin is invalid');
  if (!isId(value.runnerRunId) || !isUuid(value.launchId) || !isId(value.gateRunId) || !isId(value.budgetRunId)) {
    throw new Error('gate receipt identity is invalid');
  }
  if (!isPid(value.launcherPid)) throw new Error('gate receipt pid is invalid');
  if (!isHash(value.launcherInvocationSha256)) throw new Error('gate receipt invocation digest is invalid');
  return value;
}

export function parseReceipt(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt must be an object');
  if (value.schema === RUNNER_RECEIPT_SCHEMA) return { kind: 'runner', value: validateRunnerReceipt(value) };
  if (value.schema === GATE_RECEIPT_SCHEMA) return { kind: 'gate', value: validateGateReceipt(value) };
  throw new Error('receipt schema is unsupported');
}

export function writeReceiptExclusive(path, value) {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return path;
}

export function receiptPathInside(file, runDir) {
  const absolute = resolve(file);
  const root = resolve(runDir);
  const rel = relative(root, absolute);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function joinReceipts(runner, gate) {
  const problems = [];
  if (runner.state !== 'spawned') problems.push('RUNNER_RECEIPT_NOT_SPAWNED');
  if (runner.origin === 'simulated' || gate.origin === 'simulated') problems.push('RECEIPT_SIMULATED');
  if (runner.origin !== gate.origin) problems.push('RECEIPT_ORIGIN_MISMATCH');
  for (const key of ['runnerRunId', 'launchId', 'launcherPid', 'launcherInvocationSha256']) {
    if (runner[key] !== gate[key]) problems.push(`RECEIPT_${key.toUpperCase()}_MISMATCH`);
  }
  if (gate.gateRunId !== gate.budgetRunId) problems.push('GATE_BUDGET_ID_CONFLICT');
  return { ok: problems.length === 0, problems };
}
