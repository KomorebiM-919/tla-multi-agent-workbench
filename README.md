# tla-multi-agent-workbench

An extensible multi-agent workbench for AI collaboration, task orchestration, and software development.

**TLA（Tailored Logic Atelier）多智能体工作台**：在 DeepSeek Harness（简称 DSH）之上构建的可扩展多智能体协作开发工作台。目标是由多个 AI 模型（Agent）协同完成需求分析、方案讨论、编码、代码审核和测试，形成一条可人工审批的软件开发流水线。

## 项目定位

- **宿主平台**：DeepSeek Harness（本机安装版 44.0.0），优先复用其原生能力：Subagent（子代理）、Workflow（工作流编排）、Goal（跨轮次持久目标）、人工审批（ask_user_question 与审批策略）、文件沙箱、Skills 与 Hindsight 记忆。
- **TLA 的职责**：定义面向软件开发的**多智能体角色分工**、**协作流程**与**人工审批关卡**，而不是重新实现 DSH 已有的编排与执行能力。
- **设计原则**：尽量使用官方现有能力，不重复造轮子；一切未经验证的 API 假设都必须先核实后使用。

## 计划实现的功能（规划中，尚未实现）

- [ ] 需求分析 Agent：把自然语言需求整理为可执行的任务清单
- [ ] 方案讨论：多 Agent 对同一问题进行多角度讨论并收敛结论
- [ ] 编码 Agent：在本地项目工作区中实现代码
- [ ] 代码审核 Agent：对改动做规范、安全与正确性审查
- [ ] 测试 Agent：编写并执行测试，反馈结果
- [ ] 多模型适配：不同角色使用不同模型（利用 DSH 的 agent 级 `agentOptions` 覆盖与 `llm-pi-ai` 多 provider 适配器；官方已证实 Workflow 无 phase 级覆盖）
- [ ] 人工审批节点：关键步骤（如合并、推送、安装依赖）必须经人类确认

## 当前进度

### V0.1 已完成

- [x] 阶段一：项目本地初始化（克隆仓库、建立 `main` 与功能分支）
- [x] 阶段二：基础项目骨架与技术文档（本分支 `feat/v0.1-foundation`）：
  - 工程规范 `AGENTS.md`
  - 架构文档 `docs/ARCHITECTURE.md`（DSH 原生能力与 LangGraph 三条路线对比及推荐）
  - 路线图 `docs/ROADMAP.md`（V0.1–V0.4）
  - 忽略规则 `.gitignore`

- [x] 阶段三：**首个三 Agent MVP 跑通**（分支 `feat/v0.1-three-agent-mvp`，2026-10-16）：

  - 三个真实、独立的角色提示词：`agents/requirement-agent.md`、`agents/coding-agent.md`、`agents/review-agent.md`
  - 工作流脚本 `workflows/three-agent-mvp.js`：由 DSH **Workflow** 工具执行，逐步调用真实 **Subagent**，由脚本编排逻辑保证执行顺序与结果传递（`phase()` 仅用于进度展示，不构成执行依赖）
  - 一次真实运行的完整证据链 `docs/evidence/v0.1-first-run/`：需求 → 编码 → 审核 → **修订 → 复审**，共 5 次子代理执行；首轮审核 `CHANGES_REQUESTED`，复审 `APPROVED`
  - 演示项目 `examples/text-stats/`：仅标准库的文本统计工具，44 个单元测试全绿；编排层另有 **45 项独立复核**全过

- [x] 阶段四：**按首次代码审核意见加固工作流，并完成第二次真实运行**（分支 `feat/v0.1-three-agent-mvp`，2026-10-16）：

  - 成功判定不再只看 Review 结论：必须同时满足「编码自述测试通过 ∧ Verifier 独立复跑通过 ∧ Review `APPROVED` 且其自测通过 ∧ 验收条件全覆盖且逐条满足 ∧ 需求一致性自检无冲突」；自述结果与独立验证结果分别记录并比对，矛盾即判定不通过
  - 新增两个真实子代理角色：`agents/verifier-agent.md`（`preflight` 只读预检 / `verify` 独立复跑），工作流由三角色变为**五步子代理编排**
  - 参数校验与证据保护：`runId`、`evidenceDir`（必须在 `docs/evidence/` 下且末段等于 `runId`）、目标目录与文件名（拒绝绝对路径与 `..` 穿越）、测试命令白名单、`maxCodingAttempts`（1–5 整数）、时间戳（拒绝占位时间）；**校验失败不启动任何子代理**；已存在的证据目录一律拒绝，绝不覆盖历史归档
  - Requirement Agent 增加**验收条件与边界条件的一致性自检**，发现冲突即停止而非让 Coding Agent 自行选口径
  - 编排逻辑回归测试 `tests/workflow-logic.test.mjs`：用 `node:vm` 装载真实脚本 + 模拟子代理返回值，覆盖 **31 个场景**（正常、各类失败、非法参数、修订循环、证据保护）
  - 第二次真实运行证据 `docs/evidence/v0.1-second-run/`：5 次子代理执行、交付测试 **55 个全绿**、编排层 **266 项独立复核 0 失败**，并含从 DSH 原生会话日志提取的**脱敏执行事件**（会话标识、时间、turn/step、工具调用），可证明三个角色确实是独立子代理

