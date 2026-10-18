/**
 * TLA V0.1 — three-agent MVP workflow: Requirement -> Coding -> Review.
 *
 * 由 DSH 的 `workflow` 工具执行的 JavaScript 编排脚本（本文件内容即 tool 的 `script` 参数）。
 * 角色提示词存放在 `agents/*.md`，脚本不复制提示词，而是要求每个子代理先读取自己的角色文件。
 *
 * 真实子代理调用（每一次都是独立上下文、独立执行实例）：
 *   1. Verifier（MODE=preflight）  环境预检：证据目录未被占用、路径落在仓库内、提示词文件齐全
 *   2. Requirement Agent           结构化需求 + 验收/边界条件一致性自检
 *   3. Coding Agent                在交付目录内实现代码与测试，并真实运行测试
 *   4. Verifier（MODE=verify）     独立复跑规范化测试命令，回传原始输出与文件哈希
 *   5. Review Agent                独立上下文读代码、独立复跑测试、逐条判定验收条件
 *   6.. 修订轮重复 3/4/5，直到通过或达到 maxCodingAttempts
 *
 * 执行顺序与结果传递由本脚本的编排逻辑保证（顺序 await + 上一阶段结构化结果原样注入）；
 * `phase()` 只用于进度展示，不产生执行依赖（见 2026-10-16 架构审核意见四）。
 *
 * 成功判定（本脚本的计算逻辑，不依赖任何单个 Agent 的自述；见审核意见一、复审意见四、复审要求一至七）：
 *   ok = true 当且仅当全部成立：
 *     0. 环境预检：证据目录由本次运行**排他认领**（认领工具退出码 0、claim_created 为 true、owner marker 与本次
 *        runId 一致、工具自报的认领**前**状态 evidence_dir_state_before 与预检自报的 evidence_dir_state 一致且
 *        均为 missing / empty）、上报路径均已规范化且与本次配置目标一一对应、且 `problems` 为空（非空即终止）；
 *     A. 需求自检未报告冲突（consistency_check.conflicts 为空），且验收条件 ID 齐备、不重复；
 *     B. 任何阶段（Coding / Verifier / Review）都没有报告「未解决的需求冲突」（requirement_conflicts 非空即失败）；
 *     C. Coding Agent 的自述**内部自洽**（规范化命令、退出码为非负整数、test_succeeded 与退出码及输出摘录一致）；
 *     D. Verifier 回传的**原始输出**经本脚本解析为通过（退出码 0、`Ran N tests`（N ≥ 1）、`OK` 标记、无 FAILED，
 *        且 skipped 数小于 N —— `OK (skipped=N)` 表示一个用例都没真正执行，按未执行判失败）；
 *     E. Review 结论为 APPROVED，且其**自己的**复跑也真的执行了测试（N ≥ 1、不是全体 skipped）并与 Verifier 的用例数一致；
 *     F. Review 的 criteria_check 与需求的验收 ID 集合**逐项对应**：无缺失、无重复、无未知 ID，且逐条 satisfied === true；
 *     G. Verifier / Review 的 sha256 指纹清单**恰好**覆盖配置指定的交付文件（模块 + 测试）：缺项、无关文件、
 *        重复路径一律失败，且验证前后同一路径哈希一致。
 *   任一环节自述与外部证据矛盾 → 判定不通过（status = INCONSISTENT_EVIDENCE 等），进入修订流程，绝不放行。
 *   时间戳门禁：必须是真实存在的日历时间（2026-02-30 之类失败）+ 落在运行窗口内 + 不晚于编排层当前时间；
 *   runStartedAt（及其 runId 时间戳）与编排层时钟的偏差有上限，伪造/复用运行标识会被拒绝。
 *   时间戳比较使用**两个独立的时钟**：启动时钟只用于锚定 runId/runStartedAt 一次；此后每个 Agent 返回后
 *   重新读取当前时间作为"未来时间"的判定基准，避免长运行的判定基准过期（复审要求一）。
 *
 * args 契约（runId 必填；未提供 task.requirement 时运行仓库内置的演示任务）：
 * {
 *   "runId": "v0.1-run-20261016T123456Z",   // 必须以 -<UTC 紧凑时间戳> 结尾，并与 runStartedAt 表示同一秒
 *   "evidenceDir": "docs/evidence/v0.1-run-20261016T123456Z",
 *   "promptDir": "agents",
 *   "runStartedAt": "2026-10-16T20:34:56+08:00",
 *   "task": {
 *     "requirement": "<自然语言需求>",
 *     "targetDir": "examples/text-stats",
 *     "moduleFile": "text_stats.py",
 *     "testFile": "test_text_stats.py",
 *     "sampleFile": "sample_input.txt",
 *     "testCommand": "python -m unittest discover -s examples/text-stats -p \"test_*.py\"",
 *     "maxCodingAttempts": 2
 *   }
 * }
 *
 * 返回值：结构化运行结果（ok / status / 各阶段结构化输出 / 逐轮判定与原因），供编排代理归档与核验。
 */

// ================================================================ 参数解析与校验
// 纯函数区：不调用 agent()，由 tests/workflow-logic.test.mjs 用模拟返回值覆盖。

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// runId 必须以 -<UTC 紧凑时间戳>（YYYYMMDDTHHMMSSZ）结尾：把运行标识绑定到真实运行时间，
// 同一秒内不可能产生两个相同的 runId，从命名上消除"两次运行共用一个证据目录"的窗口。
const RUN_ID_STAMP_PATTERN = /^(.*[A-Za-z0-9])-(\d{8}T\d{6}Z)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CRITERIA_ID_PATTERN = /^\s*([A-Za-z]{2,8}-[A-Za-z0-9]{1,4})/;
const BASENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PY_MODULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*\.py$/;
const PY_TEST_PATTERN = /^test_[A-Za-z0-9_-]*\.py$/;
const TEST_COMMAND_PATTERN = /^python3? -m unittest discover -s [A-Za-z0-9._/-]+ -p "[A-Za-z0-9._*?-]+"( -v)?$/;
// 受控执行环境：必须与命令在**同一次进程调用**里设置。不能依赖宿主进程环境——
// 三个子代理各自是独立会话/进程，编排层里临时设置的变量不会传过去（v0.2-run1 的 AC-24 就是这样漏掉的）。
const TEST_ENV_VAR = 'PYTHONDONTWRITEBYTECODE';
const TEST_ENV_VALUE = '1';
// 前缀只设置这一个变量，然后紧接规范化命令本身：不接受任意 shell 片段。
const TEST_ENV_PREFIX = '$env:' + TEST_ENV_VAR + " = '" + TEST_ENV_VALUE + "'; ";
const CACHE_DIR_NAME = '__pycache__';
// 同一份缓存文件在两次观测之间允许的 mtime 偏差（毫秒）。它只吸收"同一个时间戳的不同数值表示"
// （Python 的 st_mtime 是浮点、幂等取整口径不同会得到 1792240028919 与 1792240028919.332 这样的值），
// 不吸收真实重写：真实的缓存重写要么改变 bytes/sha256，要么与上一次观测相隔远超该容差。
const MTIME_TOLERANCE_MS = 5;
const MAX_ATTEMPTS_LIMIT = 5;
// 子代理调用预算：一次运行最多**启动**多少个付费子代理会话。
// v0.2-run2 的批准上限是 8 次，实际启动了 10 次（每轮多一个 Cache Collector），
// 超出的 2 次同样是付费调用。这里的预算检查发生在**启动之前**：达到上限时不再启动第 N+1 次，
// 而不是运行结束才发现超支（事后计数无法阻止已经花掉的钱）。
const AGENT_CALL_BUDGET_DEFAULT = 8;
// 预算上限本身也有上限：允许配置预算不等于允许无限预算（避免把上限改成一个巨大数字绕过约束）。
const AGENT_CALL_BUDGET_LIMIT = 32;
// 两个限制的边界必须说清楚：编排层能硬限制"调用了几次"，限制不了"单次调用内部花了多少 token"。
const AGENT_CALL_BUDGET_LIMITS_NOTE = '调用次数可硬限制（启动前检查）；单个子代理内部的 token 消耗无法由编排层硬限制';
const EVIDENCE_ROOT = 'docs/evidence/';
// 证据目录认领必须由这个排他创建（O_EXCL）工具完成：预检子代理不得自己拼写认领文件（复审要求二）。
const EVIDENCE_CLAIM_TOOL = 'tools/claim_evidence_dir.py';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function hasText(v) { return typeof v === 'string' && v.trim().length > 0; }
function hasItems(v) { return Array.isArray(v) && v.length > 0; }
function isInteger(v) { return typeof v === 'number' && Number.isInteger(v); }
function asString(v) { return typeof v === 'string' ? v.trim() : ''; }

/**
 * 把 ISO-8601 时间转成 UTC 紧凑时间戳 `YYYYMMDDTHHMMSSZ`（用于把 runId 绑定到真实运行时间）。
 * 运行环境不提供 Date 时返回 null（调用方降级为"只校验格式"）。
 */
function toUtcStamp(value) {
  if (typeof Date !== 'function' || typeof Date.parse !== 'function') { return null; }
  const ms = Date.parse(asString(value));
  if (isNaN(ms)) { return null; }
  const d = new Date(ms);
  function pad(n, width) { return String(n).padStart(width, '0'); }
  return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2) +
    'T' + pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + pad(d.getUTCSeconds(), 2) + 'Z';
}

/** 反向操作：把 runId 里的紧凑 UTC 时间戳 `YYYYMMDDTHHMMSSZ` 还原成 ISO-8601；格式不符返回 null。 */
function fromUtcStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(asString(stamp));
  if (m === null) { return null; }
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + 'Z';
}

/** 闰年判定（不依赖 Date：日历合法性校验在任何运行环境都必须成立）。 */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 某年某月的天数（含闰年二月）。 */
function daysInMonth(year, month) {
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) { return 29; }
  return table[month - 1];
}

/**
 * 严格解析 ISO-8601 时间：格式、日历合法性（含闰年）、时区偏移范围必须全部成立。
 * 返回 `{ text, ms }`（运行环境不提供 Date 时 ms 为 null）；不合法返回 null。
 * 与简单的正则匹配的区别：正则只保证"长得像"，这里保证"确实是一个真实时间"
 * —— `2026-02-30T00:00:00Z`、`2026-13-01T00:00:00Z`、`...T25:00:00Z` 一律拒绝（复审要求五）。
 */
function parseIsoTimestamp(value) {
  const text = asString(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (m === null) { return null; }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = parseInt(m[6], 10);
  if (month < 1 || month > 12) { return null; }
  if (day < 1 || day > daysInMonth(year, month)) { return null; }
  if (hour > 23 || minute > 59 || second > 59) { return null; }
  if (m[8] !== 'Z') {
    const offsetHour = parseInt(m[8].slice(1, 3), 10);
    const offsetMinute = parseInt(m[8].slice(4, 6), 10);
    if (offsetHour > 23 || offsetMinute > 59) { return null; }
  }
  let ms = null;
  if (typeof Date === 'function' && typeof Date.parse === 'function') {
    const parsed = Date.parse(text);
    if (isNaN(parsed)) { return null; }
    ms = parsed;
  }
  return { text: text, ms: ms };
}

/** 编排层自己读到的当前时间（毫秒）；运行环境不提供 Date 时返回 null。 */
function currentTimeMs() {
  if (typeof Date !== 'function' || typeof Date.now !== 'function') { return null; }
  const now = Date.now();
  return isInteger(now) ? now : null;
}

/** 毫秒时间 → ISO-8601（UTC），仅用于错误信息；无 Date 时退化为毫秒文本。 */
function isoFromMs(ms) {
  if (!isInteger(ms) || typeof Date !== 'function') { return String(ms); }
  return new Date(ms).toISOString();
}

/** 绝对路径归一化：统一分隔符并去掉末尾斜杠（比较时另行小写化）。 */
function normalizeAbsPath(value) {
  return asString(value).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** childPath 是否等于 repoTarget 或位于其下（按归一化后的字符串前缀判断）。 */
function pathUnderRepo(childPath, repoTarget) {
  const child = normalizeAbsPath(childPath).toLowerCase();
  const root = normalizeAbsPath(repoTarget).toLowerCase();
  if (child === '' || root === '') { return false; }
  return child === root || child.indexOf(root + '/') === 0;
}

/**
 * 路径里是否含未规范化的点段（`.` 或 `..`）。
 * 含点段的路径一律不得作为判定依据：`/repo/./examples` 与 `/repo/examples` 指向同一位置，
 * 但字符串前缀比对会得出不同结论，从而绕过"落在仓库内"的判定（复审要求六）。
 */
function hasDotSegments(value) {
  const segments = asString(value).replace(/\\/g, '/').split('/');
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === '.' || segments[i] === '..') { return true; }
  }
  return false;
}

/** 从 "AC-01 ..." 形式的条目里取验收 ID。 */
function criterionId(text) {
  const m = CRITERIA_ID_PATTERN.exec(asString(text));
  return m === null ? null : m[1].toUpperCase();
}

/** 校验验收条件 ID 集合：每条都必须带 ID，且不得重复（复审意见四）。 */
function parseCriteriaIds(items) {
  const ids = [];
  const errors = [];
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i += 1) {
    const id = criterionId(list[i]);
    if (id === null) {
      errors.push('第 ' + (i + 1) + ' 条验收条件缺少可识别的 ID（应以 AC-xx 开头）：' + asString(list[i]).slice(0, 60));
      continue;
    }
    if (ids.indexOf(id) !== -1) { errors.push('验收条件 ID 重复：' + id); continue; }
    ids.push(id);
  }
  return { ids: ids, errors: errors };
}

/** 收集任一阶段报告的「未解决需求冲突」（复审意见四：任何阶段报告冲突都不得成功）。 */
function collectStageConflicts(codingReport, verification, review) {
  const found = [];
  function take(stage, container) {
    if (!isObject(container)) { return; }
    const list = container.requirement_conflicts;
    if (!Array.isArray(list) || list.length === 0) { return; }
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      found.push(stage + ': ' + (isObject(item)
        ? (asString(item.refs) + ' ' + asString(item.description)).trim()
        : String(item)));
    }
  }
  take('Coding Agent', codingReport);
  take('Verifier (verify)', verification);
  take('Review Agent', review);
  return found;
}

/**
 * 收集并校验一份「文件指纹清单」：路径必须是仓库内相对路径、sha256 必须是 64 位十六进制。
 * 返回 { map, keys, reasons, duplicateReasons }：`reasons` 是"清单本身不可用"（缺项 / 路径非法 /
 * 哈希格式非法），`duplicateReasons` 是"同一路径重复出现"——后者不影响清单可用性，但会被指纹门禁
 * 判为不一致，所以单独返回，避免"重复路径"把状态挤成 INCONSISTENT_EVIDENCE 而掩盖真正的指纹问题。
 */
function collectFingerprints(list, label) {
  const map = {};
  const keys = [];
  const reasons = [];
  const duplicates = [];
  if (!hasItems(list)) {
    reasons.push(label + ' 未回传被验证文件的哈希清单');
    return { map: map, keys: keys, reasons: reasons, duplicateReasons: [] };
  }
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!isObject(item)) { reasons.push(label + ' 的哈希项不是对象'); continue; }
    const path = normalizeAbsPath(item.path);
    const sha = asString(item.sha256).toLowerCase();
    const hasParentSegment = path.split('/').indexOf('..') !== -1;
    if (path === '' || hasParentSegment || path.charAt(0) === '/' || /^[A-Za-z]:/.test(path)) {
      reasons.push(label + ' 的文件路径非法（必须是仓库内相对路径）：' + JSON.stringify(item.path));
      continue;
    }
    if (!SHA256_PATTERN.test(sha)) {
      reasons.push(label + ' 的 sha256 不是 64 位十六进制：' + JSON.stringify(item.sha256));
      continue;
    }
    const key = path.toLowerCase();
    if (keys.indexOf(key) !== -1) {
      if (duplicates.indexOf(key) === -1) { duplicates.push(key); }
      continue;
    }
    keys.push(key);
    map[key] = sha;
  }
  const duplicateReasons = duplicates.length > 0
    ? [label + ' 的哈希清单出现重复路径：' + duplicates.join(', ')]
    : [];
  return { map: map, keys: keys, reasons: reasons, duplicateReasons: duplicateReasons };
}

/**
 * 比对「验证前 / 验证后」的文件指纹，并与本次运行配置的交付文件清单核对：
 * 清单必须**恰好**覆盖配置指定的交付文件（缺项、无关文件、重复路径一律拒绝），且同一路径哈希相同。
 * 只比较 Verifier 与 Review 两份清单是否互相一致是不够的——两份都漏掉测试文件也"一致"（复审要求一）。
 */
function judgeFingerprints(verifyArtifacts, reviewArtifacts, expectedFiles) {
  const reasons = [];
  const expected = (Array.isArray(expectedFiles) ? expectedFiles : [])
    .map(function (p) { return normalizeAbsPath(p).toLowerCase(); })
    .filter(function (p) { return p !== ''; });
  if (expected.length === 0) {
    reasons.push('本次运行没有可用的交付文件清单（交付目录/模块文件/测试文件配置不完整），无法核对指纹');
  }
  const before = collectFingerprints(verifyArtifacts, 'Verifier');
  const after = collectFingerprints(reviewArtifacts, 'Review');
  for (let i = 0; i < before.reasons.length; i += 1) { reasons.push(before.reasons[i]); }
  for (let i = 0; i < after.reasons.length; i += 1) { reasons.push(after.reasons[i]); }
  for (let i = 0; i < before.duplicateReasons.length; i += 1) { reasons.push(before.duplicateReasons[i]); }
  for (let i = 0; i < after.duplicateReasons.length; i += 1) { reasons.push(after.duplicateReasons[i]); }

  function compareWithExpected(keys, label) {
    const missing = expected.filter(function (p) { return keys.indexOf(p) === -1; });
    const extra = keys.filter(function (p) { return expected.indexOf(p) === -1; });
    if (missing.length > 0) { reasons.push(label + ' 的哈希清单缺少配置指定的交付文件：' + missing.join(', ')); }
    if (extra.length > 0) { reasons.push(label + ' 的哈希清单包含配置之外的无关文件：' + extra.join(', ')); }
  }
  if (expected.length > 0) {
    compareWithExpected(before.keys, 'Verifier');
    compareWithExpected(after.keys, 'Review');
  }

  const keysBefore = before.keys.slice().sort();
  const keysAfter = after.keys.slice().sort();
  if (keysBefore.join('|') !== keysAfter.join('|')) {
    reasons.push('验证前后被哈希的文件集合不一致：' + JSON.stringify(keysBefore) + ' vs ' + JSON.stringify(keysAfter));
  } else {
    for (let i = 0; i < keysBefore.length; i += 1) {
      if (before.map[keysBefore[i]] !== after.map[keysBefore[i]]) {
        reasons.push('文件在验证前后指纹发生变化：' + keysBefore[i] +
          '（' + before.map[keysBefore[i]] + ' -> ' + after.map[keysBefore[i]] + '）');
      }
    }
  }
  return { ok: reasons.length === 0, reasons: reasons, files: keysBefore, expected: expected };
}

