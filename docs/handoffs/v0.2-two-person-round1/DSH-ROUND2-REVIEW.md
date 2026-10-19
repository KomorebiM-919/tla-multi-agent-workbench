# DSH 第二轮复核：核心验收排序修复

- 审查对象：`fix/v0.2-core-acceptance` 的 `e3f8573e086974ae52e179f4942318a310f3c63f`（父 `629992424c0d0ebabccbb0fb723dd9ab8f3c73e6`）。
- 复核基线：`feat/v0.2-component-reuse` 的 `f971df52c3803839f514824b342324aaee41b779`；当前工作区未合并、未 cherry-pick。
- 结论：**排序修复可接受（附 1 个 P3 与 1 个已知限制）；采集器接口仍是未实现方案，不能当作已完成能力；V0.2 真实返工闭环仍未验证。**

## 1. 复核范围与方法

增量 `6299924..e3f8573` 共 5 个文件、+150/−7：

| 文件 | 作用 |
| --- | --- |
| `tools/acceptance-summary.mjs` | 排序与回读选择 |
| `tests/v02-core-acceptance.test.mjs` | 26 项验收反例/正例 |
| `docs/handoffs/v0.2-two-person-round1/CORE-ROUND2.md` | 修复说明与采集器方案 |
| `README.md`、`docs/ROADMAP.md` | 状态表述 |

使用独立归档副本审查，不在当前 V0.2 工作区合并或 cherry-pick；只读核心实现，未改核心文件。未启动宿主或假模型，未调用模型，未安装依赖，未改 ACL/profile。

## 2. 排序修复

### 2.1 实现核对

`tools/acceptance-summary.mjs:109-125` 的 `orderFileEvidence(events)`：

- 要求每个事件非 `null`、类型为 `object`，且 `Number.isSafeInteger(event.index) && event.index >= 0`；
- 用 `Set` 拒绝重复序号，重复判定**跨路径全局生效**；
- 返回 `[...events].sort((a, b) => a.index - b.index)`，排序作用在副本上，不改调用方数组与事件对象。

`:136-143` 从排序后的数组选 `lastImplementationWrite`（最大 index 的实现写），再选同路径、`kind === 'read'`、`index` 严格更大的最后一个读；`:134` 的 `implementationWrites` 仍来自原数组，只用于“是否发生实现写”；`:165` 的 detail 已改为实现写数量。

### 2.2 测试与独立复现

| 用例 | 预期 | 实测 |
| --- | --- | --- |
| 旧 P2：数组末尾是旧写、最新写藏在前面 | 不得 `closed` | `partial`，`READ_BACK_AFTER_WRITE` 为 false |
| 合法乱序（读在前、写在后，按 index 可排） | `closed` | `closed` |
| 0 基序号 | 有效 | `closed` |
| 最大安全整数读序号 | 有效 | `closed` |
| 大写十六进制哈希 | 与写哈希相等 | `closed` |
| 跨路径重复 index | 拒绝回读证据 | `partial`，detail `duplicate file index 1` |
| 字符串/缺失/小数/负数/超安全整数/Infinity/NaN/null 事件 | 拒绝 | 均 `partial` |
| 排序是否修改调用方输入 | 不修改 | `OK` |

官方测试：`v02-core-acceptance` 26/26、`v02-acceptance-summary` 19/19、`v02-ledger` 59/59；V0.1 `preflight-script` 9/9 场景、42 断言（固定 `f971df5`）。V0.1 测试第一次因审查副本嵌在父仓库内、`tests/.scratch` 不可写而 EPERM，使用一次性外层放宽后通过；该副本的 git 操作使用父仓库 `.git`，是审查布置的产物，不是产品行为。`f971df5..e3f8573` 未改 `workflows/three-agent-mvp.js` 与 V0.1 preflight 文件。

### 2.3 新发现

**P3：非字符串哈希会让判定器抛错。** 当实现写与回读都存在、且 `sha256` 是 64 位 `BigInt` 时，`readBackOk` 调用 `readBack.sha256.toLowerCase` 抛出：