- [x] 阶段五：**按第二轮复审意见加固成功门禁与证据保护**（分支 `feat/v0.1-three-agent-mvp`，2026-10-16）：

  - **冲突即硬失败**：任一阶段（Coding / Verifier / Review）报告未解决的需求冲突 ⇒ `STAGE_REPORTS_REQUIREMENT_CONFLICT`，不再进入修订轮，且该状态优先于其他失败原因
  - 验收条件按 **ID 集合逐项核对**（缺失 / 重复 / 未知 ID 各有独立状态码）；并要求 Verifier 的 `artifacts` 与 Review 复核后重算的 `artifacts_after` 的文件集合与 `sha256` 完全一致（否则 `ARTIFACT_FINGERPRINT_MISMATCH`）
  - 路径与防覆盖：交付目录 / 证据目录必须回报 `realpath` 且位于仓库内、拒绝链接逃逸、`runId` 必须以 `-<UTC 时间戳>` 结尾并与 `runStartedAt` 同秒、证据目录先写 `.run-owner.json` 认领（未认领即终止）
  - 提示词修正：Requirement 的冲突定义（"现有实现与需求不一致"不是冲突，必须写进 `scope_in` / 验收条件）、Coding 的紧凑返回值与 `files_created` 硬要求、Verifier "写证据 vs 禁止写文件"的自相矛盾
  - 回归测试扩到 **50 个场景 / 227 项断言**；新增需求口径提案 `docs/REQUIREMENT-CALIBER.md` 与第二轮裁定文档 `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md`
  - **需求口径已裁定（2026-10-17）**：所有者的 P-1 – P-6 六项确认固化为可版本化基线 `docs/REQUIREMENT-BASELINE.md`（`v0.1-demo-baseline-1`）；裁定只覆盖这六项，run 6 需求的其余条文仍属未逐条裁定（清单见基线第 5.1 节）
  - 第三次、第四次、第五次真实运行都被门禁拦下（`REQUIREMENT_CONFLICT`、`STAGE_REPORTS_REQUIREMENT_CONFLICT`），原始记录保留、未冒充成功
  - **第六次真实运行（`v0.1-run6-20261016T154400Z`）首次通过**：两轮尝试（首轮 `CHANGES_REQUESTED` → 修订 → 复审 `APPROVED`），8 次子代理执行、交付测试 **81 个全绿**、独立复核 **30 项交叉检查 0 失败**；完整证据见 `docs/evidence/v0.1-run6-20261016T154400Z/`

### 规划中（未开始）

