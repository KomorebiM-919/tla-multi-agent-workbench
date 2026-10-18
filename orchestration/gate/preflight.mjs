// orchestration/gate/preflight.mjs
//
// 启动前的"保护是否真的生效"判定。
//
// 这一层的存在理由：闸门（gate.mjs）只有在**宿主确实把模型请求发给它**时才算
// 保护生效。以下几种情况都会让闸门形同不存在：
//   1. 宿主生效配置里的 baseURL 被改回真实端点；
//   2. 拦截插件根本没挂上（apply 抛错 / 未安装 / 版本不兼容）；
//   3. 插件挂上了但从不心跳（进程卡住、配置写错路径）；
//   4. 同一个宿主里还有别的模型 provider 实例没指向闸门。
// 因此判定必须同时看四件事，而不是看某个布尔变量：
//   - 闸门在监听（能连上 status 接口）；
//   - **所有**已启用的模型 provider 实例的 baseURL 都指向闸门（且至少有一个）；
//   - 本次运行（runId）写下了 mounted，且其后没有 unmounted；
//   - 心跳新鲜（证明该运行实例还在活动）。
//
// 任何一项不成立都必须**阻止启动**（不是"先跑起来再看看"）。
//
// 配置解析策略（2026-10-18 审查 P0-4）：不使用正则逐行"找字符"，而是把
// `--dump-config` 的输出当作结构化文档解析成一个**受限子集**：
//   - 只支持块式 YAML：顶层是映射序列，`key: value`，缩进为 2 空格倍数的
//     嵌套映射与序列，纯量支持引号字符串/布尔/null/数字；
//   - 显式拒绝：制表符缩进、流式集合（`{...}`/`[...]`）、锚点/别名（`&`/`*`）、
//     多文档分隔符（`---`）、重复键、无法归类的内容；
//   - 拒绝即"不可验证"，调用方必须拒绝启动（fail-closed），不做"跳过坏行继续"。
//
// 本仓库未引入 YAML 解析依赖（离线核对：工作树内没有依赖 YAML 的 package.json，
// 隔离 profile 的 node_modules 里也没有 yaml/js-yaml）；按"不新增依赖"的约束，
// 这里实现受限子集解析器，并用"未知形态一律拒绝"来换取它的可审计性。

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { GateError } from './gate.mjs';
import { KNOWN_COMPONENT_NAMES } from './known-components.mjs';

export const PREFLIGHT_SCHEMA = 'tla.gate-preflight/v1';
export const PREFLIGHT_BLOCKERS = [
  'GATE_NOT_READY',
  'BASE_URL_MISMATCH',
  'HEARTBEAT_MISSING',
  'HEARTBEAT_STALE',
  'PROVIDER_NOT_GATED',
  'PROVIDER_UNKNOWN',
  'PLUGIN_NOT_VERIFIED',
  'NO_GATED_PROVIDER',
  'COVERAGE_UNVERIFIABLE',
  'CONFIG_UNPARSEABLE',
  'CONFIG_UNREADABLE',
];

// 受信任的模型 provider 适配器清单（保守识别）：
// - 已知 provider：必须显式指向闸门才算受保护；
// - 已知非 provider（共享管线）：不参与覆盖率判定；
// - 其余 `@deepseek-ai/dsh-llm-*` 一律记为 unknown → 拒绝启动，绝不静默跳过。
export const KNOWN_PROVIDER_ADAPTERS = {
  '@deepseek-ai/dsh-llm-deepseek-api-key': { route: 'deepseek-official', aggregator: false },
  '@deepseek-ai/dsh-llm-deepseek-account': { route: 'deepseek-account', aggregator: false },
  '@deepseek-ai/dsh-llm-pi-ai': { route: 'pi-ai', aggregator: true },
};
export const KNOWN_NON_PROVIDER_ADAPTERS = new Set([
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-llm',
]);
// 已审查过、确认不会自行发起模型请求的第三方组件。每一项都必须带证据，
// 而不是"名字里没有 llm"或"看起来像"。登记的是**固定版本 + 构建指纹**：
// 名字和配置里声明的版本都不算证据，必须从宿主实际解析到的包目录读版本与
// 文件指纹；版本不符、身份读不出、内容变了都要拒绝启动。指纹口径：
// 包根下**所有普通文件**（跳过 node_modules/.git）按相对路径排序，
// 取 sha256(Σ"<文件 sha256>  <相对路径>\n")。之所以从"只算 .js/.mjs/.cjs/.json"
// 改为"所有文件"，是因为宿主真正加载的是 `package.json` 的 `dsh.bundle.patch`
// 指向的 YAML 覆盖层：只算 JS/JSON 时，改掉 cordis.patch.yml 指纹不变。
// 若包内出现符号链接、或声明的入口文件不存在/越出包根，一律判为不可核对
// （PLUGIN_IDENTITY_UNSUPPORTED_ENTRY / PLUGIN_IDENTITY_LINK_UNSUPPORTED），
// 不静默跳过。
// 这是**本地完整性核对**，防的是"装错了版本/包被换过"，不是防恶意本机管理员
// ——能被本机管理员同时改写包和本表的人可以绕过它。它也不覆盖运行时依赖解析
// （peer/外部依赖）与原生二进制内容之外的行为。
// 本项目的"出勤"插件：overlay 通过 `insert:` 注入，宿主不会给它补 `name`。覆盖率判定必须
// 认识它，否则闸门会把自己的证明插件当成未知模型适配器而拒绝启动。
export const ATTENDANCE_PLUGIN_ID = 'tla-prelaunch-budget';

