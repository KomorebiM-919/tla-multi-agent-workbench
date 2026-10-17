# 人工复审清单（交付提交 `[C39]`）

> 本清单是**请求**仓库所有者确认的项目，不代表确认已完成。AI 侧不代为签字，也不把“Agent APPROVED”当作人工结论。

## 1. 待确认对象

| 项 | 值 |
| --- | --- |
| 交付提交 | `[C39]`（`feat(text-stats): apply the run5 delivery pending human review`） |
| 需求源 | `docs/DEMO-REQUIREMENT-INPUT-v3.md` 第 2 节（`v0.2-demo-input-3`，R-01 – R-37；Q1 批准记录见 `docs/run-records/v0.2-run1-20261017T121445Z/approval.md`） |
| 交付文件（3 个，`+552 / −362`） | `examples/text-stats/text_stats.py`、`examples/text-stats/test_text_stats.py`、`examples/text-stats/README.md` |
| 未改动 | `examples/text-stats/sample_input.txt`（20 字节内容本就符合 R-34） |
| 交付测试 | `python -m unittest discover -s examples/text-stats -p "test_*.py"` ⇒ `Ran 97 tests`、`OK`（`failures=0 errors=0 skipped=0`） |

## 2. 主要行为变化（需要逐条认可）

1. **归一化顺序固定**：先剥**一个**前导 U+FEFF，再把 `\r\n` → `\n`，最后把剩余 `\r` → `\n`；`char_count` 按归一化后的码点计。因此 `'  \r\n \r\n'` 为 **5**（不是 7，也不是 6），README/测试中已删除矛盾的 `char_count: 6` 说法（AC-13、R-36）。
2. **两类调用分离且不得合并**（R-05）：命令行成功时打印四行 `key: N`；程序化调用（`main(..., stdin_text=...)`）**全程静默**，只返回退出码。`stdin_text is None` 且无文件参数时才读 stdin。
3. **受控错误统一退出码 1**（R-10、R-14）：argparse 默认的 2 被 `_ParserExit` 改写；错误走单行 `error: …` 到 stderr；程序化调用出错时 stdout/stderr 均为空。
4. **`--help` 优先**（BC-15）：带 `--help` 时退出码 0，不再因位置参数个数报错。
5. **`--encoding` 只作用于文件解码**（R-13、BC-22）：先用 `codecs.lookup(name)` 校验编码名，再选择输入；非法编码名的报错先于文件读取/解码。
6. **词数口径**：`[A-Za-z]+(?:[-'’][A-Za-z]+)*`，连接符含 U+2019；README 中不得出现裸 U+2019（须写 `\u2019`）。
7. **测试规模**：交付测试由旧版扩到 **97 项**，覆盖四类统计口径、BOM/换行、空行、连接符、程序化静默、错误码、编码、`--help`、AST 约束等。

## 3. 复核证据（可自行复算）

| 证据 | 位置 |
| --- | --- |
| 工具自检（19 个反例，证明工具不会把失败当通过） | `review-package/self-test.json`（19/19） |
| 干净副本复算（`[C39]` 的独立 worktree） | `review-package/verification-clean-copy.json`（**28/28**，运行后副本状态为空） |
| 主检出复算（含 2 个既有 `.pyc`） | `review-package/verification-main-checkout.json`（**28/28**；AC-28 缓存集合/哈希/`mtime` 前后全同，容差 0 ns） |
| 需求逐条追踪 | `review-package/REQUIREMENT-TRACEABILITY.md`（R-01 – R-37） |
| 可决策验收报告 | `review-package/ACCEPTANCE-REPORT.md` |
| run5 原始运行归档（未改写） | `docs/run-records/v0.4-run5-20261017T161034Z/`（`native-events.json`、`cache-boundary.json`、`usage/`、`workflow-script-at-run.js`） |
| 运行期原始证据 | `docs/evidence/v0.4-run5-20261017T161034Z/`（7 个 JSON） |

一条命令复算（不回写任何交付文件）：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
python docs/run-records/v0.4-run5-20261017T161034Z/review-package/verify-run5.py `
  --repo . --base [C39]^ --delivery [C39] `
  --out tests/.scratch/run5-review/manual.json
```

## 4. 需要仓库所有者明确确认的内容

1. 上述第 2 节的七项行为变化是否符合 `v0.2-demo-input-3` 的意图（尤其 R-05 两类调用、R-10 退出码 1、R-13 编码校验顺序）。
2. `sample_input.txt` 未改动是否符合预期（R-34 只要求内容自洽，本轮判定为“本就符合”）。
3. 是否接受**离线复算**（28/28 + 19/19 + 97 项测试）作为该交付的功能验收依据。
4. 是否接受 **R-33（运行期写入边界）与 R-37（冲突即停）依 run5 历史证据**判定，而不是离线重放。
5. 是否接受已声明的能力限制（缓存采集点离散、`selfCheck` 只覆盖 schema、单平台实测），且**不因此新增“必须连续监控缓存”的验收要求**。
6. 历史残留与来源不明的 worktree 注册项**暂不处理**（见 `MAINTENANCE.md`），是否同意。

### 明确不包含在本确认内的内容

- **任何远端操作**：push、创建/修改 PR（含草稿 PR #2）、合并 `main`——这些按 `AGENTS.md` §9 需要**单独授权**。
- 任何历史证据的重写、任何 ACL 修改、任何清理动作。
- 对本清单未列出的其他提交或分支的认可。

## 5. 可直接回复的验收文字（示例）

> 我确认交付提交 `[C39]`（`examples/text-stats/` 三个文件）符合 `v0.2-demo-input-3` 第 2 节 R-01 – R-37；接受离线复核结论（28/28 条目、19/19 反例、97 项交付测试 0 失败 0 错误 0 跳过）、R-33/R-37 依历史证据判定，以及已声明的能力限制；同意历史残留与来源不明 worktree 暂不处理。本确认**不包含** push、PR 或合并授权。

（若不同意其中某条，请指明条目编号；验收状态将保持“未通过”，直到该条被处理或明确豁免。）
