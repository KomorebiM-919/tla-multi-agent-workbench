# 无人值守离线加固与验收准备（2026-10-17）

> 本文档记录一轮**离线、无人值守**工作的审查范围、发现、修复与仍然不能证明的事情。
> 工作窗口：开始 `2026-10-17 13:14:18 +08:00`（05:14:18 UTC），预计结束 `2026-10-17 17:14 +08:00`。
> 本轮**没有**触发任何真实审批、**没有**运行真实模型子代理、**没有**联网、**没有** Push / 改 PR / 合并。
> 人工审批安全拒绝测试仍为**未执行**；V0.1 最终验收**仍未通过**。

## 0. 起点与终点

| 项 | 值 |
| --- | --- |
| 起始提交 | `[C01]` |
| 本轮提交 | `[C02]`（取证工具加固）→ `[C03]`（文档同步）→ `[C04]`（拒绝全体跳过）→ `[C05]`（行尾固定 + 性质测试） |
| 分支 | `feat/v0.1-three-agent-mvp`（本地，未 Push） |
| `origin/main` | `2f019920c8667378065fee947eeaa8636ca49bf4`（未改动） |
| `origin/feat/...` | `029bdcc72543dbc2b10fb5195aae976ecad479a1`（未改动） |
| 草稿 PR #2 | 未触碰（未评论、未改标题、未改草稿状态） |
| 工作区 | 除有意不入库的 `docs/review/` 外干净 |

## 1. 结论摘要

**已修复的确定性缺陷 2 个**（都有回归用例，且都用"旧行为"做过反向验证）：

1. **测试全体跳过被当作通过**（编排层，严重度中）：`OK (skipped=44)` 同时带着 `Ran 44 tests` 与 `OK` 标记，
   旧解析只看这两项，于是 Verifier 主验证、Review 独立复跑、Coding 输出摘录三处都能被"一个用例都没执行"
   的输出骗过。修复：解析 `skipped=N`，`skipped >= ran` 即判未执行。
2. **干净副本里交付测试必然失败**（可复现性，严重度中）：仓库无 `.gitattributes`，本机 `core.autocrlf=true`
   时 `git archive` 导出与在新机器检出都会把 `examples/text-stats/sample_input.txt` 变成 CRLF，
   而 `test_ac22` 断言该文件恰好是 LF 字节。修复：只固定这一个数据文件的行尾。

**只报告、未改动的观察 5 条**（涉及行为取舍或仅方向安全的收紧，见 §3.3 – §3.7）。

**仍然不能证明的事**：真实人工审批拒绝（未执行）、真实模型流水线在新门禁下是否通过（未运行）、
远端分支是否未被他人改动（本轮不联网，标"未观测"）。

## 2. 工作包 B：对当前工作流的独立离线审查

方法：用 `tests/.scratch/unattended/review-probe.mjs`（**真实生产脚本** `workflows/three-agent-mvp.js` +
`tests/workflow-harness.mjs` 的可控模拟输入）逐项打靶，16 个场景。原始输出存
`tests/.scratch/unattended/review-probe.txt`（修复前）与 `review-probe-after-fix.txt`（修复后）。

