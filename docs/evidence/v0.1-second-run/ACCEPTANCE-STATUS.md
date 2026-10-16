# 第二轮审查结论（追加）：**运行完成，验收未通过／需求冲突待解决**

本文件是对 `docs/evidence/v0.1-second-run/` 的**追加记录**，用于把"运行成功"与"验收通过"分开。它**不修改**该目录下任何原始 JSON、脚本或输出：其中 `ok: true`、`status: OK`、`finalVerdict: APPROVED`、`criteria_check` 17/17 `satisfied` 等字段保持原样。

## 1. 运行事实（保留的原始记录）

| 项 | 值 |
| --- | --- |
| runId / evidenceDir | `v0.1-second-run` / `docs/evidence/v0.1-second-run` |
| 运行时间（本地 +08:00） | 2026-10-16 19:48–20:03 |
| 分支 / 运行前 HEAD | `feat/v0.1-three-agent-mvp` / `d09195a` |
| 执行方式 | DSH 原生 `workflow` 工具执行 `workflows/three-agent-mvp.js` |
| 编排层结果 | `ok: true`、`status: OK`、`attempts: 1`、`finalVerdict: APPROVED` |
| 子代理执行 | **5 次**：Verifier(preflight) → Requirement Agent → Coding Agent → Verifier(verify) → Review Agent |
| 各阶段产物时间戳（`generated_at`） | preflight `2026-10-16T19:49:59.5150373+08:00`；requirement `19:51:07.6021408`；coding-report `20:00:01.2808253`；verify `20:01:08.401997`；review `20:03:00.567788` |
| 交付测试（Verifier 原样复跑） | `Ran 55 tests` → `OK`，`exit_code=0`，`ran_tests=55` |
| Review 独立复跑 | `python -m unittest discover -s examples/text-stats -p "test_*.py" -v`，`exit_code=0` |
| Review 的 `criteria_check` | 17 项，全部 `satisfied: true` |
| Review 的 `issues` | **3 条**（见第 2 节） |
| 编排层独立复核 | `orchestrator-verification.py`：266 项检查，0 失败，`ALL CHECKS PASSED` |
| 原生执行证据 | `dsh-native-events.json`：5 个真实子代理会话，148 步 / 180 次工具调用 |

这些记录**继续有效**，只是不再等同于"验收通过"。

## 2. 审查结论（本次追加）

**结论：运行完成，验收未通过／需求冲突待解决。**

依据：

1. **同一份 Review 结论内部就承认了需求缺陷**：`review.json` 一边给出 `APPROVED`（17/17 satisfied），一边在 `issues` 中写入 3 条问题，其中 ① 与 ③ 明确指出需求内部存在**无法同时满足**的规则：
   - ① `AC-12` 第二条命令要求 `main([], stdin_text='')` 的标准输出恰为 `True 0 int`，而 `BC-12` 要求成功路径标准输出恰好 4 行 —— 同一次调用不可能同时满足；
   - ③ `BC-03` 用 `line_count = len(T.splitlines())` 作唯一依据，而 `BC-02` 明确要求 `U+2028`/`U+2029` 等不构成行边界 —— 两套语义互斥（② 是 ① 在测试里的固化表现：`test_text_stats.py:373-379`）。
2. **当时的门禁拦不住这种情况**：第二轮的成功判定只校验"独立验证通过 + 全部验收 ID satisfied + APPROVED + Review 自测通过"，**没有**"任何阶段报告未解决需求冲突即不得通过"这条规则。该规则在本轮（复审意见四）才加入，并已有回归场景覆盖（`Requirement 自检为空 + Review 报告冲突却仍 APPROVED` 必须失败）。
3. 因此 `ok: true` / `APPROVED` 只说明"**当时的判定逻辑没有拦住**"，不能作为验收通过结论：需求侧冲突尚未消除、口径尚未由人确认（见 `docs/REQUIREMENT-CALIBER.md` 的待确认项 P-1～P-5）。**该缺口已于 2026-10-17 由仓库所有者逐项裁定补上（见第 10 节），但裁定不等于验收通过。**

原始产物原文不改写；本结论以**追加**方式记录，避免"运行成功"被误读为"验收通过"。

## 3. 与提交 5034985 的关系

| 项 | 值 |
| --- | --- |
| 完整 SHA | `5034985b1131f641f6c55e0451fa6a00dd8da15b` |
| 父提交 | `d09195a408e274f04a5dd2dc7acf08347415ba74` |
| 提交时间 / 标题 | 2026-10-16 20:10:32 +08:00 / `Harden three-agent workflow success judgment, validation and evidence protection` |
| 变更规模 | 24 files changed, 3541 insertions(+), 373 deletions(-) |
| 完整差异 | `docs/evidence/v0.1-second-run/commit-5034985.diff`（由 `git diff` 直接写出；其中两处本机检出路径已按第 7 节脱敏说明替换为 `<repo>`，其余逐字未改） |

**工作树与提交的关系**：第二轮运行发生在该提交**之前**的工作树上；运行结束后，当轮全部改动（工作流脚本、角色提示词、证据、演示代码与文档）**原样**提交为 `5034985`。可核对证据：

