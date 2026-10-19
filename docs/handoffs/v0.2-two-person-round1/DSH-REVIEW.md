# DSH 独立复核：核心验收收紧（`6299924`）

## 0. 结论

本次审查对象是 `fix/v0.2-core-acceptance` 的提交
`629992424c0d0ebabccbb0fb723dd9ab8f3c73e6`（下称 `6299924`），基线为交接提交
`afead09bdbc996b4d428dbf95fc01dcf002f3e1f`（下称 `afead09`）。

**可接受的部分**：报告列出的 8 类反例都被当前补丁拦截；原有 19 项验收测试全部通过；
schema、CLI 参数和 10 个条件码未变。补丁本身是净改进，没有发现对正常输入的误伤。

**不能接受为“闭环完成”的部分**：

1. 采集链路仍无法把完整证据送入判定器。`summariseRun` 传出的写事件没有
   `kind/index/sha256`，测试没有 history，任务丢了 `subject`；因此 CLI 仍然不可能产出
   `closed`。这是已知缺口，不是本补丁引入的回归。
2. 发现一个新的 **P2 反例**：回读判定按数组顺序取“最后一次写”，而不是按 `index` 取最大写；
   乱序证据可以让一次并未覆盖最新写的回读被判为 `closed`。当前 8 个反例没有覆盖这一路径。

**建议**：把本补丁作为 V0.2 验收判据的候选纳入开发分支，但以修复 P2 排序缺陷为前提；
在采集链路补齐之前，不得据此宣布 V0.2 闭环或验收通过。

## 1. 基线与改动范围

| 项 | 值 |
| --- | --- |
| 审查分支 | `fix/v0.2-core-acceptance` |
| 完整 SHA | `629992424c0d0ebabccbb0fb723dd9ab8f3c73e6` |
| 基线 | `afead09bdbc996b4d428dbf95fc01dcf002f3e1f` |
| 关系 | 单父提交；`git merge-base` 等于 `afead09`；无 merge 提交 |
| 提交时间 | 2026-10-19T16:07:26+08:00 |
| 提交标题 | `fix(v0.2): reject incomplete acceptance evidence` |
| 远端核对 | 公开 API 的 `object.sha` 为上述完整 SHA，`object.type=commit` |

改动仅 4 个文件：

| 文件 | 改动 |
| --- | --- |
| `tools/acceptance-summary.mjs` | +25 / −7，仅验收判据 |
| `tests/v02-core-acceptance.test.mjs` | 新增 41 行，1 个正向 + 8 个反例 |
| `docs/handoffs/v0.2-two-person-round1/CORE-RETURN.md` | 新增 48 行交付说明 |
| `README.md` | +6 行入口说明 |

审查使用独立归档副本 `<review-copy>`，未合并、未 cherry-pick、未切换当前工作区；
当前工作区仍停在 `afead09`，`git status` 为空。

## 2. 8 类反例的实际结果

`node tests/v02-core-acceptance.test.mjs`：`core acceptance: 9 passed`。
逐项结果：

| 反例 | 结果 |
| --- | --- |
| 两个哈希都缺失 | `READ_BACK_AFTER_WRITE` 未满足 |
| 两个哈希都是 `unknown` | 同上 |
| 复审先通过、后拒绝 | `REVIEW_REJECTED_THEN_PASSED` 未满足 |
| 红测试的退出码为 `null` | `TESTS_RED_THEN_GREEN` 未满足 |
| 测试命令缺失 | 同上 |
| 最终 `passed=0` | `TESTS_GREEN` 未满足 |
| 4 个任务使用重复 id | `TASKS_COMPLETED` 未满足 |
| 实现路径含 `src/../sum.mjs` | `IMPLEMENTATION_FILE_CHANGED` 未满足 |

原有 `tests/v02-acceptance-summary.test.mjs`：`19 passed, 0 failed`，包括旧的
`closed` 输入、只写 `note.txt`、读在写之前、复审只拒绝等正常/异常输入。

补充的正常输入探针：十六进制大写哈希可以正常通过；`src/sum.mjs` 的常规写后回读
仍为 `closed`。没有发现补丁把正常输入误判为失败。

## 3. 独立发现

### 3.1 P2：回读排序按数组顺序，而不是按最新写

`tools/acceptance-summary.mjs:116-120` 用过滤后数组的最后一个元素作为
`lastImplementationWrite`，但回读条件却用 `read.index > write.index` 表示顺序。
两者不一致时，乱序数组可以产生假 `closed`：

```js
const h = 'a'.repeat(64)
const x = 'b'.repeat(64)
const input = { /* 其余条件均满足的 closed 输入 */ }
input.writes = [
  { kind: 'write', path: 'src/sum.mjs', index: 10, sha256: x },
  { kind: 'write', path: 'src/sum.mjs', index: 1,  sha256: h },
  { kind: 'read',  path: 'src/sum.mjs', index: 2,  sha256: h }
]
// 实际最新写是 index 10（哈希 x）；index 2 的读发生在此之前。
// 当前实现返回 verdict=closed、unmet=[]。
```