| 审查项 | 场景 | 修复前 | 修复后 | 判定 |
| --- | --- | --- | --- | --- |
| 成功判定与失败优先级 | V1 Verifier 全跳过 | `OK` / `ok=true` | `MAX_ATTEMPTS_INCONSISTENT_EVIDENCE` | 缺陷，已修 |
| 同上（全链路） | V2 三处输出全是 `OK (skipped=44)` | `OK` / `ok=true` | `MAX_ATTEMPTS_CODING_REPORT_INCONSISTENT` | 缺陷，已修 |
| 同上（修订轮） | V15 Review 复跑全跳过 | `OK` / `ok=true` | `MAX_ATTEMPTS_INCONSISTENT_REVIEW` | 缺陷，已修 |
| 同上（摘录） | V16 Coding 摘录全跳过 | `OK` / `ok=true` | `MAX_ATTEMPTS_CODING_REPORT_INCONSISTENT` | 缺陷，已修 |
| 多组摘要 | V3 `OK` 后出现 `FAILED` | 拒绝（`INCONSISTENT_EVIDENCE`） | 不变 | 正确 |
| 多组摘要 | V4 `FAILED` 后出现 `OK` | 拒绝（用例数 44 vs 3 不一致） | 不变 | 正确 |
| 矛盾退出码 | V5 退出码是数字 `0` 而非字符串 | 拒绝（`asString(0)===''`） | 不变 | 正确（偏严） |
| 类型错误 | V6 `ran_tests` 是字符串 `"44"` | `OK` | `OK` | 报告（§3.2） |
| 类型错误 | V13 Coding 返回字符串而非对象 | 拒绝（`MAX_ATTEMPTS_CODING_OUTPUT_INVALID`） | 不变 | 正确 |
| 路径规范化 | V7 指纹路径为 `./examples/...` | 拒绝（判为"配置之外的无关文件"） | 不变 | 报告（§3.3） |
| 路径规范化 | V8 指纹路径用反斜杠 | `OK` | `OK` | 设计如此（归一化） |
| 路径规范化 | V9 指纹路径大小写不同 | `OK` | `OK` | 设计如此（小写化） |
| 时间戳 | V10 非法闰日 `2026-02-29` | 拒绝（`INVALID_TIMESTAMP`） | 不变 | 正确 |
| 时间戳 | V11 合法闰日 `2028-02-29` | 夹具错误 → 修正后 `OK` | `OK`（独立探针 `leap-probe.mjs`） | 正确 |
| 时间戳 | V12 `+14:00` 时区 | `OK` | `OK` | 正确 |
| 异常返回 | V14 子代理抛异常 | 异常直接冒泡（无结构化结果） | 不变 | 报告（§3.4） |

### 3.1 缺陷 1：全体跳过被当作通过（已修复）

- **最小复现**：`verify` 返回 `raw_output: "Ran 44 tests in 0.021s\n\nOK (skipped=44)\n"`，
  Coding 与 Review 其余自述合法 → 修复前 `status: "OK"`、`ok: true`。
- **预期**：没有任何用例真正执行，不得判通过（需求侧的等价表述：`Ran N tests` 只说明"发现并载入了 N 个用例"，
  跳过不等于执行）。
- **实际（修复前）**：`OK (skipped=44)` 命中 `okMatch`，`Ran 44` 满足 `ran >= 1`，两条判据同时成立。
- **影响**：一个没有真正跑测试的 Coding Agent（或环境被配置成全跳过）可以拿到 `ok=true`，
  这是"自述可以替代证据"的老漏洞的新变体；只影响离线演示编排，不涉及真实模型行为。
- **源码位置**：`workflows/three-agent-mvp.js:514-545`（`parseUnittestOutput` / `judgeTestEvidence`）、
  `:620-650`（`judgeReviewConsistency` 的复跑判定）、`:686-700`（`judgeCodingReportConsistency` 的摘录判定）。
- **修复**：新增 `skipped` 解析、`isAllTestsSkipped()`、`allSkippedReason()`，三处判定点各加一条拒绝；
  `Ran 0 tests` 的旧判据保留。回归：`tests/workflow-logic.test.mjs` 新增 4 个场景（三处拒绝 + 部分跳过
  `skipped=2 / Ran 44` 仍 `OK`，确保不误拒）；逻辑回归 81 → **85 场景 / 372 → 391 断言**。
- **反向验证**：同一批探针在修复后由 4 个 `ok=true` 变为 4 种拒绝，而 V3/V4/V5/V10/V12/V13 结果不变。

### 3.2 观察：`ran_tests` 的类型没有被强制

`judgeTestEvidence` 只在 `isInteger(declaredRan)` 时比对自述用例数（`workflows/three-agent-mvp.js:544-547`），
字符串 `"44"` 被静默忽略——自述值不会被采信，但也没有被拒绝。方向安全（忽略而不是放行），
建议在后续版本改成"类型不符即拒绝"，本轮只记录。

### 3.3 观察：指纹路径的 `./` 前缀不被归一