- 当时（本轮修复前）`git diff 5034985 -- docs/evidence/ examples/text-stats/` 输出为空——即第二轮归档证据与演示代码自提交后未被改写。**该结论此后已不再成立**：run 3 / run 4 / run 5 的试运行确实改写了 `examples/text-stats/` 下的交付文件（详见第 6 节），但 `docs/evidence/v0.1-second-run/` 这一归档目录本身始终未被改写（`git diff 5034985 -- docs/evidence/v0.1-second-run/` 仍为空）；
- 以 `git -c core.autocrlf=false` 检出 `5034985` 后计算哈希：`examples/text-stats/text_stats.py` = 9947 B / sha256 `00149d88e886465c9bde1c2a206a1baf1a8d0bdb4dc0647cb59f5a74b31207a7`，`examples/text-stats/test_text_stats.py` = 24249 B / sha256 `6fb84eb2b9a900670ce5fe74aa3602757ebf2b97ba7d8043c8f42df73753d609` —— 与 `verify.json` 的 `artifacts` **逐字节一致**，证明"证据里被验证的文件"就是"提交里的文件"。
- ⚠️ 哈希核对必须用 `core.autocrlf=false`（或直接对 git blob 计算）。默认检出会把 LF 转成 CRLF，文件会多出行数个字节（例如 `text_stats.py` 变成 10217 B、哈希变化），造成"文件被改动"的假象 —— 本轮核对时先出现过这个假象，已定位为换行转换，不是内容差异。

本轮（复审意见 m00981）改动的工作区文件：`workflows/three-agent-mvp.js`、`tests/workflow-logic.test.mjs`、`tests/README.md`、`workflows/README.md`、`README.md`、`docs/ROADMAP.md`、`docs/REQUIREMENT-CALIBER.md`、`agents/`（`requirement-agent.md`、`verifier-agent.md`、`review-agent.md`、`coding-agent.md`、`README.md`）以及本目录下的两个审查工具（`make-review-manifest.py`、`cross-check-workflow-result.py`）；`examples/text-stats/` 的改动来自 run 3/4/5 的 Coding Agent（不是人工改写），已归档证据目录一个字节都没有被改写。

## 4. 三类证据的范围、计数与跳过项

| 类别 | 载体 | 覆盖范围 | 本轮计数 |
| --- | --- | --- | --- |
| ① 模拟测试（**不调用真实子代理**） | `tests/workflow-logic.test.mjs`（Node 标准库；`node:vm` 加载生产脚本并注入模拟 `agent()`） | 编排层判定逻辑本身：成功/失败门禁、阶段冲突停跑、验收 ID 清单核对、文件指纹、参数与防覆盖校验、预检 fail-closed、独立复跑命令一致性、Verifier 时间窗 | 50 场景 / 227 断言，0 失败（提交 `5034985` 时该文件为 31 场景 / 144 断言；复审意见修复过程中曾达到 47/213、48/219，最终为 50/227） |
| ② 实际子 Agent 执行 | `docs/evidence/v0.1-second-run/` 的 5 个 JSON + `dsh-native-events.json` | 5 个真实子代理会话的身份、策略、模型、步数与工具调用边界 | 5 会话 / 148 步 / 180 次工具调用；模型 `deepseek-flash`、`sandbox/mode=workspace-write`、`approval/policy=never`（`source=delegation`） |
| ③ 独立功能检查 | `orchestrator-verification.py`（+ 其输出文件）与交付测试套件 | 以需求原文的期望值对交付实现做外部行为检查（**不使用**交付测试套件自己的断言作为依据） | 266 项检查，0 失败；交付测试 55 项 `OK` |

计数与跳过项解释：

- ③ 的 266 项中，**47 条可静态解析**的交付测试断言被逐条取出、对实现求值，结果全部一致；另 **1 条循环驱动**的断言无法静态解析，**标注跳过**（不参与通过/失败计数）；
- 交付目录下 12 个 `tmp*` 遗留目录受沙箱 ACL 限制无法读取/删除，记录为已知问题，**不参与**检查计数；
- ① 完全不产生真实模型调用，因此**只能**证明编排层逻辑正确，**不能**证明"子代理真的运行过"；② 才是真实执行的证据；③ 不依赖 ①② 的自述结论，只依据原始输出与文件指纹；
- `dsh-native-events.json` 由 `extract-native-events.mjs` 从本机 DSH 会话日志提取，只保留会话身份、策略、模型、turn/step 边界与工具调用元数据，**不含**任何消息正文、系统提示或工具结果载荷。

## 5. 材料位置与哈希

- 可审查材料清单、git blob SHA、sha256、字节数：`docs/evidence/v0.1-second-run/REVIEW-MANIFEST.md`
- 需求口径裁定提案与裁定记录（AC-12/BC-12、BC-02/BC-03 与 P-1 – P-6）：`docs/REQUIREMENT-CALIBER.md`
- V0.1 演示任务需求基线（已裁定六项口径，版本 `v0.1-demo-baseline-1`）：`docs/REQUIREMENT-BASELINE.md`

## 6. 第二轮复审之后的运行记录（run 3 – run 6）

按复审意见 ⑥，需求口径修复完成后以**全新 runId** 重跑。run 3 – run 5 都**没有被判成功**——这本身就是门禁生效的证据；
run 6 是**第一个真实通过**的完整运行（两轮：首轮 Review 判 `CHANGES_REQUESTED`，修订后第二轮 `APPROVED`）。
每一次的原始记录都保留在各自证据目录里，事后的任何修复都没有改写这些记录。

