# docs/evidence/v0.1-second-run/ — 第二次真实运行记录（审核修复后）

本目录是 **V0.1 三 Agent 工作流在按 ChatGPT 代码审核意见修复后**的一次真实运行归档。第一次运行记录完整保留在 `docs/evidence/v0.1-first-run/`（未改动），本目录使用独立 `runId`，两者互不覆盖。

## 1. 运行元信息

| 项 | 值 |
| --- | --- |
| 运行日期（本地时间） | 2026-10-16，19:48–20:03（+08:00） |
| 分支 / 运行前 HEAD | `feat/v0.1-three-agent-mvp` / `d09195a` |
| runId / evidenceDir | `v0.1-second-run` / `docs/evidence/v0.1-second-run` |
| 执行方式 | DSH 原生 `workflow` 工具执行 `workflows/three-agent-mvp.js` |
| 结果 | `ok: true`、`status: OK`、`attempts: 1`、`finalVerdict: APPROVED` |
| 子代理执行次数 | **5**（预检 Verifier → Requirement → Coding → 验证 Verifier → Review） |
| 角色模型 | 五者同为 `deepseek-flash`（provider `deepseek-account`）；按用户要求三个角色暂共用同一模型 |
| 是否产生额外费用 | 5 次真实子代理调用（180 次工具调用），消耗当前配置模型额度；未接入任何新付费服务 |

`args`（编排代理传入）：

```json
{
  "runId": "v0.1-second-run",
  "evidenceDir": "docs/evidence/v0.1-second-run",
  "promptDir": "agents",
  "runStartedAt": "2026-10-16T19:48:21+08:00",
  "task": {
    "targetDir": "examples/text-stats",
    "moduleFile": "text_stats.py",
    "testFile": "test_text_stats.py",
    "sampleFile": "sample_input.txt",
    "maxCodingAttempts": 2
  }
}
```

未传 `task.requirement`，因此使用脚本内置演示需求（在既有文本统计工具上修正四处缺陷）。

## 2. 五个子代理的执行证据

下表的会话标识、时间、步骤与工具调用次数均取自 **DSH 原生会话日志**（`dsh-native-events.json`，脱敏，见第 6 节），不是代理自述：

| 角色 | DSH 会话 id | 创建时间（本地） | 步数 | 工具调用 | 产物 |
| --- | --- | --- | --- | --- | --- |
| Verifier Agent（preflight） | `3a235608-965a-464b-aa4a-b8d10d5a9e1e` | 2026-10-16 19:49:36 | 6 | 10 | `preflight.json` |
| Requirement Agent | `371f086c-287a-430b-b14a-0cc0f3ecaa60` | 2026-10-16 19:50:10 | 15 | 20 | `requirement.json` |
| Coding Agent | `3eb48128-7596-4541-b138-d733e9b3d728` | 2026-10-16 19:52:34 | 101 | 115 | `coding-report.json` |
| Verifier Agent（verify） | `d610249a-b590-4e77-8d61-4827827821a6` | 2026-10-16 20:00:28 | 8 | 12 | `verify.json` |
| Review Agent | `aa4447bd-782d-4c58-8d97-b3dc96a7ce6c` | 2026-10-16 20:01:24 | 18 | 23 | `review.json` |

合计 148 步 / 180 次工具调用。五个会话在原生日志中的共同属性：`origin=subagent`、`delegationDepth=1`、`agentPreset=standard`、工作目录为本仓库根目录、`sandbox/mode=workspace-write`（`source=delegation`）、`approval/policy=never`（`source=delegation`）。

这证明三个角色确实是**独立的子代理实例**（各自独立会话、独立上下文、独立 step/turn），而不是一个模型分角色扮演。

## 3. 证据文件清单

