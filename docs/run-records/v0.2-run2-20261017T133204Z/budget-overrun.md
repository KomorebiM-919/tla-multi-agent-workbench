# v0.2-run2 调用超限复盘（追加记录）

- 运行：`v0.2-run2-20261017T133204Z`（workflowRun `07797972-fcf8-4a2a-929f-6ca22b86531a`）
- 记录性质：**事后追加**。本文件不修改任何原始运行证据，也不构成对超限的事后追认。
- 复算入口：`docs/run-records/v0.2-run2-20261017T133204Z/usage/usage-report.json`（由 `tests/extract-usage-report.mjs` 只读生成）
- 原始证据：`native-events.json`（10 次调用的会话标识与时间线）、`docs/evidence/v0.2-run2-20261017T133204Z/`（各阶段 JSON）

## 1. 事实：批准上限 8，实际 10

| 项 | 值 | 依据 |
| --- | --- | --- |
| 批准的子代理调用上限 | **8 次** | `docs/run-records/v0.2-run1-20261017T121445Z/approval.md` §5「同时批准的执行预算与边界（来自同一条用户消息）」：「工作流子代理调用：最多 8 次（计划 5 次，最多 1 轮编码返工）」；run2 的授权（用户消息 m08801）沿用同一执行边界，未另行放宽 |
| 同一批准里的派生限制 | 不允许子代理再派生其他代理扩大调用量 | 同上 §5。本次运行未出现再派生子会话（`usage-report.json` 的 `coverage.derivedSessions` 为空） |
| 本次实际调用 | **10 次** | `native-events.json` 的 `agentCalls` 共 10 条、`workflowRun.agentCallCount = 10`；`usage-report.json` 找到 10 个子会话日志，覆盖完整 |
| 超出量 | **+2 次（+25%）** | 10 − 8 |

## 2. 多出来的 2 次调用是哪些、为什么

| seq | 阶段 | 标签 | totalTokens | 它做了什么 |
| --- | --- | --- | --- | --- |
| 6 | `cache` | `Cache Collector` | 560 169 | 只读采集 `<targetDir>/__pycache__` 的路径/字节数/mtime/sha256，交回 `cache-final.json` |
| 10 | `cache-revision-2` | `Cache Collector (revision 2)` | 286 096 | 同上，第二轮编码之后的最终清单 |

- **来源**：`Cache Collector` 阶段是 run1 之后新增的（提交 `[C25]`「第二次运行前的两项准备」里的**全运行缓存账本**）。run1 只有 5 次调用（`preflight → requirement → coding → verify → review`），完全在 8 次以内；run2 每个编码轮次多出 1 次 `Cache Collector`，两轮共多 2 次。
- **原因**：新增该阶段时，**没有把"批准预算 8 次"重新对账**。当时的推理只覆盖了"最坏情况 = 2 + 3 × 轮次 = 8"，漏算了自己新加的第 6 个阶段；`maxCodingAttempts = 2` 时的真实最坏情况是 `2 + 4 × 2 = 10`。
- **性质**：这 2 次是**真实的付费模型调用**，不是本地脚本、不是免费工具调用。它们产生的价值仅限于读取文件指纹——而这件事用确定性工具几十毫秒就能做完，不需要模型。

## 3. 这个超限与运行失败的关系

- 运行最终返回 `ok: false` / `MAX_ATTEMPTS_BYTECODE_CACHE_CHANGED_ACROSS_RUN`，**超限不是失败的原因，失败也不是超限的免责理由**：
  - 超限发生在第 6 次与第 10 次调用（13:49:39Z、13:57:58Z），运行当时并未中止；
  - 运行失败的原因是有一次**真实缓存写入**（Review 阶段用不带 `PYTHONDONTWRITEBYTECODE=1` 前缀的 Python 读取模块）加上 4 条 mtime 整数/浮点表示差误报，与调用次数无关。
- 因此本记录**不主张**"反正本次运行没通过，多花的 2 次可以不算"。

## 4. 代价（离线复算的用量，不是报价）

