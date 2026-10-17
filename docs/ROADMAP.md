# TLA Roadmap

TLA（Tailored Logic Atelier）多智能体工作台的阶段路线图。每个阶段都包含**功能目标**与**验收条件**；验收条件全部满足才允许进入下一阶段。本文件随实际进度持续更新，未开始阶段的内容属于规划，可能调整。

## V0.1 — 基础骨架与首个多智能体工作流（当前阶段）

**目标**：在 DeepSeek Harness（DSH）原生能力之上建立项目骨架，并跑通第一条多 Agent 协作开发流水线（**首个 MVP = Requirement / Coding / Review 三个独立 Agent**；五角色完整流水线属本阶段扩展目标）。

### 已完成

- 阶段一：项目本地初始化（克隆仓库、确认 `main` 与远程地址）。
- 阶段二：基础项目骨架与技术文档：
  - 功能分支 `feat/v0.1-foundation`
  - `README.md`（项目定位、功能规划、进度、目录说明）
  - `AGENTS.md`（工程规范、安全与人工审批要求）
  - `.gitignore`（密钥/凭据/缓存/虚拟环境等忽略规则）
  - `docs/ARCHITECTURE.md`（DSH 原生能力 vs LangGraph 路线对比与推荐）
  - `docs/ROADMAP.md`（本文件）
- 阶段三：**首个三 Agent MVP 跑通**（分支 `feat/v0.1-three-agent-mvp`，2026-10-16）：
  - `agents/`：Requirement / Coding / Review 三个角色的独立职责说明与提示词；
  - `workflows/three-agent-mvp.js`：DSH Workflow 脚本，逐步调用真实 Subagent，由编排逻辑保证执行顺序与结果传递；
  - 演示项目 `examples/text-stats/`：仅标准库的文本统计工具（纯函数 + CLI），44 个单元测试全绿；
  - 证据归档 `docs/evidence/v0.1-first-run/`：5 次子代理执行，首轮 `CHANGES_REQUESTED` → 编码 Agent 修订 → 复审 `APPROVED`，含编排层 45 项独立复核记录；
  - 本轮已满足验收条件 2（真实可核验的运行记录）与条件 4（敏感信息检查、`.gitignore` 实测）。
- 阶段四：**按首次代码审核意见加固工作流，并完成第二次真实运行**（分支 `feat/v0.1-three-agent-mvp`，2026-10-16）：
  - 成功判定加固：`ok: true` 要求「编码自述通过 ∧ Verifier 独立复跑通过 ∧ Review `APPROVED` 且自测通过 ∧ 验收条件全覆盖且逐条满足 ∧ 需求自检无冲突」，并把自述结果与独立验证结果分别记录、比对（矛盾 ⇒ `INCONSISTENT_EVIDENCE`）；
  - 新增真实子代理角色 `agents/verifier-agent.md`（`preflight` / `verify` 两种模式），编排由三角色变为五步子代理；
  - 参数校验与证据保护：`runId`/`evidenceDir`（须在 `docs/evidence/` 下且末段等于 `runId`）/相对路径/文件名/测试命令白名单/`maxCodingAttempts`（1–5 整数）/时间戳（拒绝占位值）；校验失败不启动任何子代理；已存在的证据目录一律拒绝覆盖；
  - Requirement Agent 增加验收条件与边界条件的一致性自检，冲突即停止；
  - 编排逻辑回归测试 `tests/workflow-logic.test.mjs`（`node:vm` 装载真实脚本 + 模拟子代理返回值，31 个场景全过）；
  - 第二次真实运行归档 `docs/evidence/v0.1-second-run/`：5 次子代理执行、交付测试 55 个全绿、编排层 266 项独立复核 0 失败，并含由 DSH 原生会话日志提取的**脱敏执行事件**（会话标识、时间、turn/step、工具调用次数）以证明角色独立执行。
