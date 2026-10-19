# tests/ — 测试与验证入口

## 当前状态（V0.1）

V0.1 的验收对象是"这条多 Agent 流水线本身"，因此本目录当前承载**编排逻辑的回归测试**与验证入口说明（`docs/ROADMAP.md` V0.1）。所有测试都只用本机已有的 Python 标准库与 Node 标准库，**不安装任何第三方依赖**。

### 1. 工作流逻辑回归测试（模拟子代理返回值）

`tests/workflow-logic.test.mjs` 声明场景与期望值，共享夹具在 `tests/workflow-harness.mjs`：后者用 `node:vm` 把**真实的生产脚本** `workflows/three-agent-mvp.js` 装载成函数，再注入模拟的 `agent()` 返回值、可控时钟与断言框架。生产脚本只有一份，测试直接跑它，不复制任何判定逻辑。

```powershell
node tests/workflow-logic.test.mjs
```

- 退出码 0 = 全部场景通过；非 0 = 有场景失败（输出会指明场景名与断言）。当前规模：**114 个场景 / 547 项断言**。
- 时间相关门禁使用**注入的可控时钟**（`FIXED_NOW_MS = Date.parse('2026-10-16T04:00:00Z')`，与夹具 `runId` 的时间戳同秒；由 `workflow-harness.mjs` 的 `setClock()` / `advanceClock()` 驱动，`runWith()` 每个场景开始时重置）。因此"运行起点与编排层时钟相差过大""阶段时间戳晚于当前时间""时钟推进 120 秒跨多个阶段仍成功"这类判定都能离线、确定性地测出来，不需要真实等待；夹具区有一条护栏断言时钟与夹具时间戳一致，防止两者漂移后测试失去意义。
- 覆盖的场景包括：正常成功；Coding 自述测试失败但 Review 返回 `APPROVED`（⇒ `TEST_NOT_VERIFIED`）；自述成功但独立验证失败（⇒ `INCONSISTENT_EVIDENCE`）；有验收条件未满足但 Review 返回 `APPROVED`（⇒ `CRITERIA_NOT_SATISFIED`）；`criteria_check` 覆盖不全、含未知 ID、含重复 ID（⇒ `CRITERIA_CHECK_INCOMPLETE` / `CRITERIA_CHECK_UNKNOWN_IDS` / `CRITERIA_CHECK_DUPLICATE_IDS`）；Review 自述退出码与原始输出矛盾（⇒ `INCONSISTENT_REVIEW`）；验证前后文件指纹不一致或 Review 未回传复核指纹（⇒ `ARTIFACT_FINGERPRINT_MISMATCH`）；审核不通过后自动修订；达到最大轮次仍不通过（⇒ `MAX_ATTEMPTS_*`）；非法 `targetDir`（路径穿越）；交付目录/证据目录真实路径落在仓库之外、未回报 `realpath`、链接逃逸、未完成证据目录认领（⇒ `TARGET_DIR_OUTSIDE_REPO` / `LINK_ESCAPE` / `EVIDENCE_NOT_CLAIMED`）；非法 `maxCodingAttempts`；非法 `runId`（含缺少 UTC 时间戳后缀、时间戳与 `runStartedAt` 不同秒）；`evidenceDir` 不在 `docs/evidence/` 下或与 `runId` 不一致；任意 shell 测试命令；重复/已存在的 `runId` 不得覆盖历史证据；需求自检报冲突；需求缺验收条件或缺少/重复 ID；编码未返回报告（⇒ `CODING_OUTPUT_INVALID`）；**任一阶段报告未解决需求冲突时不得成功**（Review / Verifier / Coding 各自报告冲突，以及"Coding 报告不可用 + Verifier 报告冲突"时冲突状态优先）；`args` 缺失或为空；Review 的独立复跑命令与规范命令不一致（⇒ `INCONSISTENT_REVIEW`）；Verifier 证据时间戳越出运行窗口（⇒ `INVALID_TIMESTAMP`）。
- 复审后的第二轮加固新增场景（都是"应当拒绝"）：
  - **指纹集合**：多列无关文件（README）、缺少测试文件、同一路径重复出现——**两侧清单一致也拒绝**（⇒ `ARTIFACT_FINGERPRINT_MISMATCH`）；
  - **预检自述问题**：`problems` 非空 ⇒ `PREFLIGHT_PROBLEMS`（一个子代理都不启动）；`claim_created=false`、`claim_tool` 不是排他认领工具、`claim_exit_code=10`、`owner_marker_path` 属于别的运行 ⇒ `EVIDENCE_NOT_CLAIMED`；
  同一个认领文件写成绝对路径（正斜杠或 Windows 反斜杠）视为等价、放行；含点段或指向别的文件仍判 `EVIDENCE_NOT_CLAIMED`（对应 run4 的真实故障）；
  - **Review 复跑**：`Ran 0 tests`、用例数与 Verifier 对同一规范命令的用例数不一致 ⇒ `INCONSISTENT_REVIEW`；
  - **Coding 自述内部一致性**：`test_succeeded=true` + 退出码 `1`、`false` + 退出码 `0`、测试命令不是配置的规范命令、退出码不是非负整数、自述通过但摘录含 `FAILED` ⇒ `CODING_REPORT_INCONSISTENT`；
  - **时间**：阶段时间戳日历非法（`2026-02-30`）⇒ `INVALID_TIMESTAMP`；未来时间 ⇒ `INVALID_TIMESTAMP`；`runStartedAt` 非法或与编排层实际时间相差超过 1 小时（把 `runId` 与 `runStartedAt` 一起伪造成旧时间）⇒ `INVALID_ARGS`；
  - **路径**：realpath 含未规范化的点段 ⇒ `PATH_NOT_NORMALIZED`；`target_dir` / `target_dir_realpath` / `evidence_dir_realpath` 与配置目标不对应 ⇒ `PATH_TARGET_MISMATCH`。
- 复审后的第三轮收口新增场景：
  - **两个时钟分开**：`runStartedAt` 与运行起点比较（启动时钟），每次 Agent 返回后**重新读取**当前时间与阶段时间戳比较；时钟推进 120 秒并跨 Requirement / Coding / Verifier / Review 四个阶段仍成功（⇒ `OK`）；时钟推进 7 小时越出窗口 ⇒ `INVALID_TIMESTAMP`；阶段时间戳晚于编排层当前时间 120 秒 ⇒ `INVALID_TIMESTAMP`（这条用固定时钟即可，不需要真实等待）。
  - **认领前状态**：预检必须回填认领工具自报的 `evidence_dir_state_before`；它与预检自己观察的 `evidence_dir_state` 不一致、或值为 `exists`（目录已有内容）⇒ `EVIDENCE_NOT_CLAIMED`；`empty`（已存在但空目录）可放行。