| 口径 | 值 |
| --- | --- |
| run2 全部 10 次调用 `totalTokens` | **8 773 691** |
| 其中两次 `Cache Collector` | **846 265**（560 169 + 286 096），占 **9.6%** |
| 同一份需求的 run1 全部 5 次调用 | 3 918 430 |
| run1 是否在预算内 | **WITHIN_BUDGET**（5 ≤ 8） |

- 字段恒等式 `totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` 在 184 条消息上全部成立（`mismatched = 0`）。
- **不输出货币成本**：会话日志里没有 price/cost/billing 字段，价格与渠道计费未核实，报告里固定写「未提供价格」。token 数不等于费用。
- 批准消息只声明了**调用次数**上限，没有声明 token 上限，因此本记录**不做** token 超限判定（`declared-budget.json` 的 `maxTotalTokens = null`）。

## 5. 已做的处置（不是口头承诺）

| 处置 | 落点 | 证明 |
| --- | --- | --- |
| 调用次数成为**可配置的硬上限**（默认 8，范围 1–32） | `workflows/three-agent-mvp.js` 的 `AGENT_CALL_BUDGET_DEFAULT` / `AGENT_CALL_BUDGET_LIMIT`、`validateRunConfig` 的 `task.maxAgentCalls` | `tests/workflow-logic.test.mjs` 场景 56–59（非法值 → `INVALID_ARGS`） |
| 每次模型调用**启动前**检查总量，超限即拒绝启动并中止 | 同上 `runBudgetedAgent()` / `budgetFailure()` / 返回 `agentCallBudget.calls[].started` | 场景 57：`maxAgentCalls = 7` 时第 8 次调用 `started: false`，状态 `AGENT_CALL_BUDGET_EXCEEDED`；场景 58：`maxAgentCalls = 8` 时第 9 次调用 `started: false` |
| 删除 `Cache Collector` 阶段（每轮省 1 次调用） | 同上：阶段、`FINAL_CACHE_SCHEMA`、`cacheFinalPrompt()` 一并删除；返回值改为声明 `postRunCacheSnapshot` 由本地工具补采 | 场景 56–58 的调用账本长度（1 轮 5 次、2 轮 8 次） |
| 缓存快照改用**确定性本地工具** | `tests/collect-cache-state.py`（只读，0 次模型调用） | 与 run2 的 `cache-final.json` 交叉验证一致（`text_stats.cpython-313.pyc` 14885 B / `453ece51d210…`） |
| 用量可离线复算 | `tests/extract-usage-report.mjs` + `tests/usage-report.test.mjs` | 12/12 场景、67 项断言；run1/run2 只读复算结论见 §4 |

**能力边界（必须一起说清）**：编排层能**硬限制子代理启动次数**（启动前检查，第 N+1 次不会发生），但**无法硬限制单个子代理内部的 token 消耗**——一轮 Coding 花多少 token 由模型自身行为决定，脚本只能事后统计。两者不能混为一谈；`agentCallBudget.limits` 字段把这句话写进了返回值。

## 6. 明确不做的事

- 不把这次 10 次调用追认为"已获批的 10 次"；
- 不修改 `approval.md`、`native-events.json` 或任何原始证据文件；
- 不因为运行失败而免除超限责任；
- 不自动启动第三次运行——是否重跑、按什么预算重跑，由仓库所有者单独授权。

## 7. 复算方法

```powershell
# 1) 只读提取用量（不联网、不调用模型、不读凭据；默认排除父会话）
node tests/extract-usage-report.mjs `
  --run-id v0.2-run2-20261017T133204Z `
  --run-record docs/run-records/v0.2-run2-20261017T133204Z `
  --declared-budget docs/run-records/v0.2-run2-20261017T133204Z/usage/declared-budget.json `
  --out-dir <新目录>

# 2) 期望输出（确定性部分）
#    10 个会话、184 条消息、totalTokens = 8773691、coverage = complete、budget = OVER_BUDGET
#    理由：观察到子会话数 10 超过声明上限 8（超出 2 个）
```

- `usage-report.json` 不含提取时刻，同一输入两次运行逐字节相同；提取时间、耗时、日志文件指纹放在 `extraction-metadata.json`。
