# 发布前整理（V0.1 演示功能）— 离线检查与 PR 文稿

本文件是**发布前整理**的离线产物：只读检查本地 Git 对象、整理待推送提交（截至 `[C42]` 为 42 个）相对草稿 PR #2 原版本的变化、准备可直接使用的 PR 文稿、报告安全与敏感性检查结果、分类后续候选任务，并给出发布前结论。

**本轮不联网观测远端、不 push、不修改 PR 内容、不合并、不调用模型、不安装依赖、不清理历史文件。** 文中所有"远端"结论都来自本地跟踪引用的最后已知值，**不是实时远端观测**。

---

## 1. Git 事实（读取时间：本轮整理时）

| 项目 | 值 |
| --- | --- |
| `HEAD` | `[C42]`（本轮整理动作开始时的提交；本文件连同计数修正构成紧随其后的第 43 个提交） |
| 分支 | `feat/v0.1-three-agent-mvp` |
| 上游跟踪引用 | `origin/feat/v0.1-three-agent-mvp` = `029bdcc72543dbc2b10fb5195aae976ecad479a1`（`test(claim) …`，提交时间 2026-10-17T01:55:11+08:00） |
| 该跟踪引用的本地更新时间 | 2026-10-17 02:06:54 +0800（reflog 记录的一次 push） |
| 相对跟踪引用 | 截至 `[C42]`：**落后 0 / 领先 42**；本文件提交后：**落后 0 / 领先 43**（`git rev-list --left-right --count '@{u}...HEAD'`） |
| 工作区 | 仅 6 项运行前既有的未跟踪文件（`docs/evidence/v0.1-approval-rejection-20261017T112518Z/` 下 5 个 + `docs/review/`），无已跟踪改动 |
| 范围规模 | 截至 `[C42]`：`205 files changed, 51508 insertions(+), 716 deletions(-)`；含本轮文档提交：`206 files changed, 51774 insertions(+), 716 deletions(-)` |
| HEAD 树 | 274 个文件 / 4.27 MB（截至 `[C42]`），最大文件 0.27 MB（`docs/evidence/v0.1-second-run/commit-5034985.diff`） |
| 远端 URL | `https://github.com/KomorebiM-919/tla-multi-agent-workbench`（无凭据、无 token 前缀） |

**跟踪引用的语义边界**：`029bdcc` 是本地最后一次 push 后记录的值；本轮没有联网，因此**无法证明**远端此刻仍停在该提交（例如被他人推送、或 PR #2 已被修改）。push 前如需确定性，需要一次真实的远端观测。

---

## 2. 42 个提交（截至 `[C42]`）相对 PR #2 原版本的主要变化（按主题，不逐条堆砌）

PR #2 原版本停在 `029bdcc`（三 Agent MVP 的早期形态）。这 42 个提交把仓库推进到"五阶段流水线 + 真实运行证据 + 可复算验收材料"。按主题分六组：

### 2.1 演示交付功能（`examples/text-stats/`）

- 交付物最终形态：329 行实现 + 97 个单元测试 + README + 样例输入，仅标准库。
- 关键行为收敛：程序化调用（显式 `stdin_text`）在成功、`--help`、五类受控错误下**双流皆空**；命令行侧保持"成功 4 行 / `--help` 用法 / 错误一行 `error: `"；退出码只有 0/1（argparse 的 2 被收敛成 1）；`--encoding` 校验先于输入选择；CRLF/CR 归一化与 BOM 剥离有明确口径。
- 对应提交：`[C14]`（程序化静默）、`[C05]`（样本行尾固定 + 有界性质测试）、`[C17]`（run1 交付）、`[C39]`（run5 交付，当前 HEAD 采用版本）。

### 2.2 工作流加固（`workflows/three-agent-mvp.js`）