- 第二次真实运行结束后（v0.2-run2）补的场景：
  - **mtime 表示精度不构成重写**：同一个 pyc 被不同子代理报成 `1760000000000`（整数毫秒）与 `1760000000000.332`（浮点毫秒），而 `bytes` 与 `sha256` 完全相同时 ⇒ `OK`（不得误报 `BYTECODE_CACHE_CHANGED_ACROSS_RUN`）。这条直接来自真实运行里的 4 条误报。
  - **容差不得放过真实重写**：`bytes` 与 `sha256` 相同但 `mtime` 相距 5 秒 ⇒ 仍判 `BYTECODE_CACHE_WRITTEN`（容差只吸收表示精度，不吸收真实写入）。
- 子代理调用预算（`task.maxAgentCalls`）新增场景：
  - **边界不溢出不漏**：默认预算 8 + `maxCodingAttempts: 2` 恰好两轮 8 次 ⇒ `OK`，`agentCallBudget.limit/started/attempted` 都是 8；
  - **第 N+1 次调用真的没有启动**：`maxAgentCalls: 7` + 两轮 ⇒ `AGENT_CALL_BUDGET_EXCEEDED`、实际启动 7 次、账本最后一项 `started: false`、`attempted: 8`，日志含"拒绝启动第 8 次调用"；
  - **预算用完不靠事后算账**：`maxAgentCalls: 8` + 需要 11 次的三轮计划 ⇒ 中止在启动前（账本第 9 项 `started: false`、日志含"拒绝启动第 9 次"），证明拦截点在 `agent()` 之前而不是跑完再统计；
  - **非法上限**：`maxAgentCalls` 为 `33` / `0` / `2.5` / `'4'` ⇒ `INVALID_ARGS` 且一次子代理都不启动；
  - **容差边界与证明边界**：mtime 相差正好 5 毫秒 ⇒ `OK`，相差 6 毫秒 ⇒ `BYTECODE_CACHE_WRITTEN`；末条断言 `finalDecision.cacheCoverage.collectsAfterLastAgent === false`、`unobservedWindow` 非空、`note` 含"不可观测"——把"没抓到"与"没发生"分开写进返回值。

### 1a. 预检认领门禁的集成测试（真实认领工具 + 编排层门禁）

`tests/preflight-claim-integration.test.mjs` 不使用手工拼写的认领结果：它**真的调用** `tools/claim_evidence_dir.py`，把工具打印的 JSON 原样接入编排层预检返回值，再看门禁放行还是拒绝。当前 **6 个场景 / 59 项断言**：

```powershell
node tests/preflight-claim-integration.test.mjs
```

- 首次认领（工具真实退出码 0）⇒ 预检通过并跑完整条流水线（`OK`），并核对工具独立解算的 realpath 与编排层推导一致、证据目录里只有认领文件；
- 重复认领（工具退出码 10）⇒ 门禁拒绝，且既有 `.run-owner.json` **逐字节不变**、目录里没有 `preflight.json`；
- 目录非空且无认领文件（退出码 11）⇒ 拒绝，原目录内容与哈希不变、不创建认领文件、不写任何文件；
- 已存在但为空的目录 ⇒ 可被认领（工具报告 `empty`）并放行；
- 预检自报的认领前状态与工具回报的 `evidence_dir_state_before` 不一致 ⇒ `EVIDENCE_NOT_CLAIMED`；
- 证据目录路径**含空格**（`docs/evidence/itest claim <pid>/<runId>`，工具输出文件也放在含空格的目录下）⇒ 照常认领并跑完整条流水线。

> **子进程的启动方式**：直接执行 Python 解释器（`resolvePython()` 从 `PATH` 里挑出真实 `python.exe`，跳过 Windows 应用商店别名占位程序，可用环境变量 `TLA_PYTHON` 覆盖），参数以**数组**传入，子进程输出写进**已打开的文件句柄**，全程不经过 shell。更早的版本把命令拼成一个字符串交给 shell（`shell: true` 加 `> out.json 2> err.txt` 重定向），它在审查环境里以 `0xC0000005` 崩溃，而且路径含空格时会被 shell 拆成多个参数——含空格的那个场景就是这条的回归。
> 用文件句柄而不是管道捕获输出是环境约束：DSH 文件沙箱下 Node 捕获子进程 stdout/stderr（管道）会 `EPERM`，文件句柄不经过管道。输出文件放在证据目录**之外**，否则目录会因"非空"被认领工具拒绝。
> 该测试使用**真实当前时间**（`Date.now()`）构造 `runId` / `runStartedAt` 并让编排层时钟同步（`runWith(..., { resetClock: false })`），因为认领工具写的是真实时钟，固定夹具时钟会让工具产物落在运行窗口之外。临时证据目录建在 `docs/evidence/<父目录>/<runId>`（编排层硬要求：必须在 `docs/evidence/` 之下且最后一级等于 `runId`），用后即删。

### 1b. 证据目录排他认领工具的进程级测试

`tools/claim_evidence_dir.py` 负责用 `open(..., 'x')`（`O_EXCL`）排他创建 `.run-owner.json`。它的行为（不是一个进程内的模拟）由 `tests/test_claim_evidence_dir.py` 通过**真实子进程**验证：

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

当前 11 个用例：首次认领成功并创建 marker；重复认领被拒绝且 marker **逐字节不变**（`claimedAt` / `claimedBy` 不被下一轮覆写）；同一 `runId` 也不可重认领；**8 个进程同时认领只有一个成功**（其余退出码 10，或竞态下退出码 11：赢家建好目录但还没写 marker 时，输家看到的是"非空目录"——两者都算拒绝，硬性要求是"只有 1 个成功且输家不创建认领文件"）；目录非空且无认领文件时拒绝且不写任何文件；空目录可认领；目标是文件时拒绝；绝对路径 / `..` 穿越 / 反斜杠 / 空值 / 非法 `runId` / 非法日历日期一律参数错误（退出码 4）；marker 里不出现本机绝对路径。

> 测试的临时目录用 `os.makedirs` + `uuid4` 命名放在 `tests/.scratch/`（已由根 `.gitignore` 忽略），**不要**用 `tempfile.mkdtemp`：它按 `0o700` 建目录，在 Windows 上会把 DACL 收窄到仅所有者，导致测试自己都进不去。

