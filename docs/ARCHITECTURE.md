# TLA Architecture

TLA（Tailored Logic Atelier）多智能体工作台的技术架构说明。本文档记录**已核实的技术事实**（标注证据来源）、三条候选技术路线的对比，以及当前阶段的架构决策。文档随架构演进持续更新。

> 原则：所有能力声明必须有证据（官方文档、本机实测、工具清单原文）；未验证的假设一律列入「未验证项」，禁止当作事实使用。

## 1. 设计原则

1. **优先复用宿主平台原生能力**：TLA 建立在 DeepSeek Harness（DSH）之上，能用 DSH 现成机制的（子代理、工作流、审批、沙箱、记忆）就不自己实现。
2. **证据先行**：使用任何 API 前必须核实其存在性与稳定性；不凭经验假设。
3. **角色分工，流程显式**：多智能体协作通过明确的角色（需求、讨论、编码、审核、测试）与显式流转规则实现，流程本身可追踪、可审计。
4. **人工审批是硬关卡**：合并、推送、依赖安装、权限变更等操作必须有真人确认。
5. **敏感信息零提交**：公开仓库，任何凭据禁止进入 Git 历史。

## 2. 技术资产盘点（证据核实结果）

### 2.1 DeepSeek Harness

#### 本机安装版（本机实测，2026-10-16）

- 安装目录 `<harness-install-dir>`，Electron 桌面应用，版本号 `44.0.0`（`version` 文件），nightly 更新通道，发布者 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.（`resources/app-update.yml`）。
- 捆绑运行时：Node.js 24.18.1、pnpm 11.7.0（`resources/runtime/versions.json`）。
- 家目录 `~/.dsh` 内含：`sessions/`（会话）、`storages/`（存储）、`llm-deepseek/`（DeepSeek 模型适配器目录）、`profiles/`（当前仅初始化 `desktop` 配置文件）、`.credentials.yaml`（凭据文件，内容不读取、不复用）。

#### 官方开源仓库（docs 原文核实，master 分支，2026-10-16）

- 仓库 <https://github.com/deepseek-ai/deepseek-harness>：默认分支 `master`（非 main），MIT 协议，TypeScript 单仓 monorepo（`apps/`、`docs/`、`packages/` 40+ 包组、`python/`、`native/`、`website/`）。
- 架构底座：**Cordis 插件框架**，口号 "Everything is a Plugin"。
- 仓库版本 `0.2.1-alpha.4`（package.json），`packageManager: pnpm@11.28.5`，`engines.node: ^22.19.0 || >=24.0.0`，桌面端 devDependency `electron ^44.7.0`。
- README 官方警告（原文）："DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**" → 官方明确不承诺兼容性。
- 版本体系注意：本机安装版 `44.0.0`（桌面应用版本号）与仓库 pre-release `0.2.1-alpha.4`（包版本号）体系不同，视为两条独立版本线；官方文档证据为设计层面，本机行为以实测为准。

#### 原生能力（第一手宿主工具清单 + 官方 docs 交叉核实）

| 能力 | 机制 | 证据 |
| --- | --- | --- |
| 子代理 Subagent | `ctx.subagents` 运行时；provider 为 `spawn`/`fork`/`acp`；官方另有**子代理后端包**：`subagent-codex`（providerName `codex`、全局工具 `subagent_codex`；每次运行为全新 app-server + 一次性临时线程、**无续跑/池化**；运行时固定 `@openai/codex@0.153.4`；本包不登录、不建账号、不改 Codex 设置）、`subagent-claude-code`、`subagent-dsh-sdk`、`subagent-acp`；启动请求字段 `cwd, agentPreset, label, prompt, parent, signal, agentOptions, outputSchema, maxDepth`；结果为 `output / structured / diagnostic / stopReason`；模型工具 `subagent`/`subagent_fork`/`send_message`/`interrupt_agent`/`list_agents` | 宿主工具清单 + docs/subsystems/subagent.md + packages/subagent/*/README.md |
| Workflow 工作流 | JavaScript 编排脚本（`agent()`/`pipeline()`/`parallel()`/`phase()`/`log()` 钩子 + `args` 全局量，顶层 await 允许，以 `return <json>` 结束）；`meta` 字段与 Claude Code 动态工作流词表一致；结构化结果经子代理 `outputSchema` 校验；错误抛 `WorkflowError`（fatal）；事件 `workflow/start·phase·log·agent-start·agent-end·end` 可观察。⚠️ **`phase()` 只用于进度展示，不产生真正的执行依赖**（`phases` 是进度词汇，供观察者分组显示，不构成执行结构）；**Agent 的执行顺序与结果在 Agent 之间的传递，必须由 Workflow 脚本的实际编排逻辑保证**（`pipeline` 逐级传递、显式参数与返回值、`parallel` 汇总等），不得依赖 phase 声明；**无按 phase 覆盖 provider/model 的能力**——官方原文 "Workflow policy is fixed per tool registration"，provider 选择属部署配置而非模型调用参数，后续多模型分配必须按已验证的 agent 级机制设计 | 宿主工具清单 + docs/subsystems/workflow.md |
| 多模型适配 | `ctx.llm` 供应商中立服务；适配器：`llm-deepseek`（官方直连）、`llm-deepseek-api-key`、`llm-pi-ai`（多 provider 目录路由 + 手工声明 OpenAI 兼容/自建网关，`providers` 字典路由，凭据经 `apiKeyEnv` 或 OAuth 登录存入凭据库，详见下节）；**agent 级**覆盖：`SubagentStartRequest.agentOptions` 支持 per-agent 的 provider/model/reasoning-effort/output-token 覆盖；**无 phase 级覆盖** | 宿主工具清单 + packages/llm/*/README.md |
| 会话持久化与续跑 | `ctx.sessionPersistence`：每会话一个追加式逻辑 JSONL 日志，默认 checksummed Zstandard 分帧存储，崩溃安全原子落盘、分批 fsync、断尾截断；`ctx.agents.resume({ resumeSessionId })` 续跑，崩溃中断的 turn 由 agent-loop 补合成 `turn/end { reason: interrupted }`；`ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })` 在 turn 边界分叉会话；会话元数据含 `cwd?, parentSession?, isSeeded, delegationDepth?`。**无图节点级检查点/时间回溯** | docs/subsystems/persistence.md |
| 人工审批 | `ctx.approval.request()` → `allowed-once / rejected / cancelled / unavailable`；策略 `ask`（默认）/`never`（无人值守严格模式，一律拒绝）；UI 通道提供人工应答者，**ACP 桥可为自动化代理提供机器决策**；`ask_user_question` 工具支持 blocking（默认）与 timed（超时释放模型继续工作，`{"pending": true, "callId"}` 后续送达回答；超时≠批准） | 宿主工具清单 + docs/subsystems/approval.md |
| 本地项目接入 | `workspace` 包族：命名项目列表 + 按目录分组会话；`skill-filesystem` 从项目/自定义/用户目录发现并监视 skills；文件工具 + 分级沙箱 + 后台任务 + `present` 交付 | 宿主工具清单 + packages/workspace |
| 记忆 | Hindsight 仓库级记忆与知识页 | 宿主工具清单 |

