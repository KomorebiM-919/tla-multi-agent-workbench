# tests/ — 测试与验证入口

## 当前状态（V0.1）

V0.1 的验收对象是"这条多 Agent 流水线本身"，因此本目录当前承载**编排逻辑的回归测试**与验证入口说明（`docs/ROADMAP.md` V0.1）。所有测试都只用本机已有的 Python 标准库与 Node 标准库，**不安装任何第三方依赖**。

### 1. 工作流逻辑回归测试（模拟子代理返回值）

`tests/workflow-logic.test.mjs` 声明场景与期望值，共享夹具在 `tests/workflow-harness.mjs`：后者用 `node:vm` 把**真实的生产脚本** `workflows/three-agent-mvp.js` 装载成函数，再注入模拟的 `agent()` 返回值、可控时钟与断言框架。生产脚本只有一份，测试直接跑它，不复制任何判定逻辑。

```powershell
node tests/workflow-logic.test.mjs
```

- 退出码 0 = 全部场景通过；非 0 = 有场景失败（输出会指明场景名与断言）。当前规模：**81 个场景 / 372 项断言**。
- 时间相关门禁使用**注入的可控时钟**（`FIXED_NOW_MS = Date.parse('2026-10-16T04:00:00Z')`，与夹具 `runId` 的时间戳同秒；由 `workflow-harness.mjs` 的 `setClock()` / `advanceClock()` 驱动，`runWith()` 每个场景开始时重置）。因此"运行起点与编排层时钟相差过大""阶段时间戳晚于当前时间""时钟推进 120 秒跨多个阶段仍成功"这类判定都能离线、确定性地测出来，不需要真实等待；夹具区有一条护栏断言时钟与夹具时间戳一致，防止两者漂移后测试失去意义。
- 覆盖的场景包括：正常成功；Coding 自述测试失败但 Review 返回 `APPROVED`（⇒ `TEST_NOT_VERIFIED`）；自述成功但独立验证失败（⇒ `INCONSISTENT_EVIDENCE`）；有验收条件未满足但 Review 返回 `APPROVED`（⇒ `CRITERIA_NOT_SATISFIED`）；`criteria_check` 覆盖不全、含未知 ID、含重复 ID（⇒ `CRITERIA_CHECK_INCOMPLETE` / `CRITERIA_CHECK_UNKNOWN_IDS` / `CRITERIA_CHECK_DUPLICATE_IDS`）；Review 自述退出码与原始输出矛盾（⇒ `INCONSISTENT_REVIEW`）；验证前后文件指纹不一致或 Review 未回传复核指纹（⇒ `ARTIFACT_FINGERPRINT_MISMATCH`）；审核不通过后自动修订；达到最大轮次仍不通过（⇒ `MAX_ATTEMPTS_*`）；非法 `targetDir`（路径穿越）；交付目录/证据目录真实路径落在仓库之外、未回报 `realpath`、链接逃逸、未完成证据目录认领（⇒ `TARGET_DIR_OUTSIDE_REPO` / `LINK_ESCAPE` / `EVIDENCE_NOT_CLAIMED`）；非法 `maxCodingAttempts`；非法 `runId`（含缺少 UTC 时间戳后缀、时间戳与 `runStartedAt` 不同秒）；`evidenceDir` 不在 `docs/evidence/` 下或与 `runId` 不一致；任意 shell 测试命令；重复/已存在的 `runId` 不得覆盖历史证据；需求自检报冲突；需求缺验收条件或缺少/重复 ID；编码未返回报告（⇒ `CODING_OUTPUT_INVALID`）；**任一阶段报告未解决需求冲突时不得成功**（Review / Verifier / Coding 各自报告冲突，以及"Coding 报告不可用 + Verifier 报告冲突"时冲突状态优先）；`args` 缺失或为空；Review 的独立复跑命令与规范命令不一致（⇒ `INCONSISTENT_REVIEW`）；Verifier 证据时间戳越出运行窗口（⇒ `INVALID_TIMESTAMP`）。
- 复审后的第二轮加固新增场景（都是"应当拒绝"）：
  - **指纹集合**：多列无关文件（README）、缺少测试文件、同一路径重复出现——**两侧清单一致也拒绝**（⇒ `ARTIFACT_FINGERPRINT_MISMATCH`）；
  - **预检自述问题**：`problems` 非空 ⇒ `PREFLIGHT_PROBLEMS`（一个子代理都不启动）；`claim_created=false`、`claim_tool` 不是排他认领工具、`claim_exit_code=10`、`owner_marker_path` 属于别的运行 ⇒ `EVIDENCE_NOT_CLAIMED`；
  - **Review 复跑**：`Ran 0 tests`、用例数与 Verifier 对同一规范命令的用例数不一致 ⇒ `INCONSISTENT_REVIEW`；
  - **Coding 自述内部一致性**：`test_succeeded=true` + 退出码 `1`、`false` + 退出码 `0`、测试命令不是配置的规范命令、退出码不是非负整数、自述通过但摘录含 `FAILED` ⇒ `CODING_REPORT_INCONSISTENT`；
  - **时间**：阶段时间戳日历非法（`2026-02-30`）⇒ `INVALID_TIMESTAMP`；未来时间 ⇒ `INVALID_TIMESTAMP`；`runStartedAt` 非法或与编排层实际时间相差超过 1 小时（把 `runId` 与 `runStartedAt` 一起伪造成旧时间）⇒ `INVALID_ARGS`；
  - **路径**：realpath 含未规范化的点段 ⇒ `PATH_NOT_NORMALIZED`；`target_dir` / `target_dir_realpath` / `evidence_dir_realpath` 与配置目标不对应 ⇒ `PATH_TARGET_MISMATCH`。