### 1c. 突变检验（旧生产脚本 + 新测试）

把 `e3c27c1` 的旧生产脚本换成新测试的被测对象，用来证明"新增的拒绝场景真的能抓住旧门禁的漏洞"：

```powershell
# 旧脚本内容：git show e3c27c1:workflows/three-agent-mvp.js
# 做法：把 harness 的 WORKFLOW_PATH 指向旧脚本副本，再跑同一批测试
```

第三轮结果：旧脚本下**逻辑套件 54/81 场景通过，24 个场景返回了 `ok: true`（误放行）**，另有 **3 个场景虽被拒绝但状态码 / 原因不符合新契约**（`Coding test_succeeded=false` + 退出码 0 ⇒ 旧 `INCONSISTENT_EVIDENCE`（新契约 `CODING_REPORT_INCONSISTENT`）；`2026-02-30` 这类非法日历时间 ⇒ 靠 6 小时窗口"偶然"拒绝（原因是"不在运行窗口内"而不是"日历时间非法"）；把 `runId` 与 `runStartedAt` 一起伪造成一天前的旧时间 ⇒ 旧 `INVALID_TIMESTAMP` 且已经启动了预检子代理（新契约在启动前即 `INVALID_ARGS`））。集成套件在旧脚本下 **5/6** 通过：认领前状态不一致那个场景被拒绝，但走的是旧的"未完成认领"原因，说明 `evidence_dir_state_before` 当时并未被消费；含空格路径那个场景在旧脚本下照样通过——它针对的是**子进程启动方式**（测试自身），不是编排层的门禁逻辑。

### 1d. 审批拒绝取证工具的离线回归与反向验证

人工审批安全拒绝测试**已执行一次**（2026-10-17，父会话 `pwsh` 升级审批被用户拒绝，机器判定 `PASS` +
用户逐字确认，现场见 `docs/evidence/v0.1-approval-rejection-20261017T112518Z/`）。
下面两个套件只验证**取证与判定逻辑**，全程不触发审批、不访问网络、不读凭据、不跑真实子代理：

```powershell
node tests/approval-rejection-evidence.test.mjs   # 131 断言 / 27 组场景
node tests/approval-evidence-mutation.test.mjs    # 18 组 v1→v3 + 11 组 v2→v3 反向验证
```

- `tests/approval-rejection-evidence.test.mjs`：合成事件流 + 合成指纹 + 临时 git 仓库。
  - **日志切帧**：按 RFC 8878 帧结构求帧长，而不是按 zstd 魔数扫——有一个用例手工构造原始块，让**载荷内部**出现 `28 B5 2F FD`（魔数扫描会切成 3 段），结构解析仍得到 2 帧；另有截断尾部、保留块类型、帧头保留位、坏校验和（⇒ `badFrames=1`）、空文件、坏行计数。
  - **事件关联**：唯一 marker、approval id、callId、`toolName`、`sandbox_permissions`、`reason` 前缀与 `justification` 一致、决定与工具结果对应、事件顺序（`call < asked < decided ≤ result`）、重复/歧义/缺失、`never` 只取"调用时刻"生效的策略（决定之后才出现的 `never` 不得污染判定）、子代理会话拒绝。
  - **无副作用四要件**：`git status` 文本相同但工作区内容变了（⇒ `WORKSPACE_CONTENT_CHANGED`）、目标被创建、本地 remote-tracking refs 变化、依赖清单变化、权限未测得（⇒ INCOMPLETE 而不是 PASS）、两个缺失值不算"相等"、快照 `runId`/目标/仓库/身份/时间顺序/标记不一致、同前缀文件已存在。
  - **缺失值与身份错配（v3 新增 6 项）**：`target` 两边都是 `null`、`target.exists` 两边都是 `null`、`identity.sessionId` 两边都是 `null`、两份快照的会话 id 相同但不是日志里的会话、`repo.root` 两边都是 `null`、执行前目标已存在——六种情形旧版都会 PASS，现在分别判 `TARGET_UNMEASURED` / `TARGET_EXISTS_UNMEASURED` / `SNAPSHOT_IDENTITY_UNMEASURED` / `SNAPSHOT_SESSION_MISMATCH` / `REPO_ROOT_UNMEASURED` / `TARGET_EXISTED_BEFORE`。
  - **审批操作与目标绑定（v3 新增 5 项）**：命令必须逐字等于规范命令（`APPROVAL_COMMAND_UNBOUND`）、缺命令判 `APPROVAL_COMMAND_UNMEASURED`（INCOMPLETE）、命令指向另一个文件（同 marker）、命令里追加别的动作、`justification` 没写目标路径（`TARGET_NOT_IN_JUSTIFICATION`）、目标落在工作区内（`TARGET_INSIDE_WORKSPACE`）、目标名不符合契约（`TARGET_NAME_NOT_IN_CONTRACT`）。
  - **v4 新增的收紧**：快照 marker 必须就是本次审批的 marker（`SNAPSHOT_MARKER_NOT_BOUND`）；`insideRepo` / `nameMatchesContract` 由工具按路径**重算**，改字段即 `TARGET_CONSTRAINT_TAMPERED`；内容指纹有文件被跳过 ⇒ `CONTENT_SCOPE_INCOMPLETE`（INCOMPLETE）；快照采集区间必须围住审批事件（`SNAPSHOT_BEFORE_AFTER_APPROVAL` / `SNAPSHOT_AFTER_BEFORE_RESULT` / 缺事件时间 ⇒ `EVENT_TIME_UNMEASURED`）；规范命令改为排他创建 `New-Item -ItemType File ... -ErrorAction Stop`。
  - **写入与 CLI**：排他创建拒绝覆盖、取证目录被排除在内容指纹之外、`pathKey` 大小写归一、`verify` 的退出码 `0/1/3/4`。
- `tests/approval-evidence-mutation.test.mjs`：把加固前的判定规则冻结成 `judgeV1` / `compareStatesV1`（以及 v3 之前的 `compareStatesV2`），同一批 18 个用例同时喂给 v1 与当前版，另有一张 11 行的 v2→v3 严格比对表。当前结果：**11 组误放行被拦下、1 组误拒绝被修正、3 组理由不符、3 组无差异**；v2→v3 的 11 组（六类缺失值、身份错配、审批指向另一个文件、marker 未绑定、内容跳过、约束篡改、时间区间）全部 `v2 PASS → v3 非 PASS`。

