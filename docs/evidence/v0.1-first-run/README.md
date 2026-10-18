# V0.1 首个三 Agent 工作流运行记录（`v0.1-first-run`）

本目录是 **V0.1 首个 MVP**（Requirement → Coding → Review 三个独立 Agent）唯一一次真实运行的原始证据归档。所有文件都是这次运行的**实际产物**，不是示例或模拟文本。

| 项目 | 值 |
| --- | --- |
| 运行标识 | `v0.1-first-run` |
| 运行日期 | 2026-10-16（本机系统时间 +08:00） |
| 功能分支 | `feat/v0.1-three-agent-mvp` |
| 工作流脚本 | [`workflows/three-agent-mvp.js`](../../../workflows/three-agent-mvp.js) |
| 角色提示词 | [`agents/requirement-agent.md`](../../../agents/requirement-agent.md)、[`agents/coding-agent.md`](../../../agents/coding-agent.md)、[`agents/review-agent.md`](../../../agents/review-agent.md) |
| 执行方式 | 宿主 DeepSeek Harness 的 **Workflow 工具**（编排脚本运行在 DSH 宿主内，逐步调用真实 **Subagent**；不是由单个模型分饰三角） |
| 子代理执行次数 | **5 次**（需求 1 次；编码 2 次；审核 2 次） |
| 模型 | 三个角色本次均使用本机 DSH 默认模型，未做 per-agent 模型覆盖（多模型分工属 V0.2） |

## 1. 执行轨迹（真实的回溯/修订闭环）

```text
Requirement Agent ──requirement.json──▶ Coding Agent（第 1 轮）
                                          │ coding-report.json（42 个测试全绿）
                                          ▼
                                    Review Agent（第 1 轮）
                                          │ review.json：verdict = CHANGES_REQUESTED
                                          │ （4 条 issue：3 条需求内部矛盾 + 死代码 + scratch 目录）
                                          ▼
                                    Coding Agent（第 2 轮修订）
                                          │ coding-report-revision-2.json（44 个测试全绿）
                                          ▼
                                    Review Agent（复审）
                                          │ review-revision-2.json：verdict = APPROVED
                                          ▼
                                    编排层独立复核（本目录 orchestrator-verification.py）
```

第一轮审核给出 `CHANGES_REQUESTED`、编码 Agent 修订、复审给出 `APPROVED`——这条真实回路本身就是「三个 Agent 独立执行且结果真实传递」的证据。

## 2. 证据文件

| 文件 | 产出者 | 内容 |
| --- | --- | --- |
| `requirement.json` | Requirement Agent | 目标、范围（`scope_in` 10 条 / `scope_out` 9 条）、**13 条验收条件（AC-01…AC-13）**、**15 条边界条件（BC-01…BC-15）**、4 条 `open_questions` |
| `coding-report.json` | Coding Agent（第 1 轮） | 交付文件清单、实现摘要、AC 覆盖自述、真实测试命令与输出、与需求的偏离说明 |
| `coding-report-revision-2.json` | Coding Agent（第 2 轮） | 按复审意见修订后的交付清单与复验结论（删除死代码常量、新增 scratch 目录契约测试、新增交付目录内 `.gitignore`） |
| `review.json` | Review Agent（第 1 轮） | `verdict = CHANGES_REQUESTED`；13 条 AC 逐条 `satisfied` 判定；4 条 issue（含文件与行号）；独立复跑测试的命令与结果 |
| `review-revision-2.json` | Review Agent（复审） | `verdict = APPROVED`；13 条 AC 逐条判定；6 条低优先级问题；独立复跑结果 |
| `test-output.txt` | 编排层（仓库所有者） | 编排层亲自执行的单元测试原始输出：`Ran 44 tests` + `OK`，退出码 0 |
| `orchestrator-verification.py` | 编排层 | **独立复核脚本**（不使用 Coding Agent 的测试）：45 项检查，含需求 BC 原文示例、BC-05 不变量穷举、CLI 退出码与输出格式、仅标准库 import |
| `orchestrator-verification-output.txt` | 编排层 | 上述脚本的真实输出：`checks=45 failures=0`，退出码 0 |

## 3. 交付产物（演示项目本身）

演示项目在 [`examples/text-stats/`](../../../examples/text-stats/)：仅标准库的文本统计 CLI + 纯函数 + 测试 + 文档。

## 4. 编排层独立复核结果

- 单元测试（Coding Agent 自带）：**44 个用例全部通过**，退出码 0（`test-output.txt`）。
- 编排层独立检查：**45 项全部通过**，退出码 0（`orchestrator-verification-output.txt`）。检查向量直接取自需求 BC 条文的例子（BC-01/02/03/04/05/11/14）以及编排者按需求文字独立推导的输入，不读取实现内部细节。
- 结论：实现与需求 BC 条文一致；未发现「静态文本冒充运行结果」的痕迹（每份 JSON 都带真实测试输出、退出码与文件清单）。