| 文件 | 由谁产生 | 内容 |
| --- | --- | --- |
| `preflight.json` | Verifier Agent（preflight） | 只读预检：仓库根、证据目录状态、提示词文件存在性、目标目录、解算后的绝对路径、问题清单 |
| `requirement.json` | Requirement Agent | 结构化需求：目标、范围（SI-01..SI-11 / SO-01..SO-10）、验收条件 AC-01..AC-17、边界条件 BC-01..BC-19、待澄清项 OQ-01..OQ-05、一致性自检结果 |
| `coding-report.json` | Coding Agent | 交付文件清单与大小、实现说明、真实测试命令与退出码、自述测试结果、与需求的偏差 |
| `verify.json` | Verifier Agent（verify） | 独立复跑规范命令的原始输出全文、退出码、用例数、结果标记、产物 sha256/字节数 |
| `review.json` | Review Agent | 逐条验收条件判定（含其自己实跑的原始输出与行号证据）、问题清单、最终结论 |
| `dsh-native-events.json` | 编排层（工具脚本） | 由 DSH 原生会话日志提取的脱敏执行事件（见第 6 节） |
| `extract-native-events.mjs` | 编排层 | 生成上一行文件的只读提取脚本（仅 Node 标准库） |
| `orchestrator-verification.py` | 编排层 | 编排层的独立复核脚本（期望值来自需求工件，不依赖交付测试套件） |
| `orchestrator-verification-output.txt` | 编排层 | 上一行脚本的原始输出 |
| `README.md` | 编排层 | 本文件 |

## 4. 编排层独立复核

`orchestrator-verification.py` 由编排代理（不是三个角色）编写，用于**独立于交付测试套件**再验一遍实现：

- **266 项检查、0 失败**（exit 0）；输出见 `orchestrator-verification-output.txt`。
- 覆盖：需求文件里 BC-01…BC-16 的显式示例、AC-05…AC-17 的判定口径、SI-04/SI-05/SI-06 的接口要求、BC-05 的 512 组不变量采样、CLI 的退出码与输出格式、错误路径、以及 AST 静态检查（仅用标准库；无转发函数；`sys.exit(main())` 单入口）。
- 另外把交付测试套件中**47 条可静态解析的断言**重新对实现求值，结论与交付测试一致（另有 1 条循环驱动的断言无法静态解析，已在输出中标注跳过）。
- 可信度说明：复核脚本首次运行有 1 项失败，追查后确认是**编排层自己的正则写得太宽**（把 `count_text("hello world\nfoo bar\n\n")["line_count"] == 3` 这条正确断言误判成历史遗留断言），不是实现缺陷；改正后全绿。此处如实记录，避免把编排层的错误算到实现头上。

## 5. 相对第一次运行的修复（对应审核意见）

| 审核意见 | 本轮落地情况 |
| --- | --- |
| 一、成功判定漏洞 | `ok: true` 现在要求同时成立：Coding 自述测试通过 **∧** Verifier 独立复跑的原始输出通过 **∧** Review 返回 `APPROVED` **∧** Review 自己的复跑通过 **∧** 验收条件全覆盖且逐条满足 **∧** 需求一致性自检无冲突。任一矛盾都不再可能输出成功。自述结果与独立验证结果被分别记录并比对（`selfReportVsVerified`），不一致时报 `INCONSISTENT_EVIDENCE`。 |
| 二、配置参数检查 | 新增 `validateRunConfig`：`runId` 必填且受限字符集；`evidenceDir` 必须位于 `docs/evidence/` 下且最后一段等于 `runId`；目标目录/文件名必须是仓库内相对路径（拒绝绝对路径、盘符、`..` 穿越、反斜杠）；`testCommand` 只接受规范化命令（可加 `-v`）；`maxCodingAttempts` 必须是 1–5 的整数；时间戳必须在运行时间窗内。**校验失败时不启动任何子代理。** |
| 三、改进 Requirement Agent | 提示词新增「验收条件与边界条件一致性自检」强制小节，产出 `consistency_check`；自检报冲突时脚本以 `REQUIREMENT_CONFLICT` 立即停止，不再让 Coding Agent 自行选口径。第一次运行发现的真实冲突案例作为已知案例注入需求提示词。 |
| 四、保护运行证据 | `v0.1-first-run` 完整保留（未改动，git 可核）；本次使用独立 `runId`；证据目录已存在时直接 `EVIDENCE_EXISTS` 拒绝，不覆盖历史；时间戳必须为真实运行时间（第一次运行中 `coding-report.json` 的 `generated_at` 是占位值 `2026-02-14T00:00:00Z`，本轮起由脚本强制校验）；新增 DSH 原生事件脱敏证据。 |
| 五、补充回归测试 | 新增 `tests/workflow-logic.test.mjs`：用 `node:vm` 装载真实脚本并以模拟子代理返回值驱动，**31 个场景全部通过**（含失败场景、非法参数、证据保护、修订循环与轮次上限）；过程见第 7 节。 |
| 六、重新运行与报告 | 本次即全新 `runId` 的真实运行，证据齐备，且同步检查了演示项目源码与测试脚本。 |