> 这两个套件同样受环境约束：DSH 文件沙箱下不能捕获子进程管道输出，因此 CLI 用例直接调用
> 导出的 `main()` 并临时接管 `process.stdout/stderr`；需要真实 git 的用例用 `tests/.scratch/` 下的临时仓库
> （该目录已被 `.gitignore` 忽略），用后即删。也正因为这条约束，**不要用 `node --test` 跑它们**——测试运行器
> 本身要用管道启动子进程，会得到 `spawn EPERM`；直接 `node tests/<file>.test.mjs` 是在当前进程内运行，正常。

### 1e. 文本统计的有界性质测试（独立参考实现 + 反向验证）

```powershell
python tests/property_text_stats.py   # 1217 组检查，约 0.2 秒，exit 0 = 全部通过
```

- **证明范围分两层，必须分开看**（脚本 docstring 与末尾输出也这么写）：
  - (A) **已批准口径**：16 条固定示例直接断言 RB-1 – RB-6 的可观察结果（不经过参考实现）；
  - (B) **实现一致性**：随机输入上把生产实现的四个计数与脚本内独立参考实现比对，其中**包含尚未逐条批准的规则**
    （单词正则的具体形状、撇号/连字符连接符、只剥一个前导 BOM）。这一层证明"当前实现与参考实现一致"，
    **不等于**"这些规则已被需求批准"。
  - 脚本**不覆盖** RB-1（程序化调用静默）与 RB-5（编排层冲突门禁，那是工作流侧的事），也不证明 RB-2 的 CLI 输出路径；
    那些分别由 `examples/text-stats/test_text_stats.py`（AC-10/AC-13/BC-15/BC-17 等）、
    `tests/preflight-claim-integration.test.mjs` 与 `tests/workflow-logic.test.mjs` 提供证据。
  - 脚本**不断言"归一化幂等"**：参考实现与生产实现都只剥**一个**前导 BOM，`'\ufeff\ufeffabc'` 归一化两次会再少一个字符，
    幂等性在这条规则下本来就不成立（早先文档里"归一化幂等"的说法已删除）。
- 参考期望在脚本内**独立实现**（按字符扫描切行、扫描式词计数），不 import 生产函数来自证正确；
  生产实现只作为被比对的一方。
- 固定种子 `0–9`、每种子 120 组随机输入（字母/数字/空白/CR/LF/CRLF/BOM/U+2028/U+2029/`\x0b`/`\x0c`/
  `\x1c–\x1e`/`\x85`/预组合重音/组合重音/连接符），另有 16 条固定示例与 1 条 200000 字符长文本；
  墙钟上限 60 秒，超时即失败。失败时会缩减为最小反例并打印复现命令。
- **反向验证**（确认脚本抓得住错实现）：用 `TLA_TEXT_STATS_PATH=<被改坏的副本>` 运行，三个变异体
  全部被判失败并给出最小反例——去掉"末尾空片段"逻辑（`'\n'`）、改用 `splitlines()`（`'a\u2028b'`）、
  丢掉撇号连接符（`'Z\u2019X'`）。变异体只存在于 `tests/.scratch/`（已忽略），不入库。

### 2. 演示项目的自动验证（普通测试脚本）

首个 MVP 的交付产物是一个演示用 Python 文本统计工具（`examples/text-stats/`，属于工作流测试样例，不是 TLA 工作台自身的核心功能）。它的单元测试就是本阶段的自动验证脚本：

```powershell
python -m unittest discover -s examples/text-stats -p "test_*.py" -v
```

期望结果：**97 个用例全部通过**（`OK`）。当前套件来自第五次真实流水线（`docs/run-records/v0.4-run5-20261017T161034Z/`，需求同为 `v0.2-demo-input-3`）的交付版本，覆盖验收条件与边界条件（空文本、结尾换行、空白行、单词判定规则、编码与 BOM、错误路径、退出码、两类调用作用域）；逐条映射见该运行审查包里的 `REQUIREMENT-TRACEABILITY.md`。**历史记录**：2026-10-17 第二次真实流水线（`docs/evidence/v0.2-run2-20261017T133204Z/`）交付的是 81 例套件。

- **程序化调用的输出作用域**（2026-10-17 收口新增）：`stdin_text` 显式传入时，成功、`--help`、五类受控错误都必须保持 `stdout`/`stderr` **双流为空**；唯一例外是"非法 `--encoding` 在选输入前就返回 `1`"。命令行侧则保持"成功 4 行 / `--help` 用法 / 错误一行 `error: `"。
- **新测试确实能抓住旧实现**（2026-10-17 早先那版 86 例套件的对照记录）：把 `git show HEAD:examples/text-stats/text_stats.py` 的旧实现与那版测试放同一目录运行，结果 `Ran 86 tests` / **8 例失败**，全部落在上述静默与编码用例上。
- **v0.2 套件的变异检查**（正式工具：`python tests/mutation-text-stats.py`）：把 run2 交付的那版 81 例套件分别对准三个重新引入旧行为的变异体（工具总是对准 `examples/text-stats/` 的**当前**套件，下面的数字是 2026-10-17 那次记录的）——① `_report_error` 忽略 `quiet`（程序化错误写 stderr）→ 5 例失败（4 例命中 `silent` 关键词）；② 程序化 `_parse_args` 不重定向 `--help` 输出 → 1 例失败；③ 非法 `--encoding` 且无 PATH 时返回 0 → 3 例失败（2 例命中 `encoding` 关键词）。基线对未变异实现 81/81 通过，说明这三处假 PASS 仍被回归锁住。
- **"被抓住"的判据从固定用例名改为行为关键词**（2026-10-17 run2 收口）：旧判据要求失败用例名以 run1 那套名字（`test_ac12_…`/`test_ac09_…`/`test_bc14_…`）开头，而用例名由交付方自己起；run2 交付的是 `test_ac15_…`/`test_ac16_…`/`test_bc13_…`，于是三个变异体明明都被杀掉，报告却写"命中目标=0"、整步 `exit=1`。现在判据是"套件失败 **且** 至少一个失败用例名命中该变异体的行为关键词（`name_hint`）"，理由与边界写在 `tests/mutation-text-stats.py` 的 `matched_failures` 文档字符串里，`tests/test_mutation_gate.py` 用 run2 的真实用例名把这个判据钉住（含"提示不得退回 `test_` 固定名"的断言）。
- **独立行为探针**（正式工具：`python tests/probe-text-stats-requirement.py`）：按需求原文独立推导期望，**不 import 交付测试**、
  不读交付实现之外的判定逻辑，当前 **180 项**（文本层 46、程序化层、命令行层、交付文件层）。它和交付套件是两条独立证据，
  任何一条通过都不能替代另一条。