- [x] **V0.2 原型：手动多模型分工与预算规划**（分支 `feat/v0.2-component-reuse`，2026-10-18；**真实外部模型调用 0 次**；`dsh-agent-teams@0.1.23` 只装进隔离 profile `stage1`，未触碰现用 Desktop profile）：

  - `orchestration/`：配置校验、离线价格快照查询、整数金额估算、按基点分配预算（最大余数法，各项之和恒等于总额）、计划生成与 `create` 入参翻译
  - 价格快照 `orchestration/data/pricing-snapshot.portkey-72e1084.json`：取自 portkey-models@`72e1084` 的 6 条真实条目，由"美分/token"换算为"微-分/百万 token"整数；该仓库无时间戳，**新鲜度未知、未与官网核对**
  - 宿主模型目录 `orchestration/data/host-catalog.dsh-0.2.0-rc.2.json`：从随包 `app.asar` 只读提取的 provider/model/计费渠道/目录价，用 `--host-catalog` 与计划交叉核对。**已发现旧快照与目录价差约 3 倍**（`deepseek-v4-pro` 43.5/87 vs 132/396 微-分/百万），且 `deepseek-v4-flash` 不在宿主目录中——所以不能用旧快照决定运行模型或预算
  - 对 `dsh-agent-teams` 只做兼容性探测与计划翻译，执行恒返回 `unavailable`（`BACKEND_EXECUTION_NOT_IMPLEMENTED`），不伪造集成成功
  - 边界声明：预算是**计划分配**，不是付款/余额/跨供应商划拨；`agent-teams` 后端**没有**全局模型调用硬上限（`CALL_CAP_PARTIAL`）；计划的就绪状态拆成七个维度（配置/估算/估算可信度/后端兼容/执行实现/预算保护/宿主路由核对），任何一项缺失都 `status: "blocked"`（"插件装了"不等于"能执行"）
  - 金额一律整数微单位、费用**向上取整**（非零用量不会被算成 0）。缓存读写缺价时**不冒充上界**：金额记未知并进入 blocker，只有配置显式声明 `estimates.assumptions.cachePriceEqualsInput` 才按输入价代入，并标 `assumed`/`low`
  - 启动前拦截器 `orchestration/interceptors/prelaunch-budget.mjs` + 真实接线插件 `orchestration/interceptor-plugin/`：宿主形状的 `agent/request` 监听器，在请求发出前同步预占、超限抛错（**零新增发送**）。**已在隔离 profile 的真实宿主上验证**：额度耗尽时假服务端零新增请求、重启不重置额度、监听器异常 fail-closed；同时实测到"插件激活失败只警告、不 fail-closed"（无预算跑到 2567 次请求，全轮含失败证据共 2580 次假模型 HTTP 请求），因此"装上了"永远不等于"预算生效"，**该缺口已登记为付费实验的前置阻塞**。夹具测试 11 场景 / 53 断言，真实宿主实验见 [`docs/V0.2-STAGE12-EVIDENCE.md`](docs/V0.2-STAGE12-EVIDENCE.md)
  - 离线复跑：`node orchestration/cli.mjs plan --config orchestration/examples/plan-agent-teams.json --pricing orchestration/data/pricing-snapshot.portkey-72e1084.json --host-catalog orchestration/data/host-catalog.dsh-0.2.0-rc.2.json --now 2026-10-17T18:00:00Z`（退出码 0 = ready，2 = blocked）
  - 启动闸门 `orchestration/gate/` + 启动器 `tools/gated-run.mjs`（同日的后续修复）：本地 HTTP 代理只绑 `127.0.0.1`、**默认拒绝**，只有"有效租约 + 额度未用尽"才建立上游连接；启动器在启动宿主前校验生效配置的 `baseURL` 指向闸门，读到新鲜挂载心跳才发租约、心跳过期则撤销并终止宿主。真实宿主故障注入的上游请求数：插件缺失 **0**（闸门 403、宿主退出码 3）、正常挂载 1（退出码 0）、额度耗尽 1（第 2 次在插件层被拒）、**插件完全不参与拒绝时仍为 1**（第 2 次由闸门 403 BUDGET_EXHAUSTED）、心跳过旧 **0 新增**（退出码 3）、存在未受保护 provider 实例时**拒绝启动**。实现、故障矩阵与**未证明项**见 [`docs/V0.2-PRELAUNCH-GATE.md`](docs/V0.2-PRELAUNCH-GATE.md)；闸门只是本地实验工具，不是宿主级强制保护：**实测把同一 provider 的 `baseURL` 换个回环端点，宿主就直接把请求发给该端点并正常返回，闸门完全看不到**（run G）；因此保护强度等于"生效配置里每个 provider 实例都指向闸门"这条覆盖率校验，而不是闸门本身存在
  - 测试 `tests/v02-orchestration.test.mjs`（12 个场景 / 267 项断言）、`tests/v02-prelaunch-budget.test.mjs`（11 个场景 / 53 项断言）与 `tests/v02-gate.test.mjs`（18 个场景 / 187 项断言；设 TLA_REAL_PROFILE 指向隔离 profile 时再多 2 项）、`tests/v02-reactive-model.test.mjs`（反应式假模型引擎 45 项断言，含 `NO_PROGRESS_LOOP` 直接反例：只认结构化的 `tool_result`/`is_error`/`tool_use_id`，失败文本里的成功字样、历史里的旧 `attempt_id`、空结果、跨会话串状态都不算推进）、`tests/v02-repair-rehearsal.test.mjs`（38 项断言：26 次状态迁移的返工序列预演 + 隔离小项目 fail→pass→回退再 fail；**合成工具往返与预演不等于宿主验证**）与 `tests/v02-b1-scenarios.test.mjs`（5 个确定性场景）、`tests/v02-repair-loop.test.mjs`（55 项断言：30 次决策走完返工与复审流程，失败分支与 `maxUses` 上限逐条断言）、`tests/v02-repair-protocol.test.mjs`（123 项断言：脱敏夹具哈希与无泄漏校验 + 14 条历史请求回放）、`tests/v02-fs-observation.test.mjs`（20 项断言：读后写契约的离线模型，路径写法归一、跨会话不授权、读后变化与并发创建）、`tests/v02-plugin-identity.test.mjs`（33 项断言：分类与身份核验消费同一个规范化实例——只有 id 的实例在未证明安装身份时必须拒绝、显式名合法、名字与已登记 id 冲突、包未被 profile 声明、字节被改、同包多实例、disabled、阻断项去重）；含针对"半上取整""2^53 中间量溢出""缓存写被丢弃""兼容即 ready""缓存缺价被当成上界""重启静默重置额度""无租约仍放行""用调用方给的配置文件冒充生效配置""长跑被 mounted 年龄误杀""卸载后迟到心跳被接受""自带模型端点的随包组件被白名单放过""未 claim 的成员请求共用会话键""写失败的报错被当成完成""轮询额度按 6 次写死""同一个失败原地重试到无限""按 id 放行插件而身份列表为空也算通过"十六处真实缺陷的回归断言；另有插件登记的版本与构建指纹核对（同名不同版本、同版本不同字节、证据缺失都拒绝启动），以及检出保真 `tools/check-checkout-fidelity.mjs` + `tests/v02-checkout-fidelity.test.mjs`（6 项断言：在强制 `core.autocrlf=true` 的一次性 worktree 上复算插件字节，CRLF 改写与代码改动都必须被拒，登记指纹不得被改写）、静态预检 `tools/static-preflight.mjs` + `tests/v02-static-preflight.test.mjs`（6 项断言：红测试必须是红、插件目录要能真解析出登记版本与指纹、`apiKeyEnv` 缺失或环境变量为空都拒绝、失败项一次列全）、以及账本复算的六阶段口径（`tools/recompute-ledger.mjs`：预占 / 闸门放行 / 上游收到 / 成功响应 / 错误响应 / 没答完分开计数，连接中断与客户端实收在没有对应证据时保持 `unknown`，缺日志、截断日志、只写一半的日志一律标 INCOMPLETE，回归见 `tests/v02-ledger.test.mjs` 59 项断言）。测试本身不联网、不调模型
  - 启动器自己读配置（配置绑定）：`tools/gated-run.mjs` 用与启动宿主**同一条命令、同一 profile、同一 patch 列表、同一工作目录**去问宿主"你的生效配置是什么"，把输出落盘并记 sha256，再核对其中**每一个启用中的 provider 实例**的 `baseURL` 是否指向本次闸门；取不到配置（`CONFIG_UNREADABLE`）、覆盖情况不明（`CONFIG_COVERAGE_UNKNOWN`）、没有任何受保护 provider（`NO_GATED_PROVIDER`）、存在未受保护实例（`PROVIDER_NOT_GATED`）时一律拒绝启动（宿主不启动、上游 0 请求）。`--dump-config-from` 与 `--allow-ungated-providers` 已删除，不存在"用调用方文件替代生效配置"或"放宽覆盖率"的开关。真实宿主 run I/J/K 证据与拒绝码含义见 [`docs/V0.2-PRELAUNCH-GATE.md`](docs/V0.2-PRELAUNCH-GATE.md) §7.1；实验前逐项清单见 [`docs/V0.2-FIRST-REAL-EXPERIMENT-CHECKLIST.md`](docs/V0.2-FIRST-REAL-EXPERIMENT-CHECKLIST.md)
  - 结论与清单：[`docs/V0.2-REUSE-DECISIONS.md`](docs/V0.2-REUSE-DECISIONS.md)、[`docs/V0.2-ARCHITECTURE.md`](docs/V0.2-ARCHITECTURE.md)、[`docs/V0.2-MOBILE-CHANNEL.md`](docs/V0.2-MOBILE-CHANNEL.md)、[`docs/V0.2-INTEGRATION-PLAN.md`](docs/V0.2-INTEGRATION-PLAN.md)（阶段 1/2 已执行，阶段 3 付费协作**未授权**）、[`docs/V0.2-PERMISSION-PREFLIGHT.md`](docs/V0.2-PERMISSION-PREFLIGHT.md)、[`docs/V0.2-STAGE12-EVIDENCE.md`](docs/V0.2-STAGE12-EVIDENCE.md)（隔离环境实测记录）、[`docs/V0.2-PRELAUNCH-GATE.md`](docs/V0.2-PRELAUNCH-GATE.md)（启动闸门：设计、故障矩阵、限制）

