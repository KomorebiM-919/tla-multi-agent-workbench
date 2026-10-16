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

### 规划中（未开始）

- [ ] V0.1 剩余工作：首个 DSH 原生多 Agent 工作流（需求分析 → 讨论 → 编码 → 审核 → 测试）
- [ ] V0.2 起：多模型分工、状态持久化/断点续跑评估、LangGraph 互补路线评估
- 详见 [docs/ROADMAP.md](docs/ROADMAP.md)

## 目录说明

| 路径 | 用途 |
| --- | --- |
| `README.md` | 项目介绍与进度总览 |
| `AGENTS.md` | 面向所有 AI 开发者的工程规范 |
| `.gitignore` | 忽略规则（密钥、凭据、缓存、虚拟环境等） |
| `docs/ARCHITECTURE.md` | 技术架构与路线对比（DSH 原生 vs LangGraph） |
| `docs/ROADMAP.md` | V0.1–V0.4 阶段计划与验收条件 |
| `agents/`（规划中） | 各角色 Agent 的定义与提示词 |
| `workflows/`（规划中） | 工作流编排脚本（DSH Workflow） |
| `tests/`（规划中） | 项目级测试 |
| `src/`（规划中） | TLA 自有代码（如后续接入 LangGraph 时的编排层） |

> 标注「规划中」的目录尚不存在，将在对应阶段创建。

## 安全约定

本仓库为公开仓库（public）。**绝对禁止**提交以下内容：

- API Key（如 `sk-...`）、OAuth 登录凭据、访问令牌
- 客户隐私数据、个人身份信息
- 任何真实密钥配置文件（示例配置如 `.env.example` 允许提交，但不得含真实值）

提交前必须执行敏感信息检查（详见 `AGENTS.md`）。

## 快速开始

当前阶段仅有文档与骨架，无需安装依赖。后续阶段的运行方式将在对应版本中补充。
