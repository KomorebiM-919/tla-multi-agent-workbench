# run 6 证据：门禁首次放行的一次完整运行

- **runId**：`v0.1-run6-20261016T154400Z`
- **runStartedAt**：`2026-10-16T23:44:00+08:00`（由 runId 尾部 UTC 时间戳派生，用于证据时间戳窗口校验）
- **返回值**：`ok: true`、`status: OK`、`attempts: 2`、`errors: []`
- **最终判定**：Review Agent 第二轮 `APPROVED`（23/23 验收标准 satisfied），Verifier 两次独立复跑 `Ran 81 tests` / `OK` / exit 0
- **这是本项目第一次由门禁放行的运行**：run 1–run 5 分别因证据目录冲突、返回值语义、指纹口径不一致、需求文本自相矛盾（AC-05 数值笔误）等原因被编排脚本拦下（见 `../v0.1-second-run/ACCEPTANCE-STATUS.md`）。

本目录同时记录**三类互相独立的证据**，任何一类都可以单独核验这次运行确实发生过、且结论一致：

| # | 证据类别 | 文件 | 说明 |
| --- | --- | --- | --- |
| ① | 工作流返回值 | `workflow-result.json` | 编排脚本 `workflows/three-agent-mvp.js` 返回的判定结果（含逐次尝试明细） |
| ② | DSH 原生执行事件 | `dsh-native-events.json` | 直接从 DSH 会话日志提取的 8 个子代理会话执行事实（步骤数、工具调用数、沙箱/审批策略），不含模型原始文本 |
| ③ | 编排者独立复核 | `orchestrator-verification-run6.py`、`orchestrator-verification-run6-output.txt`、`cross-check-output.txt`、`orchestrator-demo-test-output.txt`、`orchestrator-regression-output.txt` | 不依赖子代理口述的独立判据：按需求原文逐条验收、返回值 ↔ 磁盘证据交叉核对、交付测试与门禁逻辑回归 |

## 1. 运行配置

| 项 | 值 |
| --- | --- |
| 工作流脚本 | `workflows/three-agent-mvp.js`，77741 字节，sha256 `b18122563bb988d3b84d2e0aec47c1111cd935c8638bf725ee7fbb9bd33e95bc` |
| 门禁回归测试 | `tests/workflow-logic.test.mjs`，29418 字节，sha256 `776423c7146034d7e842b99b4c9e3fca3208088cca6e4aa1675b88323132e7c4` |
| 角色提示词 | `agents/`（requirement / coding / verifier / review 四个角色，按 `promptDir` 解析） |
| pipeline | `Verifier(preflight)` → `Requirement Agent` → `Coding Agent` → `Verifier(verify)` → `Review Agent` |
| targetDir | `examples/text-stats` |
| testCommand | `python -m unittest discover -s examples/text-stats -p "test_*.py"` |
| maxCodingAttempts | 2 |
| criteriaIds | `AC-01` … `AC-23` |
| 宿主 | DSH 44.0.0；模型 `deepseek-flash`（provider `deepseek-account`，contextWindow 1000000） |
| 子代理沙箱/审批 | 每个子代理 `sandbox.mode = workspace-write`（source `delegation`）、审批策略 `never`（source `delegation`），均由编排脚本显式指定 |

## 2. 时间线（两次尝试）

本地时间为 UTC+8；会话时间取自 `dsh-native-events.json` 的 `createdAt`，文件时间取自各证据文件 `generated_at`。