| 运行 | runId | 结果 | 停止原因 |
| --- | --- | --- | --- |
| 第三次 | `v0.1-run3-20261016T150153Z` | `ok: false` / `REQUIREMENT_CONFLICT` | 需求自检报出 4 条"冲突"，但逐条核对后都是**现有实现与本次需求不一致**，不属于需求内部矛盾（该情形应写入 `scope_in` / 验收条件）。据此改写了 `agents/requirement-agent.md` 的冲突定义与 `workflows/three-agent-mvp.js` 的需求提示词 |
| 第四次 | `v0.1-run4-20261016T150809Z` | `ok: false` / `STAGE_REPORTS_REQUIREMENT_CONFLICT`（状态码被次要原因掩盖为 `CODING_OUTPUT_INVALID`） | Verifier 与 Review **各自独立**发现 Requirement Agent 新造出的真实内部矛盾：BC-03(b)「以换行结尾的文本不产生额外空行」与 BC-04 示例「`"  \n\t\n"` 的 line_count 为 3」不可同时成立；而 Requirement 自检仍报 `conflicts: []`（漏检），由下游阶段捕获 |
| 第五次 | `v0.1-run5-20261016T152321Z` | `ok: false` / `STAGE_REPORTS_REQUIREMENT_CONFLICT` | Requirement Agent 又自造了一个数字示例：AC-05 要求 `char_count("cafe" + U+0301) == 6`，与它自己写下的"组合字符不作连接符、按代码点计数"规则（值为 5）矛盾。自检仍报 `conflicts: []`，Coding / Verifier / Review 三方一致报出；门禁按设计停止，未进入修订轮。运行墙钟约 11 分钟，五个子代理全部执行（77 个交付测试、`OK`） |
| 第六次 | `v0.1-run6-20261016T154400Z` | **`ok: true` / `OK` / `APPROVED`**（`attempts: 2`） | 无（成功）。首轮 Review 判 `CHANGES_REQUESTED`：交付测试与 README 里留下指向**上一次运行**的过期注释（`test_text_stats.py:204-209` 仍写 AC-05 的 `char_count` 为 6 / 冲突写入 `requirement_conflicts`）以及过期的边界条件编号（`BC-01 .. BC-23`，实际为 BC-24）。第 2 轮只改 `test_text_stats.py` 与 `README.md`，`text_stats.py` 两轮哈希相同（`56fdd944…` / 11184 B），复审 23/23 全部满足 |

第六次运行（**首个真实通过**）的证据与计数见第 7 节；需求口径为 `docs/REQUIREMENT-CALIBER.md`
（run 6 的需求已按加固后的规则把空白行示例写死为"2 行 / `non_empty_line_count` 0"）。

第四次运行的附带发现（都已成为代码/提示词的修复项）：

- Coding Agent 未返回可用的实现报告（`files_created` 缺失，且没有写出 `coding-report.json`），但它对交付目录的修改**已经落盘**。
  门禁因此报 `CODING_OUTPUT_INVALID`，把更重要的冲突状态掩盖了；已把"任一阶段报告冲突"的判定提前到其他失败原因之前
  （新增回归场景：Coding 报告不可用 + Verifier 报告冲突 ⇒ 必须报 `STAGE_REPORTS_REQUIREMENT_CONFLICT`），
  并在 `agents/coding-agent.md` 增加"返回值必须紧凑、先写产物文件再返回、`files_created` 不得省略"的硬要求。
- 针对第四次的矛盾来源，内置演示需求补上了权威示例："仅含空白字符的行仍然是行：`"  \n\t\n"` 是 2 行（两行都是空白行），
  其 `non_empty_line_count` 是 0；任何验收条件与边界条件的示例都必须与上述示例一致，不得把末尾换行之后的空片段另计为一行（该输入不得写成 3 行）。"

第五次运行的附带发现（同样已落成修复项）：

- **数字示例是 Requirements Agent 的主要出错点**：两次真实运行（run 4、run 5）都是它新造示例与自己的规则算不出同一个数。已改 `agents/requirement-agent.md`：
  每写一个数值示例都必须给出推导、并与同一份需求里的规则和已给示例逐条比对；优先沿用原始需求已给出的示例，不要另造。

- **文件指纹集合不一致**：Verifier 把 `README.md`、`.gitignore`、`sample_input.txt` 也列入 `artifacts`，Review 只列模块与测试文件，
  于是报 `ARTIFACT_FINGERPRINT_MISMATCH`。已明确两侧只覆盖 `task.moduleFile` 与 `task.testFile` 两类文件（脚本提示词 + `agents/verifier-agent.md` + `workflows/README.md`）。
- **Coding Agent 这次写出了 `coding-report.json`**（与第四次相反），但 `files_created`/返回值格式仍是易失点；提示词已加"先写产物文件、再返回紧凑结果"的硬要求。
- **工具侧限制（如实记录）**：DSH 的 `workflow` 工具返回值会被 harness 截断（本次少了 15446 字符，截断点之后的字段没有到达调用方）。
  因此 `docs/evidence/v0.1-run5-20261016T152321Z/workflow-result.json` 里对截断部分显式标注了 `_harnessTruncation` 与 `_derivedTail`
  （`finalVerdict` / `finalDecision` 标注为 **DERIVED, NOT VERBATIM**），不做成"逐字完整"的样子。子代理会话 id 也不在返回值里（workflow 的子代理不在调用会话的
  `list_agents` 树中），原生执行证据一律改用 DSH 会话日志按"父会话 + 时间窗"筛选，与第二轮方法一致。

## 7. 第六次运行（首个真实通过）的三类证据与计数

原始材料与逐文件哈希：`docs/evidence/v0.1-run6-20261016T154400Z/README.md`（该目录另有 `workflow-result.json` 与全部阶段证据）。