- 阶段五：**按第二轮复审意见加固成功门禁与证据保护，并复跑真实运行**（分支 `feat/v0.1-three-agent-mvp`，2026-10-16）：
  - 门禁：**任一阶段报告未解决需求冲突 ⇒ `STAGE_REPORTS_REQUIREMENT_CONFLICT`**，不再进入修订轮，且该状态优先于其他失败原因；验收条件改为按 **ID 集合逐项核对**（需求侧缺/重复 ID ⇒ `REQUIREMENT_IDS_INVALID`，Review 侧 ⇒ `CRITERIA_CHECK_INCOMPLETE` / `_DUPLICATE_IDS` / `_UNKNOWN_IDS`）；
  - 路径与防覆盖：交付目录与证据目录必须回报 `realpath` 且都位于仓库内（`TARGET_DIR_OUTSIDE_REPO`）、拒绝链接逃逸（`LINK_ESCAPE`）、`runId` 必须以 `-<UTC 时间戳>` 结尾并与 `runStartedAt` 同秒、证据目录先写 `.run-owner.json` 认领（未认领 ⇒ `EVIDENCE_NOT_CLAIMED`）；
  - 证据一致性：Verifier 的 `artifacts` 与 Review 复核后重算的 `artifacts_after` 的文件集合与 `sha256` 必须一致（⇒ `ARTIFACT_FINGERPRINT_MISMATCH`）；失败时返回值新增 `error` / `errors`，便于人工直接阅读原因；
  - 提示词：Requirement 的冲突定义改为"只有**本次需求内部**、同类调用、同一输入的互斥期望才算冲突"（"现有实现与需求不一致"必须写进 `scope_in` / 验收条件）；Coding 增加"返回值紧凑、先写产物文件、`files_created` 不得省略"；Verifier 修正"写证据"与"禁止写文件"的冲突（唯一允许的写操作是它自己的产物文件与 `.run-owner.json`）；
  - 回归测试扩到 **50 个场景 / 227 项断言**（新增冲突优先级、ID 逐项核对、文件指纹、realpath/链接/认领、`runId` 时间戳、独立复跑命令一致性、Verifier 时间窗等场景）；
  - 新增需求口径提案 `docs/REQUIREMENT-CALIBER.md`（AC-12/BC-12、BC-02/BC-03 的分层口径与 P-1…P-6 待确认项）与第二轮裁定文档 `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md`（"运行完成、验收未通过／需求冲突待解决"）；
  - **需求口径裁定落地（2026-10-17）**：P-1 – P-6 已由仓库所有者逐项确认，固化为可版本化需求基线 `docs/REQUIREMENT-BASELINE.md`（`v0.1-demo-baseline-1`，条目 RB-1 – RB-6），并与当前实现和交付测试逐项核对一致；裁定**只覆盖这六项**，run 6 需求的其余条文与"以哪一轮需求文本为准"仍属未逐条裁定（见基线第 5 节），**V0.1 最终验收未通过**；
  - **审批拒绝取证工具加固（2026-10-17，离线，真实拒绝测试已单独执行）**：新增 `tools/approval-rejection-evidence.mjs`（快照 + 判定 + `snapshot`/`verify` 子命令）与离线回归 `tests/approval-rejection-evidence.test.mjs`（131 断言 / 27 组场景）、反向验证 `tests/approval-evidence-mutation.test.mjs`（18 组 v1→v3 + 11 组 v2→v3）；判定规则改为"缺证据 ⇒ `INCOMPLETE`（退出码 3）"，校验审批事件关联与顺序、逐文件内容指纹、快照身份/时间对应、**快照 marker 与本次审批绑定、目标约束按路径重算、内容跳过判不完整、采集区间围住审批事件（v4）**，审批命令与被观察目标逐字绑定且**排他创建**，日志按 RFC 8878 帧结构切分（不按魔数扫），机器判定/人工确认/最终结论三段分离；方案见 `docs/APPROVAL-REJECTION-TEST-PLAN.md`（v4，已执行一次）；
  - **无人值守离线加固（2026-10-17，工作包 B–F，离线，未触发审批、未跑真实子代理、未联网）**：修复 2 个确定性缺陷——① `OK (skipped=44)`（全体跳过）此前会被当作测试通过，现按 `skipped >= ran` 判未执行（新增 4 个回归场景，逻辑回归 85 场景 / 391 断言）；② 仓库缺 `.gitattributes`，`core.autocrlf=true` 的机器上 `git archive`/检出会把 `examples/text-stats/sample_input.txt` 变成 CRLF，导致干净副本里 `test_ac22` 必然失败，现只固定该文件 `text eol=lf`。另新增 `tests/property_text_stats.py`（固定种子、1217 组、独立参考实现、三个变异体反向验证均被抓）与审查记录 `docs/OFFLINE-REVIEW-2026-10-17.md`；只报告未改动 5 条（`ran_tests` 类型未强制、指纹 `./` 前缀不归一、子代理异常无兜底、测试 `spawnSync` 无 `timeout`、会话日志整读入内存）；
  - 第三次、第四次与第五次真实运行**都被门禁拦下**（`REQUIREMENT_CONFLICT`；`STAGE_REPORTS_REQUIREMENT_CONFLICT`），原始记录见 `ACCEPTANCE-STATUS.md` §6——门禁按设计生效，未把失败冒充成功；三次的根因都是 Requirement Agent 自造的数字示例与自己的规则算不出同一个数，据此要求"每个数值示例必须给出推导并优先沿用原始需求的示例"；
  - **第六次真实运行 `v0.1-run6-20261016T154400Z` 首次通过**（`ok: true` / `status: OK`）：两轮尝试（首轮 Review 判 `CHANGES_REQUESTED`，原因是交付测试与 README 里残留上一次运行的过期注释与过期边界条件编号；修订后复审 `APPROVED`，23/23 满足），8 次子代理执行、交付测试 81 个全绿、回归测试 50 场景 / 227 断言 0 失败、返回值 ↔ 磁盘证据交叉检查 30 项 0 失败；证据与诚实记录见 `docs/evidence/v0.1-run6-20261016T154400Z/README.md`。
  - **新版真实流水线 `v0.2-run1-20261017T121445Z` 首次运行（2026-10-17）**：需求文本 `v0.2-demo-input-3`（R-01 – R-37）经所有者 Q1 批准，记录见 `docs/run-records/v0.2-run1-20261017T121445Z/`；编排层返回 `ok: true` / `finalVerdict: APPROVED`，5 次原生子代理调用（预检 / Requirement / Coding / Verifier / Review）、0 轮编码返工、交付测试 76 例全绿、27 条 AC + 27 条 BC 全覆盖。**V0.1 最终验收仍未通过**：远端未观测，且 **AC-24（不新增 `__pycache__/`）在本轮未被满足** —— Review 却判 `satisfied: true`，人工复审认定该判定不成立（`.pyc` 的 mtime 落在 Verifier 阶段）
  - **v0.2-run1 复审收口（2026-10-17，离线，未跑真实模型）**：① AC-24 追加人工复审记录 `docs/evidence/v0.2-run1-20261017T121445Z/human-review-ac24.md`（原件 `review.json` 不改，纠正结论以该记录与 `ACCEPTANCE-STATUS.md` §16.2 为准）；② 编排层最小改动让 Coding/Verifier/Review 的测试进程真的拿到 `PYTHONDONTWRITEBYTECODE=1`（固定前缀 + 同一命令上下文），并新增 `bytecode_scope` 硬门禁（`BYTECODE_CACHE_WRITTEN` / `BYTECODE_ENV_NOT_APPLIED` / `BYTECODE_SCOPE_UNMEASURED`），真实子进程集成测试 6 场景 / 45 断言；③ 原生事件证据 `docs/run-records/v0.2-run1-20261017T121445Z/native-events.json`（宿主日志白名单提取：5 次调用、父会话、深度 1、无再派生、脚本指纹、产物归因，10/10 检查）；④ 复核工具转正式（`tests/review-run-evidence.py` 70 项 + 10 夹具自检、`tests/run-review-suite.py` 一次跑完 13 条命令、`tests/probe-text-stats-requirement.py` 180 项、`tests/mutation-text-stats.py` 3 变异体、`tests/extract-native-events.mjs`）；⑤ 37 条需求 → AC/BC 映射 `requirement-mapping.json`（54 个验收项、80 处引用、AC-24 标 `not-proven`）；⑥ 纠正 `[C19]` 的提交范围偏差（`docs/review/` 不应入库），用显式清单的纠正提交从跟踪树移除、磁盘文件保留，正式材料改放 `docs/run-records/<runId>/review-package/`。**V0.1 最终验收仍未通过**，新门禁尚未经真实运行验证。