/**
 * 运行期写入边界：交付目录里的 `__pycache__` 在测试执行前后必须完全一致。
 *
 * 为什么不能只看 git：`.gitignore` 已经忽略了 `__pycache__`，`git status` 永远看不见它的变化；
 * 被忽略的写入仍然违反本轮运行期约束（v0.2-run1 的 AC-24 就是这样被误判成 satisfied 的）。
 * 因此用执行前后的**文件指纹**（路径 / 字节数 / mtime / sha256）比对，不看是否被跟踪。
 *
 * 规则（fail-closed）：
 *  - 未返回 bytecode_scope、字段类型不对、路径不在缓存目录下、清单里有重复路径 → BYTECODE_SCOPE_UNMEASURED（证据不完整，不得判通过）；
 *  - 测试进程没有拿到受控环境变量（env_applied != true）→ BYTECODE_ENV_NOT_APPLIED；
 *  - 执行后出现执行前不存在的缓存文件 → BYTECODE_CACHE_WRITTEN；
 *  - 同一缓存文件的字节数 / mtime / sha256 前后不一致 → BYTECODE_CACHE_WRITTEN（被重写）。
 */
function normalizeCacheEntries(raw, cachePrefix, label) {
  if (!Array.isArray(raw)) { return { ok: false, entries: [], reason: label + ' 的缓存清单不是数组' }; }
  const entries = [];
  const seen = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isObject(item)) { return { ok: false, entries: [], reason: label + ' 的缓存清单第 ' + (i + 1) + ' 项不是对象' }; }
    const entryPath = asString(item.path).replace(/\\/g, '/');
    if (entryPath === '' || entryPath.indexOf('..') !== -1 || entryPath.charAt(0) === '/' || entryPath.indexOf('://') !== -1) {
      return { ok: false, entries: [], reason: label + ' 的缓存清单第 ' + (i + 1) + ' 项路径不可用：' + JSON.stringify(item.path) };
    }
    if (entryPath.indexOf(cachePrefix + '/') !== 0) {
      return { ok: false, entries: [],
        reason: label + ' 的缓存清单第 ' + (i + 1) + ' 项不在缓存目录 ' + cachePrefix + ' 下：' + entryPath };
    }
    if (seen.indexOf(entryPath) !== -1) {
      return { ok: false, entries: [], reason: label + ' 的缓存清单出现重复路径：' + entryPath };
    }
    seen.push(entryPath);
    const bytes = item.bytes;
    const mtimeMs = item.mtime_ms;
    const sha256 = asString(item.sha256).toLowerCase();
    if (!isInteger(bytes) || bytes < 0) {
      return { ok: false, entries: [], reason: label + ' 的缓存清单条目缺少合法字节数：' + entryPath };
    }
    if (typeof mtimeMs !== 'number' || !isFinite(mtimeMs) || mtimeMs <= 0) {
      return { ok: false, entries: [], reason: label + ' 的缓存清单条目缺少合法 mtime_ms：' + entryPath };
    }
    if (!SHA256_PATTERN.test(sha256)) {
      return { ok: false, entries: [], reason: label + ' 的缓存清单条目缺少合法 sha256：' + entryPath };
    }
    entries.push({ path: entryPath, bytes: bytes, mtimeMs: mtimeMs, sha256: sha256 });
  }
  return { ok: true, entries: entries, reason: '' };
}

/**
 * 两次观测是否指向"同一份缓存内容"。
 *
 * 为什么不能直接比较 mtime：三个子代理各自用 Python 读 `st_mtime * 1000`，同一个文件会被
 * 报成 `1792240028919`（整数毫秒）与 `1792240028919.332`（浮点毫秒）两种表示；用 `!==` 比较
 * 会把"bytes 与 sha256 完全相同"的同一份文件误判成被重写（v0.2-run2 的 4 条报错就是这么来的）。
 * 因此：先比内容（bytes + sha256），内容一致时只把 mtime 差当作噪声，容差见 MTIME_TOLERANCE_MS。
 */
function sameCacheObservation(earlier, later) {
  if (earlier.bytes !== later.bytes) { return false; }
  if (earlier.sha256 !== later.sha256) { return false; }
  return Math.abs(earlier.mtimeMs - later.mtimeMs) <= MTIME_TOLERANCE_MS;
}

function judgeBytecodeScope(scope, cachePrefix, label) {
  const boundary = label + ' 的运行期写入边界（' + cachePrefix + '）';
  if (!isObject(scope)) {
    return { ok: false, status: 'BYTECODE_SCOPE_UNMEASURED', before: null, after: null,
      reasons: [boundary + '：未返回 bytecode_scope，无法证明测试进程没有写缓存（证据不完整）'] };
  }
  const before = normalizeCacheEntries(scope.entries_before, cachePrefix, boundary);
  const after = normalizeCacheEntries(scope.entries_after, cachePrefix, boundary);
  if (!before.ok || !after.ok) {
    return { ok: false, status: 'BYTECODE_SCOPE_UNMEASURED', before: null, after: null,
      reasons: [before.ok ? after.reason : before.reason] };
  }
  if (scope.env_applied !== true) {
    return { ok: false, status: 'BYTECODE_ENV_NOT_APPLIED', before: before.entries, after: after.entries,
      reasons: [boundary + '：测试进程没有获得 ' + TEST_ENV_VAR + '=' + TEST_ENV_VALUE + '（env_applied != true）'] };
  }
  if (asString(scope.env_variable).toUpperCase() !== TEST_ENV_VAR) {
    return { ok: false, status: 'BYTECODE_ENV_NOT_APPLIED', before: before.entries, after: after.entries,
      reasons: [boundary + '：报告的受控环境变量不是 ' + TEST_ENV_VAR + '：' + JSON.stringify(scope.env_variable)] };
  }
  const beforeMap = {};
  for (let i = 0; i < before.entries.length; i += 1) { beforeMap[before.entries[i].path] = before.entries[i]; }
  const created = [];
  const rewritten = [];
  for (let i = 0; i < after.entries.length; i += 1) {
    const entry = after.entries[i];
    const prior = beforeMap[entry.path];
    if (prior === undefined) { created.push(entry.path); continue; }
    if (!sameCacheObservation(prior, entry)) { rewritten.push(entry.path); }
  }
  const reasons = [];
  if (created.length > 0) { reasons.push(boundary + '：测试执行后新增了缓存文件：' + created.join(', ')); }
  if (rewritten.length > 0) { reasons.push(boundary + '：测试执行后缓存文件被重写：' + rewritten.join(', ')); }
  if (reasons.length > 0) {
    return { ok: false, status: 'BYTECODE_CACHE_WRITTEN', reasons: reasons, created: created, rewritten: rewritten,
      before: before.entries, after: after.entries };
  }
  return { ok: true, status: 'OK', reasons: [], created: [], rewritten: [], before: before.entries, after: after.entries };
}

/** 相邻两个观测点的缓存清单必须完全一致；任何新增 / 重写 / 删除都算这一轮在写缓存。 */
function compareCachePoints(earlier, later) {
  const changes = [];
  const earlierMap = {};
  for (let i = 0; i < earlier.entries.length; i += 1) { earlierMap[earlier.entries[i].path] = earlier.entries[i]; }
  const laterMap = {};
  for (let j = 0; j < later.entries.length; j += 1) { laterMap[later.entries[j].path] = later.entries[j]; }
  for (let i = 0; i < earlier.entries.length; i += 1) {
    const path = earlier.entries[i].path;
    const now = laterMap[path];
    if (now === undefined) {
      changes.push({ path: path, kind: 'deleted' });
    } else if (!sameCacheObservation(earlier.entries[i], now)) {
      changes.push({ path: path, kind: 'rewritten' });
    }
  }
  for (let j = 0; j < later.entries.length; j += 1) {
    if (earlierMap[later.entries[j].path] === undefined) { changes.push({ path: later.entries[j].path, kind: 'created' }); }
  }
  return changes;
}

/**
 * 全运行缓存基线判定：Coding / Verifier / Review 各自的前后不变**只是必要条件**。
 * 阶段之间的间隙同样必须不变，否则"两个验证阶段各自看起来没事，但编码阶段或间隙里写过缓存"
 * 会被误判通过（v0.2-run1 的 AC-24 正是这种情形）。因此把所有观测点按时间顺序串起来，
 * 逐对比较：运行前基线 → Coding 前/后 → Verifier 前/后 → Review 前/后 → 最终采集。
 */
function judgeBytecodeRun(parts, cachePrefix) {
  const failures = [];
  const points = [];
  // 基线在参数校验时已经归一化过一遍（entries 用 mtimeMs 字段），这里不要再按原始字段名解析一次。
  const baselineAlreadyNormalized = Array.isArray(parts.baseline) && parts.baseline.every(function (e) {
    return isObject(e) && typeof e.path === 'string' && typeof e.mtimeMs === 'number';
  });
  const baseline = baselineAlreadyNormalized
    ? { ok: true, entries: parts.baseline, reason: '' }
    : normalizeCacheEntries(parts.baseline, cachePrefix, '运行前基线（编排层采集）');
  if (!baseline.ok) {
    failures.push({ status: 'BYTECODE_SCOPE_UNMEASURED', reasons: [baseline.reason],
      created: [], rewritten: [], removed: [] });
  } else {
    points.push({ label: '运行前基线（编排层采集）', entries: baseline.entries });
  }

  const stageScopes = [
    { label: 'Coding', scope: isObject(parts.coding) ? parts.coding.bytecode_scope : null },
    { label: 'Verifier', scope: isObject(parts.verification) ? parts.verification.bytecode_scope : null },
    { label: 'Review', scope: isObject(parts.review) ? parts.review.bytecode_scope : null }
  ];
  for (let i = 0; i < stageScopes.length; i += 1) {
    const stage = stageScopes[i];
    const verdict = judgeBytecodeScope(stage.scope, cachePrefix, stage.label);
    if (!verdict.ok) { failures.push(verdict); }
    if (Array.isArray(verdict.before) && Array.isArray(verdict.after)) {
      points.push({ label: stage.label + ' 执行前', entries: verdict.before });
      points.push({ label: stage.label + ' 执行后', entries: verdict.after });
    }
  }

  // 不再为"读文件指纹"单独启动子代理（工作流脚本无文件系统 API；v0.2-run2 为此每轮多付一次调用，
  // 是 10 次调用超过批准 8 次的直接原因）。最后一个观测点是 Review Agent 自报的执行后清单；
  // Review 返回之后的写入不在门禁覆盖范围内，由运行结束后的确定性工具补充（事后证据，不参与门禁）。
  const coverage = {
    finalPoint: 'Review Agent 自报的执行后清单',
    collectsAfterLastAgent: false,
    unobservedWindow: 'Review Agent 返回之后发生的缓存写入',
    note: '本运行没有为读取文件指纹启动额外子代理：最后一个观测点是 Review Agent 自报的执行后清单；' +
      'Review 返回之后的写入不在门禁覆盖范围内，由运行结束后的确定性工具补充（不参与门禁）。' +
      '另外：判定按内容身份（bytes + sha256）比较，mtime 只允许 5 毫秒的表示精度差——' +
      '若一次写入在观测点之间完成、把内容改回原样且 mtime 变化不超过容差，属于不可观测范围，本判定不能证明它没发生。'
  };

  const changes = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const found = compareCachePoints(points[i], points[i + 1]);
    for (let j = 0; j < found.length; j += 1) {
      changes.push({ from: points[i].label, to: points[i + 1].label, path: found[j].path, kind: found[j].kind });
    }
  }
  if (changes.length > 0) {
    const described = changes.map(function (c) {
      const verb = c.kind === 'deleted' ? '被删除' : (c.kind === 'created' ? '被新增' : '被重写');
      return c.path + ' 在「' + c.from + '」与「' + c.to + '」之间' + verb;
    });
    failures.push({ status: 'BYTECODE_CACHE_CHANGED_ACROSS_RUN',
      reasons: ['运行期写入边界（' + cachePrefix + '）：' + described.join('；')],
      created: changes.filter(function (c) { return c.kind === 'created'; }).map(function (c) { return c.path; }),
      rewritten: changes.filter(function (c) { return c.kind === 'rewritten'; }).map(function (c) { return c.path; }),
      removed: changes.filter(function (c) { return c.kind === 'deleted'; }).map(function (c) { return c.path; }) });
  }

  // 优先级：阶段内写入（最具体）> 阶段间隙变化 > 环境未生效 > 证据不完整。
  const priority = ['BYTECODE_CACHE_WRITTEN', 'BYTECODE_CACHE_CHANGED_ACROSS_RUN',
    'BYTECODE_ENV_NOT_APPLIED', 'BYTECODE_SCOPE_UNMEASURED'];
  const reasons = [];
  const created = [];
  const rewritten = [];
  const removed = [];
  failures.forEach(function (f) {
    f.reasons.forEach(function (r) { if (reasons.indexOf(r) === -1) { reasons.push(r); } });
    (f.created || []).forEach(function (p) { if (created.indexOf(p) === -1) { created.push(p); } });
    (f.rewritten || []).forEach(function (p) { if (rewritten.indexOf(p) === -1) { rewritten.push(p); } });
    (f.removed || []).forEach(function (p) { if (removed.indexOf(p) === -1) { removed.push(p); } });
  });
  if (failures.length === 0) {
    return { ok: true, status: 'OK', reasons: [], created: [], rewritten: [], removed: [], coverage: coverage,
      points: points.map(function (p) { return { label: p.label, count: p.entries.length }; }), changes: [] };
  }
  let status = priority[priority.length - 1];
  for (let i = 0; i < priority.length; i += 1) {
    if (failures.some(function (f) { return f.status === priority[i]; })) { status = priority[i]; break; }
  }
  return { ok: false, status: status, reasons: reasons, created: created, rewritten: rewritten, removed: removed,
    coverage: coverage,
    points: points.map(function (p) { return { label: p.label, count: p.entries.length }; }), changes: changes };
}

/**
 * 相对路径安全校验：拒绝绝对路径、盘符、`..`、反斜杠、空段与首尾空白。
 * 返回归一化（去掉尾部 `/`）的路径；不合法时返回 null。
 */
function normalizeRelPath(raw) {
  const value = asString(raw);
  if (value === '') { return null; }
  if (value.indexOf('\\') !== -1) { return null; }
  if (value.charAt(0) === '/') { return null; }
  if (/^[A-Za-z]:/.test(value)) { return null; }
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed === '') { return null; }
  const segments = trimmed.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === '' || segment === '.' || segment === '..') { return null; }
  }
  return trimmed;
}

/**
 * 认领文件路径的等价判定：既接受仓库内相对路径（原契约），也接受**由同一个仓库根解算出的绝对路径**。
 * 绝对路径必须与 `repoRootReal + '/' + 期望相对路径` 归一化并小写化后逐字符相同，因此它仍然只指向同一个文件；
 * 盘符相对路径（`D:foo`）、含点段的路径（`/repo/./x`、`/repo/a/../x`）、指向别处的路径一律不接受。
 * 放宽这一条只影响"怎么写出同一个文件"，不影响"必须是本次运行独占的那一个文件"。
 */
function ownerMarkerPathMatches(reported, repoRootReal, expectedRelPath) {
  const raw = asString(reported);
  if (raw === '') { return false; }
  if (normalizeRelPath(raw) === expectedRelPath) { return true; }
  const looksAbsolute = raw.charAt(0) === '/' || /^[A-Za-z]:/.test(raw) || raw.indexOf('\\') !== -1;
  if (!looksAbsolute) { return false; }
  const expected = normalizeAbsPath(repoRootReal + '/' + expectedRelPath).toLowerCase();
  const actual = normalizeAbsPath(raw).toLowerCase();
  return expected !== '' && actual === expected;
}

/** 文件名必须是纯 basename（不含任何路径分隔符），避免越出交付目录。 */
function normalizeBasename(raw) {
  const value = asString(raw);
  if (value === '' || value === '.' || value === '..') { return null; }
  if (value.indexOf('/') !== -1 || value.indexOf('\\') !== -1) { return null; }
  if (!BASENAME_PATTERN.test(value)) { return null; }
  return value;
}

function canonicalTestCommand(targetDir) {
  return 'python -m unittest discover -s ' + targetDir + ' -p "test_*.py"';
}

/** 受控执行环境的说明：与"规范化测试命令"分别记录，避免把环境写死进命令契约。 */
function testEnvironment() {
  return {
    variable: TEST_ENV_VAR,
    value: TEST_ENV_VALUE,
    mechanism: 'command-prefix',
    applies_to: 'single-command-invocation'
  };
}

/** 真正下发的执行命令 = 受控环境前缀 + 规范化命令（前缀只对这一次进程调用生效）。 */
function executionTestCommand(canonical) {
  return typeof canonical === 'string' && canonical !== '' ? TEST_ENV_PREFIX + canonical : null;
}

/**
 * 测试命令只允许"规范化命令"本身（可带 -v）或**带本脚本固定环境前缀**的同一条命令。
 * 前缀是编排层生成的常量，不是来自参数的自由文本：仍然不允许任意 shell 命令。
 */
function isAllowedTestCommand(command, canonical) {
  const value = asString(command);
  if (value === '' || typeof canonical !== 'string' || !TEST_COMMAND_PATTERN.test(canonical)) { return false; }
  const executed = executionTestCommand(canonical);
  if (executed === null) { return false; }
  const candidates = [canonical, canonical + ' -v', executed, executed + ' -v'];
  return candidates.indexOf(value) !== -1;
}

/** 记录本次命令是否带了受控环境前缀（放行两种形式，但证据里必须能区分）。 */
function testCommandEnvironmentApplied(command, canonical) {
  const value = asString(command);
  return value !== '' && value.indexOf(TEST_ENV_PREFIX) === 0 && isAllowedTestCommand(value, canonical);
}