| 类别 | 载体 | 覆盖范围 | 本次计数 |
| --- | --- | --- | --- |
| ① 模拟测试（**不调用真实子代理**） | `tests/workflow-logic.test.mjs` + `tests/test_claim_evidence_dir.py` | 编排层判定逻辑本身：成功/失败门禁、阶段冲突停跑、验收 ID 清单核对、文件指纹、参数与防覆盖校验、预检 fail-closed、独立复跑命令一致性、Verifier 时间窗；以及排他认领工具的进程级行为（重复认领 / 8 进程并发 / 非空目录 / 路径越界） | 编排层 73 场景 / 332 断言，0 失败；认领工具 11 用例，0 失败 |
| ② 实际子 Agent 执行 | `docs/evidence/v0.1-run6-20261016T154400Z/dsh-native-events.json` + 9 个阶段证据 JSON | 8 个真实子代理会话（预检、需求、编码×2、验证×2、审核×2）的身份、策略、模型、步数与工具调用边界 | 8 会话 / 8 turns / 158 步 / 198 次工具调用；模型 `deepseek-flash`、`sandbox/mode=workspace-write`、`approval/policy=never`（`source=delegation`） |
| ③ 独立功能检查 | `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6.py`（+ 输出）、`cross-check-output.txt`、交付测试 | 以 `requirement.json` 原文的期望值为唯一依据，对交付实现做外部行为检查（**不使用**交付测试自己的断言作为依据）；再把 `workflow-result.json` 与磁盘证据逐项对照 | 独立验收 **280 项检查 / 0 失败 / 1 跳过**（退出码 0）；返回值 ↔ 磁盘交叉检查 **30 项 / 0 失败**；交付测试 `Ran 81 tests` / `OK` |

计数与跳过项解释：

- ③ 的 280 项全部按需求原文判定，期望值未取自交付实现或交付测试；唯一跳过项是 BC-07 中"单独的 `\r`"——
  BC-07 本身口径明确（"判定 non_empty_line_count 时使用 Python `str.strip()` 的空白集合"，括号里逐字列出 8 个字符），
  真正无法单独观测的是"`\r` 是否被 `str.strip()` 视为空白"**这一事实**：BC-02 要求在切分前把所有 CRLF 与单独 CR 归一化成 LF，
  任何一行内容里都不可能保留 `\r`，该条在可观测输入上永远不会被触发，故**标注跳过、不猜**
  （BC-07 列出的 8 个字符里，6 个各有显式 PASS，`\n` 由行切分隐含覆盖，`\r` 为跳过项）；
- run 6 复核脚本那条跳过说明里的"需求原文"引文有误（归一化顺序错挂 BC-04，且引文与 BC-07 语义相反），
  勘误与逐字原文见 `docs/evidence/v0.1-run6-20261016T154400Z/ERRATUM-BC-07-CITATION.md`；**跳过结论不受影响**；
- ③ 另做 AST 静态交叉核对：`test_text_stats.py` 的 149 个 `assertEqual` 中可静态求值 44 条，与需求原文一致 44 条、不一致 0 条，其余 32 条因左值为循环变量或右值非字面量无法静态求值；
- ① 完全不产生真实模型调用，只能证明编排层逻辑正确，不能证明"子代理真的运行过"；② 才是真实执行的证据；③ 不依赖 ①② 的自述结论；
- `dsh-native-events.json` 只保留会话身份、策略、模型、turn/step 边界与工具调用元数据，**不含**任何消息正文、系统提示或工具结果载荷；
- `workflow-result.json` 是工具返回值，本次被 harness 截断（丢失 27611 字符，逐字前缀 49920 字符）；被截断的尾部按**磁盘上各阶段子代理自己写下的证据文件**补全，并在 `_harnessTruncation` / `_derivedTail` 中逐字段标注来源与重建方式——**这些字段不是逐字返回值**。前缀哈希 `63120b94…` 是**脱敏前**原文的哈希，脱敏替换绝对路径后字节已变、无法从归档文件复算，故 `_harnessTruncation` 同时记录了脱敏后同一前缀的哈希 `4b6c8131…`（两条并存，口径写在 `verbatimPrefixSha256Basis`）；
- run 3 – run 6 四个证据目录内的本机绝对路径已脱敏（仓库根 → `<repo>`、用户主目录 → `<home>`），脱敏脚本 `.sanitize-pass.py` 留档于 run 6 目录，对任一目录复跑幂等；脱敏只改文本、不改 JSON 结构，所有 JSON 在替换后重新解析通过。为便于 diff，脱敏同时把 UTF-16 / 带 BOM 的 `.json` / `.txt` / `.md` 统一重写为无 BOM 的 UTF-8（run 6 的两份编排者输出按原命令以 UTF-8 重出，`orchestrator-regression-output.txt` 的文本在换行归一化后与替换前逐字相同）；
- 脱敏的唯一例外：`docs/evidence/v0.1-second-run/commit-5034985.diff` 按默认规则（`.diff` 不改写，以免与提交不再对应）本应跳过，但其中两行含本机检出路径，而本仓库是公开仓库，故做了一次性替换（2 处 → `<repo>`，287788 → 287730 字节）；该文件因此不再与 `git show 5034985` 逐字节相同，差异仅这两处。
- 提交前检查第 2 条（`git diff --check` 无空白错误）在本次归档里有**两处刻意保留的例外**，都是逐字归档的产物、改写会让证据与记录的哈希不符：`docs/evidence/v0.1-second-run/commit-5034985.diff`（它复刻 `git show 5034985` 的内容，其中大量以 `+ ` 开头的行本来就是该提交里的行尾空白），以及 `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6-output.txt`（3 行行尾空白，来自独立复核脚本转印需求原文）。除这两份产物外，本次提交的其余文件 `git diff --check` 干净。

