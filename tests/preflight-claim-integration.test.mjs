// tests/preflight-claim-integration.test.mjs
//
// 预检认领门禁的**集成测试**：不使用手工拼写的认领结果，而是真的调用
// tools/claim_evidence_dir.py，把它打印的 JSON 原样接入编排层预检返回值，再看门禁放行还是拒绝。
//
// 覆盖（复审要求二）：
//   1. 首次认领成功（工具真实退出码 0）→ 预检通过、运行一路走到成功；
//   2. 重复认领被工具拒绝（退出码 10）→ 门禁拒绝，且既有认领文件逐字节不变；
//   3. 目录非空且无认领文件（退出码 11）→ 拒绝，且失败路径不写任何文件（尤其不写 preflight.json）；
//   4. 已存在但为空的目录可被认领（认领前状态 empty）；
//   5. 预检自报的认领前状态与工具回报的 evidence_dir_state_before 不一致 → EVIDENCE_NOT_CLAIMED；
//   6. 证据目录路径**含空格**时同样能被认领并跑完整条流水线（参数数组传参，不经过 shell 拼接）。
//
// 子进程的启动方式（复审修正）：直接执行 Python 解释器、参数以**数组**传入，子进程输出写进**已打开的文件句柄**。
// 早期版本把命令拼成一个字符串交给 shell（`shell: true` 加 `> out 2> err` 重定向），它在审查环境里以
// 0xC0000005 崩溃，而且路径含空格时会被 shell 拆成多个参数；现在不经过 shell，路径原样作为单个参数传递。
// 之所以用文件句柄而不是管道捕获：DSH 文件沙箱下 Node 捕获子进程 stdout/stderr（管道）会 EPERM，
// 文件句柄不经过管道，因此可用。
//
// 运行：node tests/preflight-claim-integration.test.mjs

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT, TARGET_DIR, setClock, makeRunner, preflightOk, happyPlan, baseArgs,
  requirementOk, codingOk, verifyOk, reviewOk
} from './workflow-harness.mjs';

const runner = makeRunner();
const scenario = runner.scenario;

const REPO_ROOT_REAL = realpathSync(REPO_ROOT).replace(/\\/g, '/');
const SCRATCH = path.join(REPO_ROOT, 'tests', '.scratch');
const RUNNER_DIR = path.join(SCRATCH, 'claim-integration-' + process.pid);
const CLAIM_TOOL = 'tools/claim_evidence_dir.py';
const MARKER_NAME = '.run-owner.json';

let redirectSeq = 0;
const createdDirs = [];

function sceneDir(rel) {
  return path.join(REPO_ROOT, rel);
}

/**
 * 解析出可直接执行的 Python 3 解释器路径。
 * 不走 shell、也不用管道读版本（沙箱下管道会 EPERM）：逐个候选路径用 stdio: 'ignore' 试跑一次。
 * 跳过 Windows 的 `Microsoft\WindowsApps\python.exe`——那是应用商店别名占位程序，不是真解释器。
 * 需要指定别的解释器时设置环境变量 TLA_PYTHON。
 */
function resolvePython() {
  const isWindows = process.platform === 'win32';
  const names = isWindows ? ['python'] : ['python3', 'python'];
  const exts = isWindows ? ['.exe'] : [''];
  const candidates = [];
  if (process.env.TLA_PYTHON) { candidates.push(process.env.TLA_PYTHON); }
  String(process.env.PATH || '').split(path.delimiter).forEach(function (entry) {
    const dir = entry.replace(/^"|"$/g, '').trim();
    if (dir === '' || /WindowsApps/i.test(dir)) { return; }
    names.forEach(function (name) {
      exts.forEach(function (ext) { candidates.push(path.join(dir, name + ext)); });
    });
  });
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!existsSync(candidate)) { continue; }
    const probe = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)'],
      { stdio: 'ignore' });
    if (probe.error === undefined && probe.status === 0) { return candidate; }
  }
  throw new Error('找不到可用的 Python 3 解释器；请用环境变量 TLA_PYTHON 指定 python 可执行文件（例如 C:\\...\\python.exe）');
}

