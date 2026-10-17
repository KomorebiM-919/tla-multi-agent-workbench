# 审查包：`v0.2-run1-20261017T121445Z`（提交 `[C17]`）

本目录是**这一次**真实流水线运行的审查材料入口。它只做索引与复算，不替代证据原件：
原件在 `docs/evidence/v0.2-run1-20261017T121445Z/` 与 `docs/run-records/v0.2-run1-20261017T121445Z/`，
两者在本目录的 `SHA256SUMS.txt` 里逐文件列出。

> 本包**不是**"V0.1 最终验收通过"的证明。它证明的是：这一次运行按契约跑完、证据自洽、
> 独立复核未发现造假。最终是否验收仍由仓库所有者决定。

## 1. 版本与提交

| 项 | 值 |
| --- | --- |
| 分支 | `feat/v0.1-three-agent-mvp` |
| 运行前源码版本 | `[C16]` |
| 交付 + 证据提交 | `[C17]`（14 files, +1804/−539） |
| 状态文档提交 | `[C18]`（5 files, +326/−275） |
| 审查包提交 | 见本目录所在提交（本文件随该提交入库，提交号无法自指） |
| 远端 | 未 push、未创建/修改 PR、未合并 |

## 2. 需求原文（批准后不再静默修改）

| 项 | 值 |
| --- | --- |
| 来源文档 | `docs/DEMO-REQUIREMENT-INPUT-v3.md`（`v0.2-demo-input-3`）第 2 节，R-01 – R-37 |
| 批准 | 宿主消息 `m07160`（"我批准 v0.2-demo-input-3 的 R-01 – R-37 作为本轮真实流水线需求原文"） |
| 固化文本 | `docs/run-records/v0.2-run1-20261017T121445Z/requirement-injected.txt` |
| 字节 / 行 | 15249 B / 123 行 / LF / 无 BOM |
| sha256 | `6307a7f0ca0a84ccf0b8036ad202d7acaa56e8664d5761b22c10a915a86f71d7` |
| 条款计数 | R-01 – R-37 各出现一次（37 条） |
| 派生规则 | 只去掉每条行首的状态标签（`（已批准…）`/`（建议维持现状…）`/`（已确认…）`），正文一字未改；R-05 正文里的历史引用"（这条分层来自已批准的 RB-1 + RB-2…）"不是行首标签，保留 |

申请批准与执行是两件事：本文件只说明"批准了什么"，不代表"验收通过"。

## 3. 交付差异

- 完整差异：`delivery.diff`（`git show [C17] -- examples/`，3 files, +777/−539）
- 实际改动文件：`examples/text-stats/text_stats.py`、`examples/text-stats/test_text_stats.py`、`examples/text-stats/README.md`
- 未改动：`examples/text-stats/sample_input.txt`（仍是 20 字节 `"hello world\nfoo bar\n"`，R-34/Q2）
- 交付源码范围：**没有**越出 R-32 允许的 4 个文件（工作区与提交两处都核过）

## 4. 阶段证据（原件字节）

| 阶段 | 产物 | 字节 | sha256 | generated_at |
| --- | --- | --- | --- | --- |
| 认领 | `.run-owner.json` | 277 | `9b90d4607839334cdbb199439978efc898d1248de7cbfe031d5c1f9d3cb35c24` | claimedAt `20:19:14.564772+08:00` |
| 预检 | `preflight.json` | 2140 | `5850288c50c05b3d8ad4de4b81c117604c6b309b3852f23a28c16a34049a92b0` | `20:19:28.546819+08:00` |
| 需求 | `requirement.json` | 23000 | `9119b09ca0ace17a4f37ce80c5116309702e47d122c64fb8c0a620174674f089` | `20:21:27.2308535+08:00` |
| 编码 | `coding-report.json` | 5977 | `02992917870036b536c607ba0bcbe53600787930016384bfc104e8895229fabc` | `20:26:27.887939+08:00` |
| 验证 | `verify.json` | 1384 | `f75ea00c24067ad25144cfa06c716571c8f1a769ff751030bea371fe2f47e0a2` | `20:28:15.328120+08:00` |
| 审核 | `review.json` | 15023 | `2f419cb69b56516dc880139a8e4d06a303ce85d3b0fe3e25568c25054985c2f5` | `20:30:24.5474296+08:00` |

三条硬事实（由 `tests/review-run-evidence.py` 复算，不采信报告里的自述）：

- `verify.json` 与 `review.json` 记录的 `text_stats.py` / `test_text_stats.py` sha256，与**磁盘当前字节**一致；
- `review.json` 的 `criteria_check` 恰好覆盖 `AC-01` – `AC-27`，且逐条 `satisfied`，`requirement_conflicts` 为空；
- 各阶段 `generated_at` 单调递增，认领早于所有阶段。

## 5. 原生事件摘要

见 `native-events.json`。要点：宿主 `workflow` 工具一次调用（后台任务 `workflow-2`，meta `tla-v02-run1`），
返回 `ok: true` / `status: "OK"` / `attempts: 1` / `finalVerdict: "APPROVED"`，摘要行 `completed (5 agents)`
⇒ **原生子代理调用 5 次**（预检、需求、编码、验证、审核），在批准的 8 次上限内，且没有子代理再派生代理。