#### 人工审批的设计区分与拦截边界（2026-10-16 审核确认）

**必须区分三层，不得混为一谈**：

| 层 | 机制 | 性质与边界 |
| --- | --- | --- |
| 用户交互层 | `ask_user_question` 工具：blocking（默认）或 timed；超时返回 `{"pending": true, "callId"}`，**超时≠批准** | 只是**交互手段**（提问、征求意见、收集选择），本身不拦截任何操作 |
| 宿主审批层 | DSH 审批缝 `ctx.approval.request()` → `allowed-once` / `rejected` / `cancelled` / `unavailable`；策略 `ask`（默认）/ `never`（无人值守严格模式，一律拒绝） | **真正的操作级关卡**：由被保护操作触发，返回值决定该次操作是否执行 |
| 工程规范层 | `AGENTS.md` §9 的人工确认要求（push、PR、合并 `main`、安装依赖、修改全局配置/系统权限/DSH 源码、接入付费 API、移动删除代码、扩大权限） | **工程约定**：规定「哪些操作必须有真人批准」，其强制力依赖前两层真正落实 |

**拦截边界（关键约束）**：

- **不得假定「在提示词里写一句要求」就能保证所有危险操作被强制拦截**。提示词与 Agent 自觉属于**软约束**，无法穷尽所有危险路径，也不构成可验证的保证。
- 强制拦截只能来自：宿主沙箱（如 `workspace-write` 与越权审批升级）、审批策略（`ask` / `never`）、以及被保护操作自身的审批点；覆盖范围必须**以负面测试验证**，不能用文档声明代替。
- **V0.1 必须完成一次安全的拒绝审批测试**（见 `docs/ROADMAP.md` V0.1 验收条件）：对受保护操作发起审批并明确拒绝，确认**没有发生实际副作用**（工作区文件未变、无远端写入、未安装依赖、权限未变），并归档测试记录。
- 任何「某类操作已被完全拦截」的结论都必须有实测证据；未验证前一律留在 §7 风险清单中（见 #11）。

#### 第三方模型接入机制（GPT / Codex / GLM 等；官方包 README 原文核实，2026-10-16）

`ctx.llm` 是供应商中立服务，接入非 DeepSeek 模型有两条官方路径：**pi-ai 目录路由** 与 **手工声明网关路由**（适配器 `@deepseek-ai/dsh-llm-pi-ai`）。证据：`packages/llm/llm-pi-ai/README.md`、`docs/user/guide/providers.md`、`packages/subagent/subagent-codex/README.md`（均为 master 分支原文，2026-10-16 核实）。