- [x] **人工审批的安全拒绝测试**：已执行并通过一次父会话 `pwsh` 沙箱升级审批的人工拒绝路径测试（现场见
  [`docs/evidence/v0.1-approval-rejection-20261017T112518Z/`](docs/evidence/v0.1-approval-rejection-20261017T112518Z/README.md)；
  范围仅这一次：其它工具与"允许一次"路径未验证、远端未观测）
- [x] **新版真实模型流水线的完整运行（第五次，`v0.4-run5-20261017T161034Z`）**：5 个角色各 1 次调用（5/8，无派生）、交付测试 97 项全绿、编排层独立复核 28/28、缓存边界 `CLEAN`、用量 4 465 947 tokens（声明 8 000 000，`WITHIN_BUDGET`）；证据见 [`docs/run-records/v0.4-run5-20261017T161034Z/`](docs/run-records/v0.4-run5-20261017T161034Z/README.md)。**所有者已于 2026-10-18 基于审核报告确认“本轮演示功能验收通过”**（记录：[`OWNER-ACCEPTANCE.md`](docs/run-records/v0.4-run5-20261017T161034Z/review-package/OWNER-ACCEPTANCE.md)）；该确认是“基于报告的验收确认”，不是所有者逐行审查或独立复跑，也不代表整个多模型平台开发完成
- [ ] **远端发布授权**：交付与归档均只在本地，未 push、未建 PR、未合并 `main`；按 `AGENTS.md` §9 需所有者单独授权。发布前的离线检查、PR 文稿与安全检查见 [docs/PUBLICATION-READINESS-v0.1.md](docs/PUBLICATION-READINESS-v0.1.md)
- [ ] V0.1 扩展目标：加入 discussion、testing 两个角色，构成五角色完整流水线（不是首次运行成功的前提）
- [ ] V0.2 剩余：智能推荐与排序（需要真实评估数据）、推荐预算比例、状态持久化的真实冷恢复实测、手机通道安装与移动网络实测、Codex 兼容性验证、LangGraph 互补路线评估（均未开始）
- 详见 [docs/ROADMAP.md](docs/ROADMAP.md)

### 当前能力状态

（2026-10-18）

按"有没有代码 / 有没有在真实宿主上跑过 / 能不能声称做到"三栏分开写，避免把离线证明当成产品能力。

**已实现（代码在库，离线测试全绿）**

