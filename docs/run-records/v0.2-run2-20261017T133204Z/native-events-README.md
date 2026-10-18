# v0.2-run2 原生执行证据（会话日志白名单字段提取）

本目录的 `native-events.json` 是**原生证据**，不是编排层自己打印的派生摘要。
它由 `tests/extract-native-events.mjs` 只读解析 DSH 宿主写入的会话日志后生成。

- 提取器：`tests/extract-native-events.mjs`
- 输出：`docs/run-records/v0.2-run2-20261017T133204Z/native-events.json`
- 提取时间：`2026-10-17T14:12:52Z`（由复核套件第 13 步重新生成）
- 检查结果：**10/10** 派生检查通过（`checksAllPassed: true`）

## 1. 为什么需要这一份

`docs/evidence/v0.2-run2-20261017T133204Z/` 里的 JSON 是各子代理自己写的结论，
它能证明"有人写了这些结论"，但证明不了"这些结论是几个独立子会话写出来的、没有在编排层伪造、没有再多派生代理"。
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
$env:DSH_HOME  # 例如 <用户主目录>\.dsh
node tests/extract-native-events.mjs `
  --parent session-3f96bf08-83ae-48d6-a239-0223d4b1c12c `
  --workflow-name tla-v02-run2 `
  --since "2026-10-17T21:32:04+08:00" `
  --evidence-dir docs/evidence/v0.2-run2-20261017T133204Z `
  --script-file docs/run-records/v0.2-run2-20261017T133204Z/workflow-script-at-run.js `
  --out docs/run-records/v0.2-run2-20261017T133204Z/native-events.json
```

退出码：`0` = 10 项派生检查全过；`1` = 有检查失败（结果仍写盘）；`2` = 参数或日志结构问题。
同一命令重跑应得到**逐字节相同**的 `native-events.json`。

## 3. 脚本指纹（这份证据里最需要看清的一处）

| 对比项 | 值 |
| --- | --- |
| 宿主记录的 `arguments.script` | 127871 字节 / 2207 行 / sha256 `f56a0cc08992bfeb94ba6e0b34ef92c6f9423f8a1700e2be59b3d6cc350282cc` |
| `workflow-script-at-run.js`（本目录） | 与上面**逐字节相同**（`matchesRepoScriptExact: true`、`byteDelta: 0`） |
| 仓库当前 `workflows/three-agent-mvp.js` | 127870 字节 / sha256 `4a278d4a698342decc4d55ad6bdf0534d2caf4325553afb330a8613a204e47aa` |

差异：**只差一个空行**。这次运行是把脚本全文内联传给 `workflow` 工具（不是 `--script-file` 引用），
我在逐段抄写时，在 `const decision = judgeAttempt(...)` 与 `if (!decision.ok) { reportProblems(...) }`
之间多敲了一个换行。用 `difflib` 逐行比对确认：除此之外 2205 行逐字节一致，语义等价。
之所以另存一份 `workflow-script-at-run.js`，是为了让"当时到底跑的是哪一版脚本"可被复算——
仓库文件在这一轮之后已被修改（缓存账本修复），直接比对仓库文件会得出错误的"不一致"结论。

## 4. 提取结果摘要

| 字段 | 值 |
| --- | --- |
| workflow name | `tla-v02-run2` |
| runId | `07797972-fcf8-4a2a-929f-6ca22b86531a` |
| 时间窗 | `2026-10-17T13:36:52.511Z` → `13:58:48.553Z` |
| stopReason | `completed` |
| 子代理调用 | **10 次**，全部 `outcome: completed` |
| 模型 | 全部 `deepseek-account` / `deepseek-flash` / `contextWindow 1000000` |

调用序列（`seq` / 阶段 / 起止）：

| # | label | phase | 起（UTC） | 止（UTC） |
| --- | --- | --- | --- | --- |
| 1 | Verifier (preflight) | preflight | 13:36:52 | 13:37:33 |
| 2 | Requirement Agent | requirement | 13:37:33 | 13:41:27 |
| 3 | Coding Agent | coding | 13:41:27 | 13:45:38 |
| 4 | Verifier (verify) | verify | 13:45:38 | 13:46:34 |
| 5 | Review Agent | review | 13:46:34 | 13:49:39 |
| 6 | Cache Collector | cache | 13:49:39 | 13:50:44 |
| 7 | Coding Agent (revision 2) | coding-revision-2 | 13:50:44 | 13:54:01 |
| 8 | Verifier (verify) (revision 2) | verify-revision-2 | 13:54:01 | 13:55:15 |
| 9 | Review Agent (revision 2) | review-revision-2 | 13:55:15 | 13:57:58 |
| 10 | Cache Collector (revision 2) | cache-revision-2 | 13:57:58 | 13:58:48 |

产物归因：`requirement.json` / `coding-report.json` / `review.json` 由写文件工具写出（#2 / #3 / #5、以及
revision-2 的 #7 / #9 覆盖同名文件），`preflight.json` / `verify.json` / `.run-owner.json` 由子会话经 `pwsh` 写出
（按时间窗口归因，#1 / #4 / #1）。

## 5. 这一份不能证明什么

- 只能证明"宿主的会话日志里确实发生了这些调用与产物写入"，**不能**证明这些产物内容正确（那由
  `review-package/` 里的独立复核负责）；
- 日志字段是白名单提取，不是全量重放；没有导出提示词正文与会话消息内容（有意为之：其中可能含本机路径）；
- 本机用户目录已替换为 `<用户主目录>`（与 `precheck.json` 同一脱敏口径）。
