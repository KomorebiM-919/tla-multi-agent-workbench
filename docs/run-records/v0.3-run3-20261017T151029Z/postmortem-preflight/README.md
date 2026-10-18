# 事故后的执行前校验（run3 之后追加，不修改中止证据）

本目录是 `v0.3-run3-20261017T151029Z` 中止之后**追加**的离线材料，对应 `m11670` 的要求：先解决"脚本怎么可靠送到宿主"和"0 次调用能不能发现问题"，
再谈第四次运行。**本目录不含任何真实模型调用**，也没有修改同级的 `run-aborted.md`、`native-events.json`、`cache-boundary.json`、
`delivery.diff`、`usage/` 等原始中止证据。

## 1. 结论先写

- **宿主没有"从文件读脚本"的机器传递路径**（已核实，见 §2），因此脚本只能以文本内联提交。
- **宿主也没有零调用的 schema 校验接口**（已核实，见 §2），所以"Review schema 缺 `type`"这类错误只能由本地实现提前发现。
- 因此本轮新增 `tests/preflight-workflow-script.mjs`：把**准备提交的载荷**与**固定提交里的源码字节**逐字节比较，
  并对全部 5 个 schema 跑宿主支持子集规则的本地实现。它是本地检查，**不等于宿主已接受**。
- 按本目录 `preflight-report.json`：提交 `[C32]` 的载荷
  **141953 字节 / sha256 `05c62896…`** 与源码**逐字节相同**，5 个 schema 全部合法，**真实模型调用 0 次**（模拟 8 次）。

## 2. 宿主能力核实（asar 只读探查，未改宿主、未装依赖）

| 事项 | 结论 | 证据 |
| --- | --- | --- |
| `workflow` 工具能否接受文件路径 | **不能** | `dsh-tool-workflow/lib/index.js` 的 `parameters` 只有 `script`(string) / `meta`(object) / `args`；`rawInput: args.script` |
| 引擎 API 能否接受文件 | **不能** | `dsh-workflow/README.md`：`ctx.workflowEngine.start({ script, meta, args?, parent, signal? })`，且明确 "No saved or nested workflows — the capability starts caller-supplied scripts only" |
| schema 子集校验发生在何时 | **`agent()` 调用链内部** | `dsh-workflow-ptc/lib/index.js` 的 `assertObjectJsonSchema(request.schema)`，无"先校验再启动"的公开接口 |
| 是否有零调用校验入口 | **没有** | 同上；本地 `schemaViolations()` 只是宿主规则的**本地复刻** |

复刻的规则来自 `dsh-tools/lib/types/json-schema.js`：支持关键字 `type/oneOf/properties/required/additionalProperties/items/enum/const`
（外加 `description/title/default/examples` 注释键）；`type` 与 `oneOf` 互斥；**两者都没有却出现 `properties/required/additionalProperties/items/enum/const`
时报 `<path>.<key> requires type or oneOf`**——run3 的致命错误正是这一条。

## 3. 本目录的 `preflight-report.json` 怎么复算

```powershell
$sha = '[C32]'
cmd /c "git show ${sha}:workflows/three-agent-mvp.js > tests/.scratch/payload.js"
node tests/preflight-workflow-script.mjs --payload tests/.scratch/payload.js --commit $sha --out out.json
```

报告里的关键字段：

- `comparison`：`rawIdentical` / `normalizedIdentical` / `byteDelta` / `firstDifference`；**唯一**允许的规范化是
  `normalizeTrailingNewline()`（把末尾连续换行压成一个 `\n`），原始哈希与规范化哈希同时保留，不做"语义等价"豁免。
- `schemas`：`distinct = 5`、`capturedCalls = 8`（两轮模拟）、`allValid`、逐个 label 的 `sha256` 与 `violations`。
- `hostCapabilities`：`machineScriptTransfer: unsupported-by-tool-schema`、`zeroCallSchemaValidation: unavailable`、
  `agentCalls: { real: 0, simulated: 8 }`。

## 4. 反向测试（`node tests/preflight-script.test.mjs`，9 场景 / 42 断言）

| 场景 | 期望 |
| --- | --- |
| 载荷与固定提交逐字节相同 | 退出 0、`PASS`、`agentCalls.real === 0` |
| 只多一个末尾换行 | 退出 0，但 `sha256Raw` 不同、`byteDelta === 1`、规范化哈希相同 |
| `REVIEW_SCHEMA.properties.issues.items` 删掉 `type` | 退出 12、点名 `Review Agent`、违规含 `requires type or oneOf` |
| `if (!decision.ok) {` 改成 `if (decision.ok === false) {` | 退出 10（判定代码改动不得豁免） |
| 删掉一行 `log(...)` | 退出 10 |
| 只改注释 | 退出 10 |
| 换行改成 CRLF | 退出 10 |
| 纯函数 `schemaViolations()` 直接检查删掉 `type` 的 Review schema | 报出 `required` / `additionalProperties` / `properties` 三条 `requires type or oneOf` |
| 缺少 `--commit` | 退出 4 |

## 5. run3 现场保持原样（只读核对）

- 原始中止证据未改动：`git status --porcelain -- docs/evidence/v0.3-run3-20261017T151029Z docs/run-records/v0.3-run3-20261017T151029Z` 为空
  （本目录是新增文件，不覆盖任何已有记录）。
- 交付物已还原且与 `HEAD` 一致：`git status --porcelain -- examples/text-stats` 为空。
- `delivery.diff` **可在独立副本恢复**（未改动工作树）：`git worktree add --detach <tmp> HEAD` 后
  `git -C <tmp> apply --check delivery.diff` 与 `git apply` 均退出 0，`git -C <tmp> status --porcelain` 恰好三个 `M`；
  恢复出的文件与 run3 的 `verify.json` 记录逐字节一致：
  `text_stats.py` 13008 B / `077c7bffee24f806…`、`test_text_stats.py` 40850 B / `c496a04792cba3a5…`。
  该路径**不会被自动应用**：那是未经审核的交付，恢复只在独立副本里做过一次核对。

## 6. 这份材料不能证明什么

- 不能证明"我下一次实际提交的文本 = 这里校验过的载荷"——宿主没有机会在启动前校验请求体，本工具也无法介入那一层；
  这条只能靠运行后的 `tests/extract-native-events.mjs`（`invocation.scriptMatchesRepo`）事后核对。
- 不能证明"本地 schema 检查通过 = 宿主接受"——宿主校验发生在 `agent()` 内部，本地实现只是规则复刻。
- 不能证明 run3 的交付物合格：run3 在 Review 启动前中止，**没有审核结论**，`delivery.diff` 仍属未审核内容。
- 不含任何真实运行：**第四次真实运行仍需所有者单独授权**，调用数与 token 观测额度另行批准。