- **配置面**：`providers` 字典即全部配置面，每个键是一个路由名，请求以 `GenerateOptions.provider` 选择。官方示例含 `openai`（`apiKeyEnv: OPENAI_API_KEY`、`baseURL`、`reasoning: high`）、`anthropic`（`apiKeyEnv: ANTHROPIC_API_KEY`、`models: [{ id: claude-sonnet-4-5, contextWindow: 200000 }]`）与手工声明的 `acme-gateway`（`api: openai-completions`、`baseURL`、`compat: { thinkingFormat: deepseek }`、自定义 `models` 含 `reasoningEfforts`）。
- **凭据**：`apiKeyEnv` 是凭据**引用**，经 harness 凭据缝按请求解析，密钥不写入配置文件（解析为空则请求失败 `MISSING_CREDENTIAL`）；pi-ai 自带登录的 provider 可走 **OAuth 或交互式密钥**登录，凭据存于凭据库 `llm-pi-ai/<provider id>` 并在跨进程锁下刷新；手工声明路由名必须是小写连字符标识符，否则凭据写入被拒（`LlmError('UNSTORABLE_PROVIDER_ID')`）。
- **GPT（OpenAI 模型）**：catalog 路由 `openai` + API Key。官方明确限制（原文）："OpenAI offers no ChatGPT sign-in … the `openai` route signs in with an API key." → **不支持用 ChatGPT 账号登录**，只能用 API Key。
- **Codex**：两条**互不相同且都已文档化**的轴。
  1. **作为模型传输（catalog 路由 `openai-codex`）**：官方 Dev Note 原文 "Bedrock, Vertex, Azure, and Codex authenticate through flows a profile cannot completely describe with a key, an endpoint, and headers; catalog routes still reach them through their own provider, and only an explicit override is refused. **Codex is sign-in-able through the authorization flow's OAuth grant.**"；官方另说明 "Providers without native key authentication, such as `openai-codex`, show no key field unless the profile explicitly names a credential reference." → 走 OAuth 授权登录，**不是**可手写的 `api` 协议；Codex/Azure 传输还会忽略 `supportsMaxOutputTokens` 兼容字段。
  2. **作为外部 Agent 后端（独立包 `subagent-codex`）**：官方原文 "Install `@deepseek-ai/dsh-subagent-codex` into a Profile when delegated work should run in a genuine, unattended Codex session in the parent Session's workspace."；机制为 "Every run spawns a fresh app-server, creates one ephemeral thread, and executes exactly one turn; **there is no continuation, resume, or pooling**."；认证留在原生 Codex 侧（"the Bundle supplies the CLI but does not create an account, log in, trust a project, or rewrite Codex settings"）。
  - **Codex 委派与 ChatGPT Plus 兼容性（V0.2 独立验收项，尚未验证）**：待验证的目标是「能否经官方 `openai-codex` OAuth 路线或 `subagent-codex` 后端，用**已有的 ChatGPT Plus 订阅**在 DSH 内完成 Codex 任务委派」。约束与前提：① 必须区分 **ChatGPT 订阅权限**与**独立 OpenAI API 计费**——两者互不通用，本机文档已证 `openai` 路由**不接受 ChatGPT 登录**（只接受 API Key），因此订阅权益只能经 OAuth 授权路径尝试，且不构成任何 API 额度；② **不承诺**特定模型一定可用，**不承诺**无限额度；③ 未经用户明确批准，不得安装 Codex、不得授权账户、不得使用付费 API；④ 不得读取、复制或提交 OAuth Token 或其他认证秘密（与 `AGENTS.md` §7 一致）。该项只做「调查 + 实测取证」，不改变 V0.1/V0.2 的运行依赖。
- **GLM / Kimi 等国产模型**：**官方随附 provider 目录已内置**（官方用户指南原文："pick a provider dsh ships with — the list shows provider ids such as `anthropic`, `openai`, `moonshotai` for Kimi, or `zai` for GLM — enter its API key, and save."）。目录中已证实的 provider id 含 `openai`、`anthropic`、`openai-codex`、`zai`（GLM）、`zai-coding-plan`、`moonshotai`（Kimi）、`minimax`、`bailian`、`qwen-token-plan`、`qwen-token-plan-cn`、`xiaomi`、`deepseek`、`google`、`xai`、`openrouter`、`azure`、`bedrock`、`opencode`、`kilo`、`openai-codex-responses`；**未证实**存在名为 `zhipu`/`stepfun`/`baichuan`/`siliconflow`/独立 `qwen` 的 provider id（见 §7 #9）。
- **任意 OpenAI 兼容端点（官方文档化的第三入口："Custom model API"）**：官方原文 "Switch the card to **Custom model API** for a relay, a company gateway, a self-hosted server, or any provider absent from the installed catalog. Supply a lowercase Provider ID, base URL, API protocol, credential, and at least one model."，落盘为 profile 的 `cordis.patch.yml`，示例：
  ```yaml
  - id: llm-pi-ai
    config:
      providers:
        my-gateway:
          apiKeyEnv: GATEWAY_API_KEY
          api: openai-completions
          baseURL: https://gateway.example/v1
          models:
            - id: legacy-chat
  ```
  **可手写的 `api` 协议恰好三个**（官方用户指南逐字枚举）：`openai-completions`、`openai-responses`、`anthropic-messages`；"A provider speaks one protocol, so a gateway that serves two needs two providers."；兼容开关用于国产兼容网关的典型差异（原文 "Most OpenAI-compatible gateways refuse at least one thing OpenAI accepts."，如 `compat: { supportsDeveloperRole: false, maxTokensField: max_tokens }`）。