### 1f. 运行期写入边界（`__pycache__`）的真实子进程门禁

AC-24 / R-33 要求"不新增 `__pycache__/`"。历史上的做法是"人工设置 `PYTHONDONTWRITEBYTECODE=1` 后复跑、
看 `.pyc` 有没有变"——这不是运行期检查（v0.2-run1 因此误判，见 `docs/evidence/v0.2-run1-20261017T121445Z/human-review-ac24.md`）。
现在改成硬门禁：

```powershell
node tests/bytecode-integration.test.mjs   # 6 个场景 / 45 项断言，真实起 PowerShell + Python 子进程
```

- 规范测试命令（`python -m unittest discover -s <targetDir> -p "test_*.py"`）在**执行时**加固定前缀
  `$env:PYTHONDONTWRITEBYTECODE = '1'; `，前缀由工作流常量生成，`isAllowedTestCommand` 只放行
  "规范命令"或"固定前缀 + 规范命令"（可带 `-v`），**不接受任意环境变量或任意 shell 命令**；
- **全运行账本**（2026-10-17 第二轮加固）：编排层在启动任何子代理之前采集 `task.cacheBaseline`（必填参数，
  用调用方的实测清单，不允许默认空数组顶替），Coding / Verifier / Review 各自交回 `bytecode_scope`
  （`env_applied`、`env_variable`、`cache_dir`、`entries_before`、`entries_after`，每项含 `path/bytes/mtime_ms/sha256`），
  **Review 自报的执行后清单就是本轮最后一个观测点**；相邻观测点之间出现新增 / 重写 / 删除 ⇒
  `BYTECODE_CACHE_CHANGED_ACROSS_RUN`（"两个验证阶段各自前后不变"只是必要条件，见 `tests` 里的离线场景
  "Verifier 与 Review 各自前后不变、但阶段之间缓存变化"）；单阶段自己前后变了 ⇒ `BYTECODE_CACHE_WRITTEN`；
  未设变量 ⇒ `BYTECODE_ENV_NOT_APPLIED`；未测量 / 清单重复 / 越界 ⇒ `BYTECODE_SCOPE_UNMEASURED`。
- **mtime 比较口径**（v0.2-run2 之后修）：`bytes` 与 `sha256` 是内容身份，`mtime_ms` 只作为附带证据；
  两者内容一致时允许 `mtime_ms` 相差 ≤ `MTIME_TOLERANCE_MS`（5 毫秒），因为同一个文件会被不同子代理
  报成整数毫秒与浮点毫秒两种表示。真实重写仍然会被抓住（内容变，或时间差远超容差）。
  四者都在 `REVIEW_NOT_APPROVED` 之前判不通过，且**已存在缓存全程逐字段一致不得被误拒**；
- 变量是否真的到达子进程**不靠退出码判断**（PowerShell 会把非零退出码折叠成 1）：子进程把 `os.environ` 写进文件，
  父进程再读回比对；`.gitignore` 忽略 `__pycache__/` 不等于允许写入，故检查的是字节/mtime/哈希而不是 `git status`。
- **证明边界（必读，别把"没抓到"读成"没发生"）**：mtime 容差只吸收"同一时间戳的整数/浮点毫秒表示差"，
  **不构成**"内容相同就证明没写过"。判定按内容身份比较，因此**把内容改回原样、且 mtime 变化不超过 5 毫秒的写入
  属于不可观测范围**；Review 返回之后的写入也不在门禁内（最后一个观测点就是 Review 自报的清单）。
  返回值 `finalDecision.cacheCoverage` 原样写出 `collectsAfterLastAgent: false` 与 `unobservedWindow`，
  需要补证据时用下面的确定性工具事后采集（补采结果**不参与**本次判定）。

### 1g. 确定性缓存快照工具（0 次模型调用）

```powershell
python tests/collect-cache-state.py --target-dir examples/text-stats --run-id <runId> --snapshot-label cache-before --out docs/evidence/<runId>/cache-before.json --pretty
python tests/collect-cache-state.py --target-dir examples/text-stats --run-id <runId> --snapshot-label cache-postrun --out docs/evidence/<runId>/cache-postrun.json --pretty
```

- **为什么有它**：v0.2-run2 每轮都额外启动一个 "Cache Collector" 子代理，只为读几个文件指纹——那是**付费模型调用**，
  也正是 10 次调用超过批准 8 次的直接原因（复盘见 `docs/run-records/v0.2-run2-20261017T133204Z/budget-overrun.md`）。
  工作流脚本没有文件系统 API，但"读指纹"不需要模型，因此交给这个只读的确定性工具：不联网、不读凭据、不写被采集目录。
- **两次采集的时点由外层控制**：`cache-before` 必须在任何子代理启动前采；`cache-postrun` 必须在最后一个子代理结束后、
  其他测试或导入开始前采（否则后面的 Python 运行会污染快照）。
- 字段口径与编排层 `normalizeCacheEntries` 兼容：`path`（仓库内相对、正斜杠）、`bytes`（整数）、`mtime_ms`（整数毫秒）、
  `sha256`（小写十六进制）；输出 `{collected_at, run_id, snapshot_label, entries, cache_dir, tool, note}`，UTF-8 无 BOM、LF。
  `run_id` / `snapshot_label` 供外层判定核对"这份快照属于本次运行"。
- 退出码：0 采集完成（目录不存在也算完成，`entries` 为空且 `note` 说明原因）、4 参数错误、5 IO 错误、
  12 解算后越出仓库根（越界时不写 `--out`）。
- 进程级测试 `tests/test_collect_cache_state.py`（**9 个用例**）：四字段与磁盘一致、`path` 无反斜杠、`mtime_ms` 为整数毫秒且
  两次采集一致、空目录/目录不存在均退出 0、只列 `.pyc` 且忽略子目录、`--out` UTF-8 无 BOM + LF 且自动建父目录、
  参数错误三态退出 4、`--cache-dir ../../../escape-__pycache__` 退出 12 且不写文件。

> 测试里给子进程加了 `PYTHONIOENCODING=utf-8`：工具输出的是 UTF-8 JSON（`note` 含中文），而子进程 stdout 走管道时
> 默认用 locale 编码（Windows 上是 cp936），不强制就会在父进程按 UTF-8 解码时变成替换字符、断言随之失真。