| 阶段 | 子代理会话 | 开始（本地） | 关键数字 | 结论 |
| --- | --- | --- | --- | --- |
| Verifier(预检) | `6050b308` | 23:45:36 | 8 步 / 12 次工具调用 | 证据目录不存在（`evidence_dir_state: missing`）、提示词文件齐全、路径无符号链接 → 允许继续 |
| Requirement Agent | `3da3bf8f` | 23:46:41 | 23 条验收标准 + 24 条边界条件 | 自检通过，`requirement_conflicts: []` |
| Coding Agent（第 1 次） | `31028159` | 23:48:22 | 54 步 / 58 次工具调用；创建 4 个文件 | 自报 `test_succeeded: true`、exit 0；`requirement_conflicts: []` |
| Verifier(verify)（第 1 次） | `6b0b99ff` | 23:52:37 | `Ran 81 tests` / `OK`，exit 0 | 独立复跑通过；上报 2 个产物（模块 + 测试）及 sha256 |
| Review Agent（第 1 次） | `267299a1` | 23:53:37 | 23 条标准全部 satisfied；2 个问题 | **CHANGES_REQUESTED**：测试文件内 2 处陈旧注释（历史 AC-05 数值 6、旧编号 `BC-01 .. BC-23`）与当前口径不符 |
| Coding Agent（修订 2） | `dc79b5f9` | 23:55:55 | 15 步 / 24 次工具调用 | 只改注释与文本，未改逻辑；`requirement_conflicts: []`、exit 0 |
| Verifier(verify)（修订 2） | `cc85c0f3` | 23:56:56 | `Ran 81 tests` / `OK`，exit 0（`generated_at` 23:58:27） | 产物 sha256 与磁盘一致 |
| Review Agent（修订 2） | `c0b942a9` | 23:58:39 | 23/23 satisfied、`issues: []` | **APPROVED** |

第 1 次的产物 `examples/text-stats/test_text_stats.py` 已被第 2 次修订覆盖；`text_stats.py` 两次一致。

## 3. 交付产物（`examples/text-stats/`）

| 文件 | 字节 | sha256 |
| --- | --- | --- |
| `text_stats.py` | 11184 | `56fdd9449b4c7b28b427515840e14480cfb352f7795796953ad9086190bc7990` |
| `test_text_stats.py` | 30828 | `39892a7d96ec0f3177c06ccc01bb06e62ab30c4df413277b7c9a18bceb8aa84e` |

上表是**第 2 次（最终）修订后**的指纹，与 `verify-revision-2.json` / `review-revision-2.json` 的 `artifacts_after` 一致。
第 1 次尝试的 `test_text_stats.py` 为 30875 字节、sha256 前 16 位 `591206d56117670f`（含 CRLF 行尾），已被第 2 次修订覆盖；
`text_stats.py` 两轮完全相同，未做任何修改。

测试命令 `python -m unittest discover -s examples/text-stats -p "test_*.py"` → `Ran 81 tests` / `OK` / exit 0（编排者在 run 后另行复跑，输出见 `orchestrator-demo-test-output.txt`）。

指纹口径：本次运行的产物集合**只包含模块与测试两个文件**（Verifier 与 Review 上报的 `artifacts` / `artifacts_after` 都是 2 项，交叉检查也已确认）。run 5 正是因为在这一点上三方口径不一致（5 项 vs 2 项）被门禁拦下，本次运行验证了修复有效。

## 4. 证据文件清单