## 8. 复审后的第二轮门禁加固（本轮，未重跑真实子代理）

背景：仓库所有者对 e3c27c1 的审查材料包做了独立复核（包哈希、55 项文件哈希、46 项 blob 回算、
50/227 门禁回归、81 项交付测试、280 项功能复核、30 项交叉检查全部复现），并指出 7 类**已经在
"真实工作流源码 + 模拟返回值"的完整编排路径上复现为 `ok:true`** 的异常。本轮只做确定性门禁修复与离线测试。

| # | 复审要求 | 本轮处理 | 新增/涉及的应当拒绝场景 |
| --- | --- | --- | --- |
| 1 | 指纹必须覆盖配置指定的源码与测试文件，拒绝无关清单、缺项、重复路径；不能只比较两份清单相同 | `judgeFingerprints()` 以配置的交付文件集合（`<targetDir>/<moduleFile>` + `<targetDir>/<testFile>`）为基准，逐项核对**缺项 / 无关文件 / 重复路径**（两侧一致也拒绝）；`collectFingerprints()` 把"重复路径"与"清单不可用"分开返回，使状态落到 `ARTIFACT_FINGERPRINT_MISMATCH` 而不是被挤成 `INCONSISTENT_EVIDENCE` | 多列 README、缺少测试文件、重复路径（各 1 场景） |
| 2 | 预检 `problems` 非空必须失败；证据目录与 owner marker 必须确定性排他创建，已有认领不得覆写；补真实重复认领与并发测试 | 新增 `PREFLIGHT_PROBLEMS`（`problems` 非空即终止）；新增 `tools/claim_evidence_dir.py`，用 `open(..., 'x')`（`O_EXCL`）排他创建 `.run-owner.json`，已有认领拒绝且**不覆写**（退出码 10）；预检必须回传 `claim_tool` / `claim_created` / `claim_exit_code`，`owner_marker_path` 必须属于本次运行，否则 `EVIDENCE_NOT_CLAIMED` | 预检 `problems` 非空；`claim_created=false`；`claim_tool` 非本工具；`claim_exit_code=10`；owner marker 属于别的运行；认领工具的**进程级** 11 项用例（含 8 进程并发只有一个成功、重复认领后 marker 逐字节不变） |
| 3 | Review 必须实际执行 >0 项测试；与 Verifier 对同一规范命令的用例数不一致时拒绝 | `judgeReviewConsistency(..., verifierRanTests)`：`Ran 0 tests` 拒绝；用例数与 Verifier 不一致拒绝（均为 `INCONSISTENT_REVIEW`） | Review 复跑 `Ran 0 tests`、用例数 43 vs Verifier 44 |
| 4 | Coding 的 `test_succeeded`、退出码、命令必须内部一致；`true + exit 1` 不得成功 | 新增 `judgeCodingReportConsistency()` 与状态 `CODING_REPORT_INCONSISTENT`（命令必须是本次规范命令；退出码必须是非负整数；`true` 与非 0 退出码、`false` 与 0 退出码、自述与输出摘录的 OK/FAILED 标记互相矛盾一律拒绝） | `true+exit 1`、`false+exit 0`、命令被换、退出码 `ok`、自述通过但摘录含 FAILED |
| 5 | 无效日期解析必须失败；时间窗绑定编排层实际时间；补无效日期、未来时间、伪造起点测试 | `parseIsoTimestamp()` 做真实的历法校验（`2026-02-30`、`25:00`、`+25:00` 一律非法）；`judgeTimestamp(..., orchestratorNowMs)` 增加"晚于编排层当前时间"判据；`validateRunConfig(args, orchestratorNowMs)` 增加"`runStartedAt` 与编排层实际时间相差超过 1 小时 ⇒ 运行标识疑似伪造或过期"（`RUN_START_MAX_SKEW_MS`） | 需求阶段 `2026-02-30`、Verifier 未来时间、`runStartedAt` 非法、`runId` 与 `runStartedAt` 一起伪造成一天前 |
| 6 | 路径判定拒绝未规范化的点段；核对解析路径与配置目标的对应关系 | 新增 `PATH_NOT_NORMALIZED`（`repo_root` / `repo_root_realpath` / `target_dir_realpath` / `evidence_dir_realpath` / `link_components` / `resolved_paths` 中出现 `.`、`..`、空段即拒绝）与 `PATH_TARGET_MISMATCH`（`target_dir`、`target_dir_realpath`、`evidence_dir_realpath` 必须与本次配置逐项对应） | 带 `/./` 的 realpath；`target_dir_realpath` 指向仓库内别的目录；`target_dir` 不符；`evidence_dir_realpath` 不符 |
| 7 | 修正 BC-07 跳过说明中的错误需求引文；材料包包含 `.test-scratch/.gitkeep` 或明确创建该目录的复现步骤 | 新增勘误 `docs/evidence/v0.1-run6-20261016T154400Z/ERRATUM-BC-07-CITATION.md`（逐字给出 BC-01/BC-02/BC-04/BC-07 原文与三处错误；两个已冻结文件保持逐字节不变，避免与已交付材料包的哈希冲突），本节第 7 节中文表述同步改写；`agents/verifier-agent.md` 新增"引用需求原文必须逐字并标注来源条目"的规则 | 本轮复现说明中补上 `.test-scratch/` 的创建步骤与跟踪状态（见下） |

