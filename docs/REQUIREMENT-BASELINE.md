# V0.1 演示任务需求基线（`examples/text-stats`）

> **基线版本**：`v0.1-demo-baseline-1`
> **裁定日期**：2026-10-17（本机 +08:00）
> **裁定方式**：仓库所有者人工裁定，逐项确认 P-1 – P-6（见 `docs/REQUIREMENT-CALIBER.md` 第 3 节）
> **适用范围**：V0.1 演示任务 `examples/text-stats/`（Requirement → Coding → Verifier → Review 流水线的演示目标）
> **状态**：**已裁定（仅限本文第 1 节的六项口径）**

本文把 **P-1 – P-6 六项已确认口径**固化为可版本化的需求基线。规则文本**采用** `docs/evidence/v0.1-run6-20261016T154400Z/requirement.json`（下称"run 6 需求"）中的相应条文，并引用 `docs/evidence/v0.1-second-run/requirement.json`（下称"run 2 需求"）作为冲突来源与历史依据。

**明确不成立的推论**：本文**不**把 run 6 需求整体认定为已批准。run 6 需求中未被第 1 节引用的条文（见第 5.1 节清单）仍属**未逐条裁定**，只是当前实现与测试正在沿用它们。

**历史证据不改字节**：`docs/evidence/**` 下的 JSON、脚本与输出文件一个字节都没有被本文改写；口径上的替代关系一律以本文与 `docs/REQUIREMENT-CALIBER.md` 的**追加说明**表达（见第 3 节）。

## 1. 基线条目（RB-1 – RB-6，已人工确认）

### RB-1 程序化调用必须静默

**口径**：显式传入 `stdin_text`（含空串）时，`main(argv, stdin_text=...)` **只返回整数退出码**，不写标准输出、不写 stderr、不读进程标准输入。

- **可观察结果**：`main([], stdin_text='')` → 返回值 `0`，屏幕上**没有任何**输出；外层命令
  `python -c "import text_stats as t; code = t.main([], stdin_text=''); print(callable(t.main), code, type(code).__name__)"`
  的 stdout 恰为 `True 0 int`（那三个值由**外层 `print`** 写出，见第 4 节）。
- **来源**：run 6 需求 BC-15（`:72`，"作用域 a"）；run 2 需求 AC-12（`:45`）。
- **实现**：`examples/text-stats/text_stats.py:250`（`programmatic = stdin_text is not None`）、`:273-275`（`elif programmatic: return EXIT_OK`）。
- **测试**：`examples/text-stats/test_text_stats.py:384`、`:387`、`:393`、`:411`、`:530`。

### RB-2 命令行空标准输入必须成功输出四行零值

**口径**：命令行调用、未给出文件路径、进程标准输入立即 EOF 时，走**成功路径**：输出恰好 4 行、四项全 0、退出码 0、不阻塞等待输入。

- **可观察结果**：标准输入重定向为空文件后运行 `python examples/text-stats/text_stats.py` →
  `char_count: 0` / `line_count: 0` / `non_empty_line_count: 0` / `word_count: 0`，退出码 `0`。
- **来源**：run 6 需求 AC-13（`:45`）、BC-16（`:73`，"作用域 b"）。
- **实现**：`examples/text-stats/text_stats.py:276-281`、`:283-285`。
- **测试**：`examples/text-stats/test_text_stats.py:490`（立即 EOF ⇒ 四行 0）。

### RB-3 组合记号与归一化：只允许一个期望值

**口径**：不做任何 Unicode 归一化（NFC/NFD 都不做）。

- `'cafe' + U+0301`（`e` 后接组合重音）⇒ `word_count == 1`、`char_count == 5`；
- 预组合形式 `'café'`（U+00E9）⇒ `word_count == 1`、`char_count == 4`；
- 把该输入的 `word_count` 断言为 **2 是错误**（历史缺陷，任何版本的需求都不允许）。

