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
- **第二次运行前的两项准备（2026-10-17，离线）**：① **全运行缓存账本**——`task.cacheBaseline` 成为必填参数（启动前实测的 `<targetDir>/__pycache__` 清单，不允许默认空数组），Coding / Verifier / Review 各自交回前后清单，Review 之后新增只读阶段 `Cache Collector` 交回最终清单（**该阶段已在 run2 收口中删除**，见下行"调用超限复盘"），相邻观测点之间出现新增 / 重写 / 删除即 `BYTECODE_CACHE_CHANGED_ACROSS_RUN`（"两个验证阶段各自前后不变"只是必要条件）；离线新增 3 个拒绝场景（阶段间隙变化、Coding 阶段写入、缺基线），逻辑测试 98 场景 / 454 断言、真实子进程 6 场景 / 45 断言；② **复核输出防覆盖**——`tests/run-review-suite.py` 的 `--out-dir` 成为必填项并**真正传给每个会写文件的子工具**（review/probe/mutation 的 `--json-out`、native 的 `--out`），已存在的非空目录直接 exit 2 拒绝覆盖，超时记为失败（exit 124）且仍写 `suite-results.json` 收尾，子进程强制 `PYTHONDONTWRITEBYTECODE=1` 并记录；新增 `tests/test_run_review_suite.py` 10 个用例。**这两项准备已由下一行 `v0.2-run2` 的真实运行检验：账本确实抓到了唯一一次真实写入，`--out-dir` 防覆盖也按预期工作。**

- **第二次真实运行 `v0.2-run2-20261017T133204Z`（2026-10-17）**：编排层返回 **`ok: false` / `MAX_ATTEMPTS_BYTECODE_CACHE_CHANGED_ACROSS_RUN`**。实质结果两轮都合格——Coding 自述 81 例全绿、Verifier 独立复跑 `Ran 81 tests … OK`、Review `APPROVED` 且 25 条 AC 全 `satisfied`、需求自检零冲突、预检零问题——失败只来自**运行期写入边界**。独立复核把 5 条报错拆成两类：① **1 条真实写入**：Review 阶段用**不带** `$env:PYTHONDONTWRITEBYTECODE` 前缀的临时 Python 调用 import 了被测模块，把 `examples/text-stats/__pycache__/text_stats.cpython-313.pyc` 从 14916 B 改成 14885 B（mtime 13:47:31Z，落在 Verifier 结束与 Review 结束之间）；② **4 条 mtime 表示精度误报**：同一文件被不同子代理报成整数毫秒 `1792244851273` 与浮点毫秒 `1792244851273.0972`，`bytes`/`sha256` 完全相同却被 `!==` 判成重写。修复：判定改为**内容身份**（`bytes` + `sha256`）加 `mtime_ms` 容差 5 毫秒，提示词新增"该阶段内**任何** Python 调用都必须带同一前缀（不只是测试命令）"；逻辑测试 **100 场景 / 464 断言**。同一轮复核还修了复核工具自己的两处过时口径：命令比对现在允许剥离**逐字符已知**的 `$env:PYTHONDONTWRITEBYTECODE = '1'; ` 前缀（换了值仍拒绝，14/14 夹具），变异检查的"被抓住"判据从固定用例名改为行为关键词（3/3 变异体被抓住，`tests/test_mutation_gate.py` 用 run2 的真实用例名做回归）。归档与同类记录见 `docs/run-records/v0.2-run2-20261017T133204Z/`（`approval.md`、`native-events.json`、`requirement-mapping.json`、`review-package/`，13 条复核命令全部退出码 0）。**第三次真实运行尚未执行**，需所有者决定。

- **run2 调用超限复盘与修复（2026-10-17，离线，未跑真实模型）**：run2 的原生记录是 **10 次子代理调用，超过已批准的 8 次**——多出的两次是 `seq6` / `seq10` 的 `Cache Collector`（560 169 + 286 096 = 846 265 tokens，占本次 8 773 691 的 9.6%），根因是 run1 之后新增该阶段时**没有把批准的 8 次重新对账**（真实最坏是 `2 + 4 × 2 = 10`，不是 `2 + 3 × 2 = 8`）。复盘记录 `docs/run-records/v0.2-run2-20261017T133204Z/budget-overrun.md`：保留原始证据、**不追认预算**、不以"运行没通过"为由免责。修复：① 删除 `Cache Collector` 阶段，缓存快照改由确定性本地工具 `tests/collect-cache-state.py` 事后采集（0 次模型调用）；② 新增 `task.maxAgentCalls`（默认 8、范围 1–32，非法值 `INVALID_ARGS`）作为**统一调用账本**，五处调用点全部走 `runBudgetedAgent`，**启动前**检查，到上限返回 `AGENT_CALL_BUDGET_EXCEEDED` 并在 `agentCallBudget.calls` 留下 `started: false` 的那一项（证明"第 N+1 次没有启动"，不是事后加总）；③ 离线用量提取器 `tests/extract-usage-report.mjs`（只读会话日志、不联网、不调用模型、不读凭据）把 run1/run2 复算到各自 `usage/` 子目录：run1 **5 次 / 3 918 430 tokens / WITHIN_BUDGET**，run2 **10 次 / 8 773 691 tokens / OVER_BUDGET**；④ 测试：逻辑回归 **110 场景 / 529 断言**（新增预算边界、第 N+1 次不启动、mtime 容差 5→6 毫秒边界、`cacheCoverage` 证明边界）、`usage-report.test.mjs` 12 场景 / 67 断言、`test_collect_cache_state.py` 9 用例、`bytecode-integration` 6/6 45 断言、`preflight-claim-integration` 6/6 59 断言。**第三次运行方案**：按当前流水线（预检 1 + 需求 1 + 每轮 3）重算，`maxCodingAttempts = 2` 的最坏情况是 **8 次**（正好等于默认上限），期望路径 5 次；token 无运行前上限、只能事后用提取器统计。该方案**等待所有者单独授权**，本轮不触发任何真实模型调用。

