# V0.2 分支的 PR 文案（待人工在 GitHub 上粘贴）

- 分支：`feat/v0.2-component-reuse` → `main`
- 远端提交：`b9a55794dccdc6acbbc25e7e14c3c03099c279be`
- base 说明：本分支从 `release/v0.1-public`（`5e8ef41`）切出，所以它**包含尚未合并的 V0.1 交付**。
  相对 `5e8ef41` 的范围才是 V0.2 新增；不要把 `main..head` 的全部差异算成 V0.2 的工作。
- 建议标题：

```
feat(v0.2): offline orchestration prototype with an independent pre-launch gate
```

- 建议正文：

```markdown
## 这个 PR 是什么

V0.2 的离线原型与安全基础设施，**不是**"多模型协作已验收"。

包含四部分：

1. 配置 / 价格 / 估算 / 计划原型（`orchestration/`）：角色到 provider/model 的显式映射、负责人、
   基点分配、向上取整的金额计算、价格快照与宿主模型目录的交叉核对；不调用模型。
2. 启动闸门（`orchestration/gate/`）：只绑 `127.0.0.1`、默认拒绝的本地代理，只有"有效租约 +
   额度未用尽 + 本次运行的挂载证明"才建立上游连接；租约只能同进程调用，HTTP 控制面只读。
3. 启动器（`tools/gated-run.mjs`）：用与启动宿主相同的命令 / profile / patch 列表 / 工作目录
   自己取生效配置，核对每个已启用 provider 实例的 baseURL 是否指向闸门；核对已安装插件的
   版本与构建指纹；任何一项不成立就不启动宿主。
4. 账本复算（`tools/recompute-ledger.mjs`）：预占 / 闸门放行 / 上游收到 / 上游完成四阶段分别计数，
   缺日志、空日志、截断日志一律 `INCOMPLETE`，不把无法核实的 0 当成对账通过。

## 已验证（隔离 profile + 回环假模型）

- 额度耗尽：假服务端零新增请求（真实宿主）。
- 插件完全不参与拒绝时，第 2 次请求仍由闸门 403 拒绝，上游严格 1。
- 插件缺失 / 心跳过旧 / 存在未受保护 provider 实例：拒绝启动，宿主不启动，上游 0。
- 并发争最后一个额度：10 并发只有 1 次放行。
- 插件版本或字节被改动：拒绝启动（指纹不符）。
- 真实外部模型调用：0。以上全部是本地假模型请求。

## 明确未完成

- 返工闭环在三次宿主实验内没有跑完（工作区路径、端口占用、规则缺 `maxUses`），
  详见 `docs/V0.2-B1-MATRIX.md` §7。
- 跨进程预算、按角色配额、fallback、多会话并发：未实现，未验证。
- 闸门不是宿主级强制保护：覆盖率校验依赖 CLI `--dump-config` 的输出，换一个未受保护的
  端点即可绕开（`docs/V0.2-PRELAUNCH-GATE.md` §5 有实测）。
- 手机通道、付费多模型协作：未开始 / 未授权。

## 复算入口

```bash
node tests/v02-gate.test.mjs            # 17 场景 / 184 断言（TLA_REAL_PROFILE 时 186）
node tests/v02-ledger.test.mjs          # 43 项
node tests/v02-prelaunch-budget.test.mjs # 10 场景 / 46 项
node tests/v02-orchestration.test.mjs   # 12 场景 / 267 项
node tests/workflow-logic.test.mjs      # 114 场景 / 547 项
node tests/preflight-claim-integration.test.mjs # 6 场景 / 59 项
```
```

## 为什么没有直接建 PR

本会话能读远端（`git ls-remote`、公开 API 读取），但 GitHub 的写操作需要凭据；
按仓库规范（`AGENTS.md` §7.1）没有读取或拼接任何凭据，`gh` 也未安装。
因此 PR #2 的文案更新与 V0.2 Draft PR 的创建需要由你在浏览器里完成，
最小步骤见下。

## 最小手动步骤

1. 打开 <https://github.com/KomorebiM-919/tla-multi-agent-workbench/compare/main...feat/v0.2-component-reuse?expand=1>
2. 标题与正文粘贴上面的内容，选择 **Create draft pull request**。
3. 在正文里保留"base 说明"那一段，避免读者把 V0.1 的差异算成 V0.2。
