# workflows/ — DSH 工作流脚本

本目录存放 TLA 的**编排脚本**。脚本用 DSH 原生 `workflow` 工具的 JavaScript 形式编写，是"谁在什么时候调用哪个角色、结果怎么传递、什么算成功"的唯一来源；角色提示词在 `agents/`。

## `three-agent-mvp.js`（V0.1 首个 MVP）

**五个子代理角色**（每个都是一次独立的 `agent()` 调用，即独立的 DSH 子代理实例）：

1. `Verifier Agent`（MODE=preflight）：只读预检——仓库根、证据目录状态、提示词文件是否齐备、目标目录是否存在、解算后的路径。预检失败**不会**启动任何后续角色。
2. `Requirement Agent`：把自然语言需求整理为结构化需求（目标 / 范围 / 验收条件 / 边界条件），并做**验收条件与边界条件的一致性自检**。
3. `Coding Agent`：接收需求（结构化结果原样注入提示词）并在目标目录内实现代码与 `unittest` 测试，**自己真实运行测试**后报告。
4. `Verifier Agent`（MODE=verify）：**独立复跑**规范化测试命令，回传原始输出全文、退出码、用例数与产物 `sha256`。它不做判定、不改文件。
5. `Review Agent`：在独立上下文中读取需求、代码、验证结果，逐条判定验收条件，给出 `APPROVED` / `CHANGES_REQUESTED`。

**执行顺序与结果传递由脚本的编排逻辑保证**（`phase()` 仅用于进度展示，不产生执行依赖）：

```
preflight → requirement → [ coding → verify → review ] × (最多 maxCodingAttempts 轮) → cacheFinal
```

`cacheFinal`（`Cache Collector (after review)`）是**只读采集**阶段：它不跑测试、不改文件，只把 `<targetDir>/__pycache__`
在 Review 结束后的清单交回来。它存在的理由见下条"运行期写入边界"：只看两个验证阶段各自的前后不变，证明不了编码阶段和阶段间隙里没有写过缓存。

审核不通过时，脚本把该轮问题清单与编排层的判定原因**回注**给新的 Coding Agent 实例（`coding-report-revision-2.json` 等），再验证、再复审。

### 成功判定（`ok: true` 的充分必要条件）

只有当以下**全部**成立时才输出成功——不再只看 Review 的结论：

- Requirement 自检无未解决冲突，且验收条件 ID 唯一、可识别（缺失/重复 ID ⇒ `REQUIREMENT_IDS_INVALID`）；
- **任何阶段**（Coding / Verifier / Review）报告了未解决的需求冲突 ⇒ 立即判定为 `STAGE_REPORTS_REQUIREMENT_CONFLICT`，不再进入修订轮；
  该状态**优先于其他失败原因**（即使同时存在 Coding 报告不可用等次要问题，也报冲突状态），因为冲突只能由人工统一口径后重跑；
- Coding Agent 自述测试通过，且返回了可用的实现报告（缺 `files_created` ⇒ `CODING_OUTPUT_INVALID`）；
- Coding 自述**内部自洽**：`test_command` 必须是本次配置的规范命令、`test_exit_code` 必须是非负整数、
  `test_succeeded` 必须与退出码及输出摘录里的 `OK` / `FAILED` 标记一致（`true` + 非 0 退出码等矛盾 ⇒ `CODING_REPORT_INCONSISTENT`）；
- Verifier（verify）独立复跑的原始输出通过（退出码 0 + `Ran N tests` + `OK` + 无 `FAILED`，且 `N >= 1`）；
- 二者结论一致（自述成功但独立验证失败 ⇒ `INCONSISTENT_EVIDENCE`）；
- Review 返回 `APPROVED`，且它自己复跑的原始输出也通过，**执行用例数 `N >= 1` 且与 Verifier 对同一规范命令的用例数一致**
  （`Ran 0 tests` 或数量不一致 ⇒ `INCONSISTENT_REVIEW`）；
- Review 的 `criteria_check` 按**验收 ID 集合**逐项核对：缺 ID ⇒ `CRITERIA_CHECK_INCOMPLETE`、重复 ID ⇒ `CRITERIA_CHECK_DUPLICATE_IDS`、
  未知 ID ⇒ `CRITERIA_CHECK_UNKNOWN_IDS`，且每条 `satisfied: true`；
