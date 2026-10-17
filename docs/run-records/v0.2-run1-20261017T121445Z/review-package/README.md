# v0.2-run1 复核材料（正式目录版）

本目录是对 2026-10-17 首次新版真实流水线运行 `v0.2-run1-20261017T121445Z` 的**复核材料**，
由编排层（人类监督下的 Agent）在运行结束后独立采集，不采信子代理的 `APPROVED` 字面结论。

> 本目录与 `docs/review/[C17]/` 的关系：后者是运行当时生成的审查包，已被误加入版本库
> （授权范围是"不提交 `docs/review/`"），随后用**显式文件清单的纠正提交**从跟踪树移除，
> 磁盘文件保留。本目录是"长期随仓库保留"的正式版本，内容按本次收口重算，不是前者的复制品。
> 历史提交里曾包含那些文件这一事实无法抹去（见提交说明）。

## 1. 复现方式

一条命令即可重跑全部复核项（会重写 `test-output/`、`suite-results.json`、`native-events.json`）：

```powershell
python tests/run-review-suite.py --run-id v0.2-run1-20261017T121445Z
```

该脚本按固定 argv 依次执行 13 条命令，记录每条命令的 argv、退出码、耗时、输出路径与输出 sha256，
并把输出统一写成 UTF-8 / LF（PowerShell 的 `*>` 重定向在 Windows 上会写成 UTF-16LE + BOM）。
它只写本目录，不修改任何被跟踪文件。

## 2. 本次结果（全部退出码 0）

| 编号 | 内容 | 结果 |
| --- | --- | --- |
| 01 | 交付单元测试（`python -m unittest discover -s examples/text-stats`） | `Ran 76 tests` / `OK` |
| 02 | 独立复核 `tests/review-run-evidence.py`（带映射与 8 条显式排除项） | **70/70** 项通过 |
| 03 | 复核工具自检 `--self-test` | **10/10** 夹具 |
| 04 | 独立行为探针 `tests/probe-text-stats-requirement.py` | **180/180** |
| 05 | 变异检查 `tests/mutation-text-stats.py` | 基线 76/76；3/3 变异体被抓（3 / 1 / 5 例失败） |
| 06 | 工作流逻辑 `tests/workflow-logic.test.mjs` | **95/95** 场景、439 断言 |
| 07 | 真实子进程集成 `tests/bytecode-integration.test.mjs` | **6/6** 场景、45 断言 |
| 08 | 预检认领 `tests/preflight-claim-integration.test.mjs` | **6/6** 场景、59 断言 |
| 09 | 审批取证 `tests/approval-rejection-evidence.test.mjs` | **131/131** 断言 |
| 10 | 审批取证变异 `tests/approval-evidence-mutation.test.mjs` | 18/18 用例 + strict 11/11 |
| 11 | 统计性质测试 `tests/property_text_stats.py` | 1217 组（16 固定 + 1200 随机 + 1 长文本） |
| 12 | `tests/` 下单元测试 | `Ran 11 tests` / `OK` |
| 13 | 原生日志提取 `tests/extract-native-events.mjs` | **10/10** 派生检查通过 |

## 3. 原生事件证据

`../native-events.json`（由上面第 13 条命令重新生成）与 `../native-events-README.md`：

- 运行 `tla-v02-run1`，runId `eb10cbf3-d04c-4fa1-913c-459e2f0e81dc`，
  `2026-10-17T12:19:03.240Z` → `12:31:18.229Z`，`stopReason: completed`；
- **5 次**子代理调用，全部 `delegationDepth = 1`、父会话 = 当前会话、`outcome = completed`，
  模型 `deepseek-flash`（provider `deepseek-account`）、沙箱 `workspace-write`、审批来源 `delegation`；
- 产物归因：`requirement.json` / `coding-report.json` / `review.json` 为写文件工具所写（#2 / #3 / #5），
  `preflight.json` / `verify.json` / `.run-owner.json` 由子会话经 `pwsh` 写出（按时间窗口归因，#1 / #4 / #1）；
- 另有一条 `tla-v02-real-run`（runId `11e3ec92-…`）在 `0.47 s` 内以 `stopReason: error` 结束、**0 次调用**，
  即正式运行前占位符试跑失败留下的原生证据（无副作用）；
- 脚本指纹：宿主记录 `script` 为 104088 B / sha256 `7846694d…`，仓库 `workflow-script-at-run.js` 为 104089 B /
  `48f3aaea…`，**仅差末尾换行**，检查按归一化判等。

## 4. AC-24 的纠正（本目录的重点）

运行当时 Review 对 AC-24（"不新增 `__pycache__`"）判 `satisfied: true`，理由是"子代理设了
`PYTHONDONTWRITEBYTECODE=1` 复跑后 `.pyc` 的 mtime 没变"。人工复审认定该判定**不成立**：
`.pyc` 的 mtime `20:27:08` 正是 Verifier 阶段执行规范命令的时间，而当时命令**不带**该变量，
即运行期确实发生了缓存写入；"复跑没有再写"不能证明"本轮没有写"。
原件不改，纠正记录在 `../../evidence/v0.2-run1-20261017T121445Z/human-review-ac24.md`，
映射文件 `../requirement-mapping.json` 的 `notProven` 把 AC-24 标为 `not-proven`、BC-25 标为 `partially-proven`。

后续改动（本目录第 06/07 条命令覆盖）把这件事变成硬门禁：测试命令必须带固定环境前缀
`$env:PYTHONDONTWRITEBYTECODE = '1'; `，Verifier 与 Review 都要交回 `bytecode_scope`
（测试前后 `<targetDir>/__pycache__` 的清单），出现写入 / 未设变量 / 未测量三种情况都判不通过。
**这只在离线下验证过，尚未在真实运行中验证。**

## 5. 需求映射

`../requirement-mapping.json`：37 条需求（R-01 – R-37）→ 54 个验收项（AC-01 – AC-27、BC-01 – BC-27），
共 80 处引用。每条含 `criteria`、`rationale`、`evidence[]`（交付用例 / 独立探针 / Review 结论）。
R-37 没有对应的统计验收项（冲突门禁不是统计行为），理由写在 `rationale` 里 —— 这张表**不能**只靠"ID 数量"自证完整。

## 6. 这份材料不能证明什么

- 不能证明真实流水线的**下一次**运行会通过 AC-24（新门禁只做了离线验证）；
- 不能证明 Review 对其它 26 条 AC 的判定都正确（本次只纠正了 AC-24，其余按映射与独立探针交叉核对）；
- 不能证明快照/日志整体未被篡改（原生证据来自宿主日志白名单字段，不是全量重放）；
- 远端仓库状态仍未观测（未 push、未创建/修改 PR、未合并）。V0.1 最终验收**仍未通过**。