本轮计数：编排层回归 **73 场景 / 332 断言 / 0 失败**（`node tests/workflow-logic.test.mjs`，退出码 0），
认领工具 **11 用例 / 0 失败**（`python -m unittest discover -s tests -p "test_*.py"`，退出码 0）。
两套测试都**不调用真实子代理**：回归测试用 `node:vm` 加载真实工作流源码、注入模拟的 `agent()`
返回值与固定时钟（`FIXED_NOW_MS = Date.parse('2026-10-16T04:00:00Z')`，与夹具 `runId` 的 UTC 时间戳同秒）。

遗留与口径：

- `.test-scratch/.gitkeep` **自 `d09195a` 起就已被跟踪**（blob `ba06749207b9f4748d295ee68b43174298b0157a`，
  存在于 `e3c27c1`），只是**未**被收录进 e3c27c1 审查材料包的 46 项材料清单；`examples/text-stats/README.md:124`
  因此仍然成立。本轮在复现说明中补上"若从导出的目录树运行交付测试，需要 `mkdir -p examples/text-stats/.test-scratch`"。
- `examples/text-stats/.test-scratch/` 下存在 12 个**不可读取、不可删除**的 `tmp*` 目录（Python `tempfile.mkdtemp`
  以 `0o700` 创建，Windows 上把 DACL 收窄到仅所有者；`icacls` 也无权处理）。它们被交付版
  `examples/text-stats/.gitignore` 的 `.test-scratch/tmp*/` 规则忽略（该规则就是为这类残留准备的），
  `git status` 保持干净，只在扫描该目录时打印若干 `warning: could not open directory`。这是 Python `mode` 行为、
  不是 DSH 沙箱 provisioning 缺陷，故未做 ACL 修复。
- P-1 – P-6（`docs/REQUIREMENT-CALIBER.md` 第 3 节）仍未裁定，本轮**不自行选边**（后于 2026-10-17 由人工逐项裁定，见第 10 节）；
- "人工审批的安全拒绝测试"（`docs/ROADMAP.md`）仍是 V0.1 的正式验收缺口，本轮未做。
- 本轮**没有**重跑真实子代理：run 6 是截至本轮**唯一一次被判成功**的完整真实运行，其证据冻结为 e3c27c1 快照（"唯一"只修饰"被判成功"——run 3 – run 5 同样是真实子代理运行并留下了真实产物，见第 6 节与第 10 节第 3 条）。
  **门禁通过 ≠ 最终验收通过**：本轮只能证明"上述 7 类异常不再能判为成功"，不能证明真实子代理在新门禁下跑通。

## 9. 复审后的第三轮收口（本轮，未重跑真实子代理）

背景：仓库所有者对 `b003651` 的审查材料包做了独立复核（75/75 场景、342 断言、11 项进程级认领测试、
81 项交付测试全部复现，旧脚本 + 新测试的 24 个场景失败也已复现），本轮只收口复审指定的 3 项。

| # | 复审要求 | 本轮处理 | 测试 |
| --- | --- | --- | --- |
| 1 | 启动时钟与阶段检查时钟分开；每次 Agent 返回后重新读取当前时间；补"时钟推进 120 秒"与"跨多个阶段的成功"测试，保留真正未来时间戳的拒绝测试 | `const startupNowMs = currentTimeMs();` 只用于 `validateRunConfig()` 的"运行起点"锚定；此后每个 Agent 返回后重新读时钟：`preflightNowMs` / `claimNowMs` / `requirementNowMs` / `codingNowMs` / `verifyNowMs` / `reviewNowMs`，逐个传给 `judgeTimestamp()`。文件头说明两个时钟的用途与原因（长运行的判定基准会过期） | 时钟推进 120 秒、每个阶段都用"当时的"时间戳、跨 Requirement→Coding→Verifier→Review 四个阶段仍 `OK`（旧代码会因判定基准过期误判为未来时间）；时钟推进 7 小时越出窗口 ⇒ `INVALID_TIMESTAMP`；阶段时间戳比判定当刻晚 120 秒 ⇒ `INVALID_TIMESTAMP`。全部用可控时钟，无真实等待 |
| 2 | 预检明确消费认领工具的 `evidence_dir_state_before`，区分认领前后状态；补真实工具结果接入预检门禁的集成测试（首次认领通过、重复认领拒绝且已有证据字节不变、认领失败不写 `preflight.json`） | `PREFLIGHT_SCHEMA` 必填 `evidence_dir_state_before`（枚举 `missing` / `empty` / `exists`）；门禁要求它只接受 `missing` / `empty`，且必须与预检自报的 `evidence_dir_state` 一致（⇒ 否则 `EVIDENCE_NOT_CLAIMED`）；注释明确"认领成功后目录里的 `.run-owner.json` 是正常的认领后状态，不作为 `EVIDENCE_EXISTS` 判据"；`preflightPrompt` 要求认领失败（工具退出码非 0）时**不写任何文件**（尤其不写自己的产物文件，否则污染别的运行的证据），直接返回结构化结果让编排层以 `EVIDENCE_NOT_CLAIMED` 终止 | 新增 `tests/preflight-claim-integration.test.mjs`：**真实调用** `tools/claim_evidence_dir.py` 并把其 JSON 原样接入预检返回值（5 场景 / 48 断言）——首次认领 ⇒ 全流程 `OK` 且证据目录只有认领文件；重复认领（退出码 10）⇒ 拒绝、既有 `.run-owner.json` 逐字节不变、目录里没有 `preflight.json`；目录非空且无认领文件（退出码 11）⇒ 拒绝且原内容与哈希不变、不创建认领文件、不写任何文件；已存在但为空 ⇒ 可认领并放行；自报状态与工具回报不一致 ⇒ `EVIDENCE_NOT_CLAIMED`。逻辑回归另加 2 场景（`state_before=exists` ⇒ 拒绝；自报与工具不一致 ⇒ 拒绝） |
| 3 | 修正文档中"旧脚本对新增异常全部返回 `ok:true`"的概括，区分误放行与"拒绝状态码不符合新契约" | 该过度概括出现在**未跟踪**的 `docs/review/b003651/README.md:3` 与 `:129`；为不改变已交付材料包的字节（其哈希已记录），本轮不在该目录内改写，而是在**新审查包**与本节给出精确分类 | 旧脚本（`e3c27c1`）+ 新测试：新场景中 **24 个返回 `ok:true`（真正的误放行）**，另有 **3 个虽被拒绝但状态码/原因不符合新契约**——`Coding test_succeeded=false` + 退出码 `0` ⇒ 旧 `INCONSISTENT_EVIDENCE`（新契约 `CODING_REPORT_INCONSISTENT`）；`2026-02-30` 这类非法日历时间 ⇒ 靠 6 小时窗口"偶然"拒绝（原因不是"日历时间非法"）；`runId` 与 `runStartedAt` 一起伪造成旧时间 ⇒ 旧 `INVALID_TIMESTAMP` 且已经启动过预检子代理（新契约在启动前即 `INVALID_ARGS`）。集成套件在旧脚本下 4/5 通过：认领前状态不一致那场景被拒绝，但走的是旧的"未完成认领"原因，说明 `evidence_dir_state_before` 当时确实未被消费 |