- **第三次真实运行 `v0.3-run3-20261017T151029Z` 在 Review 启动前中止（2026-10-17）**：用户按 `m11171` 授权（`maxAgentCalls=8`、`maxCodingAttempts=2`、声明 `maxTotalTokens=8 000 000` 仅作事后观测、需求沿用 `v0.2-demo-input-3` 不改条款、不自动重开第四次）。运行走了 4 次调用（预检 / 需求 / 编码 / 验证）后被**宿主**拒绝第 5 次调用：`WorkflowError: agent() schema is outside the supported subset — unsupported JSON schema: schema.properties.issues.items.properties requires type or oneOf …`。根因**不是仓库缺陷**，而是我把脚本手工内联进 `workflow` 调用时漏了 `REVIEW_SCHEMA.properties.issues.items` 的 `type: 'object'`（与运行前提交 `[C30]` 的逐行 diff 只有 2 处：这一行致命、一处注释末句被截短）。记录见 `docs/run-records/v0.3-run3-20261017T151029Z/run-aborted.md`（`stopReason: error`、`agentCallCount: 4`、无 `review.json`、交付改动只以 `delivery.diff` 形式保留并已从工作区还原、**不得称为通过**）。缓存边界独立判定为 **`CLEAN`**（基线 + Coding/Verifier 前后观测点 + 运行后快照共 6 点，0 违规、0 问题，`tests/verify-cache-boundary.py`，0 次模型调用）；用量只读复算 4 会话 / 83 条消息 / 3 916 632 tokens / `WITHIN_BUDGET`（事后观测）。**据此新增内联脚本指纹自检**：`driftHash` + `selfCheckValue` + `checkSelfCheck`，五处调用点在启动前比对提示词与 schema，漂移即 `SCRIPT_DRIFT`（`args.selfCheckRequired: true` 时缺指纹也 fail-closed）；`node tests/script-fingerprint.mjs` 生成 `args.selfCheck`，`--check` 4 项自检（含"篡改 schema 指纹时只发出 4 次调用"）。逻辑回归 **110 场景 / 529 断言**全绿。**第四次真实运行需所有者单独授权**，不自动重开。

- **run3 事故后的执行前校验（2026-10-17，离线，0 次模型调用）**：先核实"宿主能否从文件把脚本原文传给 `workflow` 的 `script` 参数"——asar 内的 `dsh-tool-workflow` 实现里 `parameters` 只有 `script`(string)/`meta`(object)/`args`，**没有文件路径参数**；真正的 schema 子集校验在 `dsh-workflow-ptc` 的 `assertObjectJsonSchema`，位于 `agent()` 调用链内部，**宿主没有零调用的校验接口**。因此结论是"没有可靠的机器传递路径"，不再靠手工转录去尝试真实运行（这条限制已写进 `workflows/README.md` 与 `docs/ARCHITECTURE.md` §6）。新增两道离线防线：① `tests/preflight-workflow-script.mjs`——把"准备提交的载荷"与 `git show <SHA>:workflows/three-agent-mvp.js` 的源码字节**逐字节**比较（唯一允许的规范化是把末尾换行压成单个 `\n`，同时保留原始与规范化哈希；判定代码改动、漏行、注释改动、CRLF 一律不通过），并用 `runSource` 在本地跑一次两轮模拟、对**全部 5 个 schema** 跑宿主子集规则的本地实现；退出码 `0/10/11/12/13/4/5`，报告里 `hostCapabilities` 如实写 `machineScriptTransfer: unsupported-by-tool-schema`、`zeroCallSchemaValidation: unavailable`、`agentCalls: { real: 0, simulated: 8 }`。② `args.selfCheck` 范围收窄——只带 `node tests/script-fingerprint.mjs --schemas-only` 的**静态 schema 指纹**（夹具生成的提示词指纹不能用于真实运行），未固定期望值的字段进 `scriptSelfCheck.unchecked`，部分比对不得说成全部比对。测试：`tests/preflight-script.test.mjs` **9 场景 / 42 断言**（含 run3 那个缺 `type` 的变异体必须在 0 次调用时被抓住）、`script-fingerprint --check` **5 项**。另把 `workflows/three-agent-mvp.js` 的行尾固定为 LF（`.gitattributes`），否则本机 `core.autocrlf=true` 下次检出会把逐字节比对变成 CRLF 假失败。**本条不包含任何真实运行**：第四次运行仍待所有者单独授权，调用数与 token 观测额度另行批准。