**来源**：run 2 需求 BC-09（`:61`）、AC-07（`:40`，并明文禁止断言 2）、SI-10（`:18`）、AC-14（`:47`）、BC-17（`:69`）、BC-18（`:70`）；run 6 需求 BC-12（`:69`，"同一输入只允许一个期望值 1，任何给出的 2 均为错误"）、BC-08（`:65`，4 码点 / 5 码点）。
**实现**：`examples/text-stats/text_stats.py:75-76`（连接符常量）、`:82`（单词正则 `[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*`，只认 ASCII 字母）、`:97-101`（归一化只做 BOM 与换行，不做 Unicode 归一化）。
**测试**：`examples/text-stats/test_text_stats.py:345-346`、`:348-350`、`:352-353`。

### RB-4 行边界集合只有 LF / CRLF / CR

**口径**：行边界集合 = { LF (`\n`)、CRLF (`\r\n`)、CR (`\r`) }，**仅此三种**。`U+2028`、`U+2029`、`\x0b`、`\x0c`、`\x1c`、`\x1d`、`\x1e`、`\x85` **一律不是行边界**：它们保留在行内容里，并计入 `char_count`。归一化顺序固定为"先把 `\r\n` 换成 `\n`，再把剩余的 `\r` 换成 `\n`"。因此 **`str.splitlines()` 不能作为 `line_count` 的唯一实现依据**。

- **可观察结果**：`'a' + U+2028 + 'b'` ⇒ `line_count == 1`、`char_count == 3`。
- **示例值全部保留**：`''→0`、`'\n'→1`、`'a\n'→1`、`'a'→1`、`'a\nb'→2`、`'a\n\n'→2`、`'hello world\nfoo bar\n'→2`、`'hello world\nfoo bar\n\n'→3`。
- **来源（替代关系）**：run 6 需求 BC-01（`:58`）**取代** run 2 需求 BC-03（`:55`）里"`line_count = len(T.splitlines())` 是唯一权威"的字面实现依据；run 2 BC-03 与 BC-02（`:54`，`line_count('a\u2028b') == 1`）的互斥由此消除，**结论值不变**。
- **实现**：`examples/text-stats/text_stats.py:97-101`、`:103-110`。
- **测试**：`examples/text-stats/test_text_stats.py:244-250`、`:252-253`（另有 run 6 的独立复核脚本按需求原文判定）。

### RB-5 冲突处理：AC 与 BC 之间没有隐式优先级

**口径**：同一调用方式、同一输入的期望值只允许一个。当一份需求内部对不同条文（含 AC 与 BC 之间）给出**互斥期望**时，**不设隐式优先级**：实施者（Requirement / Coding / Verifier / Review）不得自行选边，必须报出冲突并停止，等待人工裁定。

- **编排层门禁**：`workflows/three-agent-mvp.js:750-752`（任一阶段报告冲突 ⇒ `STAGE_REPORTS_REQUIREMENT_CONFLICT`，立即停止、不进入修订循环）、`:1567-1572`（需求自检报冲突 ⇒ `REQUIREMENT_CONFLICT`，不启动 Coding Agent）；三份阶段报告的 `requirement_conflicts` 均为必填字段（`:936`、`:954`、`:971`、`:987`、`:1005`、`:1047`），提示词要求写明 `refs` + `description` 而非选边（`:1213`、`:1240`、`:1290`、`:1364`）。
- **测试**：`tests/workflow-logic.test.mjs:217`、`:227`（`REQUIREMENT_CONFLICT`）、`:275`、`:285`、`:295`、`:305`（`STAGE_REPORTS_REQUIREMENT_CONFLICT`，含"冲突优先于其他失败原因"）。
- **历史描述更正**：run 2 需求 BC-17（`:69`）的"一律以本需求为准"讲的是"**需求** vs 交付目录内既有文档/测试的旧数值"，**不是** AC 与 BC 之间的优先级；原提案把 (a) 写成"BC 优先于 AC（第二轮实现实际这么做）"属于不准确的描述，已在 `docs/REQUIREMENT-CALIBER.md` 第 3 节更正。

### RB-6 空白行计入总行数，末尾换行不额外增加一行

