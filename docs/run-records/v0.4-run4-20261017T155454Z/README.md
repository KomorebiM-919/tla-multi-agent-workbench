# v0.4-run4 运行记录（2026-10-17T15:54:54Z）

第四次真实运行（runId `v0.4-run4-20261017T155454Z`）的归档。**结论：预检阶段中止，没有交付、没有验证、没有审核。**

为什么中止、根因分层、可选修复方向见 [`run-aborted.md`](./run-aborted.md)。本文件只做索引与口径说明。

## 1. 文件清单

| 文件 | 是什么 | 来源 |
| --- | --- | --- |
| `workflow-script-at-run.js` | 宿主记录的**实际执行**脚本（141953 B） | 与固定提交 `[C33]` 及预检载荷逐字节相同 |
| `native-events.json` | 原生执行证据（白名单字段），`--script-file workflows/three-agent-mvp.js` | `tests/extract-native-events.mjs` |
| `native-events-vs-payload.json` | 同一提取，`--script-file tests/.scratch/run4/payload.js`（载荷等价性记录） | 同上 |
| `cache-boundary.json` | 全运行缓存边界判定（`INCOMPLETE`） | `tests/verify-cache-boundary.py` |
| `usage/declared-budget.json` | 运行前声明的预算（8 次调用 / 8 000 000 token） | 用户 m12051 批准的条件 |
| `usage/usage-report.json` | 只读复算的用量报告 | `tests/extract-usage-report.mjs` |
| `usage/extraction-metadata.json` | 提取时刻等易变元数据（与用量报告分开写） | 同上 |
| `SHA256SUMS.txt` | 本目录文件的 sha256 | `sha256sum` 等价复算 |

原始证据（不改写）：`docs/evidence/v0.4-run4-20261017T155454Z/`
（`.run-owner.json`、`preflight.json`、事后补充的 `cache-before.json` / `cache-postrun.json` / `cache-boundary.json`）。

说明：预检载荷原文 `tests/.scratch/run4/payload.js` 位于被 `.gitignore` 排除的临时目录，
因此不作为提交物；它与 `workflow-script-at-run.js` 逐字节相同（同一 sha256），后者才是可复核的归档副本。
`cache-boundary.json` 在本目录与证据目录各有一份（内容相同，均为确定性工具输出）。

## 2. 七项分开陈述

1. **执行文本一致性**：执行 = 固定提交 = 校验过的载荷，三方 sha256 均为
   `05c62896fa0772278eb0cac98b1e11742da3b89da9f6b46691189c1a6b7435e8`，`byteDelta: 0`。
   本次失败**不是**转录漂移。
2. **宿主运行结果**：`ok: false`、`status: "EVIDENCE_NOT_CLAIMED"`，只启动 1 次子代理（预检）。
   诱因是预检把 `owner_marker_path` 报成绝对路径，而门禁要求仓库内相对路径（`tools/claim_evidence_dir.py:160`
   自己输出的就是相对路径）。认领本身成功。
3. **独立质量复核**：**不存在**。Requirement / Coding / Verifier(verify) / Review 全部未运行，
   所以没有任何需求、交付或审核结论可复核。
4. **缓存边界**：`INCOMPLETE`（exit 11）。基线与运行后快照内容哈希相同
   （`7168ee6c…38687`，2 个 `.pyc` 逐字段相同），`violations: []`；
   但因为没有阶段观测点，这次运行**无法证明**运行期写入边界。
5. **调用预算**：1 / 8，未超限；无派生代理（`derivedSessions: []`）。
6. **token 观测**：`totalTokens = 256 475` ≤ 8 000 000，`coverage = complete`、`WITHIN_BUDGET`。
   这是事后观测判定，不是硬限额；货币成本未提供价格，不能换算。
7. **剩余限制**：本次运行只走到预检第 1 步；脚本其余部分在真实运行中仍未经检验。
   下次运行必须用**全新 runId + 全新 evidenceDir**（本目录的 `.run-owner.json` 属于本次 runId），
   且需所有者**单独授权**。

## 3. 复算命令

```powershell
node tests/extract-native-events.mjs --parent session-3f96bf08-83ae-48d6-a239-0223d4b1c12c `
  --workflow-name three-agent-mvp-run4 --since 2026-10-17T23:54:54+08:00 `
  --evidence-dir docs/evidence/v0.4-run4-20261017T155454Z `
  --script-file workflows/three-agent-mvp.js `
  --out docs/run-records/v0.4-run4-20261017T155454Z/native-events.json

node tests/extract-usage-report.mjs --run-id v0.4-run4-20261017T155454Z `
  --run-record docs/run-records/v0.4-run4-20261017T155454Z `
  --out-dir docs/run-records/v0.4-run4-20261017T155454Z/usage `
  --declared-budget docs/run-records/v0.4-run4-20261017T155454Z/usage/declared-budget.json
```

`tests/extract-native-events.mjs` 返回 exit 1 属预期：`artifacts.writtenByChild` 报四个阶段产物缺失，
这正是"只跑了预检"的事实。

## 4. 归档纪律

- 本目录是**不可改写**的运行记录：新增解释请另开文件，不要回填已经归档的数字。
- 不 push、不建 PR、不合并 `main`、不宣布 V0.1 通过：本次运行既不是通过，也不构成验收证据的一部分。