### 1g-2. 全运行缓存边界的最终判定（0 次模型调用）

```powershell
python tests/verify-cache-boundary.py --run-id <runId> --evidence-dir docs/evidence/<runId> `
  --baseline docs/evidence/<runId>/cache-before.json --postrun docs/evidence/<runId>/cache-postrun.json `
  --out docs/run-records/<runId>/cache-boundary.json --pretty
```

- **为什么有它**：工作流脚本没有文件系统 API，它的 `ok: true` 只能是**运行内暂定结果**（返回值写 `verdict: 'PROVISIONAL_OK'`
  + `verdictScope: 'provisional-in-run'`）——最后一个观测点是 Review 自报的执行后清单，Review 返回之后的写入它看不见。
  最终是否通过由这个外层工具判：它把**运行前基线 + 各阶段 `bytecode_scope` 观测点 + 运行后快照**串成一条时间线，逐段比较。
- **只生成 `cache-postrun.json` 而不消费它，等于没做**：判定必须真的读入最终快照并参与比较。
- 判定：`CLEAN`（0，全程无违反）/ `NOT_CLEAN`（10，有创建/删除/内容变化/超容差 mtime 变化）/ `INCOMPLETE`（11，
  快照缺失或读不出来、路径越界、`run_id` 或 `cache_dir` 与本次运行不符、阶段观测点不可用、时间不可解析）；
  参数错误 4、IO 错误 5。**快照不完整时不给"完整通过"**。
- 输出含 `checks`、`problems`、`violations`、`timeline[]`（每个观测点带 `entries` 计数与逐文件 `sha256`）、
  `coverage.unobservedWindow`（"写完又改回原样、且 mtime 变化不超过 5 毫秒"属不可观测范围）、`coverage.usesModelCalls: false`。
- 进程级测试 `tests/test_cache_boundary.py`（**7 个用例**）：内部 `ok` 但最终缓存变化 ⇒ `NOT_CLEAN`；最终快照缺失 ⇒ `INCOMPLETE`；
  全程一致 ⇒ `CLEAN`（时间线含 6 个观测点：基线 + 2 个阶段各前后 2 点 + postrun）；采集工具自身不生成字节码；
  另有 `run_id` 不符 ⇒ `INCOMPLETE`、阶段观测点不可用 ⇒ `INCOMPLETE`、最终快照出现新增文件 ⇒ `NOT_CLEAN`。

### 1h. 离线用量报告（只读会话日志，不调用模型）

```powershell
node tests/extract-usage-report.mjs `
  --run-id v0.2-run2-20261017T133204Z `
  --run-record docs/run-records/v0.2-run2-20261017T133204Z `
  --out-dir docs/run-records/v0.2-run2-20261017T133204Z/usage `
  --declared-budget docs/run-records/v0.2-run2-20261017T133204Z/usage/declared-budget.json
```

- 从 DSH 会话日志（多帧 zstd 或纯 JSONL）读 `assistant/message` 的 `usage`，按本次 workflow 的 `childSessionId` 集合归因；
  **默认排除父会话**，再派生的会话单独列出，不在作用域的会话只计数不静默当 0。输出两份：
  `usage-report.json`（确定性：同样的日志必然逐字节相同）与 `extraction-metadata.json`（易变：提取时间、日志指纹）。
- 字段口径：`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens` **分开报原始值**；
  不默认四者互相独立、不相加冒充准确 total（实测 `totalTokens == input + cacheRead + cacheWrite + output` 的关系记在报告里，
  并在 184 条消息上核对 `mismatched = 0`）；`cacheWriteTokens` 为 0 只说明"本次没观察到写缓存"，**不能**推断 provider 不支持上报。
- 预算判定：未声明 ⇒ `NO_BUDGET_DECLARED`；日志缺失/坏帧/坏行/缺 usage ⇒ `INCOMPLETE`（绝不会输出"完整预算内"）；
  只有运行前声明过的上限才做超限判定，`observedCallSessions > maxAgentCalls` ⇒ `OVER_BUDGET`。
  `maxTotalTokens: null` 表示批准消息没有 token 上限，因此**不做** token 超限判定；也不输出货币成本（未提供价格）。
- 轮次口径：`native-events.json` 的 `agentCalls` 里**没有** `attempt` 字段，轮次由阶段名后缀派生
  （`coding` → 第 1 轮，`coding-revision-2` → 第 2 轮，标签里的 `(revision N)` 作兜底）；
  报告同时给出每个会话的 `attempt`、`totals.attempts` 与按"轮次 + 阶段 + 代理 + 模型"分组的
  `totals.byAttempt`——返工轮次的花费必须能单独看出，不能混进合计。轮次是名字派生的，
  记录侧改名就会失真，这一条写进了报告的 `limitations`。
- 合成日志测试 `tests/usage-report.test.mjs`（**13 场景 / 75 项断言**）：正常、缺 usage、明确 0 与缺字段、重复事件、
  累计口径、不同 provider 语义、缺子会话、再派生、坏日志、未声明预算与超额、两次运行确定性、参数错误退出 4、
  缺 `attempt` 时按阶段名派生轮次并分组汇总。
- **路径脱敏**（报告要进公开仓库）：会话日志里带本机用户名，且 DSH 的会话组目录名是按 cwd 编码的
  （`--C-Users-<用户名>-...`）。因此日志路径一律写成 `<DSH_HOME>/sessions/<group>/session-<id>/session.v4.jsonl.zstd`，
  只保留会话 id；易变元数据里也不再写本机 `cwd` 绝对路径（改为工作区名字）。`usage-report.json` 与时间无关，两次运行
  逐字节相同（实测 sha256 一致），`extraction-metadata.json` 才带提取时间。

### 1i. 内联脚本指纹自检（0 次模型调用）

脚本以**纯文本**内联进 `workflow` 调用（宿主 `workflow` 工具的入参只有 `script`/`meta`/`args`，**没有文件路径参数**；
脚本本身也没有文件系统 API），2000+ 行逐字转录可能漏行：`v0.3-run3` 就漏了 `REVIEW_SCHEMA` 里 `issues.items.type`，
宿主在第 5 次调用前以"schema 不在支持子集内"拒绝，4 次调用白花（缓存边界仍是 `CLEAN`，但本次运行没有产出审核结论）。