/**
 * 校验并归一化运行参数。任何不合法输入都返回结构化错误，不抛异常、不产生空对象访问。
 */
// startupNowMs 是脚本启动时读到的时钟，只用于确认 runId/runStartedAt 来自这次真实运行（复审要求一、五）。
function validateRunConfig(rawArgs, startupNowMs) {
  const errors = [];
  if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs)) {
    return { ok: false, errors: ['args 必须是 JSON 对象，实际为 ' + typeof rawArgs], config: null };
  }
  const cfg = isObject(rawArgs) ? rawArgs : {};

  // runId 必填，不提供默认值：默认值会指向已归档的运行目录，存在覆盖历史证据的风险。
  const runId = asString(cfg.runId);
  let runIdStamp = null;
  if (!RUN_ID_PATTERN.test(runId)) {
    errors.push('runId 非法（只允许字母/数字/._-，长度 1-64，且不得以 . - _ 开头）：' + JSON.stringify(cfg.runId));
  } else {
    const stampMatch = RUN_ID_STAMP_PATTERN.exec(runId);
    if (stampMatch === null) {
      errors.push('runId 必须以 -<UTC 紧凑时间戳 YYYYMMDDTHHMMSSZ> 结尾（例如 v0.1-run-20261016T123456Z）：' +
        JSON.stringify(runId));
    } else {
      runIdStamp = stampMatch[2];
    }
  }

  const evidenceDirRaw = cfg.evidenceDir === undefined ? EVIDENCE_ROOT + runId : cfg.evidenceDir;
  const evidenceDir = normalizeRelPath(evidenceDirRaw);
  if (evidenceDir === null) {
    errors.push('evidenceDir 非法（必须是仓库内相对路径，禁止绝对路径/盘符/`..`/反斜杠）：' + JSON.stringify(evidenceDirRaw));
  } else if (evidenceDir.indexOf(EVIDENCE_ROOT) !== 0) {
    errors.push('evidenceDir 必须位于 ' + EVIDENCE_ROOT + ' 之下：' + evidenceDir);
  } else if (evidenceDir.split('/').pop() !== runId) {
    errors.push('evidenceDir 的最后一级目录必须等于 runId（防止证据归档到别的运行目录）：' + evidenceDir + ' vs ' + runId);
  }

  const promptDirRaw = cfg.promptDir === undefined ? 'agents' : cfg.promptDir;
  const promptDir = normalizeRelPath(promptDirRaw);
  if (promptDir === null) {
    errors.push('promptDir 非法（必须是仓库内相对路径）：' + JSON.stringify(promptDirRaw));
  }

  const taskInput = cfg.task === undefined ? {} : cfg.task;
  let taskIsObject = true;
  if (!isObject(taskInput)) {
    taskIsObject = false;
    errors.push('task 必须是 JSON 对象，实际为 ' + (Array.isArray(taskInput) ? 'array' : typeof taskInput));
  }
  const task = taskIsObject ? taskInput : {};

  const targetDirRaw = task.targetDir === undefined ? 'examples/text-stats' : task.targetDir;
  const targetDir = normalizeRelPath(targetDirRaw);
  if (targetDir === null) {
    errors.push('targetDir 非法（必须是仓库内相对路径，禁止绝对路径/盘符/`..`/反斜杠）：' + JSON.stringify(targetDirRaw));
  }

  const moduleFile = task.moduleFile === undefined ? 'text_stats.py' : normalizeBasename(task.moduleFile);
  if (moduleFile === null || !PY_MODULE_PATTERN.test(moduleFile)) {
    errors.push('moduleFile 非法（必须是单层文件名且形如 x.py）：' + JSON.stringify(task.moduleFile));
  }

  const testFile = task.testFile === undefined ? 'test_text_stats.py' : normalizeBasename(task.testFile);
  if (testFile === null || !PY_TEST_PATTERN.test(testFile)) {
    errors.push('testFile 非法（必须是单层文件名且形如 test_x.py）：' + JSON.stringify(task.testFile));
  }

  const sampleFile = task.sampleFile === undefined ? 'sample_input.txt' : normalizeBasename(task.sampleFile);
  if (sampleFile === null) {
    errors.push('sampleFile 非法（必须是单层文件名）：' + JSON.stringify(task.sampleFile));
  }

  const canonicalCommand = targetDir === null ? null : canonicalTestCommand(targetDir);
  const testCommandRaw = task.testCommand === undefined ? canonicalCommand : asString(task.testCommand);
  if (canonicalCommand === null || !isAllowedTestCommand(testCommandRaw, canonicalCommand)) {
    errors.push('testCommand 被拒绝：只允许规范化命令 ' + JSON.stringify(canonicalCommand) +
      '（可带 -v），不接受任意 shell 命令。实际为 ' + JSON.stringify(task.testCommand));
  }

  let maxCodingAttempts = 2;
  if (task.maxCodingAttempts !== undefined) {
    if (!isInteger(task.maxCodingAttempts) || task.maxCodingAttempts < 1 || task.maxCodingAttempts > MAX_ATTEMPTS_LIMIT) {
      errors.push('maxCodingAttempts 非法（必须是 1..' + MAX_ATTEMPTS_LIMIT + ' 的整数）：' +
        JSON.stringify(task.maxCodingAttempts));
    } else {
      maxCodingAttempts = task.maxCodingAttempts;
    }
  }

  // 子代理调用预算：默认就是批准过的上限（8 次），不因为"这次可能不够用"就自动放宽。
  let maxAgentCalls = AGENT_CALL_BUDGET_DEFAULT;
  if (task.maxAgentCalls !== undefined) {
    if (!isInteger(task.maxAgentCalls) || task.maxAgentCalls < 1 || task.maxAgentCalls > AGENT_CALL_BUDGET_LIMIT) {
      errors.push('maxAgentCalls 非法（必须是 1..' + AGENT_CALL_BUDGET_LIMIT + ' 的整数）：' +
        JSON.stringify(task.maxAgentCalls));
    } else {
      maxAgentCalls = task.maxAgentCalls;
    }
  }
  // 预算是否覆盖最坏情况（2 + 3 × 轮次）只作为返回字段说明，不在校验阶段拦截：
  // 拦在启动前会让"预算不足"变成参数错误、掩盖真实的限额语义；
  // 这里让它在**启动前检查**处按预算中止，并留下"第 N 次未启动"的记录（可测试、可审计）。

  // 内联脚本指纹自检（可选）：脚本必须以纯文本内联进 workflow 调用（脚本没有文件系统 API），
  // 逐字转录 2000+ 行时可能漏掉一行（v0.3-run3 就漏了 REVIEW_SCHEMA 里 `items` 的 type，
  // 宿主在第 5 次调用前以 schema 不合法拒绝，白花了 4 次调用）。
  // 因此允许把 `tests/script-fingerprint.mjs` 生成的期望指纹作为 args.selfCheck 传入：
  // 每次调用前比对提示词与 schema 的指纹，不一致就在**启动该子代理之前**中止。
  let selfCheck = null;
  if (cfg.selfCheck !== undefined) {
    if (!isObject(cfg.selfCheck)) {
      errors.push('selfCheck 非法（必须是 { "<label>": { "prompt": "...", "schema": "..." } } 对象）');
    } else {
      // 每条至少要有 schema 或 prompt 之一：schema 是静态的，可以在启动前从固定提交固定下来；
      // 提示词由真实需求与阶段结果拼成，只能在对应阶段比对，不许用模拟夹具生成的指纹冒充。
      const badKeys = Object.keys(cfg.selfCheck).filter(function (key) {
        const entry = cfg.selfCheck[key];
        if (!isObject(entry)) { return true; }
        const hasPrompt = entry.prompt !== undefined;
        const hasSchema = entry.schema !== undefined;
        if (!hasPrompt && !hasSchema) { return true; }
        if (hasPrompt && asString(entry.prompt) === '') { return true; }
        if (hasSchema && asString(entry.schema) === '') { return true; }
        return false;
      });
      if (badKeys.length > 0) {
        errors.push('selfCheck 的条目至少要有 schema 或 prompt 指纹（给出时不得为空字符串），以下条目不合法：' + badKeys.join(', '));
      } else {
        selfCheck = cfg.selfCheck;
      }
    }
  }
  const selfCheckRequired = cfg.selfCheckRequired === true;

  let runStartedAt = null;
  if (cfg.runStartedAt !== undefined) {
    const parsedStarted = parseIsoTimestamp(cfg.runStartedAt);
    // 无效日期（2026-02-30、25:00、+25:00 之类）必须失败：正则匹配不代表这是一个真实时间（复审要求五）。
    if (parsedStarted === null) {
      errors.push('runStartedAt 非法（必须是合法的、带时区的 ISO-8601 日历时间）：' + JSON.stringify(cfg.runStartedAt));
    } else {
      runStartedAt = parsedStarted.text;
    }
  }
  // runStartedAt 省略时由 runId 里的 UTC 时间戳还原：时间窗门禁必须始终生效，
  // 否则只要省略该参数就能让所有时间戳校验失效（fail-closed）。
  if (runStartedAt === null && runIdStamp !== null) {
    runStartedAt = fromUtcStamp(runIdStamp);
  }
  // runId 里的 UTC 时间戳必须与 runStartedAt 表示同一秒：运行标识不可事后编造或复用。
  if (runIdStamp !== null && runStartedAt !== null) {
    const expectedStamp = toUtcStamp(runStartedAt);
    if (expectedStamp !== null && expectedStamp !== runIdStamp) {
      errors.push('runId 的时间戳部分（' + runIdStamp + '）与 runStartedAt（' + runStartedAt +
        ' → UTC ' + expectedStamp + '）不是同一秒');
    }
  }
  // 时间窗必须绑定编排层的**启动时钟**：把 runId 与 runStartedAt 一起改成一个伪造的旧时间
  // （两者"同一秒"，上面那条查不出来）时，只有与启动时的实际时间比对才能拦住（复审要求五）。
  if (runStartedAt !== null && isInteger(startupNowMs)) {
    const started = parseIsoTimestamp(runStartedAt);
    if (started !== null && started.ms !== null && Math.abs(started.ms - startupNowMs) > RUN_START_MAX_SKEW_MS) {
      errors.push('runStartedAt（' + started.text + '）与编排层实际时间（' + isoFromMs(startupNowMs) +
        '）相差超过 ' + (RUN_START_MAX_SKEW_MS / MS_PER_HOUR) + ' 小时：运行标识疑似伪造或过期');
    }
  }

  // 全运行缓存基线：必须在任何子代理启动前由编排层实际采集并作为参数传入。
  // 缺失它不是"省一步"，而是让"本轮没有写缓存"永远无法被证明（fail-closed）。
  let cacheBaseline = null;
  const cachePrefixForArgs = targetDir === null ? CACHE_DIR_NAME : targetDir + '/' + CACHE_DIR_NAME;
  if (task.cacheBaseline === undefined) {
    errors.push('缺少 cacheBaseline：启动前必须实际采集 ' + cachePrefixForArgs +
      ' 的清单（path/bytes/mtime_ms/sha256），否则无法证明本轮没有新增、重写或删除缓存');
  } else if (!Array.isArray(task.cacheBaseline)) {
    errors.push('cacheBaseline 非法（必须是数组）：' + JSON.stringify(task.cacheBaseline));
  } else {
    const normalizedBaseline = normalizeCacheEntries(task.cacheBaseline, cachePrefixForArgs, 'cacheBaseline 参数');
    if (!normalizedBaseline.ok) {
      errors.push(normalizedBaseline.reason);
    } else {
      cacheBaseline = normalizedBaseline.entries;
    }
  }

  let requirementInput = null;
  if (task.requirement !== undefined) {
    if (typeof task.requirement !== 'string' || task.requirement.trim() === '') {
      errors.push('task.requirement 非法（必须是非空字符串）：' + JSON.stringify(task.requirement));
    } else {
      requirementInput = task.requirement.trim();
    }
  }

  const config = {
    runId: runId,
    runIdStamp: runIdStamp,
    evidenceDir: evidenceDir,
    promptDir: promptDir,
    requirementInput: requirementInput,
    targetDir: targetDir,
    moduleFile: moduleFile,
    testFile: testFile,
    sampleFile: sampleFile,
    testCommand: canonicalCommand,
    maxCodingAttempts: maxCodingAttempts,
    maxAgentCalls: maxAgentCalls,
    cacheBaseline: cacheBaseline,
    runStartedAt: runStartedAt,
    selfCheck: selfCheck,
    selfCheckRequired: selfCheckRequired
  };

  if (errors.length > 0) { return { ok: false, errors: errors, config: config }; }
  return { ok: true, errors: [], config: config };
}

// ================================================================ 证据判定（纯函数）

/**
 * 解析 `unittest` 的真实输出文本（Verifier/Review 回传的原始输出）。
 * 只认文本里的硬事实，不采信任何布尔自述。
 */
function parseUnittestOutput(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const ranMatch = /Ran (\d+) tests? in /.exec(text);
  const failedMatch = /(^|\n)FAILED[^\n]*/.exec(text);
  const okMatch = /(^|\n)OK( \([^\n]*\))?(\n|$)/.exec(text);
  // `OK (skipped=44)` 同时是"OK 标记"和"一个用例都没真正执行"：unittest 只有在
  // 全部用例被跳过时才输出这种括注，所以必须单独解析 skipped 数（复审要求一）。
  const skippedMatch = /\([^)\n]*\bskipped=(\d+)[^)\n]*\)/.exec(text);
  return {
    ran: ranMatch ? parseInt(ranMatch[1], 10) : null,
    skipped: skippedMatch ? parseInt(skippedMatch[1], 10) : null,
    failedMarker: failedMatch ? failedMatch[0].trim() : null,
    okMarker: okMatch ? true : false,
    textPresent: text.trim().length > 0
  };
}

/**
 * 是否"全部用例被跳过"（即没有一条测试真正执行过）。
 * `OK (skipped=44)` 的 `Ran 44 tests` 是真实数字，仅凭"用例数 > 0 + 有 OK 标记"判断会被它骗过：
 * 必须用 skipped 与 ran 的关系单独判（复审要求一）。
 */
function isAllTestsSkipped(parsed) {
  if (!isObject(parsed)) { return false; }
  return parsed.ran !== null && parsed.skipped !== null && parsed.skipped >= parsed.ran;
}

/** 全部跳过时的统一拒绝措辞（三个判定点共用，避免措辞漂移）。 */
function allSkippedReason(label, parsed) {
  return label + ' 显示全部用例被跳过（skipped=' + parsed.skipped + ' / Ran ' + parsed.ran +
    ' tests）：没有任何测试真正执行，不能作为测试通过的证据';
}

/** 判定 Verifier 独立复跑证据是否成立（命令必须是我们批准的那条）。 */
function judgeTestEvidence(evidence, canonicalCommand) {
  const reasons = [];
  if (!isObject(evidence)) { return { passed: false, reasons: ['Verifier 未返回结构化证据（子代理失败或输出不完整）'], parsed: null }; }
  const command = asString(evidence.command);
  if (!isAllowedTestCommand(command, canonicalCommand)) {
    reasons.push('Verifier 执行的不是规范化测试命令（可带固定环境前缀）：' + JSON.stringify(command) +
      '，期望 ' + JSON.stringify(canonicalCommand) + ' 或其受控前缀形式');
  }
  const exitCode = asString(evidence.exit_code);
  if (exitCode !== '0') { reasons.push('Verifier 报告的退出码非 0：' + JSON.stringify(evidence.exit_code)); }
  const parsed = parseUnittestOutput(evidence.raw_output);
  if (!parsed.textPresent) { reasons.push('Verifier 未回传原始测试输出（不接受口头结论）'); }
  if (parsed.failedMarker) { reasons.push('原始输出含失败标记：' + parsed.failedMarker); }
  if (parsed.ran === null) { reasons.push('原始输出中没有 `Ran N tests` 行，无法确认测试真实执行'); }
  else if (parsed.ran < 1) { reasons.push('原始输出显示执行的用例数为 0'); }
  if (isAllTestsSkipped(parsed)) { reasons.push(allSkippedReason('Verifier', parsed)); }
  if (!parsed.okMarker) { reasons.push('原始输出中没有 `OK` 标记'); }

  const declaredRan = evidence.ran_tests;
  if (isInteger(declaredRan) && parsed.ran !== null && declaredRan !== parsed.ran) {
    reasons.push('Verifier 自述用例数（' + declaredRan + '）与原始输出（' + parsed.ran + '）不一致');
  }
  const declaredMarker = asString(evidence.result_marker);
  if (declaredMarker !== '' && parsed.failedMarker && declaredMarker.toUpperCase() !== 'FAILED') {
    reasons.push('Verifier 自述 ' + declaredMarker + ' 与原始输出中的失败标记不一致');
  }
  if (declaredMarker !== '' && !parsed.failedMarker && declaredMarker.toUpperCase() !== 'OK') {
    reasons.push('Verifier 自述 ' + declaredMarker + ' 与原始输出中的 OK 标记不一致');
  }
  // 只用来校验"哈希清单本身可用"（非空、路径合法、sha256 为 64 位十六进制）；
  // "重复路径"以及"是否恰好覆盖配置指定的交付文件"都在 judgeFingerprints 里判（复审要求一），
  // 这样重复路径会落到 ARTIFACT_FINGERPRINT_MISMATCH 而不是被挤成 INCONSISTENT_EVIDENCE。
  const artifactShape = collectFingerprints(evidence.artifacts, 'Verifier');
  if (artifactShape.reasons.length > 0) {
    for (let i = 0; i < artifactShape.reasons.length; i += 1) {
      reasons.push('哈希清单不可用：' + artifactShape.reasons[i]);
    }
  }

  return { passed: reasons.length === 0, reasons: reasons, parsed: parsed };
}

/**
 * 判定 Review 结论与其自身证据、与需求的一致性（审核意见一.2 / 一.3，复审意见四、要求三）。
 * expectedIds 来自需求工件，是验收条件的唯一权威 ID 集合：缺失 / 重复 / 未知一律不得通过。
 * verifierRanTests：Verifier 对同一条规范化命令实际执行的用例数，用于交叉核对 Review 的复跑（要求三）。
 */
