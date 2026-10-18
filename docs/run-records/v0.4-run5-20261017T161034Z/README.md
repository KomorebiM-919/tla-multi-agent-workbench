# 第五次真实运行记录（v0.4-run5-20261017T161034Z）

本目录是第五次真实多智能体运行的**审查材料**：运行参数、宿主日志抽取、脚本三方一致性、
缓存边界判定、独立复核与用量报告。运行本身由 `workflows/three-agent-mvp.js`（固定提交
`[C37]`）编排，本节记录的是**事后可复核的证据**，不是
"运行成功"的宣告：本目录的结论是"在给定条件下，五个角色各司其职且证据自洽"，交付代码是否
可以合入仍需人工复审（见 §7）。

## 1. 运行参数（运行前固定）

| 项 | 值 |
| --- | --- |
| 固定提交 | `[C37]`（`git rev-parse HEAD`） |
| 脚本 blob | `9501bd0af9c1bba7e12ecc3f6ee5e8bc8702db77`（`git rev-parse HEAD:workflows/three-agent-mvp.js`） |
| 脚本规模 | 143475 字节 / 2451 行（LF-only、无 BOM、末行有换行） |
| 运行标识 | `runId = v0.4-run5-20261017T161034Z`、`runStartedAt = 2026-10-18T00:10:34+08:00` |
| 证据目录 | `docs/evidence/v0.4-run5-20261017T161034Z`（运行前不存在） |
| 需求 | `v0.2-demo-input-3`，注入正文 `requirement-injected.txt`（15249 B，sha256 `6307a7f0ca0a84ccf0b8036ad202d7acaa56e8664d5761b22c10a915a86f71d7`，R-01–R-37） |
| 预算 | `maxAgentCalls = 8`、`maxCodingAttempts = 2`；`maxTotalTokens = 8 000 000` 仅事后观测 |
| 模型 | `deepseek-flash/deepseek-account`（沿用已确认 provider，未新增服务） |
| 自检指纹 | 提交时用 `node tests/script-fingerprint.mjs --schemas-only` 对该固定版本**新生成**的 8 个 schemas-only 指纹（`selfCheckRequired: true`） |

## 2. 执行文本一致性（宿主日志 → 预检稿 → 固定源码）

宿主日志（`native-events.json:script`）抽出的本次 `workflow` 调用：

| 项 | 宿主记录 | 对照 |
| --- | --- | --- |
| `callId` | `call_00_KWmrmk4lPjj0Y1F2x3651415` | — |
| `scriptBytes` | 143474 | `workflow-script-at-run.js`（本目录）= 143474 B |
| `scriptSha256` | `0099c08fdd72cf466ec5eb3e70cbaf580ef5cb94943055555ee97cc1949c1282` | `workflow-script-at-run.js` 复算相同 |
| 与仓库脚本 | `matchesRepoScript: true`、`matchesRepoScriptExact: false`、`byteDelta: -1`、`matchesRepoScriptIgnoringTrailingNewline: true` | 仓库/预检稿 sha256 均 `b21717d8d859bd94ef7acdfb0ce2792cf0f0ce0518c0a6a6f3ba1c6868988435`（143475 B） |

判定：**执行文本与预检稿逐字节相同，唯一差异是末尾那一个换行（LF）在传入宿主时被去掉**。这正是
用户授权时写明的"除末尾换行规则外任何差异 = 执行一致性失败"所允许的唯一例外，因此本项**通过**；
`workflow-script-at-run.js` 保存的是**宿主实际执行的那 143474 字节**，便于第三方直接复算
`0099c08f…`。

预检记录（`tests/.scratch/run5/`，运行前执行、不入库）：`node tests/preflight-workflow-script.mjs
--payload tests/.scratch/run5/payload.js --commit [C37]…` ⇒ PASS（exit 0）：143475 B 逐字节相同、
5 个 schema 全部合法（模拟 8 次调用）、`agentCalls.real = 0`。

## 3. 宿主运行结果

`ok: true`、`status: "OK"`、`verdict: "PROVISIONAL_OK"`、`attempts: 1`，`agentCallBudget`：
`limit 8` / `started 5` / `attempted 5`（无预算中止）：