- Verifier 的 `artifacts` 与 Review 复核后重算的 `artifacts_after` 的**文件集合与 `sha256` 完全一致**，且该集合**恰好等于**
  本次配置的交付文件（`task.targetDir` 下的 `moduleFile` 与 `testFile` 两项）：缺项、多列无关文件（README、`.gitignore`、样例输入等）、
  同一路径重复出现，或验证前后不一致 ⇒ `ARTIFACT_FINGERPRINT_MISMATCH`（两份清单互相一致但都漏掉测试文件同样不通过）；
- 预检自身报告的问题清单必须为空（`problems` 非空 ⇒ `PREFLIGHT_PROBLEMS`，先由人处理再重跑）；
- **运行期写入边界（全运行账本）**：编排层在启动任何子代理**之前**采集的 `task.cacheBaseline` 是必填参数（缺 ⇒ `INVALID_ARGS`），
  Coding 报告、Verifier 与 Review 的 `bytecode_scope` 各自交回执行前/后清单，`cacheFinal` 交回 Review 结束后的清单；
  相邻两个观测点之间出现新增 / 重写 / 删除 ⇒ `BYTECODE_CACHE_CHANGED_ACROSS_RUN`（"两个验证阶段各自前后不变"只是必要条件）；
  单个阶段自己前后变了 ⇒ `BYTECODE_CACHE_WRITTEN`；`env_applied` 不为 `true` ⇒ `BYTECODE_ENV_NOT_APPLIED`；
  清单缺失、类型不对、路径不在缓存目录下、重复路径 ⇒ `BYTECODE_SCOPE_UNMEASURED`。四者都在 `REVIEW_NOT_APPROVED` 之前判不通过；
  优先级：`BYTECODE_CACHE_WRITTEN` > `BYTECODE_CACHE_CHANGED_ACROSS_RUN` > `BYTECODE_ENV_NOT_APPLIED` > `BYTECODE_SCOPE_UNMEASURED`；
  **已存在缓存且全程前后逐字段一致不得被误拒**；
  判定"重写"的口径是**内容身份**（`bytes` + `sha256`）加 `mtime_ms` 容差 `MTIME_TOLERANCE_MS = 5` 毫秒：
  同一份文件被不同子代理报成 `1792240028919` 与 `1792240028919.332` 属于表示精度差，不算重写（v0.2-run2 因此误报 4 条）；
  另有强制提示：**该阶段内任何 Python 调用都必须带同一环境前缀**（不只是测试命令），超出前缀范围的真实写入会被全运行账本抓住。

其他失败状态码：`TEST_NOT_VERIFIED`、`INCONSISTENT_REVIEW`、`CODING_REPORT_INCONSISTENT`、`CRITERIA_NOT_SATISFIED`、`REVIEW_NOT_APPROVED`、
`BYTECODE_CACHE_CHANGED_ACROSS_RUN`、`BYTECODE_CACHE_WRITTEN`、`BYTECODE_ENV_NOT_APPLIED`、`BYTECODE_SCOPE_UNMEASURED`、
`REQUIREMENT_CONFLICT`、`PREFLIGHT_PROBLEMS`、`PATH_NOT_NORMALIZED`、`PATH_TARGET_MISMATCH`、`TARGET_DIR_OUTSIDE_REPO`、`LINK_ESCAPE`、
`EVIDENCE_NOT_CLAIMED`、`EVIDENCE_EXISTS`、`PREFLIGHT_FAILED`、`NO_ATTEMPT`、`INVALID_ARGS`、
`INVALID_TIMESTAMP`、`PROMPT_MISSING`、`REQUIREMENT_OUTPUT_INVALID`、`REQUIREMENT_IDS_INVALID`；轮次用尽时前缀 `MAX_ATTEMPTS_`。

### 输入（`args`）