- **第五次真实运行 `v0.4-run5-20261017T161034Z` 完成，并获所有者基于报告的验收确认（2026-10-18）**：5 个角色各 1 次调用（5/8，无派生）、交付测试 **97 项全绿**、编排层独立复核 **28/28**、缓存边界 **`CLEAN`**（8 个观测点同哈希，0 违规）、用量 **4 465 947 tokens / 声明 8 000 000**（`WITHIN_BUDGET`、`coverage: complete`）；三方脚本核对唯一差异是宿主去掉末尾换行（`byteDelta: -1`，属允许规则）。随后离线验收阶段：复核工具从 **25 → 28 条**（补齐 R-35 的 README 四个示例、R-29 的 UTF-16 文件与 `PYTHONIOENCODING` 两类真实子进程探针，各带“对照组必须不同”的反证），反例自检 **13 → 19 个**；确认 `docs/review/` 属**有意不入库**，复核包已按约定移到 `docs/run-records/v0.4-run5-20261017T161034Z/review-package/`（旧路径只在历史提交中出现，未改写历史）。**所有者 2026-10-18 基于审核报告确认“本轮演示功能验收通过”**（记录 `review-package/OWNER-ACCEPTANCE.md`）：需求以 `v0.2-demo-input-3` 为准、样本不变；接受离线复算与 R-33/R-37 的历史运行证据；接受已声明能力限制且**不新增连续缓存监控要求**；历史残留与来源不明 worktree 暂不处理。该确认**不含** push / PR / 合并 / 清理现场 / 再跑真实模型，也**不等于整个多模型平台开发完成**。

### 待完成

- **人工审批的安全拒绝测试**（V0.1 正式验收要求，对应验收条件 3）：完成一次被拒绝的受保护操作，证明拒绝后无实际副作用（工作区未变、无远端写入、未安装依赖、权限未变），并归档测试记录。**现状（2026-10-17）**：已执行并通过一次父会话 `pwsh` 沙箱升级审批的人工拒绝路径测试——`approval/decided.outcome=rejected`、`tool/result.isError=true`、目标文件未创建、仓库内容与状态前后一致、用户逐字确认拒绝（现场 `docs/evidence/v0.1-approval-rejection-20261017T112518Z/`，机器判定 `PASS` + 人工确认，`verify` 退出码 0；首次判定因缺人工观察为 `INCOMPLETE`/退出码 3，两次记录均保留）。范围**仅限这一次**：其它工具与"允许一次"路径未验证、远端未观测，因此**不**扩展为"所有工具安全能力通过"。V0.1 最终验收仍未通过（新版真实模型流水线尚未运行）。**2026-10-17 追记**：新版真实流水线已首次运行（`v0.2-run1-20261017T121445Z`，见上"最近状态"与 `ACCEPTANCE-STATUS.md` §16）；V0.1 最终验收仍未通过，但原因已从"流水线尚未运行"改为"远端未观测 + AC-24 的 `__pycache__` 条款未严格执行"。
- **人工审批的强制拦截覆盖面**：首个 MVP 已把审批的三层区分写入 `docs/ARCHITECTURE.md` §2.1，但「一句提示词即强制拦截」的假设不成立；强制拦截只能来自沙箱 + 审批策略 + 操作自身的审批点，需逐条验证（见 `docs/ARCHITECTURE.md` §7 未验证项 #11）。
- **需求一致性自检机制改进**（多次复现，仍未根治）：Requirement Agent 的 `consistency_check` 会漏检真实矛盾——第二次漏掉 AC-12 与 BC-12（"stdout 恰好 `True 0 int`" 与 "成功路径恰好 4 行" 不可同时满足），由 Review Agent 独立发现；第四次漏掉自己写出的 BC-03(b) 与 BC-04 空白行示例（`"  \n\t\n"` 是 2 行与 3 行互斥），第五次漏掉 AC-05 的 `char_count` 示例（示例值 6 与它自己的归一化规则算出的 5 互斥），都由 Verifier 与 Review 各自独立捕获。门禁现已能兜住该类冲突（硬失败 `STAGE_REPORTS_REQUIREMENT_CONFLICT`），但**自检本身仍是"声明式"的**：第六次运行虽然通过（自检报 `conflicts: 0`，下游两阶段与编排层独立复核也都未发现矛盾），并不能证明自检真的会做数值交叉验算。已加入的缓解措施是提示词层面的硬要求（每个数值示例必须给出推导、优先沿用原始需求的示例、示例必须与全部规则逐条比对），仍需在后续运行中持续观察（详见 `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md` §6 与 `docs/REQUIREMENT-CALIBER.md`）。
- **需求基线之外的口径仍未裁定**（2026-10-17 新增）：`docs/REQUIREMENT-BASELINE.md` 的 RB-1 – RB-6 只覆盖 P-1 – P-6 六项；run 6 需求中未被引用的条文（清单见该文件 §5.1）以及"V0.1 验收以哪一轮需求文本为准"这个元问题仍需人工裁定，裁定前不得据此宣称验收通过。**2026-10-17 追记**：元问题已用显式批准解决——所有者批准 `v0.2-demo-input-3` 的 R-01 – R-37 作为 `v0.2-run1` 的需求原文（记录见 `docs/run-records/v0.2-run1-20261017T121445Z/approval.md`）；run 6 需求与 RB-1 – RB-6 的关系仍以 `docs/REQUIREMENT-BASELINE.md` 为准。
- **多模型分工与运行预算：观测部分已落地，强制部分仍未开始（2026-10-17 更新）**：研究稿见 `docs/MULTI-MODEL-BUDGET-STUDY.md`（R-M01 – R-M13）。**已在离线侧实现**观测型能力——`tests/extract-usage-report.mjs` 按运行/阶段/轮次/代理/provider-model 汇总原始 usage 字段，可复算（同样日志逐字节相同）、可归因（含再派生与会话缺失）、并区分"未声明预算 / 覆盖不完整 / WITHIN_BUDGET / OVER_BUDGET"，已在 run1、run2 上做只读复算；`task.maxAgentCalls` 提供了**调用次数**的硬限制（启动前拦截）。**仍未实现/未核实**：单代理内部 token 的硬限制（宿主无已核实接口，不得声称支持）、货币价格（日志无 price/cost 字段，只显示"未提供价格"）、第三方 provider 接入（属人工审批范围），以及跨 provider 的 usage 字段语义一致性等 5 项待核实点。本轮不含付费调用、不新增依赖。
- **清理交付目录中的残留临时目录**（需仓库所有者执行）：`examples/text-stats/.test-scratch/` 下有 11 个第一次运行遗留的 `tmp*` 目录，其 ACL 拒绝读取与删除，AI 沙箱内无法清理；不影响测试通过（被 `.gitignore` 忽略），但建议在本机非受限终端删除。
- **后续 V0.1 扩展目标（不取消，但不是首次运行成功的前提）**：增加方案讨论（discussion）与测试（testing）两个角色，构成五角色完整流水线：需求 → 讨论 → 编码 → 审核 → 测试。