`normalizeAbsPath`（`workflows/three-agent-mvp.js:161-163`）只统一分隔符、去掉末尾斜杠，随后小写化
（`:258`、`:280`）；`./examples/...` 因前缀不同被 `judgeFingerprints` 判为"配置之外的无关文件"
（`:292-301`）。反斜杠（V8）与大小写（V9）都能被接受，唯独 `./` 不行——**口径不一致，但方向安全**
（拒绝而不是放行）。要不要统一归一化（接受 `./`）属行为取舍，本轮只记录。

### 3.4 观察：子代理抛异常没有结构化兜底

脚本内没有任何 `try/catch` 包裹 `await agent(...)`（5 个调用点：`:1397`、`:1543`、`:1594`、`:1621`、`:1638`），
异常会直接冒泡，运行以工具错误结束，已写入磁盘的阶段证据保留但没有 `workflow-result.json` 的结构化分类。
这是宿主层面的行为取舍（要不要转成 `AGENT_FAILED` 状态），本轮只记录。

### 3.5 观察：时间戳校验通过（正向结论）

合法闰日 `2028-02-29` 被接受（`leap-probe.mjs` → `{"status":"OK","ok":true}`），非法闰日 `2026-02-29` 被
`MAX_ATTEMPTS_INVALID_TIMESTAMP` 拒绝，`+14:00` 时区被接受，窗口锚在 `runStartedAt`（7 小时后仍拒绝）。
本轮未发现时间戳缺陷。

### 3.6 观察：并发/重复执行

`tools/claim_evidence_dir.py` 的重复认领（marker 已存在 → 退出码 10）既有回归 `tests/test_claim_evidence_dir.py`
（11 用例）**已经包含 8 个进程同时认领同一目录的用例：只有一个成功，其余退出码 10**
（见 `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md:152`）。
所以"并发认领会双成功"这一点已有实验覆盖；**未做的是额外压力测试**（更长时间、更多进程、跨机器、断网等情况），
这两件事不能混为一谈——本文档早先写成"并发窗口没有实验覆盖"是错的，已在此更正。
仍然**未证明**的是"任意调度下绝不双成功"：已有用例只覆盖 8 进程这一种竞争形态。

### 3.7 观察：指纹与配置的绑定

已有回归覆盖"多报 / 少报 / 重复 / 大小写"（`tests/workflow-logic.test.mjs` 场景 28 附近），
本轮探针确认"两侧一致地多报"仍被拒。未发现新缺陷。

## 4. 工作包 C：有界、可复现的性质测试

新增 `tests/property_text_stats.py`（只用标准库）：

- 参考实现**独立编写**（按字符扫描切行、扫描式词计数），不 import 生产函数自证正确；
- 固定种子 `0–9`、每种子 120 组随机输入 + 16 条固定示例 + 1 条 200000 字符长文本 = **1217 组**，墙钟上限 60 秒；
- **证明范围分两层**：(A) 16 条固定示例直接断言已批准口径 RB-2/RB-3/RB-4/RB-6 的可观察结果；
  (B) 其余 1201 组是"生产实现与独立参考实现一致"的检查，**其中包含尚未逐条批准的规则**（单词正则形状、
  连接符集合、只剥一个前导 BOM）。这一层不构成对这些规则的批准；
- 脚本**不覆盖** RB-1（程序化调用静默）与 RB-5（编排层冲突门禁），也不证明 RB-2 的 CLI 输出路径——
  那些由 `examples/text-stats/test_text_stats.py`、`tests/preflight-claim-integration.test.mjs`、
  `tests/workflow-logic.test.mjs` 各自提供证据；
- **不断言"归一化幂等"**：只剥一个前导 BOM 时 `'\ufeff\ufeffabc'` 第二次归一化还会再少一个字符，幂等并不成立；
- 未批准口径（数字算不算词、词中组合记号）只记录出现次数，不作结论；
- 失败时缩减为最小反例并打印复现命令。

结果：`exit 0`，1217 组全部通过，耗时 0.1–0.2 秒。

**反向验证**（确认它抓得住错实现）：把三个故意改坏的副本通过 `TLA_TEXT_STATS_PATH` 喂进去，三个都被判失败：

| 变异体 | 改动 | 最小反例 | 退出码 |
| --- | --- | --- | --- |
| `mutant-no-pop` | 去掉"末尾空片段"逻辑 | `'\n'` | 1 |
| `mutant-splitlines` | 改用 `str.splitlines()` 当行边界 | `'a\u2028b'` | 1 |
| `mutant-no-joiner` | 丢掉 `U+2019` 连接符 | `'Z\u2019X'` | 1 |