| 文件 | 字节 | sha256 前 16 | 产生者 |
| --- | --- | --- | --- |
| `.run-owner.json` | 187 | `0b547e190dff696c` | 编排脚本（证据目录所有权标记） |
| `.sanitize-pass.py` | 4239 | `1b8319c631630b1b` | 编排者（归档前对本目录做脱敏，把本机绝对路径替换为占位符；同时把 UTF-16/带 BOM 的文本统一为无 BOM 的 UTF-8） |
| `preflight.json` | 3537 | `3295e5e268e34d27` | Verifier(预检) 子代理 |
| `requirement.json` | 24629 | `6b429ac87303b868` | Requirement Agent 子代理 |
| `coding-report.json` | 7418 | `9ba0407276d02282` | Coding Agent（第 1 次） |
| `verify.json` | 1358 | `0832d6b7ec39ca24` | Verifier(verify)（第 1 次） |
| `review.json` | 19427 | `bf71e0e74890122c` | Review Agent（第 1 次） |
| `coding-report-revision-2.json` | 5928 | `b43338700de65ea8` | Coding Agent（修订 2） |
| `verify-revision-2.json` | 2501 | `94fadce9500fdba0` | Verifier(verify)（修订 2） |
| `review-revision-2.json` | 17649 | `c14d9ba263f3ab0d` | Review Agent（修订 2） |
| `workflow-result.json` | 117638 | `7b90d8a00bb2eabd` | 编排脚本返回值（截断部分按磁盘证据补全，见 §7；读前请先看 §7 第 1、3 条） |
| `dsh-native-events.json` | 12928 | `4b47863a7b6ee318` | 编排者用 `../v0.1-second-run/extract-native-events.mjs` 从 DSH 会话日志提取 |
| `cross-check-output.txt` | 5415 | `fc7c0615979e66bb` | 编排者运行 `../v0.1-second-run/cross-check-workflow-result.py`（脱敏后复跑，结论不变：30 项 / 0 失败） |
| `orchestrator-demo-test-output.txt` | 12099 | `8cc63a1df8f7ff56` | 编排者运行交付测试（`-v`，stdout+stderr 合并；原 PowerShell 捕获版混入了 PowerShell 错误记录且为 UTF-16，已按 §8 命令以 UTF-8 重出） |
| `orchestrator-regression-output.txt` | 3921 | `dc6e87204294350c` | 编排者运行门禁回归测试（UTF-8；文本内容与替换前的 UTF-16 归档逐字相同，仅换行/编码归一） |
| `orchestrator-verification-run6.py` | 58215 | `679847eadd2a9bfe` | 独立复核子代理（会话 `eb2e9ca7`） |
| `orchestrator-verification-run6-output.txt` | 32662 | `bb907afca4f80aae` | 同上，其运行输出（UTF-8 无 BOM；脱敏替换 2 处绝对路径后字节数较生成时少 63） |

完整 sha256 与 git blob SHA-1 见 `../v0.1-second-run/REVIEW-MANIFEST.md`（该清单在归档时重新生成）。

## 5. 返回值 ↔ 磁盘证据一致性

`cross-check-workflow-result.py` 用 `workflow-result.json` 的逐次尝试明细核对磁盘上的证据文件、产物指纹、criteria ID 集合：**检查项 30，失败 0，跳过 0（结论：全部一致）**。

其中包含：两次尝试的产物路径集合与 sha256 在 verify/review 之间一致、最终 `verify.artifacts` 与 `review.artifacts_after` 的 sha256 与磁盘原始字节一致、`criteria_check` 的 ID 集合与顶层 `criteriaIds` 一致（`missing=[]`、`unknown=[]`）。第 1 次的 `test_text_stats.py` 被后续修订覆盖，属预期，列为说明项而非失败。

## 6. 独立复核（③ 类证据）

独立复核子代理**不引用交付实现与交付测试的断言**，期望值全部取自 `requirement.json` 的 `acceptance_criteria` / `boundary_conditions` 原文：

- 检查项 **280**，通过 **280**，失败 **0**，跳过 **1**，退出码 0。
- 唯一跳过项：BC-07 中「单独的 `\r`」——需求只说行边界字符先归一化，未说明归一化后如何单独观测 `\r` 是否属于空白集合，故不猜，输出中附判定理由与需求原文摘录（BC-07 其余 6 个空白字符均已实际检查）。
- 另附一条信息项（不作为期望来源）：交付测试 `Ran 81 tests` / `OK`。
- 静态交叉核对：AST 求值 `test_text_stats.py` 中 149 个 `assertEqual`，可静态求值 44 条，与需求原文一致 44 条、不一致 0 条；其余 32 条因左值为循环变量或右值非字面量而无法静态求值。
- 结论：**未发现交付实现与需求不符之处**。

## 7. 诚实说明与已知局限