export const REVIEWED_PLUGIN_EVIDENCE = Object.freeze({
  'tla-prelaunch-budget': Object.freeze({
    version: '0.0.0-local',
    buildDigest: '54f1a8e32f717f52d563ba368713c744c3bde486afeb3f3d133052a0a027e43d',
    fileCount: 3,
    bundlePatch: null,
    reviewedFor: '本仓库的预算拦截器（profile overlay insert 挂载）',
    evidence: Object.freeze([
      'listener 只读 agent/request 的配置并在发起前同步预占额度，然后 return next()',
      '模块不 import 任何 HTTP/LLM 客户端，不读凭据，不写仓库文件',
      '挂载时先写 mounted、紧接着写一次 heartbeat，再开始定时心跳（否则首个请求落在 mounted 与首个定时心跳之间的窗口会被判 PROOF_NO_HEARTBEAT）',
    ]),
  }),
  '@nanmicoder/dsh-agent-teams': Object.freeze({
    version: '0.1.23',
    buildDigest: 'e97e31807710852fd6ef45f433d91aaec174c183cd38d30bd305fb4d795eb29c',
    fileCount: 123,
    bundlePatch: Object.freeze({
      path: 'cordis.patch.yml',
      sha256: '699b8ba773693205db637a5fea7c0c9e38ce1668a148e347beb0ea4339c2079b',
    }),
    reviewedFor: '团队执行后端候选（隔离 profile `stage1` 内 0.1.23）',
    evidence: Object.freeze([
      '安装包 lib/ 22 个 js 全文扫描：0 处 baseURL、0 处 llm.stream、0 处 llm.prepareCall、0 处 apiKey、无 Authorization 头构造',
      '只调用 ctx.llm.listModels / ctx.llm.resolveCallConfig（members.js:89、:404）做目录与调用配置解析，不发模型请求',
      '唯一的 fetch 在 client.js（浏览器 bundle）里，指向宿主自身的相对路由 /plugins/dsh-agent-teams/{plan,halt}，由 authenticatedWebRoutes 注册并要求宿主连接鉴权',
      '真正的模型请求由它通过 ctx.subagents 派生的子代理在宿主 AgentLoop 内发起，因此仍走 agent/request 与同一道闸门',
    ]),
  }),
});
// 升级到未登记版本时不能自动放行：名字在表里也要按登记的版本判断。
export const REVIEWED_PLUGIN_NAMES = new Set(Object.keys(REVIEWED_PLUGIN_EVIDENCE));

export const PLUGIN_IDENTITY_SCHEMA = 'tla.plugin-identity/v1';
export const PLUGIN_IDENTITY_STATUSES = [
  'verified',
  'unregistered',
  'identity-unreadable',
  'identity-unsupported',
  'version-mismatch',
  'build-mismatch',
];

