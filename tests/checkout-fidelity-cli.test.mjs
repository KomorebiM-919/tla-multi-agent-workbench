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
//
// 断言不能依赖"本仓库恰好被检出在含空格路径下"：换成无空格检出时缺陷无从复现，测试也
// 就失去了意义。这里每次运行都自建一个带空格的受控检出（git worktree + 工作区改动覆盖），
// 从夹具里跑真实 CLI，无论测试执行位置有没有空格都能覆盖到那段编码差异。
//
// 沙箱不允许管道捕获子进程输出，所以 stdout/stderr 重定向到文件再读回
// （与 tests/preflight-script.test.mjs 的 runTool 相同）；git 的 stdout 同样落文件。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH = join(REPO_ROOT, 'tests', '.scratch');
const TOOL_REL = join('tools', 'check-checkout-fidelity.mjs');
const EXPECTED_DIGEST = '54f1a8e32f717f52d563ba368713c744c3bde486afeb3f3d133052a0a027e43d';

let base = '';
let fixture = '';
let counter = 0;

/** 起 git 子进程，stdout/stderr 落文件（沙箱禁止管道捕获）。 */
function git(args, cwd, tag) {
  counter += 1;
  const outFile = join(base, tag + '-' + counter + '.out');
  const errFile = join(base, tag + '-' + counter + '.err');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync('git', args, {
      cwd,
      stdio: ['ignore', outFd, errFd],
      timeout: 120000
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status: result.status === null ? -1 : result.status,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8')
  };
}

/** 起真实 CLI 子进程；脚本与 `--repo` 都在带空格的夹具里。 */
function runCli(args) {
  counter += 1;
  const outFile = join(base, 'cli-out-' + counter + '.txt');
  const errFile = join(base, 'cli-err-' + counter + '.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [join(fixture, TOOL_REL)].concat(args), {
      cwd: fixture,
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

/**
 * 建立受控夹具：一个含空格的干净检出，再覆盖工作区里相对 HEAD 已改动的文件，
 * 保证被测到的是"本次待测版本"而不是偶发落后的 HEAD。
 */
function buildFixture() {
  // 路径刻意取短：夹具里还要再建一层工作树，检出时仓库里最深的一批路径
  // （如 docs/evidence/v0.1-approval-rejection-.../EVIDENCE-MANIFEST.json）加上
  // 夹具前缀就会撞上 Windows 的 260 字符上限，git 会以 exit 128 报 "Filename too long"。
  base = join(SCRATCH, 'cf-' + randomUUID().replace(/-/gu, '').slice(0, 8));
  const parent = join(base, 'with space');
  fixture = join(parent, 'repo');
  mkdirSync(parent, { recursive: true });

  const added = git(['worktree', 'add', '--detach', fixture, 'HEAD'], REPO_ROOT, 'worktree-add');
  assert.equal(added.status, 0, '无法建立夹具检出：' + added.stderr.slice(0, 400));

  const changed = git(['diff', '--name-only', '-z', 'HEAD'], REPO_ROOT, 'worktree-diff');
  assert.equal(changed.status, 0, '无法读出工作区改动：' + changed.stderr.slice(0, 400));
  for (const rel of changed.stdout.split('\0').filter(Boolean)) {
    const from = join(REPO_ROOT, rel);
    if (!existsSync(from)) continue; // 工作区已删除的文件保持删除
    const to = join(fixture, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

before(() => {
  buildFixture();
});

after(() => {
  if (fixture === '') return;
  git(['worktree', 'remove', '--force', fixture], REPO_ROOT, 'worktree-remove');
  // 先 prune 再删目录：prune 的 stdout/err 也落在 base 里，顺序颠倒会 ENOENT
  git(['worktree', 'prune'], REPO_ROOT, 'worktree-prune');
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

test('the fixture checkout path contains a space, so the entry guard sees %20', () => {
  assert.ok(fixture.includes(' '), '夹具路径不含空格，编码差异无从复现：' + fixture);
});

test('the fixture runs the tool version under test, not a stale HEAD copy', () => {
  assert.deepEqual(readFileSync(join(fixture, TOOL_REL)),
    readFileSync(join(REPO_ROOT, TOOL_REL)),
    '夹具里的工具与工作区不一致：被测版本不对');
});

test('CLI runs main() under a space-containing path and returns a valid success result', () => {
  const outcome = runCli(['--json', '--repo', fixture]);
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