function judgeReviewConsistency(review, expectedIds, canonicalCommand, verifierRanTests) {
  const reasons = [];
  const expected = (Array.isArray(expectedIds) ? expectedIds : []).map(function (id) { return String(id).toUpperCase(); });
  if (!isObject(review)) {
    return { approved: false, allSatisfied: false, coversAll: false, ownTestsPassed: false, ownTestsRan: null,
      missingIds: expected, duplicateIds: [], unknownIds: [], reviewConflicts: 0,
      criteriaTotal: 0, criteriaSatisfied: 0, reasons: ['Review Agent 未返回结构化结论'] };
  }
  const verdict = asString(review.verdict);
  const approved = verdict === 'APPROVED';
  if (!approved) { reasons.push('Review 结论为 ' + (verdict === '' ? '(空)' : verdict)); }

  const checks = Array.isArray(review.criteria_check) ? review.criteria_check : [];
  const seen = [];
  const duplicateIds = [];
  const unknownIds = [];
  let satisfied = 0;
  for (let i = 0; i < checks.length; i += 1) {
    const item = checks[i];
    if (!isObject(item)) { reasons.push('criteria_check 第 ' + (i + 1) + ' 项不是对象'); continue; }
    const id = criterionId(item.criterion);
    if (id === null) {
      reasons.push('criteria_check 第 ' + (i + 1) + ' 项缺少可识别的验收 ID：' + asString(item.criterion).slice(0, 40));
    } else if (seen.indexOf(id) !== -1) {
      if (duplicateIds.indexOf(id) === -1) { duplicateIds.push(id); }
    } else {
      seen.push(id);
      if (expected.indexOf(id) === -1) { unknownIds.push(id); }
    }
    if (item.satisfied === true) { satisfied += 1; }
  }
  const missingIds = expected.filter(function (id) { return seen.indexOf(id) === -1; });
  const coversAll = expected.length > 0 && missingIds.length === 0;
  if (!coversAll) { reasons.push('criteria_check 未逐项覆盖需求的验收 ID，缺失：' + (missingIds.join(', ') || '(需求无 ID)')); }
  if (duplicateIds.length > 0) { reasons.push('criteria_check 中出现重复的验收 ID：' + duplicateIds.join(', ')); }
  if (unknownIds.length > 0) { reasons.push('criteria_check 中出现需求里不存在的验收 ID：' + unknownIds.join(', ')); }

  const allSatisfied = checks.length > 0 && satisfied === checks.length;
  if (!allSatisfied) {
    reasons.push('验收条件未全部满足：' + satisfied + '/' + checks.length +
      '（未满足项：' + checks.filter(function (c) { return !isObject(c) || c.satisfied !== true; })
        .map(function (c) { return isObject(c) ? (criterionId(c.criterion) || asString(c.criterion).slice(0, 24)) : '(非法项)'; })
        .join(' | ') + '）');
  }

  const ownCommand = asString(review.independent_test_command);
  const ownCommandMatches = isAllowedTestCommand(ownCommand, canonicalCommand);
  const ownParsed = parseUnittestOutput(review.independent_test_output);
  const ownParseOk = ownParsed.textPresent && ownParsed.ran !== null && !ownParsed.failedMarker && ownParsed.okMarker;
  // 命令不一致必须是致命的：Review 必须原样执行规范化命令（可带固定环境前缀），否则"独立复跑"不能算数。
  let ownTestsPassed = ownParseOk && ownCommandMatches;
  if (!ownCommandMatches) {
    reasons.push('Review 的独立复跑命令不是规范化命令（可带固定环境前缀）：' + JSON.stringify(ownCommand) +
      '（必须原样执行：' + canonicalCommand + ' 或其受控前缀形式）');
  }
  if (!ownParseOk) {
    reasons.push('Review 的独立复跑证据不成立（' + (ownParsed.failedMarker ? '输出含 ' + ownParsed.failedMarker :
      '缺少 Ran/OK 标记或原始输出为空') + '）');
  }
  // 复跑必须真的执行了测试：`Ran 0 tests` 既不算独立复跑，也不能作为审核证据（复审要求三）。
  if (ownParsed.ran !== null && ownParsed.ran < 1) {
    ownTestsPassed = false;
    reasons.push('Review 的独立复跑执行了 0 个用例（`Ran 0 tests`）：不算独立验证');
  }
  // `OK (skipped=44)` 同样是"没有执行任何用例"：跳过不等于通过（复审要求一）。
  if (isAllTestsSkipped(ownParsed)) {
    ownTestsPassed = false;
    reasons.push(allSkippedReason('Review 的独立复跑', ownParsed));
  }
  // 同一条规范化命令、同一份代码，Verifier 与 Review 的执行用例数必须一致：
  // 不一致说明至少有一方没有真正执行（复审要求三）。
  if (isInteger(verifierRanTests) && ownParsed.ran !== null && ownParsed.ran !== verifierRanTests) {
    ownTestsPassed = false;
    reasons.push('Review 独立复跑的执行用例数（' + ownParsed.ran + '）与 Verifier 对同一规范化命令的执行用例数（' +
      verifierRanTests + '）不一致');
  }
  if (asString(review.independent_test_exit_code) !== '0') {
    ownTestsPassed = false;
    reasons.push('Review 自述的复跑退出码非 0：' + JSON.stringify(review.independent_test_exit_code));
  }

  const reviewConflicts = Array.isArray(review.requirement_conflicts) ? review.requirement_conflicts : [];
  if (reviewConflicts.length > 0) {
    reasons.push('Review 报告了未解决的需求冲突 ' + reviewConflicts.length + ' 条：不得判为通过，必须先由人工统一口径');
  }

  return { approved: approved, allSatisfied: allSatisfied, coversAll: coversAll, ownTestsPassed: ownTestsPassed,
    ownTestsRan: ownParsed.ran,
    missingIds: missingIds, duplicateIds: duplicateIds, unknownIds: unknownIds, reviewConflicts: reviewConflicts.length,
    criteriaTotal: checks.length, criteriaSatisfied: satisfied, reasons: reasons };
}

/**
 * Coding Agent 自述的内部一致性：命令必须是本次配置的规范化命令，退出码必须是非负整数，
 * `test_succeeded` 必须与退出码、与输出摘录里的标记一致
 * （复审要求四：`test_succeeded=true` + `exit 1` 这种自相矛盾的自述不得被当作通过）。
 */
function judgeCodingReportConsistency(codingReport, canonicalCommand) {
  const reasons = [];
  if (!isObject(codingReport)) { return { ok: false, reasons: ['Coding Agent 未返回实现报告'] }; }
  const command = asString(codingReport.test_command);
  if (!isAllowedTestCommand(command, canonicalCommand)) {
    reasons.push('Coding 报告的测试命令不是本次运行的规范化命令：' + JSON.stringify(command) +
      '，期望 ' + JSON.stringify(canonicalCommand));
  }
  const exitText = asString(codingReport.test_exit_code);
  const exitIsNonNegativeInteger = /^\d+$/.test(exitText);
  if (!exitIsNonNegativeInteger) {
    reasons.push('Coding 报告的退出码不是非负整数：' + JSON.stringify(codingReport.test_exit_code));
  }
  if (typeof codingReport.test_succeeded !== 'boolean') {
    reasons.push('Coding 的 test_succeeded 不是布尔值：' + JSON.stringify(codingReport.test_succeeded));
  } else if (codingReport.test_succeeded === true && exitIsNonNegativeInteger && exitText !== '0') {
    reasons.push('Coding 自述测试通过（test_succeeded=true）但报告的退出码是 ' +
      JSON.stringify(codingReport.test_exit_code) + '：自述内部矛盾');
  } else if (codingReport.test_succeeded === false && exitText === '0') {
    reasons.push('Coding 自述测试未通过（test_succeeded=false）但报告的退出码是 0：自述内部矛盾');
  }
  const excerpt = typeof codingReport.test_output_excerpt === 'string' ? codingReport.test_output_excerpt : '';
  if (excerpt.trim() !== '') {
    const parsed = parseUnittestOutput(excerpt);
    if (parsed.ran !== null && parsed.ran < 1) {
      reasons.push('Coding 的输出摘录显示执行的用例数为 0');
    }
    if (isAllTestsSkipped(parsed)) {
      reasons.push(allSkippedReason('Coding 的输出摘录', parsed));
    }
    if (codingReport.test_succeeded === true && parsed.failedMarker) {
      reasons.push('Coding 自述测试通过但输出摘录含失败标记：' + parsed.failedMarker);
    }
    if (codingReport.test_succeeded === false && parsed.okMarker && !parsed.failedMarker) {
      reasons.push('Coding 自述测试未通过但输出摘录只有 OK 标记');
    }
  }
  return { ok: reasons.length === 0, reasons: reasons };
}

/**
 * 单轮判定：只有"测试真实通过 + Coding 自述内部一致 + 审核结论为通过且其证据一致 + 无未解决需求冲突 +
 * 指纹恰好覆盖配置的交付文件且前后一致"才算通过。
 * 返回 { ok, status, reasons, reviewEval, verified, fingerprints, codingConsistency, stageConflicts, selfReportVsVerified }。
 */
function judgeAttempt(codingReport, verification, review, expectedIds, canonicalCommand, codingVerdict, verificationVerdict, expectedArtifacts, bytecodeVerdict) {
  const reasons = [];
  let status = 'OK';

  // 复用调用方已算好的判定（含 Verifier 时间窗检查与 Coding 自述一致性）；没有传入时才自行计算，
  // 否则这些门禁会变成死代码（审核发现的缺陷：编排出题时算过、判定时又丢掉了）。
  const verified = isObject(verificationVerdict) ? verificationVerdict : judgeTestEvidence(verification, canonicalCommand);
  if (!verified.passed) { reasons.push('外部独立验证未通过：' + verified.reasons.join('；')); }

  const codingOutputValid = isObject(codingVerdict) && codingVerdict.outputValid === true;
  const codingConsistency = isObject(codingVerdict) && isObject(codingVerdict.consistency)
    ? codingVerdict.consistency
    : judgeCodingReportConsistency(codingReport, canonicalCommand);
  if (!codingConsistency.ok) {
    reasons.push('Coding Agent 的自述内部不一致：' + codingConsistency.reasons.join('；'));
  }

  const verifierRanTests = isObject(verified.parsed) && isInteger(verified.parsed.ran) ? verified.parsed.ran : null;
  const reviewEval = judgeReviewConsistency(review, expectedIds, canonicalCommand, verifierRanTests);
  if (!reviewEval.approved || !reviewEval.allSatisfied || !reviewEval.coversAll || !reviewEval.ownTestsPassed) {
    reasons.push('审核结论不可用：' + reviewEval.reasons.join('；'));
  }

  const fingerprints = judgeFingerprints(isObject(verification) ? verification.artifacts : null,
    isObject(review) ? review.artifacts_after : null, expectedArtifacts);
  if (!fingerprints.ok) { reasons.push('文件指纹检查未通过：' + fingerprints.reasons.join('；')); }

  // 运行期写入边界（`__pycache__` 等被忽略的写入）：git 看不见，只能靠执行前后的文件指纹。
  const bytecode = isObject(bytecodeVerdict) ? bytecodeVerdict
    : { ok: false, status: 'BYTECODE_SCOPE_UNMEASURED', reasons: ['编排层没有计算运行期写入边界（证据不完整）'] };
  if (!bytecode.ok) { reasons.push('运行期写入边界检查未通过：' + bytecode.reasons.join('；')); }

  const stageConflicts = collectStageConflicts(codingReport, verification, review);
  if (stageConflicts.length > 0) {
    reasons.push('有阶段报告了未解决的需求冲突：' + stageConflicts.join(' | '));
  }

  const codingExit = isObject(codingReport) ? asString(codingReport.test_exit_code) : '';
  const selfReportVsVerified = {
    coding_claimed_success: isObject(codingReport) ? codingReport.test_succeeded === true : null,
    coding_claimed_exit_code: codingExit === '' ? null : codingExit,
    verification_exit_code: isObject(verification) ? asString(verification.exit_code) : null,
    verification_ok: verified.passed,
    agreement: (isObject(codingReport) ? codingReport.test_succeeded === true : false) === verified.passed
  };

  // 优先级说明：只要任一阶段报告了未解决的需求冲突，状态就必须是该冲突（而不是别的原因，
  // 例如 Coding Agent 未返回可用报告）——否则冲突会被次要原因掩盖，违背"冲突即硬失败"的语义。
  if (stageConflicts.length > 0) {
    status = 'STAGE_REPORTS_REQUIREMENT_CONFLICT';
    reasons.push('任何阶段报告未解决的需求冲突时都不得判定为成功：必须先由人工统一口径，再以全新 runId 重跑');
  } else if (verified.timestampOk === false) {
    status = 'INVALID_TIMESTAMP';
    reasons.push('Verifier 证据的时间戳不在运行窗口内：疑似占位时间，验证结果不予采信');
  } else if (!codingOutputValid) {
    status = 'CODING_OUTPUT_INVALID';
    reasons.push('Coding Agent 未返回可用的实现报告（files_created 缺失或子代理失败）');
  } else if (!codingConsistency.ok) {
    status = 'CODING_REPORT_INCONSISTENT';
    reasons.push('Coding Agent 的测试自述内部矛盾（命令 / 退出码 / test_succeeded 三者不自洽）：自述结果不予采信');
  } else if (!selfReportVsVerified.agreement) {
    status = 'INCONSISTENT_EVIDENCE';
    reasons.push('Coding Agent 自述（test_succeeded=' + JSON.stringify(selfReportVsVerified.coding_claimed_success) +
      '，exit=' + JSON.stringify(selfReportVsVerified.coding_claimed_exit_code) +
      '）与外部独立验证（' + (verified.passed ? '通过' : '未通过') + '，exit=' +
      JSON.stringify(selfReportVsVerified.verification_exit_code) + '）矛盾：自述不能当作验证结果');
  } else if (!verified.passed) {
    // 走到这里时自述与独立验证已一致，因此这里必然也是"Coding 自述失败"：
    // 曾另设 CODING_SELF_REPORTED_FAILURE 分支，但它永远不可达（自述失败而验证通过会先被 INCONSISTENT_EVIDENCE 拦下），已删除。
    status = 'TEST_NOT_VERIFIED';
    reasons.push('独立复核未通过（Coding 自述与复核结论一致地判为失败）：测试结果不予采信');
  } else if (!reviewEval.ownTestsPassed) {
    status = 'INCONSISTENT_REVIEW';
  } else if (!fingerprints.ok) {
    status = 'ARTIFACT_FINGERPRINT_MISMATCH';
  } else if (!bytecode.ok) {
    status = bytecode.status;
  } else if (!reviewEval.approved) {
    status = 'REVIEW_NOT_APPROVED';
  } else if (!reviewEval.allSatisfied) {
    status = 'CRITERIA_NOT_SATISFIED';
  } else if (reviewEval.duplicateIds.length > 0) {
    status = 'CRITERIA_CHECK_DUPLICATE_IDS';
  } else if (reviewEval.unknownIds.length > 0) {
    status = 'CRITERIA_CHECK_UNKNOWN_IDS';
  } else if (!reviewEval.coversAll) {
    status = 'CRITERIA_CHECK_INCOMPLETE';
  }

  return { ok: status === 'OK', status: status, reasons: reasons, reviewEval: reviewEval,
    verified: verified, fingerprints: fingerprints, codingConsistency: codingConsistency,
    stageConflicts: stageConflicts, selfReportVsVerified: selfReportVsVerified, bytecode: bytecode };
}

/** 需求自检结果：出现冲突就必须停止，不得让 Coding Agent 自选一套解释（审核意见三）。 */
function judgeRequirementConsistency(requirement) {
  if (!isObject(requirement)) {
    return { ok: false, conflicts: ['Requirement Agent 未返回结构化需求'], idErrors: [], criteriaIds: [] };
  }
  const idInfo = parseCriteriaIds(requirement.acceptance_criteria);
  if (idInfo.errors.length > 0) {
    return { ok: false, conflicts: [], idErrors: idInfo.errors, criteriaIds: idInfo.ids };
  }
  const check = requirement.consistency_check;
  if (!isObject(check) || check.self_checked !== true) {
    return { ok: false, criteriaIds: idInfo.ids, idErrors: [],
      conflicts: ['Requirement Agent 未完成验收条件与边界条件的一致性自检（consistency_check.self_checked != true）'] };
  }
  const conflicts = Array.isArray(check.conflicts) ? check.conflicts : [];
  if (conflicts.length > 0) {
    return { ok: false, criteriaIds: idInfo.ids, idErrors: [], conflicts: conflicts.map(function (c) {
      return isObject(c) ? (asString(c.refs) + ' ' + asString(c.description)).trim() : String(c);
    }) };
  }
  return { ok: true, conflicts: [], idErrors: [], criteriaIds: idInfo.ids };
}

/** 时间戳真实性：必须是合法的 ISO-8601 日历时间、落在运行窗口内、且不得晚于编排层当前时间。 */
const TIMESTAMP_WINDOW_HOURS = 6;
const TIMESTAMP_CLOCK_SKEW_MS = 60000;
const MS_PER_HOUR = 3600000;
// 运行起点与编排层实际时间的最大允许偏差：runId 里的时间戳必须来自这次真实运行（复审要求五）。
const RUN_START_MAX_SKEW_MS = MS_PER_HOUR;

// nowMs 是**判定当刻**读到的时钟（每个阶段返回后重新读取），不是启动时刻：这样长运行的判定基准不会过期（复审要求一）。
function judgeTimestamp(value, runStartedAt, windowHours, nowMs) {
  const parsed = parseIsoTimestamp(value);
  // 格式对但日期不存在（2026-02-30、25:00、+25:00 等）同样是无效时间：必须失败，不得当成"格式正确"放行。
  if (parsed === null) {
    return { ok: false, reason: '时间戳不是合法的带时区 ISO-8601 日历时间：' + JSON.stringify(value) };
  }
  if (!runStartedAt) { return { ok: true, reason: '' }; }
  const started = parseIsoTimestamp(runStartedAt);
  if (started === null) {
    return { ok: false, reason: '运行起始时间本身不是合法的 ISO-8601 日历时间：' + JSON.stringify(runStartedAt) };
  }
  if (started.ms === null || parsed.ms === null) { return { ok: true, reason: '' }; }
  const windowMs = (isInteger(windowHours) ? windowHours : TIMESTAMP_WINDOW_HOURS) * MS_PER_HOUR;
  if (parsed.ms < started.ms - TIMESTAMP_CLOCK_SKEW_MS || parsed.ms > started.ms + windowMs) {
    return { ok: false, reason: '时间戳 ' + parsed.text + ' 不在运行窗口内（起始 ' + started.text +
      '，窗口 ' + (windowMs / MS_PER_HOUR) + ' 小时）：疑似占位时间' };
  }
  // 时间窗绑定判定当刻的时钟：明显晚于此刻（超出容差）的时间戳只能是被编造出来的（复审要求五）。
  if (isInteger(nowMs) && parsed.ms > nowMs + TIMESTAMP_CLOCK_SKEW_MS) {
    return { ok: false, reason: '时间戳 ' + parsed.text + ' 晚于编排层当前时间（' + isoFromMs(nowMs) +
      '）：不可能由本次运行真实取得' };
  }
  return { ok: true, reason: '' };
}