## 5. 工作包 D：干净副本可复现性核验

用 `git archive HEAD` 在 `tests/.scratch/unattended/clean copy/tla repo`（**路径含空格**）构建干净副本：
95 个文件，无 `docs/review/`、无 `tests/.scratch/`、无 `.git`，不依赖任何未跟踪文件与缓存。

| 套件 | 修复前（`clean-*.txt`） | 修复后（`clean2-*.txt`） |
| --- | --- | --- |
| 编排逻辑 | exit 0，85/85、391 断言 | exit 0，85/85、391 断言 |
| 认领集成 | exit 0，6/6、59 断言 | exit 0，6/6、59 断言 |
| 取证回归 | exit 0，90/90 | exit 0，90/90 |
| 取证反向验证 | exit 0，18/18 | exit 0，18/18 |
| 性质测试 | 文件当时未入库（`Errno 2`） | exit 0，1217 组 |
| 交付测试 | **exit 1，`test_ac22` 失败** | exit 0，`Ran 81 tests` / `OK` |
| 认领工具 unittest | exit 0，`Ran 11 tests` / `OK` | exit 0，`Ran 11 tests` / `OK` |

**缺陷 2 的最小复现**：`AssertionError: 'hello world\r\nfoo bar\r\n' != 'hello world\nfoo bar\n'`，
位置 `examples/text-stats/test_text_stats.py:710`（`test_ac22_sample_input_is_the_documented_reference_text`）。
存储字节是 LF（`git cat-file blob` 20 字节），本机工作区也是 LF，但 `git archive` 与在新机器检出会按
`core.autocrlf=true` 转成 CRLF。修复：`.gitattributes` 只固定该文件 `text eol=lf`；修复后干净副本里该文件
字节为 `68 65 6C 6C 6F 20 77 6F 72 6C 64 0A ...`。**已知限制**：这只固定了一个数据文件；其它文本文件在新
机器上仍会按对方 `core.autocrlf` 检出（`eol` 全局策略属项目约定，本轮不代为决定）。

**行尾对哈希的影响**：`git archive` 导出的是**存储字节经属性过滤后**的结果，工作区字节取决于
`core.autocrlf`；因此任何"对文件内容算哈希"的结论都必须写明口径（存储字节 / 工作区字节 / 导出字节），
不能混用。本轮所有材料哈希都以工作区字节为准，并在材料清单里注明。

## 6. 工作包 E：要求 → 实现 → 测试 → 证据 → 状态

### 6.1 演示程序（`examples/text-stats`）

| 要求 | 实现 | 测试 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| RB-1 程序化调用静默 | `text_stats.py:250`、`:273-275` | `test_text_stats.py:384-388`、`:530` | 干净副本 exit 0 | 已证明 |
| RB-2 CLI 空 stdin → 四行 0 | `text_stats.py:276-285` | `:490` | 同上 | 已证明 |
| RB-3 `cafe+U+0301` = 1 词 / 5 字符，不做 NFC | `text_stats.py:82` | `:348-350` | 同上 | 已证明 |
| RB-4 行边界仅 LF/CR/CRLF | `text_stats.py:97-110` | `:244-250`、`:252` | 同上 | 已证明 |
| RB-5 无隐式优先级（编排层） | `three-agent-mvp.js:750-752`、`:1567-1572` | `tests/workflow-logic.test.mjs:217-236`、`:275-313` | 逻辑回归 exit 0 | 部分证明（模拟输入） |
| RB-6 空白行算行、末尾换行不加行 | `text_stats.py:103-110`、`:115` | `:197-200`、`:319-322` | 干净副本 exit 0 | 已证明 |
| run 6 其余条文（AC-11/12/14–19/22、BC-02/03/04/06/07/08/09/10/11/13/14/18–24） | 已实现，但**未被逐条裁定** | 若干 | — | 未批准（不得当作验收结论） |

### 6.2 编排门禁

