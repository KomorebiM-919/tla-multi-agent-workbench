# tests/ — 测试与验证入口

## 当前状态（V0.1）

V0.1 阶段**尚未建立项目级测试框架**（`docs/ROADMAP.md` V0.1 已说明：测试 Agent 流程本身即验收对象）。本目录用于说明"怎么验证这条流水线真的跑通了"，验证入口如下。

### 1. 演示项目的自动验证（普通测试脚本）

首个 MVP 的交付产物是一个演示用 Python 文本统计工具（`examples/text-stats/`，属于工作流测试样例，不是 TLA 工作台自身的核心功能）。它的单元测试就是本阶段的自动验证脚本：

```powershell
python -m unittest discover -s examples/text-stats -p "test_*.py" -v
```

期望结果：全部用例通过（`OK`），覆盖需求中的每一条边界条件（空文本、结尾换行、空白行、单词判定规则等）。

### 2. 工作流执行证据（比测试结果更重要的部分）

`docs/evidence/<runId>/` 下保留**每个 Agent 自己写出的**原始结论（JSON 信封）与编排层的核验记录：

| 文件 | 由谁产生 | 内容 |
| --- | --- | --- |
| `requirement.json` | Requirement Agent | 结构化需求（目标、范围、验收条件、边界条件） |
| `coding-report.json` | Coding Agent | 文件清单、实现说明、真实测试命令与退出码 |
| `review.json` | Review Agent | 逐条验收条件判定、问题清单、最终结论 |
| `test-output.txt` | 编排层（人工可复现） | 提交前复跑测试的原始输出 |
| `README.md` | 编排层 | 本次运行记录：时间、命令、环境、核验结论 |

### 3. 提交前必做的通用检查

见 `AGENTS.md` 第 8 节（`git status` / `git diff --check` / 敏感信息扫描 / `.gitignore` 覆盖 / 测试通过 / 文档同步）。

## 规划

- V0.3 起引入测试 Agent 与项目级测试框架（`docs/ROADMAP.md` V0.3），届时本目录承载 TLA 自身的单元测试与集成测试。