- **第二次运行前的两项准备（2026-10-17，离线）**：① **全运行缓存账本**——`task.cacheBaseline` 成为必填参数（启动前实测的 `<targetDir>/__pycache__` 清单，不允许默认空数组），Coding / Verifier / Review 各自交回前后清单，Review 之后新增只读阶段 `Cache Collector` 交回最终清单，相邻观测点之间出现新增 / 重写 / 删除即 `BYTECODE_CACHE_CHANGED_ACROSS_RUN`（"两个验证阶段各自前后不变"只是必要条件）；离线新增 3 个拒绝场景（阶段间隙变化、Coding 阶段写入、缺基线），逻辑测试 98 场景 / 454 断言、真实子进程 6 场景 / 45 断言；② **复核输出防覆盖**——`tests/run-review-suite.py` 的 `--out-dir` 成为必填项并**真正传给每个会写文件的子工具**（review/probe/mutation 的 `--json-out`、native 的 `--out`），已存在的非空目录直接 exit 2 拒绝覆盖，超时记为失败（exit 124）且仍写 `suite-results.json` 收尾，子进程强制 `PYTHONDONTWRITEBYTECODE=1` 并记录；新增 `tests/test_run_review_suite.py` 10 个用例。**这两项准备已由下一行 `v0.2-run2` 的真实运行检验：账本确实抓到了唯一一次真实写入，`--out-dir` 防覆盖也按预期工作。**