- 复审后的第三轮收口新增场景：
  - **两个时钟分开**：`runStartedAt` 与运行起点比较（启动时钟），每次 Agent 返回后**重新读取**当前时间与阶段时间戳比较；时钟推进 120 秒并跨 Requirement / Coding / Verifier / Review 四个阶段仍成功（⇒ `OK`）；时钟推进 7 小时越出窗口 ⇒ `INVALID_TIMESTAMP`；阶段时间戳晚于编排层当前时间 120 秒 ⇒ `INVALID_TIMESTAMP`（这条用固定时钟即可，不需要真实等待）。
  - **认领前状态**：预检必须回填认领工具自报的 `evidence_dir_state_before`；它与预检自己观察的 `evidence_dir_state` 不一致、或值为 `exists`（目录已有内容）⇒ `EVIDENCE_NOT_CLAIMED`；`empty`（已存在但空目录）可放行。

### 1a. 预检认领门禁的集成测试（真实认领工具 + 编排层门禁）

`tests/preflight-claim-integration.test.mjs` 不使用手工拼写的认领结果：它**真的调用** `tools/claim_evidence_dir.py`，把工具打印的 JSON 原样接入编排层预检返回值，再看门禁放行还是拒绝。当前 **5 个场景 / 48 项断言**：

```powershell
node tests/preflight-claim-integration.test.mjs
```

- 首次认领（工具真实退出码 0）⇒ 预检通过并跑完整条流水线（`OK`），并核对工具独立解算的 realpath 与编排层推导一致、证据目录里只有认领文件；
- 重复认领（工具退出码 10）⇒ 门禁拒绝，且既有 `.run-owner.json` **逐字节不变**、目录里没有 `preflight.json`；
- 目录非空且无认领文件（退出码 11）⇒ 拒绝，原目录内容与哈希不变、不创建认领文件、不写任何文件；
- 已存在但为空的目录 ⇒ 可被认领（工具报告 `empty`）并放行；
- 预检自报的认领前状态与工具回报的 `evidence_dir_state_before` 不一致 ⇒ `EVIDENCE_NOT_CLAIMED`。

> 该测试用 shell 重定向（`> out.json 2> err.txt`）而不是管道捕获子进程输出：DSH 文件沙箱下 Node 捕获子进程 stdout/stderr（管道）会 `EPERM`，`stdio: 'ignore'` + shell 重定向是可行路径。重定向的目标文件放在证据目录**之外**，否则目录会因"非空"被认领工具拒绝。
> 该测试使用**真实当前时间**（`Date.now()`）构造 `runId` / `runStartedAt` 并让编排层时钟同步（`runWith(..., { resetClock: false })`），因为认领工具写的是真实时钟，固定夹具时钟会让工具产物落在运行窗口之外。临时证据目录建在 `docs/evidence/itest-claim-<pid>/<runId>`（编排层硬要求），用后即删。

### 1b. 证据目录排他认领工具的进程级测试

`tools/claim_evidence_dir.py` 负责用 `open(..., 'x')`（`O_EXCL`）排他创建 `.run-owner.json`。它的行为（不是一个进程内的模拟）由 `tests/test_claim_evidence_dir.py` 通过**真实子进程**验证：

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

当前 11 个用例：首次认领成功并创建 marker；重复认领被拒绝且 marker **逐字节不变**（`claimedAt` / `claimedBy` 不被下一轮覆写）；同一 `runId` 也不可重认领；**8 个进程同时认领只有一个成功**（其余退出码 10）；目录非空且无认领文件时拒绝且不写任何文件；空目录可认领；目标是文件时拒绝；绝对路径 / `..` 穿越 / 反斜杠 / 空值 / 非法 `runId` / 非法日历日期一律参数错误（退出码 4）；marker 里不出现本机绝对路径。

