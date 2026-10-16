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

### 待完成

- **人工审批的安全拒绝测试**（V0.1 正式验收要求，对应验收条件 3）：完成一次被拒绝的受保护操作，证明拒绝后无实际副作用（工作区未变、无远端写入、未安装依赖、权限未变），并归档测试记录。
- **人工审批的强制拦截覆盖面**：首个 MVP 已把审批的三层区分写入 `docs/ARCHITECTURE.md` §2.1，但「一句提示词即强制拦截」的假设不成立；强制拦截只能来自沙箱 + 审批策略 + 操作自身的审批点，需逐条验证（见 `docs/ARCHITECTURE.md` §7 未验证项 #11）。
- **需求一致性自检机制改进**（第二次运行时发现）：Requirement Agent 的 `consistency_check` 漏检了 AC-12 与 BC-12 的真实矛盾（"stdout 恰好 `True 0 int`" 与 "成功路径恰好 4 行" 不可同时满足），该矛盾最终由 Review Agent 独立发现。需改进自检判据（例如强制对"精确输出"类断言与"输出行数"类边界条件做交叉验算），并在下一次真实运行时验证能否捕获该类冲突（详见 `docs/evidence/v0.1-second-run/README.md` 第 7 节）。
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