- **第二次真实运行 `v0.2-run2-20261017T133204Z`（2026-10-17）**：编排层返回 **`ok: false` / `MAX_ATTEMPTS_BYTECODE_CACHE_CHANGED_ACROSS_RUN`**。实质结果两轮都合格——Coding 自述 81 例全绿、Verifier 独立复跑 `Ran 81 tests … OK`、Review `APPROVED` 且 25 条 AC 全 `satisfied`、需求自检零冲突、预检零问题——失败只来自**运行期写入边界**。独立复核把 5 条报错拆成两类：① **1 条真实写入**：Review 阶段用**不带** `$env:PYTHONDONTWRITEBYTECODE` 前缀的临时 Python 调用 import 了被测模块，把 `examples/text-stats/__pycache__/text_stats.cpython-313.pyc` 从 14916 B 改成 14885 B（mtime 13:47:31Z，落在 Verifier 结束与 Review 结束之间）；② **4 条 mtime 表示精度误报**：同一文件被不同子代理报成整数毫秒 `1792244851273` 与浮点毫秒 `1792244851273.0972`，`bytes`/`sha256` 完全相同却被 `!==` 判成重写。修复：判定改为**内容身份**（`bytes` + `sha256`）加 `mtime_ms` 容差 5 毫秒，提示词新增"该阶段内**任何** Python 调用都必须带同一前缀（不只是测试命令）"；逻辑测试 **100 场景 / 464 断言**。同一轮复核还修了复核工具自己的两处过时口径：命令比对现在允许剥离**逐字符已知**的 `$env:PYTHONDONTWRITEBYTECODE = '1'; ` 前缀（换了值仍拒绝，14/14 夹具），变异检查的"被抓住"判据从固定用例名改为行为关键词（3/3 变异体被抓住，`tests/test_mutation_gate.py` 用 run2 的真实用例名做回归）。归档与同类记录见 `docs/run-records/v0.2-run2-20261017T133204Z/`（`approval.md`、`native-events.json`、`requirement-mapping.json`、`review-package/`，13 条复核命令全部退出码 0）。**第三次真实运行尚未执行**，需所有者决定。