const PYTHON = resolvePython();
console.log('认领工具调用方式：直接执行 ' + PYTHON + '（参数数组 + 已打开的文件句柄，不经过 shell）');

/**
 * 运行真实的认领工具（本轮运行期间最后一次写入的现场都留在 RUNNER_DIR，便于事后核对）。
 * 参数以**数组**传入、输出写进**已打开的文件句柄**，全程不经过 shell：含空格的路径不会被拆开。
 */
function runClaimTool(evidenceDirRel, runId, runStartedAt, claimedBy, outDir) {
  const dir = outDir || RUNNER_DIR;
  mkdirSync(dir, { recursive: true });
  redirectSeq += 1;
  const outFile = path.join(dir, 'stdout-' + redirectSeq + '.json');
  const errFile = path.join(dir, 'stderr-' + redirectSeq + '.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let spawned = null;
  try {
    spawned = spawnSync(PYTHON, [CLAIM_TOOL,
      '--repo-root', '.',
      '--evidence-dir', evidenceDirRel,
      '--run-id', runId,
      '--run-started-at', runStartedAt,
      '--claimed-by', claimedBy],
    { cwd: REPO_ROOT, stdio: ['ignore', outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const raw = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  let payload = null;
  try { payload = JSON.parse(raw); } catch (error) { payload = null; }
  return {
    exitCode: spawned.status,
    payload: payload,
    raw: raw,
    stderr: existsSync(errFile) ? readFileSync(errFile, 'utf8') : '',
    spawnError: spawned.error
  };
}

/** 本次测试运行的身份：runId 以真实 UTC 时间戳结尾，且与 runStartedAt 同秒（编排层的原子防覆盖要求）。 */
function newRunIdentity(label) {
  const nowMs = Date.now();
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return {
    nowMs: nowMs,
    runId: 'it-claim-' + label + '-' + randomUUID().slice(0, 8) + '-' + stamp,
    runStartedAt: new Date(nowMs).toISOString()
  };
}

function sha256File(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * 用认领工具的真实输出拼出预检返回值。所有认领相关字段都来自工具（不是手写的），
 * 只有仓库根/交付目录这些预检自己要解算的字段才由测试按配置推导。
 */
function preflightFromTool(evidenceDirRel, payload, over) {
  const claimState = String(payload.evidence_dir_state_before || 'missing');
  const claimPayload = {
    evidence_dir_state: claimState,
    evidence_dir_state_before: claimState,
    evidence_dir_realpath: String(payload.evidence_dir_realpath || '').replace(/\\/g, '/'),
    evidence_dir_claimed: payload.claim_created === true,
    owner_marker_path: payload.owner_marker_path || (evidenceDirRel + '/' + MARKER_NAME),
    claim_tool: payload.claim_tool,
    claim_created: payload.claim_created === true,
    claim_exit_code: payload.claim_exit_code,
    claimed_at: typeof payload.claimed_at === 'string' ? payload.claimed_at : '',
    generated_at: new Date().toISOString(), // 预检发生在"现在"，固定夹具时间会落在运行窗口之外
    repo_root: REPO_ROOT,
    repo_root_realpath: REPO_ROOT_REAL,
    target_dir_realpath: REPO_ROOT_REAL + '/' + TARGET_DIR,
    problems: []
  };
  const problems = over && over.problems ? over.problems : [];
  return preflightOk(Object.assign(claimPayload, { problems: problems }, over || {}));
}

/** 给集成场景用的工作流参数：runId 末段必须等于 evidenceDir 末段，runStartedAt 与 runId 同秒。 */
function integrationArgs(identity, evidenceDirRel) {
  return baseArgs({ runId: identity.runId, evidenceDir: evidenceDirRel, runStartedAt: identity.runStartedAt });
}

function setupScene(label, parentName) {
  const identity = newRunIdentity(label);
  // 证据目录必须落在 docs/evidence/ 之下，且最后一级目录必须等于 runId（编排层两条硬要求）；
  // 中间父目录的名字不受限制，这里用它来验证"路径含空格"。
  const parent = parentName || ('itest-claim-' + process.pid);
  const evidenceDirRel = 'docs/evidence/' + parent + '/' + identity.runId;
  createdDirs.push(sceneDir(evidenceDirRel));
  createdDirs.push(path.join(REPO_ROOT, 'docs', 'evidence', parent));
  return { identity: identity, evidenceDirRel: evidenceDirRel };
}

/**
 * 集成场景用的是**真实当前时间**（认领工具写的是真实时钟），夹具里固定的 NOW 会落在运行窗口之外，
 * 因此每个阶段的 generated_at 都改成"此刻"。除此之外与 happyPlan 完全相同。
 */
function livePlan(over) {
  const stamp = function () { return new Date().toISOString(); };
  const plan = {
    requirement: function () { const r = requirementOk(3); r.generated_at = stamp(); return r; },
    coding: function () { const r = codingOk(); r.generated_at = stamp(); return r; },
    verify: function () { const r = verifyOk(); r.generated_at = stamp(); return r; },
    review: function () { const r = reviewOk(); r.generated_at = stamp(); return r; }
  };
  return happyPlan(Object.assign(plan, over || {}));
}

// ---------------------------------------------------------------- 场景

if (!existsSync(RUNNER_DIR)) { mkdirSync(RUNNER_DIR, { recursive: true }); }

// 场景 1：工具首次认领成功 → 预检放行 → 整个运行成功
{
  const scene = setupScene('first');
  const claim = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt, 'integration-first');
  const marker = path.join(sceneDir(scene.evidenceDirRel), MARKER_NAME);
  const plan = livePlan({ preflight: function () { return preflightFromTool(scene.evidenceDirRel, claim.payload); } });
  setClock(scene.identity.nowMs);
  await scenario(
    '认领工具首次认领（真实退出码 0）→ 预检通过并跑完整条流水线',
    plan, integrationArgs(scene.identity, scene.evidenceDirRel),
    {
      status: 'OK', ok: true, calls: 5,
      extra: function (result, outcome, check) {
        check('认领工具退出码为 0', claim.exitCode === 0, '实际 ' + claim.exitCode + ' / stderr=' + claim.stderr);
        check('工具报告 claim_created=true', claim.payload.claim_created === true, JSON.stringify(claim.payload));
        check('工具报告 claim_exit_code=0', claim.payload.claim_exit_code === 0, JSON.stringify(claim.payload));
        check('工具报告的认领前状态是 missing', claim.payload.evidence_dir_state_before === 'missing',
          String(claim.payload.evidence_dir_state_before));
        check('认领文件已真实创建', existsSync(marker), marker);
        const claimFile = existsSync(marker) ? readJson(marker) : {};
        check('认领文件记录的 runId 与本次运行一致', claimFile.runId === scene.identity.runId, JSON.stringify(claimFile));
        check('认领文件记录的认领者是首次认领方', claimFile.claimedBy === 'integration-first', JSON.stringify(claimFile));
        const expectedReal = REPO_ROOT_REAL + '/' + scene.evidenceDirRel;
        check('工具独立解算的 realpath 与编排层推导一致',
          String(claim.payload.evidence_dir_realpath).replace(/\\/g, '/').toLowerCase() === expectedReal.toLowerCase(),
          String(claim.payload.evidence_dir_realpath));
        check('成功路径下证据目录里只有认领文件',
          JSON.stringify(readdirSync(sceneDir(scene.evidenceDirRel)).sort()) === JSON.stringify([MARKER_NAME]),
          readdirSync(sceneDir(scene.evidenceDirRel)).join(','));
      }
    },
    { resetClock: false }
  );
}

// 场景 2：重复认领被真实拒绝（退出码 10）→ 门禁拒绝，且既有认领逐字节不变
{
  const scene = setupScene('duplicate');
  const first = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt, 'integration-first');
  const marker = path.join(sceneDir(scene.evidenceDirRel), MARKER_NAME);
  const beforeHash = sha256File(marker);
  const beforeBytes = readFileSync(marker, 'utf8');
  const second = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt, 'integration-second');
  const args = integrationArgs(scene.identity, scene.evidenceDirRel);
  const plan = livePlan({ preflight: function () { return preflightFromTool(scene.evidenceDirRel, second.payload); } });
  setClock(scene.identity.nowMs);
  await scenario(
    '重复认领被工具拒绝（真实退出码 10）→ 门禁拒绝且已有认领字节不变',
    plan, args,
    {
      status: 'EVIDENCE_EXISTS', ok: false, calls: 1,
      extra: function (result, outcome, check) {
        check('第一次认领成功（退出码 0）', first.exitCode === 0, '实际 ' + first.exitCode);
        check('第二次认领退出码为 10', second.exitCode === 10, '实际 ' + second.exitCode);
        check('第二次没有报告 claim_created=true', second.payload.claim_created !== true, JSON.stringify(second.payload));
        check('认领文件哈希未被覆写', sha256File(marker) === beforeHash, beforeHash + ' -> ' + sha256File(marker));
        check('认领文件内容逐字节不变', readFileSync(marker, 'utf8') === beforeBytes, '内容被改写');
        check('认领者仍是首次认领方', readJson(marker).claimedBy === 'integration-first', JSON.stringify(readJson(marker)));
        check('被拒绝时证据目录里没有写入 preflight.json',
          !existsSync(path.join(sceneDir(scene.evidenceDirRel), 'preflight.json')),
          readdirSync(sceneDir(scene.evidenceDirRel)).join(','));
      }
    },
    { resetClock: false }
  );
}

// 场景 3：预检自报的认领前状态与工具回报不一致 → EVIDENCE_NOT_CLAIMED
{
  const scene = setupScene('state-mismatch');
  const first = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt, 'integration-first');
  const second = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt, 'integration-second');
  const plan = happyPlan({
    preflight: function () {
      // 工具说"认领前已经是存在且非空"（exists），预检却自报 missing：报告与工具结果对不上
      const built = preflightFromTool(scene.evidenceDirRel, second.payload);
      built.evidence_dir_state = 'missing';
      return built;
    }
  });
  setClock(scene.identity.nowMs);
  await scenario(
    '预检自报认领前状态与工具回报不一致 → EVIDENCE_NOT_CLAIMED',
    plan, integrationArgs(scene.identity, scene.evidenceDirRel),
    {
      status: 'EVIDENCE_NOT_CLAIMED', ok: false, calls: 1, errorIncludes: 'evidence_dir_state_before',
      extra: function (result, outcome, check) {
        check('工具第二次仍报告退出码 10', second.exitCode === 10, '实际 ' + second.exitCode);
        check('工具回报的认领前状态是 exists', second.payload.evidence_dir_state_before === 'exists',
          String(second.payload.evidence_dir_state_before));
        check('本次运行的证据目录里没有 preflight.json（认领失败不得写文件）',
          !existsSync(path.join(sceneDir(scene.evidenceDirRel), 'preflight.json')),
          readdirSync(sceneDir(scene.evidenceDirRel)).join(','));
      }
    },
    { resetClock: false }
  );
}

// 场景 4：目录非空且无认领文件 → 工具拒绝（退出码 11），不得写入任何文件
{
  const scene = setupScene('nonempty');
  const dir = sceneDir(scene.evidenceDirRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'junk.txt'), 'this directory already has content\n', 'utf8');
  const junkHash = sha256File(path.join(dir, 'junk.txt'));
  const claim = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt, 'integration-first');
  const plan = livePlan({ preflight: function () { return preflightFromTool(scene.evidenceDirRel, claim.payload); } });
  setClock(scene.identity.nowMs);
  await scenario(
    '证据目录非空且无认领文件（工具退出码 11）→ 门禁拒绝且不写任何文件',
    plan, integrationArgs(scene.identity, scene.evidenceDirRel),
    {
      status: 'EVIDENCE_EXISTS', ok: false, calls: 1,
      extra: function (result, outcome, check) {
        check('工具退出码为 11（目录非空）', claim.exitCode === 11, '实际 ' + claim.exitCode);
        check('没有创建认领文件', !existsSync(path.join(dir, MARKER_NAME)), readdirSync(dir).join(','));
        check('原目录内容未被改动', sha256File(path.join(dir, 'junk.txt')) === junkHash, 'junk.txt 被改写');
        check('失败路径下没有 preflight.json', !existsSync(path.join(dir, 'preflight.json')), readdirSync(dir).join(','));
        check('目录里仍然只有原来那个文件', JSON.stringify(readdirSync(dir).sort()) === JSON.stringify(['junk.txt']),
          readdirSync(dir).join(','));
      }
    },
    { resetClock: false }
  );
}