- `node tests/script-fingerprint.mjs --schemas-only`：跑一次两轮模拟（8 次调用：预检 / 需求 / 编码 / 验证 / 审核 + 编码 / 验证 / 审核修订），
  只输出 `{ "<label>": { "schema": "<driftHash>" } }`——**这是唯一可以带进真实运行的夹具产物**，直接作为 `args.selfCheck`。
  不带 `--schemas-only` 时输出 `{ "<label>": { "prompt": …, "schema": … } }`，其中的**提示词指纹依赖夹具的需求与阶段结果**
  （不同 `runId`、不同需求、不同阶段结果都会变），拿去做真实运行会误报 `SCRIPT_DRIFT`。
- `node tests/script-fingerprint.mjs --check`：5 项自检——正确指纹必须通过；篡改 `Review Agent` 的 schema 指纹必须
  只发出 4 次调用（Review 未启动）；`selfCheckRequired: true` 但没给指纹必须 0 次调用即中止；不提供 `selfCheck` 的旧方式仍可用
  且返回值如实写 `scriptSelfCheck.enabled: false`；**只固定 schema** 时运行必须成功、且 `scriptSelfCheck.unchecked` 恰好 5 条
  （每条 `fields === ['prompt']`）——"没有比对"必须能被看见。
- 指纹算法（`driftHash` = FNV-1a 32 位 + djb2 32 位 + 字符数）在脚本与测试里**各实现一次**：两份实现对同一文本必须给出同一结果，
  这本身就是一条被断言的性质；它只用于发现转录漂移，不是密码学校验，不参与安全判定。
- 局限（不得越界表述）：`selfCheck` 只覆盖"schema + 各阶段提示词"，且真实运行里通常只有 schema 有固定期望值；
  提示词只能按真实输入逐阶段核对，没固定的会进 `scriptSelfCheck.unchecked`。判定逻辑（`judgeAttempt` 等）的转录漂移仍要靠
  执行前的 §1j 与运行后的 `tests/extract-native-events.mjs`（`invocation.scriptMatchesRepo`）核对。它不额外启动任何模型调用。

### 1j. 执行前校验：内联脚本的载荷与 schema（0 次模型调用）

`node tests/preflight-workflow-script.mjs --payload <文件> --commit <SHA> [--repo-file workflows/three-agent-mvp.js] [--out <json>] [--json]`

- **比较对象**：`git show <SHA>:workflows/three-agent-mvp.js` 的**源码字节**（先把 `--commit` 用 `git rev-parse` 固定成完整 SHA），
  与"准备提交的脚本文本"逐字节比较——不是拿执行副本跟它自己比。
- **字节策略只有三条**：逐字节相同即通过；**唯一**允许的规范化是把末尾连续换行压成一个 `\n`（`normalizeTrailingNewline`）；
  其余任何差异（判定代码改动、漏行、只改注释、CRLF）一律不通过，不做"语义等价"豁免。报告同时给 `sha256Raw`、
  `sha256Normalized`、`trailingNewlines`、`byteDelta`、`firstDifference`（offset/line/byte）。
- **schema 全量检查**：用 `runSource` + 两轮模拟计划在本地执行**载荷文本本身**，按 `JSON.stringify` 去重采到 5 个 schema
  （预检 / 需求 / 编码 / 验证 / 审核），逐个跑 `schemaViolations()`——这是宿主支持子集规则的本地实现（`type`/`oneOf`/
  `properties`/`required`/`additionalProperties`/`items`/`enum`/`const` + 注释键，错误文本与宿主一致）。
  run3 的 `schema.properties.issues.items.required requires type or oneOf` 这类错误能在 **0 次真实调用**时被发现。
- **能力边界写进报告**：`hostCapabilities = { machineScriptTransfer: 'unsupported-by-tool-schema', zeroCallSchemaValidation: 'unavailable',
  agentCalls: { real: 0, simulated: 8 } }`。依据是 asar 内的实现（`dsh-tool-workflow` 的 `parameters` 只有 `script`/`meta`/`args`；
  真正的子集校验发生在 `dsh-workflow-ptc` 的 `assertObjectJsonSchema`，位于 `agent()` 调用链内部）。**本地 PASS ≠ 宿主已接受**，
  **也不能证明"实际提交的文本 = 校验过的载荷"**——后者只能靠运行后的 `invocation.scriptMatchesRepo`。
- 退出码：`0` 通过 / `10` 字节不一致 / `11` schema 不合法 / `12` 两者都不合格 / `13` 载荷读取失败 / `4` 用法错误 / `5` git 或 IO 失败。
- 反向测试 `node tests/preflight-script.test.mjs`：9 场景 42 断言——逐字节相同 → PASS 且 `agentCalls.real === 0`；只多一个末尾换行
  → PASS 但原始哈希不同、`byteDelta === 1`；`REVIEW_SCHEMA.issues.items` 删掉 `type` → 退出 12、点名 `Review Agent`、
  违规含 `requires type or oneOf`；`if (!decision.ok) {` 改成 `=== false` → 退出 10（判定代码改动不得豁免）；
  删一行 `log(...)` → 退出 10；只改注释 → 退出 10；CRLF → 退出 10；纯函数 `schemaViolations` 对删掉 `type` 的 Review schema
  报出 `required`/`additionalProperties`/`properties` 三条 `requires type or oneOf`；缺 `--commit` → 退出 4。

### 3. 编排层独立复核

编排层（不是三个角色）另行编写了独立复核脚本，直接对交付实现验算需求文件中的边界条件与验收口径，并静态检查实现是否只用标准库：

```powershell
python -B docs/evidence/v0.1-second-run/orchestrator-verification.py
python -B docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6.py
```

三次真实运行的复核结果：第一次 45 项检查、第二次 266 项检查、run 6 共 280 项检查（0 失败 / 1 跳过，跳过项与勘误见
`docs/evidence/v0.1-run6-20261016T154400Z/ERRATUM-BC-07-CITATION.md`）。

v0.2-run1 起，复核不再是一次性脚本，而是可重复运行的正式工具：