**口径**：仅含空白字符的行**仍然是行**；末尾换行**不**产生额外空行。`'  \n\t\n'` ⇒ `line_count == 2`、`non_empty_line_count == 0`（写成 3 行是错误）。

- **来源**：run 6 需求 BC-05（`:62`，明文"记为 3 行均属错误"）、BC-06（`:63`）、BC-07（`:64`）；run 4 真实运行正是因该示例（2 行 vs 3 行）被门禁拦下。
- **实现**：`examples/text-stats/text_stats.py:103-110`（末尾空片段弹出）、`:115`（非空行判定用 `str.strip()`）。
- **测试**：`examples/text-stats/test_text_stats.py:197-200`、`:319-322`。

## 2. 调用方式与输出作用域（分层规则）

| 调用方式 | 标准输出 | 返回值 / 退出码 | 是否属于本次已裁定六项 |
| --- | --- | --- | --- |
| CLI（`python text_stats.py <文件>`） | 恰好 4 行 `<key>: <value>`，顺序 `char_count`、`line_count`、`non_empty_line_count`、`word_count` | 退出码 0 | 输出格式本身属**未逐条裁定**（沿用 run 6 BC-16/BC-19）；"只约束 CLI"这一点属 RB-1 |
| CLI（`python text_stats.py`，stdin 有输入） | 同上 | 退出码 0 | 同上一行 |
| CLI（`python text_stats.py`，stdin 为空 / 立即 EOF） | 4 行，四项全 0 | 退出码 0 | **RB-2（已裁定）** |
| 程序化注入（`main(argv, stdin_text=...)`，显式传入非空或空串） | **不写任何流** | 返回整数退出码 | **RB-1（已裁定）** |
| `--help` | argparse 帮助文本 | 退出码 0 | 未逐条裁定（沿用 run 6 BC-18） |
| 错误路径（文件不存在/不可读、编码名非法、位置参数多于 1 个） | stderr 一行以 `error: ` 开头 | 退出码 **1**（不得沿用 argparse 默认的 2） | 未逐条裁定（沿用 run 6 BC-18） |

要点：**"成功路径写 4 行"只约束命令行调用；"不打印"只约束显式注入输入的程序化调用**——两者作用域不同，run 2 需求 AC-12（`:45`）与 BC-12（`:64`）表面上的互斥由此消除，且**不改动任何一个具体期望值**。

## 3. 与历史证据的替代关系（不改字节）

| 历史文本 | 被谁取代 / 如何澄清 | 历史文件是否改动 |
| --- | --- | --- |
| run 2 需求 BC-03（`:55`）：`line_count = len(T.splitlines())` 为唯一权威 | 由 run 6 需求 BC-01（`:58`）与本文 RB-4 取代；示例值全部保留 | **否**（`docs/evidence/v0.1-second-run/requirement.json` 字节不变） |
| run 2 需求 AC-12（`:45`）与 BC-12（`:64`）互斥 | 由本文第 2 节的分层规则与 RB-1 / RB-2 消除 | **否** |
| run 6 需求 AC-10（`:42`）："`main([], stdin_text='')` 的标准输出为空，而不是 `True 0 int`" | 措辞把**外层命令的 stdout** 说成了 `main` 的 stdout；由本文第 4 节的澄清取代 | **否**（`docs/evidence/v0.1-run6-20261016T154400Z/requirement.json` 字节不变） |

上述目录内的所有 JSON、脚本与输出文件均保持原样；本文只做**追加说明**，不做就地改写。

## 4. 澄清：`main` 自身的输出 vs 外层 `print` 的输出

- **`main` 自身**：显式注入输入时不写任何流（RB-1），只返回整数退出码。
- **外层命令**：`python -c "import text_stats as t; code = t.main([], stdin_text=''); print(callable(t.main), code, type(code).__name__)"`
  的 stdout 恰为 `True 0 int` —— `True`（`callable(t.main)`）、`0`（`code`）、`int`（`type(code).__name__`）三个值由**外层 `print`** 写入，`main` 贡献的只是返回值 `0`。