/** 生成失败结果（所有提前退出都走这里，保证返回结构一致）。 */
function failure(status, error, extra) {
  const base = {
    ok: false,
    status: status,
    verdict: 'PROVISIONAL_FAIL',
    verdictScope: 'provisional-in-run',
    verdictMeaning: '运行内暂定失败：脚本按契约中止；原始证据保留，最终判定仍由外层复核给出',
    error: error
  };
  if (isObject(extra)) {
    Object.keys(extra).forEach(function (key) { base[key] = extra[key]; });
  }
  return base;
}

// ================================================================ 输出 Schema

const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repo_root', 'repo_root_realpath', 'evidence_dir_state', 'evidence_dir_state_before', 'evidence_dir_realpath',
    'evidence_dir_claimed', 'owner_marker_path', 'claim_tool', 'claim_created', 'claim_exit_code', 'claimed_at',
    'link_components', 'prompt_files', 'target_dir', 'target_dir_state', 'target_dir_realpath', 'resolved_paths',
    'generated_at'],
  properties: {
    repo_root: { type: 'string' },
    repo_root_realpath: { type: 'string' },
    evidence_dir_state: { type: 'string', enum: ['missing', 'empty', 'exists'] },
    evidence_dir_state_before: { type: 'string', enum: ['missing', 'empty', 'exists'] },
    evidence_dir_entries: { type: 'array', items: { type: 'string' } },
    evidence_dir_realpath: { type: 'string' },
    evidence_dir_claimed: { type: 'boolean' },
    owner_marker_path: { type: 'string' },
    claim_tool: { type: 'string' },
    claim_created: { type: 'boolean' },
    claim_exit_code: { type: 'integer' },
    claimed_at: { type: 'string' },
    link_components: { type: 'array', items: { type: 'string' } },
    prompt_files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'exists'],
        properties: { path: { type: 'string' }, exists: { type: 'boolean' } }
      }
    },
    target_dir: { type: 'string' },
    target_dir_state: { type: 'string', enum: ['present', 'missing'] },
    target_dir_realpath: { type: 'string' },
    resolved_paths: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
    generated_at: { type: 'string' }
  }
};

const REQUIREMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'scope_in', 'scope_out', 'acceptance_criteria', 'boundary_conditions', 'consistency_check', 'generated_at'],
  properties: {
    goal: { type: 'string' },
    scope_in: { type: 'array', items: { type: 'string' } },
    scope_out: { type: 'array', items: { type: 'string' } },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    boundary_conditions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    consistency_check: {
      type: 'object',
      additionalProperties: false,
      required: ['self_checked', 'conflicts'],
      properties: {
        self_checked: { type: 'boolean' },
        conflicts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['refs', 'description'],
            properties: { refs: { type: 'string' }, description: { type: 'string' } }
          }
        },
        notes: { type: 'string' }
      }
    },
    generated_at: { type: 'string' }
  }
};

// 运行期写入边界：Coding、Verifier、Review 都必须交回"执行测试前后"的缓存目录指纹。
// 字段名与命令行取值分开记录：环境变量名/值不是"命令"的一部分。
const BYTECODE_SCOPE_REQUIRED = ['env_applied', 'env_variable', 'cache_dir', 'entries_before', 'entries_after'];
const BYTECODE_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'bytes', 'mtime_ms', 'sha256'],
  properties: {
    path: { type: 'string' },
    bytes: { type: 'integer' },
    mtime_ms: { type: 'number' },
    sha256: { type: 'string' }
  }
};
const BYTECODE_SCOPE_PROPERTIES = {
  env_applied: { type: 'boolean' },
  env_variable: { type: 'string' },
  cache_dir: { type: 'string' },
  entries_before: { type: 'array', items: BYTECODE_ENTRY_SCHEMA },
  entries_after: { type: 'array', items: BYTECODE_ENTRY_SCHEMA }
};

const CODING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files_created', 'implementation_summary', 'test_command', 'test_succeeded', 'test_exit_code', 'test_output_excerpt', 'requirement_conflicts', 'report_file', 'generated_at'],
  properties: {
    files_created: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'purpose'],
        properties: { path: { type: 'string' }, purpose: { type: 'string' } }
      }
    },
    implementation_summary: { type: 'string' },
    acceptance_criteria_addressed: { type: 'array', items: { type: 'string' } },
    test_command: { type: 'string' },
    test_succeeded: { type: 'boolean' },
    test_exit_code: { type: 'string' },
    test_output_excerpt: { type: 'string' },
    deviations_from_requirement: { type: 'array', items: { type: 'string' } },
    requirement_conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['refs', 'description'],
        properties: { refs: { type: 'string' }, description: { type: 'string' } }
      }
    },
    report_file: { type: 'string' },
    bytecode_scope: { type: 'object', additionalProperties: false, required: BYTECODE_SCOPE_REQUIRED,
      properties: BYTECODE_SCOPE_PROPERTIES },
    generated_at: { type: 'string' }
  }
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'exit_code', 'raw_output', 'ran_tests', 'result_marker', 'artifacts', 'bytecode_scope',
    'requirement_conflicts', 'generated_at'],
  properties: {
    command: { type: 'string' },
    exit_code: { type: 'string' },
    raw_output: { type: 'string' },
    ran_tests: { type: 'integer' },
    result_marker: { type: 'string', enum: ['OK', 'FAILED'] },
    bytecode_scope: { type: 'object', additionalProperties: false, required: BYTECODE_SCOPE_REQUIRED,
      properties: BYTECODE_SCOPE_PROPERTIES },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256'],
        properties: { path: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' } }
      }
    },
    requirement_conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['refs', 'description'],
        properties: { refs: { type: 'string' }, description: { type: 'string' } }
      }
    },
    notes: { type: 'string' },
    generated_at: { type: 'string' }
  }
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'criteria_check', 'issues', 'independent_test_command', 'independent_test_exit_code',
    'independent_test_output', 'artifacts_after', 'bytecode_scope', 'requirement_conflicts', 'summary', 'report_file',
    'generated_at'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUESTED'] },
    bytecode_scope: { type: 'object', additionalProperties: false, required: BYTECODE_SCOPE_REQUIRED,
      properties: BYTECODE_SCOPE_PROPERTIES },
    criteria_check: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'satisfied', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          satisfied: { type: 'boolean' },
          evidence: { type: 'string' }
        }
      }
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'problem', 'suggestion'],
        properties: {
          file: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' }
        }
      }
    },
    independent_test_command: { type: 'string' },
    independent_test_exit_code: { type: 'string' },
    independent_test_output: { type: 'string' },
    artifacts_after: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256'],
        properties: { path: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' } }
      }
    },
    requirement_conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['refs', 'description'],
        properties: { refs: { type: 'string' }, description: { type: 'string' } }
      }
    },
    consistency_note: { type: 'string' },
    summary: { type: 'string' },
    report_file: { type: 'string' },
    generated_at: { type: 'string' }
  }
};

// ================================================================ 提示词构建

/**
 * 运行期写入边界提示：要求子代理在**同一条命令**里设置受控环境，并在执行前后记录缓存目录指纹。
 * 不依赖宿主进程环境（子代理是独立进程），也不允许把环境改成任意 shell 片段。
 */
function bytecodeScopeNote(cacheDir) {
  return [
    '### 运行期写入边界（强制，编排脚本会按文件指纹复核）',
    '- **必须**用带受控环境前缀的命令执行测试（前缀与命令必须在同一条命令里，不得拆成两条）：',
    '  `' + executionTestCommand(C.testCommand) + '`；',
    '- 该前缀只设置一个变量 `' + TEST_ENV_VAR + '=' + TEST_ENV_VALUE + '`，禁止追加别的环境变量、禁止追加别的命令；',
    '- 本阶段内**任何**执行 Python 的命令都必须带同一个前缀 `' + TEST_ENV_PREFIX.trim() + '`，',
    '  包括 `python -c` 抽查、临时脚本、`--help` 试跑、导入被测模块看行为：不带前缀的 Python 调用会写 `' + CACHE_DIR_NAME + '`，',
    '  而全运行账本把这些写入视为本次运行改动了缓存（进度记录 v0.2-run2 的 Review 阶段就是这样写入的）；',
    '- 执行测试**之前**与**之后**，各记录一次缓存目录 `' + cacheDir + '` 的文件清单：',
    '  每个文件记录 `path`（仓库内相对路径、正斜杠）、`bytes`、`mtime_ms`（Unix 毫秒时间戳，整数）与 `sha256`（按原始字节计算）；',
    '  目录不存在或为空时写空数组 `[]`；',
    '- 把两次清单写入 `bytecode_scope`：`{ env_applied: true, env_variable: "' + TEST_ENV_VAR + '", cache_dir: "' + cacheDir +
      '", entries_before: [...], entries_after: [...] }`；',
    '- 执行后出现新缓存文件、或已有缓存文件被重写（bytes 或 sha256 变化，或 mtime 相差超过 ' + MTIME_TOLERANCE_MS +
      ' 毫秒），本轮判不通过（`BYTECODE_CACHE_WRITTEN`）；',
    '- 未记录该字段或记录不完整，本轮判"证据不完整"（`BYTECODE_SCOPE_UNMEASURED`）。',
    '  `.gitignore` 忽略该目录不代表允许在运行期写入：`git status` 看不见的写入同样违规。'
  ].join('\n');
}

function envelopeNote(artifactPath) {
  return [
    '### 你必须写入的产物文件',
    '- 产物文件路径: ' + artifactPath,
    '- 该路径**相对于仓库根目录**：写入前先确认仓库根（`git rev-parse --show-toplevel` 或查找 `workflows/three-agent-mvp.js`），',
    '  并把路径拼到仓库根之后（或直接使用仓库根的绝对路径）；不要在别的目录下创建同名文件，',
    '  也不要把同一份报告写两次到不同位置——错位的副本会留在工作区里成为脏文件。',
    '- JSON 信封字段：run_id / agent / stage / generated_at / result（result 内也要有同样的 generated_at）。',
    '- `generated_at` 必须是**你本次运行中真实取得**的时间：先执行命令取当前时间（例如 PowerShell `Get-Date -Format o`，或 python `datetime.now().astimezone().isoformat()`），',
    '  不得使用记忆里的、占位的或猜测的时间戳；本脚本会校验时间戳必须落在本次运行窗口内。'
  ].join('\n');
}

function preflightPrompt(artifactPath, ownerMarkerPath) {
  return [
    '你是 TLA 流水线中的 **Verifier Agent**，本次以 `MODE=preflight`（环境预检）执行，在独立上下文中工作。',
    '',
    '【第一步】完整读取你的角色规范文件：' + C.promptDir + '/verifier-agent.md，并逐条遵守。',
    '',
    '【第二步】只做只读检查 + 本次运行的目录认领。**除了下面明确允许的两个写操作，不得创建、修改或删除任何其他文件**：',
    '  (a) 用仓库内的排他创建工具认领证据目录（**不得自己拼写认领文件**）：在仓库根目录执行',
    '      `python ' + EVIDENCE_CLAIM_TOOL + ' --repo-root . --evidence-dir ' + C.evidenceDir + ' --run-id ' + C.runId +
      ' --run-started-at ' + C.runStartedAt + ' --claimed-by verifier-preflight`；',
    '      该工具用 O_EXCL **排他创建** `' + ownerMarkerPath + '`（内容由它自己写）：退出码 0 = 本次运行独占成功；',
    '      退出码非 0 = 目录已被别的运行认领或创建失败——**不得覆写已有的认领文件、不得改用别的写法**，如实报告即可。**先做这一步**。',
    '  (b) 你自己的产物文件 `' + artifactPath + '`。',
    '1. 仓库根目录的绝对路径写入 `repo_root`；把它解算后的**真实路径**（软链接 / 目录联接解析之后）写入 `repo_root_realpath`。',
    '2. 证据目录 `' + C.evidenceDir + '` 在**认领之前**的状态：不存在 → `missing`；存在且为空 → `empty`；存在且有内容 → `exists`，',
    '   并把已有条目名写入 `evidence_dir_entries`（这是"不得覆盖历史证据"的判定依据，必须如实报告；',
    '   若目录里已有别的 run_id 的认领文件，必须如实报告）。',
    '   `evidence_dir_state` 写的是**认领之前**的观察；认领成功后目录里会多出 `' + ownerMarkerPath + '`，',
    '   那是正常的"认领后"状态，**不要**因此把它改写成 `exists`。',
    '3. 证据目录的真实路径写入 `evidence_dir_realpath`；把认领工具的实测结果**原样**写入 `evidence_dir_claimed`（退出码为 0 才是 true）、',
    '   `claim_tool`（固定填 `' + EVIDENCE_CLAIM_TOOL + '`）、`claim_created`（工具报告"新建成功"才为 true）、',
    '   `claim_exit_code`（工具的**真实**退出码）、`claimed_at`（认领工具写入的时间）、',
    '   `evidence_dir_state_before`（工具自报的**认领前**状态，逐字回填，不得用你自己观察到的值替代）。任一字段与工具实测不符，编排脚本会立即终止本次运行。',
    '   `owner_marker_path`：**逐字回填**认领工具输出的那个值，它是仓库内相对路径（形如 `' + ownerMarkerPath + '`）。',
    '   **不要**把它改写成绝对路径，也不要施加 `os.path.abspath` / `Path.resolve` 之类的"规范化"——工具输出的就是契约要求的形式。',
    '   **认领失败时（工具的退出码非 0）：不要写任何文件** —— 尤其不要写你自己的产物文件 `' + artifactPath + '`：',
    '   那个目录属于别的运行，写进去会污染它的证据；直接返回结构化结果（把拒绝原因写进 `problems`），让编排层以 EVIDENCE_NOT_CLAIMED 终止。',
    '4. 检查从仓库根到交付目录、证据目录的**每一级路径分量**是否为软链接、Windows 目录联接（junction）或其他重解析点，',
    '   把这些分量**解算后的真实路径**写入 `link_components`（一个都没有就写空数组 `[]`）。',
    '   某个分量是链接、且解算后的真实路径已经越出仓库根时，它的真实路径必须出现在 `link_components` 里，并把该情况写入 `problems`。',
    '5. 本次运行会用到的四个角色提示词文件是否存在：' + promptPaths.requirement + '、' + promptPaths.coding + '、' + promptPaths.review + '、' + promptPaths.verifier + '，写入 `prompt_files`。',
    '6. 交付目录 `' + C.targetDir + '` 是否存在（present/missing），其真实路径写入 `target_dir_realpath`。',
    '7. 其余能核实的绝对路径写入 `resolved_paths`；任何可能越出仓库、或与本次 run_id `' + C.runId + '` 冲突的问题写入 `problems`。',
    '   **`problems` 只要非空，本次运行就会立即终止**（不会带病运行）：只写你真正核实到的异常，不要把正常观察写进去；没有异常就写空数组 `[]`。',
    '   路径必须是**已规范化**的绝对路径：不得出现 `.` 或 `..` 这样的点段（编排脚本会拒绝含点段的路径）。',
    '',
    '【第三步】只报告你亲自核实的事实，不得推测；不得读取任何凭据文件、不得访问网络。',
    '返回结构化结果（见 schema），并写入产物文件：',
    envelopeNote(artifactPath)
  ].join('\n');
}

function requirementPrompt(artifactPath) {
  return [
    '你是 TLA 三 Agent 流水线中的第 1 个角色（Requirement Agent）。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.requirement + '，并逐条遵守。',
    '',
    '【第二步】处理下面的原始需求，产出结构化需求。',
    '',
    '### 原始需求（自然语言）',
    originalRequirement,
    '',
    '### 运行期参数',
    '- run_id: ' + C.runId,
    '- 证据目录: ' + C.evidenceDir,
    '- 交付目录（你不写代码，仅用于界定范围）: ' + C.targetDir,
    '- 依赖边界: ' + depsBoundary,
    '- 上一轮运行发现的需求缺陷（真实案例，必须避免重犯；不要照抄其中的错误断言）:',
    priorConflictNote,
    '',
    '【第三步】写完验收条件后，必须执行**一致性自检**（角色规范第 3.1 节）：',
    '- 逐条把 `acceptance_criteria` 与 `boundary_conditions` 对照：对同一个输入，两条规则是否给出**可同时成立**的期望值；',
    '- 只要存在无法同时成立的组合（例如同一输入在两条规则下期望值不同、或某条断言与其自身依据的规则矛盾），',
    '  必须写入 `consistency_check.conflicts`（标明涉及的条目编号与冲突原因），**不得把它们当作断言写进验收条件**；',
    '- 自检通过时 `consistency_check.self_checked = true` 且 `conflicts` 为空数组。',
    '  一旦报告冲突，工作流会立即停止并要求人工澄清，不会交给 Coding Agent 自行选择解释。',
    '- 凡是你自己写进需求的**数值示例**，必须逐字段按你写下的规则重算一遍（字符数按归一化后码点、行数按切分规则、',
    '  非空行数按判空规则、单词数按单词规则）；只写重算一致的数字，并**优先复用原始需求给出的示例**，不得凭印象新造数字示例。',
    '- `conflicts` 只用于「**本次需求内部**两条规则、对**同一类调用、同一输入**给出不可同时成立的期望」；',
    '- 「现有实现与本需求不一致」**不是冲突** —— 那正是本次要修改的内容，必须写进验收条件或 `scope_in`；',
    '  「实现细节没有写明」也不是冲突 —— 把它写成一条明确的边界条件即可；',
    '- 原始需求已经给出的权威口径必须**按原意**保留（尤其是"命令行调用"与"程序化注入调用"的作用域区分）：',
    '  不得用另一套口径替代、不得把两类调用合并成同一条契约；只有当你确信该权威口径本身不可实现时，才写入 `conflicts` 并停止。',
    '',
    '【第三步】编号要求（编排脚本按 ID 逐项核对，缺号 / 重号 / 未知 ID 一律判为不通过）：',
    '- `acceptance_criteria` 必须是非空字符串数组，每条以 `AC-01`、`AC-02`… 形式开头（连续、唯一、不得重复）；',
    '- `boundary_conditions` 同样每条以 `BC-01`、`BC-02`… 形式开头；',
    '- 每条正文必须自包含：写清"哪一类调用、哪个输入 → 期望值"，不要依赖未写出的上下文。',
    '',
    '【第四步】返回与产物文件 result 完全一致的结构化结果。只返回结构化结果。',
    '',
    envelopeNote(artifactPath)
  ].join('\n');
}