```json
{
  "runId": "v0.1-run6-20261016T160000Z",
  "evidenceDir": "docs/evidence/v0.1-run6-20261016T160000Z",
  "promptDir": "agents",
  "runStartedAt": "2026-10-17T00:00:00+08:00",
  "task": {
    "requirement": "<自然语言需求，可选；不传则用脚本内置演示需求>",
    "targetDir": "examples/text-stats",
    "moduleFile": "text_stats.py",
    "testFile": "test_text_stats.py",
    "sampleFile": "sample_input.txt",
    "testCommand": "python -m unittest discover -s examples/text-stats -p \"test_*.py\"",
    "maxCodingAttempts": 2,
    "cacheBaseline": []
  }
}
```

`task.cacheBaseline`：**必填**数组，内容是启动前实际采集的 `<targetDir>/__pycache__` 清单（每项 `path`/`bytes`/`mtime_ms`/`sha256`，
`path` 为仓库内相对路径且必须在缓存目录下）；缓存目录不存在就传空数组 `[]`。它是全运行写入边界比较的起点——
不传、不是数组、条目字段不合法、路径越界或重复 ⇒ `INVALID_ARGS`（**不允许**用"默认空数组"代替实测）。

参数校验（**校验失败即 `INVALID_ARGS`，不启动任何子代理**）：

| 参数 | 规则 |
| --- | --- |
| `runId` | 必填，`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`；不得包含路径分隔符；**必须以 `-<UTC 时间戳>`（`YYYYMMDDTHHMMSSZ`）结尾，且该时间戳与 `runStartedAt` 落在同一秒**（例：`v0.1-run5-20261016T152321Z`），把"防覆盖"做成命名约束 |
| `evidenceDir` | 必填，必须位于 `docs/evidence/` 下，且**最后一段目录名必须等于 `runId`**；运行开始时由预检调用 `tools/claim_evidence_dir.py` 排他写入认领文件 `.run-owner.json`（已有认领不得覆写），未认领或认领不合法即 `EVIDENCE_NOT_CLAIMED` |
| `promptDir` | 提示词目录（默认 `agents`），其中的角色文件必须存在，否则 `PROMPT_MISSING` |
| `task.targetDir` | 仓库内相对路径；拒绝绝对路径、盘符、`..` 穿越、反斜杠 |
| `task.moduleFile` / `testFile` / `sampleFile` | 仅文件名（无目录成分） |
| `task.testCommand` | 默认由 `targetDir` 推导为 `python -m unittest discover -s <targetDir> -p "test_*.py"`；显式传入时**只接受该规范命令（可加 `-v`）或带固定环境前缀的同一命令**（`$env:PYTHONDONTWRITEBYTECODE = '1'; ` + 规范命令），任意其他 shell 命令一律拒绝 |
| `task.maxCodingAttempts` | 1–5 的整数；0、小数、字符串、超大值一律 `INVALID_ARGS` |
| `task.cacheBaseline` | **必填**数组：启动前实测的 `<targetDir>/__pycache__` 清单（`path`/`bytes`/`mtime_ms`/`sha256`）；目录不存在传 `[]`；缺失或条目不合法 ⇒ `INVALID_ARGS` |
| `runStartedAt` | 可选；必须是**合法的、带时区的 ISO-8601 日历时间**（`2026-02-30`、`25:00`、`+25:00` 一律非法 ⇒ `INVALID_ARGS`），且必须与 `runId` 的时间戳同秒；**省略时由 `runId` 的 UTC 时间戳还原**（时间窗门禁不会因为省略该参数而失效）。它还必须是**这次真实运行的起点**：与编排层实际时间相差超过 1 小时即 `INVALID_ARGS`（把 `runId` 与 `runStartedAt` 一起改成旧时间也会被拦下）。子代理产物（preflight / requirement / coding-report / verify / review）的时间戳必须落在运行窗口（默认 6 小时，含 60 秒时钟偏差容差）内且**不得晚于编排层当前时间**，否则 `INVALID_TIMESTAMP`（防止用占位时间或未来时间冒充真实记录） |