> 测试的临时目录用 `os.makedirs` + `uuid4` 命名放在 `tests/.scratch/`（已由根 `.gitignore` 忽略），**不要**用 `tempfile.mkdtemp`：它按 `0o700` 建目录，在 Windows 上会把 DACL 收窄到仅所有者，导致测试自己都进不去。

### 1c. 突变检验（旧生产脚本 + 新测试）

把 `e3c27c1` 的旧生产脚本换成新测试的被测对象，用来证明"新增的拒绝场景真的能抓住旧门禁的漏洞"：

```powershell
# 旧脚本内容：git show e3c27c1:workflows/three-agent-mvp.js
# 做法：把 harness 的 WORKFLOW_PATH 指向旧脚本副本，再跑同一批测试
```

第三轮结果：旧脚本下**逻辑套件 54/81 场景通过，24 个场景返回了 `ok: true`（误放行）**，另有 **3 个场景虽被拒绝但状态码 / 原因不符合新契约**（`Coding test_succeeded=false` + 退出码 0 ⇒ 旧 `INCONSISTENT_EVIDENCE`（新契约 `CODING_REPORT_INCONSISTENT`）；`2026-02-30` 这类非法日历时间 ⇒ 靠 6 小时窗口"偶然"拒绝（原因是"不在运行窗口内"而不是"日历时间非法"）；把 `runId` 与 `runStartedAt` 一起伪造成一天前的旧时间 ⇒ 旧 `INVALID_TIMESTAMP` 且已经启动了预检子代理（新契约在启动前即 `INVALID_ARGS`））。集成套件在旧脚本下 4/5 通过：认领前状态不一致那个场景被拒绝，但走的是旧的"未完成认领"原因，说明 `evidence_dir_state_before` 当时并未被消费。

### 2. 演示项目的自动验证（普通测试脚本）

首个 MVP 的交付产物是一个演示用 Python 文本统计工具（`examples/text-stats/`，属于工作流测试样例，不是 TLA 工作台自身的核心功能）。它的单元测试就是本阶段的自动验证脚本：

```powershell
python -m unittest discover -s examples/text-stats -p "test_*.py" -v
```

期望结果：全部用例通过（`OK`），覆盖需求中的每条验收条件与边界条件（空文本、结尾换行、空白行、单词判定规则、编码与 BOM、错误路径与退出码等）。

### 3. 编排层独立复核

编排层（不是三个角色）另行编写了独立复核脚本，直接对交付实现验算需求文件中的边界条件与验收口径，并静态检查实现是否只用标准库：

```powershell
python -B docs/evidence/v0.1-second-run/orchestrator-verification.py
python -B docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6.py
```

三次真实运行的复核结果：第一次 45 项检查、第二次 266 项检查、run 6 共 280 项检查（0 失败 / 1 跳过，跳过项与勘误见
`docs/evidence/v0.1-run6-20261016T154400Z/ERRATUM-BC-07-CITATION.md`）。

### 4. 工作流执行证据（比测试结果更重要的部分）

`docs/evidence/<runId>/` 下保留**每个 Agent 自己写出的**原始结论（JSON 信封）、编排层核验记录与 DSH 原生执行事件：

| 文件 | 由谁产生 | 内容 |
| --- | --- | --- |
| `preflight.json` | Verifier Agent（preflight） | 只读预检结果（证据目录状态、提示词齐备性、路径解算） |
| `requirement.json` | Requirement Agent | 结构化需求（目标、范围、验收条件、边界条件、一致性自检） |
| `coding-report.json` | Coding Agent | 文件清单、实现说明、真实测试命令与退出码、与需求的偏差 |
| `verify.json` | Verifier Agent（verify） | 独立复跑的原始输出、退出码、用例数、产物 sha256 |
| `review.json` | Review Agent | 逐条验收条件判定、问题清单、最终结论 |
| `dsh-native-events.json` | 编排层（只读会话日志提取） | 脱敏的 DSH 原生执行事件（会话标识、时间、turn/step、工具调用），用于证明"确实是独立子代理" |
| `test-output.txt` | 编排层（人工可复现） | 提交前复跑测试的原始输出 |
| `README.md` | 编排层 | 本次运行记录：时间、命令、环境、核验结论、诚实记录 |

### 5. 提交前必做的通用检查

见 `AGENTS.md` 第 8 节（`git status` / `git diff --check` / 敏感信息扫描 / `.gitignore` 覆盖 / 测试通过 / 文档同步）。

## 规划

- V0.2 起：多模型分工（按角色分配模型）与状态持久化/续跑的验证也会落到本目录。
- V0.3 起引入测试 Agent 与项目级测试框架（`docs/ROADMAP.md` V0.3），届时本目录承载 TLA 自身的单元测试与集成测试。