```text
TypeError: readBack.sha256.toLowerCase is not a function
```

这不会产生假 `closed`（CLI 会非零退出），但输入校验应拒绝非字符串哈希，而不是让 `deriveAcceptance` 崩溃。建议在 `orderFileEvidence` 或 `readBackOk` 前统一校验 `typeof sha256 === 'string'`，或用项目已有的哈希判定函数。

**已知限制（P2 风险，方案已声明）：两个实现文件只有最新一个被回读，仍可 `closed`。** `CORE-ROUND2` 明确写了“本轮不建立每个变更文件的回读”，因此这是已披露的限制，不是回归；但在允许多个实现文件的实验里，验收措辞必须写清“只证明最新实现写”，不能写成“所有实现文件都已回读”。

### 2.4 兼容性

- `tla.acceptance-summary/v1` schema、CLI 参数、10 个条件码未变。
- 输入契约变严：字符串 `index` 以前会被隐式接受，现在整组文件证据判不通过；旧调用方必须修正。该破坏性变化已在 `CORE-ROUND2` 披露。
- 原 19 项、ledger 与 V0.1 回归通过；未跑全部 20 套，未启动宿主。

## 3. 采集器接口方案审查

`CORE-ROUND2.md` 的“Collector interface plan”明确标注**未实现**，没有新的落盘 schema。这个边界本身正确；但方案还不足以直接实现，也不能作为“采集链路已补齐”的证据。

### 3.1 能站住的部分

- 把采集器与判定器分开，避免用规则名重命名或补未知值来构造证明；
- 要求按稳定 session + 调用身份去重重复会话历史；
- 要求项目根 containment、拒绝越界/遍历/未解析路径；
- 明确“不能用运行后的磁盘哈希冒充历史写入哈希”；
- 要求保留逐次测试的命令、cwd、整数退出码与计数；
- 要求端到端合成协议测试及缺字节、重复历史、跨 run、越界路径、失败工具等反例。

### 3.2 遗漏与无法从现有日志证明的内容

| 严重度 | 缺口 | 现有证据/影响 |
| --- | --- | --- |
| P1 | 没有具体 schema、版本号、字段命名与事件类型 | 方案只有“required fact / obligation”表，无法据此写采集器或做兼容性测试 |
| P1 | 没有 runner run ID 与 gate/budget run ID 的映射 | run10 runner summary 是 `exp-mvetu4cl-b631b01f`，gate/upstream 日志用 `tla-run-mvetu4xs-1e08e7f62667`；ledger correlation 不能替代逐观测绑定 |
| P1 | 没有说明如何采集 subagent/member 的工具调用 | run10 的 6 个 request body 只有 4 个实际 tool call（`agent_teams_create`、`claim_task`、`update_task`、`read`），没有 write；只有 `subagent/descriptor` 和 `subagent/catalog`，没有 worker 的请求体或工具调用 |
| P1 | 事件顺序权威不明确 | `seq` 是单会话内序号，`time` 是不可靠的墙钟值；跨 request/session 的顺序没有总序，判定器却只接受整数 `index`，方案未定义“顺序未知”如何表达 |
| P1 | 写入/回读字节证据没有规范 | 现有 policyFacts 只有 `rule/path/outcome`，没有 `kind/index/sha256`；最终 `files` 哈希是运行后状态；tool call 的 `arguments` 与 tool result 的文本都没有规定按什么字节、什么编码、如何处理 CRLF 来哈希 |
| P2 | 红→绿测试历史只定义了义务，没有解析与信任边界 | `runProjectTest` 只返回运行后一次结果；member 自己跑测试的输出是非结构化文本，方案未说明由谁解析、如何防止伪造 |
| P2 | 任务/复审血缘仍不完整 | `readTasks` 丢失 `subject`；team.json 只是当前快照；方案要求保留 task/attempt/type/subject，但没说明从哪些事件取、如何处理重试/改派 |
| P2 | 失败/部分工具结果、重试、截断未定义 | run10 的 `read` 返回 `missing file_path`、`update_task` 返回 `missing attempt_id`；方案只提“successful paired results”，未定义失败调用是否入账、部分结果是否可证明 |
| P2 | 路径安全与脱敏边界不完整 | 只讲 containment，未讲 symlink/大小写/UNC/Windows 设备路径；tool 内容可能含敏感信息，方案没有 redaction、大小上限与落盘保留策略 |
| P2 | 没有采集器 schema 的兼容/迁移与 V0.1 影响分析 | 新采集器会进入协议样本与验收链；方案未说明旧 fixture、旧 summary、V0.1 如何继续工作 |
| P3 | `parseBody` 的能力被高估 | 它只在单个 request 内配对 call/result 并保留 `is_error`；不解决跨 request 去重、跨 session 顺序、字节观测；方案已提示限制，但没有给出替代层 |