- **其余可调项**：`models`（整体替换目录）/ `modelOverrides`（只调整个别目录模型）/ `compat`（system prompt 归属、输出上限字段、thinking 传输方式）/ `reasoningEfforts`（把档位映射成网关词汇，如 `max: ultra`）/ 路由级 `retryPolicy`（默认 `normal`、5 次）；自建 vLLM 可另设 `thinkingTokenBudgetField`、`vllmPriority`。
- **官方已知限制（与本项目相关）**：`GenerateOptions.stop` 不支持（`UNSUPPORTED_OPTION`）；登录流程**不跨进程持久**（登录中途刷新页面需重来）；未编目模型必须显式指定路由 `api`；无 Key 的无认证路由仍需占位凭据（OpenAI 兼容实现要求 API Key 或 `Authorization` 头）；错误码稳定（`MISSING_CREDENTIAL`/`INVALID_CREDENTIAL`/`UNKNOWN_MODEL`/`QUOTA`/`RATE_LIMIT`/`IMAGE_OFFLOAD_REQUIRED`）；上游 pi-ai（`@earendil-works/pi-ai` 1.1.0）带本地补丁 `patches/@earendil-works__pi-ai@1.1.0.patch`，**升级 pi-ai 必须重打该补丁**。

#### 外部程序化接口（官方文档核实，2026-10-16）

- **五类 profile**：`web` / `headless` / `sdk` / `sdk-minimal` / `acp`；基础 bundle `dsh-base`（模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测）之上叠加应用 bundle（`dsh-headless`=无服务器的一次性执行器；`dsh-sdk-app`=SDK JSON-RPC 服务器；`dsh-acp-app`=纯自动化 ACP 服务器）。
- **`dsh headless`**（一次性 CLI）："Answer one task and exit"——答案到 stdout、诊断到 stderr；选项 `--json`（stdout 输出换行分隔运行事件）、`--session-id`（接管已持久化会话）→ **CLI 层支持会话续跑**。
- **TypeScript SDK**（packages/sdk）：外部进程通过**换行分隔 stdio JSON-RPC** 驱动完整运行时；**Python SDK**（python/，发行物 `deepseek-harness-sdk` + `deepseek-harness-runtime-bin`）：默认启动捆绑的 `dsh --profile sdk` 子进程；官方原文 "Every launch requires an explicitly selected Harness home; Python never silently reads `~/.dsh`"。→ **Python 程序（如 LangGraph 节点）驱动 DSH 的官方途径**。
- 线路协议：客户端→服务端 7 方法（`initialize`、`session/prompt`、`session/resume`、`session/wait`、`session/working-directory/get`、`session/working-directory/set`、`shutdown`）；服务端→客户端 4 通知（`session.event` 全量、`session.status`、`subagent.started`、`subagent.finished` 仅进程内运行）；`serverInfo.name` 恒为 `deepseek-harness-sdk-runtime`。官方声明的限制：**无协议版本协商**（仅携带 `serverInfo.version 0.0.1`，客户端不校验）、**无取消/会话关闭方法**（放弃轮次=关闭运行时进程）、服务端→客户端请求为 dead capability（Python SDK 的 responder 面预留给未来审批流）。
- **ACP**：`dsh acp` 经标准 Agent Client Protocol over stdio 对外——客户端可创建/列出/恢复/关闭会话、挂载标准 MCP 服务器、选择模型选项、发送文本与图像提示、接收语义更新、**应答权限提示、无需人类在场取消工作**。
- **无对外 HTTP API（已核实否定）**：`docs/api-gateway.md` 的网关是**内部**浏览器↔主机 RPC（`POST /api/<namespace>/<method>`、WebSocket `/api/remote.mux`、`ctx.remoteAccess.decide()` 访问控制），未文档化为第三方网络 API；SDK/ACP 均仅文档化 stdio 传输。官方 README 的 Web UI 默认端口为 `127.0.0.1:3080`（`npx @deepseek-ai/dsh web`）；本机桌面安装版实际为 `127.0.0.1:19387`（401 需认证，见本机实测）。
- 未发现「把 dsh 作为 npm 库 import 进本地项目」的文档化方式；官方集成途径 = CLI/Web UI、Python/TypeScript SDK 子进程、ACP、headless。客户端插件 boot 注入在文档中仅称 "boot injections"，未给出 `window.__DSH_BOOT__` 字面量（需读源码确认，见未验证项）。

### 2.2 历史 LangGraph 环境（F 盘，只读检查结果）

**环境状态（2026-10-16 只读实测，未做任何修改）**：

- 位置：`F:\The university\AI\TLA\Agent System`，仅含 `.venv` 虚拟环境。
- Python 3.13.12；LangGraph 1.2.15（PyPI 当前最新稳定版，`requires_python >=3.10`）。
- 已装关键包：`langgraph-checkpoint 4.3.0`、`langgraph-prebuilt 1.1.0`、`langgraph-sdk 0.4.7`、`langchain-core 1.6.10`、`pydantic 2.14.1`。
- **未安装**：任何模型接入包（无 `langchain-openai` / `langchain-deepseek` / `langchain-anthropic`）、任何持久化 checkpointer 包（无 `langgraph-checkpoint-sqlite` / `-postgres`）→ 当时的环境只能跑内存状态、且没有接模型。
- 运行验证：`from langgraph.graph import StateGraph` 导入成功，环境可用。

**LangGraph 1.2.x 官方能力核实（官方文档原文依据）**：