### V0.1 验收条件

1. 仓库结构符合 `README.md` 目录说明；所有文档与代码状态一致。
2. 首个 MVP（Requirement / Coding / Review 三个独立 Agent）有一次**真实可核验**的运行记录：三个 Agent 的实际执行记录、任务输入输出、代码产物、测试结果与审核结论齐备；**不接受仅模拟角色文字的演示**。
3. 人工审批的三层区分（`ask_user_question` 用户交互 / DSH 底层审批缝 / `AGENTS.md` 工程规范的人工确认要求）已文档化；并完成一次**安全的拒绝审批测试**：受保护操作被拒绝后**未发生实际副作用**（工作区文件未变、无远端写入、未安装依赖、权限未变），测试记录归档。
4. `git log` 无敏感信息提交；`.gitignore` 规则经 `git check-ignore` 验证有效。
5. `main` 全程无直接提交；功能分支提交历史清晰。

> **2026-10-18 追记**：本轮演示功能（`v0.2-demo-input-3` 口径）已通过验收，并由所有者**基于审核报告**确认（`docs/run-records/v0.4-run5-20261017T161034Z/review-package/OWNER-ACCEPTANCE.md`）。该确认是“基于报告的验收确认”，不是逐行审查或独立复跑；本追记**不改写**上面五条的既有判定依据，远端发布与 V0.1 其它记录仍按各自条目处理，整个平台（V0.2–V0.4）尚未开始。

> 五角色完整流水线（需求 → 讨论 → 编码 → 审核 → 测试）是 V0.1 的**扩展目标**，不作为首个 MVP 的验收前提。

## V0.2 — 多模型分工与状态持久化（进行中：离线原型）

**目标**：验证多模型协作与长任务的状态管理能力，按需评估 LangGraph 互补路线。

### 本轮进展（2026-10-18，分支 `feat/v0.2-component-reuse`）