- V0.1 演示流水线（5 角色各 1 次调用；交付测试 97 项；编排层独立复核 28/28）。
- V0.2 离线规划/预算分配/价格查询 CLI（`orchestration/cli.mjs`，价格带 `channel`、含宿主目录核对）。
- 本地启动闸门 `orchestration/gate/` + 启动器 `tools/gated-run.mjs` + 预算插件 `orchestration/interceptor-plugin/`：租约、挂载证明、心跳、额度、`runId` 绑定、覆盖率校验、插件版本与构建指纹校验。
- 账本 `tools/recompute-ledger.mjs`（六阶段），反应式假模型 `tests/lib/reactive-model.mjs`。
- 本次收口新增：正式返工策略 `tests/fixtures/repair-loop-policy.v2.json`、30 步预演 `tests/v02-repair-loop.test.mjs`（55 项断言）、脱敏协议夹具 + 回放 `tests/v02-repair-protocol.test.mjs`（123 项断言）、读后写契约模型 `tests/lib/observation-model.mjs` 与 `tests/v02-fs-observation.test.mjs`（20 项断言）、再脱敏工具 `tools/redact-protocol.mjs`、实验包命令生成与离线校验 `tools/experiment-command.mjs` + `tests/v02-experiment-package.test.mjs`（60 项断言：用启动器自己的 `parseArgs` 校验文档里的命令、核对假模型端口与 runId 一致、缺文件与非空 run-dir 提前拒绝、请求上限无法通过改参数绕过、asar 包内 `--dsh-cli` 只校验归档本身、隔离家目录必须随命令一起传（`--dsh-home`）、探测与命令必须拿到同一个 overlay）、以及检出保真 `tools/check-checkout-fidelity.mjs` + `tests/v02-checkout-fidelity.test.mjs`（6 项断言：一次性 worktree 上强制 `core.autocrlf=true` 仍要复算出审查字节）与静态预检 `tools/static-preflight.mjs` + `tests/v02-static-preflight.test.mjs`（6 项断言：红测试必须是红、插件目录真解析、`apiKeyEnv` 缺失即拒绝）、模板化 overlay `tools/overlay-template.mjs` 与生效配置检查 `tools/inspect-effective-config.mjs` + `tests/v02-effective-config.test.mjs`（8 项断言：用启动器同一个 `buildInvocation` 取 `--dump-config` 再判定，上一轮失败的 overlay 必须被判 `provider:llm-deepseek` FAIL，模板渲染的输出必须 9 项检查全过（含 `coverage:launcher-classifier`、`identity:per-instance`、`identity:no-conflict-or-duplicate`），身份证据缺失必须判 FAIL 而不是"没有证据就算通过"，且 fixture 里的适配器名必须存在于启动器登记表）。本轮新增**实验监督器** `tools/experiment-runner.mjs` + `tests/v02-experiment-runner.test.mjs`（88 项断言，真实子进程与真实端口；含"宿主 spawn 失败要回收上游"、"孙进程比父进程活得久要判 `cleanup-anomaly`"、"运行中抛异常仍要收尾"、"清理后端口仍被占用不得记为 completed"、"固定来源不匹配 / 夹具漂移 / 检出有本地修改都在 spawn 前拒绝"、"摘要里的超时与租约必须出现在真实 argv 里并与解析值逐项一致"）与**健康探针** `tools/health-probe.mjs` + `tests/v02-health-probe.test.mjs`（22 项断言）；`experiment-command` 现在只产出**一条**监督命令（`--fake-server` / `--policy` / `--pin-source` / `--pin-fixtures` 一起进 spec），overlay 由同一模板渲染并交给生效配置检查判定，`tests/v02-experiment-package.test.mjs` 相应增至 70 项断言。另有正式验收工具 `tools/ledger-from-run.mjs`（把监督器分开放的四个输入拼成临时视图交给 `measureRun`，不手抄数字）与 `tools/acceptance-summary.mjs`（把"监督器完成 / 宿主退出 / 业务闭环"三个判据分开推导，未满足项逐条列出）+ `tests/v02-acceptance-summary.test.mjs`（19 项断言：`closed` 要同时满足 10 个条件——实现文件被改、写后回读一致、同命令测试先红后绿、复审先拒绝再通过、repair 任务实际完成、≥4 个任务全 completed、账本完整；只写 `note.txt`、读在写之前、复审只拒绝、repair 失败都判 `partial`）。

- **按真实调度重建的夹具（离线）**：`tests/fixtures/repair-loop-policy.v3.json`（35 条规则，规则分 `action` / `poll` / `idle-wait` 三类）+ `tests/lib/host-sim.mjs`（真落盘、真跑测试、真执行"必须先读后写"契约、成员回合结束即唤醒队长）+ `tests/v02-repair-loop-v3.test.mjs`（37 项断言：真实交错、报告迟到、重复结算、成员报错、无状态变化）与 `tools/budget-plan.mjs`（预算预演 31 / 35 / 38 ≤ 40，反例 50）。
**已实测（真实宿主 + 回环假模型；真实外部模型调用 0 次）**