function codingPrompt(attempt, previousReview) {
  const lines = [
    '你是 TLA 三 Agent 流水线中的第 2 个角色（Coding Agent）。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.coding + '，并逐条遵守。',
    '',
    '【第二步】按下述需求在指定交付目录内实现代码与单元测试，并真实运行测试。',
    '',
    '### 交付目录与文件名约定',
    '- 交付目录（仓库内相对路径，不得越出仓库）: ' + C.targetDir,
    '- 模块文件: ' + C.targetDir + '/' + C.moduleFile,
    '- 测试文件: ' + C.targetDir + '/' + C.testFile,
    '- 样例输入文件（按需求决定是否创建）: ' + C.targetDir + '/' + C.sampleFile,
    '- 规范化测试命令（**必须用它**运行测试）: ' + C.testCommand,
    '- 实际执行时必须带上受控环境前缀（同一条命令，不得拆开）: ' + executionTestCommand(C.testCommand),
    '- `test_command` 字段仍然只填上面那条规范化命令本身（不含环境前缀）：环境与命令分开记录；',
    '- 依赖边界: ' + depsBoundary,
    '',
    bytecodeScopeNote(C.targetDir + '/' + CACHE_DIR_NAME),
    '',
    '### Requirement Agent 的结构化产出（JSON，原样传递）',
    '```json',
    JSON.stringify(requirement, null, 2),
    '```',
    '',
    '### 本轮的独立验证约定（重要）',
    '- 你报告 `test_succeeded` / `test_exit_code` 之后，Verifier Agent 会**独立复跑同一条命令**并回传原始输出；',
    '- 你自述的结果与它的原始输出必须一致，否则本轮判定为不通过（`INCONSISTENT_EVIDENCE`）：',
    '  因此必须如实填写，且在你最后一次修改文件之后运行测试。',
    '- 你的自述还必须**内部自洽**（编排脚本逐项核对，不自洽直接判不通过 `CODING_REPORT_INCONSISTENT`）：',
    '  `test_command` 必须是上面那条规范化命令；`test_exit_code` 必须是真实退出码的十进制字符串；',
    '  `test_succeeded: true` 只能在退出码为 `"0"` 且输出摘录里**没有** `FAILED` 标记时使用；',
    '  `test_succeeded: false` 必须对应非 0 退出码；`test_output_excerpt` 必须是真实输出的片段，不得改写或省略失败标记。'
  ];

  if (previousReview) {
    lines.push(
      '',
      '### 上一轮判定未通过的原因（必须先修复）',
      '```json',
      JSON.stringify({
        verdict: previousReview.verdict,
        issues: previousReview.issues,
        criteria_check: previousReview.criteria_check,
        summary: previousReview.summary
      }, null, 2),
      '```',
      '修复后重新运行测试，并在实现说明中写清修复了什么。不得通过放宽或删除测试来"通过"审核。'
    );
  }

  lines.push(
    '',
    '### 需求冲突的报告要求（强制）',
    '- 若你在实现过程中确认需求本身自相矛盾（两条验收/边界条件对同一调用给出互斥期望），',
    '  把每条冲突写入 `requirement_conflicts`（refs + description），**不要自行选择一套解释**：',
    '  只要该字段非空，本轮就会被判为不通过，并交人工统一口径后才能重跑；',
    '- 没有发现冲突就写空数组 `[]`。'
  );

  lines.push('', '【第三步】返回与产物文件 result 完全一致的结构化结果。只返回结构化结果。', '',
    envelopeNote(artifact(attempt, 'coding-report')));
  return lines.join('\n');
}
function verifyPrompt(artifactPath) {
  return [
    '你是 TLA 流水线中的 **Verifier Agent**，本次以 `MODE=verify`（独立验证）执行，在独立上下文中工作。',
    '',
    '【第一步】完整读取你的角色规范文件：' + C.promptDir + '/verifier-agent.md，并逐条遵守。',
    '',
    '【第二步】独立复跑验收测试，并回传**原始输出**：',
    '- 必须执行的命令（不得改写、不得增删参数）: ' + C.testCommand,
    '- 实际执行时必须带上受控环境前缀（同一条命令，不得拆开）: ' + executionTestCommand(C.testCommand),
    '- 在交付目录 `' + C.targetDir + '` 存在的前提下，从仓库根目录执行它；',
    '- 把命令的完整输出（含 `Ran N tests` 与 `OK`/`FAILED` 行）原样放进 `raw_output`；不得摘要、不得改写、不得为了让结果好看而重跑别的命令；',
    '- `exit_code` 填真实退出码；`ran_tests` 填原始输出里的用例数；`result_marker` 填 `OK` 或 `FAILED`；',
    '- 复跑测试**之后**，对交付目录中的**模块文件与测试文件**计算 sha256（含 `bytes`）写入 `artifacts`；哈希必须是复跑之后的最新值；',
    '  `artifacts` 必须**恰好**包含这两个文件，路径分别写成 `' + C.targetDir + '/' + C.moduleFile + '` 与 `' +
      C.targetDir + '/' + C.testFile + '`：',
    '  多列（README、.gitignore、样例输入等）或**少列**（例如漏掉测试文件）都会被判为指纹不一致；路径不得含 `.` / `..` 点段；',
    '  哈希一律对文件的**原始字节**计算（二进制读取，不做任何换行/编码转换，Windows 上尤其不要用文本模式读取）；',
    '- `command` 填你**实际执行**的完整命令（含受控环境前缀）；`raw_output` 仍是该命令的原始输出；',
    '',
    bytecodeScopeNote(C.targetDir + '/' + CACHE_DIR_NAME),
    '- 你在本次运行中**唯一允许的写操作**是把结果写入产物文件 `' + artifactPath + '`；',
    '  不得修改交付目录或仓库中任何其他文件（不修复缺陷、不格式化代码、不删除文件、不新建文件）；发现问题只需如实报告。',
    '- `requirement_conflicts`：若你在复跑或阅读中发现需求本身自相矛盾（两条验收/边界条件对同一调用给出互斥期望），',
    '  把每条冲突写入该字段（refs + description）；没有发现就写空数组 `[]`。**报告了冲突就不要擅自选一套口径继续验证**，',
    '  照实报告即可，编排脚本会停止本次运行、交人工统一口径。',
    '',
    '【第三步】返回结构化结果并写入产物文件（只报告原始事实，不做通过/不通过的最终裁定；裁定由编排脚本按原始输出计算）：',
    envelopeNote(artifactPath)
  ].join('\n');
}

function reviewPrompt(attempt, codingReport, verification, artifactPath) {
  return [
    '你是 TLA 三 Agent 流水线中的第 3 个角色（Review Agent），在独立上下文中审核。',
    '',
    '【第一步】完整读取你的角色规范文件：' + promptPaths.review + '，并逐条遵守。',
    '',
    '【第二步】审核交付目录中的真实代码。',
    '',
    '### 交付目录',
    '- 交付目录: ' + C.targetDir,
    '- 模块文件: ' + C.targetDir + '/' + C.moduleFile,
    '- 测试文件: ' + C.targetDir + '/' + C.testFile,
    '- 规范化测试命令（**请你自己独立执行一次**）: ' + C.testCommand,
    '- 实际执行时必须带上受控环境前缀（同一条命令，不得拆开）: ' + executionTestCommand(C.testCommand),
    '- 依赖边界: ' + depsBoundary,
    '',
    '### Requirement Agent 的结构化产出（审核依据）',
    '```json',
    JSON.stringify(requirement, null, 2),
    '```',
    '',
    '### Coding Agent 的报告（线索，不是证据）',
    '```json',
    JSON.stringify(codingReport, null, 2),
    '```',
    '',
    '### Verifier Agent 的独立验证证据（原始输出，供你核对；仍需自己复跑一次）',
    '```json',
    JSON.stringify(verification, null, 2),
    '```',
    '',
    '### 结论一致性要求（强制）',
    '- `criteria_check` 必须**逐项覆盖需求中的验收 ID 集合：一条不多、一条不少、不重复**：',
    '  ' + (parseCriteriaIds(requirement.acceptance_criteria).ids.join('、') || '(需求未给出可识别的 ID)') + '；',
    '  每项的 `criterion` 必须以对应 ID 开头，并给出你自己的验证证据；不得给出需求里不存在的 ID，也不得把同一 ID 写两次（编排脚本会拒绝）。',
    '- **只要有任意一条 `satisfied: false`，`verdict` 就必须是 `CHANGES_REQUESTED`**；',
    '- `verdict: APPROVED` 必须同时满足：全部验收 ID 均 satisfied、你自己复跑的测试退出码为 0 且输出含 `OK`；',
    '- **你必须真的执行测试**：复跑输出必须含 `Ran N tests`（N ≥ 1）与 `OK`，且 N 必须与 Verifier 在同一条命令下报出的用例数一致；',
    '  `Ran 0 tests`、或与 Verifier 的用例数不一致，都会被判为不通过（`INCONSISTENT_REVIEW`）；',
    '- `artifacts_after`：在你**自己复跑测试之后**，对交付文件（模块文件与测试文件，路径写成 `' + C.targetDir + '/' +
      C.moduleFile + '` 与 `' + C.targetDir + '/' + C.testFile + '`）重新计算 sha256 写入该字段（**恰好这两个文件**，多列或少列都会被判为指纹不一致；同样按**原始字节**计算，不做换行/编码转换，须与 Verifier 的算法一致）；',
    '  这些哈希必须与 Verifier 的 `artifacts` 完全一致；若你发现文件在验证前后发生变化，必须写入 `issues` 并把 verdict 判为 `CHANGES_REQUESTED`；',
    '- `requirement_conflicts`：若你在审核中发现需求本身自相矛盾，把每条冲突写入该字段（refs + description）；没有就写空数组 `[]`。',
    '  **只要该字段非空，本轮就不可能判定为通过**：不得一边报告冲突、一边给出 APPROVED（那会被判为不通过）；',
    '- 若你发现 Coding Agent 的自述、Verifier 的原始输出、你自己的复跑结果三者之间存在矛盾，',
    '  必须在 `consistency_note` 中写明矛盾点，并把 `verdict` 判为 `CHANGES_REQUESTED`。',
    '  编排脚本会独立重算这些判定：矛盾结论不会被当作通过。',
    '',
    bytecodeScopeNote(C.targetDir + '/' + CACHE_DIR_NAME),
    '- `independent_test_command` 填你**实际执行**的完整命令（含受控环境前缀）；',
    '',
    '【第三步】以你亲眼读到的文件内容与你亲自运行的命令输出为唯一依据，',
    '写入产物文件并返回结构化结果。只返回结构化结果。',
    '',
    envelopeNote(artifactPath)
  ].join('\n');
}

// ================================================================ 运行期装配

// 编排层自己的时钟：所有"时间窗 / 未来时间 / 伪造起点"判定都以它为锚点，绝不由子代理提供。
// 启动时钟：只用于「运行标识是否与本机当前时间相符」这一次锚定（见 validateRunConfig）。
const startupNowMs = currentTimeMs();
const validated = validateRunConfig(args, startupNowMs);
if (!validated.ok) {
  phaseStatic('validation');
  log('输入参数校验失败，工作流未启动任何子代理');
  return failure('INVALID_ARGS', '运行参数校验失败，未启动任何子代理', { errors: validated.errors, received: args === undefined ? null : args });
}
const C = validated.config;

// 内置演示任务（工作流测试样例，不属于 TLA 工作台自身功能）
// 口径说明：本次需求把上一轮暴露的 AC-12/BC-12（同一调用既要求"不打印"又要求"恰好 4 行"）与
// BC-03/BC-02（splitlines 语义 vs 行边界集合）两处冲突按"作用域分开规定 + 显式行边界集合"消除，
// 使 Requirement Agent 的自检有明确权威口径可依，不再需要 Coding/Review 自行选边。
const demoRequirement = [
  '请为仓库中已有的 Python 文本统计命令行工具（examples/text-stats/text_stats.py）编写需求说明与可检查的验收条件：',
  '在既有实现基础上改进，不要重写、不要改变交付目录，也不要更改工作流本身。',
  '工具功能：读取一段文本（命令行给出一个文件路径；未给出路径时读取标准输入），输出四项统计结果：',
  '1) 总字符数；2) 总行数；3) 非空行数；4) 英文单词数。',
  '必须明确到可以逐条测试的程度，并消除历史运行中出现过的自相矛盾。以下口径是本次需求的权威定义，',
  '任何验收条件与边界条件都不得与之冲突：',
  '（1）行边界：只有 LF（\\n）、CR（\\r）、CRLF（\\r\\n）三种序列构成换行；',
  '     U+2028、U+2029、\\x0b、\\x0c、\\x1c、\\x1d、\\x1e、\\x85 一律不构成换行。',
  '（2）总行数 line_count：按上面的行边界切分后的行数；以换行结尾的文本不产生额外空行',
  '     （"a\\n" 是 1 行，"a\\nb" 是 2 行，"a\\n\\n" 是 2 行，"hello world\\nfoo bar\\n" 是 2 行，空文本是 0 行）；',
  '     仅含空白字符的行仍然是行："  \\n\\t\\n" 是 2 行（两行都是空白行），其 non_empty_line_count 是 0；',
  '     任何验收条件与边界条件的示例都必须与上述示例一致，不得把末尾换行之后的空片段另计为一行（该输入不得写成 3 行）。',
  '     不得把 str.splitlines() 当作唯一实现依据（它会把 U+2028/U+2029 等当作换行）。',
  '（3）总字符数 char_count：按归一化后的文本长度计数；归一化＝剥除一个前导 BOM（U+FEFF）、把 CRLF 与单独的 CR 统一为 LF。',
  '（4）非空行数 non_empty_line_count：切分出的行中，去掉首尾空白字符后仍非空的行数。',
  '（5）英文单词 word_count：按正则 [A-Za-z]+(?:[-\'\\u2019][A-Za-z]+)* 匹配计数；数字、下划线、中文等非 ASCII 字符不算单词的一部分。',
  '（6）命令行成功路径的输出格式：标准输出恰好 4 行，顺序为 char_count、line_count、non_empty_line_count、word_count，',
  '     每行形如 "<名称>: <整数>"，不输出其他内容。',
  '（7）作用域区分（权威口径，必须按原意保留，不得改写、不得把两类调用合并）：',
  '     a) 程序化调用：调用方**显式传入 stdin_text**（传入空串 "" 或非空文本都算）时，main() 只返回整数退出码、**不写标准输出**；',
  '         例如 main([], stdin_text="") 返回 0，且标准输出为空（调用方自己负责打印结果）。',
  '     b) 命令行调用：程序作为命令行运行（给出 PATH，或未给出 PATH 时读取进程标准输入）时，成功路径必须输出（6）规定的 4 行。',
  '     c) 因此"成功路径恰好 4 行"只约束 b；a 与 b 适用于不同调用方式，不得写成对同一调用的互斥期望，也不得反过来要求 a 也打印 4 行。',
  '（8）错误路径：文件不存在、文件不可读、编码名非法、位置参数多于 1 个，一律以退出码 1 结束，',
  '     并在标准错误输出一行以 "error: " 开头的说明；不得沿用 argparse 默认的退出码 2；--help 仍为退出码 0。',
  '（9）已知需要一并修正的既有缺陷：a) 行数口径矛盾（按上面第 2 条统一）；b) 多余位置参数退出码为 2（应为 1）；',
  '     c) 模块内存在一个仅做单行转发的冗余函数（应删除，命令行入口直接调用主函数）；',
  '     d) 文档中描述连接符时使用了外观相同、实为 U+2019 的字符（应改为可辨认的写法，例如纯 ASCII 撇号）。',
  '（10）依赖约束：只允许 Python 标准库，禁止任何第三方依赖；不得在交付目录内新增依赖声明文件。',
  '（11）实现必须同时提供可被单元测试直接调用的纯函数接口与命令行入口，并提供可在仓库内复制的示例。'
].join('\n');

const originalRequirement = hasText(C.requirementInput) ? C.requirementInput : demoRequirement;
const depsBoundary = '仅允许 Python 标准库（禁止引入任何第三方依赖）';
const priorConflictNote = [
  '- 历史记录（前两次运行的真实需求缺陷，本次必须避免重犯）：',
  '  a) "总行数"曾同时出现互斥期望：以换行结尾的 "hello world\\nfoo bar\\n" 被同时要求计 2 行与 3 行；',
  '  b) "cafe\\u0301" 的单词数曾被同时要求为 1 与 2；',
  '  c) 第二次运行又出现一对互斥要求：一条要求 main([], stdin_text="") 的标准输出恰好是 "True 0 int"，',
  '     另一条要求成功路径的标准输出恰好 4 行——同一调用不可能同时满足。',
  '  消除办法：先写清"哪一类调用"（命令行 / 程序化注入 / --help），再写该调用的期望值；',
  '  不同调用方式可以有不同期望，但同一种调用方式在同一输入下只能有一个期望。',
  '  本次原始需求在（7）中已经自行给出"命令行 / 程序化注入"的作用域区分：请按其原意保留，不要据此把两类调用合并。',
  '  另注：本工作流已把"未解决的需求冲突"设为硬失败（状态 STAGE_REPORTS_REQUIREMENT_CONFLICT）；',
  '  但「现有实现与本次需求不一致」不是冲突，它必须出现在 scope_in / 验收条件里。'
].join('\n');

const promptPaths = {
  requirement: C.promptDir + '/requirement-agent.md',
  coding: C.promptDir + '/coding-agent.md',
  review: C.promptDir + '/review-agent.md',
  verifier: C.promptDir + '/verifier-agent.md'
};

/** 本次运行的认领文件：证明证据目录由本次运行独占（复审意见五：原子防覆盖）。 */
const ownerMarkerPath = C.evidenceDir + '/.run-owner.json';

/** 证据文件路径：第 1 轮用 <kind>.json，修订轮用 <kind>-revision-<n>.json */
function artifact(attempt, kind) {
  return C.evidenceDir + '/' + kind + (attempt > 1 ? '-revision-' + attempt : '') + '.json';
}

