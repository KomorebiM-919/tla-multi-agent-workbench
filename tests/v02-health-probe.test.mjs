/**
 * Health classification is the difference between "nothing is listening" and
 * "something answered that is not ours". Treating both as "belongs to another
 * run: undefined" is how the fourth attempt's report became misleading.
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import {
  HEALTH_BLOCKER_CODES,
  HEALTH_STATUSES,
  describeHealth,
  probeUpstreamHealth
} from '../tools/health-probe.mjs';

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.log('not ok: ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

function listen(handler) {
  return new Promise((resolvePromise) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ server, port: server.address().port });
    });
  });
}

function close(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function closedPort() {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

const ok = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, runId: 'run-ok', pid: process.pid }));
});
let result = await probeUpstreamHealth('http://127.0.0.1:' + ok.port + '/health', { expectedRunId: 'run-ok' });
check('healthy upstream is ok', result.status === 'ok', result.status);
check('healthy upstream reports the observed run id', result.observedRunId === 'run-ok', String(result.observedRunId));
check('healthy upstream records the http status', result.httpStatus === 200, String(result.httpStatus));

const mismatch = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, runId: 'someone-else' }));
});
result = await probeUpstreamHealth('http://127.0.0.1:' + mismatch.port + '/health', { expectedRunId: 'run-ok' });
check('a different run id is a mismatch, not a generic failure', result.status === 'run-mismatch', result.status);
check('mismatch keeps the observed run id', result.observedRunId === 'someone-else', String(result.observedRunId));
check('mismatch names both runs', result.detail.includes('someone-else') && result.detail.includes('run-ok'), result.detail);

const missing = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
result = await probeUpstreamHealth('http://127.0.0.1:' + missing.port + '/health', { expectedRunId: 'run-ok' });
check('a body without runId is missing-run-id', result.status === 'missing-run-id', result.status);
check('missing runId does not invent one', result.observedRunId === null, String(result.observedRunId));

const notJson = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html>not json</html>');
});
result = await probeUpstreamHealth('http://127.0.0.1:' + notJson.port + '/health');
check('a non-JSON answer is invalid-json', result.status === 'invalid-json', result.status);

const http500 = await listen((req, res) => {
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('boom');
});
result = await probeUpstreamHealth('http://127.0.0.1:' + http500.port + '/health');
check('a 5xx answer is http-error', result.status === 'http-error', result.status);
check('http-error keeps the status code', result.httpStatus === 500, String(result.httpStatus));

const notOk = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, runId: 'run-ok' }));
});
result = await probeUpstreamHealth('http://127.0.0.1:' + notOk.port + '/health', { expectedRunId: 'run-ok' });
check('ok:false is an invalid body', result.status === 'invalid-body', result.status);

const port = await closedPort();
result = await probeUpstreamHealth('http://127.0.0.1:' + port + '/health', { expectedRunId: 'run-ok' });
check('a closed port is connect-failed', result.status === 'connect-failed', result.status);
check('connect-failed leaves the run id unknown', result.observedRunId === null, String(result.observedRunId));
check('connect-failed does not claim the upstream belongs to another run', !result.detail.includes('belongs to run'), result.detail);

const slow = await listen(() => { /* never answers */ });
result = await probeUpstreamHealth('http://127.0.0.1:' + slow.port + '/health', { timeoutMs: 150 });
check('a silent server is a timeout', result.status === 'timeout', result.status);

check('every blocking status has a launcher code', HEALTH_BLOCKING_STATUSES().every((status) => typeof HEALTH_BLOCKER_CODES[status] === 'string'));
check('run-mismatch keeps its own code', HEALTH_BLOCKER_CODES['run-mismatch'] === 'UPSTREAM_RUN_MISMATCH');
check('connect-failed maps to unreachable', HEALTH_BLOCKER_CODES['connect-failed'] === 'UPSTREAM_UNREACHABLE');
check('the ok status has no blocker code', HEALTH_BLOCKER_CODES.ok === undefined);

const description = describeHealth({ status: 'connect-failed', detail: 'could not connect', observedRunId: null });
check('describeHealth never prints undefined', !description.includes('undefined'), description);
check('describeHealth states the status', description.startsWith('connect-failed:'), description);

for (const { server } of [ok, mismatch, missing, notJson, http500, notOk, slow]) {
  await close(server);
}

console.log('v02-health-probe: ' + checks + ' checks, ' + failures + ' failures');
process.exit(failures === 0 ? 0 : 1);

function HEALTH_BLOCKING_STATUSES() {
  return HEALTH_STATUSES.filter((status) => status !== 'ok');
}