- 保护链：额度耗尽零新增外发、重启不重置额度、监听器异常 fail-closed、插件缺失时闸门 403、心跳过期拒绝、配置/覆盖率不匹配拒绝启动、插件版本或字节不符拒绝启动。
- 派工与 followup 调度；自动返工**只到**"插件生成修复/复审任务并自动派工"。
- 四次 closure 运行（21 次放行）都在中等完整性令牌下完成（启动日志打印 `Medium Mandatory Level (S-1-16-8192)`）。
- 受控实验的**启动前闸门**（2026-10-18）：外层升级已拿到 Medium 令牌、命令通过 `experiment-command` 校验，但启动器在宿主进程创建前以 `PLUGIN_NOT_VERIFIED` 拒绝（插件检出被本机 `core.autocrlf=true` 改写成 CRLF，指纹 `4de4b80e…` 而非审查值 `54f1a8e3…`），闸门放行 0 次、模型请求 0 次。已用 `.gitattributes` 修复（`5e1167d`）并在新检出上复算回 `54f1a8e3…`；本轮未重跑，详见 [`docs/V0.2-B1-MATRIX.md`](docs/V0.2-B1-MATRIX.md) §13。
- 受控实验的**第二次授权运行**（2026-10-18，`3bdd078`）：检出保真预检 `FIDELITY OK`、静态预检全部通过（红测试红、两个插件指纹相符、端口空闲、run 目录为空），宿主启动、插件挂载并写出心跳、闸门放行 **0** 次、上游模型请求 **0** 次——宿主在凭据解析处停止（`MISSING_CREDENTIAL`：`llm-deepseek` 没有 `deepseek-official` 路由的 API key）。根因是 overlay 只改写了 `baseURL`、没写 `apiKeyEnv`；现已在正式预检里加 `overlay:credentials` 一项（缺 `apiKeyEnv` 或环境变量为空都拒绝），并把 overlay 修正版作为下一份实验包的一部分，未在当轮重跑。详见 [`docs/V0.2-B1-MATRIX.md`](docs/V0.2-B1-MATRIX.md) §14。
- 受控实验的**第三次授权运行**（2026-10-18，**执行源码 `d769fcd`**）：外层升级拿到 Medium 令牌（`S-1-16-8192`），但启动器在宿主进程创建前以 `PROVIDER_UNKNOWN: tla-prelaunch-budget` 拒绝——overlay 用 `insert:` 注入的预算插件没有 `name`，启动器把它当成未知模型适配器，而生效配置检查器的另一套分类器把它当共享管线，两边判断分歧。闸门放行 **0** 次、插件预占 **0** 次（无挂载、无 `reserved` 事件）、上游模型请求 **0** 次，`hostStarted=false`。已按"任何失败即停止本轮"结束，未在当轮重跑；**失败后**的修复是 `26021ab`，不是失败运行的执行版本。详见 [`docs/V0.2-B1-MATRIX.md`](docs/V0.2-B1-MATRIX.md) §16 与 §17.4 的 SHA 更正。
- 启动器与离线预检的**判断初步统一**（`26021ab`）：启动器按 id 认识自己的出勤插件（`plumbing`），overlay 模板把包名写进 `insert:` 条目，生效配置检查新增第 9 项 `coverage:launcher-classifier`——用启动器自己的分类器判同一份 dump。在净检出 `v02-run4` @ `26021ab` 上离线复验：`FIDELITY OK`、`STATIC PREFLIGHT OK`、9 项配置检查全过（`guarded [llm-deepseek]`、`unknown []`）。
- **身份判定的真正统一**（`45b6540`）：上一轮的"按 id 放行"留下一个缺口——`{id:'tla-prelaunch-budget'}`（无 `name`）或 `{id:'tla-prelaunch-budget', name:'@acme/router'}` 都会被分类成 `plumbing`，而身份核验只收集 `entry.name`，于是**空身份列表**也能"通过"。现在分类与核验消费同一个规范化实例：`resolveInstancePackages` 记录包名是显式声明、只能从 id 猜、与已登记 id 冲突还是不可求值；缺 `name` 只有在**profile 声明了该包**且**安装字节能对上审查摘要**时才解析为自有插件；`judgePluginInstances` 输出每实例的 `kind`/身份结果/原因，启动器对冲突名、同包多实例、缺失身份结果与身份不完整一律拒绝，检查器复用同一判定并输出逐实例表。反例与回归见 [`docs/V0.2-B1-MATRIX.md`](docs/V0.2-B1-MATRIX.md) §17。
- 受控实验的**第四次授权启动尝试**（2026-10-18，执行源码 `45b6540`）：静态预检与生效配置 11 项全过、外层拿到 Medium 令牌，但启动器在宿主创建前以 `UPSTREAM_UNHEALTHY` 拒绝——假模型服务是用 `Start-Process` 起的**分离进程**，工具调用结束时进程树被回收，健康检查时已 `fetch failed`。闸门放行 **0**、插件预占 **0**（无挂载、无 `reserved`）、上游模型请求 **0**、宿主进程 **0**。这是上游进程寿命问题，不是保护链失效；按规则未追加启动授权、未现场改动后重跑（§18）。
- **实验生命周期监督器在真实本地进程上跑通**（`tools/experiment-runner.mjs`，88 项断言，真实环回上游、真实子进程、真实端口）：一条命令从同一份 spec 派生端口/runId/日志目录/预算，先起假上游并校验 `runId`，再起受保护宿主，全程监视，最后有界收尾。已验证：正常完成、端口被占、上游起不来、就绪后启动前上游退出、运行中上游退出、宿主失败、超时、取消、**宿主派生的孙进程也被清掉**、`stopOwnedProcess` 不会挂起；每次结束都断言端口释放、pid 不再存活。另外五条是本轮补的：**宿主 spawn 失败不能留下上游**（否则异常会让整个监督器退出）、**孙进程活得比父进程久必须记 `cleanup-anomaly`**、**运行中抛异常仍要走收尾并写摘要**、**清理后端口仍被占用不得记为 completed**、**固定修订必须真核验**（`HEAD`、检出无本地修改、夹具字节等于固定来源；不匹配、漂移、未知修订一律在网络与进程动作之前拒绝，外部假上游与策略文件的 `sha256` 一并记入证据）。摘要里的模型请求数、租约、心跳上限与超时同时写进真实 argv，并按 `--flag value` 逐项比对，防止"记录值"与"执行值"分叉。健康探针单独 22 项断言，把连接失败/超时/非 2xx/无效 JSON/缺 `runId`/`runId` 不匹配分别归类，不再把 `fetch failed` 包装成"属于其他运行"。**这是本地替身证明，不是宿主验证。**
- **第五次受控宿主运行（2026-10-18，执行源码 `11084b2`）：宿主真的起来了，成员真的写了一个文件，闭环仍未完成。** 外层 Medium 令牌（`S-1-16-8192`）、监督器相位 `pinned-verified → … → host-exited`、宿主 `exit 0`、假模型由监督器自己托管；闸门放行 15/40、拒绝 0，插件预占 15、上游到达 15、完成 15，关联 id 15/15、账本 `COMPLETE`。成员（会话 `bbcd2700…`，26 个工具）依次 claim → start → 读源码 → **写前先读 `src/note.txt`** → 写入 `PREFLIGHT-OK`（文件 mtime 在运行窗口内，`sha256 9E963723…`）→ 跑预检测试；队长在每个成员回合后轮询。停止点是夹具的轮询额度：`captain-polls-while-members-work` 在 `team-created` 状态用满 6 次后，引擎在 seq 15 拒绝（`NO_PROGRESS: captain: state=team-created 下没有可用规则`），宿主随后按自己的节奏退出。因此 `src/sum.mjs` 未改、测试仍 3 红、任务 `t1` 仍 `in_progress`、复审从未发生。三判据由正式工具分开记：`verdict = partial`，`unmet = [TESTS_GREEN, TASKS_COMPLETED, REVIEW_RAN]`。详见 [`docs/V0.2-B1-MATRIX.md`](docs/V0.2-B1-MATRIX.md) §21。
- 账本按原始日志复算：13 次运行、**放行 130 / 到达 130**（成功 115、错误 3、没答完 3、响应未知 9）。旧文档里的 `84/100` 漏了 B-1 四次运行的 9 次，已在 [`docs/V0.2-B1-MATRIX.md`](docs/V0.2-B1-MATRIX.md) §12.2 更正；逐次索引见 [`docs/V0.2-EXPERIMENT-LEDGER.md`](docs/V0.2-EXPERIMENT-LEDGER.md)。