- 成功判定：`ok: true` 需要「编码自述通过 ∧ Verifier 独立复跑通过 ∧ Review `APPROVED` 且自测通过 ∧ 验收条件按 ID 全覆盖且逐条满足 ∧ 需求自检无冲突」，自述与独立验证矛盾 ⇒ `INCONSISTENT_EVIDENCE`。
- 失败门禁（按设计拦下过真实运行）：`REQUIREMENT_CONFLICT`、`STAGE_REPORTS_REQUIREMENT_CONFLICT`、`REQUIREMENT_IDS_INVALID`、`CRITERIA_CHECK_INCOMPLETE`/`_DUPLICATE_IDS`/`_UNKNOWN_IDS`、`ARTIFACT_FINGERPRINT_MISMATCH`、`TARGET_DIR_OUTSIDE_REPO`、`LINK_ESCAPE`、`EVIDENCE_NOT_CLAIMED`、`BYTECODE_CACHE_WRITTEN`/`BYTECODE_ENV_NOT_APPLIED`/`BYTECODE_SCOPE_UNMEASURED`、`BYTECODE_CACHE_CHANGED_ACROSS_RUN`、`AGENT_CALL_BUDGET_EXCEEDED`、`SCRIPT_DRIFT`。
- 运行期写入边界：Coding / Verifier / Review 的**任何** Python 调用都带 `PYTHONDONTWRITEBYTECODE=1` 前缀，各阶段交回前后 `__pycache__` 清单，编排层按**内容同一性（`bytes` + `sha256`，`mtime_ms` 容差 5 ms）**判重写。
- 调用预算：`task.maxAgentCalls`（默认 8、上限 32）在**每次调用前**记账，超限时 `agentCallBudget.calls` 留下 `started: false` 的一项，证明"第 N+1 次没有启动"。
- 内联脚本一致性：`driftHash` + `checkSelfCheck` 在启动前比对提示词与 schema 指纹，`args.selfCheckRequired: true` 时缺指纹 fail-closed；`tests/preflight-workflow-script.mjs` 在**零调用**前提下把"准备提交的载荷"与固定提交源码逐字节比较，并对全部 schema 跑宿主子集规则的本地实现。
- 证据目录排他认领：`tools/claim_evidence_dir.py` 以 `O_EXCL` 创建 `.run-owner.json`，预检必须逐字回报相对路径；run4 因此被正确中止（子代理回报绝对路径），修复后门禁接受"解算到同一文件的绝对路径"（`[C37]`）。
- 对应提交：`[C04]`、`[C21]`、`[C25]`、`[C26]`、`[C28]`、`[C30]`、`[C07]`、`[C31]`、`[C32]`、`[C37]`、`[C34]`。

### 2.3 人工审批的安全拒绝测试（V0.1 验收条件 3）

- 正式工具 `tools/approval-rejection-evidence.mjs`（`snapshot` / `verify` 子命令）与判定规则演进到 v4：校验审批事件关联与顺序、逐文件内容指纹、快照身份与时间对应、**快照 marker 与本次审批绑定**、目标约束按路径重算、内容跳过判不完整、采集区间围住审批事件、审批命令与被观察目标逐字绑定且**排他创建**、日志按 RFC 8878 帧结构切分、机器判定/人工确认/最终结论三段分离。
- 拒绝现场归档：`docs/evidence/v0.1-approval-rejection-20261017T112518Z/`（13 个文件，含**已脱敏**快照与日志）；机器判定 `PASS` + 人工确认，`verify` 退出码 0；首次缺人工观察时为 `INCOMPLETE`（退出码 3），两次记录都保留。
- 离线回归：131 断言 / 27 组场景 + 反向验证 18 组 v1→v3 与 11 组 v2→v3。
- 对应提交：`[C02]`、`[C03]`、`[C07]`、`[C08]`、`[C09]`、`[C10]`、`[C11]`。

### 2.4 真实运行与证据归档（`docs/run-records/`、`docs/evidence/`）