- 因此 run 2 需求 AC-12（`:45`）的"标准输出为 `True 0 int`"与 run 6 需求 AC-10（`:42`）的"标准输出为空"说的是**同一事实的两面**（前者是外层命令、后者是 `main` 自身），并不矛盾。**不得**据此认为 `main` 会打印 `True 0 int`，也不得让 `main` 真的去打印。
- 本机实测（2026-10-17）：该外层命令 stdout = `True 0 int`，退出码 0；同一次调用中 `main` 未写任何流。

## 5. 未决 / 未批准清单

### 5.1 run 6 需求中**未被**本基线逐条批准的条文

以下条文当前被实现与测试沿用，但**尚未**经人工逐条裁定，不得据本文声称"run 6 需求已整体获批"：
AC-11、AC-12、AC-14 ~ AC-19、AC-22（示例值、错误路径、`--help`、依赖边界）；
BC-02（归一化顺序的逐字表述）、BC-03（只剥一个前导 U+FEFF）、BC-04（空文本四项全 0）、BC-06、BC-07（空白字符集合的逐字内容）、BC-08（码点数示例）、BC-09（单词正则逐字）、BC-10、BC-11、BC-13、BC-14、BC-18（退出码 1 / `--help` 0）、BC-19（输出标签与顺序）、BC-20（纯函数接口）、BC-21（无单行转发函数）、BC-22（只用标准库）、BC-23（示例一致性）、BC-24（连接符字符可辨认）。

### 5.2 其他未决问题

1. **以哪一轮需求文本为准**：run 2 与 run 6 是两份不同的需求文本；本文只在第 1 节的六项口径上给出替代关系，"V0.1 验收以哪一份文本为需求原文"这一元问题仍未裁定。
2. **人工审批的安全拒绝测试**：V0.1 验收条件 3 的正式验收缺口，未完成。
3. **新版真实流水线验证**：当前门禁下**没有**重跑真实子代理；run 6 是最后一次真实通过，而 `workflows/three-agent-mvp.js` 在其后已被修改（三个时钟、认领前状态门禁等）。因此"门禁通过"不能外推到"新代码下真实跑通"。
4. **既有文档的计数不一致（本轮未改，仅登记）**：`docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md` 第 9 节记"预检认领集成测试 5 场景 / 48 断言"，现为 **6 场景 / 59 断言**（见 `tests/README.md`）；`docs/ROADMAP.md` 写 `examples/text-stats/.test-scratch/` 残留目录 11 个，`ACCEPTANCE-STATUS.md` 第 8 节写 12 个。两处均未在本轮改动。
5. **V0.1 最终验收未通过**：本文是**需求口径**的基线，不是验收结论。

## 6. 版本化与变更流程

- 本文件用版本号标识：当前 `v0.1-demo-baseline-1`（2026-10-17，落地六项人工裁定）。
- 任何口径变更都必须：① 人工裁定 → ② 新增版本号（如 `v0.1-demo-baseline-2`）→ ③ 在本节追加一行变更记录 → ④ 同步更新引用本基线的文档（`docs/REQUIREMENT-CALIBER.md`、`docs/ROADMAP.md`、`README.md`、`docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md`）。
- **不得**就地改写已有版本的历史条目；`docs/evidence/**` 下的历史证据永不改写字节，口径变化一律通过追加说明表达。

### 变更记录

| 版本 | 日期 | 变更 | 裁定来源 |
| --- | --- | --- | --- |
| `v0.1-demo-baseline-1` | 2026-10-17 | 首次落地：RB-1 – RB-6 固化 P-1 – P-6 六项已确认口径；登记第 5 节未决清单 | 仓库所有者人工裁定（六项逐条确认） |

## 7. 与当前实现 / 测试的核对结果（2026-10-17 实测）