**未验证（不得声称）**

- **宿主返工闭环未完成**：没有一次"成员改完文件 → 红测试转绿 → 复审拒绝 → 复审通过 → 下游解锁"的真实记录。
- 成员写**既有实现文件**（本轮只证明了写一个已读过的新建文件）、写后回读、完整返工链。
- 真实付费多模型协作（真实外部模型调用 **0** 次）、跨 provider 实测、fallback 跨路由共享总额、多会话并发、跨进程预算、按角色配额、手机通道、智能推荐与价格实时化。
- 闸门是本地实验工具，**不是宿主级强制保护**：把同一 provider 的 `baseURL` 换个回环端点，宿主会直接把请求发给该端点，闸门看不到；保护强度等于"生效配置里每个 provider 实例都指向闸门"这条覆盖率校验。
- 本轮证明了监督器生命周期、闸门与插件预算在真实宿主上对账（15 = 15 = 15），也证明了成员能真实写盘；但 `read→write→回读→红→拒绝→修复→绿→复审`的完整闭环仍未在宿主里跑通一次，停在夹具轮询额度与真实交错不匹配处。

**更正（保留在库，不删除旧表述）**

- 旧结论"读后写契约导致队员写失败"更正为"**夹具漏了 `read`**，宿主拒绝未观察的写是正确行为"，证据与宿主契约行号见 [`docs/V0.2-FS-OBSERVATION.md`](docs/V0.2-FS-OBSERVATION.md)。
- "唯一缺一次批准、一旦批准即可跑完"**撤回**：用户暂缓运行是授权边界，不是技术失败根因，边界表见 [`docs/V0.2-B1-MATRIX.md`](docs/V0.2-B1-MATRIX.md) §12.1。

**最短复算**：`node tests/v02-orchestration.test.mjs`、`node tests/v02-gate.test.mjs`、`node tests/v02-ledger.test.mjs`、`node tests/v02-reactive-model.test.mjs`、`node tests/v02-repair-rehearsal.test.mjs`、`node tests/v02-repair-loop.test.mjs`、`node tests/v02-repair-protocol.test.mjs`、`node tests/v02-fs-observation.test.mjs`、`node tests/v02-experiment-package.test.mjs`、`node tests/v02-experiment-runner.test.mjs`、`node tests/v02-health-probe.test.mjs`、`node tests/v02-checkout-fidelity.test.mjs`、`node tests/v02-static-preflight.test.mjs`；账本 `node tools/recompute-ledger.mjs --json <run-dir>`。预演与历史回放**不等于**宿主验证。

## 目录说明

| 路径 | 用途 |
| --- | --- |
| `README.md` | 项目介绍与进度总览 |
| `AGENTS.md` | 面向所有 AI 开发者的工程规范 |
| `.gitignore` | 忽略规则（密钥、凭据、缓存、虚拟环境等） |
| `docs/ARCHITECTURE.md` | 技术架构与路线对比（DSH 原生 vs LangGraph） |
| `docs/ROADMAP.md` | V0.1–V0.4 阶段计划与验收条件 |
| `docs/REQUIREMENT-BASELINE.md` | V0.1 演示任务需求基线（已人工裁定六项口径，可版本化） |
| `docs/REQUIREMENT-CALIBER.md` | 需求口径裁定记录（冲突原文、两处更正、逐项裁定记录） |
| `docs/DEMO-REQUIREMENT-INPUT-v3.md` | V0.1 演示任务需求输入稿 v3（`v0.2-demo-input-3`，2026-10-17 经 Q1 批准为 `v0.2-run1` 真实流水线的需求原文；取代 v2） |
| `docs/DEMO-REQUIREMENT-INPUT-v2.md` | v2 候选稿（`v0.2-demo-input-2`，已被 v3 取代，保留供对照） |
| `docs/DEMO-REQUIREMENT-INPUT.md` | v1 候选稿（`v0.2-demo-input-1`，已被 v2 取代，保留供对照） |
| `docs/MULTI-MODEL-BUDGET-STUDY.md` | 多模型分工与运行预算：候选需求（R-M01 – R-M13）+ 可行性研究（可直接实现 / 依赖官方接口 / 尚未核实） |
| `docs/run-records/` | 每次真实运行的批准记录、注入需求原文与执行前检查（与 `docs/evidence/` 的证据分开） |
| `agents/` | 角色职责说明与提示词（Requirement / Coding / Review / Verifier） |
| `workflows/` | 工作流编排脚本（DSH Workflow）与运行说明 |
| `examples/` | 工作流跑通用的演示项目（如 `examples/text-stats/`） |
| `docs/evidence/` | 工作流运行证据归档（原始 Agent 产物、DSH 原生事件、测试输出、独立复核） |
| `orchestration/` | V0.2 离线编排原型：配置校验、价格快照与宿主目录核对、估算、预算分配、计划与后端适配、启动前拦截器、默认拒绝的启动闸门（不调用模型） |
| `tests/` | 编排逻辑回归测试与验证入口（见 `tests/README.md`） |
| `src/`（规划中） | TLA 自有代码（如后续接入 LangGraph 时的编排层） |