本轮计数（全部离线，未调用真实子代理）：

- 编排层逻辑回归 **81 场景 / 372 断言 / 0 失败**（`node tests/workflow-logic.test.mjs`，退出码 0）；
  夹具与可控时钟抽到 `tests/workflow-harness.mjs`，由两个测试文件共享；
- 预检认领集成测试 **5 场景 / 48 断言 / 0 失败**（`node tests/preflight-claim-integration.test.mjs`，退出码 0）；
- 认领工具进程级测试 **11 用例 / 0 失败**（`python -m unittest discover -s tests -p "test_*.py"`，退出码 0）；
- 交付项目测试 **81 用例 / 0 失败**（`python -m unittest discover -s examples/text-stats -p "test_*.py"`，退出码 0；交付代码本轮未改动）。

遗留与口径（沿用第 8 节，本条未变）：

- P-1 – P-6（`docs/REQUIREMENT-CALIBER.md` 第 3 节）仍未裁定，本轮不自行选边；
- "人工审批的安全拒绝测试"仍是 V0.1 正式验收缺口，本轮未做；
- `.test-scratch/.gitkeep` 的跟踪状态与 12 个不可读 `tmp*` 残留目录的说明见第 8 节；
- 本轮**没有**重跑真实子代理：run 6 仍是截至本轮唯一一次被判成功的完整真实运行，其证据仍未变（"唯一有真实子代理证据的运行"这一说法是错的，正确表述见第 10 节第 3 条）。
  **门禁通过 ≠ 最终验收通过**：本轮只证明"时钟判定与认领前状态这两处不再能被绕过"。

## 10. 需求口径裁定与 V0.1 演示任务需求基线（本轮，未重跑真实子代理）

背景：2026-10-17，仓库所有者对 `docs/REQUIREMENT-CALIBER.md` 第 3 节的 P-1 – P-6 **逐项裁定**，并要求：把决定固化为可版本化的需求基线；更正文档里三处问题（P-3 的错误选项、P-5 的历史描述、"run 6 是唯一有真实子代理证据的运行"这一错误说法）；澄清 `main` 自身输出与外层 `print` 输出的区别。本轮**没有修改任何历史证据 JSON 或输出文件**，也**没有**重跑真实子代理。

### 10.1 裁定结果（六项，全部确认）

| 项 | 裁定 | 基线条目 |
| --- | --- | --- |
| P-1 | 显式传入 `stdin_text`（包括空串）时，`main` 静默返回整数退出码 | RB-1 |
| P-2 | 命令行读取空 stdin 到 EOF 时，输出四行零值统计并返回 0 | RB-2 |
| P-3 | `cafe` + U+0301 为 **1 个词、5 个字符**；不做 NFC/NFD 归一化（断言为 2 是历史缺陷，禁止） | RB-3 |
| P-4 | 行边界仅 LF、CR、CRLF；其余所列分隔字符不构成行边界 | RB-4 |
| P-5 | AC 与 BC 没有隐式优先级；发现同一调用、同一输入的互斥要求时，报告冲突并停止，等待人工裁定 | RB-5 |
| P-6 | 空白行计入总行数，末尾换行不额外增加一行；`'  \n\t\n'` 为 2 行、0 非空行 | RB-6 |

落点：**`docs/REQUIREMENT-BASELINE.md`（基线版本 `v0.1-demo-baseline-1`）**，其中每条给出可观察示例、来源条文、实现位置与测试位置。

### 10.2 基线只覆盖这六项