function phaseStatic(label) {
  if (typeof phase === 'function') { phase(label); }
}

function reportProblems(context, reasons) {
  if (hasItems(reasons)) { log(context + '：' + reasons.join('；')); }
}

// ---------------------------------------------------------------- 子代理调用预算

/**
 * 子代理调用账本：**启动前**记账并检查预算。
 *
 * 为什么要在调用前检查：事后统计只能证明"超了多少"，无法阻止第 9 次调用发生。
 * v0.2-run2 批准 8 次、实际启动 10 次（每轮多一个 Cache Collector），多出来的两次是真实付费调用。
 * 因此预算耗尽时返回一个标记对象、**不调用 agent()**，由调用点转成 AGENT_CALL_BUDGET_EXCEEDED 中止。
 *
 * 注意边界：这里能强制限制的是"启动多少次子代理会话"，**不能**限制单个子代理内部的 token 消耗
 * （一次调用可能读很多文件、跑很长的循环）。两者不能混为一谈。
 */
const agentCalls = [];
// 指纹自检里"没有固定期望值、因此没有比对"的字段：如实累积，写进返回值，避免把部分比对说成全部比对。
const scriptSelfCheckUnchecked = [];

function budgetExhaustedMarker(index, label) {
  return { agentCallBudgetExhausted: true, attemptedIndex: index, label: label, budget: C.maxAgentCalls };
}

function isBudgetExhausted(value) {
  return isObject(value) && value.agentCallBudgetExhausted === true;
}

async function runBudgetedAgent(prompt, options) {
  const index = agentCalls.length + 1;
  const entry = { index: index, label: options.label, phase: options.phase };
  if (index > C.maxAgentCalls) {
    entry.started = false;
    agentCalls.push(entry);
    log('子代理调用预算已用尽（上限 ' + C.maxAgentCalls + ' 次）：拒绝启动第 ' + index + ' 次调用「' + options.label + '」');
    return budgetExhaustedMarker(index, options.label);
  }
  entry.started = true;
  agentCalls.push(entry);
  log('子代理调用 ' + index + '/' + C.maxAgentCalls + '：' + options.label);
  return await agent(prompt, options);
}

function budgetFailure(marker) {
  const started = agentCalls.filter(function (c) { return c.started === true; }).length;
  return failure('AGENT_CALL_BUDGET_EXCEEDED',
    '子代理调用预算用完（上限 ' + C.maxAgentCalls + ' 次）：第 ' + marker.attemptedIndex + ' 次调用「' + marker.label +
    '」没有启动，工作流按预算中止；已启动 ' + started + ' 次调用的证据保留',
    {
      runId: C.runId,
      evidenceDir: C.evidenceDir,
      // 账本形状与成功返回的 agentCallBudget 一致（含 calls），失败时也能直接核对"第几次没启动"
      agentCallBudget: {
        limit: C.maxAgentCalls,
        attempted: marker.attemptedIndex,
        started: started,
        limits: AGENT_CALL_BUDGET_LIMITS_NOTE,
        calls: agentCalls.map(function (c) {
          return { index: c.index, label: c.label, phase: c.phase, started: c.started };
        })
      }
    });
}

// ---------------------------------------------------------------- 内联脚本指纹自检

/**
 * 轻量文本指纹：FNV-1a 32 位 + djb2 32 位 + 字符数，用 `-` 连接。
 * 用途只有一个：发现"内联进 workflow 调用的脚本文本与仓库文件不一致"（漏行、错行、粘贴走样）。
 * 它不是密码学校验（能被构造碰撞），也不用于安全判定——安全判定全部靠文件哈希与原始输出。
 * 期望值由 `node tests/script-fingerprint.mjs` 从仓库文件生成。
 */
function driftHash(text) {
  const value = typeof text === 'string' ? text : String(text);
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) + code) >>> 0;
  }
  return h1.toString(16) + '-' + h2.toString(16) + '-' + value.length.toString(16);
}

/** 一次调用的指纹 = 提示词指纹 + schema 指纹（schema 先稳定序列化，避免键序影响）。 */
function selfCheckValue(prompt, schema) {
  return { prompt: driftHash(prompt), schema: driftHash(JSON.stringify(schema)) };
}

/**
 * 在启动子代理**之前**比对指纹。返回 null 表示可以继续；返回失败结果表示必须中止。
 * 未提供该 label 的期望值时：`selfCheckRequired` 为真则中止（fail-closed），否则放行（旧调用方兼容）。
 * 只固定 schema 是允许的：schema 是静态的，可以在启动前从固定提交固定下来；
 * 提示词由真实需求与阶段结果拼成，只有同一轮真实输入才比对得上——未固定的字段记入
 * `scriptSelfCheck.unchecked`，不得据此声称整份脚本与仓库一致。
 */
function checkSelfCheck(label, prompt, schema) {
  const expected = isObject(C.selfCheck) ? C.selfCheck[label] : null;
  if (!isObject(expected)) {
    if (C.selfCheckRequired === true) {
      return failure('SCRIPT_DRIFT', '本次运行要求逐项比对脚本指纹，但 args.selfCheck 缺少 ' + JSON.stringify(label) + ' 的期望值',
        { runId: C.runId, evidenceDir: C.evidenceDir, label: label });
    }
    return null;
  }
  const actual = selfCheckValue(prompt, schema);
  const problems = [];
  const unchecked = [];
  const expectedPrompt = expected.prompt === undefined ? null : asString(expected.prompt);
  const expectedSchema = expected.schema === undefined ? null : asString(expected.schema);
  if (expectedSchema === null) {
    unchecked.push('schema');
  } else if (expectedSchema !== actual.schema) {
    problems.push('schema 指纹不一致（期望 ' + JSON.stringify(expectedSchema) + '，实际 ' + actual.schema + '）');
  }
  if (expectedPrompt === null) {
    unchecked.push('prompt');
  } else if (expectedPrompt !== actual.prompt) {
    problems.push('提示词指纹不一致（期望 ' + JSON.stringify(expectedPrompt) + '，实际 ' + actual.prompt + '）');
  }
  if (problems.length === 0) {
    if (unchecked.length > 0) {
      scriptSelfCheckUnchecked.push({ label: label, fields: unchecked.slice() });
      log('脚本指纹自检：' + label + ' 未固定 ' + unchecked.join('/') + '（只作补充，不据此声称脚本与仓库一致）');
    }
    return null;
  }
  log('脚本指纹自检失败（' + label + '）：' + problems.join('；'));
  return failure('SCRIPT_DRIFT', '内联脚本与仓库文件不一致，已在启动子代理前中止：' + problems.join('；'),
    { runId: C.runId, evidenceDir: C.evidenceDir, label: label, expected: expected, actual: actual });
}

// ================================================================ 编排

phaseStatic('preflight');
log('run_id=' + C.runId + ' | evidence_dir=' + C.evidenceDir + ' | target_dir=' + C.targetDir);
log('step 1/5: Verifier (preflight) -> ' + artifact(1, 'preflight'));

const preflightPromptText = preflightPrompt(artifact(1, 'preflight'), ownerMarkerPath);
const preflightDrift = checkSelfCheck('Verifier (preflight)', preflightPromptText, PREFLIGHT_SCHEMA);
if (preflightDrift !== null) { return preflightDrift; }
const preflight = await runBudgetedAgent(preflightPromptText, {
  label: 'Verifier (preflight)',
  phase: 'preflight',
  schema: PREFLIGHT_SCHEMA
});
if (isBudgetExhausted(preflight)) { return budgetFailure(preflight); }

if (!isObject(preflight)) {
  return failure('PREFLIGHT_FAILED', '环境预检子代理失败（返回空结果），工作流终止', { runId: C.runId, evidenceDir: C.evidenceDir });
}
// 阶段检查时钟：每次 Agent 返回后**重新读取**当前时间，而不是复用启动时那一次（复审要求一）。
// 复用启动时钟会让"未来时间戳"的判定基准随运行时长过期：一个跑了很久的运行会把诚实的阶段时间戳误判为未来时间。
const preflightNowMs = currentTimeMs();
const preflightTime = judgeTimestamp(preflight.generated_at, C.runStartedAt, TIMESTAMP_WINDOW_HOURS, preflightNowMs);
if (!preflightTime.ok) {
  return failure('INVALID_TIMESTAMP', '环境预检的时间戳不可信：' + preflightTime.reason,
    { runId: C.runId, evidenceDir: C.evidenceDir, preflight: preflight });
}
if (preflight.evidence_dir_state === 'exists') {
  log('证据目录已存在且有内容，拒绝覆盖（保护历史运行证据）');
  return failure('EVIDENCE_EXISTS',
    '证据目录 ' + C.evidenceDir + ' 已存在且有内容；请使用全新的 runId 与 evidenceDir，历史证据不会被覆盖',
    { runId: C.runId, evidenceDir: C.evidenceDir, existingEntries: preflight.evidence_dir_entries || [] });
}
const missingPrompts = (Array.isArray(preflight.prompt_files) ? preflight.prompt_files : [])
  .filter(function (f) { return !isObject(f) || f.exists !== true; })
  .map(function (f) { return isObject(f) ? asString(f.path) : '(非法项)'; });
if (missingPrompts.length > 0) {
  return failure('PROMPT_MISSING', '角色提示词文件缺失：' + missingPrompts.join(', '),
    { runId: C.runId, promptDir: C.promptDir });
}
const repoRoot = normalizeAbsPath(preflight.repo_root);
const repoRootReal = normalizeAbsPath(preflight.repo_root_realpath);
const targetDirReal = normalizeAbsPath(preflight.target_dir_realpath);
const evidenceDirReal = normalizeAbsPath(preflight.evidence_dir_realpath);
const resolvedPaths = Array.isArray(preflight.resolved_paths) ? preflight.resolved_paths : [];
if (repoRoot === '' || repoRootReal === '') {
  return failure('TARGET_DIR_OUTSIDE_REPO',
    '预检未回报仓库根目录的真实路径（realpath），无法确认交付目录落在仓库内',
    { runId: C.runId, resolvedPaths: resolvedPaths, preflight: preflight });
}
// 含未规范化点段（`.` / `..`）的路径不得作为判定依据：字符串前缀比对会被 `/repo/./x` 这类写法骗过（复审要求六）。
const dotSegmentPaths = [repoRoot, repoRootReal, targetDirReal, evidenceDirReal]
  .concat((Array.isArray(preflight.link_components) ? preflight.link_components : []).map(normalizeAbsPath))
  .concat(resolvedPaths.map(normalizeAbsPath))
  .filter(function (p) { return p !== '' && hasDotSegments(p); });
if (dotSegmentPaths.length > 0) {
  return failure('PATH_NOT_NORMALIZED',
    '预检回报的路径含未规范化的点段（`.` 或 `..`），无法据此判定是否落在仓库内：' + dotSegmentPaths.join(', '),
    { runId: C.runId, resolvedPaths: resolvedPaths, preflight: preflight });
}
// fail-closed：交付目录与证据目录「解算后的真实路径」都必须落在仓库根的真实路径之内。
if (!pathUnderRepo(targetDirReal, repoRootReal) || !pathUnderRepo(evidenceDirReal, repoRootReal)) {
  return failure('TARGET_DIR_OUTSIDE_REPO',
    '交付目录或证据目录的真实路径不在仓库根之内（target=' + targetDirReal + '；evidence=' + evidenceDirReal + '；repo=' + repoRootReal + '）',
    { runId: C.runId, resolvedPaths: resolvedPaths, preflight: preflight });
}
// 解算后的真实路径必须与本次运行配置的目标一一对应：指向仓库内"别的目录"同样不可信（复审要求六）。
const expectedTargetReal = normalizeAbsPath(repoRootReal + '/' + C.targetDir).toLowerCase();
const expectedEvidenceReal = normalizeAbsPath(repoRootReal + '/' + C.evidenceDir).toLowerCase();
const pathTargetProblems = [];
if (normalizeRelPath(preflight.target_dir) !== C.targetDir) {
  pathTargetProblems.push('target_dir 报告为 ' + JSON.stringify(preflight.target_dir) + '，本次配置是 ' + JSON.stringify(C.targetDir));
}
if (targetDirReal.toLowerCase() !== expectedTargetReal) {
  pathTargetProblems.push('target_dir_realpath 报告为 ' + targetDirReal + '，按配置应为 ' + expectedTargetReal);
}
if (evidenceDirReal.toLowerCase() !== expectedEvidenceReal) {
  pathTargetProblems.push('evidence_dir_realpath 报告为 ' + evidenceDirReal + '，按配置应为 ' + expectedEvidenceReal);
}
if (pathTargetProblems.length > 0) {
  return failure('PATH_TARGET_MISMATCH',
    '预检回报的解算路径与本次运行配置的目标不对应：' + pathTargetProblems.join('；'),
    { runId: C.runId, targetDir: C.targetDir, evidenceDir: C.evidenceDir, resolvedPaths: resolvedPaths, preflight: preflight });
}
// 路径分量中的软链接 / 目录联接若解算后越出仓库，直接终止（复审意见五：链接逃逸）。
const linkComponents = Array.isArray(preflight.link_components) ? preflight.link_components : [];
const escapingLinks = linkComponents.map(normalizeAbsPath).filter(function (p) {
  return p !== '' && !pathUnderRepo(p, repoRootReal);
});
if (escapingLinks.length > 0) {
  return failure('LINK_ESCAPE',
    '工作目录路径中存在解算后越出仓库的重解析点（软链接 / 目录联接）：' + escapingLinks.join(', '),
    { runId: C.runId, linkComponents: linkComponents, preflight: preflight });
}
// 认领必须由排他创建工具真实完成：只报告 claimed=true 不算证据（复审要求二）。
const claimProblems = [];
if (preflight.evidence_dir_claimed !== true) {
  claimProblems.push('evidence_dir_claimed 不是 true');
}
if (asString(preflight.claim_tool) !== EVIDENCE_CLAIM_TOOL) {
  claimProblems.push('claim_tool 报告为 ' + JSON.stringify(preflight.claim_tool) +
    '，本次运行只承认 ' + JSON.stringify(EVIDENCE_CLAIM_TOOL) + ' 的排他创建结果');
}
// 认领前后状态必须分开：`evidence_dir_state` 是预检自己在认领**之前**观察到的状态，
// `evidence_dir_state_before` 是排他创建工具在**创建认领文件之前**读到的权威状态（复审要求二）。
// 两者不一致说明报告与工具结果对不上；认领前的状态只接受 missing / empty（有内容的目录工具会拒绝认领）。
// 认领之后目录里会有 `.run-owner.json`（这就是"认领后"的状态，属正常，不作为 EVIDENCE_EXISTS 判据）。
const claimStateBefore = asString(preflight.evidence_dir_state_before);
if (claimStateBefore !== 'missing' && claimStateBefore !== 'empty') {
  claimProblems.push('认领工具回报的认领前状态 evidence_dir_state_before=' +
    JSON.stringify(preflight.evidence_dir_state_before) + '（只接受 missing / empty：已有内容的目录不得被认领）');
}
if (claimStateBefore !== asString(preflight.evidence_dir_state)) {
  claimProblems.push('预检自报的认领前状态 evidence_dir_state=' + JSON.stringify(preflight.evidence_dir_state) +
    ' 与认领工具回报的 evidence_dir_state_before=' + JSON.stringify(preflight.evidence_dir_state_before) + ' 不一致');
}
if (preflight.claim_created !== true) {
  claimProblems.push('claim_created 不是 true（认领文件已存在或创建失败：已有认领不得覆写）');
}
if (preflight.claim_exit_code !== 0) {
  claimProblems.push('claim_exit_code 报告为 ' + JSON.stringify(preflight.claim_exit_code) + '，排他创建没有成功');
}
// 认领时间必须落在本次运行窗口内：否则报上来的可能是别的运行（或很久以前）留下的旧认领文件。
const claimedAt = asString(preflight.claimed_at);
const claimNowMs = currentTimeMs();
const claimTime = claimedAt === ''
  ? { ok: false, reason: '未回报认领时间' }
  : judgeTimestamp(claimedAt, C.runStartedAt, TIMESTAMP_WINDOW_HOURS, claimNowMs);
if (!claimTime.ok) {
  claimProblems.push('claimed_at 不可信（' + claimTime.reason + '）：认领可能不属于本次运行');
}
if (!ownerMarkerPathMatches(preflight.owner_marker_path, repoRootReal, ownerMarkerPath)) {
  claimProblems.push('owner_marker_path 报告为 ' + JSON.stringify(preflight.owner_marker_path) +
    '，本次运行应为 ' + JSON.stringify(ownerMarkerPath) + '（或由同一个仓库根解算出的同一文件的绝对路径）');
}
if (claimProblems.length > 0) {
  return failure('EVIDENCE_NOT_CLAIMED',
    '预检未能证明证据目录由本次运行独占（' + claimProblems.join('；') + '）；为防止两个运行同时写入同一目录，已终止',
    { runId: C.runId, evidenceDir: C.evidenceDir, ownerMarkerPath: ownerMarkerPath, preflight: preflight });
}
// 预检报告的 problems 只要非空就终止：任何"可能有问题"的观察都必须先由人处理，不得带病运行（复审要求二）。
const preflightProblems = Array.isArray(preflight.problems) ? preflight.problems : [];
if (preflightProblems.length > 0) {
  const described = preflightProblems.map(function (p) {
    return hasText(p) ? asString(p) : '(空项或非字符串：' + JSON.stringify(p) + ')';
  });
  return failure('PREFLIGHT_PROBLEMS',
    '环境预检报告了 ' + preflightProblems.length + ' 个问题，必须先由人处理后才能运行：' + described.join('；'),
    { runId: C.runId, evidenceDir: C.evidenceDir, problems: described, preflight: preflight });
}
log('环境预检通过：repo_root=' + repoRoot + ' | 证据目录状态=' + preflight.evidence_dir_state +
  ' | 交付目录状态=' + preflight.target_dir_state);

phaseStatic('requirement');
log('step 2/5: Requirement Agent -> ' + artifact(1, 'requirement'));

const requirementPromptText = requirementPrompt(artifact(1, 'requirement'));
const requirementDrift = checkSelfCheck('Requirement Agent', requirementPromptText, REQUIREMENT_SCHEMA);
if (requirementDrift !== null) { return requirementDrift; }
const requirement = await runBudgetedAgent(requirementPromptText, {
  label: 'Requirement Agent',
  phase: 'requirement',
  schema: REQUIREMENT_SCHEMA
});
if (isBudgetExhausted(requirement)) { return budgetFailure(requirement); }