| 能力 | 机制（核实结果） |
| --- | --- |
| 状态管理 | `StateGraph` + 类型化状态（TypedDict / dataclass / Pydantic，文档注明 Pydantic 性能较差）；per-key reducer（`Annotated`）；支持独立输入/输出 schema |
| 任务编排 | 节点/边/条件边；多出边节点在下一 superstep 并行；`Send` API 实现 map-reduce 扇出；子图（subgraph）三种持久化模式；递归上限默认 1000 |
| 持久化/检查点 | 内置 `InMemorySaver`/`MemorySaver`（内存，进程重启即丢失）；`SqliteSaver`（独立包 `langgraph-checkpoint-sqlite`，开发用文件持久化）、`PostgresSaver`（独立包，生产级）；`thread_id` 为主键；`graph.get_state()`/`get_state_history()` 支持状态检查与**时间回溯** |
| 人工审批 | 动态 `interrupt()` + `Command(resume=...)`（需 checkpointer + 同一 `thread_id`；恢复时节点从头重跑）；静态断点 `interrupt_before/after` 官方定位为**调试工具**，不推荐用于 HITL |
| 预置 Agent | `langgraph.prebuilt.create_react_agent` **在 v1 已弃用**，官方迁移到 `langchain.agents.create_agent`；`langgraph-supervisor` 是独立 PyPI 包（0.0.31），官方 README 自述「多数场景推荐直接用工具实现 supervisor 模式」 |
| 模型适配 | LangGraph 本身只依赖 `langchain-core`，不依赖完整 `langchain`；模型需单独安装集成包（如 `langchain-deepseek` 的 `ChatDeepSeek`，环境变量 `DEEPSEEK_API_KEY`）；DeepSeek-R1（`deepseek-reasoner`）不支持工具调用与结构化输出，DeepSeek-V3（`deepseek-chat`）支持 |

证据来源：LangGraph 官方文档站（graph-api / checkpointers / persistence / interrupts / use-subgraphs / migrate-langgraph-v1 等页面，已迁移至 `docs.langchain.com/oss/python/langgraph/*`）与 PyPI 元数据，调研时间为 2026-10-16（与本机 git 提交记录 `d218e1a` / `09cfaa6` / `ce98be8` 同日，依据系统时间与提交时间戳记录，非估算），逐条带原文引用（完整引用见本阶段调研报告）。

## 3. 两项技术的能力对照

| 维度 | DeepSeek Harness（本机 44.0.0 + 仓库 docs 核实） | LangGraph 1.2.15（官方文档核实） |
| --- | --- | --- |
| 多智能体编排 | Workflow 脚本：`parallel` 扇出 + `pipeline` 流水线 + 阶段进度分组；结果可 JSON Schema 校验；provider 策略为部署级配置 | 图编排：节点/边/条件边 + Send 扇出 + 子图；类型化状态 |
| 状态与持久化 | 会话级：JSONL+Zstd 持久化、崩溃恢复、turn 边界 resume/fork、`--session-id`/SDK 续跑；**无图节点级检查点/时间回溯** | 图级：线程检查点、跨进程持久化（Sqlite/Postgres）、`get_state_history` 时间回溯 |
| 人工审批 | 审批缝 `ask`/`never` 策略 + `ask_user_question`（blocking/timed）+ ACP 机器决策 | `interrupt()`/`Command(resume=)`：图执行中暂停等待外部输入；需自行实现审批 UI/落点 |
| 多模型 | agent 级 `agentOptions` 覆盖 + `llm-pi-ai`：内置 provider 目录已含 `openai`、`anthropic`、`zai`(GLM)、`moonshotai`(Kimi)、`openai-codex`、`minimax` 等，另可手写 OpenAI 兼容/自建路由（`openai-completions`/`openai-responses`/`anthropic-messages` 三协议）；无 phase 级覆盖 | 通过 langchain-* 集成包接入（需自管 API Key 与包版本） |
| 本地项目能力 | 原生：工作区、文件工具、受限 shell、沙箱分级、后台任务、Skills、记忆 | 无内置：需通过 langchain 工具自行实现文件/命令能力与安全边界 |
| 外部调用接口 | 官方：Python/TS SDK（stdio JSON-RPC，`session/prompt·resume·wait`、工作目录读写）、ACP（stdio）、`dsh headless --json/--session-id`；**无第三方 HTTP API**；SDK 为 pre-release、无版本协商/取消方法 | 标准 Python 库：进程内 import 即可编排（天然可被任何 Python 程序调用） |
| 运行时形态 | Electron 桌面应用（本机 44.0.0，nightly 通道）；仓库 pre-release 0.2.1-alpha.4，官方声明将有破坏性变更 | 纯 Python 库，`requires_python >=3.10` |

## 4. 三条候选路线

### 路线 A：只使用 DeepSeek Harness

TLA 的全部编排用 DSH 原生 Subagent + Workflow 实现；角色提示词、工作流脚本作为仓库内容维护；人工审批用 `ask_user_question` + 审批缝；多模型用 agent 级 `agentOptions` 覆盖与 `llm-pi-ai` 适配器；长任务续跑用会话 resume/fork + Goal 机制。

### 路线 B：LangGraph 编排 + DSH 执行

LangGraph 定义图（状态、检查点、HITL），图中节点通过**官方 Python SDK**（`deepseek-harness-sdk` 子进程 stdio JSON-RPC：`session/prompt` → `session/wait` → `session/resume`、`session/working-directory/set`）或 `dsh headless --session-id` 调用 DSH 执行具体 Agent 任务；DSH 承担「模型 + 工具 + 沙箱 + 审批」，LangGraph 承担「图级状态 + 检查点 + 时间回溯 + HITL 编排」。

### 路线 C：以 LangGraph 为主要执行框架，按需使用 DSH

