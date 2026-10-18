# v0.3-run3 运行中止记录（2026-10-17T15:12:15Z 开始）

本文件记录**第三次真实运行**（runId `v0.3-run3-20261017T151029Z`）为什么中止、现场留下了什么、
以及它在哪些意义上**不能**被称为"通过"。原始证据在 `docs/evidence/v0.3-run3-20261017T151029Z/`，
不被本文件改写。

## 1. 结论

- 运行**没有完成**：`workflowRun.stopReason = error`，`agentCallCount = 4`。
- 它**不是**契约失败（不是 `MAX_ATTEMPTS_*`、不是 `AGENT_CALL_BUDGET_EXCEEDED`、不是缓存门禁失败），
  而是宿主在**第 5 次子代理调用（Review）启动前**拒绝了这次调用的参数。
- 因此本次运行**没有审核结论**：`review.json` 不存在，25 条验收项（AC-01…AC-25）与 26 条边界条件
  （BC-01…BC-26）都**没有**被独立审核过。任何人不得把 `coding-report.json` 里 `test_succeeded: true`
  或 `verify.json` 里的测试通过读成"交付合格"。
- 缓存边界判定是 `CLEAN`（见第 5 节），但这只说明**没有观测到意外的缓存写入**，
  不说明交付内容正确。

## 2. 中止点与宿主错误原文

宿主拒绝发生在 Review Agent 调用处（`runBudgetedAgent` 的第 5 次调用）：

```
WorkflowError: agent() schema is outside the supported subset — unsupported JSON schema:
schema.properties.issues.items.properties requires type or oneOf;
schema.properties.issues.items.required requires type or oneOf;
schema.properties.issues.items.additionalProperties requires type or oneOf
```

栈：`WorkflowExecution.readAgentOptions (dsh-workflow-guest.js:903:10)` →
`agent (dsh-workflow-guest.js:726:47)` → `runBudgetedAgent (workflow:tla-v03-run3:1837:16)` →
`workflow:tla-v03-run3:2112:24`。

## 3. 根因：内联脚本的转录漂移（不是仓库脚本缺陷）

脚本必须以纯文本内联进 `workflow` 调用（脚本没有文件系统 API）。本次运行的内联副本是我手工转录的
2299 行，逐字节对比（`tests/.scratch/unattended/diff-run3-script.py`，基线为运行前的提交
`[C30]` 中的 `workflows/three-agent-mvp.js`）只有 **2 处**差异：

| # | 位置 | 差异 | 后果 |
| --- | --- | --- | --- |
| 1 | `REVIEW_SCHEMA.properties.issues.items` | 漏掉 `type: 'object',` 一行 | **致命**：宿主认为 schema 不在支持子集内，Review 无法启动 |
| 2 | `preflightNowMs` 上方的注释 | 注释末句被截短（`…未到时间。` → `…未到时间`） | 无行为影响 |

- 仓库文件在 `[C30]` 是**正确**的（含 `type: 'object'`），所以这不是仓库脚本的缺陷。
- 执行副本已原样归档为 `docs/run-records/v0.3-run3-20261017T151029Z/workflow-script-at-run.js`
  （134705 B，sha256 `5766ccc3fb0791691b4b458cbe18f825c6c7998be0749ee28b660b186de2c481`）。
- 注意：**该归档文件与现在仓库里的脚本已经不可逐字节比较**——run3 之后仓库脚本增加了 `selfCheck`
  指纹自检（第 8 节），文件从 134735 B 增长到 140155 B。`native-events.json` 里
  `invocation.matchesRepoScript: true` 是因为提取时用 `--script-file` 指向了这份**执行副本本身**，
  它只证明"归档 = 执行"，**不证明**"执行 = 仓库"。真正的漂移证据是上面这张 diff 表。

## 4. 调用账本（4 / 8）

| seq | 标签 | 阶段 | 开始（UTC） | 结束（UTC） | 子会话 |
| --- | --- | --- | --- | --- | --- |
| 1 | Verifier (preflight) | preflight | 15:12:16 | 15:13:21 | `1061a2f2-…` |
| 2 | Requirement Agent | requirement | 15:13:21 | 15:18:57 | `7d10e3c9-…` |
| 3 | Coding Agent | coding | 15:18:57 | 15:22:13 | `f2bf28f4-…` |
| 4 | Verifier (verify) | verify | 15:22:13 | 15:23:05 | `22e058ba-…` |
| — | Review Agent | review | **未启动** | — | — |

- 4 次 ≤ `maxAgentCalls = 8`，**没有超限**；第 5 次是被宿主在参数校验阶段拒绝的，不是被预算拦的。
- 没有派生代理（4 个子会话的 `parentSession` 都指向父会话）。

## 5. 全运行缓存边界的独立判定：`CLEAN`

运行结束后**在任何其它 Python 导入之前**采了一次快照，然后用确定性工具判定（0 次模型调用）：