- run1 `v0.2-run1-20261017T121445Z`：`ok: true`，但 AC-24 的 `__pycache__` 条款实际未满足（Review 判 `satisfied: true` 被人工复审推翻，追加 `human-review-ac24.md`，原件不改）。
- run2 `v0.2-run2-20261017T133204Z`：真实写入 + mtime 精度误报 → `MAX_ATTEMPTS_BYTECODE_CACHE_CHANGED_ACROSS_RUN`；**10 次调用超过批准的 8 次**，专门写了 `budget-overrun.md`：保留原始证据、不追认预算、不以"运行没通过"免责。
- run3：在 Review 启动前被宿主拒绝第 5 次调用（`agent() schema is outside the supported subset`），根因是内联转录漏了一行 `type: 'object'`；归档 `run-aborted.md`，明确"不得称为通过"。据此新增内联脚本指纹自检。
- run4：预检子代理把 `owner_marker_path` 报成绝对路径 → `EVIDENCE_NOT_CLAIMED` 中止（门禁按设计生效），归档并给出三层根因；随后修复门禁并补 4 个单元测试。
- run5 `v0.4-run5-20261017T161034Z`：**5 个角色各 1 次调用（5/8，无派生）、97 项交付测试全绿、编排层独立复核 28/28、缓存边界 `CLEAN`、4 465 947 tokens（声明 8 000 000，`WITHIN_BUDGET`）**；三方脚本核对唯一差异是宿主去掉末尾换行（`byteDelta: -1`，属允许规则）。
- 归档可复算：`SHA256SUMS.txt`（run5 包 17 条、run5 归档 18 条）逐文件复算 0 失败；`.gitattributes` 让 `docs/evidence/**`、`docs/run-records/**` 按原文入库（`-text`），避免 `core.autocrlf=true` 破坏"同输入必得同字节"的复算链。
- 对应提交：`[C17]`、`[C18]`、`[C19]`、`[C22]`、`[C20]`、`[C33]`、`[C34]`、`[C35]`、`[C36]`、`[C38]`、`[C39]`。

### 2.5 预算与用量统计

- **观测型（已实现、可复算）**：`tests/extract-usage-report.mjs` 只读会话日志、不联网、不调模型、不读凭据；按运行/阶段/轮次/代理/provider-model 汇总原始 `usage` 字段，区分"未声明预算 / 覆盖不完整 / `WITHIN_BUDGET` / `OVER_BUDGET`"，已在 run1、run2、run5 上复算（run1 5 次 / 3 918 430 tokens；run2 10 次 / 8 773 691 tokens `OVER_BUDGET`；run5 5 次 / 4 465 947 tokens `WITHIN_BUDGET`）。
- **强制型（只做了次数）**：`task.maxAgentCalls` 是启动前的硬限制；**单代理内部 token 的硬限制没有已核实接口**，不得声称支持；货币价格在日志里没有字段，只能显示"未提供价格"。
- 对应提交：`[C28]`、`[C29]`、`[C27]`（研究稿 `docs/MULTI-MODEL-BUDGET-STUDY.md`，R-M01 – R-M13）。

### 2.6 验收结论与能力限制

- run5 离线验收包（正式位置 `docs/run-records/v0.4-run5-20261017T161034Z/review-package/`）：复核工具 **28 项检查**（含 R-35 的 README 四个示例、R-29 的 UTF-16 文件与 `PYTHONIOENCODING` 两类真实子进程探针，各带"对照组必须不同"的反证）、**19 个反例自检**、干净副本与主检出处均 28/28、交付测试 97/0/0/0、37 条需求追踪表（R-01 – R-37 逐条有依据）。
- **所有者 2026-10-18 基于审核报告确认"本轮演示功能验收通过"**（`review-package/OWNER-ACCEPTANCE.md`）：需求以 `v0.2-demo-input-3` 为准、样本不变；接受离线复算与 R-33/R-37 的历史运行证据；接受已声明能力限制且**不新增连续缓存监控要求**。该确认**不是**逐行审查、不是独立复跑，**不等于**整个多模型平台开发完成，也**不是** V0.1 五条验收条件的整体重判。
- 已声明能力限制（4 条）：缓存瞬时写入（两次采集之间的"写完又改回原样且 mtime 变化 ≤5 ms"）不可观测；`selfCheck` 只覆盖 schema 指纹、不含提示词指纹；R-33/R-37 依赖历史运行证据而非离线重放；`examples/text-stats/.test-scratch/` 的 11–12 个历史 `tmp*` 目录需所有者在本机非受限终端清理。
- 对应提交：`[C40]`、`[C41]`、`[C42]`。

---

## 3. PR 文稿（可直接使用）

> 说明：PR #2 已存在且为草稿。下面的标题与正文按"更新现有草稿 PR #2"准备；推送与修改 PR 均需所有者授权（`AGENTS.md` §9）。

### 3.1 现状：草稿 PR #2 的既有文案（本地留档，最后更新于 `029bdcc`）