采用 run 6 需求的相应条文，**不等于**认定 run 6 需求整体获批。run 6 需求中未被六项引用的条文（AC-11/AC-12/AC-14–AC-19/AC-22、BC-02/BC-03/BC-04/BC-06/BC-07/BC-08/BC-09/BC-10/BC-11/BC-13/BC-14/BC-18/BC-19/BC-20/BC-21/BC-22/BC-23/BC-24）仍是**未逐条裁定**的条文，清单见基线第 5.1 节。本文件第 6、7 节引用的 run 6 计数，仍然只是"那一轮运行留下的记录"。

### 10.3 更正："run 6 是唯一有真实子代理证据的运行"是错的

`docs/evidence/` 下**多轮都有真实子代理产物**，逐目录清点如下（本轮实测）：

| 证据目录 | 文件数 | 其中真实 Agent 产物 |
| --- | --- | --- |
| `docs/evidence/v0.1-first-run/` | 9 | 5 次子代理执行的全部产物 |
| `docs/evidence/v0.1-second-run/` | 15 | 5 个阶段 JSON + `dsh-native-events.json`（5 会话 / 148 步 / 180 次工具调用） |
| `docs/evidence/v0.1-run3-20261016T150153Z/` | 3 | `preflight.json`、`requirement.json`（需求自检报冲突后停止，未进入编码） |
| `docs/evidence/v0.1-run4-20261016T150809Z/` | 5 | 含 `review.json`、`verify.json`（同时含真实预检与需求产物） |
| `docs/evidence/v0.1-run5-20261016T152321Z/` | 8 | 含 `coding-report.json`、`review.json`、`verify.json`、`workflow-result.json` |
| `docs/evidence/v0.1-run6-20261016T154400Z/` | 19 | 8 会话 / 158 步 / 198 次工具调用，两轮修订的全部产物 |

正确表述：**run 6 是当前门禁下第一次（也是截至本轮最后一次）被判成功的完整真实运行**，而**不是**"唯一有真实子代理证据的运行"。第 8、9 节里"唯一一次成功的真实重跑"已按此含义改写。

### 10.4 澄清：`main` 自身的输出 vs 外层 `print` 的输出

run 6 需求 AC-10（`docs/evidence/v0.1-run6-20261016T154400Z/requirement.json:42`）写"`main([], stdin_text='')` 的标准输出为空，而不是 `True 0 int`"——那句话把**外层命令** `python -c "...; print(callable(t.main), code, type(code).__name__)"` 的 stdout 说成了 `main` 的 stdout。事实是：`True` / `0` / `int` 三个值由**外层 `print`** 写出，`main` 自身不写任何流、只返回 `0`。本机实测（2026-10-17）：外层命令 stdout = `True 0 int`、退出码 0；同一次调用中 `main` 无输出。完整澄清见 `docs/REQUIREMENT-BASELINE.md` 第 4 节。**历史需求文件字节不变**，澄清以追加说明表达。

### 10.5 与当前实现 / 测试的核对（本轮实测，未调用真实子代理）

**结论：六项已裁定口径与当前实现、当前交付测试完全一致，未发现需要修改的实现或测试差异。**

| 项 | 实测探针 | 结果 |
| --- | --- | --- |
| P-1 | `main([], stdin_text='')`；外层命令 `python -c "...print(callable(t.main), code, type(code).__name__)"` | 返回 `0` 且无任何输出；外层 stdout = `True 0 int` |
| P-2 | `python examples/text-stats/text_stats.py < 空文件` | `0/0/0/0` 四行、退出码 0、不阻塞 |
| P-3 | `count_text('cafe\u0301')` | `char_count 5`、`word_count 1` |
| P-4 | `count_text('a\u2028b')` | `line_count 1`、`char_count 3` |
| P-5 | `node tests/workflow-logic.test.mjs` | 81/81 场景、372 断言、0 失败、退出码 0 |
| P-6 | `count_text('  \n\t\n')` | `line_count 2`、`non_empty_line_count 0` |

交付测试：`python -m unittest discover -s examples/text-stats -p "test_*.py"` → `Ran 81 tests` / `OK`（退出码 0）。

### 10.6 登记（本轮**不**改）的既有不一致

- 本文件第 9 节记预检认领集成测试"5 场景 / 48 断言"——那是**那一轮的当时状态**；该轮之后的子进程启动方式修正轮已把它增至 **6 场景 / 59 断言**（见 `tests/README.md`）；
- `docs/ROADMAP.md` 写 `examples/text-stats/.test-scratch/` 下有 11 个遗留 `tmp*` 目录，本文件第 8 节写 12 个。

两处均属既有文档计数不一致，本轮只登记、不扩大修改范围。

### 10.7 本轮改动文件

`docs/REQUIREMENT-BASELINE.md`（新增）、`docs/REQUIREMENT-CALIBER.md`、`docs/ROADMAP.md`、`README.md`、本文件。`docs/evidence/` 下**只有本文件**被更新：所有历史 JSON、脚本与输出文件（含 run 3 – run 6 目录）**零改动**。

### 10.8 遗留（未变）

- "人工审批的安全拒绝测试"（V0.1 验收条件 3）仍未完成；
- 当前门禁下**没有**重跑真实子代理：run 6 之后 `workflows/three-agent-mvp.js` 已被修改（两个时钟、认领前状态门禁等），"门禁通过"不能外推为"新代码下真实跑通"；
- 因此 **V0.1 最终验收仍未通过**；本次只是把需求口径由"待裁定"变为"已裁定并有可版本化基线"。