> `src/` 等标注「规划中」的目录尚不存在。`agents/`、`workflows/`、`examples/`、`docs/evidence/`、`tests/` 已随首个 MVP 及其加固轮创建。

## 安全约定

本仓库为公开仓库（public）。**绝对禁止**提交以下内容：

- API Key（如 `sk-...`）、OAuth 登录凭据、访问令牌
- 客户隐私数据、个人身份信息
- 任何真实密钥配置文件（示例配置如 `.env.example` 允许提交，但不得含真实值）

提交前必须执行敏感信息检查（详见 `AGENTS.md`）。

## 快速开始

演示项目与工作流**不需要安装任何第三方依赖**（仅 Python 标准库 + DSH 原生工具）。

### 运行三 Agent 工作流

1. 打开本机已安装的 **DeepSeek Harness** 桌面应用，新建一个会话，把该会话的工作目录指向**本项目根目录**。
2. 把 [`workflows/three-agent-mvp.js`](workflows/three-agent-mvp.js) 的脚本交给 DSH 的 **Workflow 工具**执行（Workflow 工具只接受**内联脚本**，脚本内部没有文件系统/网络 API，因此必须把整份脚本作为 `script` 参数发出）。脚本按顺序调用 `agent()`，每次都是一个**真实 Subagent**：预检 Verifier → 需求 → 编码 → 验证 Verifier → 审核；审核判为 `CHANGES_REQUESTED` 时，把审核意见交回新的编码 Agent 修订（默认最多 2 轮）。`args` 至少要给**一个新的 `runId`**（必须以 `-<UTC 时间戳>` 结尾且与 `runStartedAt` 同一秒，例如 `v0.1-run7-20261016T170000Z`）与对应的 `evidenceDir`（默认 `docs/evidence/<runId>`，末段必须等于 `runId`），`targetDir` 例如 `examples/text-stats`。
3. 运行结束后，证据文件写入 `docs/evidence/<runId>/`：`.run-owner.json`（认领标记）、预检结果、需求 JSON、编码报告、独立验证输出、审核结论；每轮修订各带 `-revision-N` 后缀。
4. 复核证据：`cross-check-workflow-result.py`（返回值 ↔ 磁盘证据交叉检查）、`extract-native-events.mjs`（从 DSH 会话日志提取脱敏的原生执行事件）、`make-review-manifest.py`（材料清单与逐文件哈希）。

参数与细节见 [`workflows/README.md`](workflows/README.md)。

### 运行测试与独立复核

```powershell
# 编排逻辑回归测试（模拟子代理返回值，114 个场景 / 547 项断言）
node tests/workflow-logic.test.mjs

# 预检认领门禁的集成测试（真实调用 tools/claim_evidence_dir.py，6 个场景 / 59 项断言）
node tests/preflight-claim-integration.test.mjs

# 证据目录排他认领工具的进程级测试（11 个用例）
python -m unittest discover -s tests -p "test_*.py"

# 审批拒绝取证工具的离线回归与反向验证（131 断言 + 18 组 v1→v3 + 11 组 v2→v3；不触发任何审批）
node tests/approval-rejection-evidence.test.mjs
node tests/approval-evidence-mutation.test.mjs

# 文本统计的有界性质测试（固定种子 0–9、1217 组，独立参考实现；约 0.2 秒）
python tests/property_text_stats.py

# 演示项目的单元测试（97 个用例；v0.4-run5 交付版，含程序化调用 --help / 受控错误 / 非法 --encoding 的静默回归）
python -m unittest discover -s examples/text-stats -p "test_*.py" -v

# V0.2 编排原型的离线测试（12 个场景 / 267 项断言 + 11 个场景 / 53 项断言 + 18 个场景 / 187 项断言 + 账本复算 50 项断言 + 反应式引擎 41 项断言 + 返工预演 36 项断言；不联网、不调用模型）
node tests/v02-orchestration.test.mjs
node tests/v02-prelaunch-budget.test.mjs
node tests/v02-gate.test.mjs
node tests/v02-ledger.test.mjs
node tests/v02-reactive-model.test.mjs
node tests/v02-repair-rehearsal.test.mjs

# 编排层独立复核（直接验算需求中的边界条件）
python -B docs/evidence/v0.1-second-run/orchestrator-verification.py

# 返回值 ↔ 磁盘证据交叉检查（第六次运行）
python -B docs/evidence/v0.1-second-run/cross-check-workflow-result.py --result docs/evidence/v0.1-run6-20261016T154400Z/workflow-result.json --evidence-dir docs/evidence/v0.1-run6-20261016T154400Z

# 审查材料清单与逐文件哈希
python -B docs/evidence/v0.1-second-run/make-review-manifest.py --repo . --out docs/evidence/v0.1-second-run/REVIEW-MANIFEST.md
```

已完成的三次完整真实运行记录（含各角色的产物、审核结论、DSH 原生执行事件与诚实记录）见
[`docs/evidence/v0.1-first-run/README.md`](docs/evidence/v0.1-first-run/README.md)、
[`docs/evidence/v0.1-second-run/README.md`](docs/evidence/v0.1-second-run/README.md) 与
[`docs/evidence/v0.1-run6-20261016T154400Z/README.md`](docs/evidence/v0.1-run6-20261016T154400Z/README.md)；
被门禁拦下的 run 3 – run 5 记录在 [`docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md`](docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md)。