| 项目 | 值 |
| --- | --- |
| base | `main` = `2f019920c8667378065fee947eeaa8636ca49bf4`（本地与跟踪引用一致） |
| head | 该文案写作时远端 head 为 `029bdcc`；本地 head 现为 `[C42]`（领先 42 个提交） |
| 标题 | `feat(v0.1) 三智能体 MVP：离线门禁回归与真实认领工具集成` |
| 正文结构 | 「这是什么 / 验证状态（81/81、372 断言、11 tests、81 tests）/ 集成测试子进程启动方式 / 关于 run 6 与证据 / 仍未完成的验收项 / 复核材料」 |
| 留档位置 | `docs/review/029bdcc/pr-draft.md`、`pr-link.md`（`docs/review/` 有意不入库） |

### 3.2 既有正文中已经过期的结论（必须更新，否则会误导复审）

| 既有表述 | 当前事实 | 依据 |
| --- | --- | --- |
| 离线门禁回归「81/81 场景、372 断言」 | **114 场景 / 547 断言** | 本轮实测 `node tests/workflow-logic.test.mjs` |
| 交付测试「Ran 81 tests」 | **Ran 97 tests** | run5 交付版本（`[C39]`） |
| 「P-1 ～ P-6 仍为未完成验收项」 | P-1 – P-6 已由所有者逐项确认，固化为 `docs/REQUIREMENT-BASELINE.md`（`v0.1-demo-baseline-1`，RB-1 – RB-6） | `[C01]` 及基线文件 |
| 「人工审批的安全拒绝测试未完成」 | **已完成一次并通过**（机器判定 `PASS` + 人工确认，`verify` 退出码 0） | `docs/evidence/v0.1-approval-rejection-20261017T112518Z/`、`[C11]` |
| 「新版真实流水线（真实子代理）端到端验证未完成」 | 已运行 run1 – run5（含 run3/run4 中止与 run2 超预算复盘），run5 **干净通过**并获所有者基于报告的验收确认 | `docs/run-records/`、`[C42]` |
| 「本 PR 不合并 `main`，也未完成 V0.1 最终验收」 | **保持有效**：`main` 未被改动（仍为 `2f01992`），V0.1 五条验收条件未被整体重判 | 见 §6 |

### 3.3 建议的标题

```
feat: five-stage agent pipeline with verifiable run evidence (demo function accepted)
```

### 3.4 建议的正文（**已过期**：以 `docs/PUBLICATION-REDACTION-PLAN-v0.1.md` §6 为准，修正了 owner-marker 门禁、schema 自检与全文本一致性、本机标识披露三处）