### 待完成

- **人工审批的安全拒绝测试**（V0.1 正式验收要求，对应验收条件 3）：完成一次被拒绝的受保护操作，证明拒绝后无实际副作用（工作区未变、无远端写入、未安装依赖、权限未变），并归档测试记录。**现状（2026-10-17）**：已执行并通过一次父会话 `pwsh` 沙箱升级审批的人工拒绝路径测试——`approval/decided.outcome=rejected`、`tool/result.isError=true`、目标文件未创建、仓库内容与状态前后一致、用户逐字确认拒绝（现场 `docs/evidence/v0.1-approval-rejection-20261017T112518Z/`，机器判定 `PASS` + 人工确认，`verify` 退出码 0；首次判定因缺人工观察为 `INCOMPLETE`/退出码 3，两次记录均保留）。范围**仅限这一次**：其它工具与"允许一次"路径未验证、远端未观测，因此**不**扩展为"所有工具安全能力通过"。V0.1 最终验收仍未通过（新版真实模型流水线尚未运行）。**2026-10-17 追记**：新版真实流水线已首次运行（`v0.2-run1-20261017T121445Z`，见上"最近状态"与 `ACCEPTANCE-STATUS.md` §16）；V0.1 最终验收仍未通过，但原因已从"流水线尚未运行"改为"远端未观测 + AC-24 的 `__pycache__` 条款未严格执行"。
- **人工审批的强制拦截覆盖面**：首个 MVP 已把审批的三层区分写入 `docs/ARCHITECTURE.md` §2.1，但「一句提示词即强制拦截」的假设不成立；强制拦截只能来自沙箱 + 审批策略 + 操作自身的审批点，需逐条验证（见 `docs/ARCHITECTURE.md` §7 未验证项 #11）。
- **需求一致性自检机制改进**（多次复现，仍未根治）：Requirement Agent 的 `consistency_check` 会漏检真实矛盾——第二次漏掉 AC-12 与 BC-12（"stdout 恰好 `True 0 int`" 与 "成功路径恰好 4 行" 不可同时满足），由 Review Agent 独立发现；第四次漏掉自己写出的 BC-03(b) 与 BC-04 空白行示例（`"  \n\t\n"` 是 2 行与 3 行互斥），第五次漏掉 AC-05 的 `char_count` 示例（示例值 6 与它自己的归一化规则算出的 5 互斥），都由 Verifier 与 Review 各自独立捕获。门禁现已能兜住该类冲突（硬失败 `STAGE_REPORTS_REQUIREMENT_CONFLICT`），但**自检本身仍是"声明式"的**：第六次运行虽然通过（自检报 `conflicts: 0`，下游两阶段与编排层独立复核也都未发现矛盾），并不能证明自检真的会做数值交叉验算。已加入的缓解措施是提示词层面的硬要求（每个数值示例必须给出推导、优先沿用原始需求的示例、示例必须与全部规则逐条比对），仍需在后续运行中持续观察（详见 `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md` §6 与 `docs/REQUIREMENT-CALIBER.md`）。
- **需求基线之外的口径仍未裁定**（2026-10-17 新增）：`docs/REQUIREMENT-BASELINE.md` 的 RB-1 – RB-6 只覆盖 P-1 – P-6 六项；run 6 需求中未被引用的条文（清单见该文件 §5.1）以及"V0.1 验收以哪一轮需求文本为准"这个元问题仍需人工裁定，裁定前不得据此宣称验收通过。**2026-10-17 追记**：元问题已用显式批准解决——所有者批准 `v0.2-demo-input-3` 的 R-01 – R-37 作为 `v0.2-run1` 的需求原文（记录见 `docs/run-records/v0.2-run1-20261017T121445Z/approval.md`）；run 6 需求与 RB-1 – RB-6 的关系仍以 `docs/REQUIREMENT-BASELINE.md` 为准。
- **多模型分工与运行预算的实现未开始（2026-10-17，只登记需求与研究）**：研究稿见 `docs/MULTI-MODEL-BUDGET-STUDY.md`，把候选需求分三类——可直接实现 9 条（用量与模型归因、可复算、白名单比对、观测型预算判定）、依赖官方接口 3 条（预算强制中止、第三方 provider 接入、目录数据）、尚未核实 5 条（货币价格口径、跨 provider 字段一致性、`meta.phases` 的 provider/model 语义、`model/selection` 事件语义、父子会话用量边界）。本轮不含实现、不新增依赖、不产生付费调用。附带的一次只读取证顺带确认：`v0.2-run2` 的 10 个子代理会话共 184 条助手消息、`input 415 664 / output 240 267 / cacheRead 8 117 760 / total 8 773 691` token，且 `totalTokens = input + cacheRead + cacheWrite + output`，父会话累计不能当作运行级用量。
- **清理交付目录中的残留临时目录**（需仓库所有者执行）：`examples/text-stats/.test-scratch/` 下有 11 个第一次运行遗留的 `tmp*` 目录，其 ACL 拒绝读取与删除，AI 沙箱内无法清理；不影响测试通过（被 `.gitignore` 忽略），但建议在本机非受限终端删除。
- **后续 V0.1 扩展目标（不取消，但不是首次运行成功的前提）**：增加方案讨论（discussion）与测试（testing）两个角色，构成五角色完整流水线：需求 → 讨论 → 编码 → 审核 → 测试。