### 3.3 run10 的具体不可证点

- `upstream-requests.jsonl` 19 行，字段为 `seq/at/method/path/runId/correlationId/sessionId/event` 等；`policyFacts` 只有 claim/update/fileOutcome/filePath/prompt/currentAttempt/lastToolText/wakeKind，没有 `kind/index/sha256`。
- 6 个 request body 中共 4 个实际 tool call，没有 write；`read` 因缺 `file_path` 失败，`update_task` 因缺 `attempt_id` 失败。
- 有 `subagent/descriptor`（worker，childId）与 `subagent/catalog`，但没有 worker 的工具调用记录；不能据此证明成员写盘。
- `gate-summary.json` 没有 tool 字段；`plugin-events.jsonl` 只有预算事件；`team.json` 有 `t1` subject=claimed，但 `readTasks` 不保留 subject。
- 因而“采集器会补齐 hashes/read events/history/subjects”目前只是方案，不是运行证据；不能用现有日志补造。

## 4. 结论与接受条件

**排序修复：有条件接受。** P2 已按整数序号正确选择最新写与后续读；重复/无效序号被拒绝；合法乱序与 0 基通过；不修改调用方输入；原 19 项、ledger 与 V0.1 回归通过。接受条件：

1. 修复 P3：非字符串 `sha256` 应判不通过并给出 detail，不得抛 `TypeError`；
2. 在验收措辞中保留“只证明最新实现写”的限制，除非未来补每文件回读；
3. 记录字符串 `index` 的破坏性收紧，修正任何旧调用方。

**采集器：不接受为已完成能力。** 方案方向正确，但缺少 schema、run 映射、member 采集、顺序语义、字节规范、脱敏/保留与兼容测试；在实现并通过端到端合成协议测试前，不得声称 V0.2 可闭环。

**V0.2：仍未验证真实返工闭环。** 本轮未启动宿主或假模型，授权仍为 0。

## 5. 最小复现

旧 P2（应判不通过）：

```js
deriveAcceptance({
  // ... 其余条件保持有效 ...
  writes: [
    { kind: 'write', path: 'src/sum.mjs', index: 10, sha256: 'b'.repeat(64) },
    { kind: 'write', path: 'src/sum.mjs', index: 1, sha256: 'a'.repeat(64) },
    { kind: 'read', path: 'src/sum.mjs', index: 2, sha256: 'a'.repeat(64) }
  ]
})
// 期望 partial / READ_BACK_AFTER_WRITE=false；修复后实测即此结果
```

P3（当前抛错）：

```js
const h = 10n ** 63n
// 同一组写/读，index 分别为 1/2，sha256 都是 h
// 当前抛出 TypeError: readBack.sha256.toLowerCase is not a function
```

复跑命令（占位符）：

```powershell
node tests/v02-core-acceptance.test.mjs
node tests/v02-acceptance-summary.test.mjs
node tests/v02-ledger.test.mjs
node tests/preflight-script.test.mjs
```

## 6. 边界

本轮只读审查独立副本，未修改 `fix/v0.2-core-acceptance` 或当前 V0.2 核心文件；未合并、未 cherry-pick、未强推；未启动宿主、假模型或模型请求；未安装依赖；未改 ACL/profile。审查文档可脱敏后单独提交、普通推送。
