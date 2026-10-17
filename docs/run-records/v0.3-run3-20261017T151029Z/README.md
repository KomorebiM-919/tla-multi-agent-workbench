# v0.3-run3 运行记录（中止）

runId `v0.3-run3-20261017T151029Z`，始于 `2026-10-17T23:10:29+08:00`，**止于 Review Agent 启动前**
（`stopReason: error`，4 次子代理调用）。中止原因、现场与"不能证明什么"见 `run-aborted.md`；
本目录不放任何"通过"结论。

| 文件 | 内容 |
| --- | --- |
| `run-aborted.md` | 中止记录：宿主错误原文、转录漂移的逐行 diff、调用账本 4/8、缓存边界 `CLEAN`、交付 diff 的去向、用量、事后加固 |
| `workflow-script-at-run.js` | **实际被执行**的内联脚本原件（134705 B，sha256 `5766ccc3…de2c481`）。它不是仓库文件的副本，差异见 `run-aborted.md` §3 |
| `native-events.json` | 宿主会话日志白名单提取：4 次调用、子会话 id、模型、产物归因、`invocation` 指纹。8/10 检查通过，失败的 2 项正是"运行未完成"与"没有 `review.json`" |
| `cache-boundary.json` | `tests/verify-cache-boundary.py` 的独立判定：`CLEAN`，7 项检查全过，时间线 6 个观测点，`violations: []` |
| `delivery.diff` | Coding Agent 改动 3 个文件的完整 diff（+99/−22，16425 B，UTF-8 文本）。**未经审核、未采纳**，工作区已用 `git checkout -- examples/text-stats` 还原 |
| `usage/usage-report.json` | 只读用量汇总：4 会话 / 83 条消息 / `totalTokens = 3 916 632` / `WITHIN_BUDGET`（事后观测，不是硬限额） |
| `usage/extraction-metadata.json` | 易变元数据（提取时间、日志来源指纹、字段语义与覆盖范围），与上面的确定性报告分开 |
| `usage/declared-budget.json` | 运行前声明的预算：`maxAgentCalls = 8`、`maxTotalTokens = 8 000 000`（来源 `m11171`） |
| `SHA256SUMS.txt` | 本目录与 `docs/evidence/<runId>/` 全部文件的 sha256（15 条，逐条重算 0 失配） |

## 为什么没有 `review-package/`

`tests/run-review-suite.py` 的 13 条命令是**围绕一份已完成的运行**做独立复核的：需求映射比对
`review.json`、交付物指纹比对 `verify.json`、变异体在交付代码上跑。本次运行没有 `review.json`
（Review 未启动），交付改动也已从工作区还原，因此那套复核**没有可对照的结论**，强行跑只会得到一组
"文件不存在"的失败，不能提供任何独立性。取而代之的是三件不依赖模型结论、可逐条拒绝的检查：

1. 缓存边界（`cache-boundary.json`，0 次模型调用，快照缺失/身份不符/超容差变化都会判失败）；
2. 原生事件（`native-events.json`，直接读宿主日志，失败项如实保留）；
3. 用量复算（`usage/usage-report.json`，只读日志，两次运行逐字节相同）。

## 复算命令

```
python tests/verify-cache-boundary.py --run-id v0.3-run3-20261017T151029Z \
  --evidence-dir docs/evidence/v0.3-run3-20261017T151029Z \
  --baseline docs/evidence/v0.3-run3-20261017T151029Z/cache-before.json \
  --postrun docs/evidence/v0.3-run3-20261017T151029Z/cache-postrun.json \
  --out <新目录>/cache-boundary.json

node tests/extract-native-events.mjs --parent session-3f96bf08-83ae-48d6-a239-0223d4b1c12c \
  --workflow-name tla-v03-run3 --since 2026-10-17T23:10:00+08:00 \
  --evidence-dir docs/evidence/v0.3-run3-20261017T151029Z \
  --script-file docs/run-records/v0.3-run3-20261017T151029Z/workflow-script-at-run.js \
  --out <新目录>/native-events.json

node tests/extract-usage-report.mjs --run-id v0.3-run3-20261017T151029Z \
  --run-record docs/run-records/v0.3-run3-20261017T151029Z \
  --out-dir <新目录>/usage \
  --declared-budget docs/run-records/v0.3-run3-20261017T151029Z/usage/declared-budget.json
```

注意 `--script-file` 指向的是**执行副本本身**，所以 `invocation.matchesRepoScript` 只证明"归档 = 执行"，
不证明"执行 = 仓库"；后者要看 `run-aborted.md` §3 的逐行 diff。

## 不能证明什么

- 没有审核结论：25 条 AC 与 26 条 BC 都未被独立审核，`coding-report.json` 的 `test_succeeded: true`
  不等于交付合格。
- 缓存 `CLEAN` 只覆盖已观测窗口（两次采集之间的写入、写完改回原样且 mtime 变化 ≤ 5 毫秒的写入不可观测）。
- 用量 `WITHIN_BUDGET` 是事后观测判定，不能读成"工作流能在 8M 处强制停止"。
- 本次运行不计入 V0.1 验收；下一次运行需要所有者单独授权，不自动重开。