| 要求 | 实现 | 测试 | 状态 |
| --- | --- | --- | --- |
| 成功判定与失败优先级 | `judgeAttempt` / 各 `MAX_ATTEMPTS_*` | 逻辑回归 85 场景 | 部分证明（模拟输入，非真实模型） |
| 全体跳过不得通过 | `parseUnittestOutput` + `isAllTestsSkipped` | 新增 4 场景 | 已证明（本轮修复） |
| 需求冲突即停 | `:750-752`、`:1567-1572` | 逻辑回归 6 场景 | 已证明 |
| 时间戳（日历/窗口/时钟推进/闰日/时区） | `judgeTimestamp` + 每阶段重读时钟 | 逻辑回归 6 场景 + `leap-probe.mjs` | 已证明（检查是"不可能性检查"，不能证明时间戳来源真实） |
| 证据认领与路径规范化 | `:1489-1502`、`:1454-1463` | 逻辑回归 + 认领集成 6/59 | 已证明 |

### 6.3 宿主安全（审批拒绝）

| 要求 | 实现 | 测试 | 状态 |
| --- | --- | --- | --- |
| 判定逻辑（缺证据不得 PASS、事件关联、无副作用边界、日志切帧） | `tools/approval-rejection-evidence.mjs` | 116 断言 / 18 组 v1→v3 + 7 组 v2→v3 反向验证 | 已证明（逻辑层；不含真实审批） |
| **真实人工拒绝** | — | — | **未执行**（需用户亲自点"拒绝"） |
| 远端未被改动 | — | — | **未观测**（本轮不联网） |

## 7. 工作包 F：有界恢复与资源检查（只做能做的）

- **脚本超时**：`tests/` 下的 `spawnSync` 调用**没有**设置 `timeout` 选项；若被调用的 `python`/`git` 挂起，
  测试套件会一起挂住（不会误报成功，但会阻塞）。建议后续加 `timeout`，本轮只记录。
- **取证工具覆盖写**：已改为 `flag: 'wx'` 排他创建（`tests/approval-rejection-evidence.test.mjs` 有拒绝覆盖用例）。
- **日志解析资源边界**：整份会话日志会一次性读入内存（本轮实测 6573 帧 / 10395 事件正常）；超大日志的
  内存上界未压测，只记录。
- **认领失败/中途终止恢复**：`tools/claim_evidence_dir.py` 在失败时无残留（既有 11 用例覆盖）；遗留
  `.run-owner.json` 的清理仍属人工决定，工具不自动清理。

## 8. 材料与复算

所有原始输出存 `tests/.scratch/unattended/`（该目录被 `.gitignore:120` 忽略，不入库）：
`{approval-evidence,approval-mutation,workflow-logic,claim-integration,text-stats,tools-unittest}-final.txt`、
`review-probe.txt` / `review-probe-after-fix.txt`、`leap-probe.txt`、`property.txt`、`mutant-{no-pop,splitlines,no-joiner}.txt`、
`clean-*.txt`（修复前）、`clean2-*.txt`（修复后）。

复算命令（任选其一）：

```powershell
node tests/workflow-logic.test.mjs                       # 85/85、391 断言
node tests/preflight-claim-integration.test.mjs          # 6/6、59 断言
node tests/approval-rejection-evidence.test.mjs          # 116/116
node tests/approval-evidence-mutation.test.mjs           # 18/18 + strict 7/7
python tests/property_text_stats.py                      # 1217 组
python -m unittest discover -s examples/text-stats -p "test_*.py"   # Ran 81 / OK
python -m unittest discover -s tests -p "test_*.py"      # Ran 11 / OK
```

## 9. 复审修复（2026-10-17 第二轮，离线）

首次审查交上去之后被复审推翻了几处"以为已经证明"的地方。原样记录，因为它们比结论更有用：

### 9.1 六种"缺失值相等"曾被判 PASS

`compareStates` 旧版只在"两边的值都存在且不相等"时报失败，于是下面六种情形全部通过（都在合成夹具上复现过）：

