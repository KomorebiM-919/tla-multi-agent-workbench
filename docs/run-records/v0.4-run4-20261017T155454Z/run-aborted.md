# v0.4-run4 运行中止记录（2026-10-17T15:54:54Z 开始）

本文件记录**第四次真实运行**（runId `v0.4-run4-20261017T155454Z`）为什么在预检阶段中止、
现场留下了什么、以及它在哪些意义上**不能**被称为"通过"。原始证据在
`docs/evidence/v0.4-run4-20261017T155454Z/`，不被本文件改写。

已授权的运行条件（用户 m12051）：`maxAgentCalls = 8`、`maxCodingAttempts = 2`、
声明 `maxTotalTokens = 8 000 000` 仅作事后观测；失败即停、不自动重开、不改需求、
不丢弃未审核改动。

## 1. 结论

- 运行**没有完成**：`ok = false`、`status = "EVIDENCE_NOT_CLAIMED"`，
  **只启动了 1 次子代理调用**（Verifier preflight），Requirement / Coding / Verify / Review 均未启动。
- 它不是转录漂移、不是宿主 schema 拒绝、不是预算超限、不是缓存门禁失败。
  触发点是编排脚本**自己的** fail-closed 门禁：预检回报的 `owner_marker_path` 是**绝对路径**，
  而脚本要求它与本次运行配置的**仓库内相对路径**逐字符相等。
- 因此本次运行**没有需求、没有交付、没有验证、没有审核结论**。
  `preflight.json` 里的 `claim_created: true` / `claim_exit_code: 0` 只说明"证据目录被本次运行排他认领成功"，
  不说明任何交付质量。

## 2. 中止点与失败原文（逐字）

编排脚本在 `workflows/three-agent-mvp.js:2096` 的相等判定处返回：

```
if (normalizeRelPath(preflight.owner_marker_path) !== ownerMarkerPath) {
```

运行返回值中的失败文本：

```
预检未能证明证据目录由本次运行独占（owner_marker_path 报告为 "<repo-root>\\docs\\evidence\\v0.4-run4-20261017T155454Z\\.run-owner.json"，本次运行应为 "docs/evidence/v0.4-run4-20261017T155454Z/.run-owner.json"）；为防止两个运行同时写入同一目录，已终止
```

## 3. 根因（三层，按可核实程度排列）

1. **预检子代理改写了一个本应逐字回填的字段。**
   认领工具 `tools/claim_evidence_dir.py:160` 自己输出的就是**相对路径**：
   `payload['owner_marker_path'] = relative + '/' + MARKER_NAME`
   （即 `docs/evidence/v0.4-run4-20261017T155454Z/.run-owner.json`）。
   而 `preflight.json` 里同一字段被写成了解算后的绝对路径
   `<repo-root>\docs\evidence\v0.4-run4-20261017T155454Z\.run-owner.json`。
   子代理把工具输出做了"规范化改写"，而不是原样转抄。
2. **`normalizeRelPath` 对绝对路径返回 `null`**（拒绝盘符 / 前导斜杠），
   于是 `null !== 'docs/evidence/.../.run-owner.json'` 成立，判定为"未独占"。
   这个拒绝行为本身是**正确的**（它防止路径逃逸），问题在输入被改写而不是门禁太严。
3. **提示词没有把该字段的"回填方式"钉死。**
   `preflightPrompt()` 只对 `evidence_dir_state_before` 明确写了"逐字回填，不得用你自己观察到的值替代"
   （`workflows/three-agent-mvp.js:1534`），对 `owner_marker_path` 只说明了"工具会用 O_EXCL 创建它"，
   没有要求"逐字回填工具输出、且必须是仓库内相对路径"。同一个 schema 里其余路径字段
   （`repo_root`、`evidence_dir_realpath`、`target_dir_realpath`、`resolved_paths`）全部是绝对路径，
   这个字段是唯一的相对路径例外，缺少显式标注时被"统一成绝对路径"是可预期的行为偏差。

**认领本身是成功的**：`.run-owner.json` 已由排他创建工具写出（277 B，
`claimedAt: 2026-10-17T23:56:38.452290+08:00`，`claimedBy: verifier-preflight`，
`claimMode: exclusive-create (O_EXCL)`）。门禁拦下的是**证据格式**，不是实际互斥性；
这是"宁可误停、不可带病运行"的正确取舍，但代价是一次完整的付费预检调用。

