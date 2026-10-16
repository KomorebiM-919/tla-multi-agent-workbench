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
preflight → requirement → [ coding → verify → review ] × (最多 maxCodingAttempts 轮)
```

审核不通过时，脚本把该轮问题清单与编排层的判定原因**回注**给新的 Coding Agent 实例（`coding-report-revision-2.json` 等），再验证、再复审。

### 成功判定（`ok: true` 的充分必要条件）

只有当以下**全部**成立时才输出成功——不再只看 Review 的结论：

- Requirement 自检无未解决冲突；
- Coding Agent 自述测试通过；
- Verifier（verify）独立复跑的原始输出通过（退出码 0 + `Ran N tests` + `OK` + 无 `FAILED`）；
- 二者结论一致（自述成功但独立验证失败 ⇒ `INCONSISTENT_EVIDENCE`）；
- Review 返回 `APPROVED`，且它自己复跑的原始输出也通过；
- Review 的 `criteria_check` **覆盖全部验收条件**且逐条 `satisfied: true`。

任何一条不满足都会返回明确的失败状态码，例如：`TEST_NOT_VERIFIED`、`INCONSISTENT_EVIDENCE`、`INCONSISTENT_REVIEW`、`CRITERIA_NOT_SATISFIED`、`CRITERIA_CHECK_INCOMPLETE`、`REVIEW_NOT_APPROVED`、`REQUIREMENT_CONFLICT`，轮次用尽时前缀 `MAX_ATTEMPTS_`。

### 输入（`args`）

```json
{
  "runId": "v0.1-second-run",
  "evidenceDir": "docs/evidence/v0.1-second-run",
  "promptDir": "agents",
  "runStartedAt": "2026-10-16T19:48:21+08:00",
  "task": {
    "requirement": "<自然语言需求，可选；不传则用脚本内置演示需求>",
    "targetDir": "examples/text-stats",
    "moduleFile": "text_stats.py",
    "testFile": "test_text_stats.py",
    "sampleFile": "sample_input.txt",
    "testCommand": "python -m unittest discover -s examples/text-stats -p \"test_*.py\"",
    "maxCodingAttempts": 2
  }
}
```

参数校验（**校验失败即 `INVALID_ARGS`，不启动任何子代理**）：

| 参数 | 规则 |
| --- | --- |
| `runId` | 必填，`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`；不得包含路径分隔符 |
| `evidenceDir` | 必填，必须位于 `docs/evidence/` 下，且**最后一段目录名必须等于 `runId`** |
| `promptDir` | 提示词目录（默认 `agents`），其中的角色文件必须存在，否则 `PROMPT_MISSING` |
| `task.targetDir` | 仓库内相对路径；拒绝绝对路径、盘符、`..` 穿越、反斜杠 |
| `task.moduleFile` / `testFile` / `sampleFile` | 仅文件名（无目录成分） |
| `task.testCommand` | 默认由 `targetDir` 推导为 `python -m unittest discover -s <targetDir> -p "test_*.py"`；显式传入时**只接受该规范命令（可加 `-v`）**，任意 shell 命令一律拒绝 |
| `task.maxCodingAttempts` | 1–5 的整数；0、小数、字符串、超大值一律 `INVALID_ARGS` |
| `runStartedAt` | 可选；提供时必须是合法 ISO 时间且与子代理时间戳同窗，否则 `INVALID_TIMESTAMP`（防止用占位时间冒充真实记录） |

**证据保护**：若 `evidenceDir` 已存在（含指向 `v0.1-first-run` 这类历史归档的情形），脚本以 `EVIDENCE_EXISTS` 拒绝运行，绝不覆盖已有证据——每次运行必须使用新的 `runId`。

### 输出

结构化运行结果：`{ ok, status, runId, evidenceDir, pipeline, targetDir, testCommand, attempts, finalVerdict, finalDecision, attemptsDetail, originalRequirement, requirement, codingReports, finalReview }`。

`finalDecision` 逐项列出成功判定的依据（`testsIndependentlyVerified`、`reviewApproved`、`allCriteriaSatisfied`、`criteriaCheckCoversAll`、`reviewIndependentTestsPassed`），便于人工核查而不必信任一句 `ok`。

### 证据文件（写入 `evidenceDir`）

| 文件 | 产生者 |
| --- | --- |
| `preflight.json` | Verifier Agent（preflight） |
| `requirement.json` | Requirement Agent |
| `coding-report.json`（修订轮为 `coding-report-revision-<n>.json`） | Coding Agent |
| `verify.json`（修订轮同上） | Verifier Agent（verify） |
| `review.json`（修订轮同上） | Review Agent |

## 如何在本机运行（中文步骤）

1. 打开本机已安装的 **DeepSeek Harness** 桌面应用，新建会话并把工作目录指向**本项目根目录**。
2. 在会话里发送这样一句话（可原样复制；请务必换一个**新的 `runId`**）：

   > 请读取 `workflows/three-agent-mvp.js`，用 `workflow` 工具执行它。`args` 用：
   > `{"runId": "v0.1-third-run", "evidenceDir": "docs/evidence/v0.1-third-run", "promptDir": "agents", "runStartedAt": "<当前本地时间，ISO 格式>", "task": {"targetDir": "examples/text-stats", "maxCodingAttempts": 2}}`
   > 执行完把返回结果与我核对，并把证据归档到证据目录。

3. 编排代理会真实启动五个子代理（预检 → 需求 → 编码 → 验证 → 审核），每阶段的结论写入证据文件。
4. 运行结束后**自己去核对**（不要只依赖代理口述）：

   ```powershell
   python -m unittest discover -s examples/text-stats -p "test_*.py" -v
   Get-ChildItem docs\evidence\v0.1-third-run
   ```

5. 想观察"变更后再审"的修订循环：把 `task.requirement` 换成你自己的需求（例如"再增加一个统计项"），并给一个新的 `runId`。

> 注意：每次运行都会真实调用 DSH 子代理（消耗当前所配置模型的额度），不是离线模拟；运行前请确认模型与计费方式。

## 相关

- 角色提示词：`agents/`（含 `agents/verifier-agent.md`，说明 Verifier 只提供独立验证的原始证据，判定逻辑由本脚本持有）
- 工作流逻辑的回归测试（模拟子代理返回值）：`tests/workflow-logic.test.mjs`
- 两次真实运行的完整记录：`docs/evidence/v0.1-first-run/`、`docs/evidence/v0.1-second-run/`
