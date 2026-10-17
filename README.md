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

- [x] **人工审批的安全拒绝测试**：已执行并通过一次父会话 `pwsh` 沙箱升级审批的人工拒绝路径测试（现场见
  [`docs/evidence/v0.1-approval-rejection-20261017T112518Z/`](docs/evidence/v0.1-approval-rejection-20261017T112518Z/README.md)；
  范围仅这一次：其它工具与"允许一次"路径未验证、远端未观测）
- [ ] V0.1 剩余：**新版真实模型流水线**在新门禁下的完整运行（演示需求输入需先经一次确认）
- [ ] V0.1 扩展目标：加入 discussion、testing 两个角色，构成五角色完整流水线（不是首次运行成功的前提）
- [ ] V0.2 起：多模型分工、状态持久化/断点续跑评估、ChatGPT Plus/Codex 兼容性验证、LangGraph 互补路线评估
- 详见 [docs/ROADMAP.md](docs/ROADMAP.md)

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
| `docs/run-records/` | 每次真实运行的批准记录、注入需求原文与执行前检查（与 `docs/evidence/` 的证据分开） |
| `agents/` | 角色职责说明与提示词（Requirement / Coding / Review / Verifier） |
| `workflows/` | 工作流编排脚本（DSH Workflow）与运行说明 |
| `examples/` | 工作流跑通用的演示项目（如 `examples/text-stats/`） |
| `docs/evidence/` | 工作流运行证据归档（原始 Agent 产物、DSH 原生事件、测试输出、独立复核） |
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
# 编排逻辑回归测试（模拟子代理返回值，85 个场景 / 391 项断言）
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

# 演示项目的单元测试（76 个用例；v0.2 真实流水线交付版，含程序化调用 --help / 受控错误 / 非法 --encoding 的静默回归）
python -m unittest discover -s examples/text-stats -p "test_*.py" -v

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