if (!isObject(requirement) || !hasText(requirement.goal) ||
    !hasItems(requirement.acceptance_criteria) || !hasItems(requirement.boundary_conditions)) {
  return failure('REQUIREMENT_OUTPUT_INVALID',
    'Requirement Agent 输出不完整或子代理失败（goal/acceptance_criteria/boundary_conditions 缺失）',
    { runId: C.runId, evidenceDir: C.evidenceDir, received: requirement });
}
const requirementNowMs = currentTimeMs();
const requirementTime = judgeTimestamp(requirement.generated_at, C.runStartedAt, TIMESTAMP_WINDOW_HOURS, requirementNowMs);
if (!requirementTime.ok) {
  return failure('INVALID_TIMESTAMP', '需求阶段的时间戳不可信：' + requirementTime.reason,
    { runId: C.runId, evidenceDir: C.evidenceDir, requirement: requirement });
}
const requirementConsistency = judgeRequirementConsistency(requirement);
if (hasItems(requirementConsistency.idErrors)) {
  return failure('REQUIREMENT_IDS_INVALID',
    '需求中的验收条件 ID 不合法（缺失或重复），无法逐项核对：' + requirementConsistency.idErrors.join('；'),
    { runId: C.runId, evidenceDir: C.evidenceDir, requirement: requirement, idErrors: requirementConsistency.idErrors });
}
if (!requirementConsistency.ok) {
  log('需求自检报告冲突，停止实施并等待人工澄清（不会交给 Coding Agent 自行选择解释）');
  return failure('REQUIREMENT_CONFLICT',
    'Requirement Agent 的一致性自检发现无法同时满足的规则，工作流停止实施，等待人工澄清',
    { runId: C.runId, evidenceDir: C.evidenceDir, requirement: requirement, conflicts: requirementConsistency.conflicts });
}
log('Requirement Agent 完成：验收条件 ' + requirement.acceptance_criteria.length +
  ' 条（ID ' + requirementConsistency.criteriaIds.join('、') + '）、边界条件 ' +
  requirement.boundary_conditions.length + ' 条、自检冲突 0 条');

/** 验收条件 ID 的权威集合：缺失 / 重复 / 未知一律不得通过（复审意见四）。 */
const expectedCriteriaIds = requirementConsistency.criteriaIds;
/** 配置指定的交付文件清单：指纹清单必须"恰好"覆盖这两个文件（复审要求一）。 */
const deliveryFiles = (C.targetDir === null || C.moduleFile === null || C.testFile === null)
  ? []
  : [C.targetDir + '/' + C.moduleFile, C.targetDir + '/' + C.testFile];
const attemptsDetail = [];
let previousReview = null;
let attempt = 1;
let lastDecision = null;

while (attempt <= C.maxCodingAttempts) {
  const revTag = attempt > 1 ? ' (revision ' + attempt + ')' : '';

  phaseStatic('coding' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 3/5: Coding Agent' + revTag + ' -> ' + artifact(attempt, 'coding-report'));

  const codingLabel = 'Coding Agent' + revTag;
  const codingPromptText = codingPrompt(attempt, previousReview);
  const codingDrift = checkSelfCheck(codingLabel, codingPromptText, CODING_SCHEMA);
  if (codingDrift !== null) { return codingDrift; }

  const codingReport = await runBudgetedAgent(codingPromptText, {
    label: codingLabel,
    phase: 'coding' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: CODING_SCHEMA
  });
  if (isBudgetExhausted(codingReport)) { return budgetFailure(codingReport); }
  const codingOutputValid = isObject(codingReport) && hasItems(codingReport.files_created);
  const codingNowMs = currentTimeMs();
  // Coding 自述的内部一致性（命令 / 退出码 / test_succeeded）：报告"看起来可用"也不能自相矛盾（复审要求四）。
  const codingConsistency = judgeCodingReportConsistency(codingReport, C.testCommand);
  if (!codingConsistency.ok) {
    log('Coding Agent' + revTag + ' 的测试自述内部不一致：' + codingConsistency.reasons.join('；'));
  }
  if (codingOutputValid) {
    const codingTime = judgeTimestamp(codingReport.generated_at, C.runStartedAt, TIMESTAMP_WINDOW_HOURS, codingNowMs);
    if (!codingTime.ok) {
      return failure('INVALID_TIMESTAMP', '编码阶段的时间戳不可信：' + codingTime.reason,
        { runId: C.runId, evidenceDir: C.evidenceDir, attempt: attempt, received: codingReport });
    }
    log('Coding Agent' + revTag + ' 完成：文件 ' + codingReport.files_created.length +
      ' 个，自述测试 ' + (codingReport.test_succeeded ? '通过' : '未通过') + '（exit=' + codingReport.test_exit_code + '）');
  } else {
    log('Coding Agent' + revTag + ' 未返回可用的实现报告（继续走独立验证与审核，最终判定为不通过）');
  }

  phaseStatic('verify' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 4/5: Verifier (verify)' + revTag + ' -> ' + artifact(attempt, 'verify'));

  const verifyLabel = 'Verifier (verify)' + revTag;
  const verifyPromptText = verifyPrompt(artifact(attempt, 'verify'));
  const verifyDrift = checkSelfCheck(verifyLabel, verifyPromptText, VERIFY_SCHEMA);
  if (verifyDrift !== null) { return verifyDrift; }

  const verification = await runBudgetedAgent(verifyPromptText, {
    label: verifyLabel,
    phase: 'verify' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: VERIFY_SCHEMA
  });
  if (isBudgetExhausted(verification)) { return budgetFailure(verification); }
  const verificationJudge = judgeTestEvidence(verification, C.testCommand);
  const verifyNowMs = currentTimeMs();
  if (isObject(verification)) {
    const verifyTime = judgeTimestamp(verification.generated_at, C.runStartedAt, TIMESTAMP_WINDOW_HOURS, verifyNowMs);
    verificationJudge.timestampOk = verifyTime.ok;
    if (!verifyTime.ok) { verificationJudge.passed = false; verificationJudge.reasons.push(verifyTime.reason); }
  }
  log('Verifier' + revTag + ' 判定：' + (verificationJudge.passed ? '测试通过（外部独立验证）' : '未通过'));

  phaseStatic('review' + (attempt > 1 ? '-revision-' + attempt : ''));
  log('step 5/5: Review Agent' + revTag + ' -> ' + artifact(attempt, 'review'));

  const reviewLabel = 'Review Agent' + revTag;
  const reviewPromptText = reviewPrompt(attempt, codingReport, verification, artifact(attempt, 'review'));
  const reviewDrift = checkSelfCheck(reviewLabel, reviewPromptText, REVIEW_SCHEMA);
  if (reviewDrift !== null) { return reviewDrift; }

  const review = await runBudgetedAgent(reviewPromptText, {
    label: reviewLabel,
    phase: 'review' + (attempt > 1 ? '-revision-' + attempt : ''),
    schema: REVIEW_SCHEMA
  });
  if (isBudgetExhausted(review)) { return budgetFailure(review); }
  const reviewNowMs = currentTimeMs();
  if (isObject(review)) {
    const reviewTime = judgeTimestamp(review.generated_at, C.runStartedAt, TIMESTAMP_WINDOW_HOURS, reviewNowMs);
    if (!reviewTime.ok) {
      review.consistency_note = asString(review.consistency_note) + ' [编排层：' + reviewTime.reason + ']';
      review.verdict = 'CHANGES_REQUESTED';
    }
  }

  // 缓存账本只使用各阶段子代理自报的 before/after 清单：
  // 不再为"读文件指纹"启动额外子代理——工作流脚本没有文件系统 API（宿主限制），
  // 而为一个只读快照付一次完整模型调用（v0.2-run2 每轮一次，共 2 次）性价比不合理，
  // 也是那次运行 10 次调用超过批准 8 次的直接原因。Review 返回之后的写入属于覆盖盲区，
  // 由运行结束后确定性工具 tests/collect-cache-state.py 生成的 cache-postrun.json 补充（不参与门禁）。
  const cachePrefix = C.targetDir === null ? CACHE_DIR_NAME : C.targetDir + '/' + CACHE_DIR_NAME;
  const bytecodeVerdict = judgeBytecodeRun({
    baseline: C.cacheBaseline,
    coding: codingReport,
    verification: verification,
    review: review
  }, cachePrefix);
  if (!bytecodeVerdict.ok) {
    log('第 ' + attempt + ' 轮运行期写入边界：' + bytecodeVerdict.status + '（' + bytecodeVerdict.reasons.join('；') + '）');
  }
  const decision = judgeAttempt(codingReport, verification, review, expectedCriteriaIds, C.testCommand,
    { outputValid: codingOutputValid, consistency: codingConsistency }, verificationJudge, deliveryFiles, bytecodeVerdict);
  if (!decision.ok) { reportProblems('第 ' + attempt + ' 轮判定未通过', decision.reasons); }
  log('第 ' + attempt + ' 轮判定：' + (decision.ok ? 'PASS' : decision.status));

  attemptsDetail.push({
    attempt: attempt,
    codingReport: codingReport,
    verification: verification,
    review: review,
    decision: decision
  });
  lastDecision = decision;

  if (decision.ok) { break; }
  if (hasItems(decision.stageConflicts)) {
    log('有阶段报告了未解决的需求冲突：本轮不进入修订循环（需求冲突无法由 Coding Agent 自行修复，须人工统一口径）');
    break;
  }
  if (attempt >= C.maxCodingAttempts) {
    log('已达到最大编码轮次（' + C.maxCodingAttempts + '），工作流以不通过结束并保留全部证据');
    break;
  }

  if (isObject(review)) {
    // 复制后再追加编排层的意见：否则会改写已存档的 Review 结论，使返回值与磁盘 review.json 不一致（审核发现）。
    previousReview = Object.assign({}, review);
    previousReview.issues = Array.isArray(review.issues) ? review.issues.slice() : [];
  } else {
    previousReview = {
      verdict: 'CHANGES_REQUESTED',
      issues: [{ file: '(unknown)', location: '-',
        problem: 'Review Agent 本次未返回结构化结论', suggestion: '重新运行审核并确认输出符合 schema' }],
      summary: 'Review Agent 未返回有效结论（子代理失败）'
    };
  }
  if (hasItems(decision.reasons)) {
    previousReview.issues = (Array.isArray(previousReview.issues) ? previousReview.issues : []).concat([
      { file: '(编排层判定)', location: '第 ' + attempt + ' 轮',
        problem: decision.reasons.join('；'), suggestion: '按上述原因修复后重新提交本轮证据' }
    ]);
  }
  attempt = attempt + 1;
}

const finalAttempt = attemptsDetail[attemptsDetail.length - 1];
const finalOk = isObject(finalAttempt) && finalAttempt.decision.ok === true;
const verifiedFinal = isObject(finalAttempt) ? finalAttempt.decision.verified : { passed: false, reasons: ['无有效轮次'] };
const reviewFinal = isObject(finalAttempt) ? finalAttempt.decision.reviewEval : { approved: false, allSatisfied: false, coversAll: false, ownTestsPassed: false, criteriaTotal: 0, criteriaSatisfied: 0, reasons: ['无有效轮次'] };
let status = finalOk ? 'OK' : (isObject(finalAttempt) ? finalAttempt.decision.status : 'NO_ATTEMPT');
const finalStageConflicts = isObject(finalAttempt) ? (finalAttempt.decision.stageConflicts || []) : [];
const finalFingerprints = isObject(finalAttempt) ? finalAttempt.decision.fingerprints : null;
if (!finalOk && C.maxCodingAttempts > 1 && attemptsDetail.length >= C.maxCodingAttempts &&
    finalStageConflicts.length === 0) {
  status = 'MAX_ATTEMPTS_' + status;
}

return {
  ok: finalOk,
  status: status,
  // 工作流脚本没有文件系统 API：它能看到的最后一个缓存观测点是 Review 自报的执行后清单。
  // 因此这里的 ok 只能是"运行内暂定结果"，最终是否通过由外层确定性工具比对
  // 运行前基线 / 各阶段观测点 / 运行后 postrun 快照 之后判定（不启动任何模型代理）。
  verdict: finalOk ? 'PROVISIONAL_OK' : 'PROVISIONAL_FAIL',
  verdictScope: 'provisional-in-run',
  verdictMeaning: finalOk
    ? '运行内暂定结果：Review 返回之后的缓存写入未被观测，最终通过需要外层缓存边界判定'
    : '运行内暂定失败：脚本按契约中止；原始证据保留，最终判定仍由外层复核给出',
  // 失败原因同样要回传（编排层判定不得只给状态码，复审意见四）。
  error: finalOk ? '' : (isObject(finalAttempt) ? finalAttempt.decision.reasons.join('；') : '没有任何有效轮次'),
  errors: isObject(finalAttempt) ? finalAttempt.decision.reasons : ['没有任何有效轮次'],
  runId: C.runId,
  evidenceDir: C.evidenceDir,
  ownerMarkerPath: ownerMarkerPath,
  runStartedAt: C.runStartedAt,
  pipeline: ['Verifier(preflight)', 'Requirement Agent', 'Coding Agent', 'Verifier(verify)', 'Review Agent'],
  targetDir: C.targetDir,
  testCommand: C.testCommand,
  cacheBaseline: C.cacheBaseline,
  cacheDirPrefix: C.targetDir === null ? CACHE_DIR_NAME : C.targetDir + '/' + CACHE_DIR_NAME,
  // 命令与执行环境分开记录：环境不改变规范化命令本身，也不放开任意 shell。
  testEnvironment: testEnvironment(),
  testExecutionCommand: executionTestCommand(C.testCommand),
  // 内联脚本指纹自检的结果范围：enabled=true 时按 args.selfCheck 逐项比对；
  // unchecked 列出"没有固定期望值所以没比对"的字段（部分比对不得说成全部比对）。
  scriptSelfCheck: {
    enabled: isObject(C.selfCheck),
    required: C.selfCheckRequired === true,
    labels: isObject(C.selfCheck) ? Object.keys(C.selfCheck).sort() : [],
    unchecked: scriptSelfCheckUnchecked.slice()
  },
  maxCodingAttempts: C.maxCodingAttempts,
  // 调用预算与实际启动记录：预算在每次启动前检查，台账是"实际启动了几次"的权威记录。
  // 这里能强制限制的是"启动多少次子代理"，不能限制单个子代理内部的 token 消耗。
  agentCallBudget: {
    limit: C.maxAgentCalls,
    started: agentCalls.filter(function (c) { return c.started === true; }).length,
    attempted: agentCalls.length,
    calls: agentCalls.map(function (c) {
      return { index: c.index, label: c.label, phase: c.phase, started: c.started };
    }),
    limits: AGENT_CALL_BUDGET_LIMITS_NOTE
  },
  // 运行结束后必须由确定性本地工具补充的缓存快照（不是子代理，不产生调用）。
  postRunCacheSnapshot: {
    required: true,
    tool: 'python tests/collect-cache-state.py',
    path: C.evidenceDir + '/cache-postrun.json',
    note: '工作流脚本没有文件系统 API，无法自己读取文件指纹；Review 返回之后的写入只能事后补充采集。'
  },
  criteriaIds: expectedCriteriaIds,
  evidenceFiles: attemptsDetail.reduce(function (list, d) {
    return list.concat([
      artifact(d.attempt, 'coding-report'),
      artifact(d.attempt, 'verify'),
      artifact(d.attempt, 'review')
    ]);
  }, [ownerMarkerPath, artifact(1, 'preflight'), artifact(1, 'requirement')]),
  attempts: attemptsDetail.length,
  originalRequirement: originalRequirement,
  requirement: requirement,
  requirementSelfCheck: isObject(requirement) ? requirement.consistency_check : null,
  preflight: preflight,
  attemptsDetail: attemptsDetail.map(function (d) {
    return {
      attempt: d.attempt,
      codingReport: d.codingReport,
      verification: d.verification,
      review: d.review,
      decision: { ok: d.decision.ok, status: d.decision.status, reasons: d.decision.reasons },
      selfReportVsVerified: d.decision.selfReportVsVerified,
      bytecodeScope: d.decision.bytecode
    };
  }),
  finalVerdict: isObject(finalAttempt) && isObject(finalAttempt.review) ? finalAttempt.review.verdict : null,
  finalReview: isObject(finalAttempt) ? finalAttempt.review : null,
  finalDecision: {
    ok: finalOk,
    status: status,
    testsIndependentlyVerified: verifiedFinal.passed === true,
    testsVerificationReasons: verifiedFinal.reasons,
    reviewApproved: reviewFinal.approved === true,
    criteriaSatisfied: reviewFinal.criteriaSatisfied,
    criteriaTotal: reviewFinal.criteriaTotal,
    allCriteriaSatisfied: reviewFinal.allSatisfied === true,
    criteriaCheckCoversAll: reviewFinal.coversAll === true,
    reviewIndependentTestsPassed: reviewFinal.ownTestsPassed === true,
    fingerprintsMatch: isObject(finalFingerprints) ? finalFingerprints.ok === true : false,
    fingerprintReasons: isObject(finalFingerprints) ? finalFingerprints.reasons : ['无有效轮次'],
    bytecodeScopeOk: isObject(finalAttempt) && isObject(finalAttempt.decision.bytecode)
      ? finalAttempt.decision.bytecode.ok === true : false,
    bytecodeScopeStatus: isObject(finalAttempt) && isObject(finalAttempt.decision.bytecode)
      ? finalAttempt.decision.bytecode.status : 'BYTECODE_SCOPE_UNMEASURED',
    bytecodeScopeReasons: isObject(finalAttempt) && isObject(finalAttempt.decision.bytecode)
      ? finalAttempt.decision.bytecode.reasons : ['无有效轮次'],
    cachePoints: isObject(finalAttempt) && isObject(finalAttempt.decision.bytecode)
      ? (finalAttempt.decision.bytecode.points || []) : [],
    cacheChanges: isObject(finalAttempt) && isObject(finalAttempt.decision.bytecode)
      ? (finalAttempt.decision.bytecode.changes || []) : [],
    cacheCoverage: isObject(finalAttempt) && isObject(finalAttempt.decision.bytecode)
      ? (finalAttempt.decision.bytecode.coverage || null) : null,
    stageReportedRequirementConflicts: finalStageConflicts,
    criteriaIds: expectedCriteriaIds
  }
};