| # | 角色 | 子会话 | 起止（UTC） |
| --- | --- | --- | --- |
| 1 | Verifier (preflight) | `2482b58f-285e-4348-9dfe-a069e54e27bf` | 16:12:59.192 → 16:13:31.868 |
| 2 | Requirement Agent | `b436cdc3-c7e4-4312-b4c1-87b40881b766` | 16:13:31.898 → 16:16:40.741 |
| 3 | Coding Agent | `951f93fb-657f-4cf7-8add-908a22379a1b` | 16:16:40.773 → 16:20:43.634 |
| 4 | Verifier (verify) | `af14c2e6-a945-4ff9-ba73-280193afc173` | 16:20:43.659 → 16:22:14.463 |
| 5 | Review Agent | `85c9c231-4356-4962-bd25-27756b1ed414` | 16:22:14.498 → 16:24:01.440 |

预检（本轮修复点）：`owner_marker_path` 回填为**仓库内相对路径**
`docs/evidence/v0.4-run5-20261017T161034Z/.run-owner.json`，认领 `claim_created: true`、
`claim_exit_code: 0`、`evidence_dir_state_before: "missing"`、`problems: []`——第四次运行的
"绝对路径 → `EVIDENCE_NOT_CLAIMED`"没有复现；该修复由 `[C37]` 引入，本轮是它的首次实跑验证。

各阶段产物（`docs/evidence/v0.4-run5-20261017T161034Z/`，写入者由 `native-events.json` 逐个核对）：
`preflight.json` 2503 B（write-tool #1）、`requirement.json` 26461 B（#2）、`coding-report.json`
10558 B（#3）、`verify.json` 5216 B（time-window #4）、`review.json` 15825 B（#5）、
`.run-owner.json` 277 B（认领工具）。

关键结论字段：需求阶段 29 条 `acceptance_criteria`（AC-01–AC-29）+ 30 条 `boundary_conditions`
（BC-01–BC-30）、`conflicts: []`；编码阶段 4 个文件、`test_succeeded: true`（`Ran 97 tests` +
`OK`）；验证阶段同一命令 `exit_code: "0"`、`ran_tests: 97`；审核阶段 `verdict: "APPROVED"`、
`criteria_check` 逐条覆盖 AC-01–AC-29 且独立复跑 `Ran 97 tests`。

## 4. 独立复核（本目录 `independent-review.py`，非代理产出）

`independent-review.py` 由复核者编写，不含任何模型调用，按需求条文重新推导 AC-01–AC-29 并逐条
实测（`python docs/run-records/v0.4-run5-20261017T161034Z/independent-review.py --out …`）：

- **25 组探针，覆盖全部 29 条 AC，25/25 PASS，exit 0**（`independent-review.json`）；
  其中 AC-11/12/14/15/16 由 34 个 `count_text` 用例一次性核对。
- 交付实现的行为抽查与审核结论一致：程序化调用静默（含 `--help`、受控错误）、命令行 4 行输出、
  五类受控错误退出码 1、`--encoding` 校验先于输入选择、`sys.exit(` 仅在模块入口、
  AST 视角的 import 只含标准库。
- README 的数值一律可复现（本轮另抽查）：`hello world\n` → 12/1/1/2、`a\r\nb\rc` → 5/3/3/3、
  `'  \r\n \r\n'` → 5/2/0/0（不是 6）、UTF-16LE 文件 → 4/1/1/1、`--help a.txt b.txt` → 0、
  `sample_input.txt` 20 字节 → 20/2/2/4；README 无裸 `U+2019`（R-36）。
- 证据指纹独立复算：`text_stats.py` = `5b6658d9…bd64`（13054 B）、`test_text_stats.py` =
  `b14e17d8…fbed`（45484 B），与 `verify.json` 和 `review.json` 的 `artifacts`/`artifacts_after`
  完全一致；审核与验证记录的是同一组 sha256。
- 交付目录内的既有 `.test-scratch/tmp*` 残留目录（12 个）创建时间均为 **2026-10-16 19:20–19:27**，
  早于本次运行；复核者的测试复跑前后条目数 13 → 13（未新增），README BC-27 注释已载明该历史残留
  与 ACL 限制。

## 5. 缓存边界（最终快照参与判定）

