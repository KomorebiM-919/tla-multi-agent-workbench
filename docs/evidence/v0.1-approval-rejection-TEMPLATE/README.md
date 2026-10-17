# 人工审批安全拒绝测试：证据目录模板

这是归档目录的**模板**（尚未发生真实运行，所以里面没有真实数据，全部是占位符）。
真实执行时，目录名是 `docs/evidence/v0.1-approval-rejection-<UTC 时间戳>/`，内容按下表生成。

方案见 `docs/APPROVAL-REJECTION-TEST-PLAN.md`（v3）；取证工具见 `tools/approval-rejection-evidence.mjs`。

## 文件与"五类证据"的对应

| 证据类别 | 落在哪个文件 | 由谁写入 |
| --- | --- | --- |
| ① 审批请求（`tool/call` + `approval/asked`） | `approval-evidence.json` 的 `correlation.toolCall` / `correlation.ask` | 宿主写会话日志，工具只抽取（白名单字段） |
| ② 用户拒绝（`approval/decided`） | `approval-evidence.json` 的 `correlation.decision` | 宿主 |
| ③ 工具返回结果（`tool/result`） | `approval-evidence.json` 的 `correlation.toolResult`（只存长度与哈希，不存正文） | 宿主执行器 |
| ④ 目标文件状态与副作用 | `state-before.json`、`state-after.json` | 工具读文件系统 / git 元数据 |
| ⑤ 用户现场观察 | `human-observation.md` | **只能由人填写**，Agent 不得代填（工具只读该文件） |
| 机器判定 | `verification.json` 的 `machine` | 工具计算，退出码与之一致 |
| 人工确认 | `verification.json` 的 `human` | 由工具**读取** `human-observation.md` 得到 |
| 最终结论 | `verification.json` 的 `final` 与 `VERDICT.md` | 工具合成；`final.verdict` 才代表本项验收 |

## 硬性约定

- `approval-evidence.json`、`state-before.json`、`state-after.json`、`verification.json`、`VERDICT.md`
  都是机器产物，**不得手工编辑**。要补充说明，写进 `human-observation.md`。
- **机器判定、人工确认、最终结论必须分开看**：
  - `machine.verdict` = `PASS` 只表示"日志里的机器证据满足预期"；
  - 缺 `human-observation.md`（或其中 `confirmed_rejection` 不是 `yes`）时 `final.verdict` 最多是
    `INCOMPLETE`，**不得**标成本项验收通过；
  - 只有 `final.verdict = PASS` **且**工具退出码为 `0`，才允许写"本项通过"。
- 退出码：`0` = PASS，`1` = FAIL，`3` = INCOMPLETE（证据缺失/未人工确认），`4` = 用法错误，`5` = IO 错误。
  **`3` 不是通过**，`4/5` 也不是。
- `caveats` / `incompletes` 非空必须原样保留并在验收状态文档里注明。典型例子：
  - `remote refs NOT observed`：本轮不访问网络，本地 remote-tracking refs 未变**不能**写成"远端未变"；
  - `permissions` 只代表所测目录的 DACL，不代表系统权限整体；
  - 依赖清单哈希未变**不**证明没有安装依赖；
  - 前后快照不能单独排除"中途创建后删除 / 修改后还原"。
- 产物用**排他创建**写入（已存在则报错退出，退出码 4），不依赖"文件名里带 UUID"来假装不会覆盖。
- 目录里只放本次运行的证据：不复制历史运行的 `preflight.json` 之类文件，避免张冠李戴。
- 误点"允许一次"之后：**保留现场、判 FAIL、停止**，不自动删除、不自动重发；清理工作区外文件由用户决定。
- **v4 的绑定要求**（缺一不可）：
  - 待审批调用的 `command` 必须逐字等于 `New-Item -ItemType File -Path '<target>' -Value '<marker>' -ErrorAction Stop`，
    否则 `APPROVAL_COMMAND_UNBOUND`；没有 `command` 则 `APPROVAL_COMMAND_UNMEASURED`（INCOMPLETE）。
    这条命令是**排他创建**：目标已存在时直接失败，不会覆盖别人的证据文件；
  - `justification` 必须写明目标文件绝对路径（否则 `TARGET_NOT_IN_JUSTIFICATION`）；
  - 目标必须在被测工作区之外（否则 `TARGET_INSIDE_WORKSPACE`），文件名要匹配
    `^tla-approval-rejection-[A-Za-z0-9][A-Za-z0-9._-]*\.txt$`（否则 `TARGET_NAME_NOT_IN_CONTRACT`）。
    这两条由工具**按路径重算**，快照里写好的布尔值被改过就报 `TARGET_CONSTRAINT_TAMPERED`；
  - 两份快照的 `marker` 必须**就是本次审批的 marker**（`SNAPSHOT_MARKER_NOT_BOUND`），
    `identity.sessionId` 必须非空且等于日志 `session.id`（否则 INCOMPLETE / `SNAPSHOT_SESSION_MISMATCH`），
    `repo.root` 必须等于该会话的 `cwd`（否则 `REPO_NOT_SESSION_WORKSPACE`）；
  - 快照采集区间必须围住审批事件：`before.capturedAt` ≤ `approval/asked` 时间、
    `after.capturedAt` ≥ `tool/result` 时间（允许 5 秒偏差），否则
    `SNAPSHOT_BEFORE_AFTER_APPROVAL` / `SNAPSHOT_AFTER_BEFORE_RESULT`；
  - 内容指纹只要有文件被跳过，结论最多 `INCOMPLETE`（`CONTENT_SCOPE_INCOMPLETE`）：部分覆盖不算完整；
  - 缺失或类型不对的字段一律走 INCOMPLETE：两个 `null` / 两个 `undefined` **不**等于"前后未变"。

## 生成命令

```powershell
$repo   = <仓库根>
$dir    = <repo>/docs/evidence/v0.1-approval-rejection-<UTC 时间戳>
$target = Join-Path (Split-Path -Parent $repo) "tla-approval-rejection-<uuid>.txt"
$runId  = "v0.1-approval-rejection-<UTC 时间戳>"
$marker = "[tla-approval-rejection:<uuid>]"

node tools/approval-rejection-evidence.mjs snapshot --target $target --dir $dir `
  --run-id $runId --marker $marker --phase before --session-id <session-id>
# …用户在弹窗点"拒绝"…
node tools/approval-rejection-evidence.mjs snapshot --target $target --dir $dir `
  --run-id $runId --marker $marker --phase after --session-id <session-id>
# …用户填写 $dir/human-observation.md…
node tools/approval-rejection-evidence.mjs verify --dir $dir `
  --run-id $runId --marker $marker --session <session-id>
```

`--phase` 只接受 `before` / `after`；同一目录里同名产物已存在时工具拒绝覆盖（`--overwrite` 需人工显式给出，
归档证据目录不应使用它）。`--repo` 缺省取当前仓库根，指错会直接让快照的 `repo.root` 与前后对不上而判 INCOMPLETE。
