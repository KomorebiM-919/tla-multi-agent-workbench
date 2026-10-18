# 运行批准记录 — v0.2-run2

## 1. 批准来源

| 项 | 值 |
| --- | --- |
| 批准方式 | 父会话内用户直接书面回复（宿主消息 `m08801`，2026-10-17，本地时区 UTC+8） |
| 批准内容（要点概述，非逐字原文） | 授权我直接执行第二次真实运行（不再逐项询问）；需求文本沿用已批准的 `v0.2-demo-input-3`；运行结束后做独立复核与本地提交，不 push |
| 被批准对象 | 同一份注入需求文本（见 §2），以及"用 `workflows/three-agent-mvp.js` 跑一次完整流水线"这个动作本身 |
| 本次运行 | `v0.2-run2-20261017T133204Z`（新 runId，排他证据目录，不复用 run1 的目录） |

## 2. 注入需求文本的固化

| 项 | 值 |
| --- | --- |
| 注入文本文件 | `docs/run-records/v0.2-run2-20261017T133204Z/requirement-injected.txt` |
| 注入文本规格 | 15249 字节 / 123 行 / 仅 LF / UTF-8 |
| 注入文本 SHA-256 | `6307a7f0ca0a84ccf0b8036ad202d7acaa56e8664d5761b22c10a915a86f71d7` |
| 与 run1 的关系 | **逐字节相同**（同一份已批准原文，未改动任何条款） |
| 注入方式 | 由 `tests/.scratch/unattended/prep-run2.py` 写 `run-args.json`，工作流以 `task.requirement` 注入；`runStartedAt` = `2026-10-17T21:32:04+08:00` |

## 3. 本次运行实际执行的东西

| 项 | 值 |
| --- | --- |
| 脚本（仓库文件） | `workflows/three-agent-mvp.js`（127870 字节，sha256 `4a278d4a698342decc4d55ad6bdf0534d2caf4325553afb330a8613a204e47aa`） |
| 脚本（**实际提交给宿主**的文本） | `docs/run-records/v0.2-run2-20261017T133204Z/workflow-script-at-run.js`（127871 字节，sha256 `f56a0cc08992bfeb…0282cc`） |
| 两者差异 | 只差**一个空行**（`judgeAttempt` 调用与 `if (!decision.ok)` 之间）。原因：这次运行是把脚本全文内联传给 `workflow` 工具，我逐段抄写时多敲了一个换行；语义等价，已用 `difflib` 逐行核实并记录在 `native-events-README.md` |
| 运行参数 | `run-args.json`（含 `cacheBaseline` 两项：`__pycache__` 下两个 `.pyc` 的 bytes / mtime_ms / sha256） |
| 编码尝试上限 | `maxCodingAttempts = 2` |
| 交付范围 | 仅 `examples/text-stats`（R-32） |
| 远端 | 不 push、不改 PR、不合并 |

## 4. 需求批准 ≠ 最终验收

- 本次运行返回 `ok: false`（`MAX_ATTEMPTS_BYTECODE_CACHE_CHANGED_ACROSS_RUN`），**不是**通过。
- 但两轮的实质产物都合格：81 例测试通过、Verifier 独立复跑通过、Review `APPROVED` 且 51 条验收项逐条 satisfied。
- 不通过的原因经复核为"1 条真实写入 + 4 条 mtime 表示精度误报"（详见 `docs/ROADMAP.md` 的 `v0.2-run2` 条目与
  `review-package/README.md`），已在同轮修复并补了离线场景。
- **是否重跑第三次，由仓库所有者决定**；本轮不自动启动。

## 5. 记录脱敏

`precheck.json` 与 `native-events.json` 在归档前做过脱敏：本机用户目录被替换为 `<用户主目录>`，
其余字节不变；`codexHome` 等无关字段不涉及。脱敏只影响记录文件，流水线未读取这些字节。
