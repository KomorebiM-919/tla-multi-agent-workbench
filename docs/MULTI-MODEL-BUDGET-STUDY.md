# 多模型分工与预算：候选产品需求 + 技术可行性研究

状态：**研究稿（未实现、未排期）**。本文件只回答两件事：

1. 如果要把"多模型分工"和"运行预算"做成本项目的产品能力，需求应该怎么写；
2. 按本机 + 官方接口的现状，每条需求是"现在就能做"、"要先有官方接口"还是"还没核实"。

它**不包含**任何实现、不新增依赖、不接第三方账号、不产生真实付费，也不改变 V0.1 的验收口径。
文中所有"能做到"的判断都附了证据位置；没有证据的地方明确写成"尚未核实"，不写成"应该可以"。

---

## 1. 结论摘要

| 类别 | 条数 | 含义 |
| --- | --- | --- |
| A. 可直接实现 | 10 | 只用现有宿主日志、现有编排脚本、标准库即可完成，不需要新接口、不需要新依赖 |
| B. 依赖官方接口 | 3 | 需要宿主提供的能力（或需要先实测确认某个已文档化接口在本 build 真的生效）；本轮不得声称已支持 |
| C. 尚未核实（疑点，不是需求条） | 5 | 缺证据（价格口径、跨 provider 字段一致性、事件语义等），只能先观测、不能先承诺 |

一句话结论：**"观测型预算"（事后算出每次运行花了多少 token、每个阶段谁花的）今天就能做，
因为用量已经原生记录在日志里；"强制型预算"（跑到一半超限就停）没有已核实的接口，现在做不了。**
多模型分工的方向是 agent 级覆盖（`agentOptions`），不是 phase 级——后者官方明确不支持。

---

## 2. 候选产品需求（建议下一版需求稿的 R-M 条款）

编号用 `R-M`（model/budget）以免与 V0.1 的 `R-01`–`R-37` 混淆。每条给出验收口径，
验收口径都指向"可被证据文件验证"，不指向"代理自己说"。