## 6. 证据卫生（脱敏说明）

- `preflight.json` 中有 7 处本机仓库绝对路径（JSON 转义形式），已机械替换为 `<repo>`；替换后文件仍是合法 JSON。其余证据文件 0 处绝对路径。
- `dsh-native-events.json` 由 `extract-native-events.mjs` 生成，**只保留非内容字段**：会话标识、父子关系、沙箱与审批策略、模型、turn/step 边界、工具调用 id/名称/参数键名/目标路径、时间戳。**明确排除**：user/assistant 消息正文、系统提示词、工具参数值、工具结果载荷、凭据库。输出经检查 0 处 `D:\` 与 `C:\Users` 引用，0 处密钥/令牌模式。
- 本目录所有文件经 8 类密钥/令牌模式扫描，无真实命中。
- 三个 Agent 只改动了交付目录内的 3 个文件（`git status` 可核），未触碰仓库中其他文件。

## 7. 诚实记录：本轮暴露的问题（未擅自扩大修改范围）

1. **需求一致性自检漏检了真实矛盾**：`requirement.json` 的 `consistency_check.conflicts` 为空，但 Review Agent 独立发现 AC-12 与 BC-12 数学上不可同时满足——AC-12 的第二条命令要求 `python text_stats.py`（stdin 为空）的 stdout 恰好是 `True 0 int`（即不得打印统计行），而 BC-12 要求成功路径恰好输出 4 行。实现顺从 AC-12 的字面要求（显式传入空 `stdin_text` 时不输出），Review Agent 自行复跑 12 次（`inherit`、`DEVNULL`、空管道、换行管道等）全部得到 `True 0 int`，因此 AC-12 判为 `satisfied`。需求文本本身仍矛盾，这是**下一轮应修的方向**，本次未手改 Agent 产物（手改会破坏证据真实性）。
2. `test_text_stats.py` 把上述行为固化为期望值（`test_injected_empty_stdin_text_writes_nothing`）；需求口径统一后需同步调整测试。
3. BC-03 字面 `len(T.splitlines())` 与 BC-02 的 `line_count('a\u2028b') == 1` 存在定义张力；实现用字符掩码规避（U+2028/U+2029 不视为换行，其余 `splitlines` 边界仍切分），不影响任何验收条件，但需求文本应补一句「行边界集合」定义。
4. `examples/text-stats/.test-scratch/` 下有 **11 个第一轮遗留的 `tmp*` 目录**，其 ACL 连读取都拒绝，AI 沙箱内无法删除；需要仓库所有者在本机非受限终端清理（不影响测试：本轮测试只在该目录写平铺文件，不再新建子目录）。
5. 三个角色当前共用同一模型（`deepseek-flash`）。多模型分工属 V0.2，本轮不做。
6. 交付目录 `__pycache__/` 已清理；`.test-scratch/` 的 `.gitkeep` 与忽略规则已修正（见仓库 `.gitignore` 说明），保证新克隆后该目录存在、测试可写。

## 8. 复现命令

```powershell
# 1) 交付项目的测试
python -m unittest discover -s examples/text-stats -p "test_*.py" -v

# 2) 工作流逻辑的回归测试（Node 标准库，无新依赖）
node tests/workflow-logic.test.mjs

# 3) 编排层独立复核（266 项检查）
python -B docs/evidence/v0.1-second-run/orchestrator-verification.py

# 4) 重新提取 DSH 原生执行事件（脱敏，只读会话日志）
node docs/evidence/v0.1-second-run/extract-native-events.mjs `
  --parent session-3f96bf08-83ae-48d6-a239-0223d4b1c12c `
  --since 2026-10-16T19:48:21+08:00 `
  --out docs/evidence/v0.1-second-run/dsh-native-events.json
```

> 说明：第 4 步只读取 `$env:DSH_HOME/sessions/` 下的会话元数据，不读取消息正文，也不读取任何凭据文件。