```markdown
## 这个 PR 做了什么

把 `feat/v0.1-three-agent-mvp` 从"三 Agent 早期形态"推进到**可复算的五阶段流水线**：预检 → Requirement → Coding → Verifier → Review，并补上真实运行证据、离线复核工具与验收材料。

范围：43 个提交，206 个文件（+51774 / −716）。

### 交付功能

- `examples/text-stats/`：仅标准库的文本统计工具（329 行实现 + 97 个单元测试 + README + 样例输入）。
- 行为口径：程序化调用（显式 `stdin_text`）在成功、`--help`、五类受控错误下双流皆空；命令行侧成功 4 行、`--help` 用法、错误一行；退出码只有 0/1；`--encoding` 校验先于输入选择；CRLF/CR 归一化与 BOM 剥离有明确规则。

### 工作流加固（每一条都有回归测试）

- 成功判定要求「自述通过 ∧ 独立复跑通过 ∧ 复审 `APPROVED` ∧ 验收条件按 ID 全覆盖 ∧ 需求自检无冲突」，自述与独立验证矛盾即 `INCONSISTENT_EVIDENCE`。
- 运行期写入边界：所有 Python 调用带 `PYTHONDONTWRITEBYTECODE=1`，各阶段交回 `__pycache__` 前后清单，按内容同一性（`bytes` + `sha256`，`mtime_ms` 容差 5 ms）判重写。
- 调用预算：`task.maxAgentCalls`（默认 8、上限 32）在调用前记账，超限时留下 `started: false` 的拒绝记录。
- 内联脚本一致性：`driftHash` 指纹自检 + 零调用预检（把准备提交的载荷与固定提交源码逐字节比较）。
- 证据目录排他认领：`O_EXCL` 创建 `.run-owner.json`，预检必须逐字回报相对路径，否则中止。

### 真实运行记录（不只有成功的那一次）

| 运行 | 结果 | 要点 |
| --- | --- | --- |
| run1 `v0.2-run1-…` | `ok: true`，但 AC-24 被人工复审推翻 | 追加 `human-review-ac24.md`，原件不改 |
| run2 `v0.2-run2-…` | 门禁拦下 | 1 条真实写入 + 4 条 mtime 精度误报；**10 次调用超批准的 8 次**，专文复盘、不追认预算 |
| run3 `v0.3-run3-…` | 宿主拒绝第 5 次调用 | 内联转录漏了一行 `type: 'object'`；归档为"中止，不得称通过" |
| run4 `v0.4-run4-…` | 预检中止 | `owner_marker_path` 被报成绝对路径 ⇒ `EVIDENCE_NOT_CLAIMED`，门禁按设计生效 |
| run5 `v0.4-run5-…` | **干净通过** | 5/8 次调用、97 项测试全绿、独立复核 28/28、缓存边界 `CLEAN`、4 465 947 tokens / 8 000 000 |

### 验收材料

- `docs/run-records/v0.4-run5-20261017T161034Z/review-package/`：复核工具 28 项检查、19 个反例自检、37 条需求追踪表（R-01 – R-37）、`OWNER-ACCEPTANCE.md`。
- 复算方式：`python docs/run-records/v0.4-run5-20261017T161034Z/review-package/verify-run5.py --self-test`、`--repo . --base [C39]^ --delivery [C39]`；包内 `SHA256SUMS.txt` 逐文件校验。

### 审批拒绝测试（V0.1 验收条件 3）

`tools/approval-rejection-evidence.mjs`（判定规则 v4）+ 拒绝现场 `docs/evidence/v0.1-approval-rejection-20261017T112518Z/`（13 个文件，**只含脱敏快照**）；机器判定 `PASS` + 人工确认。范围**仅限这一次**的 `pwsh` 沙箱升级拒绝路径，其它工具与"允许一次"路径未验证。

### 预算与用量

- 观测型：`tests/extract-usage-report.mjs` 只读会话日志，可复算、可归因，区分 `WITHIN_BUDGET` / `OVER_BUDGET`。
- 强制型：只有**调用次数**是硬限制；单代理 token 硬限制与货币价格**没有已核实接口**，不声称支持。

### 已知限制

1. 缓存瞬时写入（两次采集之间的短窗口写入）不可观测。
2. 内联脚本指纹只覆盖 schema，不覆盖提示词。
3. R-33/R-37 依赖历史运行证据，不是离线重放。
4. `examples/text-stats/.test-scratch/` 有 11–12 个历史 `tmp*` 目录，需所有者在本机非受限终端清理。
5. 本 PR **不**代表整个多模型平台完成（V0.2–V0.4 未开始），也**不**是 V0.1 五条验收条件的整体重判。

### 验收结论

**本轮演示功能（`v0.2-demo-input-3` 口径）验收通过**，由所有者基于审核报告确认（`OWNER-ACCEPTANCE.md`）。该确认不含推送、合并、清理现场或再跑真实模型的授权。

### 提交前检查

- `git check-ignore` 验证 `.gitignore` 有效；`tests/.scratch/` 未入库。
- 敏感信息扫描：无 API Key / OAuth Token / 私钥 / 凭据；无真实个人信息；原始未脱敏审批快照未入库。
- 离线测试：编排逻辑 114 场景 / 547 断言、预检载荷 9/42、用量报告 13/75、认领集成 6/59、交付测试 97、复核工具 28/28 + 19/19。
```

---

### 3.5 更新方式（二选一，需所有者决定）

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| **A. 整体替换**（推荐） | 用 3.3 的标题 + 3.4 的正文替换现有描述 | 现有正文有 5 条结论已过期，逐条改比整体替换更容易漏；替换后信息与 HEAD 一致 |
| B. 追加一节 | 保留原正文，末尾追加「## 更新（2026-10-18）：演示功能验收通过」+ 3.4 的关键段落 | 想保留"当时的状态"作为历史；代价是读者要读到末尾才知道哪些结论已过期 |

无论选哪种，都必须**保留**这两句区分：①「本轮演示功能验收通过」≠「整个多模型平台开发完成」；②「演示功能验收通过」≠「V0.1 五条验收条件整体重判通过」。3.4 的正文已包含这两句。

