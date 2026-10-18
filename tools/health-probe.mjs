/**
 * Classify what the fake upstream actually answered before a host is allowed
 * to start.
 *
 * The launcher used to collapse every failure into one string and then attach
 * `runId: undefined` to it, which read like "this upstream belongs to another
 * run" even when nothing answered at all. Each outcome below is a distinct
 * fact, so a reviewer can tell "nothing is listening" from "something is
 * listening that is not ours".
 */
export const HEALTH_SCHEMA = 'tla.upstream-health/v1';

export const HEALTH_STATUSES = Object.freeze([
  'ok',
  'connect-failed',
  'timeout',
  'http-error',
  'invalid-json',
  'invalid-body',
  'missing-run-id',
  'run-mismatch'
]);

/** Statuses that mean "the upstream is not this run's service". */
export const HEALTH_BLOCKING_STATUSES = Object.freeze(
  HEALTH_STATUSES.filter((status) => status !== 'ok')
);

const DEFAULT_TIMEOUT_MS = 3_000;

function errorCode(error) {
  const cause = error === null || error === undefined ? null : error.cause;
  if (cause !== null && cause !== undefined && typeof cause.code === 'string') return cause.code;
  if (error !== null && error !== undefined && typeof error.code === 'string') return error.code;
  return null;
}

function isTimeout(error) {
  const name = error === null || error === undefined ? '' : String(error.name);
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const causeName = error !== null && error !== undefined && error.cause !== null && error.cause !== undefined
    ? String(error.cause.name)
    : '';
  return causeName === 'TimeoutError' || causeName === 'AbortError';
}

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error';
  const code = errorCode(error);
  const message = typeof error.message === 'string' ? error.message : String(error);
  return code === null ? message : code + ': ' + message;
}

/**
 * @param {string} healthUrl
 * @param {{expectedRunId?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 */
export async function probeUpstreamHealth(healthUrl, options = {}) {
  const expectedRunId = options.expectedRunId;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  const startedAt = Date.now();
  const base = {
    schema: HEALTH_SCHEMA,
    healthUrl,
    expectedRunId: expectedRunId === undefined ? null : expectedRunId,
    observedRunId: null,
    httpStatus: null,
    elapsedMs: 0
  };
  const finish = (status, detail, extra = {}) => ({
    ...base,
    ...extra,
    status,
    detail,
    elapsedMs: Date.now() - startedAt
  });

  let response;
  try {
    response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (isTimeout(error)) {
      return finish('timeout', 'no answer within ' + String(timeoutMs) + ' ms (' + describeError(error) + ')');
    }
    return finish('connect-failed', 'could not connect to ' + healthUrl + ' (' + describeError(error) + ')');
  }

  if (response.ok !== true) {
    return finish('http-error', 'health endpoint answered HTTP ' + String(response.status), { httpStatus: response.status });
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    return finish('invalid-json', 'health endpoint did not return JSON (' + describeError(error) + ')', { httpStatus: response.status });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return finish('invalid-body', 'health body is not a JSON object', { httpStatus: response.status });
  }
  if (body.ok !== true) {
    return finish('invalid-body', 'health body did not report ok: true', { httpStatus: response.status });
  }
  if (typeof body.runId !== 'string' || body.runId === '') {
    return finish('missing-run-id', 'health body has no runId string', { httpStatus: response.status });
  }
  if (expectedRunId !== undefined && body.runId !== expectedRunId) {
    return finish(
      'run-mismatch',
      'upstream belongs to run "' + body.runId + '", not "' + expectedRunId + '"',
      { httpStatus: response.status, observedRunId: body.runId }
    );
  }
  return finish('ok', 'upstream answered as run "' + body.runId + '"', { httpStatus: response.status, observedRunId: body.runId });
}

/** Blocker code the launcher reports for a non-ok health status. */
export const HEALTH_BLOCKER_CODES = Object.freeze({
  'connect-failed': 'UPSTREAM_UNREACHABLE',
  'timeout': 'UPSTREAM_TIMEOUT',
  'http-error': 'UPSTREAM_HTTP_ERROR',
  'invalid-json': 'UPSTREAM_INVALID_JSON',
  'invalid-body': 'UPSTREAM_INVALID_JSON',
  'missing-run-id': 'UPSTREAM_RUN_ID_MISSING',
  'run-mismatch': 'UPSTREAM_RUN_MISMATCH'
});

/** Human-readable line that never invents a run id it did not read. */
export function describeHealth(health) {
  if (health === null || health === undefined) return 'no health result';
  const observed = health.observedRunId === null || health.observedRunId === undefined
    ? null
    : health.observedRunId;
  const parts = [health.status + ': ' + health.detail];
  if (observed !== null) parts.push('observed runId ' + observed);
  return parts.join('; ');
}