### V0.1 验收条件

1. 仓库结构符合 `README.md` 目录说明；所有文档与代码状态一致。
2. 首个 MVP（Requirement / Coding / Review 三个独立 Agent）有一次**真实可核验**的运行记录：三个 Agent 的实际执行记录、任务输入输出、代码产物、测试结果与审核结论齐备；**不接受仅模拟角色文字的演示**。
3. 人工审批的三层区分（`ask_user_question` 用户交互 / DSH 底层审批缝 / `AGENTS.md` 工程规范的人工确认要求）已文档化；并完成一次**安全的拒绝审批测试**：受保护操作被拒绝后**未发生实际副作用**（工作区文件未变、无远端写入、未安装依赖、权限未变），测试记录归档。
4. `git log` 无敏感信息提交；`.gitignore` 规则经 `git check-ignore` 验证有效。
5. `main` 全程无直接提交；功能分支提交历史清晰。

> 五角色完整流水线（需求 → 讨论 → 编码 → 审核 → 测试）是 V0.1 的**扩展目标**，不作为首个 MVP 的验收前提。

## V0.2 — 多模型分工与状态持久化

**目标**：验证多模型协作与长任务的状态管理能力，按需评估 LangGraph 互补路线。

### 功能规划

- 多模型适配：利用 DSH **agent 级** `agentOptions` 覆盖 + `llm-pi-ai` 多 provider 适配器，让不同角色使用不同模型（如讨论用 A 模型、编码用 B 模型）。分工必须基于**已验证的 agent 级模型覆盖机制**；官方已证实 `phase()` 只用于进度展示、Workflow **无 phase 级** provider/model 覆盖，因此**不假定**可按 phase 切换模型。
- 用量与预算：候选需求与技术可行性见 `docs/MULTI-MODEL-BUDGET-STUDY.md`（R-M01 – R-M13）。研究结论：**观测型**"每个阶段用了什么模型、花了多少 token"可由宿主原生日志复算（已在 `v0.2-run2` 的 10 个子会话上验证，184 条消息全部带 `usage`），今天就能做；**强制型**"超限即中止"没有已核实的接口，不得声称支持；第三方 provider 接入属人工审批范围。
- 长任务状态管理：优先评估 DSH 会话持久化与续跑（JSONL+Zstd、`resume`/`fork`）与 Goal 机制（跨轮次持久目标）；当且仅当需要图节点级检查点/时间回溯/图内 HITL 时才考虑引入 LangGraph Checkpointer。
- 若采用 LangGraph（路线 B）：通过官方 Python SDK（`deepseek-harness-sdk`，stdio JSON-RPC：`session/prompt`→`session/wait`→`session/resume`）或 `dsh headless --json --session-id` 桥接 DSH 的 Agent 执行能力；启用条件见 `docs/ARCHITECTURE.md` 第 5 节。
- **ChatGPT Plus / Codex 兼容性验证（独立验收项）**：调查并**实际验证**经官方 `openai-codex` OAuth 路由或 `subagent-codex` 后端，用**已有的 ChatGPT Plus 订阅**在 DSH 内完成 Codex 任务委派。必须区分 **ChatGPT 订阅权限**与**独立 OpenAI API 计费**（本机文档已证 `openai` 路由不接受 ChatGPT 登录、只接受 API Key）；不承诺特定模型一定可用，不承诺无限额度；未经用户批准不得安装 Codex、不得授权账户、不得使用付费 API；不得读取、复制、提交 OAuth Token 或其他认证秘密。