### 复核过程的诚实记录

1. 编排层脚本**第一轮**曾在 4+1 处报 FAIL，经与 BC-01/02/03/04/11 原文逐条核对，确认是**编排者期望值写错**（CRLF 归一化后的 `char_count`、`'\n'` 的行数、两处字符数算术、BOM-only 输入），实现本身正确；脚本已按需求原文更正后全绿。这些错误保留在此记录，不隐藏。
2. 本目录内由子代理写出的文件中出现的**本机绝对路径已统一替换为 `<repo>`**（仅此一项机械替换，其余内容未改动）；替换后 JSON 仍可正常解析。

## 5. 证据卫生检查

- 敏感信息扫描（`sk-`*、`ghp_*`、`AKIA…`、`BEGIN PRIVATE KEY`、`password=`、`api_key=`、`Bearer <长令牌>`）：**7 类模式 0 命中**。
- 本机绝对路径：本目录内**0 处**（已替换为 `<repo>`）。
- 文件编码：UTF-8 无 BOM。

## 6. 已知问题（均不阻塞本次交付，如实记录）

1. **需求文本自相矛盾（根因，位于 `requirement.json`，非实现缺陷）**：
   - AC-02/AC-06 要求 `count_text('hello world\nfoo bar\n')['line_count'] == 3`，而 BC-03 明文规定「以换行结尾不产生额外的空行」（`'a\n'` → 1），AC-07 对同样以换行结尾的输入也要求 1；两者数学上不可同时成立。
   - AC-05 要求 `'cafe\u0301'` 的 `word_count == 2`，而 BC-06 规定用 `[A-Za-z]+` 在归一化文本上 `findall`，只能得 1；BC-09 自身又对等价写法 `'café'` 断言 1。
   - BC-09 的示例 `count_text('naïve')['word_count'] == 1` 与其依据的 BC-06 规则不符（该写法实测为预组合 `U+00EF`，按正则得 2）。
   - 实现按 `scope_in` 第 7 条「BC-01..BC-11 是实现与验收的唯一判定依据」统一取 BC 口径，两位 Review Agent 均独立确认这三处**在任何实现下都无法同时满足**，故不构成编码缺陷。改进方向（供下一次运行）：需求输入中显式要求 Requirement Agent 自检 AC 与 BC 的一致性，并把冲突项标注为 `open_questions` 而不是写成断言。
2. **多余位置参数的退出码**：`python text_stats.py a.txt b.txt` 由 argparse 直接退出，退出码 2，而需求 `open_questions` 第 2 条约定为 1；测试只断言「非 0」，未捕获该偏差（低优先级，已在 `review-revision-2.json` 记录）。
3. **冗余函数 `_cli`**（`examples/text-stats/text_stats.py`）：仅 `return main(argv)` 的单行转发，复审建议直接调用 `main`（低优先级）。
4. **文档字形**：`text_stats.py` docstring 与 `examples/text-stats/README.md` 用两个外观相同的引号描述 BC-08 的连接符，无法辨认第二个字符其实是 `U+2019`（低优先级，仅可读性）。
5. **残留目录：`examples/text-stats/.test-scratch/` 下 12 个 `tmp*` 子目录**：来自早期 `tempfile.mkdtemp` 探测失败（当前令牌对其 ACL 无权限，`Remove-Item -Recurse -Force` 被拒绝）。它们已被 `examples/text-stats/.gitignore` 忽略，不影响版本库，但仍是磁盘垃圾；需仓库所有者在非受限终端清理。
6. **测试依赖预先存在的 scratch 目录**：本机 DSH 沙箱（workspace-write）禁止向工作区之外写入，也禁止向本次运行中新建的目录写入文件，因此测试改为在交付目录内**已存在**的 `.test-scratch/` 写平铺临时文件。代价：全新克隆里该目录必须存在——已通过提交 `.test-scratch/.gitkeep` 保证。
7. **证据保真度**：`coding-report.json` 的 `generated_at` 是占位时间戳 `2026-02-14T00:00:00Z`，与真实运行时间（`2026-10-16T19:2x+08:00`）不符；其余 4 份文件的时间戳彼此一致。原始文件未改动，此处如实标注。

## 7. 复现方式

```powershell
# 1) 运行演示项目的测试（仅标准库，无需安装依赖）
python -m unittest discover -s examples/text-stats -p "test_*.py" -v

# 2) 运行编排层独立复核（45 项检查）
python -B docs/evidence/v0.1-first-run/orchestrator-verification.py

# 3) 重跑三 Agent 工作流：在一个把工作目录指向本仓库的 DSH 会话中，
#    把 workflows/three-agent-mvp.js 交给 Workflow 工具执行（步骤见 workflows/README.md）。
```
