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

### 规划中（未开始）

- [ ] V0.1 剩余：**人工审批的安全拒绝测试**（受保护操作被拒绝后必须无实际副作用，是 V0.1 正式验收要求）
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
| `agents/` | 三个角色的职责说明与提示词（Requirement / Coding / Review） |
| `workflows/` | 工作流编排脚本（DSH Workflow）与运行说明 |
| `examples/` | 工作流跑通用的演示项目（如 `examples/text-stats/`） |
| `docs/evidence/` | 工作流运行证据归档（原始 Agent 产物、测试输出、独立复核） |
| `tests/` | 项目级测试（当前仅有说明，见 `tests/README.md`） |
| `src/`（规划中） | TLA 自有代码（如后续接入 LangGraph 时的编排层） |

> `src/` 等标注「规划中」的目录尚不存在。`agents/`、`workflows/`、`examples/`、`docs/evidence/` 已随首个 MVP 创建。

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
2. 把 [`workflows/three-agent-mvp.js`](workflows/three-agent-mvp.js) 的脚本交给 DSH 的 **Workflow 工具**执行（`args` 中指定 `targetDir`，例如 `examples/text-stats`）。脚本按顺序调用 `agent()`，每次都是一个**真实 Subagent**：需求 → 编码 → 审核；审核判为 `CHANGES_REQUESTED` 时，把审核意见交回同一编码 Agent 修订（默认最多 2 轮）。
3. 运行结束后，证据文件写入 `docs/evidence/<runId>/`：需求 JSON、编码报告、审核结论、测试输出。

参数与细节见 [`workflows/README.md`](workflows/README.md)。

### 运行演示项目的测试与独立复核

```powershell
python -m unittest discover -s examples/text-stats -p "test_*.py" -v
python -B docs/evidence/v0.1-first-run/orchestrator-verification.py
```

一次真实运行的完整记录（含三个 Agent 的产物与审核结论）见 [`docs/evidence/v0.1-first-run/README.md`](docs/evidence/v0.1-first-run/README.md)。
