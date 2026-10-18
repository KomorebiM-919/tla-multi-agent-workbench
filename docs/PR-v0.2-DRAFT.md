# V0.2 分支的 PR 文案（待人工在 GitHub 上粘贴）

- 分支：`feat/v0.2-component-reuse` → `main`
- 远端提交：本文件随代码一起推送，**不自指 SHA**；推送后的 tip 以报告里的 `git ls-remote` 输出为准
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

- **宿主返工闭环没有跑完**。前三次宿主实验止于夹具缺陷（工作区路径、端口占用、规则缺 `maxUses`）；
  `repair4` 账本 26/26 对账 `COMPLETE`、关联 ID 26 条逐条配对，但夹具当时把错误消息当成"完成"；
  `repair5`（正式反应式引擎）16 次放行、16 条到达、关联 ID 16/16 配对，但成员 `write` 被本机沙箱
  ACL 挡住（`SetFileSecurityW EACCES (Win32 5)`），项目文件改前改后 sha256 相同、测试仍 1 条失败。
  收尾跑了四次 closure（`run2` 5 次放行、`run3` 2 次、`run4` 14 次），都在**中等完整性令牌**
  （`Medium Mandatory Level`）下完成，最后一次推进到队员写 `src/note.txt` 被
  `file has not been read` 拒绝——复盘确认该文件**从未被读**（第 11 条请求直接写），宿主的拒绝是对的，
  是夹具漏了 `read` 那一步（详见 `docs/V0.2-FS-OBSERVATION.md`）。
- **仍未验证**：成员在中等完整性令牌下真正写盘；read-before-write 契约在真实宿主里完整走通；
  从实现到复审通过的完整返工链。用户暂缓第五条宿主实验是**授权边界**，不是技术失败根因。
- **之后的三次受控启动尝试都在宿主创建前结束**，各自暴露一个可离线修复的缺陷，也因此没有新增
  任何模型请求：①插件检出被本机 `core.autocrlf=true` 改写成 CRLF，指纹不符（`PLUGIN_NOT_VERIFIED`，
  已用 `.gitattributes` 修复）；②overlay 只换 `baseURL` 没写 `apiKeyEnv`，宿主启动后止于
  `MISSING_CREDENTIAL`（已加 `overlay:credentials` 预检）；③启动器把 overlay `insert:` 注入、
  宿主不补 `name` 的预算插件当成未知模型适配器（`PROVIDER_UNKNOWN`），而离线检查器用的是另一套
  分类器——两边判断分歧（已统一：`coverage:launcher-classifier`，见 `docs/V0.2-B1-MATRIX.md` §16）。
- 随后又补齐了那次统一留下的身份缺口：分类与核验原先各写一半——`id` 等于预算插件名就被记成
  `plumbing`，而身份核验只收集显式 `name`，于是**空身份列表**也能通过（`{id:'tla-prelaunch-budget'}`、
  `{id:'tla-prelaunch-budget', name:'@acme/router'}` 两个反例都已固定成测试）。现在两者消费同一个
  规范化实例：缺 `name` 只有在 profile 声明该包**且**安装字节等于审查 `buildDigest` 时才解析为自有插件，
  冲突名、同包多实例、身份结果缺失、身份不完整一律拒绝启动，离线检查器复用同一判定并输出逐实例表
  （`docs/V0.2-B1-MATRIX.md` §17）。这一轮同样**没有启动宿主**。
- 全轮假模型请求（按原始日志去重复算）：13 次运行、**闸门放行 130 / 上游到达 130**（成功 115、
  错误 3、没答完 3、响应未知 9），**真实外部模型调用 0 次**。旧文案里的 `84/100` 只含
  repair3+repair4(+repair5)，漏了 B-1 四次运行的 9 次与 closure 的 21 次；更正见
  `docs/V0.2-B1-MATRIX.md` §12.2 与 `docs/V0.2-EXPERIMENT-LEDGER.md`。
- 跨进程预算、按角色配额、fallback、多会话并发：未实现，未验证。
- 闸门不是宿主级强制保护：覆盖率校验依赖 CLI `--dump-config` 的输出，换一个未受保护的
  端点即可绕开（`docs/V0.2-PRELAUNCH-GATE.md` §5 有实测）。
- 手机通道、付费多模型协作：未开始 / 未授权。

## 复算入口

```bash
node tests/v02-gate.test.mjs            # 18 场景 / 187 断言（TLA_REAL_PROFILE 时再多 2 项）
node tests/v02-ledger.test.mjs          # 59 项
node tests/v02-prelaunch-budget.test.mjs # 11 场景 / 53 项
node tests/v02-orchestration.test.mjs   # 12 场景 / 267 项
node tests/v02-reactive-model.test.mjs  # 41 项（结构化工具结果判定）
node tests/workflow-logic.test.mjs      # 114 场景 / 547 项
node tests/preflight-claim-integration.test.mjs # 6 场景 / 59 项
node tests/v02-repair-rehearsal.test.mjs # 38 项：返工序列预演 + 隔离项目 fail→pass（不是宿主验证）
node tests/v02-repair-loop.test.mjs      # 55 项：30 次决策的返工/复审闭环离线预演（失败分支全覆盖）
node tests/v02-repair-protocol.test.mjs  # 123 项：脱敏协议夹具哈希校验 + 14 条历史请求回放
node tests/v02-fs-observation.test.mjs   # 20 项：read-before-write 契约的离线模型
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