```powershell
# 单次运行的证据复核（70 项检查；--self-test 跑 14 个夹具确认"该拒的拒、不该拒的不误拒"）
python tests/review-run-evidence.py --run-id v0.2-run2-20261017T133204Z `
  --mapping docs/run-records/v0.2-run2-20261017T133204Z/requirement-mapping.json `
  --allow-scope tests/workflow-harness.mjs --allow-scope workflows/three-agent-mvp.js  # 逐条列出，不静默跳过
python tests/review-run-evidence.py --self-test

# 一次跑完全部复核项，原始输出与 JSON 全部写进**你指定的唯一目录**（UTF-8 / LF，附 suite-results.json）
python tests/run-review-suite.py --run-id v0.2-run2-20261017T133204Z `
  --out-dir docs/run-records/v0.2-run2-20261017T133204Z/review-package `
  --parent-session <sessionId> --workflow-name tla-v02-run2 --since 2026-10-17T21:32:04+08:00

# 宿主原生事件（白名单字段，不导出消息正文）：调用次数、父会话、深度、脚本指纹、产物归因
node tests/extract-native-events.mjs --parent <sessionId> --workflow-name tla-v02-run2 `
  --since 2026-10-17T21:32:04+08:00 --evidence-dir docs/evidence/v0.2-run2-20261017T133204Z `
  --script-file docs/run-records/v0.2-run2-20261017T133204Z/workflow-script-at-run.js `
  --out docs/run-records/v0.2-run1-20261017T121445Z/native-events.json
```

- `review-run-evidence.py` 的判定口径与生产门禁一致（时间窗口 6 小时、缺失时区直接判不完整），
  **空验收集合、重复指纹、三报告冲突字段、37 条到 AC/BC 的映射完整性**都有对应用例，不能靠"全部通过"自证；
- `--allow-scope` 用于"运行结束后被人**工授权**改动的工作树路径"：每一条都以 `workspace.allow_scope_exclusions*`
  检查项原样打印并写入 JSON，**不允许静默跳过**；
- `run-review-suite.py` 的写入范围是**你给的 `--out-dir`**（拒绝覆盖已存在的非空目录，exit 2），加上被测工具自己
  按契约产生的临时目录（`tests/.scratch/`、`examples/text-stats/.test-scratch/`）；它不会改写任何被跟踪的仓库文件，
  也不会把输出写回上一轮的归档目录。`--out-dir` 会**原样传给每个会写文件的子工具**（review/probe/mutation 的
  `--json-out`、native 提取的 `--out`），不是只换文本输出目录；`--timeout` 超时记为失败（exit 124）并继续跑完其余命令，
  `suite-results.json` 里同时记录 `timedOut`、`failed` 与每个子进程的 `PYTHONDONTWRITEBYTECODE=1`；
- 这套管线自身的离线测试在 `tests/test_run_review_suite.py`（10 个用例：拒绝覆盖、参数真正传下去、
  超时不丢结果且收尾返回 1、归档目录返回 2、子进程环境变量）与 `tests/test_mutation_gate.py`
  （6 个用例：变异体"被抓住"的行为关键词判据、run2 真实用例名回归、提示不得退回固定用例名）；
- **命令比对的口径**（v0.2-run2 之后修）：注入的 `testCommand` 允许带固定前缀
  `$env:PYTHONDONTWRITEBYTECODE = '1'; `（R-33 的写入边界需要它）。`command_is_canonical` 先剥离
  **逐字符已知**的这几种前缀再比对；前缀里换了值（如 `= '0'`）仍然算不 canonical，两条都有夹具。

### 4. 工作流执行证据（比测试结果更重要的部分）

`docs/evidence/<runId>/` 下保留**每个 Agent 自己写出的**原始结论（JSON 信封）、编排层核验记录与 DSH 原生执行事件：

| 文件 | 由谁产生 | 内容 |
| --- | --- | --- |
| `preflight.json` | Verifier Agent（preflight） | 只读预检结果（证据目录状态、提示词齐备性、路径解算） |
| `requirement.json` | Requirement Agent | 结构化需求（目标、范围、验收条件、边界条件、一致性自检） |
| `coding-report.json` | Coding Agent | 文件清单、实现说明、真实测试命令与退出码、与需求的偏差 |
| `verify.json` | Verifier Agent（verify） | 独立复跑的原始输出、退出码、用例数、产物 sha256 |
| `review.json` | Review Agent | 逐条验收条件判定、问题清单、最终结论 |
| `cache-before.json` | `tests/collect-cache-state.py`（运行前、任何子代理启动前） | 运行前缓存基线快照（含 `run_id`） |
| `cache-postrun.json` | `tests/collect-cache-state.py`（运行结束后、其他测试或导入前） | 确定性补采的缓存最终清单，必须被 `verify-cache-boundary.py` 消费 |
| `dsh-native-events.json` | 编排层（只读会话日志提取） | 脱敏的 DSH 原生执行事件（会话标识、时间、turn/step、工具调用），用于证明"确实是独立子代理" |
| `test-output.txt` | 编排层（人工可复现） | 提交前复跑测试的原始输出 |
| `README.md` | 编排层 | 本次运行记录：时间、命令、环境、核验结论、诚实记录 |

### 5. 提交前必做的通用检查

见 `AGENTS.md` 第 8 节（`git status` / `git diff --check` / 敏感信息扫描 / `.gitignore` 覆盖 / 测试通过 / 文档同步）。

## 规划

- V0.2 起：多模型分工（按角色分配模型）与状态持久化/续跑的验证也会落到本目录。
- V0.3 起引入测试 Agent 与项目级测试框架（`docs/ROADMAP.md` V0.3），届时本目录承载 TLA 自身的单元测试与集成测试。

### Synthetic implementation-write review diagnostics

```text
node tests/v02-write-review-diagnostics.test.mjs
```

Seventeen synthetic scenarios cover unfinished/failed/completed unreviewed
repairs, superseded rejection epochs, every uncovered path/write, later rewrites,
legitimate historical passes, work diagnostics, replay/immutability, Windows path
normalization and no-write/note-only/invalid-prefix boundaries. No host or model
is started. This is an independent formal core regression; the DSH handoff
regression package remains separately maintained and is not copied into this test.

### Round6 maintenance checks

`node tests/v02-migration-links.test.mjs` exercises real checkout/OS-temp links,
ordinary-directory rejection and an isolated directory-like lstat simulation.
Set `TLA_LINK_TEST_ROOT` to an existing writable volume directory to relocate
fixture creation; tests never skip failed link capabilities.

`node tools/self-check/write-review-mutations.mjs [empty-output-directory]`
first requires a green baseline, copies only local dependencies, applies three
exact one-occurrence substitutions and requires syntax success plus an assertion
failure (module-load errors do not qualify). Each mutant gets patch.json, test.log
and hashes in report.json. The source checkout is never mutated. Keep generated
logs outside tracked files. `v02-write-review-diagnostics` now has 18 scenarios.