// 只读取文件内容算指纹；不执行包内代码。
// 覆盖范围：包根下所有普通文件（跳过 node_modules/.git），因此 bundle 覆盖层
// （如 cordis.patch.yml）、manifest、入口与资产都在内。包内出现符号链接、
// 声明的 bundle patch 越出包根或不存在时，返回 ok:false（不可核对）。
export function fingerprintPluginDir(pkgDir) {
  const pkgFile = pkgDir + '/package.json';
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    return { ok: false, reason: 'PLUGIN_IDENTITY_UNREADABLE', detail: '读不出 ' + pkgFile + '：' + error.message };
  }
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
    return { ok: false, reason: 'PLUGIN_IDENTITY_UNREADABLE', detail: pkgFile + ' 里没有 version 字段' };
  }

  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error('读不出目录 ' + dir + '：' + error.message);
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error('包内符号链接不受支持：' + childRel + '（不跟随、不跳过）');
      }
      if (entry.isDirectory()) {
        walk(dir + '/' + entry.name, childRel);
      } else if (entry.isFile()) {
        const digest = createHash('sha256').update(readFileSync(dir + '/' + entry.name)).digest('hex');
        files.push({ path: childRel, sha256: digest });
      }
    }
  };

  try {
    walk(pkgDir, '');
  } catch (error) {
    return { ok: false, reason: 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY', detail: error.message };
  }
  if (files.length === 0) {
    return { ok: false, reason: 'PLUGIN_IDENTITY_UNREADABLE', detail: '包内没有可核对的文件：' + pkgDir };
  }

  const bundlePatchRel = manifest.dsh?.bundle?.patch ?? null;
  if (bundlePatchRel !== null) {
    if (typeof bundlePatchRel !== 'string' || bundlePatchRel.trim() === '') {
      return { ok: false, reason: 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY', detail: 'package.json 的 dsh.bundle.patch 不是非空字符串' };
    }
    const normalized = bundlePatchRel.replace(/^\.\//, '');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      return { ok: false, reason: 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY', detail: 'dsh.bundle.patch 越出包根：' + bundlePatchRel };
    }
    if (!files.some((file) => file.path === normalized)) {
      return { ok: false, reason: 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY', detail: 'dsh.bundle.patch 指向的文件不存在：' + bundlePatchRel };
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = files.map((file) => file.sha256 + '  ' + file.path + '\n').join('');
  const bundleFile = bundlePatchRel === null ? null : files.find((file) => file.path === bundlePatchRel.replace(/^\.\//, ''));
  return {
    ok: true,
    version: manifest.version,
    fileCount: files.length,
    buildDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
    bundlePatch: bundleFile === null || bundleFile === undefined ? null : { path: bundleFile.path, sha256: bundleFile.sha256 },
  };
}

// 从宿主实际解析到的包目录核对身份。配置里写的版本一律不采信。
export function verifyInstalledPlugin({ name, pkgDir = null }) {
  const expected = REVIEWED_PLUGIN_EVIDENCE[name];
  if (expected === undefined) {
    return {
      schema: PLUGIN_IDENTITY_SCHEMA,
      name,
      status: 'unregistered',
      installedVersion: null,
      declaredVersion: null,
      expectedVersion: null,
      fileCount: null,
      buildDigest: null,
      expectedBuildDigest: null,
      detail: '该组件没有登记过已审查的版本与构建指纹',
    };
  }
  return verifyPluginAgainst({ name, pkgDir, expected });
}

// 与"登记表"解耦的核对函数（测试可以用合成证据验证各个分支）。
export function verifyPluginAgainst({ name, pkgDir = null, expected }) {
  if (typeof pkgDir !== 'string' || pkgDir === '') {
    return {
      schema: PLUGIN_IDENTITY_SCHEMA,
      name,
      status: 'identity-unreadable',
      installedVersion: null,
      declaredVersion: expected.version,
      expectedVersion: expected.version,
      fileCount: null,
      buildDigest: null,
      expectedBuildDigest: expected.buildDigest,
      detail: '找不到该组件在宿主 profile 里的安装位置',
    };
  }
  const fingerprint = fingerprintPluginDir(pkgDir);
  if (fingerprint.ok !== true) {
    return {
      schema: PLUGIN_IDENTITY_SCHEMA,
      name,
      status: fingerprint.reason === 'PLUGIN_IDENTITY_UNSUPPORTED_ENTRY' ? 'identity-unsupported' : 'identity-unreadable',
      installedVersion: null,
      declaredVersion: expected.version,
      expectedVersion: expected.version,
      fileCount: null,
      buildDigest: null,
      expectedBuildDigest: expected.buildDigest,
      detail: fingerprint.detail,
    };
  }
  const base = {
    schema: PLUGIN_IDENTITY_SCHEMA,
    name,
    installedVersion: fingerprint.version,
    declaredVersion: expected.version,
    expectedVersion: expected.version,
    fileCount: fingerprint.fileCount,
    buildDigest: fingerprint.buildDigest,
    expectedBuildDigest: expected.buildDigest,
    bundlePatch: fingerprint.bundlePatch,
  };
  if (fingerprint.version !== expected.version) {
    return { ...base, status: 'version-mismatch', detail: '审查版本 ' + expected.version + '，实际安装 ' + fingerprint.version };
  }
  if (fingerprint.buildDigest !== expected.buildDigest) {
    return {
      ...base,
      status: 'build-mismatch',
      detail: '版本相同但构建内容不同：' + fingerprint.fileCount + ' 个文件，指纹 ' + fingerprint.buildDigest.slice(0, 16) + '…，审查时为 ' + expected.buildDigest.slice(0, 16) + '…',
    };
  }
  return { ...base, status: 'verified', detail: null };
}

// 随包组件里"名字不带 `dsh-llm-` 前缀、但自己持有模型端点配置"的特例。
// 白名单只能证明组件在默认 profile 里存在，不能证明它不调用模型；下面两个
// 组件都持有可指向真实模型服务的端点是宿主源码里的事实：
// - `@deepseek-ai/dsh-web-search-deepseek`：默认 baseURL 为
//   `https://api.deepseek.com/anthropic/v1`，请求 `${baseURL}/messages`；
// - `@deepseek-ai/dsh-deepseek-account-platform`：默认 `inferenceOrigin` 为
//   `https://api.deepseek.com`，本机代理再把推理请求转发到该地址。
// 因此它们只有在"端点显式指向闸门"或"被禁用"时才算受保护，否则一律 unguarded。
export const MODEL_ENDPOINT_COMPONENTS = {
  '@deepseek-ai/dsh-web-search-deepseek': ['baseURL'],
  '@deepseek-ai/dsh-deepseek-account-platform': ['inferenceOrigin'],
};

const YAML_SCALAR_TRUE = new Set(['true', 'True', 'TRUE', 'yes', 'on']);
const YAML_SCALAR_FALSE = new Set(['false', 'False', 'FALSE', 'no', 'off']);
const YAML_SCALAR_NULL = new Set(['null', 'Null', 'NULL', '~']);

export class PreflightError extends Error {
  constructor(code, detail) {
    super(code + ': ' + detail);
    this.name = 'PreflightError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  return { ok: false, code, detail };
}

/**
 * 解析 `--dump-config` 输出（受限 YAML 子集）。
 *
 * @param {string} text 原始输出
 * @returns {{ok:true, entries:object[]} | {ok:false, code:string, detail:string}}
 */
export function parseDumpConfigStrict(text) {
  if (typeof text !== 'string') return fail('CONFIG_UNPARSEABLE', '输出不是字符串');
  const stripped = text.replace(/^\uFEFF/, '');
  const trimmed = stripped.trim();
  if (trimmed === '') return fail('CONFIG_UNPARSEABLE', '输出为空');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    // 结构化 JSON 也接受（同一份数据，另一种序列化），但只接受数组根。
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return fail('CONFIG_UNPARSEABLE', 'JSON 解析失败：' + String(error && error.message));
    }
    if (!Array.isArray(parsed)) return fail('CONFIG_SHAPE_INVALID', '配置根必须是条目数组');
    return validateEntries(parsed);
  }

  const rawLines = stripped.split(/\r?\n/);
  const lines = [];
  const BLOCK_SCALAR = /:\s*(?:!!([A-Za-z0-9_-]+)\s+)?([|>])([+-]?)\s*$/;
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    if (raw.trim() === '') continue;
    if (/^\s*#/.test(raw)) continue;
    if (/^\t/.test(raw) || /(^|[^ ])\t/.test(raw)) return fail('CONFIG_UNPARSEABLE', '第 ' + (index + 1) + ' 行含制表符缩进');
    if (/^\s*---\s*$/.test(raw) || /^\s*\.\.\.\s*$/.test(raw)) return fail('CONFIG_UNPARSEABLE', '不支持多文档 YAML');
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) return fail('CONFIG_UNPARSEABLE', '第 ' + (index + 1) + ' 行缩进不是 2 的倍数');
    let text = raw.trim();
    const blockScalar = BLOCK_SCALAR.exec(text);
    if (blockScalar !== null) {
      // 多行块标量（例如 `desktopPlatform: !!js >-` 后跟两行表达式）。
      // 内容无法静态求值 → 折叠成"不可信标签值"，由覆盖率判定保守处理。
      const parts = [];
      let lookahead = index + 1;
      while (lookahead < rawLines.length) {
        const next = rawLines[lookahead];
        if (next.trim() === '') { lookahead += 1; continue; }
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        parts.push(next.trim());
        lookahead += 1;
      }
      const tag = blockScalar[1] === undefined ? 'text' : blockScalar[1];
      text = text.slice(0, blockScalar.index) + ': !!' + tag + ' ' + parts.join(' ');
      index = lookahead - 1;
    }
    lines.push({ indent, text, line: index + 1 });
  }
  if (lines.length === 0) return fail('CONFIG_UNPARSEABLE', '输出没有有效行');
  if (!lines[0].text.startsWith('- ')) return fail('CONFIG_SHAPE_INVALID', '配置根必须是条目数组');

  let cursor = 0;
  const parseBlock = (indent) => {
    // 决定块类型：映射序列（`- `）还是映射（`key:`）。
    if (cursor >= lines.length) return fail('CONFIG_UNPARSEABLE', '意外的文档结束');
    const first = lines[cursor];
    if (first.indent !== indent) return fail('CONFIG_UNPARSEABLE', '第 ' + first.line + ' 行缩进与预期不符');
    if (first.text.startsWith('- ')) {
      const items = [];
      while (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].text.startsWith('- ')) {
        const item = lines[cursor];
        const inline = item.text.slice(2).trim();
        cursor += 1;
        if (inline === '') {
          // `-` 单独一行，后面是更深缩进的块。
          if (cursor >= lines.length || lines[cursor].indent <= indent) return fail('CONFIG_UNPARSEABLE', '第 ' + item.line + ' 行的条目没有内容');
          const child = parseBlock(lines[cursor].indent);
          if (child.ok !== true) return child;
          items.push(child.value);
          continue;
        }
        if (/^["'[{&*|>]/.test(inline)) return fail('CONFIG_UNPARSEABLE', '第 ' + item.line + ' 行使用了不支持的标量/集合写法');
        const entry = {};
        if (inline.includes(':')) {
          // `- key: value` 形式：把这一行当作映射的第一项。
          const parsedPair = parsePair(inline, item.line);
          if (parsedPair.ok !== true) return parsedPair;
          entry[parsedPair.key] = parsedPair.value;
          while (cursor < lines.length && lines[cursor].indent === indent + 2 && !lines[cursor].text.startsWith('- ')) {
            const line = lines[cursor];
            const pair = parsePair(line.text, line.line);
            if (pair.ok !== true) return pair;
            if (Object.prototype.hasOwnProperty.call(entry, pair.key)) return fail('CONFIG_DUPLICATE_KEY', '第 ' + line.line + ' 行重复键 ' + pair.key);
            cursor += 1;
            if (pair.value === undefined) {
              if (cursor >= lines.length || lines[cursor].indent <= indent + 2) return fail('CONFIG_UNPARSEABLE', '第 ' + line.line + ' 行的键没有嵌套内容');
              const child = parseBlock(lines[cursor].indent);
              if (child.ok !== true) return child;
              entry[pair.key] = child.value;
            } else {
              entry[pair.key] = pair.value;
            }
          }
        } else {
          entry.value = decodeScalar(inline, item.line);
          if (entry.value instanceof Error) return fail('CONFIG_UNPARSEABLE', entry.value.message);
        }
        items.push(entry);
      }
      return { ok: true, value: items };
    }

    const mapping = {};
    while (cursor < lines.length && lines[cursor].indent === indent && !lines[cursor].text.startsWith('- ')) {
      const line = lines[cursor];
      const pair = parsePair(line.text, line.line);
      if (pair.ok !== true) return pair;
      if (Object.prototype.hasOwnProperty.call(mapping, pair.key)) return fail('CONFIG_DUPLICATE_KEY', '第 ' + line.line + ' 行重复键 ' + pair.key);
      cursor += 1;
      if (pair.value === undefined) {
        if (cursor >= lines.length || lines[cursor].indent <= indent) return fail('CONFIG_UNPARSEABLE', '第 ' + line.line + ' 行的键没有嵌套内容');
        const child = parseBlock(lines[cursor].indent);
        if (child.ok !== true) return child;
        mapping[pair.key] = child.value;
      } else {
        mapping[pair.key] = pair.value;
      }
    }
    return { ok: true, value: mapping };
  };

  const root = parseBlock(lines[0].indent);
  if (root.ok !== true) return root;
  if (cursor !== lines.length) return fail('CONFIG_UNPARSEABLE', '第 ' + lines[cursor].line + ' 行之后还有无法归类的剩余内容');
  if (!Array.isArray(root.value)) return fail('CONFIG_SHAPE_INVALID', '配置根必须是条目数组');
  return validateEntries(root.value);
}

function parsePair(text, line) {
  const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/.exec(text);
  if (!match) return fail('CONFIG_UNPARSEABLE', '第 ' + line + ' 行不是 `key: value` 形态：' + text);
  const rawValue = match[2];
  if (rawValue === undefined || rawValue === '') {
    return { ok: true, key: match[1], value: undefined };
  }
  // 空的流式集合（`[]` / `{}`）没有内容，不隐藏 provider，可以接受；
  // 非空流式集合可能藏着一个未受保护的 provider 实例，继续拒绝。
  if (rawValue === '[]') return { ok: true, key: match[1], value: [] };
  if (rawValue === '{}') return { ok: true, key: match[1], value: {} };
  if (/^[\[{]/.test(rawValue)) return fail('CONFIG_UNPARSEABLE', '第 ' + line + ' 行使用了流式集合');
  if (/^[&*]/.test(rawValue)) return fail('CONFIG_UNPARSEABLE', '第 ' + line + ' 行使用了锚点/别名');
  const value = decodeScalar(rawValue, line);
  if (value instanceof Error) return fail('CONFIG_UNPARSEABLE', value.message);
  return { ok: true, key: match[1], value };
}

function decodeScalar(raw, line) {
  const text = raw.trim();
  // 宿主配置里存在 `!!js <表达式>` 形式的标签值（例如 `disabled: !!js process.platform === 'win32'`）。
  // 它无法被静态求值，也不能当作普通字符串：一律解析成不可信标记，
  // 由覆盖率判定保守处理（禁用标记不可信 → 视为启用；baseURL 不可信 → 视为未受保护）。
  if (text.startsWith('!!')) {
    const tagged = /^!!([A-Za-z0-9_-]+)\s+(.*)$/.exec(text);
    if (!tagged) return new Error('第 ' + line + ' 行的标签缺少内容');
    return { __tagged: tagged[1], raw: tagged[2] };
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    if (text.length < 2 || !text.endsWith(quote)) return new Error('第 ' + line + ' 行的引号没有闭合');
    const inner = text.slice(1, -1);
    if (quote === "'" && inner.includes("'")) return new Error('第 ' + line + ' 行的单引号字符串含未转义引号');
    return inner;
  }
  if (text.includes("'") || text.includes('"')) return new Error('第 ' + line + ' 行的引号位置不合法');
  if (/#/.test(text)) return new Error('第 ' + line + ' 行含内联注释，无法可靠解析');
  if (YAML_SCALAR_TRUE.has(text)) return true;
  if (YAML_SCALAR_FALSE.has(text)) return false;
  if (YAML_SCALAR_NULL.has(text)) return null;
  if (/^-?\d+$/.test(text)) {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return new Error('第 ' + line + ' 行的整数超出安全范围');
    return value;
  }
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  return text;
}

function validateEntries(entries) {
  const ids = new Set();
  const normalized = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return fail('CONFIG_SHAPE_INVALID', '第 ' + (index + 1) + ' 个条目不是映射');
    if (typeof entry.id !== 'string' || entry.id.length === 0) return fail('CONFIG_SHAPE_INVALID', '第 ' + (index + 1) + ' 个条目缺少 id');
    if (ids.has(entry.id)) return fail('CONFIG_DUPLICATE_ID', '条目 id 重复：' + entry.id);
    ids.add(entry.id);
    if (entry.name !== undefined && typeof entry.name !== 'string') return fail('CONFIG_SHAPE_INVALID', '条目 ' + entry.id + ' 的 name 不是字符串');
    normalized.push({
      id: entry.id,
      name: entry.name === undefined ? null : entry.name,
      disabled: entry.disabled === true,
      config: entry.config === undefined ? null : entry.config,
      source: 'parsed',
    });
  }
  return { ok: true, entries: normalized };
}

function isAggregatorConfigured(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
  const providers = config.providers;
  if (Array.isArray(providers)) return providers.length > 0;
  if (providers !== undefined && providers !== null) return true;
  return false;
}

function readBaseUrl(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = config.baseURL;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// 读取任意一个"端点"键（例如 `inferenceOrigin`），语义与 readBaseUrl 相同。
function readEndpoint(config, key) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = config[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 一个配置实例的规范化身份。
 *
 * 规则（用户 m24003）：
 *   - `id` 只是实例标识，不能证明"加载的是哪个包"；
 *   - `name` 是包名，是唯一可用于身份核验的声明；同一个 id 配一个冲突的 name 必须拒绝；
 *   - 缺 `name` 时，只有当 id 恰好是已登记包名、且**安装包身份被实际核验**通过时才可解析为自有插件；
 *     绝不因为 id 长得像自己的插件就直接算 plumbing。
 */
export const PLUGIN_INSTANCE_SCHEMA = 'tla.plugin-instance/v1';

function isDisabledInstance(entry) {
  const config = entry.config;
  const nested = config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config.disabled === true || config.enabled === false
    : false;
  return entry.disabled === true || nested;
}

/**
 * 把结构化配置条目规范化成"实例 + 候选包名 + 命名来源"，并记录无法求值的条目。
 * 纯函数：不读文件系统，不判断覆盖率。
 */
export function resolveInstancePackages(entries) {
  const instances = [];
  const problems = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null;
    const config = entry.config === undefined ? null : entry.config;
    const disabled = isDisabledInstance(entry);
    const rawName = entry.name === undefined || entry.name === null ? null : entry.name;
    if (rawName !== null && (typeof rawName !== 'string' || rawName.trim() === '')) {
      problems.push({
        code: 'PLUGIN_INSTANCE_UNEVALUABLE',
        instance: id,
        detail: 'name 不是非空字符串，无法确定它加载哪个包',
      });
      instances.push({ id, declaredName: null, candidate: null, nameSource: 'unevaluable', disabled, config });
      continue;
    }
    const declared = rawName === null ? null : rawName.trim();
    const idIsReviewedName = id !== null && REVIEWED_PLUGIN_NAMES.has(id);
    if (declared !== null && idIsReviewedName && declared !== id) {
      problems.push({
        code: 'PLUGIN_IDENTITY_CONFLICT',
        instance: id,
        detail: '实例 id 是已登记包名 ' + id + '，name 却声明为 ' + declared + '：id 不能覆盖冲突的 name',
      });
      instances.push({ id, declaredName: declared, candidate: null, nameSource: 'conflict', disabled, config });
      continue;
    }
    if (declared === null) {
      instances.push({
        id,
        declaredName: null,
        candidate: idIsReviewedName ? id : null,
        nameSource: idIsReviewedName ? 'id-needs-installed-package' : 'missing',
        disabled,
        config,
      });
      continue;
    }
    instances.push({ id, declaredName: declared, candidate: declared, nameSource: 'name', disabled, config });
  }
  return { instances, problems };
}

/** 非"自有插件"的实例沿用原有 provider 判据（模型适配器 / 端点组件 / 白名单组件）。 */
function classifyComponent({ id, name, config, gate }) {
  if (name === null) {
    return { status: 'unknown', baseURL: null, detail: '缺 name，无法判断它是否发模型请求' };
  }
  if (!name.startsWith('@deepseek-ai/dsh-llm-')) {
    const endpointKeys = MODEL_ENDPOINT_COMPONENTS[name];
    if (endpointKeys !== undefined) {
      const endpoints = endpointKeys.map((key) => ({ key, url: readEndpoint(config, key) }));
      const allGated = gate !== null && endpoints.length > 0
        && endpoints.every(({ url }) => url !== null && checkBaseUrl({ effectiveBaseUrl: url, gateBaseUrl: gate }).ok);
      return {
        status: allGated ? 'guarded' : 'unguarded',
        baseURL: endpoints.length === 1 ? endpoints[0].url : null,
        modelEndpointKeys: endpointKeys.slice(),
        detail: allGated ? null : '端点未全部指向闸门',
      };
    }
    const trusted = REVIEWED_PLUGIN_NAMES.has(name) || KNOWN_COMPONENT_NAMES.has(name);
    return {
      status: trusted ? 'plumbing' : 'unknown',
      baseURL: readBaseUrl(config),
      detail: trusted ? null : '不在受信任组件白名单内，可能具备模型请求能力',
    };
  }
  if (KNOWN_NON_PROVIDER_ADAPTERS.has(name)) {
    return { status: 'plumbing', baseURL: null, detail: '登记的非模型适配器' };
  }
  const known = KNOWN_PROVIDER_ADAPTERS[name];
  if (known === undefined) {
    return { status: 'unknown', baseURL: readBaseUrl(config), detail: '不认识的模型适配器' };
  }
  if (known.aggregator) {
    return {
      status: isAggregatorConfigured(config) ? 'unguarded' : 'not-configured',
      baseURL: readBaseUrl(config),
      detail: isAggregatorConfigured(config) ? '聚合器渠道已配置，无法逐个证明都指向闸门' : '聚合器未配置渠道',
    };
  }
  const baseURL = readBaseUrl(config);
  const check = baseURL === null || gate === null
    ? { ok: false, reason: 'BASE_URL_MISMATCH' }
    : checkBaseUrl({ effectiveBaseUrl: baseURL, gateBaseUrl: gate });
  return {
    status: check.ok ? 'guarded' : 'unguarded',
    baseURL,
    detail: check.ok ? null : (check.reason === undefined ? 'baseURL 未指向闸门' : check.reason),
  };
}

/**
 * 统一判定：分类与身份核验使用**同一个**规范化结果。
 *
 * @param {object[]} entries 结构化配置条目
 * @param {{gateBaseUrl?: string, identities?: object[]|null}} options
 *   `identities` 为已核验的安装身份（来自 `verifyPluginIdentities`）；为 null 时是"纯分类"
 *   模式，缺 name 的自有插件一律记为 unknown，不推断。
 */
export function judgePluginInstances(entries, options = {}) {
  const gateUrl = options.gateBaseUrl === undefined ? null : options.gateBaseUrl;
  const gate = normalizeBaseUrl(gateUrl);
  const identities = Array.isArray(options.identities) ? options.identities : null;
  const { instances, problems } = resolveInstancePackages(entries);
  const rows = [];
  for (const instance of instances) {
    const { id, declaredName, candidate, disabled, config, nameSource } = instance;
    const row = {
      id,
      name: declaredName,
      resolvedName: candidate,
      nameSource,
      disabled,
      kind: 'unknown',
      detail: null,
      identity: null,
      baseURL: null,
    };
    if (disabled) {
      row.kind = 'disabled';
      row.baseURL = readBaseUrl(config);
      rows.push(row);
      continue;
    }
    if (nameSource === 'conflict') {
      row.detail = 'PLUGIN_IDENTITY_CONFLICT：id 与 name 冲突，拒绝';
      rows.push(row);
      continue;
    }
    if (nameSource === 'unevaluable') {
      row.detail = 'PLUGIN_INSTANCE_UNEVALUABLE：name 不可解析，拒绝';
      rows.push(row);
      continue;
    }
    const isReviewed = candidate !== null && REVIEWED_PLUGIN_NAMES.has(candidate);
    if (isReviewed) {
      if (identities === null) {
        // 纯分类：显式 name 维持旧行为（登记过的包算 plumbing，身份另行核验）；
        // 只有 id、没有名字的实例一律 unknown，避免"按 id 推断受信任代码"。
        if (nameSource === 'name') {
          row.kind = 'plumbing';
          row.detail = '按 name 登记的自有插件（纯分类模式未核验身份）';
        } else {
          row.kind = 'unknown';
          row.detail = 'PLUGIN_IDENTITY_UNPROVEN：缺 name，且没有安装包身份证据';
        }
        rows.push(row);
        continue;
      }
      const match = identities.find((item) => item !== null && typeof item === 'object' && item.name === candidate);
      row.identity = { name: candidate, status: match === undefined ? 'missing' : match.status };
      if (match === undefined) {
        row.kind = 'unknown';
        row.detail = 'PLUGIN_IDENTITY_UNPROVEN：没有任何身份核验结果';
        problems.push({ code: 'PLUGIN_IDENTITY_UNPROVEN', instance: id, detail: row.detail });
      } else if (match.status !== 'verified') {
        row.kind = 'unknown';
        row.detail = 'PLUGIN_NOT_VERIFIED：' + String(match.status) + '（' + String(match.detail || '没有可核对的安装身份') + '）';
        problems.push({ code: 'PLUGIN_NOT_VERIFIED', instance: id, detail: row.detail });
      } else {
        row.kind = 'plumbing';
        row.detail = '已核验的安装包 ' + candidate;
      }
      rows.push(row);
      continue;
    }
    const classified = classifyComponent({ id, name: candidate, config, gate });
    row.kind = classified.status;
    row.detail = classified.detail === undefined ? null : classified.detail;
    row.baseURL = classified.baseURL === undefined ? null : classified.baseURL;
    if (classified.modelEndpointKeys !== undefined) row.modelEndpointKeys = classified.modelEndpointKeys;
    rows.push(row);
  }

  // 重复实例：同一个**需要身份核验的包**被启用两次时，"每个实例都有 verified 结果"就没有唯一含义。
  // 宿主自带的组件包可以被合法地挂载两次（例如 tool-subagent 与 tool-subagent-fork 同包不同 id），
  // 那些包不参与身份核验，因此不能拿它们当阻断项。
  const counts = new Map();
  for (const row of rows) {
    if (row.kind === 'disabled' || row.resolvedName === null) continue;
    if (!REVIEWED_PLUGIN_NAMES.has(row.resolvedName)) continue;
    counts.set(row.resolvedName, (counts.get(row.resolvedName) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) {
      problems.push({
        code: 'PLUGIN_DUPLICATE_INSTANCE',
        instance: name,
        detail: '同一个包 ' + name + ' 被启用 ' + String(count) + ' 次，身份无法归属到单个实例',
      });
    }
  }

  const providers = rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.kind,
    baseURL: row.baseURL,
    ...(row.modelEndpointKeys === undefined ? {} : { modelEndpointKeys: row.modelEndpointKeys }),
    ...(row.identity === null ? {} : { identity: row.identity }),
  }));
  const pick = (status) => providers.filter((provider) => provider.status === status).map((provider) => provider.id);
  const gateValue = gate === null ? null : gate;
  return {
    schema: PLUGIN_INSTANCE_SCHEMA,
    gateBaseUrl: gateValue,
    instances: rows,
    problems,
    identityComplete: problems.length === 0
      && rows.every((row) => row.kind === 'disabled' || row.identity === null || row.identity.status === 'verified'),
    coverage: {
      schema: PREFLIGHT_SCHEMA,
      gateBaseUrl: gateValue,
      providers,
      guarded: pick('guarded'),
      unguarded: pick('unguarded'),
      notConfigured: pick('not-configured'),
      disabled: pick('disabled'),
      unknown: pick('unknown'),
      plumbing: pick('plumbing'),
    },
  };
}

/**
 * 逐个 provider 实例判断是否指向闸门（纯分类，不含安装身份核验）。
 *
 * @param {object[]} entries 结构化配置条目
 * @param {string} gateBaseUrl 本次闸门地址
 */
export function extractProviderCoverage(entries, gateBaseUrl) {
  return judgePluginInstances(entries, { gateBaseUrl }).coverage;
}

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
  const read = readRunEvents(eventLogPath, { runId: null });
  if (read.ok !== true) return null;
  for (let index = read.events.length - 1; index >= 0; index -= 1) {
    const event = read.events[index];
    if (kinds === undefined || kinds.includes(event.event)) return event;
  }
  return null;
}

/**
 * 严格读取运行事件日志。
 *
 * @param {string} eventLogPath
 * @param {{runId: (string|null), allowForeign: boolean}} options
 *   runId 为 null 时不做运行过滤（只用于调试读最后一条）。
 */
export function readRunEvents(eventLogPath, { runId = null, allowForeign = false } = {}) {
  let text;
  try {
    text = readFileSync(eventLogPath, 'utf8');
  } catch (_missing) {
    return { ok: false, reason: 'PROOF_MISSING', detail: '事件文件不存在：' + String(eventLogPath), events: [] };
  }
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_badLine) {
      // 损坏行绝不跳过：跳过会让"证明"变成"挑着看"。
      return { ok: false, reason: 'PROOF_UNREADABLE', detail: '第 ' + (index + 1) + ' 行不是合法 JSON', events };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'PROOF_UNREADABLE', detail: '第 ' + (index + 1) + ' 行不是对象', events };
    }
    if (typeof parsed.event !== 'string' || parsed.event === '') {
      return { ok: false, reason: 'PROOF_UNREADABLE', detail: '第 ' + (index + 1) + ' 行缺少 event 字段', events };
    }
    if (runId !== null && parsed.runId !== runId) {
      if (allowForeign !== true) return { ok: false, reason: 'PROOF_FOREIGN_RUN', detail: '第 ' + (index + 1) + ' 行属于其他运行：' + String(parsed.runId), events };
      continue;
    }
    events.push(parsed);
  }
  if (runId !== null && events.length === 0) {
    return { ok: false, reason: 'PROOF_MISSING', detail: '没有属于本次运行的事件', events };
  }
  return { ok: true, events };
}

const PROOF_ACTIVE_EVENTS = new Set(['mounted', 'heartbeat', 'reserved', 'rejected']);

function proofKindAllowed(event) {
  return PROOF_ACTIVE_EVENTS.has(event.event) || event.event === 'unmounted';
}

/**
 * 走一遍本次运行的生命周期事件，输出"身份/终态"结论。
 *
 * 这是 P0-3 的核心：只看"首条 mounted"和"最后一条事件"会漏掉两类真实问题——
 *   1. `mounted → unmounted → heartbeat`：卸载是终态，迟到心跳不能复活它；
 *   2. 同一 runId 内重复 `mounted`：那是另一个实例，必须走新的运行身份授权。
 *
 * 判定规则（全部失败即拒绝，没有"跳过坏行继续"）：
 *   - 第一条事件必须是本次运行的 `mounted`；
 *   - 只接受 mounted/heartbeat/reserved/rejected/unmounted；
 *   - 时间戳必须可解析且不回退（允许相等）；
 *   - `mounted` 只能出现一次（重复 → PROOF_DUPLICATE_MOUNT）；
 *   - `unmounted` 之后出现任何事件 → PROOF_AFTER_UNMOUNT（不复活）；
 *   - `mounted` 早于宿主启动时刻 → PROOF_PRE_START；
 *   - `mounted` 时间在未来 → PROOF_FUTURE。
 *
 * 注意：这里**不判定"mounted 有多旧"**。长跑任务的 mounted 本来就会越来越旧，
 * 把它的年龄当作掉线会让正常运行在若干个窗口后被误杀。运行期的新鲜度由
 * `checkProtectionHeartbeat` 用**最新心跳**单独判定。
 *
 * @returns {{ok:boolean, reason:(string|null), detail:(string|undefined), mountedAt:(number|null),
 *   ended:boolean, latestHeartbeatAt:(number|null), lastActivityAt:(number|null), lastEvent:(string|null)}}
 */
export function walkRunLifecycle({ eventLog, runId, now, notBefore, clockSkewMs = 2000, requireHeartbeat = false }) {
  const empty = { ok: false, reason: null, mountedAt: null, ended: false, latestHeartbeatAt: null, lastActivityAt: null, lastEvent: null };
  if (typeof runId !== 'string' || runId === '') return { ...empty, reason: 'PROOF_NO_RUN_ID' };
  const read = readRunEvents(eventLog, { runId });
  if (read.ok !== true) return { ...empty, reason: read.reason, detail: read.detail };
  const events = read.events;
  if (events[0].event !== 'mounted') {
    return { ...empty, reason: 'PROOF_UNORDERED', detail: '本次运行的第一条事件不是 mounted', lastEvent: events[0].event };
  }
  let mountedAt = null;
  let mountCount = 0;
  let ended = false;
  let latestHeartbeatAt = null;
  let lastActivityAt = null;
  let lastEvent = null;
  let previousAt = null;
  for (const event of events) {
    const eventAt = Date.parse(event.at);
    if (!Number.isFinite(eventAt)) {
      return { ...empty, reason: 'PROOF_UNREADABLE', detail: '事件 ' + String(event.event) + ' 缺少可解析的 at', lastEvent: String(event.event) };
    }
    if (previousAt !== null && eventAt < previousAt) {
      return { ...empty, reason: 'PROOF_TIME_ORDER', detail: '事件时间倒退：' + String(event.event) + ' 早于上一条', lastEvent: String(event.event) };
    }
    previousAt = eventAt;
    if (!proofKindAllowed(event)) {
      return { ...empty, reason: 'PROOF_UNKNOWN_EVENT', detail: String(event.event), lastEvent: String(event.event) };
    }
    if (ended) {
      // unmounted 是本次运行的终态：之后的心跳/预占一律视为"试图复活"。
      return { ...empty, reason: 'PROOF_AFTER_UNMOUNT', detail: 'unmounted 之后仍有事件：' + String(event.event), ended: true, lastEvent: String(event.event) };
    }
    if (event.event === 'mounted') {
      mountCount += 1;
      if (mountCount > 1) {
        return { ...empty, reason: 'PROOF_DUPLICATE_MOUNT', detail: '同一运行里出现了第二次 mounted（需要新的运行身份）', ended: false, lastEvent: 'mounted' };
      }
      mountedAt = eventAt;
      lastActivityAt = eventAt;
    } else if (event.event === 'unmounted') {
      ended = true;
      lastEvent = 'unmounted';
    } else if (event.event === 'heartbeat') {
      latestHeartbeatAt = eventAt;
      lastActivityAt = eventAt;
      lastEvent = 'heartbeat';
    } else {
      lastActivityAt = eventAt;
      lastEvent = event.event;
    }
  }
  if (mountedAt === null) {
    return { ...empty, reason: 'PROOF_UNORDERED', detail: '没有可用的 mounted 时间', lastEvent };
  }
  const age = now - mountedAt;
  if (age < -60_000) {
    return { ...empty, reason: 'PROOF_FUTURE', detail: 'mounted 时间在未来', lastEvent };
  }
  if (Number.isFinite(notBefore) && mountedAt < notBefore - Math.max(0, clockSkewMs)) {
    return { ...empty, reason: 'PROOF_PRE_START', detail: 'mounted 早于本次宿主启动 ' + (notBefore - mountedAt) + 'ms', lastEvent };
  }
  if (ended) {
    return { ...empty, reason: 'RUN_ENDED', detail: '本次运行已 unmounted', ended: true, mountedAt, latestHeartbeatAt, lastActivityAt, lastEvent: 'unmounted' };
  }
  if (requireHeartbeat === true && latestHeartbeatAt === null) {
    return { ...empty, reason: 'PROOF_NO_HEARTBEAT', detail: '本次运行只有 mounted，没有心跳', mountedAt, ended: false, latestHeartbeatAt: null, lastActivityAt, lastEvent };
  }
  return { ok: true, reason: null, mountedAt, ended: false, latestHeartbeatAt, lastActivityAt, lastEvent };
}

/**
 * 运行级挂载证明（启动/授权用）：身份有效、没有卸载终态、且（可选）出现心跳。
 *
 * 这里刻意不看 mounted 的年龄——长跑运行的 mounted 会一直变旧。运行期是否还活着
 * 由 `checkProtectionHeartbeat` 用最新心跳判定。
 *
 * @returns {{ok:boolean, reason:(string|null), at:(string|null), lastEvent:(string|null)}}
 */
export function evaluateMountProof({ eventLog, runId, now, notBefore, requireHeartbeat = false, clockSkewMs = 2000 }) {
  const lifecycle = walkRunLifecycle({ eventLog, runId, now, notBefore, clockSkewMs, requireHeartbeat });
  if (lifecycle.ok !== true) {
    return { ok: false, reason: lifecycle.reason, detail: lifecycle.detail, at: null, lastEvent: lifecycle.lastEvent === undefined ? null : lifecycle.lastEvent };
  }
  return { ok: true, reason: null, at: new Date(lifecycle.mountedAt).toISOString(), lastEvent: lifecycle.lastEvent };
}

/**
 * 运行期活性判定：用**最新心跳**的新鲜度，而不是 mounted 的年龄。
 *
 * - 卸载终态（含 unmounted 之后的迟到事件）→ RUN_ENDED / PROOF_AFTER_UNMOUNT；
 * - 从未出现心跳 → HEARTBEAT_MISSING；
 * - 最新心跳超过 maxAgeMs → HEARTBEAT_STALE（停止心跳要及时撤销）；
 * - 时间在未来 → HEARTBEAT_STALE。
 */
export function checkProtectionHeartbeat({ eventLog, runId, now, maxAgeMs }) {
  const lifecycle = walkRunLifecycle({ eventLog, runId, now });
  if (lifecycle.ok !== true) {
    const map = {
      RUN_ENDED: 'RUN_ENDED',
      PROOF_AFTER_UNMOUNT: 'RUN_ENDED',
      PROOF_NO_HEARTBEAT: 'HEARTBEAT_MISSING',
      PROOF_DUPLICATE_MOUNT: 'HEARTBEAT_MISSING',
      PROOF_TIME_ORDER: 'HEARTBEAT_STALE',
      PROOF_UNREADABLE: 'HEARTBEAT_STALE',
    };
    const reason = map[lifecycle.reason] || 'HEARTBEAT_MISSING';
    return { ok: false, reason, detail: lifecycle.detail || lifecycle.reason, lastEvent: lifecycle.lastEvent === undefined ? null : lifecycle.lastEvent };
  }
  if (lifecycle.latestHeartbeatAt === null) {
    return { ok: false, reason: 'HEARTBEAT_MISSING', detail: '本次运行没有心跳事件', lastEvent: lifecycle.lastEvent };
  }
  const age = now - lifecycle.latestHeartbeatAt;
  if (age < -60_000) return { ok: false, reason: 'HEARTBEAT_STALE', detail: '心跳时间在未来', ageMs: age, maxAgeMs, lastEvent: lifecycle.lastEvent };
  if (age > maxAgeMs) return { ok: false, reason: 'HEARTBEAT_STALE', ageMs: age, maxAgeMs, lastEvent: lifecycle.lastEvent };
  return { ok: true, reason: null, ageMs: age, lastEvent: lifecycle.lastEvent };
}

/**
 * 本次运行是否已经卸载结束。
 *
 * 语义修正（复审问题 2）：旧实现只看"最后一条事件是不是 unmounted"，
 * 于是 `mounted → unmounted → heartbeat` 会被判成"仍在运行"。
 * 现在只要出现过 unmounted 就是终态；损坏/无法读取的日志按"已结束"处理
 * （fail-closed：宁可撤销租约，也不放行来路不明的运行）。
 */
export function runEndedByLastEvent(eventLogPath, runId) {
  try {
    const read = readRunEvents(eventLogPath, { runId });
    if (read.ok !== true) return true;
    return read.events.some((event) => event.event === 'unmounted');
  } catch (_error) {
    return true;
  }
}

/**
 * 纯判定：全部条件成立才允许启动。
 *
 * 覆盖率必须是"可验证"的：有结构化的 provider 清单、没有未受保护实例、
 * 没有不认识的适配器、至少有一个确实指向闸门的 provider。
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
  const coverage = input.coverage === undefined ? null : input.coverage;
  if (coverage === null || coverage === undefined) {
    blockers.push({ code: 'COVERAGE_UNVERIFIABLE', detail: '没有可验证的 provider 覆盖信息' });
  } else {
    if (Array.isArray(coverage.unguarded) && coverage.unguarded.length > 0) {
      blockers.push({ code: 'PROVIDER_NOT_GATED', detail: '未指向闸门的 provider 实例：' + coverage.unguarded.join(',') });
    }
    if (Array.isArray(coverage.unknown) && coverage.unknown.length > 0) {
      blockers.push({ code: 'PROVIDER_UNKNOWN', detail: '无法识别的模型适配器（不能声称覆盖率完整）：' + coverage.unknown.join(',') });
    }
    if (!Array.isArray(coverage.guarded) || coverage.guarded.length === 0) {
      blockers.push({ code: 'NO_GATED_PROVIDER', detail: '没有任何模型 provider 指向闸门' });
    }
  }
  const pluginIdentities = Array.isArray(input.pluginIdentities) ? input.pluginIdentities : [];
  for (const identity of pluginIdentities) {
    if (identity === null || identity.status === 'verified') continue;
    blockers.push({
      code: 'PLUGIN_NOT_VERIFIED',
      detail: (identity.name || identity.id || '<unknown>') + '：' + identity.status + '（' + (identity.detail || '没有可核对的安装身份') + '）',
    });
  }
  // 分类/身份判定阶段发现的问题（冲突 name、缺身份结果、重复实例、不可求值）直接成为阻断项：
  // 这些是"覆盖率看起来完整但身份没被证明"的情形，不能只在覆盖率数组里体现。
  const pluginProblems = Array.isArray(input.pluginProblems) ? input.pluginProblems : [];
  for (const problem of pluginProblems) {
    if (problem === null || typeof problem !== 'object' || typeof problem.code !== 'string') continue;
    blockers.push({
      code: problem.code,
      detail: (problem.instance === undefined || problem.instance === null ? '' : '实例 ' + String(problem.instance) + '：')
        + String(problem.detail === undefined ? '' : problem.detail),
    });
  }
  if (input.identityComplete === false) {
    blockers.push({
      code: 'PLUGIN_IDENTITY_INCOMPLETE',
      detail: '有启用的自有插件实例没有 verified 身份结果（身份列表为空或漏项不能算通过）',
    });
  }
  // 同一原因可能从两条路径来（身份数组 + 判定问题），去重但保留首个说明。
  const seen = new Set();
  const unique = [];
  for (const blocker of blockers) {
    const key = blocker.code + '|' + blocker.detail;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(blocker);
  }
  return { allow: unique.length === 0, blockers: unique };
}

/** 把判定结果写成给人看的一段话（也用于启动失败的错误反馈）。 */
export function formatDecision(decision) {
  if (decision.allow) return 'protection verified: gate reachable, baseURL points at gate, heartbeat fresh, providers covered';
  return 'protection NOT verified -> refuse to start: ' + decision.blockers.map((b) => b.code + ' (' + b.detail + ')').join('; ');
}

/** 通过回环 HTTP 读取闸门状态（只读）；连不上即视为未就绪。 */
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