TLA 本体是一个 LangGraph Python 应用（自接 langchain-deepseek 等模型包、自建工具与安全边界），仅在个别场景（如需 DSH 特有技能）按需经 SDK/headless 调用 DSH。

### 五维对比

| 维度 | A（DSH 原生） | B（LangGraph 编排 + DSH 执行） | C（LangGraph 为主） |
| --- | --- | --- | --- |
| 开发复杂度 | **低**：零新依赖，直接使用宿主工具；仓库只维护提示词与工作流脚本 | **中**：官方 Python SDK 已把桥接从「解析 CLI 输出」降为「JSON-RPC 调用」，但仍需建 Python 编排层 + 子进程生命周期管理（无取消方法，放弃轮次=杀进程） | **中高**：需自接模型包、自管 API Key、自建文件/命令工具与安全边界 |
| 维护成本 | **低**：单一运行时；但需跟随 DSH 版本变化（nightly + 官方 pre-release 均声明破坏性变更，里程碑需锁版本复验） | **高**：Electron 应用与 Python 环境双栈维护；SDK pre-release 无版本协商，桥接层需容忍协议漂移 | **高**：自建能力随 LangChain/LangGraph 版本迁移（v1 已现 create_react_agent 弃用）；DSH 沦为辅助 |
| 扩展能力 | 中：Workflow 扇出/流水线/agent 级多模型已覆盖 V0.1–V0.2 需求；会话 resume/fork 覆盖断点续跑；但无图级检查点与时间回溯 | **高**：LangGraph 完整图能力（检查点、HITL、时间回溯）+ DSH 的执行/沙箱/审批；DSH 会话 resume 与 LangGraph 检查点可双层互补 | 高：LangGraph 生态完整；但工作区/沙箱/审批需自建 |
| 稳定性 | 中高：宿主平台即开发环境，能力有第一手工具清单背书；版本漂移是唯一变量 | 中：LangGraph 1.2.x 稳定；DSH SDK 为 pre-release（协议 0.0.1、无取消/会话关闭），属官方但尚不成熟 | 中：LangGraph 1.2.x 成熟稳定；自建部分引入新 bug 面 |
| 功能重复程度 | **零重复**：全部复用宿主能力 | 低：图状态/检查点/HITL 由 LangGraph 承担，与 DSH 的会话持久化/审批缝职责可划清 | **高**：沙箱、审批、工具、记忆全部与 DSH 重复实现 |

### 路线评述

- **A** 是「宿主原生路线」：成本最低、零重复，与项目原则一致；短板是图节点级的检查点与时间回溯缺失，只能以会话 resume/fork + Goal 机制近似。
- **B** 是「互补路线」：能力上最完整，且官方 Python SDK 的存在使桥接有文档化支撑（无需解析 CLI 输出）；代价是双栈维护 + DSH SDK 的 pre-release 风险（无版本协商、无取消方法、无会话关闭）。LangGraph 侧 HITL（interrupt/resume）与 DSH 审批缝存在重叠，需要明确单一职责。
- **C** 是「另起炉灶路线」：把 DSH 已提供的安全边界、审批、工作区能力全部重做一遍，重复度最高；仅在「完全脱离 DSH 宿主」成为硬需求时才值得考虑。

## 5. 推荐路线与决策记录

**V0.1（含 V0.2 初期）：路线 A — 只使用 DeepSeek Harness。**（2026-10-16 架构审核正式确认）

> **审核结论（有条件通过，2026-10-16）**：正式确认以 DSH 原生 Subagent、Workflow 与模型适配机制作为 V0.1 核心；**LangGraph 暂不参与实际运行**，仅保留为未来可选的高级编排层（即本文件路线 B 的定位，保持未启用状态；未经启用条件逐项验证与人工批准不得引入）。审核附带条件已落地到本文件与 `docs/ROADMAP.md`：缩小首个 MVP 到三个真实 Agent、明确审批三层区分与拒绝审批测试、新增 Codex/ChatGPT Plus 兼容性验证项、澄清 Workflow 执行语义、修正验证日期。

理由：

1. 与本轮约束一致：不安装新依赖、优先官方现有能力、不重复造轮子。
2. V0.1 的验收目标（多角色协作、一次人工审批生效、零敏感信息提交）用 DSH 原生 Subagent + Workflow + 审批缝即可完整覆盖，无需引入第二运行时。
3. 多模型分工目标（V0.2）可由 agent 级 `agentOptions` 覆盖 + `llm-pi-ai` 适配器原生实现；官方已证实**无 phase 级覆盖**，多模型方案须按 agent 粒度设计（V0.2 实测）。
4. 长任务断点续跑可由 DSH 会话 resume/fork 原生覆盖，LangGraph 的独有优势收敛为「图节点级检查点 + 时间回溯 + 图内 HITL」。
5. 历史 LangGraph 环境虽有可用基础（1.2.15 + 可导入验证），但模型包与持久化包均未安装；「已有 LangGraph」本身不构成采用理由（决策原则：不为已有而用）。
6. 路线 B 的桥接虽有官方 Python SDK 支撑，但 SDK 为 pre-release（无版本协商/取消/会话关闭）且本机 profile 未初始化、未实测；不足以支撑 V0.1 落地。路线 C 重复度最高，与项目原则冲突。