1. **工作流返回值被 harness 截断。** `workflow-result.json` 是编排脚本的返回值，DSH 对工具返回长度有上限，`attemptsDetail[1].verification.notes` 中途被切断（`_harnessTruncation`：`truncated: true`、丢失 27611 字符、逐字前缀 49920 字符 sha256 前缀 `63120b94…`——该哈希对应**脱敏前**的原文，脱敏把绝对路径换成占位符后字节已变、无法从本文件复算，故同处另记了脱敏后同一前缀的哈希 `4b6c8131…`（`verbatimPrefixSha256Basis`）；同一工具调用的 spill 文件也在同一位置截断，故这段文本无法从任何产物恢复）。编排者按**磁盘上各阶段子代理自己写下的证据文件**补全了被截断的尾部（`attemptsDetail[1].verification` 尾段、`.review`、`.decision`、`.selfReportVsVerified`，以及顶层 `finalVerdict` / `finalReview` / `finalDecision`），并在 `_derivedTail` 中逐字段标注了来源与重建方式——**这些字段不是逐字返回值**，请以磁盘证据为准。
2. **原生事件不含模型原始文本。** `dsh-native-events.json` 只保留执行事实（会话 ID、父子关系、创建时间、步数、工具调用数、沙箱/审批策略、记录类型计数），按设计排除 user/assistant 消息正文，无法据此复现模型的逐字推理。
3. **本目录及 `v0.1-run3/4/5` 三个目录内的绝对路径已脱敏**（仓库根 → `<repo>`、用户主目录 → `<home>`），脱敏脚本 `.sanitize-pass.py` 一并留档，可对任一目录复跑且幂等；脱敏不改动任何 JSON 结构，所有 JSON 在替换后均重新解析通过。脱敏同时把 UTF-16 / 带 BOM 的 `.txt` / `.md` / `.json` 统一写成无 BOM 的 UTF-8（同目录的 `.md` 与 `.sanitize-pass.py` 自身除外）；`.diff` 默认不改写（改写会让它不再对应提交），唯一例外是 `../v0.1-second-run/commit-5034985.diff` 内的两处本机路径，理由与字节差见 `../v0.1-second-run/ACCEPTANCE-STATUS.md` 第 7 节。
4. **唯一一次人工判定的跳过项**（BC-07 单独 `\r`）已在 §6 说明，未被计为通过。
5. **本目录的 Review 报告是子代理输出**，不作为最终结论：判定逻辑由编排脚本持有，编排者的独立复核见 ③ 类证据。
6. **子代理留下过一个错位的证据副本（工作区脏文件）**：run 6 的 Coding Agent 除写入指定产物路径 `docs/evidence/v0.1-run6-20261016T154400Z/coding-report.json` 外，还在 `examples/docs/evidence/v0.1-run6-20261016T154400Z/coding-report.json`（8523 字节）写了一份同名报告——即把相对路径拼到了交付目录附近的错误位置。该副本**不属于交付物、也未纳入本次提交**：保留在工作区作现场记录，并在仓库根 `.gitignore` 中以 `examples/docs/` 规则排除，避免以后被 `git add -A` 误提交；交付目录 `examples/text-stats/` 内没有多余文件。据此已在脚本的提示词模板中加了一条约束（见 §9），要求子代理先把路径拼到仓库根、不要在别处创建同名文件。
7. **run 6 之后对脚本提示词做了一处加固**（见 §9），因此**当前工作树里的 `workflows/three-agent-mvp.js` 与本次运行所用的版本相差这一处提示词文本**：运行所用的版本是 77741 字节、sha256 `b18122563bb988d3b84d2e0aec47c1111cd935c8638bf725ee7fbb9bd33e95bc`（§1），加固后的版本哈希见 `../v0.1-second-run/REVIEW-MANIFEST.md` 的"当前工作树"一节。加固只改提示词文本，不改判定逻辑；门禁回归测试在加固后重新跑过（见 §10）。

## 8. 复现命令

```powershell
# 交付测试（归档输出 orchestrator-demo-test-output.txt 即此命令；-v 列出每个用例）
python -B -m unittest discover -s examples/text-stats -p "test_*.py" -v
# 注意：在 PowerShell 里不要用 `2>&1 | ...` 捕获——unittest 把结果写 stderr，PowerShell 会把
# 它包装成 ErrorRecord 混进输出（归档的第一版就是这样被污染的）。用 `cmd /c "... > 文件 2>&1"`，
# 或先设 PYTHONIOENCODING=utf-8，才能得到干净的 UTF-8 文本。

# 返回值 ↔ 磁盘证据交叉检查
python -B docs/evidence/v0.1-second-run/cross-check-workflow-result.py `
  --result docs/evidence/v0.1-run6-20261016T154400Z/workflow-result.json `
  --evidence-dir docs/evidence/v0.1-run6-20261016T154400Z

# 门禁逻辑回归（模拟子代理返回值，不调用模型）
node tests/workflow-logic.test.mjs
# 注意：不要用 `node --test` 包装——本测试脚本自带 runner，且 DSH 沙箱禁止被捕获的子进程管道（会报 EPERM: spawn）。

# 独立验收复核（按需求原文逐条判定，280 项）
python -B docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6.py

# 重新提取原生执行事件（需要 DSH 会话日志；父会话为运行该次工作流的子代理会话 ID）
node docs/evidence/v0.1-second-run/extract-native-events.mjs --parent <会话 ID> --since "2026-10-16T23:44:00+08:00"
```