| 基线条目 | 实现位置 | 交付测试 | 独立探针结果 |
| --- | --- | --- | --- |
| RB-1 | `examples/text-stats/text_stats.py:250`、`:273-275` | `test_text_stats.py:384`、`:387`、`:393`、`:411`、`:530` | `main([], stdin_text='')` → 返回 `0`、无任何输出；外层命令 stdout = `True 0 int` |
| RB-2 | `text_stats.py:276-281`、`:283-285` | `test_text_stats.py:490` | 空 stdin 重定向 ⇒ `0/0/0/0` 四行、退出码 0 |
| RB-3 | `text_stats.py:75-76`、`:82`、`:97-101` | `test_text_stats.py:345-346`、`:348-350`、`:352-353` | `count_text('cafe\u0301')` → `char_count 5`、`word_count 1` |
| RB-4 | `text_stats.py:97-101`、`:103-110` | `test_text_stats.py:244-250`、`:252-253` | `count_text('a\u2028b')` → `line_count 1`、`char_count 3` |
| RB-5 | `workflows/three-agent-mvp.js:750-752`、`:1567-1572` | `tests/workflow-logic.test.mjs:217`、`:227`、`:275`、`:285`、`:295`、`:305` | `node tests/workflow-logic.test.mjs` → 81/81 场景、372 断言、退出码 0 |
| RB-6 | `text_stats.py:103-110`、`:115` | `test_text_stats.py:197-200`、`:319-322` | `count_text('  \n\t\n')` → `line_count 2`、`non_empty_line_count 0` |

**结论：六项已裁定口径与当前实现、当前测试完全一致，本轮未发现需要修改的实现或测试差异。**

完整回归（本轮实测，全部离线、未调用真实子代理）：
`python -m unittest discover -s examples/text-stats -p "test_*.py"` → `Ran 81 tests` / `OK`（退出码 0）；`node tests/workflow-logic.test.mjs` → 81/81 场景、372 断言、0 失败（退出码 0）。

### 7.1 勘误（**非口径变更**）：实现行号与用例数已位移

上表的行号记录的是 2026-10-17 核对当时的文件状态。此后 `examples/text-stats/text_stats.py` 为"程序化调用静默"补齐了 `--help` 与受控错误路径（`_report_error(..., quiet=...)`、`_parse_args(argv, quiet)`、编码校验前移），代码行整体下移，**口径本身未变**：

| 基线条目 | 当前实现位置（2026-10-17 收口后） |
| --- | --- |
| RB-1 | `text_stats.py:167-175`（`_report_error` 的 `quiet`）、`:223-235`（`_parse_args` 吞掉 argparse 输出）、`:280`（`programmatic` 分流）、`:307`（`elif programmatic: return EXIT_OK`） |
| RB-2 | `text_stats.py:311-318`（标准输入路径与 4 行输出） |
| RB-3 | `text_stats.py:78`、`:84`、`:99-101` |
| RB-4 | `text_stats.py:99-101`、`:103-112` |
| RB-6 | `text_stats.py:103-112`、`:115` |

用例数同样位移：交付测试现为 **86 例**（原 81 例，新增 8 例静默/编码回归、合并 2 个旧断言、保留其余），`python -m unittest discover -s examples/text-stats -p "test_*.py"` → `Ran 86 tests` / `OK`；编排逻辑回归现为 **85 场景 / 391 断言**（原 81 / 372）。

## 8. 相关文档

- 需求口径裁定提案与冲突原文（含 P-1 – P-6 的裁定记录与两处更正）：`docs/REQUIREMENT-CALIBER.md`
- 验收状态（含本轮追加的第 10 节）：`docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md`
- 新版真实流水线的需求输入候选稿（现行 `v0.2-demo-input-2`，待 Q1 批准；本文六项已落入其 R-01 / R-02 / R-16+R-19+R-24 / R-21+R-22 / R-37）：`docs/DEMO-REQUIREMENT-INPUT-v2.md`（前一版 `docs/DEMO-REQUIREMENT-INPUT.md` 保留供对照，已被取代）
- 流水线门禁与状态码表：`workflows/README.md`
- 演示交付物本身：`examples/text-stats/README.md`、`examples/text-stats/text_stats.py`、`examples/text-stats/test_text_stats.py`
