# workflows/ — DSH 工作流脚本

本目录存放 TLA 的**编排脚本**。脚本用 DSH 原生 `workflow` 工具的 JavaScript 形式编写，是"谁在什么时候调用哪个角色、结果怎么传递"的唯一来源；角色提示词在 `agents/`。

## `three-agent-mvp.js`（V0.1 首个 MVP）

**流水线**：`Requirement Agent` → `Coding Agent` → `Review Agent`（三个**真实、独立**的子代理实例）。

**编排逻辑（脚本保证，而非 `phase()` 标签）**：

1. `Requirement Agent` 产出结构化需求（目标 / 范围 / 验收条件 / 边界条件），并写入证据文件 `requirement.json`。
2. 脚本把该结构化结果**原样注入** `Coding Agent` 的提示词 —— 这就是"结果传递"的实际机制；Coding Agent 在交付目录内实现代码与 `unittest` 测试、真实运行测试，并写入 `coding-report.json`。
3. 脚本把需求与编码报告**原样注入** `Review Agent`；Review Agent 在独立上下文中读取真实文件、**独立复跑测试**，给出 `APPROVED` / `CHANGES_REQUESTED`，写入 `review.json`。
4. **修订循环**：若结论为 `CHANGES_REQUESTED`，脚本把问题清单回注给新的 Coding Agent 实例（`coding-report-revision-2.json`）后再审一次；最多 `maxCodingAttempts`（默认 2）轮，仍不通过则以 `ok: false` 结束并保留全部证据。

**错误处理**：每个阶段都校验结构化输出是否完整（需求缺 `goal`/`acceptance_criteria`、编码缺 `files_created`、审核 `verdict` 不合法都会终止并返回 `{ ok: false, stage, error, received }`）；子代理失败（返回 `null`）同样终止，不产生"看起来成功"的假结果。

**输入（`args`，全部可选）**：

```json
{
  "runId": "v0.1-first-run",
  "evidenceDir": "docs/evidence/v0.1-first-run",
  "promptDir": "agents",
  "task": {
    "requirement": "<自然语言需求>",
    "targetDir": "examples/text-stats",
    "moduleFile": "text_stats.py",
    "testFile": "test_text_stats.py",
    "testCommand": "python -m unittest discover -s examples/text-stats -p \"test_*.py\"",
    "maxCodingAttempts": 2
  }
}
```

不传 `task.requirement` 时使用脚本内置的演示任务（Python 文本统计工具；属于工作流测试样例，不是 TLA 工作台自身的核心功能）。

**输出**：结构化运行结果 `{ ok, runId, evidenceDir, pipeline, targetDir, testCommand, attempts, originalRequirement, requirement, codingReports, finalReview, finalVerdict }`，由编排代理归档到 `docs/evidence/<runId>/`。

## 如何在本机运行（中文步骤）

1. 打开本机已安装的 **DeepSeek Harness** 桌面应用，把一个会话的工作目录指向**本项目根目录**。
2. 在会话里发送这样一句话（可原样复制）：

   > 请读取 `workflows/three-agent-mvp.js`，用 `workflow` 工具执行它（`args` 用默认值：runId = `v0.1-first-run`），然后把返回结果写入 `docs/evidence/<runId>/` 归档。

3. 编排代理会（通过 DSH 的 `workflow` 工具）真实启动三个子代理：先需求、再编码、再审核，并把每阶段结论写入证据文件。
4. 运行结束后，自己去核对（不依赖代理口述）：

   ```powershell
   python -m unittest discover -s examples/text-stats -p "test_*.py" -v
   Get-ChildItem docs\evidence\v0.1-first-run
   ```

5. 若要做一次"变更后再审"的观察：把 `task.requirement` 换成你自己的需求（例如"再增加一个统计项"）并给一个新的 `runId`，脚本会自动走修订循环。

> 注意：每次运行会真实调用 DSH 的子代理（消耗当前所配置模型的额度），不是离线模拟。