## 4. 执行文本一致性：三方一致（可逐字节复核）

本次运行**没有**转录漂移。三方比较结果：

| 对象 | 字节数 | sha256 | Git blob |
| --- | --- | --- | --- |
| 宿主记录的实参 `script`（`native-events.json`） | 141953 | `05c62896fa0772278eb0cac98b1e11742da3b89da9f6b46691189c1a6b7435e8` | — |
| 固定提交 `[C33]` 的 `workflows/three-agent-mvp.js` | 141953 | `05c62896fa0772278eb0cac98b1e11742da3b89da9f6b46691189c1a6b7435e8` | `900b7098eae86b34aaf1a7ad59fc9a1e54b540a4` |
| 预检载荷 `tests/.scratch/run4/payload.js` | 141953 | `05c62896fa0772278eb0cac98b1e11742da3b89da9f6b46691189c1a6b7435e8` | `900b7098eae86b34aaf1a7ad59fc9a1e54b540a4` |

- `node tests/preflight-workflow-script.mjs --payload tests/.scratch/run4/payload.js --commit [C33]…`
  在提交前返回 **PASS（exit 0）**：逐字节相同、字节差 0、5 个 schema 全部合法、`agentCalls.real = 0`。
- `node tests/extract-native-events.mjs … --script-file workflows/three-agent-mvp.js` 的
  `invocation` 块：`scriptBytes 141953`、`scriptLines 2432`、`matchesRepoScriptExact: true`、`byteDelta: 0`。
- 同一提取器再以 `--script-file tests/.scratch/run4/payload.js` 复跑
  （`native-events-vs-payload.json`）：同样 `matchesRepoScriptExact: true`、`byteDelta: 0`。
- 执行副本已原样归档为 `workflow-script-at-run.js`（141953 B，同上 sha256）。
- 提取器自身返回 exit 1：`checks 9/10`，唯一失败项是 `artifacts.writtenByChild`
  （`requirement.json` / `coding-report.json` / `verify.json` / `review.json` 的写入者数为 0）——
  这是事实（那四个阶段从未运行），不是提取器或脚本的问题。

结论：**执行 = 固定提交 = 校验过的载荷**，三者逐字节相同；本次失败不可能由转录漂移解释。

## 5. 调用账本（1 / 8）与子会话

| seq | 标签 | 阶段 | 开始（UTC） | 结束（UTC） | 子会话 |
| --- | --- | --- | --- | --- | --- |
| 1 | Verifier (preflight) | preflight | 15:56:29.388 | 15:57:14.329 | `e5f8028d-206d-47d7-83d1-ada87b7a974b` |
| — | Requirement Agent | requirement | **未启动** | — | — |
| — | Coding Agent | coding | **未启动** | — | — |
| — | Verifier (verify) | verify | **未启动** | — | — |
| — | Review Agent | review | **未启动** | — | — |

- 1 次 ≤ `maxAgentCalls = 8`，**未超限**；没有任何派生代理（`derivedSessions: []`）。
- 同一次运行内 `selfCheck` 8 个 label 的 schema 指纹全部通过（否则会在**启动前**以 `SCRIPT_DRIFT` 中止，
  实际并未发生：预检确实启动了）。

## 6. 全运行缓存边界：`INCOMPLETE`（不是"通过"）

运行结束、且在**任何其它 Python 导入之前**采了快照，然后用确定性工具判定（0 次模型调用）：

```
python tests/collect-cache-state.py --target-dir examples/text-stats \
  --run-id v0.4-run4-20261017T155454Z --snapshot-label cache-postrun \
  --out docs/evidence/v0.4-run4-20261017T155454Z/cache-postrun.json --pretty

python tests/verify-cache-boundary.py --run-id v0.4-run4-20261017T155454Z \
  --evidence-dir docs/evidence/v0.4-run4-20261017T155454Z \
  --baseline docs/evidence/v0.4-run4-20261017T155454Z/cache-before.json \
  --postrun docs/evidence/v0.4-run4-20261017T155454Z/cache-postrun.json \
  --out docs/evidence/v0.4-run4-20261017T155454Z/cache-boundary.json --pretty
```