**路径与认领校验**（预检阶段，任一不满足即 fail-closed，不进入需求阶段）：交付目录与证据目录必须回报 `realpath`，且两者的真实路径都必须位于仓库根之内（⇒ `TARGET_DIR_OUTSIDE_REPO`）；
`repo_root`、`repo_root_realpath`、`target_dir_realpath`、`evidence_dir_realpath`、`link_components`、`resolved_paths` 中出现未规范化的点段（`.`、`..`、空段）⇒ `PATH_NOT_NORMALIZED`；
`target_dir`、`target_dir_realpath`、`evidence_dir_realpath` 必须与本次配置逐项对应（⇒ `PATH_TARGET_MISMATCH`）；
解算路径中出现指向仓库之外的链接组件 ⇒ `LINK_ESCAPE`；证据目录必须由 `tools/claim_evidence_dir.py` 本次排他认领成功
（`evidence_dir_claimed: true`、`claim_created: true`、`claim_tool: "tools/claim_evidence_dir.py"`、`claim_exit_code: 0`、`owner_marker_path` 属于本次运行）⇒ 否则 `EVIDENCE_NOT_CLAIMED`。
预检自报的 `evidence_dir_state`（它认领**之前**观察到的状态）必须与认领工具自报的 `evidence_dir_state_before` 完全一致，
且后者只接受 `missing` / `empty`：两者不一致、或工具报告 `exists`（目录里已有内容）⇒ 同样是 `EVIDENCE_NOT_CLAIMED`
——这条把"目录到底是不是空的"从代理的自述变成工具实测，认领之后再出现的 `.run-owner.json` 属于正常的"认领后"状态，不作为 `EVIDENCE_EXISTS` 判据。
预检产物的 `problems` 数组非空 ⇒ `PREFLIGHT_PROBLEMS`（先由人处理，再以新 `runId` 重跑）：凡是代理认为"可能越出仓库、与 `runId` 冲突、缺失或不确定"的观察都必须写进 `problems`，写进去就会停跑；结构化字段仍必须填准。
Verifier 的哈希一律对文件**原始字节**计算（二进制读取；Windows 上不得用文本模式读文件，否则行尾转换会让哈希偏离）。

**两个时钟分开**（复审后的收口）：`runStartedAt` 只与**启动时钟**（脚本开始执行时读到的当前时间）比较，用于确认"这确实是本次运行的起点"；
每个 Agent 返回后脚本都**重新读取**当前时间，再与该阶段产物里的 `generated_at` 比较——这样"阶段时间戳晚于当前时间"是拿判定当刻的时钟判的，
而不是拿启动时刻判的（否则一个跑了很久的运行会误判）。窗口判定仍以 `runStartedAt` 为锚点（默认 6 小时 + 60 秒偏差容差）。

**证据保护**：若 `evidenceDir` 已存在（含指向 `v0.1-first-run` 这类历史归档的情形），脚本以 `EVIDENCE_EXISTS` 拒绝运行，绝不覆盖已有证据——每次运行必须使用新的 `runId`；新目录也必须先由预检调用认领工具成功创建 `.run-owner.json` 才会继续，而在预检拒绝（未认领 / 路径越界 / 已有认领）时认领工具**不写任何文件**。

### 输出

结构化运行结果：`{ ok, status, error, errors, runId, evidenceDir, ownerMarkerPath, runStartedAt, pipeline, targetDir, testCommand, testEnvironment, testExecutionCommand, cacheBaseline, cacheDirPrefix, maxCodingAttempts, criteriaIds, evidenceFiles, attempts, originalRequirement, requirement, requirementSelfCheck, preflight, attemptsDetail, finalVerdict, finalReview, finalDecision }`。
每一轮的 `codingReport` / `verification` / `review` 与编排层判定都挂在该轮的 `attemptsDetail[n]` 下（没有 `codingReports` 之类的顶层键）。

`finalDecision` 逐项列出成功判定的依据（`testsIndependentlyVerified`、`reviewApproved`、`allCriteriaSatisfied`、`criteriaCheckCoversAll`、`reviewIndependentTestsPassed`、`fingerprintsMatch`、`stageReportedRequirementConflicts`），便于人工核查而不必信任一句 `ok`；

失败时另外返回 `error`（可直接阅读的原因文本）与 `errors`（原因数组），以及 `criteriaIds`、`evidenceFiles`、`ownerMarkerPath` 等核查字段。

### 证据文件（写入 `evidenceDir`）