## 9. run 6 之后新增的改动（不参与本次运行的判定）

| 改动 | 位置 | 原因 |
| --- | --- | --- |
| 提示词模板增加"产物路径相对仓库根"的约束 | `workflows/three-agent-mvp.js` 的 `envelopeNote()`（见 §7 第 6、7 条） | run 6 的 Coding Agent 把报告错位写到了 `examples/docs/…`；该模板被四个角色共用，故在注入点统一约束 |
| 证据整备工具加固 | `docs/evidence/v0.1-second-run/cross-check-workflow-result.py`（逐次尝试核对、`--archived` 归档模式、路径穿越防护、UTF-8 输出）、`make-review-manifest.py`（`--repo` 必填且 fail-closed、清理未使用变量、清单里不写本机绝对路径） | 交叉检查原本只看返回值顶层，无法覆盖多轮修订；归档运行（run 3–run 5）的产物已被后续修订覆盖，需要显式模式区分 |
| 测试夹具去掉写死的本机路径 | `tests/workflow-logic.test.mjs:37`（`REPO_ROOT` 改为 `path.resolve(HERE, '..')`） | 原来写死本机检出路径（仓库根的绝对形式）：公开仓库不该带作者机器路径，换个检出位置也会断言失败 |
| 文档同步 | `workflows/README.md`、`tests/README.md`、`README.md`、`docs/ROADMAP.md`、`docs/ARCHITECTURE.md`、`docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md` | 行为变化必须反映在文档里（AGENTS.md 第 8 节第 6 条），并如实记录 run 3–run 6 的结果 |

## 10. 加固后重新验证（本次提交前）

- 门禁回归测试（`tests/workflow-logic.test.mjs`）：50 场景 / 227 断言，0 失败（输出见 `orchestrator-regression-output.txt`，sha256 `dc6e87204294350c…`。该文件在本轮改过两处，故与运行当时那份 UTF-16 归档不是逐字节相同：一是编码由 UTF-16LE 归一为 UTF-8，二是测试夹具里的仓库根由写死的本机路径改为从测试文件位置推导——归一化换行后，两份输出的**文本内容逐字相同**，说明改动没有改变任何判定）。
- 交付测试：`Ran 81 tests` / `OK` / exit 0（输出见 `orchestrator-demo-test-output.txt`，按 §8 命令以 UTF-8 重出，替换了原先混入 PowerShell 错误记录的那份）。
- 返回值 ↔ 磁盘证据交叉检查：30 项 / 0 失败（输出见 `cross-check-output.txt`）。
- 独立验收复核：280 项 / 0 失败 / 1 跳过（输出见 `orchestrator-verification-run6-output.txt`）。
- **未重跑真实子代理流水线**：上述改动只影响提示词文本与整备工具，不影响编排层判定逻辑；真实运行的证据以本次 run 6 为准，不因事后改动而改写。
- 一处刻意保留的检查例外：`git diff --check` 会在 `orchestrator-verification-run6-output.txt` 里报出 3 行行尾空白（复核脚本打印需求原文时带入）。该文件是逐字归档的产物，改写会与 §4 记录的哈希不符，故保留并在 `../v0.1-second-run/ACCEPTANCE-STATUS.md` 第 7 节说明；`commit-5034985.diff` 也属同类例外。

## 相关

- 验收状态与 run 1–run 5 的失败原因：`../v0.1-second-run/ACCEPTANCE-STATUS.md`
- 工作流脚本与用法：`../../../workflows/README.md`
- 架构与证据分级：`../../ARCHITECTURE.md`