**路线 B 的启用条件（写入 V0.2 验收门，见 `docs/ROADMAP.md`）**：当且仅当出现「需要图节点级检查点/时间回溯/图内 HITL，且 DSH 会话 resume/fork + Goal 机制实测无法满足」时，先做最小桥接 spike 验证以下事实，全部通过才允许进入主流程：

1. 本机初始化 `sdk`/`headless` profile，Python SDK 子进程启动成功（显式指定 Harness home，验证其"不静默读 ~/.dsh"的契约）；
2. `session/prompt` → `session/wait` → `session/resume` 全链路往返，含 `session/working-directory/set` 指定工作区；
3. 单次调用启动开销实测可接受（Electron/Node 子进程冷启动成本需量化）；
4. LangGraph 侧安装 sqlite checkpointer（`langgraph-checkpoint-sqlite`）并验证 interrupt/resume 全链路；
5. 若需无人值守审批回传：验证 `dsh acp` 的权限应答通道。

**路线 C 否决**：除非未来出现「必须脱离 DSH 宿主运行」的硬需求，否则不采用；其自建沙箱/审批/工具与项目「不重复实现」原则直接冲突。

## 6. 目标架构视图（V0.1，路线 A）

```text
┌────────────────────────────────────────────────────────────────────────────┐
│  Goal（跨轮次持久目标，人工可 pause/resume）                               │
│   │                                                                        │
│   ▼                                                                        │
│  Workflow（JS 编排脚本，仓库维护）                                         │
│   ├─ phase: requirement   Requirement Agent（整理需求与验收标准）          │
│   ├─ phase: coding        Coding Agent（实现小型 Python 功能）             │
│   ├─ phase: review        Review Agent（独立检查实现是否符合需求）         │
│   ├─ 自动验证：普通测试脚本（V0.1 首个 MVP 不设独立测试 Agent）            │
│   └─ 人工审批关卡：审批缝 / ask_user_question（合并、推送、装依赖等）      │
│                                                                            │
│  说明：phase 标签仅用于进度展示，不产生执行依赖；Agent 的执行顺序与结果    │
│        传递由 Workflow 脚本的实际编排逻辑保证。                            │
│  后续扩展（非首次运行前提）：加入 discussion、testing → 五角色流水线       │
│                                                                            │
│  基础设施：文件沙箱（workspace-write / 审批升级）· Skills · Hindsight 记忆 │
│            · 会话持久化（JSONL+Zstd，resume/fork 续跑）                    │
└────────────────────────────────────────────────────────────────────────────┘
```

**首个 MVP 范围（2026-10-16 审核确认）**：

- **三个真实、独立的 Agent**（不是模拟角色文字）：`Requirement Agent` 整理需求与验收标准；`Coding Agent` 接收需求并实现小型 Python 功能；`Review Agent` 独立检查实现是否符合需求。
- 自动验证允许使用**普通测试脚本**；独立的测试（testing）角色属 V0.1 后续扩展，不是首次运行成功的前提。
- MVP 成功的判据是**可核验的产物**：三个 Agent 的实际执行记录、任务输入输出、代码产物、测试结果与审核结论；**不接受仅模拟角色文字的演示**。
- 五角色完整流水线（需求 → 讨论 → 编码 → 审核 → 测试）仍为 V0.1 扩展目标，不取消，但不作为首次运行成功的前提。

仓库侧只维护：角色提示词（`agents/`）、工作流脚本（`workflows/`）、证据目录排他认领等门禁小工具（`tools/`）、测试与文档。不包含任何自研编排运行时。

**编排层门禁（V0.1 已实现，证据驱动）**：编排脚本自己持有成功判定，不依赖任何角色的自述——需求合并（验收 ID 唯一性、需求自检冲突）、阶段报告冲突优先停跑、
Coding 自述的**内部一致性**（命令 / 退出码 / `test_succeeded` / 输出摘录四者自洽）、Verifier 与 Review 的独立复跑是否真实执行（用例数 > 0 且两侧一致）、
文件指纹**恰好覆盖**配置的交付文件（缺项、无关文件、重复路径一律拒绝）、预检 fail-closed（真实路径必须在仓库内、无链接逃逸、路径无未规范化点段、
解析路径与配置目标一一对应、预检自报的认领前状态必须与认领工具实测的 `evidence_dir_state_before` 一致且只接受"尚不存在/空目录"、`problems` 必须为空）、证据目录由 `tools/claim_evidence_dir.py` 以 `O_EXCL` **排他认领**（已有认领不得覆写）、
时间戳必须是合法日历时间且落在"编排层实际时间"附近的运行窗口内——**启动时钟与阶段检查时钟分开**：`runStartedAt` 只与脚本启动时刻比较，
每个 Agent 返回后都重新读取当前时间，用它判断该阶段的时间戳是否"来自未来"；**运行期写入边界按全运行账本判定**：编排层在启动任何子代理之前先采集
`cacheBaseline`（必填参数），Coding / Verifier / Review 各自交回执行前后清单，**Review 自报的清单就是本轮最后一个观测点**，
相邻两点之间出现新增 / 重写 / 删除都拒绝（`BYTECODE_CACHE_CHANGED_ACROSS_RUN`），"两个验证阶段各自前后不变"只是必要条件；
"重写"按内容身份（`bytes` + `sha256`）判定，`mtime_ms` 允许 5 毫秒的表示精度差（同一文件被不同 Agent 报成整数毫秒与浮点毫秒）。
**证明边界**：容差只吸收表示差，不构成"内容相同即没写过"——把内容改回原样且 mtime 变化不超过 5 毫秒的写入不可观测，
Review 返回之后的写入也不在门禁内，由运行结束后的确定性工具 `tests/collect-cache-state.py` 事后补采（0 次模型调用、不参与判定），
返回值 `finalDecision.cacheCoverage` 原样写出这段未观测窗口。**子代理调用预算**：`task.maxAgentCalls`（默认 8、范围 1–32）在每次调用**启动前**检查，
到上限即返回 `AGENT_CALL_BUDGET_EXCEEDED`、账本里留下 `started: false` 的那一项；原先每轮额外启动的只读 `Cache Collector` 阶段
已删除（它是调用超限的直接原因），改用上述确定性工具。注意能力边界：**调用次数可以硬限制，单个子代理内部的 token 消耗无法由编排层硬限制**。
任一条不满足即返回明确状态码、不以 `ok: true` 收场
（完整状态码表见 `workflows/README.md`，回归测试与认领集成测试见 `tests/`）。