---

## 4. 安全检查（只读扫描本地对象）

扫描方式：遍历 `git rev-list '@{u}..HEAD'` 的 42 个提交，对每个提交 `git grep` 一批凭据/令牌/私钥模式，再对 HEAD 树做一次全量检查；脚本 `tests/.scratch/release/scan.py`（`.scratch` 已被忽略，不入库）。

| 检查项 | 结果 |
| --- | --- |
| OpenAI 风格 key（`sk-…`）、GitHub token/PAT、AWS key id、Slack token、私钥块、JWT 形态 | **0 命中**（42 个提交逐一检查） |
| `Bearer <token>`、`Authorization: <secret>`、`?token=` / `&key=` 形态 | **0 命中** |
| `api_key` / `secret` / `password` / `*_token` **赋值为长字面量** | HEAD 树 **0 命中** |
| 敏感文件名（`.env`、`credentials*`、`*.pem`/`*.key`/`*.pfx`、`id_rsa*`、`.npmrc` 等） | **0** |
| `git config --local` 的 `credential.*` / `http.*` 键 | **无** |
| 远端 URL 内嵌凭据 | **无**（`https://github.com/…`，无 `@`、无 token 前缀） |
| 邮箱类命中 | 仅 `example.com`（夹具）、`users.noreply.github.com`，以及 `@contextmanager`、`1.1.0.patch` 两处正则误报——**未发现真实邮箱**；本机账户名与本地绝对路径不属此列，见 §4.1 |
| 范围内提交作者 | 唯一：`KomorebiM-919 <329656981+KomorebiM-919@users.noreply.github.com>`（GitHub noreply 地址） |
| 本地原始审批快照 | **未入库**：HEAD 只含 `redacted/*.redacted.json`（3 个）+ 日志与清单；`approval-evidence.json` / `state-before.json` / `state-after.json` / `.acl-*.tmp` 仍是未跟踪文件，不会进入推送对象 |
| 临时材料 | HEAD 树**无** `__pycache__` / `.pyc` / `node_modules` / `.scratch` / `.venv` / `.bak` / `.orig`；唯一的 `.log` 是证据 `commands.log`；`docs/review/` 不在跟踪树中 |
| `docs/review/` 旧路径 | HEAD 中无 `docs/review/`、无 `run5-offline-acceptance` 旧路径 |

### 4.1 本地标识暴露（非凭据；处理方案见 `docs/PUBLICATION-REDACTION-PLAN-v0.1.md`）

用 `tests/.scratch/release/exposure.py` 对推送树与 HEAD 逐文件扫描（固定字符串 + 反斜杠转义/正斜杠变体）：

| 标识 | 推送树 `029bdcc` | HEAD `[C43]` |
| --- | --- | --- |
| 本机账户名（5 位数字） | **0** | 3 处 / 3 文件 |
| 本机用户主目录（两种写法） | **0** | 2 处 / 2 文件 |
| 工作区绝对路径（三种写法合计） | **0** | 125 处 / 22 文件 |
| DSH 安装目录绝对路径 | **0** | 1 处 / 1 文件（`docs/ARCHITECTURE.md:21`） |

**三个要点**：

1. 推送树（`029bdcc`，即远端当前 head）里这些值出现 **0 次**，只有 `C:\Users\<用户名>`、`C:\Users\<user>` 这类占位符；所以暴露**完全落在未推送的 43 个提交内**。
2. 因此"追加一个 HEAD 级占位符提交"**不能**清除它们：那 43 个提交仍各自保存原值，推送后 `git log -S` 可直接翻出，等于没脱敏。
3. 但重写**未推送**的 43 个提交不需要 force push，也不触碰远端历史（`029bdcc` 及其祖先不变）——因为发布分支以 `029bdcc` 为基线，push 是 fast-forward。

处理方案（推荐"无标识重放 + 快进发布"）、对证据哈希/固定提交引用/复核工具/PR 更新的影响、以及需批准的动作清单，见 `docs/PUBLICATION-REDACTION-PLAN-v0.1.md`。本文件**不做**任何改写。

---

## 5. 后续候选任务（区分已实现 / 研究过 / 尚未开始）