结果：`status: "INCOMPLETE"`（exit 11），`problems: ["stage_observations_found：证据里找到 0 个阶段观测点"]`、
`violations: []`。7 项检查中 6 项 `ok`，唯一失败项是"没有阶段观测点"——
因为 Coding / Verifier / Review 从未运行，证据目录里没有它们的 `bytecode_scope`。

基线与运行后快照的内容哈希**完全相同**（都是 `7168ee6c5b31599b7ee6bbd8af48df240c81f80b7318f5a2cad9d558313e8687`，
2 个条目逐字段相同）：

| 文件 | bytes | mtime_ms | sha256 |
| --- | --- | --- | --- |
| `examples/text-stats/__pycache__/test_text_stats.cpython-313.pyc` | 66316 | 1792240028919 | `24e090c3…d4317280` |
| `examples/text-stats/__pycache__/text_stats.cpython-313.pyc` | 14885 | 1792244851273 | `453ece51…b82d2b` |

**准确含义**：两个采集点之间的缓存内容没有变化；但"没有阶段观测点"意味着这次运行**无法证明**
运行期写入边界（因为没有阶段在交付目录里跑过 Python）。`INCOMPLETE` 既不是通过，也不能当通过用。

## 7. 用量（只读复算，事后观测）

```
node tests/extract-usage-report.mjs --run-id v0.4-run4-20261017T155454Z \
  --run-record docs/run-records/v0.4-run4-20261017T155454Z \
  --out-dir docs/run-records/v0.4-run4-20261017T155454Z/usage \
  --declared-budget docs/run-records/v0.4-run4-20261017T155454Z/usage/declared-budget.json
```

结果：1 个会话 / 11 条消息 / `totalTokens = 256 475`，`coverage = complete`，
`budget = WITHIN_BUDGET`（`maxAgentCalls = 8`、`maxTotalTokens = 8 000 000`）。

- 调用预算：1 / 8。
- token 观测：256 475 ≤ 8 000 000——**事后观测判定**，工作流不能在 8M 处强制停止。
- 货币成本：未提供价格，不能由 token 换算金额。

## 8. 交付物现状

- `examples/text-stats` **未被改动**（`git status` 中没有任何 `examples/` 条目）：
  Coding Agent 从未启动，因此没有待审 diff。
- 证据目录里只有 `.run-owner.json`、`preflight.json`，以及事后补充的
  `cache-before.json` / `cache-postrun.json` / `cache-boundary.json`。
- 不可删除、不可复用该目录：`.run-owner.json` 属于本次 runId，重跑必须用全新 runId 与全新 evidenceDir。

## 9. 可选修复方向（**需所有者批准后才能改脚本并重跑**）

1. **提示词补一句（最小改动，只降低概率）**：在 `preflightPrompt()` 的认领段落加一行
   "`owner_marker_path` 必须**逐字回填**认领工具输出的 `owner_marker_path`（仓库内相对路径，不得改写成绝对路径）"。
2. **门禁容忍两种写法（结构性修复，仍 fail-closed）**：若报告的是绝对路径，
   以预检回报的 `repo_root` 解算后与 `repoRoot + '/' + ownerMarkerPath` 比较，且解算结果必须仍落在 `evidenceDir` 内；
   相对路径分支保持现有的 `normalizeRelPath` 严格比较。两条分支任一成立才放行，其余一律拒绝。
3. **两者都做 + 单元测试**（推荐）：覆盖"相对路径通过""绝对路径且解算到同一文件通过"
   "绝对路径指向别处拒绝""含 `..` 的绝对路径拒绝"四个用例，落在 `tests/workflow-logic.test.mjs`。

不建议的选项：放宽成"只要 `claim_created` 为 true 就不再核对 marker 路径"——
那会让"认领文件被换成另一个运行的"这一类错误静默通过。

## 10. 不能证明什么

- 不能证明需求正确、交付合格或通过审核：这三件事本次运行**都没有发生**。
- 不能证明运行期写入边界：缓存判定是 `INCOMPLETE`（没有阶段观测点）。
- 不能证明脚本其余部分在真实运行中可用：只走到预检第 1 步就中止了。
- 不能把本次运行算作 V0.1 验收的一部分；下一次运行需要所有者**单独授权**，不自动重开。