**该文件是派生摘要，不是日志重放**：本会话宿主日志是 zstd 压缩的 JSONL（约 16 MB），当前环境没有解码器，
因此 `native-events.json` 的来源写的是"宿主工具返回值 + 各产物 `generated_at`"，并显式标注"未重放日志"。
要逐帧证据，需在具备 zstd 解码器的环境另行提取。

## 6. 测试输出（本机实跑，原文在 `test-output/`）

| 文件 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `01-delivery-unit-tests.txt` | `python -m unittest discover -s examples/text-stats -p "test_*.py"` | `Ran 76 tests` / `OK` | 0 |
| `02-review-run-evidence.txt` | `python tests/review-run-evidence.py --run-id v0.2-run1-20261017T121445Z` | 52/52 项通过 | 0 |
| `03-independent-probe.txt` | `python tests/.scratch/unattended/probe-independent-v02.py`（按需求原文重算） | 86/86 项通过 | 0 |
| `04-mutation-check.txt` | `python tests/.scratch/unattended/mutation-check-v02.py` | 基线 76/76；三个变异体分别被 3 / 1 / 2 例抓住 | 0 |
| `05-workflow-logic.txt` | `node tests/workflow-logic.test.mjs` | 85/85 场景、391 断言 | 0 |
| `06-preflight-claim.txt` | `node tests/preflight-claim-integration.test.mjs` | 6/6 场景、59 断言 | 0 |
| `07-approval-evidence.txt` | `node tests/approval-rejection-evidence.test.mjs` | 131/131 | 0 |
| `08-approval-mutation.txt` | `node tests/approval-evidence-mutation.test.mjs` | 18/18 + strict 11/11 | 0 |
| `09-property-text-stats.txt` | `python tests/property_text_stats.py` | 1217 组 | 0 |
| `10-tests-unittest.txt` | `python -m unittest discover -s tests -p "test_*.py"` | `Ran 11 tests` / `OK` | 0 |

`03` / `04` 的脚本在 `tests/.scratch/` 下，**未入库**（本地工具）。因此这两项结论在当前仓库里只能按
`02` 与 `04` 的原始输出复核；若要长期可复现，应把这两个脚本正式入库（另一次提交，未在本轮做）。

关于用例数从 86 变 76：上一次交付（提交 `[C14]`）是 86 例；本轮 Coding Agent 按新需求重写了测试文件
（986 行 / 39783 B / 76 例）。这不是"少了 10 个断言就变弱"——`04` 用三个重新引入旧缺陷的变异体验证了
三处历史假 PASS 仍会被抓住，`03` 又用独立探针按需求原文逐条重算。差异本身仍应由人复核
`delivery.diff` 里 `test_text_stats.py` 的增删。

## 7. 哈希与复算

- `SHA256SUMS.txt`：本目录所有文件 + 六个阶段产物 + 三个运行记录文件的 sha256（相对仓库根）。
- 复算（PowerShell，读文本行、按列比对）：

```powershell
Get-Content docs/review/[C17]/SHA256SUMS.txt | ForEach-Object {
  $h, $p = $_ -split '  ', 2
  $a = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()
  if ($a -ne $h) { "MISMATCH $p" }
}
```

- 字节口径：`docs/evidence/v0.2-run1-20261017T121445Z/**` 与 `docs/run-records/v0.2-run1-20261017T121445Z/**`
  在 `.gitattributes` 里是 `-text -whitespace`，即**工作区字节 = Git blob 字节 = 记录 sha256**；
  交付源码与说明是 `text eol=lf`。

## 8. 这份材料**不**成立的部分（必须与结论一起读）

1. **AC-24「不新增 `__pycache__/`」本轮未被严格执行**：`examples/text-stats/__pycache__/` 运行前已存在，
   但其中 `.pyc` 的 mtime 是 Verifier 阶段（`20:27:08`），即规范测试命令在未设 `PYTHONDONTWRITEBYTECODE=1`
   的情况下重写了字节码。原因是 `isAllowedTestCommand` 只放行规范命令原文（不接受环境变量前缀），
   而宿主进程环境无法为本会话设置该变量。该目录被 `.gitignore` 忽略、未进版本库、未改任何被跟踪文件。
   **这是需求条款与编排契约的环境冲突，不是编码产物越界**；彻底满足需要工作流支持注入环境变量（须另行批准）。
2. **远端状态未观测**：未 push、未创建/修改 PR、未合并，因此无法据此判断远端分支是否与本地一致。
3. **复核工具的自证边界**：`tests/review-run-evidence.py` 把自身列为 `ORCHESTRATOR_TOOLS` 并单独打印，
   它无法自证"自己没有被改坏"。要复核它，请 `git show [C17] -- tests/review-run-evidence.py`。
4. **`native-events.json` 不是日志重放**（见 §5）。
5. **快照/日志整体真伪、其它工具与"允许一次"路径**都不在本轮证据范围内。
6. **`sample_input.txt` 与 `docs/review/`、`tests/.scratch/` 不含在本包哈希清单里**：前者未改动（可按 git 核对），
   后两者是本地目录、按设计不入库。

## 9. 结论（限定表述）

- 编排层结论：`ok: true` / `APPROVED`（5 次调用、0 轮返工、76 例全绿、27 AC + 27 BC 全覆盖）。
- 编排层独立复核：52/52、独立探针 86/86、变异检查 3/1/2、仓库回归全绿。
- **V0.1 最终验收：仍未通过**——原因不再是"流水线没跑过"，而是 §8 列出的未观测项与第 1 条未严格执行的条款。
