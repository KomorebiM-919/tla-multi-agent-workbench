// tests/checkout-fidelity-cli.test.mjs
//
// 回归：`tools/check-checkout-fidelity.mjs` 的主模块判断。
//
// 2026-11-01 把仓库迁到含空格的路径（`E:\AI\DSH Workplace\...`）后，工具用
// `'file:///' + process.argv[1].replace(...)` 手工拼 URL 再与 `import.meta.url` 比较。
// `import.meta.url` 会把空格编码成 `%20`，手工拼出来的没有编码，二者永不相等，于是
// `main()` 根本不执行：进程 exit 0、没有任何输出——一个看起来通过的假阳性。
//
// 因此这里必须起真实 CLI 子进程；只 import 导出函数会绕过主模块判断，正是缺陷所在。
// 沙箱不允许管道捕获子进程输出，所以 stdout/stderr 重定向到文件再读回
// （与 tests/preflight-script.test.mjs 的 runTool 相同）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOL = join(REPO_ROOT, 'tools', 'check-checkout-fidelity.mjs');
const WORK = join(REPO_ROOT, 'tests', '.scratch', 'checkout-fidelity-cli');
const EXPECTED_DIGEST = '54f1a8e32f717f52d563ba368713c744c3bde486afeb3f3d133052a0a027e43d';

let counter = 0;

/** 起真实 CLI 子进程，输出落文件（沙箱禁止管道捕获）。 */
function runCli(args) {
  mkdirSync(WORK, { recursive: true });
  counter += 1;
  const outFile = join(WORK, 'cli-out-' + counter + '.txt');
  const errFile = join(WORK, 'cli-err-' + counter + '.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [TOOL].concat(args), {
      cwd: REPO_ROOT,
      stdio: ['ignore', outFd, errFd],
      timeout: 180000
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status: result.status,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8')
  };
}

test('the repository path really contains a space (otherwise this regression proves nothing)', () => {
  assert.ok(REPO_ROOT.includes(' '), '仓库根不含空格，主模块判断的缺陷无法复现：' + REPO_ROOT);
});

test('CLI runs main() under a space-containing path and returns a valid success result', () => {
  const outcome = runCli(['--json']);
  assert.equal(outcome.status, 0, 'exit ' + outcome.status + ' · stderr=' + outcome.stderr.slice(0, 400));
  assert.notEqual(outcome.stdout.trim(), '',
    'CLI 没有任何输出：主模块判断没有执行（静默 no-op），不能算通过');
  const report = JSON.parse(outcome.stdout);
  assert.equal(report.schema, 'tla.checkout-fidelity/v1');
  assert.equal(report.ok, true, 'FIDELITY 未通过：' + JSON.stringify(report.problems));
  assert.equal(report.digest, EXPECTED_DIGEST);
  assert.equal(report.expected, EXPECTED_DIGEST);
  assert.equal(report.fileCount, 3);
  assert.deepEqual(report.crlf, []);
  assert.deepEqual(report.files.map((file) => file.path).sort(),
    ['index.js', 'lib/budget.mjs', 'package.json']);
  for (const file of report.files) {
    assert.equal(file.carriageReturns, false, file.path + ' 含 CR 字节');
  }
});

test('an unknown argument exits non-zero with a diagnostic instead of a silent success', () => {
  const outcome = runCli(['--frobnicate']);
  assert.equal(outcome.status, 2, 'stderr=' + outcome.stderr.slice(0, 400));
  assert.match(outcome.stderr, /unknown argument: --frobnicate/u);
  assert.equal(outcome.stdout.trim(), '');
});

test('--repo without a value exits non-zero with a diagnostic', () => {
  const outcome = runCli(['--repo']);
  assert.equal(outcome.status, 2, 'stderr=' + outcome.stderr.slice(0, 400));
  assert.match(outcome.stderr, /--repo needs a path/u);
  assert.equal(outcome.stdout.trim(), '');
});