### 验收条件

1. 同一工作流中至少两个不同模型协作，角色与模型映射可配置且可复现。
2. 一个耗时超过单轮的任务可以跨轮次恢复并完成，状态不丢失（Goal 或 Checkpoint 二选一，以实测为准）。
3. 若引入 LangGraph：必须先用真实环境验证 DSH Python SDK 子进程 / `dsh headless --session-id` 等接口稳定可用（含工作区指定、会话续跑、冷启动开销量化），并完成最小可行桥接 demo；未验证前不得进入主流程。
4. **仅当路线 B 确实启动实验时**才要求性能对比留档：DSH 原生编排 vs LangGraph 编排的启动/调度开销有实测数据；未启动路线 B 实验时，本项不作为验收条件。
5. **ChatGPT Plus / Codex 兼容性验证**（独立验收项）：完成上述调查与实测取证并记录结论；结论须明确区分「ChatGPT 订阅权限」与「独立 API 计费」，且不包含任何认证秘密（OAuth Token 等）。若无法验证或不可用，如实记录否定结论即视为该项通过。

## V0.3 — 质量自动化与流程深化

**目标**：强化代码审核与测试能力，让多 Agent 流水线产出可量化质量改进。

### 功能规划

- 代码审核 Agent 深化：diff 分析、安全规范检查、与 `AGENTS.md` 规范对照。
- 测试 Agent 深化：自动生成测试、执行测试、失败归因与修复建议闭环。
- 讨论流程结构化：方案讨论产出可追踪的决策记录（ADR 风格）。
- 人工审批体验优化：审批项摘要、批量确认。

### 验收条件

1. 审核 Agent 对已知问题样例（注入安全缺陷、规范违反）的检出率达到约定阈值（≥80%，样例集在本阶段建立）。
2. 测试 Agent 对典型 bug 能生成可失败的复现测试并协助修复。
3. 每个讨论环节产出决策记录，可回溯「为什么这样做」。
4. 所有新增流程均有对应文档与测试。

## V0.4 — 扩展性与产品化（远景）

**目标**：把 TLA 变成可扩展的工作台，而不是一次性脚本集合。

### 功能规划

- 角色/工作流模板库：新项目可复用「需求-讨论-编码-审核-测试」流水线模板。
- 知识沉淀：利用宿主平台记忆能力（Hindsight）沉淀项目决策与经验。
- 更多模型接入：按角色分配模型——DSH 内置 provider 目录已含 `openai`、`anthropic`、`zai`(GLM)、`moonshotai`(Kimi)、`openai-codex`、`minimax` 等（见 `docs/ARCHITECTURE.md` §2.1）；目录外端点走 "Custom model API" 手写 OpenAI 兼容路由（三协议：`openai-completions`/`openai-responses`/`anthropic-messages`）；评估外部 Agent 后端（`subagent-codex`、`subagent-claude-code`）的接入条件与代价。
- 可视化与报告：流程执行摘要、审批记录、质量指标面板（如 DSH Web GUI 客户端插件）。

### 验收条件（初稿，实施前细化）

1. 新项目可在有限配置下复用流水线模板并成功运行。
2. 跨会话知识可检索、可追溯来源。
3. 一次完整流水线可在无人值守下运行至人工审批节点并正确等待。
