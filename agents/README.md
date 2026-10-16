# agents/ — 角色定义与提示词

本目录存放 TLA 各 Agent 角色的**提示词规范**。每个角色一份 Markdown 文件，是提示词的唯一来源（single source of truth）；工作流脚本不复制提示词内容，而是要求每个子代理**先读取自己的角色文件**再执行任务。

## 当前角色（V0.1 首个 MVP）

| 文件 | 角色 | 职责 |
| --- | --- | --- |
| `requirement-agent.md` | Requirement Agent | 把自然语言需求整理为明确任务、验收条件与边界条件，并对二者做一致性自检 |
| `coding-agent.md` | Coding Agent | 按需求在指定交付目录实现代码与单元测试，并真实运行测试 |
| `verifier-agent.md` | Verifier Agent | 独立复跑规范化测试命令，只回传原始输出、退出码与文件指纹（不审核、不修改文件） |
| `review-agent.md` | Review Agent | 在独立上下文中读取需求与真实代码，独立复跑测试，逐条判定验收条件，给出 APPROVED / CHANGES_REQUESTED |

五角色完整流水线中的 `discussion`（方案讨论）与 `testing`（测试）角色属 V0.1 扩展目标，尚未建立。Verifier Agent 不是"测试角色"的替代：它只提供外部独立验证的原始证据，判定逻辑仍由编排脚本持有。

## 运行契约（与 `workflows/three-agent-mvp.js` 的约定）

1. **独立执行实例**：每个角色由工作流脚本通过 DSH 原生 Subagent 机制（`workflow` 工具的 `agent()` 钩子）**分别调用**，各自拥有独立上下文；角色不是由同一个模型在一次回答里轮流扮演。
2. **执行顺序与结果传递**：由脚本的实际编排逻辑保证（`await` 顺序 + 上一阶段结构化结果原样注入下一阶段提示词）。`phase()` 只用于进度展示，不产生执行依赖。
3. **产物落盘**：每个角色必须把自己这一阶段的原始结论写入编排脚本指定的**证据文件**（JSON 信封），格式见各角色文件。信封结构：

   ```json
   {
     "run_id": "<本次运行 id>",
     "agent": "<角色名>",
     "stage": "<阶段名>",
     "generated_at": "<ISO-8601 时间>",
     "result": { "...": "该角色规定的字段" }
   }
   ```

   信封中的 `result` 必须与角色返回给编排脚本的结构化结果一致 —— 这使得"证据文件"与"工作流返回值"可以互相核对，而不是各自独立编造。
4. **结论词表**：审核结论固定为 `APPROVED` 或 `CHANGES_REQUESTED` 两个值，不接受其他措辞。
5. **共同禁令**（对所有角色生效，与 `AGENTS.md` 一致）：
   - 不安装任何依赖（仅限 Python 标准库）；
   - 不执行 `git commit` / `git push` / 任何远端操作；
   - 不访问网络、不读取任何凭据文件（`.credentials.yaml`、`.env`、凭据管理器等）；
   - 不修改交付目录以外的文件（证据文件与自身报告除外）；
   - 不编造任何执行结果（测试结果、文件内容、退出码都必须来自真实执行）。

## 如何运行

见 `workflows/README.md`；运行方式由 DSH 的 `workflow` 工具执行 `workflows/three-agent-mvp.js`。