| 文件 | 产生者 |
| --- | --- |
| `preflight.json` | Verifier Agent（preflight） |
| `.run-owner.json` | `tools/claim_evidence_dir.py`（预检阶段调用）：本次运行对证据目录的**排他**认领标记（`O_EXCL` 创建，已有认领拒绝覆写；防止与其他运行/历史归档混用） |
| `requirement.json` | Requirement Agent |
| `coding-report.json`（修订轮为 `coding-report-revision-<n>.json`） | Coding Agent |
| `verify.json`（修订轮同上） | Verifier Agent（verify） |
| `review.json`（修订轮同上） | Review Agent |

## 如何在本机运行（中文步骤）

1. 打开本机已安装的 **DeepSeek Harness** 桌面应用，新建会话并把工作目录指向**本项目根目录**。
2. 在会话里发送这样一句话（可原样复制；请务必换一个**新的 `runId`**）：

   > 请读取 `workflows/three-agent-mvp.js`，用 `workflow` 工具执行它。`args` 用：
   > `{"runId": "v0.1-run7-<UTC 紧凑时间戳，形如 20261016T160000Z>", "evidenceDir": "docs/evidence/v0.1-run7-<同一个时间戳>", "promptDir": "agents", "runStartedAt": "<与 runId 时间戳同一秒的本地时间，ISO 格式>", "task": {"targetDir": "examples/text-stats", "maxCodingAttempts": 2}}`
   > 执行完把返回结果与我核对，并把证据归档到证据目录。

3. 编排代理会真实启动五个子代理（预检 → 需求 → 编码 → 验证 → 审核），每阶段的结论写入证据文件。
4. 运行结束后**自己去核对**（不要只依赖代理口述）：

   ```powershell
   python -m unittest discover -s examples/text-stats -p "test_*.py" -v
   Get-ChildItem docs\evidence\v0.1-run7-20261016T160000Z

   # 返回值 ↔ 磁盘证据交叉检查（逐次尝试核对指纹、ID 集合、证据文件）
   python -B docs/evidence/v0.1-second-run/cross-check-workflow-result.py --result docs/evidence/v0.1-run7-20261016T160000Z/workflow-result.json --evidence-dir docs/evidence/v0.1-run7-20261016T160000Z
   ```

   > 交付测试需要一个已存在的 `examples/text-stats/.test-scratch/` 目录（仓库里由已跟踪的占位文件
   > `examples/text-stats/.test-scratch/.gitkeep` 提供）。若从导出的目录树（例如只解出被跟踪文件、没保留空目录的归档）运行，
   > 先 `mkdir -p examples/text-stats/.test-scratch` / `New-Item -ItemType Directory -Force examples\text-stats\.test-scratch`。

5. 想观察"变更后再审"的修订循环：把 `task.requirement` 换成你自己的需求（例如"再增加一个统计项"），并给一个新的 `runId`。

> 注意：每次运行都会真实调用 DSH 子代理（消耗当前所配置模型的额度），不是离线模拟；运行前请确认模型与计费方式。

## 相关

- 角色提示词：`agents/`（含 `agents/verifier-agent.md`，说明 Verifier 只提供独立验证的原始证据，判定逻辑由本脚本持有）
- 工作流逻辑的回归测试（模拟子代理返回值，不调用真实子代理）：`tests/workflow-logic.test.mjs`（夹具与可控时钟在 `tests/workflow-harness.mjs`）
- 预检认领门禁的集成测试（真实调用认领工具，把它的 JSON 接入门禁）：`tests/preflight-claim-integration.test.mjs`
- 证据目录排他认领工具（预检调用，`O_EXCL` 创建 `.run-owner.json`）：`tools/claim_evidence_dir.py`；其进程级测试：`tests/test_claim_evidence_dir.py`
- 证据核查工具（都在 `docs/evidence/v0.1-second-run/`）：`cross-check-workflow-result.py`（返回值 ↔ 磁盘证据，逐次尝试核对指纹与 ID 集合；历史运行加 `--archived`）、`extract-native-events.mjs`（从 DSH 会话日志提取脱敏原生执行事件）、`make-review-manifest.py`（材料清单 + 逐文件 sha256 / git blob SHA-1）
- 真实运行的完整记录：`docs/evidence/v0.1-first-run/`、`docs/evidence/v0.1-second-run/`，以及首个通过运行的 `docs/evidence/v0.1-run6-20261016T154400Z/`（另有被门禁拦下的 run 3/4/5，见 `docs/evidence/` 与 `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md`）