审查副本中的复现输出：`out-of-order-writes: verdict=closed unmet=(none)`。
同样，`index` 为字符串 `'1'` / `'2'` 也被接受（`string-index: closed`），
说明排序字段没有整数校验。

建议：按数值最大且为整数的 `index` 选择最新实现写；回读也必须是整数 `index`，
且严格大于最新写。当前 8 个反例应增加“乱序写”和“字符串 index”两例。

### 3.2 P3：`IMPLEMENTATION_FILE_CHANGED` 的 detail 统计口径

`tools/acceptance-summary.mjs:145` 使用 `writeList.length`，而不是
`implementationWrites.length`。只写 `note.txt` 时，条件为假但 detail 仍显示
“1 file event(s)”，容易把“有文件事件”误读成“实现文件被改”。不影响 verdict，
建议改为实现写计数。

### 3.3 P3：路径规范化假设未被执行

`isImplementationPath` 明确拒绝反斜杠，但 `readRuleUsage` 原样保留
`policyFacts.filePath`，没有做 `src/...` 规范化。当前采集器尚未传 `kind`，所以
这条路径暂时不会进入判定；一旦采集器补齐，Windows 日志里的 `src\sum.mjs`
会被判为不可接受的实现路径。建议在采集器入口统一转 `/`，或在判据中显式拒绝并
记录该假设。

### 3.4 采集链路缺口（已确认，非本补丁引入）

`CORE-RETURN.md` 的说明与实际代码一致：

- `readRuleUsage`（`tools/acceptance-summary.mjs:44-69`）的写事件只有
  `{rule, path, outcome}`，没有 `kind/index/sha256`；读事件放在单独的 `reads`，
  `summariseRun` 只把 `writes` 传给判定器。
- `runProjectTest`（`:84-97`）只返回当前一次测试的
  `{exitCode, passed, failed, output}`，没有 `history`。
- `readTasks`（`:71-82`）只保留 `{id, status}`，丢掉 `subject`；
  `REPAIR_COMPLETED` 却依赖 `subject` 或 `id` 中的 `repair/fix` 字样。
- `files` 的 SHA-256（`:195-199`）只作为输出展示，没有和写事件关联，
  也没有进入 `deriveAcceptance`。

只读检查 run10 的实际产物（`<run10>`）：

```text
upstream-requests.jsonl: 19 行；usage=5；writes=0；reads=0
policyFacts.filePath 为 null；没有 index/sha256/kind
runner: status=completed, hostStarted=true, hostExit.code=0
team.json: 1 个任务 t1，status=claimed，subject="Implement sum() in src/sum.mjs"
```

因此“监督器 completed / 宿主 exit 0”与“业务闭环”仍被正确分开；但也说明
当前 CLI 不可能凭这些产物得到 `closed`。没有补造哈希、历史或 subject，
也没有修改 run10 现场。

## 4. 兼容性与回归覆盖

| 测试 | 结果 |
| --- | --- |
| `tests/v02-core-acceptance.test.mjs` | 9/9 |
| `tests/v02-acceptance-summary.test.mjs` | 19/19 |
| `tests/v02-ledger.test.mjs` | 59/59 |
| `tests/v02-experiment-package.test.mjs` | 80 checks，0 failures |
| `tests/v02-experiment-runner.test.mjs` | 117 checks，0 failures |
| `tests/v02-b1-scenarios.test.mjs` | 5 scenarios，0 failed |
| `tests/preflight-script.test.mjs` | 9/9 场景，42 项断言（V0.1，固定 `afead09`） |

接口影响：`ACCEPTANCE_SCHEMA` 仍为 `tla.acceptance-summary/v1`；10 个条件码未增删；
CLI 参数未变；只有 `verify/acceptance-summary` 的导入方是 V0.2 测试与文档，
V0.1 的 `preflight-script` / workflow 测试不导入该模块。因此 V0.1 没有代码路径
受本次判据收紧影响；V0.1 的回归是在 `afead09` 固定副本上跑的，不等同于对
本分支的全量兼容证明。

**未覆盖**：没有启动宿主或假模型；没有跑全部 20 套 V0.2 测试；没有验证
`tools/experiment-command.mjs` 的真实命令生成；没有验证 `summariseRun` 的端到端
`closed` 路径（当前也不可能通过）。

## 5. 建议

1. **判据补丁**：建议纳入 V0.2 开发分支，作为“拒绝不完整证据”的净改进；
   合并前修复 P2 的排序/整数校验，并补两个最小反例。
2. **闭环声明**：在采集器补齐 `kind/index/sha256`、`history`、`subject` 之前，
   不得把 `closed` 作为 V0.2 验收结论；`CORE-RETURN.md` 已经这样声明，本次复核同意。
3. **边界**：本次没有修改 ChatGPT 归属的核心文件；审查副本和复现脚本留在
   `<review-copy>`，未进入仓库。

复现命令（在独立副本内，不启动宿主）：

```text
node tests/v02-core-acceptance.test.mjs
node tests/v02-acceptance-summary.test.mjs
node review-probes.mjs
```
