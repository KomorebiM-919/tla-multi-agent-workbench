# v0.2-run1 原生执行证据（会话日志白名单提取）

本目录的 `native-events.json` 是**原生证据**，不是编排层自己打印的派生摘要。
它由 `tests/extract-native-events.mjs` 只读解析 DSH 宿主写入的会话日志后生成。

- 提取器：`tests/extract-native-events.mjs`
- 输出：`docs/run-records/v0.2-run1-20261017T121445Z/native-events.json`
- 对照的既有派生摘要：`docs/review/[C17]/native-events.json`（保留不动，它不是原生证据）

## 1. 为什么需要这一份

`docs/review/[C17]/native-events.json` 是编排层在 workflow 返回值基础上写的摘要，
它证明不了"宿主真的调用了 5 个会话、没有再派生、产物确实由这些会话写出"。
宿主的会话日志里有确定性记录：

| 事件类型 | 含义 |
| --- | --- |
| `tool-workflow/run-start` / `run-end` | 一次 `workflow` 工具运行的开始与结束（含 `runId`、`stopReason`） |
| `tool-workflow/agent-start` / `agent-end` | 每次 `agent()` 调用的开始与结束（含 `seq`、`label`、`phase`、`childId`、`outcome`） |
| 子会话日志头 | 子会话的 `parentSession`、`delegationDepth`、`agentPreset`、`createdAt` |
| `request/context` | 该会话实际使用的 `provider` / `model` / `contextWindow` |
| `sandbox/mode`、`approval/policy` | 该会话的沙箱与审批策略 |
| `tool/call` | 工具名与参数（本工具只取文件路径或产物文件名，不导出载荷） |

## 2. 复算方法

在仓库根目录执行（`DSH_HOME` 已由宿主设置；本工具只读日志，不写入 `sessions/`）：

```powershell
$env:DSH_HOME  # 例如 C:\Users\<user>\.dsh
node tests/extract-native-events.mjs `
  --parent session-3f96bf08-83ae-48d6-a239-0223d4b1c12c `
  --workflow-name tla-v02-run1 `
  --since "2026-10-17T20:14:45+08:00" `
  --evidence-dir docs/evidence/v0.2-run1-20261017T121445Z `
  --script-file docs/run-records/v0.2-run1-20261017T121445Z/workflow-script-at-run.js `
  --out docs/run-records/v0.2-run1-20261017T121445Z/native-events.json
```

退出码：`0` = 10 项派生检查全过；`1` = 有检查失败（结果仍写盘）；`2` = 参数或日志结构问题。

同一命令重跑应得到**逐字节相同**的 `native-events.json`；唯一可能变化的是
`artifacts[].mtimeUtc`（文件系统时间）与 `invocation.at` 之外的宿主时间戳本身——这些字段
来自宿主的原始记录，不会因为重跑而改变，除非宿主清理过日志。

`workflow-script-at-run.js` 是**运行当时**实际提交给 `workflow` 工具的脚本文本快照
（104089 字节，sha256 `48f3aaea0b799ef4ec73d55d0344d5d4030e82d89d2c9afdf56fa084d84271b6`），
与 `git show [C16]:workflows/three-agent-mvp.js` 逐字节一致。
之所以另存一份，是因为 `workflows/three-agent-mvp.js` 在本轮之后已被修改，
否则无法复算"当时跑的到底是哪一版脚本"。

## 3. 提取结果（`native-events.json` 摘要）

运行身份：

| 字段 | 值 |
| --- | --- |
| workflow name | `tla-v02-run1` |
| 宿主 runId | `eb10cbf3-d04c-4fa1-913c-459e2f0e81dc` |
| 开始 / 结束（UTC） | `2026-10-17T12:19:03.240Z` / `2026-10-17T12:31:18.229Z` |
| stopReason | `completed` |
| agent 调用数 | 5 |

5 次 `agent()` 调用（均 `delegationDepth = 1`、`parentSession` = 父会话）：

| seq | 角色 | 阶段 | 子会话 | 模型 | 沙箱 / 审批 | 工具调用数 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Verifier (preflight) | preflight | `95080ad7-47d1-4914-ba2e-1f5b6f033a52` | deepseek-flash / deepseek-account | workspace-write / never | 9 |
| 2 | Requirement Agent | requirement | `e97396ba-711a-4947-b3a3-b7527a79a06b` | deepseek-flash / deepseek-account | workspace-write / never | 16 |
| 3 | Coding Agent | coding | `acd7cdfc-a9b4-4a52-a388-822bfce9682f` | deepseek-flash / deepseek-account | workspace-write / never | 28 |
| 4 | Verifier (verify) | verify | `cc7b6d6f-892a-40a2-aa01-4d9f3297607e` | deepseek-flash / deepseek-account | workspace-write / never | 22 |
| 5 | Review Agent | review | `76724e4f-4955-4d31-b8e4-959832246936` | deepseek-flash / deepseek-account | workspace-write / never | 27 |

产物归因（每个阶段产物恰由一个子会话产出）：