| 候选任务 | 状态 | 依据与边界 |
| --- | --- | --- |
| **五角色扩展**（增加 discussion / testing 两个角色，构成"需求 → 讨论 → 编码 → 审核 → 测试"） | **尚未开始** | `docs/ROADMAP.md` V0.1 扩展目标；明确"不是首次运行成功的前提"。现有流水线是预检 + 4 个执行角色（Requirement / Coding / Verifier / Review）。 |
| **多模型手动分工**（按角色指定不同模型） | **研究过，未实现** | `docs/MULTI-MODEL-BUDGET-STUDY.md` 已核实"agent 级 `agentOptions` 覆盖"可用、Workflow **无 phase 级** provider/model 覆盖；本机当前所有运行都用同一模型（`deepseek-account/deepseek-flash`），没有做过双模型协作运行。 |
| **智能路由**（按任务自动选择模型） | **尚未开始，且未做可行性研究** | 研究稿只覆盖"配置式选路"（`providers` 字典 + `GenerateOptions.provider`），没有任何自动路由的实测或证据；不得写成已有能力。 |
| **价格感知**（成本估算 / 按价格决策） | **研究过，未实现** | 研究稿 R-M09 允许"降级形态：显示'未提供价格'"；会话日志**没有 price/cost/billing 字段**，也没有 provider 账单数据，因此现在只能显示"未提供价格"。 |
| **预算分配**（跨角色/跨阶段分配额度、token 硬上限） | **部分实现** | 已实现：调用次数硬限制 `task.maxAgentCalls`（启动前拦截）+ 事后用量观测（`tests/extract-usage-report.mjs`，可复算）。未实现：单代理 token 硬限制（宿主无已核实接口）、按角色分配额度、超限自动中止（除次数外）。 |

**明确不是已有能力**：支付充值、跨供应商资金划拨、自动采购额度——仓库里没有任何相关代码或证据，也不在已批准的研究范围内。

---

## 6. 发布前结论

### 6.1 是否具备"普通 push + 更新现有草稿 PR #2"的条件

**技术条件具备，无安全阻塞**：
- 待推送范围明确（领先 42 个提交、0 落后；加上本轮文档提交为 43 个；工作区无已跟踪改动）；
- 凭据/令牌/私钥/真实个人信息扫描全部为 0；原始未脱敏审批快照与临时材料不在跟踪树；
- 离线测试全绿（编排逻辑 114/547、预检载荷 9/42、用量 13/75、认领集成 6/59、交付 97、复核工具 28/28 + 19/19）；
- 文档状态与代码一致（本轮修正了 `README.md` 与 `tests/README.md` 里过时的测试计数：85→114 场景 / 391→547 断言、76→97 用例，并把 81 例标注为 run2 的历史记录）。

**两个需要所有者决定的点（不是技术阻塞）**：
1. **本地信息暴露**：3 个 HEAD 文件含本机账户名、18 个文件含本地绝对路径（其中 1 个是本文件）、历史对象含 2 个审查包。是否接受、或按 §4.1 方案 B 先做一次 HEAD 级占位符替换（方案 C 会改写 42 个提交的 SHA）。
2. **PR 文稿的选择**：是用 §3 的正文**整体替换**草稿 PR #2 描述，还是只追加一节"V0.1 演示功能验收通过"？后者更保守，前者信息更完整。

### 6.2 准确的待授权操作范围

若所有者批准，需要的授权只有这三项（其余都不需要）：

1. **一次普通 `git push origin feat/v0.1-three-agent-mvp`**（43 个提交、206 个文件）；
2. **更新草稿 PR #2 的标题/正文**（不改变 base/head，不合并）；
3. （脱敏发布，替代上面的单项假设）**按脱敏方案重建发布分支并快进推送**，见 `docs/PUBLICATION-REDACTION-PLAN-v0.1.md` §8 的 A1/A2/A3。

**不包含**：合并 `main`、创建新 PR、改写已推送历史、清理历史残留、删除未跟踪现场、调用模型或安装依赖。

### 6.3 本轮实际执行与未执行

- 执行：只读 Git 检查、安全扫描（本地对象）、文档整理与本地提交；未联网。
- 未执行：push、修改 PR、合并、调用模型、安装依赖、清理任何历史文件或未跟踪现场、ACL 修改。