按"最后一个代理结束后**先**采集缓存，再启动其它复核"执行：

- `cache-before.json`（运行前，`tests/.scratch/run5/`）：2 条 pyc，`test_text_stats…pyc` 66316 B
  `24e090c3…`、`text_stats…pyc` 14885 B `453ece51…`。
- `cache-postrun.json`（`2026-10-18T00:24:05+08:00`，最后一个代理 00:24:01 之后）：内容与基线**逐条相同**。
- `python tests/verify-cache-boundary.py …` ⇒ **`status: "CLEAN"`，exit 0**，`violations: []`、
  `problems: []`，7 项检查全 ok：三方 `run_id` 一致、找到 3 个阶段观测点、快照晚于最后观测点、
  8 个观测点的 sha256 全部为 `7168ee6c…e8687`（与第四次运行相同）。
- 已知覆盖率限制（工具自述）：两次采集点之间的写入、以及"写完又改回原样且 mtime 变化 ≤ 5 ms"
  的瞬时写入不可观测；本判定不使用模型调用（`usesModelCalls: false`）。

## 6. 调用预算与 token 观测

- 调用：**5 / 8**（预检、需求、编码、验证、审核），无派生代理（`derivedAgentsAllowed: false`），
  无预算中止；实际 1 轮编码即通过，`maxCodingAttempts = 2` 未用满。
- `node tests/extract-usage-report.mjs …` ⇒ **5 个会话、100 条消息、`totalTokens = 4 465 947`**，
  `coverage: "complete"`（无缺日志、无缺 usage），`budget: "WITHIN_BUDGET"`（声明上限 8 000 000）。
- 口径提醒：这是**token 观测**，不是货币成本；`maxTotalTokens` 不是硬限额（编排层只硬限制调用次数）。

## 7. 剩余限制与未决事项

1. **交付代码仍需人工复审**：`examples/text-stats/` 的 3 个文件由本次运行改动，本地另行提交，
   未 push、未建 PR、未合并 `main`；本目录不构成"V0.1 通过"的宣告。
2. **执行文本末尾换行的差异**是宿主传递行为，不是脚本漂移；`workflow-script-at-run.js` 以实际执行的
   143474 字节入库，任何"脚本未被篡改"的复核都应对它做 sha256。
3. **缓存观测窗口**：只有"运行前 + 运行后 + 3 个阶段观测点"共 8 个观测点，窗口之间的写入不可见。
4. **`schema`/`prompt` 自检只覆盖 schema 指纹**：本次 `selfCheck` 只给 schema（`unchecked` 含 5 个
   prompt 字段），提示词漂移不在自检范围内，只能靠"脚本字节一致"间接保证。
5. **`.test-scratch/tmp*` 历史残留**（12 个，2026-10-16 创建）需人工处理 ACL 才能清理，与本轮无关。
6. **需求映射的人工判断**：AC 由需求代理从 R-01–R-37 推导，复核者按条文抽验并通过，但"每条 R
   是否都被某条 AC 覆盖"没有机械判定，只能人工比对。

## 8. 文件清单

| 文件 | 内容 |
| --- | --- |
| `README.md` | 本文件 |
| `workflow-script-at-run.js` | 宿主实际执行的脚本文本（143474 B，sha256 `0099c08f…`，无末尾换行） |
| `native-events.json` | 从宿主会话日志抽取的运行事件（checks 10/10） |
| `requirement-injected.txt` | 本次运行注入的需求正文（15249 B，与 v0.2-run1/run2 逐字节相同） |
| `cache-before.json` | 运行前缓存基线（2 条 pyc） |
| `cache-boundary.json` | 缓存边界判定（CLEAN，8 个观测点） |
| `independent-review.py` / `independent-review.json` | 复核者编写的 AC-01–AC-29 独立复核工具与结果（25/25 PASS） |
| `usage/declared-budget.json` | 声明预算（8 次调用 / 8 000 000 token 观测阈值） |
| `usage/usage-report.json` / `usage/extraction-metadata.json` | 用量报告与提取元数据（5 会话 / 4 465 947 token） |
| `SHA256SUMS.txt` | 本目录与 `docs/evidence/v0.4-run5-20261017T161034Z/` 全部文件的 sha256 |