// 场景 5：已存在但为空的目录 → 工具可认领（认领前状态 empty）→ 放行
{
  const scene = setupScene('empty-dir');
  mkdirSync(sceneDir(scene.evidenceDirRel), { recursive: true });
  const claim = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt, 'integration-first');
  const plan = livePlan({ preflight: function () { return preflightFromTool(scene.evidenceDirRel, claim.payload); } });
  setClock(scene.identity.nowMs);
  await scenario(
    '已存在但为空的目录可被排他认领（工具报告 empty）→ 放行',
    plan, integrationArgs(scene.identity, scene.evidenceDirRel),
    {
      status: 'OK', ok: true, calls: 5,
      extra: function (result, outcome, check) {
        check('工具退出码为 0', claim.exitCode === 0, '实际 ' + claim.exitCode);
        check('工具回报的认领前状态是 empty', claim.payload.evidence_dir_state_before === 'empty',
          String(claim.payload.evidence_dir_state_before));
        check('认领文件已创建', existsSync(path.join(sceneDir(scene.evidenceDirRel), MARKER_NAME)), '未创建');
      }
    },
    { resetClock: false }
  );
}

// 场景 6：证据目录路径含空格 → 参数数组传参不经过 shell，认领与整条流水线照常成功
{
  const spaceParent = 'itest claim ' + process.pid;                                 // 父目录名含空格
  const spaceRunner = path.join(SCRATCH, 'claim integration runner ' + process.pid); // 输出文件也放在含空格路径下
  const scene = setupScene('space-path', spaceParent);
  const claim = runClaimTool(scene.evidenceDirRel, scene.identity.runId, scene.identity.runStartedAt,
    'integration-space', spaceRunner);
  const marker = path.join(sceneDir(scene.evidenceDirRel), MARKER_NAME);
  const plan = livePlan({ preflight: function () { return preflightFromTool(scene.evidenceDirRel, claim.payload); } });
  setClock(scene.identity.nowMs);
  await scenario(
    '证据目录路径含空格 → 认领工具与预检门禁照常放行（参数数组、不经过 shell）',
    plan, integrationArgs(scene.identity, scene.evidenceDirRel),
    {
      status: 'OK', ok: true, calls: 5,
      extra: function (result, outcome, check) {
        check('夹具本身确实含空格（防止空格被悄悄去掉）',
          scene.evidenceDirRel.indexOf(' ') !== -1 && spaceRunner.indexOf(' ') !== -1,
          scene.evidenceDirRel + ' / ' + spaceRunner);
        check('子进程启动没有异常（不经过 shell）', claim.spawnError === undefined,
          String(claim.spawnError && claim.spawnError.message));
        check('工具退出码为 0', claim.exitCode === 0, '实际 ' + claim.exitCode + ' / stderr=' + claim.stderr);
        check('工具报告的认领前状态是 missing',
          claim.payload !== null && claim.payload.evidence_dir_state_before === 'missing',
          String(claim.payload && claim.payload.evidence_dir_state_before));
        check('认领文件创建在含空格的路径下', existsSync(marker), marker);
        const expectedReal = REPO_ROOT_REAL + '/' + scene.evidenceDirRel;
        check('含空格路径的 realpath 与编排层推导一致',
          String(claim.payload.evidence_dir_realpath).replace(/\\/g, '/').toLowerCase() === expectedReal.toLowerCase(),
          String(claim.payload.evidence_dir_realpath));
        check('成功路径下证据目录里只有认领文件',
          JSON.stringify(readdirSync(sceneDir(scene.evidenceDirRel)).sort()) === JSON.stringify([MARKER_NAME]),
          readdirSync(sceneDir(scene.evidenceDirRel)).join(','));
      }
    },
    { resetClock: false }
  );
}

for (const dir of createdDirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch (error) { /* 清理失败不影响结论 */ }
}

runner.finish('预检认领门禁集成测试（真实认领工具 + 编排层门禁）');
