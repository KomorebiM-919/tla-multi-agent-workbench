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
3. 因此 `ok: true` / `APPROVED` 只说明"**当时的判定逻辑没有拦住**"，不能作为验收通过结论：需求侧冲突尚未消除、口径尚未由人确认（见 `docs/REQUIREMENT-CALIBER.md` 的待确认项 P-1～P-5）。

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
- 需求口径裁定提案（AC-12/BC-12、BC-02/BC-03 与待确认项）：`docs/REQUIREMENT-CALIBER.md`

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
| ① 模拟测试（**不调用真实子代理**） | `tests/workflow-logic.test.mjs` | 编排层判定逻辑本身：成功/失败门禁、阶段冲突停跑、验收 ID 清单核对、文件指纹、参数与防覆盖校验、预检 fail-closed、独立复跑命令一致性、Verifier 时间窗 | 50 场景 / 227 断言，0 失败 |
| ② 实际子 Agent 执行 | `docs/evidence/v0.1-run6-20261016T154400Z/dsh-native-events.json` + 9 个阶段证据 JSON | 8 个真实子代理会话（预检、需求、编码×2、验证×2、审核×2）的身份、策略、模型、步数与工具调用边界 | 8 会话 / 8 turns / 158 步 / 198 次工具调用；模型 `deepseek-flash`、`sandbox/mode=workspace-write`、`approval/policy=never`（`source=delegation`） |
| ③ 独立功能检查 | `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6.py`（+ 输出）、`cross-check-output.txt`、交付测试 | 以 `requirement.json` 原文的期望值为唯一依据，对交付实现做外部行为检查（**不使用**交付测试自己的断言作为依据）；再把 `workflow-result.json` 与磁盘证据逐项对照 | 独立验收 **280 项检查 / 0 失败 / 1 跳过**（退出码 0）；返回值 ↔ 磁盘交叉检查 **30 项 / 0 失败**；交付测试 `Ran 81 tests` / `OK` |

计数与跳过项解释：

- ③ 的 280 项全部按需求原文判定，期望值未取自交付实现或交付测试；唯一跳过项是 BC-07 中"单独的 `\r`"——需求只规定行边界字符先归一化，未规定归一化后如何单独观测 `\r` 是否属于空白集合，故**标注跳过、不猜**（BC-07 其余 6 个空白字符均已实际检查）；
- ③ 另做 AST 静态交叉核对：`test_text_stats.py` 的 149 个 `assertEqual` 中可静态求值 44 条，与需求原文一致 44 条、不一致 0 条，其余 32 条因左值为循环变量或右值非字面量无法静态求值；
- ① 完全不产生真实模型调用，只能证明编排层逻辑正确，不能证明"子代理真的运行过"；② 才是真实执行的证据；③ 不依赖 ①② 的自述结论；
- `dsh-native-events.json` 只保留会话身份、策略、模型、turn/step 边界与工具调用元数据，**不含**任何消息正文、系统提示或工具结果载荷；
- `workflow-result.json` 是工具返回值，本次被 harness 截断（丢失 27611 字符，逐字前缀 49920 字符）；被截断的尾部按**磁盘上各阶段子代理自己写下的证据文件**补全，并在 `_harnessTruncation` / `_derivedTail` 中逐字段标注来源与重建方式——**这些字段不是逐字返回值**。前缀哈希 `63120b94…` 是**脱敏前**原文的哈希，脱敏替换绝对路径后字节已变、无法从归档文件复算，故 `_harnessTruncation` 同时记录了脱敏后同一前缀的哈希 `4b6c8131…`（两条并存，口径写在 `verbatimPrefixSha256Basis`）；
- run 3 – run 6 四个证据目录内的本机绝对路径已脱敏（仓库根 → `<repo>`、用户主目录 → `<home>`），脱敏脚本 `.sanitize-pass.py` 留档于 run 6 目录，对任一目录复跑幂等；脱敏只改文本、不改 JSON 结构，所有 JSON 在替换后重新解析通过。为便于 diff，脱敏同时把 UTF-16 / 带 BOM 的 `.json` / `.txt` / `.md` 统一重写为无 BOM 的 UTF-8（run 6 的两份编排者输出按原命令以 UTF-8 重出，`orchestrator-regression-output.txt` 的文本在换行归一化后与替换前逐字相同）；
- 脱敏的唯一例外：`docs/evidence/v0.1-second-run/commit-5034985.diff` 按默认规则（`.diff` 不改写，以免与提交不再对应）本应跳过，但其中两行含本机检出路径，而本仓库是公开仓库，故做了一次性替换（2 处 → `<repo>`，287788 → 287730 字节）；该文件因此不再与 `git show 5034985` 逐字节相同，差异仅这两处。
- 提交前检查第 2 条（`git diff --check` 无空白错误）在本次归档里有**两处刻意保留的例外**，都是逐字归档的产物、改写会让证据与记录的哈希不符：`docs/evidence/v0.1-second-run/commit-5034985.diff`（它复刻 `git show 5034985` 的内容，其中大量以 `+ ` 开头的行本来就是该提交里的行尾空白），以及 `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6-output.txt`（3 行行尾空白，来自独立复核脚本转印需求原文）。除这两份产物外，本次提交的其余文件 `git diff --check` 干净。