```
python tests/collect-cache-state.py --target-dir examples/text-stats \
  --run-id v0.3-run3-20261017T151029Z --snapshot-label cache-postrun \
  --out docs/evidence/v0.3-run3-20261017T151029Z/cache-postrun.json --pretty

python tests/verify-cache-boundary.py --run-id v0.3-run3-20261017T151029Z \
  --evidence-dir docs/evidence/v0.3-run3-20261017T151029Z \
  --baseline docs/evidence/v0.3-run3-20261017T151029Z/cache-before.json \
  --postrun docs/evidence/v0.3-run3-20261017T151029Z/cache-postrun.json \
  --out docs/run-records/v0.3-run3-20261017T151029Z/cache-boundary.json --pretty
```

结果 `status: "CLEAN"`：7 项检查全 `ok: true`（`baseline_present`、`postrun_present`、`run_identity`、
`stage_observations_found`、`postrun_after_last_observation`、`stage_observations_usable`、`no_violations`），
`violations: []`、`problems: []`，时间线 6 个观测点（基线 → Coding 前后 → Verifier 前后 → 运行后快照），
`tolerance_ms: 5`。两条 `.pyc` 在基线与运行后快照里逐字段相同：

| 文件 | bytes | mtime_ms | sha256 |
| --- | --- | --- | --- |
| `examples/text-stats/__pycache__/test_text_stats.cpython-313.pyc` | 66316 | 1792240028919 | `24e090c3…d4317280` |
| `examples/text-stats/__pycache__/text_stats.cpython-313.pyc` | 14885 | 1792244851273 | `453ece51…b82d2b` |

**证明边界**（照 `coverage.unobservedWindow` 原样）：两次采集之间的写入不可观测；"写完又改回原样、
且 mtime 变化不超过 5 毫秒"的瞬时写入不可观测。`CLEAN` 的准确含义是"在已观测的窗口里没有发现意外写入"。

## 6. 交付物现状

- Coding Agent 改动了 3 个文件（`git diff --stat`：`examples/text-stats/README.md` 22、`test_text_stats.py` 97、
  `text_stats.py` 2，共 +99/−22），Verifier 记录的产物指纹：
  `text_stats.py` 13008 B / sha `077c7bff…`、`test_text_stats.py` 40850 B / sha `c496a047…`。
- 这些改动**没有经过审核**，因此**没有**留在工作区：完整 diff 已归档为
  `docs/run-records/v0.3-run3-20261017T151029Z/delivery.diff`（16425 B，UTF-8 文本；抓取时 PowerShell
  `>` 重定向写的是 UTF-16LE，归档前已转成 UTF-8 无 BOM，否则 Git 会把它当二进制），随后工作区用
  `git checkout -- examples/text-stats` 还原到 `HEAD`。
- 也就是说：本次运行的交付物只以"待审 diff"的形式存在，未合并、未采纳。

## 7. 用量（只读复算，事后观测）

```
node tests/extract-usage-report.mjs --run-id v0.3-run3-20261017T151029Z \
  --run-record docs/run-records/v0.3-run3-20261017T151029Z \
  --out-dir docs/run-records/v0.3-run3-20261017T151029Z/usage \
  --declared-budget docs/run-records/v0.3-run3-20261017T151029Z/usage/declared-budget.json
```

结果：4 个会话 / 83 条消息 / `totalTokens = 3 916 632`，`coverage = complete`，
`budget = WITHIN_BUDGET`（声明 `maxAgentCalls = 8`、`maxTotalTokens = 8 000 000`）。

- 调用预算：4 / 8，**未超限**。
- token 观测：3 916 632 ≤ 8 000 000，`WITHIN_BUDGET`——这是**事后观测判定**，
  工作流并不能在 8M 处强制停止。
- 货币成本：未提供价格，不能由 token 换算金额。

## 8. 事后加固（本次事故的直接产出）

`workflows/three-agent-mvp.js` 新增内联脚本指纹自检：

- `driftHash(text)`（FNV-1a 32 位 + djb2 32 位 + 字符数）与 `selfCheckValue(prompt, schema)`；
- `checkSelfCheck(label, prompt, schema)` 在**每次调用启动之前**比对提示词与 schema 的指纹，
  不一致返回 `SCRIPT_DRIFT`（错误文本写明是 `schema 指纹不一致` 还是 `提示词指纹不一致`）；
- `args.selfCheckRequired: true` 时缺期望指纹也 fail-closed 中止，因此"漏转录一整段标签"不会静默通过；
- `node tests/script-fingerprint.mjs` 生成 `args.selfCheck`（4 项自检：正确指纹通过、篡改 schema 指纹时
  只发出 4 次调用、缺指纹时 0 次调用、旧方式仍可用且如实报告 `scriptSelfCheck.enabled: false`）。

**这条加固只覆盖"提示词 + schema"**。判定逻辑（`judgeAttempt` 等）的转录漂移仍要靠运行后的
`invocation.scriptMatchesRepo` 核对与人工复核；它降低风险，不消除风险。

## 9. 不能证明什么

- 不能证明交付内容正确或符合需求：没有 Review 结论。
- 不能证明脚本与仓库文件一致（见第 3 节末）。
- 不能证明"运行结束之后没有缓存写入"：只有一次运行后快照，覆盖窗口见第 5 节的证明边界。
- 不能把本次运行算作 V0.1 验收的一部分；下一次运行需要所有者**单独授权**，不会自动重开。