| 产物 | 字节 | sha256（前 12 位） | 归因方式 | 产出会话 |
| --- | --- | --- | --- | --- |
| `preflight.json` | 2140 | `5850288c50c0` | 时间窗（mtime 落于 #1 区间） | #1 Verifier (preflight) |
| `requirement.json` | 23000 | `9119b09ca0ac` | 写工具调用 | #2 Requirement Agent |
| `coding-report.json` | 5977 | `029929178700` | 写工具调用 | #3 Coding Agent |
| `verify.json` | 1384 | `f75ea00c2406` | 时间窗 | #4 Verifier (verify) |
| `review.json` | 15023 | `2f419cb69b56` | 写工具调用 | #5 Review Agent |
| `.run-owner.json` | 277 | `9b90d4607839` | 时间窗 | #1 Verifier (preflight) |

归因只承认两种机制（见 JSON 的 `extraction.attributionRules`）：

- `write-tool`：子会话里有写文件工具调用，目标路径就在证据目录内（强）。
- `time-window`：文件 `mtime` 落入**唯一**一个子会话的活动区间（次强；经 shell 写出的产物只能这样归因）。

两种都拿不到、或同时命中多个子会话时，检查项失败，不会"猜"。

## 4. 脚本指纹

`workflow` 工具的 `script` 参数在宿主侧会**去掉末尾换行**：

| 口径 | 字节 | sha256 |
| --- | --- | --- |
| 宿主记录的实际参数值 | 104088 | `7846694d2bdcccd9b675b3b79ff8be53c204ec4e0bb7e8ab539317445c0b94cf` |
| 仓库中的运行版脚本（含末尾换行） | 104089 | `48f3aaea0b799ef4ec73d55d0344d5d4030e82d89d2c9afdf56fa084d84271b6` |

去掉末尾换行后两者哈希相等 ⇒ 执行的脚本与 `git show [C16]:workflows/three-agent-mvp.js` 一致，
差异仅为那一个换行字节。检查项 `invocation.scriptMatchesRepo` 记录的就是这个结论。

`args` 只记录 `sha256` 与键名（`evidenceDir` / `promptDir` / `runId` / `runStartedAt` / `task`），
`argsSha256 = 917c3a4d732f49c48d0a94c5891e0ef49140185a529d09501a0722e81d7ee630`；
需求原文的具体内容另有 `requirement-injected.txt`（sha256 记录在 `approval.md` 与审查包里）。

## 5. 10 项派生检查（`derivedChecks`）

| id | 结论 |
| --- | --- |
| `run.single` | 时间窗内名为 `tla-v02-run1` 的运行恰好 1 次 |
| `run.completed` | `stopReason = completed` |
| `calls.count` | `agent-start` 事件 5 条 = 记录的调用数 |
| `calls.parentMatches` | 5 个子会话的 `parentSession` 都等于父会话 |
| `calls.depth` | 5 个子会话的 `delegationDepth` 都是 1 |
| `calls.noGrandchildren` | 全库会话中没有任何会话以这 5 个子会话为父 |
| `calls.uniqueChildren` | 5 个 `childId` 互不相同 |
| `invocation.scriptDigest` | 找到 `workflow` 工具调用参数并算出脚本哈希 |
| `invocation.scriptMatchesRepo` | 归一末尾换行后与运行版脚本一致 |
| `artifacts.writtenByChild` | 6 个产物都有字节/哈希，且各归属唯一一个子会话 |

## 6. 顺带核实的一件历史事实（失败试跑无副作用）

同一父会话日志里还有一条 0.47 秒即失败的运行：

| 字段 | 值 |
| --- | --- |
| name | `tla-v02-real-run` |
| runId | `11e3ec92-e421-4d54-b9a0-6e3cc63ce186` |
| 开始 / 结束（epoch ms） | `1792239375817` / `1792239376288` |
| stopReason | `error` |
| agent 调用 | 0 |

这与此前报告里"占位符试跑在第 1 行就 `ReferenceError`、未产生任何 agent 调用与证据目录"一致，
可作为该事故**没有副作用**的原生依据。提取器不把它算进本轮运行（`run.single` 只认
`--workflow-name` 指定的名字）。

## 7. 这份证据不能证明什么

1. **只能证明宿主记录了什么**。日志若被裁剪或损坏，本工具无法发现；它不声称宿主记录完整。
2. **不证明质量**。它证明 5 次调用发生、身份与产物来源，不证明产物内容正确——那要靠验收映射与测试。
3. **不覆盖未记录的操作**。子会话里若读写过证据目录之外的文件，这里只有工具名与目标路径，
   没有逐条写入校验；运行期写入边界另有 `bytecode_scope` 检查（见编排层与测试）。
4. **子会话审批策略是 `never`**（来源 `delegation`）：本次运行没有、也不可能有子代理的宿主审批事件；
   这一点由 `approval/policy` 事件本身证明，不需要推断。
5. **归因的时间窗机制依赖文件系统 mtime**，比写工具调用弱；`preflight.json`、`verify.json`、
   `.run-owner.json` 三项用的是这一机制，已在表中标注。