## 7. 风险与未验证项（跟踪清单）

| # | 事项 | 状态 | 影响 |
| --- | --- | --- | --- |
| 1 | 本机 `sdk`/`headless` profile 未初始化（沙箱外写 ~/.dsh 曾报 EPERM）；Python SDK/`dsh headless --session-id` 会话续跑**文档已核实、本机未实测** | 待 spike（V0.2 验证门） | 路线 B 可行性 |
| 2 | DSH nightly 通道 + 仓库 pre-release 双线均声明破坏性变更 | 每个里程碑锁版本复验 | 工作流脚本兼容性 |
| 3 | agent 级 `agentOptions` 覆盖在本机是否可指定第三方模型（本机 `~/.dsh` 无 `llm-pi-ai` 目录与凭据，即未配置任何第三方 provider；亦无实测）。官方已证实 Workflow **无 phase 级** provider/model 覆盖，故多模型分配只能按 agent 级机制设计 | 未验证（V0.2 实测） | V0.2 多模型分工 |
| 4 | 官方 docs 未逐页核实项：`llm-streaming.md` 适配器契约细节（message/block 类型、StreamChunk 协议、适配器接口签名）、`tool-catalog.md` 全量工具编目 | 官方文档核实不足（包级 README 已覆盖主要 schema） | 能力盘点完整性 |
| 5 | DSH SDK 官方限制：无协议版本协商（`serverInfo.version 0.0.1` 不校验）、无取消/会话关闭方法、服务端→客户端请求为 dead capability | 已核实为官方设计现状 | 外部集成稳定性与轮次放弃方式 |
| 6 | 无第三方 HTTP API（已核实否定）；客户端插件 boot 注入的 `window.__DSH_BOOT__` 字面量未在文档出现（需读源码确认） | 已核实/未确认 | 外部集成方式与客户端插件开发 |
| 7 | 本机安装版 `44.0.0` 与仓库 `0.2.1-alpha.4` 的版本体系对应关系 | 未核实 | 官方文档证据与本机行为的映射 |
| 8 | 历史 venv 中 `langgraph-sdk 0.4.7` 指向的 LangGraph Platform 服务能力 | 未验证 | 远期可选：DSH 外的托管方案 |
| 9 | pi-ai 内置 provider 目录的**完整**清单（已证实含 `zai`=GLM、`moonshotai`=Kimi、`openai-codex`、`minimax`、`bailian`、`qwen-token-plan` 等；`provider-data.generated.ts` 全文未取到，仅有目录清单与字符串采集）；**未证实**存在 `zhipu`/`stepfun`/`baichuan`/`siliconflow`/独立 `qwen` 的 provider id | 部分核实（本轮取证；关键结论有用户指南原文背书） | 第三方模型可选范围 |
| 10 | Codex 是否有比 `packages/subagent/subagent-codex/README.md` 更完整的专题接入文档（`docs/subsystems/README.md` 索引全文未核验）；`codex` 是否作为 wire protocol 存在于 hand-declared `api` 取值中 | 未核实 | Codex 接入方式 |
| 11 | 审批强制拦截的实际覆盖范围未验证：提示词与 Agent 自觉只是软约束，宿主沙箱/审批策略究竟覆盖哪些危险操作，需以拒绝审批负面测试逐项确认 | 未验证（V0.1 拒绝审批测试） | 「危险操作被拦截」的可信度 |
| 12 | ChatGPT Plus 订阅经官方 `openai-codex` OAuth 或 `subagent-codex` 在 DSH 内委派 Codex 任务的实际可用性（须区分订阅权益与独立 API 计费；不承诺模型可用性与额度） | 未验证（V0.2 独立验收项） | Codex 委派可行性 |
| 13 | `workflow` 工具的返回值会被宿主截断（run 5 实测：约 1.5 万字符未到达调用方），因此长返回值**不能**直接当作逐字证据；且 workflow 内部的子代理会话不出现在调用会话的 `list_agents` 树中，无法从返回值取得会话 id | 已实测（工具侧限制，工作区按实测设计证据方式） | 编排层取证方式：返回值须落盘并显式标注截断/推导部分，原生执行证据改用 DSH 会话日志按「父会话 + 时间窗」筛选 |