| 编号 | 需求 | 验收口径 | 类别 |
| --- | --- | --- | --- |
| R-M01 | 运行记录必须记录**每次代理调用实际使用的模型**（provider / model / contextWindow），来源为宿主原生日志，不接受代理自述 | 运行记录的 `native-events.json` 中每个 `agentCalls[]` 都有 `model` 三元组，且与日志原文一致 | A |
| R-M02 | 运行结束必须输出**按阶段与代理拆分的用量表**，字段至少含 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens`，并写明每个字段的定义 | 用量表可被 `review-run-evidence.py` 逐项比对；缺任一阶段即 FAIL | A |
| R-M03 | 用量必须**可复算**：给定 runId 与日志目录，一条命令重建同一张表 | 重建结果与原归档逐字节一致（sha256 相等）；不可复算即视为证据不合格 | A |
| R-M04 | 预算以**观测预算**表达：运行配置声明"本次运行 token 上限"，运行结束给出 `WITHIN_BUDGET` / `OVER_BUDGET` 判定 | 判定结果写入运行记录；判定不使用代理自述数字 | A |
| R-M05 | 预算**强制中止**：达到上限后停止后续阶段 | 需要宿主在每次模型调用前提供预算钩子；本轮无法验收 | B |
| R-M06 | 每个阶段的**期望模型**必须在运行配置中声明，运行后与实测比对 | 不一致时给出 `MODEL_MISMATCH` 并列入运行记录；一致时逐阶段列出比对结果 | A |
| R-M07 | 模型必须来自**显式白名单**，且**不得静默回退**到未声明模型 | 白名单外的模型出现在实测结果中即 `MODEL_NOT_ALLOWED`；回退视为不一致而非"自动纠正" | A |
| R-M08 | 第三方模型接入只能在**人工批准后**配置，凭据必须经 `apiKeyEnv` 之类引用，不得明文落盘 | 配置检查项 + 仓库敏感信息扫描双重把关 | B |
| R-M09 | 成本（货币）**只在有官方价格来源时**输出；无价格来源时显示"未提供价格" | 记录中不得出现推测价格；有价格时必须注明来源与版本 | A（降级形态）/ C（真实价格） |
| R-M10 | 用量与配额信息不得把账号标识写进交付仓库 | 归档文件对账号标识零命中（与现有脱敏规则同一条扫描） | A |
| R-M11 | 多模型分工**不得破坏可复现性**：同一 runId 下每个阶段的模型必须固定记录在运行记录里 | 重跑同一脚本、同一配置，阶段-模型映射完全相同 | A |
| R-M12 | 预算相关失败必须与**质量失败**区分开 | 返回状态区分 `OVER_BUDGET` 与 `MAX_ATTEMPTS_*` / `BYTECODE_*` 等原因，不得合并成一个布尔 | A |
| R-M13 | 第三方模型的 contextWindow / reasoningEffort 映射必须显式声明，不依赖目录默认值 | 配置中每个模型都写 contextWindow；缺省即配置错误 | B |

---

## 3. 现有可用面（已核实的部分）

### 3.1 模型选取：agent 级，不是 phase 级

- 官方接口面：`SubagentStartRequest.agentOptions` 支持 per-agent 的 provider / model / reasoning-effort / output-token 覆盖；
  适配器 `llm-pi-ai` 以 `providers` 字典做路由，请求用 `GenerateOptions.provider` 选路。
  证据：`docs/ARCHITECTURE.md` 的多模型适配行与其下 §2 的 provider 章节（2026-10-16 核实的官方原文）。
- 同文件明确记录了一条**限制**：Workflow "policy is fixed per tool registration"，**没有 phase 级 provider/model 覆盖**；
  `phase()` 只是进度词汇，不构成执行结构。所以多模型分配只能按 agent 级设计。
- 本 build 的 `workflow` 工具说明里，`agent(prompt, opts)` 接受独立的 `provider` / `model` 覆盖，
  `meta.phases` 也有可选的 provider/model 字段。**这两者的语义尚未实测**（见 C 类清单），
  尤其 `meta.phases` 的字段可能只是展示元数据——官方文档说策略按工具注册固定，两者存在张力，必须实测再依赖。

### 3.2 本机现状：只有一种模型口径

- 本机 `~/.dsh` 没有 `llm-pi-ai` 目录与第三方 provider 凭据（`docs/ARCHITECTURE.md` §7 第 3 条，状态"未验证（V0.2 实测）"）。
- 本次真实运行 `v0.2-run2-20261017T133204Z` 的 10 次代理调用**全部**是
  `provider: deepseek-account` / `model: deepseek-flash` / `contextWindow: 1000000`
  （`docs/run-records/v0.2-run2-20261017T133204Z/native-events.json`）。
  这意味着：多模型相关的"跨 provider 差异"在本机**没有任何可验证样本**。

### 3.3 用量已经原生记录（本轮实测结论）

宿主会话日志里有 `assistant/message` 记录，其 `data.usage` 带
`inputTokens` / `outputTokens` / `totalTokens` / `cacheReadTokens` / `cacheWriteTokens`。
本轮对 61 个会话日志做了只读汇总，验证了三件事：

1. 每个子代理会话都有自己的日志文件，`native-events.json` 的 `childSessionId` 能一一对上；
2. 带 `usage` 的记录数 = 助手消息数（run2 的 10 个子会话：184 条消息、184 条带 usage，**没有缺失**）；
3. 汇总后能得出每个阶段的用量，且 `totalTokens ≈ inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`。

run2 的实测用量（只统计 10 个子代理会话，不含父会话）：

| seq | 阶段 | 代理 | 消息数 | input | output | cacheRead | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | preflight | Verifier (preflight) | 8 | 10 130 | 6 432 | 160 384 | 176 946 |
| 2 | requirement | Requirement Agent | 25 | 26 727 | 48 739 | 1 233 024 | 1 308 490 |
| 3 | coding | Coding Agent | 27 | 126 118 | 50 717 | 1 593 088 | 1 769 923 |
| 4 | verify | Verifier (verify) | 13 | 18 313 | 6 810 | 307 456 | 332 579 |
| 5 | review | Review Agent | 20 | 55 911 | 35 737 | 1 172 864 | 1 264 512 |
| 6 | cache | Cache Collector | 21 | 20 706 | 6 983 | 532 480 | 560 169 |
| 7 | coding-revision-2 | Coding Agent (revision 2) | 23 | 59 593 | 32 961 | 1 193 984 | 1 286 538 |
| 8 | verify-revision-2 | Verifier (verify) (revision 2) | 15 | 42 651 | 10 698 | 614 400 | 667 749 |
| 9 | review-revision-2 | Review Agent (revision 2) | 18 | 47 773 | 34 708 | 1 038 208 | 1 120 689 |
| 10 | cache-revision-2 | Cache Collector (revision 2) | 14 | 7 742 | 6 482 | 271 872 | 286 096 |
| — | **合计** | 10 个子代理 | **184** | **415 664** | **240 267** | **8 117 760** | **8 773 691** |

口径说明（写进 R-M02 的字段定义里）：

- `totalTokens` 是**请求级累计**，不是"账单"：同一段上下文会在多个请求里重复计入，缓存命中部分也不同计费；
- `cacheWriteTokens` 在本机恒为 0，因此**不能**据此断言"没有缓存写入"，只能说"该 provider 不上报这个字段"；
- 父会话累计（本次统计到 3 064 条助手消息、约 3.0 亿 total）包含研究工作本身的全部对话，**不是**一次运行的用量，
  运行级数字必须按 runId 的子会话集合聚合，不能拿父会话数字充数。

### 3.4 为什么"观测型"能现在做、"强制型"不能

- 观测型只依赖**已经落盘的日志**：读日志 → 按 `childSessionId` 聚合 → 与运行记录比对。
  全流程只用标准库与既有脚本，没有新接口。
- 强制型需要**在每次模型调用之前**知道"已经花了多少、还差多少"，并让宿主据此拒绝下一次调用。
  现有可核实的接口里没有这个钩子：Goal 的 `max_goal_rounds` 限制的是"轮次"，不是 token；
  Workflow 没有 per-phase 预算参数；沙箱与审批策略都不涉及用量。
  所以 R-M05 只能等官方接口，不能靠"记录 + 事后告警"冒充。

---

## 4. 三类清单

### A. 可直接实现（10 条）

R-M01 / R-M02 / R-M03 / R-M04（观测判定，不中止）/ R-M06 / R-M07（声明 + 事后比对）/ R-M09（降级形态：显示"未提供价格"）/ R-M10 / R-M11 / R-M12。

支撑事实：用量与模型字段已原生记录（§3.3）；比对与归档能力已在
`tests/extract-native-events.mjs`、`tests/review-run-evidence.py` 中存在同类实现；
运行状态已有"可区分原因"的先例（`BYTECODE_*` 与 `MAX_ATTEMPTS_*` 就是分开的）。

代价估计（只算工作量性质，不算工期承诺）：把 §3.3 的只读汇总固化成 `tests/extract-usage-report.mjs`
（与现有提取脚本同构），再加 2–3 条复核检查、1 组夹具，属于"一天量级"的增量，不涉及新依赖。

### B. 依赖官方接口（3 条）

| 编号 | 依赖什么 | 现状 |
| --- | --- | --- |
| R-M05 | 模型调用前的预算钩子（或官方预算/配额能力） | 无已核实接口；Goal 的轮次上限不等价 |
| R-M08 | `llm-pi-ai` 的 provider 配置 + `apiKeyEnv` 凭据引用 + 人工批准 | 接口在官方文档中已核实，但本机未配置、且接入属"人工审批"范围（AGENTS.md §9） |
| R-M13 | 第三方模型的 contextWindow / reasoningEfforts 目录数据 | 目录存在（含 `openai`/`anthropic`/`zai`/`moonshotai` 等 id），但本机无样本；且官方说明目录数据可能被 `models`/`modelOverrides` 整体替换 |

补充：`agent()` 的 `provider` / `model` 覆盖**在本 build 的工具说明里存在**，但官方 Workflow 文档说策略"按工具注册固定"。
这两句话不冲突（一个是工具入参，一个是策略层），但**本机没有实测过一次跨 provider 调用**，
所以把它放进 B 类而不是 A 类：需要先花一次极小调用验证"传了 model 真的按传的跑"，再谈分工。

### C. 尚未核实（5 条）

1. **货币价格与计费口径**：日志里没有价格字段，也没有 provider 侧的账单数据；不同 provider 的缓存计价规则不同。
   任何"这次花了多少钱"的输出都必须等官方或 provider 的权威口径。
2. **跨 provider 的 usage 字段一致性**：本机只有 `deepseek-account` 一种口径；`cacheWriteTokens` 恒 0 说明字段存在不等于语义一致。
3. **`meta.phases` 的 provider/model 字段语义**：可能是纯展示；在实测前不得据此声明"支持按阶段选模型"。
4. **`model/selection` 事件的语义**：日志里有 5 条该类型记录，但字段含义（是"用户选了模型"还是"运行时解析结果"）未核实。
5. **父会话与子会话的用量边界**：子代理会话是否会把父会话的上下文重复计入、压缩（compaction）产生的用量记在哪个会话，
   目前只有"总数对得上"的弱证据，没有逐请求对账。

---

## 5. 建议的最小落地顺序

1. **先固化观测**：把 §3.3 的汇总做成可复算脚本，并加进复核套件（对应 R-M01/R-M02/R-M03）。
2. **再声明期望**：运行配置里写"每阶段期望模型 + 白名单"，运行后比对（R-M06/R-M07）。
3. **然后才有预算**：以观测值为基础设上限，先只做 `WITHIN_BUDGET` / `OVER_BUDGET` 判定（R-M04/R-M12）。
4. **最后才谈跨模型**：等第 1 步能稳定给出"每个阶段用了什么模型、花了多少"，再拿一次极小调用验证 agent 级覆盖，
   之后再谈把某阶段换到别的 provider。第三方接入必须单独走人工批准，不能混在功能提交里。

反过来做（先接第三方模型、再补用量观测）会得到一个无法验收的状态：既证明不了"分工生效"，
也证明不了"预算没超"。

---

## 6. 边界与不做什么

- 本文件不新增依赖、不读取任何凭据、不产生真实付费调用；第 3.3 节的数据来自**已发生的** run2 日志，只读。
- 不提议把第三方模型的密钥写进仓库；`apiKeyEnv` 是凭据引用，真实值由宿主凭据库提供。
- 不改变 V0.1 验收口径：多模型与预算属于 V0.2 之后的候选能力，当前状态是"研究完成、实现未开始"。
- 不承诺工期；"一天量级"只描述改动形态（新增一个提取脚本 + 几条检查 + 夹具），不是排期。

---

## 7. 证据位置与复算方法

| 结论 | 证据 |
| --- | --- |
| agent 级覆盖存在、无 phase 级覆盖 | `docs/ARCHITECTURE.md` 的多模型适配行、Workflow 行，及其 §2 provider 章节 |
| 本机无第三方 provider 凭据 | `docs/ARCHITECTURE.md` §7 第 3 条（状态：未验证（V0.2 实测）） |
| run2 全部调用为 `deepseek-account`/`deepseek-flash`/1M | `docs/run-records/v0.2-run2-20261017T133204Z/native-events.json` 的 `agentCalls[].model` |
| 用量字段与逐代理汇总 | 只读扫描 `$env:DSH_HOME/sessions/**/session.v4.jsonl.zstd`，按 `session` 头取 id、按 `assistant/message` 的 `data.usage` 求和；61 个会话文件、184 条子代理消息全部带 usage |
| 无价格字段 | 同上扫描中"usage-like"字段只有 token 计数，无 price/cost/billing 字段 |

复算命令（不落盘、不改仓库；`DSH_HOME` 指向本机会话日志根目录）：

```powershell
node tests/.scratch/unattended/sum-run2-tokens.mjs
```

> 该脚本目前只是取证草稿（放在被 gitignore 的 `tests/.scratch/`），第 5 节第 1 步才是把它产品化。