| 情形 | 旧版结果 | v3 结果 |
| --- | --- | --- |
| `before.target` 与 `after.target` 都是 `null` | PASS | `TARGET_UNMEASURED` + INCOMPLETE |
| `target.exists` 两边都是 `null` | PASS | `TARGET_EXISTS_UNMEASURED` |
| `identity.sessionId` 两边都是 `null` | PASS | `SNAPSHOT_IDENTITY_UNMEASURED` |
| 两份快照 `sessionId` 相同但不是日志里的会话 | PASS | `SNAPSHOT_SESSION_MISMATCH`（FAIL） |
| `repo.root` 两边都是 `null` | PASS | `REPO_ROOT_UNMEASURED` |
| 执行前目标已存在、执行后不存在 | PASS | `TARGET_EXISTED_BEFORE`（FAIL） |

根因是"用相等代替测量"：`undefined === undefined` 被当成"前后一致"。v3 改成**先判是否测到（→ INCOMPLETE），
再判是否相同（→ FAIL）**，并给每个字段加类型判据（`isMeasuredString/Boolean/Number`）。

### 9.2 审批操作没有被绑定到被观察的目标

旧版只检查"有一次带 marker 的审批被拒绝、有一次工具失败、目标前后都在"，**没有核对被审批的命令是什么**，
所以"审批一次无害写入、快照却检查另一个文件"也能通过。v3 引入规范命令契约：

```
Set-Content -LiteralPath '<target>' -Value '<marker>' -Encoding ascii -NoNewline
```

`toolCall.command` 必须与该契约逐字一致（规范化只折叠空白、统一分隔符）：不一致 → `APPROVAL_COMMAND_UNBOUND`（FAIL），
没有 `command` 字段 → `APPROVAL_COMMAND_UNMEASURED`（INCOMPLETE，**不**降级成 PASS），`justification` 里没写目标路径 →
`TARGET_NOT_IN_JUSTIFICATION`。这里刻意**不**解析任意 PowerShell 命令——只是比对一条已知写法，读不懂就判证据不完整。

### 9.3 取证回归在审查环境里 85/90

原因是临时 git 仓库 `git init` 没成功，随后 HEAD、内容范围等五项断言级联失败。v3 的修法不是"跳过"，而是：
先断言 `git init` 的退出码与 stderr，**前置失败就单独报错并 return**，不把环境问题伪装成产品缺陷；
临时仓库改到仓库内唯一命名的 `tests/.scratch/` 下（已被 `.gitignore` 忽略），不依赖系统临时目录。

### 9.4 被夸大的证明范围

- 性质测试曾被写成"校验已批准口径 RB-1 – RB-6"，实际它比对的是**完整参考计数**（含未批准的单词正则、连接符、BOM 规则），
  且**不**覆盖 RB-1（程序化调用）与 RB-5（编排冲突门禁）。现在分 (A) 已批准固定示例 / (B) 实现一致性两层标注。
- "归一化幂等"曾被写成性质，但只剥一个前导 BOM 时它并不成立（`'\ufeff\ufeffabc'`）。已删除该断言。
- 并发：认领工具的 11 项既有测试**已含 8 进程并发用例**，"没有实验覆盖"的说法是错的；正确表述是"已有 8 进程覆盖，
  未做额外压力测试，也未证明任意调度下绝不双成功"（见 §3.6 的更正）。
- **机器局部判定 ≠ 完整验收**：`machine.verdict = PASS` 只代表日志与快照里那些被测量的字段符合预期；
  远端未被观测、内容范围有跳过项、真实人工拒绝未发生时，不得宣称"无副作用已完整证明"。

### 9.5 本轮修订后的计数

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 取证回归 | `node tests/approval-rejection-evidence.test.mjs` | 116 断言，exit 0 |
| 反向验证 | `node tests/approval-evidence-mutation.test.mjs` | 18 组 v1→v3 + 7 组 v2→v3，exit 0 |
| 工作流逻辑 | `node tests/workflow-logic.test.mjs` | 85/85、391 断言，exit 0 |
| 认领集成 | `node tests/preflight-claim-integration.test.mjs` | 6/6、59 断言，exit 0 |
| 性质测试 | `python tests/property_text_stats.py` | 1217 组，exit 0 |
| 交付单元测试 | `python -m unittest discover -s examples/text-stats -p "test_*.py"` | Ran 81 / OK |
| 认领工具单元测试 | `python -m unittest discover -s tests -p "test_*.py"` | Ran 11 / OK |

原始输出见 `tests/.scratch/unattended/v3/`。