- 已落地：`orchestration/` 的"配置 → 价格快照 → 估算 → 预算分配 → 计划"链路；规划与估算部分不调用模型，不需要联网。
- 已核实：六个候选组件的许可证、实际 commit、可用接口与不可用原因，决策见 [`V0.2-REUSE-DECISIONS.md`](V0.2-REUSE-DECISIONS.md)；最小架构与数据契约见 [`V0.2-ARCHITECTURE.md`](V0.2-ARCHITECTURE.md)。
- `dsh-agent-teams` 只做兼容性探测与 `create` 入参翻译，执行恒返回 `unavailable`；`dsh-model-router` 因会覆盖用户所选模型而暂缓；RouteLLM 仅作研究参考。
- 手机通道只做审查与准备清单（[`V0.2-MOBILE-CHANNEL.md`](V0.2-MOBILE-CHANNEL.md)），未安装、未开端口。
- 独立复审轮（2026-10-18，不联网、0 次模型调用）：修复五处真实缺陷——单 token 用量不再被算成 0（`costForTokens(1, 1) === 1`；旧实现返回 `0`）；2^53 附近的中间量溢出改为显式 `MONEY_OVERFLOW`（旧 `divRoundHalfUp(2 ** 52 + 1, 1)` 返回 `4503599627370498`、旧 `divCeil(Number.MAX_SAFE_INTEGER, 2)` 返回 `4503599627370495`，都错 1）；导入器不再丢弃 `cache_write_input_token`；计划的"就绪"拆成多维，任何一维缺失都不得 `ready`（即使插件已安装，`BACKEND_NOT_INSTALLED` 消失也不会自动变成可执行）。独立重算脚本 93 项全部通过，针对性测试新增 1 场景。
- 计价与计数口径修订轮（2026-10-18，不联网、0 次模型调用）：缓存价缺失**不再按输入价冒充上界**，改为金额未知 + blocker `ESTIMATES_INCOMPLETE`；只有配置显式声明 `estimates.assumptions.cachePriceEqualsInput` 才代入并标 `assumed`/`low` + blocker `ESTIMATES_ASSUMED`。调用计数拆成五个不可互换的单位（成员创建 / 代理启动 / 模型请求 / 重试 / token），并新增 `totals.coverage{multiModel, multiProvider}` —— **同一 `deepseek-official` 渠道跑两个模型只算 multiModel，不算 multiProvider**。
- 计费渠道与宿主目录核对轮（2026-10-18，只读联网查 npm registry + 只读提取随包 `app.asar`，0 次模型调用）：价格条目新增 `channel`（唯一键 `provider/model/channel`），渠道不一致不得共用价格；新增 `orchestration/data/host-catalog.dsh-0.2.0-rc.2.json`（随包 provider/model/计费渠道/目录价）与 `--host-catalog` 交叉核对。**发现旧价格快照与宿主目录价差约 3 倍**（`deepseek-v4-pro` 43.5/87 vs 132/396 微-分/百万），且 `deepseek-v4-flash` 不在宿主目录 —— 不能凭旧快照决定运行模型或预算。npm 只读核实：`@nanmicoder/dsh-agent-teams` 的 `latest` 是**稳定版 `0.1.23`**（已声明支持宿主 `0.2.0-rc.2`），`0.1.24-rc.1` 只是 `next`；当时逐行核对的源码仍是 `0.1.24-rc.1`，**版本错配未解决**（阶段 1 已改为按实际安装的 `0.1.23` 包重新核对接口、工具清单与启动路径）。
- 启动前拦截语义轮（2026-10-18）：从随包 `dsh-agent-loop` 只读确认 `agent/request` 瀑布在 `llm.prepareCall()` **之前**触发、重试会重新进入（`:1134`→`:1050`）、抛错冒到 turn 级 catch（`:1008`）即**不发请求**；未打标签的监听器全局可见（`dsh-scope/README.md:42/77`）。据此实现拦截器逻辑与夹具测试（超限零新增发送、并发恰好放行 N 个、重试各自预占）。三阶段集成申请见 [`V0.2-INTEGRATION-PLAN.md`](V0.2-INTEGRATION-PLAN.md)。
- 阶段 1 / 2 隔离验证（2026-10-18，用户按 `m15875` 授权；阶段 3 付费协作未授权）：把 `dsh-agent-teams@0.1.23`（`latest`，integrity 与 npm 元数据一致）装进**隔离 profile `stage1`**（`DSH_HOME` 重定向到工作区内，现用 Desktop profile 全程不可写且未变），重启宿主后用**本机假模型 HTTP 服务**（仅回环监听、未开放公网入口）做零付费验证。**真实外部模型调用 0 次；本地假模型请求 13 次**（run1 1 次放行 / run2 2 次后第 3 次在发送前被拒 / 重启后 0 次新增 / run3 首次派工 4 次含成员 1 次 / run4 followup 6 次含成员 2 次 / run5 监听器故障注入 0 次）；**全轮含失败证据去重后共 2580 次**（另有修复前失控重启的 2567 次）。**负面发现**：插件 `apply()` 抛错时宿主只打印 `warning: 1 entry did not activate` 并继续运行——曾在状态文件存在时跑出上述无预算请求，因此"装了拦截器"不能假设为"预算生效"，必须同时核对挂载事件与服务端请求数。**这条已登记为付费实验（阶段 3）的前置阻塞**：先做挂载失败保护，再谈付费。修复后重启语义为"读回已用额度、不重置"，监听器抛错则为 fail-closed。卸载已复核（`package.json`/`pnpm-lock.yaml` 回基线），残留 `node_modules` 空目录与悬空符号链接。证据见 [`V0.2-STAGE12-EVIDENCE.md`](V0.2-STAGE12-EVIDENCE.md)。
- 启动闸门轮（2026-10-18，针对上一条的前置阻塞；仍未调用真实模型）：把"能不能发请求"从插件搬到**网络层默认拒绝**——`orchestration/gate/gate.mjs` 是只绑 `127.0.0.1` 的本地代理，无有效租约/额度用尽/已撤销即 403 且**不建上游连接**；`tools/gated-run.mjs` 在启动宿主前校验生效配置的 `baseURL` 指向闸门，读到新鲜挂载心跳才发租约、心跳过期即撤销并终止宿主（退出码 3 表示保护未建立、4 表示运行中丢失）。真实宿主故障注入：**插件缺失时上游 0 条**（宿主收到 403 后退出）、**正常挂载 1 条**、**额度耗尽 1 条**（第 2 次在插件层被拒）。夹具 7 场景 / 57 断言覆盖 `apply` 抛错、心跳缺失/过旧、租约过期、运行中撤销与 baseURL 未指向闸门。**未证明**：宿主绕过被覆写的 `baseURL` 时闸门看不到请求、跨进程共享预算、`resume`/`fallback`/自动返工路径；闸门是本地实验工具，**不是宿主级强制保护**。见 [`V0.2-PRELAUNCH-GATE.md`](V0.2-PRELAUNCH-GATE.md)。
- 返工闭环第二轮（2026-10-18，零成本）：更正"队员没有文件写入工具"的错误结论（队员实有 26 个工具，含 `read`/`write`/`edit`/`pwsh`；`MEMBER_TOOL_NAMES` 的 4 个只是协调子集）；三次宿主实验（20 / 1 / 37 次外发假请求，真实外部调用 0）仍未闭合返工，原因定位到工作区根与项目路径不一致、假服务端口占用、规则缺 `maxUses`；账本复算改为四阶段（预占 / 闸门放行 / 上游收到 / 上游完成），缺日志或截断日志一律 `INCOMPLETE`（`tests/v02-ledger.test.mjs` 43 项断言）。详见 `docs/V0.2-B1-MATRIX.md` §7。
- 闸门验证轮（2026-10-18，零成本；用户按 `m16918` 授权）：先查**实际网络路径**——生效配置里不止一个模型 provider 实例（`llm-deepseek`=`deepseek-official`、`llm-deepseek-account`=`deepseek-account`、`llm-pi-ai` 未配 `providers:` 时不注册路由），而闸门只在 `baseURL` 被覆写时位于路径上。**绕过实测**（run G）：把同一 provider 的 `baseURL` 指向另一个回环端点，不经启动器直接跑宿主，请求直接到达该端点并正常返回，闸门完全看不到。据此新增 `extractProviderCoverage` 与 `PROVIDER_NOT_GATED`：生效配置里只要有一个 provider 实例未指向闸门就**拒绝启动**（run F strict：宿主未启动、非闸门端点 0 请求）。**独立拦截**（run E）：插件限额 100 完全不参与拒绝、闸门额度 1 → 客户端 2 次请求、上游严格 1 条、第 2 次由闸门 403 `BUDGET_EXHAUSTED`。并发夹具：10 并发争最后 1 个额度 → 1×200、9×403、上游 1。真实宿主心跳过旧（run H，`--heartbeat-max-age-ms 1`）→ `HEARTBEAT_STALE`、宿主一次 403 后退出、上游 0 新增、退出码 3，无无限重试。夹具扩到 10 场景 / 78 断言。
- 配置绑定轮（2026-10-18，零成本；用户按 `m17221` 授权）：把"启动器校验的生效配置"与"真正启动的实例"绑死——`tools/gated-run.mjs` 不再接受调用方预生成的配置文件（`--dump-config-from` 已删除），改为用**同一条命令、同一 profile、同一 patch 列表、同一工作目录**去问宿主本身，把 stdout 落盘为 `effective-config.yml` 并记 sha256；stdout/stderr 用两个文件描述符分开，避免把报错堆栈当配置。拒绝启动的条件扩为：闸门未就绪、配置读不到（`CONFIG_UNREADABLE`）、覆盖情况不明（`CONFIG_COVERAGE_UNKNOWN`）、没有受保护 provider（`NO_GATED_PROVIDER`）、存在未受保护实例（`PROVIDER_NOT_GATED`）、`baseURL` 未指向闸门。`--allow-ungated-providers` 一并删除，**不存在放宽覆盖率的开关**。真实宿主验证：run I 正常（两个 provider 实例都指向闸门、`config.sha256=ee03e4e9…`、假上游 1 条、退出码 0）、run J 配置不匹配（`llm-deepseek-account` 未指向闸门 → 退出码 3、宿主未启动、上游 0 新增）、run K 配置读不到（profile 不存在 → `CONFIG_UNREADABLE`、退出码 3、上游 0 新增）。夹具扩到 11 场景 / 97 断言；同时产出一份《首次真实模型实验前检查清单》（渠道与 provider、保护范围、单会话串行、请求数上限 2、token 与费用上界、停止条件、三方对账、回滚）。
- 独立审查修复轮（2026-10-18，零成本；用户按 `m17691` 任务书授权）：外部静态审查列出 P0/P1 缺陷后本地重写。P0-1 删除闸门全部 HTTP 写控制面（只留只读 `status`，写调用仅限同进程）；P0-2 租约改为显式状态机（永久撤销后不能再发、迟到心跳不复活、撤销不能续期、`status()` 如实报告、新租约不复位已用额度、关闭后不再授权或转发）；P0-3 挂载证明绑定**运行级 `runId`**（启动器生成、`TLA_RUN_ID` 探测与启动同源、插件每条事件带 `runId`；他 run 事件/坏行/`unmounted`/未来时间默认拒绝；区分挂载证明、活跃心跳与预占事件）；P0-4 生效配置改为**受限 YAML 子集的结构化解析**（拒绝制表符、非空流式集合、锚点/别名、多文档、重复键与重复 id；未知适配器记 `unknown` 并拒绝；`decideStart` 要求覆盖率可验证、无未受保护实例、至少一个受保护 provider）；P0-5 探测失败分类（spawn/signal/timeout/exit/unreadable/unparseable），必须**完整解析**才算成功，`samePatchesAsProbe` 改为逐文件 sha256，并新增 `sameEnvAsProbe`/`sameRunIdAsProbe`。P1：严格整数区间、删除 `--on-loss`、`terminateHost` 的 SIGTERM→宽限→SIGKILL→`taskkill /T /F` 全程有上限、宿主超时主动终止、`finally` 兜底、更正"apply 永不抛错"、状态丢失/损坏一律 fail-closed。反例测试扩到 `v02-gate` **15 场景 / 150 断言**、`v02-prelaunch-budget` **10 场景 / 46 断言**；真实宿主复验（`round2/`）：正向 `EXIT=0`、两 provider 均 guarded、上游 1 条与 `reserved=1` 一致、`runId` 全程一致；不装插件时 `EXIT=3`、`HEARTBEAT_MISSING`、闸门 `NO_LEASE`（`MOUNT_PROOF_PROOF_MISSING`）、上游 0 新增。真实外部模型调用仍为 **0 次**。
- 生命周期修复轮（2026-10-18，零成本；用户按复审任务书授权；**状态：待独立复核**）：复审用两个可复现反例指出生命周期判定"只看首尾"。①健康长跑被误停——`checkProtectionHeartbeat` 先调 `evaluateMountProof` 并用最初 `mounted` 的年龄判 `PROOF_STALE`，运行还没掉保护就被杀；②卸载后迟到心跳被接受——`mounted → unmounted → heartbeat` 仍返回 `ok:true`。修法：新增 `walkRunLifecycle` 完整事件状态机（首条必须 `mounted`；`unmounted` 为终态；重复 `mounted`、时间倒序、坏行、`unmounted` 之后的任何事件都拒绝），`evaluateMountProof` 只判身份/终态、不再用 `mounted` 年龄，`checkProtectionHeartbeat` 只看**最新心跳**年龄，`runEndedByLastEvent` 只要出现过 `unmounted` 即终态（读不出时返回 `true`，fail-closed）。覆盖率语义补强：白名单只证明组件存在，`@deepseek-ai/dsh-web-search-deepseek`（默认 `baseURL` 指向 `api.deepseek.com`）与 `@deepseek-ai/dsh-deepseek-account-platform`（默认 `inferenceOrigin` 指向 `api.deepseek.com`）改为按**端点是否指向闸门**判定，默认端点即 `unguarded` 并拒绝启动。测试 `v02-gate` 升到 **15 场景 / 150 断言**，新增 `scenarioLifecycleAtGate` 用上游请求计数区分"判定误接受"与"真的转发"。真机长跑复验（`round3/long`，心跳间隔 300 ms、`--heartbeat-max-age-ms 2000`）：运行 6.61 s（3.3 个心跳窗口），插件 `reserved` 6 = 闸门 `allowed` 6 = 上游 `accepted` 6，0 拒绝，`EXIT=0`。真实外部模型调用 **0 次**。
- B-1 零付费集成验证（2026-10-18，零成本；用户按 `m18673` 授权；**状态：待独立复核**）：把 `@nanmicoder/dsh-agent-teams@0.1.23` 装回隔离 profile（同一固定版本，不是新依赖），先只读核对其启动与网络路径（`lib/` 22 个 js：0 处 baseURL / 0 处 llm.stream / 0 处 apiKey；唯一的 fetch 指向宿主自身的 `/plugins/dsh-agent-teams/*` 路由），再以**带版本的证据**登记为 `REVIEWED_PLUGIN_EVIDENCE`，未登记组件仍按 `unknown` 拒绝启动。真实宿主跑通 resume（`resumeMode=resumed`、`used` 3→4、第 5 次在发起前被拒）与"一次会话只带一个团队"的双团队尝试（预占 5 = 闸门放行 5 = 上游 5，其中 1 条来自成员会话）；取消场景只证明"已转发 + 宿主被终止"，自动返工与跨闸门 fallback 未在真实宿主执行（分别受限于静态脚本无法引用运行时 `attempt_id`、启动器只支持单闸门）。夹具新增 5 个确定性场景（共用额度、取消不退款、双闸门互不影响、resume 不清零、返工不设独立计数）。本轮假模型 HTTP 请求 9 次，真实外部模型调用 0 次。详见 `docs/V0.2-B1-MATRIX.md`。
- 收口轮（2026-10-18，零成本；用户按 `m18873` 授权；**状态：待独立复核**）：三件事。①**插件身份**：登记表加 `version` + `buildDigest`（包内 `.js/.mjs/.cjs/.json` 按相对路径排序后取哈希）+ `fileCount`，启动器用 `realpathSync` 解析实际安装目录核对，任何不一致即 `PLUGIN_NOT_VERIFIED` 拒绝启动；真机反例（给已装 `lib/index.js` 追加一行注释）→ `EXIT=3`、`hostStarted:false`、指纹 `27dd0897…` vs `4adb2b0c…`；恢复后 `EXIT=0`、两项 `verified`。②**增量账本**：先前"预占 13 / 拒绝 2"是把 resume 两次的累计 `used` 相加，复算后为**预占 10、拒绝 1、放行 9、上游 9**（见 `docs/V0.2-B1-MATRIX.md` §6.1）。③**自动返工**：用反应式假模型（从真实 `tool_result` 提取 `attempt_id` 回填，不猜）在真机跑通"审核失败 → 插件**自动**生成 `t3`（repair）+ `t4`（review）→ 自动派工"，但修复执行与复审未跑完（第 40 次请求预算耗尽），因此只算"调度已证明"。本轮假模型请求 40 次（该次返工运行）、真实外部模型调用 0 次。
- 返工闭环轮（2026-10-18，零成本；用户按 `m20665` 授权；**状态：待独立复核**）：把假模型的判定从"文本里出现某个字符串"改成**结构化的工具结果**——新增 `tests/lib/reactive-model.mjs`（`tla.reactive-model/v2`：只认 `tool_result`/`is_error`/`tool_use_id`，`attempt_id` 只从当前轮 claim 取，规则按角色 + 状态 + `maxUses` 推进，匹配不到就 `NO_PROGRESS`），回归 `tests/v02-reactive-model.test.mjs` 41 项、`tests/v02-repair-rehearsal.test.mjs` 36 项（含隔离小项目 fail→pass）。启动器新增 `--project-cwd`（项目工作区与证据目录分开）、`--require-file`、`--upstream-health-url`/`--upstream-run-id`；闸门为每条转发生成覆盖客户端同名值的 `x-tla-correlation-id`，账本逐条配对。第五次也是唯一一次宿主实验（`repair5`）：闸门放行 16、上游到达 16、关联 ID 16/16 配对、账本 `INCOMPLETE`（3 次未完成响应），**闭环仍未完成**——成员会话的 `write` 被本机沙箱 ACL 挡住（`SetFileSecurityW EACCES (Win32 5)`，与 `pwsh` 的 `SetNamedSecurityInfoW failed` 同源），项目文件改前改后 sha256 相同、测试仍 1 条失败；另有我自己的两处夹具缺陷（轮询额度 6、写失败后重读只允许再写一次）已修并补回归。真实外部模型调用 0 次，全轮假模型请求闸门放行合计 100。详见 `docs/V0.2-B1-MATRIX.md` §9。
- 权限定位与账本口径轮（2026-10-18，零成本；用户按 `m21080` 授权；**状态：待独立复核**）：①**权限预检在 `workspace-write` 下未通过**——全新的最小项目里成员 `write` 同样失败（`SetFileSecurityW EACCES`），本机复现证明"写字节成功、复制 DACL 失败"，根因是这条启动链路带低完整性/受限令牌、宿主继承后无法修改 DACL，与项目 ACL、嵌套 worktree、链接无关；按用户要求只交付解除清单（单条启动命令改在中等完整性令牌下运行，范围/回滚均写明）并停止，未改 ACL、未关沙箱、未把宿主整体切到 `danger-full-access`，见 [`V0.2-PERMISSION-PREFLIGHT.md`](V0.2-PERMISSION-PREFLIGHT.md)。②账本改为**六阶段**（到达 / 成功响应 / 错误响应 / 中断 / 没答完 / 客户端实收），错误响应不再算作"没答完"，无证据的保持 `unknown`；复算 `repair4/run` 为 `COMPLETE` 且关联 ID 26/26 逐条配对（上一轮"重复 ID"是账本把服务端三行当三次请求的误报），`repair5/run` 为 16 到达 / 13 成功 / 0 错误 / 3 没答完，`repair3/run` 保持 `INCOMPLETE`。③夹具调度改为"同一失败原地重试超过阈值即 `NO_PROGRESS_LOOP`"，轮询额度从 10 恢复为 6、轮询规则显式标 `progressExempt`；预演新增两类反例。④本轮**没有新的宿主实验**：唯一一次授权已在上一轮用尽，返工闭环仍未完成。
- 正式化收口轮（2026-10-18，零成本；用户按 `m21939` 任务书授权；**状态：待独立复核**）：把证据从对话搬进仓库，并纠正三处过度表述。①**撤回"只缺一次批准、一旦批准即可跑完"**——Medium 令牌已验证（closure 四次启动日志均打印 `Medium Mandatory Level (S-1-16-8192)`）、保护链已验证（21 次放行），但成员真实写盘、read-before-write 完整走通、完整返工链**仍未验证**；用户暂缓第五次运行是**授权边界**，不是技术失败根因（`docs/V0.2-B1-MATRIX.md` §12.1）。②**账本按原始日志去重**：13 次运行、放行 **130** / 到达 **130**（成功 115、错误 3、没答完 3、响应未知 9）；旧 `84/100` 只含 repair3+repair4(+repair5)，漏了 B-1 四次运行的 9 次（`docs/V0.2-EXPERIMENT-LEDGER.md`、§12.2）。③**read-before-write 专项**：`closure/run4` 的写失败是夹具漏读 `note.txt`（第 11 条请求直接写），宿主按契约拒绝是正确行为；宿主契约（按会话隔离、`realpath` 目标键、`dev:ino:size:mtimeNs:ctimeNs` 版本）与 20 项离线检查见 `docs/V0.2-FS-OBSERVATION.md`。④**夹具进正式测试**：`tests/fixtures/repair-loop-policy.v2.json` + `tests/v02-repair-loop.test.mjs`（55 项：30 次决策、队长 6 / 成员 24 分别计数、工具失败不得 `completed`、红测试不得过审、同一失败连续两次即 `NO_PROGRESS_LOOP`）、`tests/fixtures/repair-protocol/` + `tests/v02-repair-protocol.test.mjs`（123 项：脱敏夹具哈希与无泄漏、14 条历史请求回放命中 13 条）、`tests/lib/observation-model.mjs` + `tests/v02-fs-observation.test.mjs`（20 项）、`tools/redact-protocol.mjs`（转换规则）。⑤交付下一次实验包 `docs/V0.2-NEXT-EXPERIMENT.md`（固定 SHA、命令、新 runId、预检、累计预算、预期事件、停止条件），**只准备、未执行、未申请升级**。

- **验收状态**：条件 1（至少两个不同模型在同一工作流中协作且可复现）**未满足**——本轮没有任何**真实外部**模型调用（阶段 2 只接本机假模型服务），只具备配置、计划与"请求前计数"能力；条件 2（跨轮次恢复）未开始。**不得**把本轮隔离原型当作 V0.2 验收通过。
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


- 独立复核修复（2026-10-18，零成本）：插件身份指纹改为覆盖包根下全部普通文件并校验
  `dsh.bundle.patch` 入口（只改 `cordis.patch.yml` 也会被检出），登记值按已安装包重算；
  启动器核对解析结果是否落在该 profile 根下；新增 `tools/recompute-ledger.mjs` 与
  `tests/v02-ledger.test.mjs`（21 项）把账本口径变成可复算的正式工具；`v02-gate` 17 场景 /
  184 项断言（设 `TLA_REAL_PROFILE` 时 186 项）。返工闭环第三次实验（预算 40）在真实宿主上
  走到“审核失败 → 插件自动生成修复与复审任务 → 自动派工”，但 worker 领到修复任务后没有完成，
  记为“调度已证明、执行未完成”，本轮三次实验额度用尽后停止。
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
