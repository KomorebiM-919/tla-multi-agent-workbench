# V0.2 双人开发交接（round 1）

本包只交接**基线、接口契约、核心文件导航和失败证据**，不搬聊天记录、不复制运行日志。
后续由用户手动在 ChatGPT 与 DSH 之间传递本包；不建立自动跨会话通信。

## 1. 固定交接基线

| 项 | 值 |
| --- | --- |
| 分支 | `feat/v0.2-component-reuse` |
| 完整 HEAD | `943901ed9ee1b21e74c44f1fd1bfc7628a284d2e` |
| 工作区 | `<repo>\..\workspaces\v0.2-component-reuse` |
| 远端 | `refs/heads/feat/v0.2-component-reuse` = `943901ed9ee1b21e74c44f1fd1bfc7628a284d2e`（公开 GitHub API 核对，`object.type=commit`） |
| `git status` | 空 |
| 跟踪文件 | 386 |
| 工具链 | Node `v24.21.0`；Git `2.56.0.windows.2` |

- 本包是**代码基线** `943901e` 的交接；本包自身的提交会再前进一个 HEAD，不改变代码基线。
- 当时 `tests/.scratch/v02-round13/experiment-spec.json`（2465 B，pin `9037a22`）已在 `943901e` 之前生成，**pin 已失效**；它只是离线校验产物，不可直接启动。
- 未启动宿主、未起假模型服务、未消耗模型请求；实验启动授权仍为 **0**。

## 2. 核心文件导航

### 2.1 监督器：`tools/experiment-runner.mjs`（45479 B）

- **入口**：`node tools/experiment-runner.mjs --spec <spec.json> [--check]`（`main` 在 :213）。
- **输入**：`tla.experiment-spec/v1` JSON；关键字段 `projectCwd`、`runDir`、`profile`、`gatePort`/`upstreamPort`、`modelRequests`、`requireFiles`、`fakeServerPath`、`policyPath`、`pinned.sourceSha`/`fixturesSha`、`dshExe`/`dshCli`/`dshHome`、`prompt`。
- **输出**：`runner-<runId>.json`（runDir 的父目录）、`overlay-<runId>.patch.yml`、`logs-<runId>/`、runDir 内事件与账本输入。
- **关键约束**：`validateSpec` :110 要求 `runDir` 不存在或为空、pin 为 40 位十六进制、必需文件存在；`--check` 会执行 `preflightSpec` :434，失败 exit 1；正式运行调 `runExperiment` :699，负责假上游、宿主、监视和收尾。
- **当前已知问题**：`--check` 是“启动前全部可证明项”，不是 shape 检查；旧 pin 会在这里被拒绝。`--dsh-cli` 位于 `app.asar` 内时只核对归档存在。

### 2.2 启动器 / 保护闸门：`tools/gated-run.mjs`（41624 B）

- **入口**：`main()` :500；通常只由监督器按 `buildHostArgs` :961 生成 argv 后调用，不手工拼命令。
- **输入**：`--upstream`、`--model-requests`、`--heartbeat-file`、`--lease-ttl-ms`、`--heartbeat-max-age-ms`、`--timeout-ms`、`--run-dir`、`--gate-port`、`--gate-log`、`--dsh-exe`、`--dsh-cli`、`--dsh-home`、`--profile`、`--patch`、`--prompt`、`--project-cwd`、`--require-file`、`--upstream-health-url`、`--upstream-run-id`、`--summary`。
- **输出**：闸门事件/摘要、宿主进程与退出码、预算挂载证明。
- **退出码**：`0` 正常、`1` 宿主失败、`2` 环境/参数、`3` 保护未建立、`4` 运行中保护丢失。
- **关键约束**：拒绝 `--` 与 `--dump-config-from` / `--allow-ungated-providers` / `--on-loss`；`verifyPluginIdentities` :308 要求 `node_modules/<name>` 的 `realpath` 落在 profile 内；`fetchEffectiveConfig` :370 只做配置合成，不启动宿主。
- **当前已知问题**：profile 外部 Junction 会在静态指纹检查里通过、在身份检查里 `identity-unreadable`；当前修复方式是 profile 内 `vendor/interceptor-plugin` 副本 + 内部链接，不放宽门禁。

### 2.3 预检：`tools/experiment-command.mjs`（24840 B）+ 两个检查器

- **入口**：`node tools/experiment-command.mjs <flags>`（`main` :413）。
- **输入**：与 `README` §7 相同的 dsh/project/run/ports/prompt/fake-server/policy/pin 参数；`--profile` 可选，`--overlay` 在 supervised 模式可选。
- **输出**：全过时写 `dirname(runDir)/experiment-spec.json`，打印 `FULL PREFLIGHT OK`、supervised command、`STATIC PREFLIGHT OK`；失败不写 spec，exit 1。
- **检查链**：`buildCommand` → `runStaticChecks`（`tools/static-preflight.mjs:131`：红测试、插件身份、端口、overlay 凭据）→ `inspectEffectiveConfig`（`tools/inspect-effective-config.mjs:54`，`--dump-config` 配置合成）→ `preflightSpec`（`tools/experiment-runner.mjs:434`）。
- **当前已知问题**：静态检查直接对插件目录做指纹，配置检查却走 `verifyPluginIdentities`；两者口径不同，本轮迁移漏项正是这样漏掉的。`--dsh-cli` 在 asar 内只核对 archive 存在；`--dump-config` 不是宿主启动。

### 2.4 预算插件：`orchestration/interceptor-plugin/`（3 文件）

- **入口**：`index.js` 的 `apply(ctx, config)` :144；运行时逻辑在 `lib/budget.mjs` 的 `createRequestBudget` / `createAgentRequestListener`。
- **输入**：`modelRequests`、`stateFile`、`eventLog`、`runId`、`heartbeatIntervalMs`；监听 `agent/request`，prepend 预占。
- **输出**：`reserved` / `rejected` / `mounted` / `heartbeat` 事件；stateFile 用于恢复。
- **当前已知问题**：宿主对 `apply()` 抛错只记录 warning 并继续；不能只看“插件已加载”，必须核对挂载事件与服务端请求数。resume 时 stateFile/eventLog 损坏或丢失按“额度已耗尽”处理。profile 内副本必须与 `REVIEWED_PLUGIN_EVIDENCE` 的 `0.0.0-local`、3 文件、digest `54f1a8e3…` 一致。

### 2.5 反应式夹具：`tests/lib/reactive-model.mjs` + `tests/fixtures/`

- **入口**：`createReactiveModel`、`parseBody`、`validatePolicy`、`roleOf`、`sessionKeyOf`。
- **输入**：`tests/fixtures/repair-policy.v2.json`（单测重放）或 `repair-loop-policy.v3.json`（round13 policy，19594 B，键 `schema/id/note/team/rules`），以及 `tests/fixtures/repair-protocol/` 的 14 条脱敏请求。
- **输出**：规则命中、放行/拒绝/NO_PROGRESS 等决策。
- **当前已知问题**：protocol replay 只证明 13/14 命中，不是宿主运行；run10 的失败是夹具工具契约与宿主 schema 漂移（`path` vs `file_path`、缺 `description`、缺 `attempt_id`），不是产品崩溃。

### 2.6 账本：`tools/ledger-from-run.mjs` + `tools/recompute-ledger.mjs`

- **入口**：`node tools/ledger-from-run.mjs --run-dir <dir> --upstream-log <log> [--label] [--json]`；`node tools/recompute-ledger.mjs [--json] <run-dir>...`。
- **输入**：runDir 内 `plugin-events.jsonl`、`gate-events.jsonl`、`gate-summary.json`；上游日志。
- **输出**：reserved/rejected/allowed/received/completed/completeness；`COMPLETE` 才 exit 0。
- **当前已知问题**：账本完整性依赖事件关联；单看宿主 exit 0 或监督器 completed 不够。缺少事件就是 `INCOMPLETE`，不得补写。

### 2.7 验收：`tools/acceptance-summary.mjs`（12471 B）

- **入口**：`node tools/acceptance-summary.mjs --runner <runner.json> --run-dir <dir> --upstream-log <log> --project <dir> [--test test/sum.test.mjs] [--require-file ...] [--json]`。
- **输入**：监督器 summary、账本、上游日志、项目 tasks/测试/文件哈希。
- **输出**：验收 verdict；`closed` 才 exit 0，否则 exit 2。
- **当前已知问题**：必须同时满足返工闭环、测试转绿、复审完成、账本 COMPLETE；目前没有任何真实宿主运行达到 `closed`。

## 3. 最短离线复算命令

不启动宿主、不起假上游、不调用模型；下列命令只读已有产物，`--check` 只做预检。

```powershell
# 1) 启动前全部可证明项（需要已有 spec）
node tools/experiment-runner.mjs --spec <spec> --check

# 2) 预算预演（31 / 35 / 38，required 38，fits）
node tools/budget-plan.mjs --policy tests/fixtures/repair-loop-policy.v3.json

# 3) 账本复算
node tools/recompute-ledger.mjs --json <run-dir>

# 4) 验收判定
node tools/acceptance-summary.mjs `
  --runner <runner.json> --run-dir <run-dir> --upstream-log <upstream-log> `
  --project <project> --test test/sum.test.mjs `
  --require-file src/sum.mjs --require-file src/note.txt --require-file test/sum.test.mjs

# 5) 迁移链接回归（23 项）
node tools/check-migration-links.mjs `
  --profile <dsh-home>\profiles\stage1 `
  --source-dir orchestration/interceptor-plugin `
  --legacy-path v02-worktree
```

离线测试共 20 套，逐套执行、只看退出码；不要用 `node --test`（本沙箱禁管道）：

```powershell
Get-ChildItem tests/v02-*.test.mjs | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { break }
}
```

测试会写 `tests/.scratch/**`；常态沙箱下该路径不可写，需要一次性外层放宽。最近一次结果：20/20 通过，日志在 `<repo>\tests\.scratch\v02-round13\test-output-after-link-fix.log`（不随仓库提交）。

## 4. 最近一次真实宿主失败（最小脱敏证据）

`docs/V0.2-B1-MATRIX.md` §23.5（:1158-1171）记录：

| 项 | 值 |
| --- | --- |
| 源码 | `2ccbb57` |
| runId | `exp-mvetu4cl-b631b01f` |
| 运行目录 | `host1/round10` |
| 监督器 | `completed` |
| 宿主退出码 | `0` |
| 闸门放行 | 6 / 40 |
| 插件 | verified |
| 端口 | 已释放 |
| 实际文件变化 | 仅 `teams/fixture-loop/team.json` |
| `src/sum.mjs` | 未修改 |
| 测试结果 | 仍红 |
| 复审 | 未发生 |
| 收场 | worker 在 `implementing` 无规则，`NO_PROGRESS` |

**原因**：夹具工具契约旧于宿主 `0.2.1-rc.2`——`read`/`write` 用了 `path`（宿主要 `file_path`），`pwsh` 缺 `description`，`agent_teams_update_task` 缺 `attempt_id`。这是**夹具/接口漂移**，不是产品崩溃，也不是模型能力结论。

**它证明什么**：监督器、宿主、闸门、预算插件可以完成一次受控运行；“进程完成”不等于业务闭环。
**它不证明什么**：真实外部模型、返工读→写→红→拒→返修→绿→复审、账本 COMPLETE 与 `closed` 从未发生。

## 5. 尚未执行的实验条件

当前启动授权 **0**；以下条件全部满足前不得启动：

1. 用户对新一轮实验的明确批准（一次性、限定 spec）。
2. 固定最终提交 SHA，**重新生成** spec；不得用旧 pin 或当前 HEAD 顶替。
3. 全新目标项目（`src/sum.mjs` 用 455 B 红版本，`src/note.txt` 用审查夹具基线）和全新空 runDir。
4. 隔离 profile `stage1`；插件身份逐实例 `verified`；端口 18920/18921 空闲；假模型由监督器托管。
5. `experiment-command` 退出 0（`FULL PREFLIGHT OK` + `STATIC PREFLIGHT OK`），且 `--check` 再次通过。
6. 运行中满足 `docs/V0.2-NEXT-EXPERIMENT.md` §7 的停止条件：40 请求未完成、非预期 403、启动前配置拒绝、成员 `SetFileSecurityW`、连续 `NO_PROGRESS`、账本 INCOMPLETE、非 `127.0.0.1` 请求、预算外文件改动。
7. 不修改 ACL / 现用 Desktop profile，不安装依赖，不开放公网，不合并、不强推。

当前 round13 spec 是 `9037a22` 的离线产物，对 `943901e` 已过期；它**不能**作为启动依据。

## 6. 文件归属与冻结

### ChatGPT 接手（本轮交接后 DSH 不修改）

| 文件 | 理由 |
| --- | --- |
| `tools/experiment-runner.mjs` | 监督器生命周期、spec 校验、pin 校验、运行编排 |
| `tools/gated-run.mjs` | 启动器/保护闸门、退出码、身份与配置合成 |
| `tools/experiment-command.mjs` | 命令契约与预检流水线 |
| `orchestration/gate/preflight.mjs` | 闸门判定、身份/覆盖策略 |
| `orchestration/gate/gate.mjs` | 闸门服务 |
| `orchestration/gate/known-components.mjs` | 组件白名单 |
| `orchestration/interceptor-plugin/index.js` | 预算插件运行时 |
| `orchestration/interceptor-plugin/lib/budget.mjs` | 原子预占/拒绝逻辑 |
| `tools/acceptance-summary.mjs` | 验收判据 |
| `tools/recompute-ledger.mjs` | 账本语义 |
| `tests/lib/reactive-model.mjs` | 反应式执行契约引擎 |

### DSH 维护

| 文件/目录 | 理由 |
| --- | --- |
| `tools/static-preflight.mjs`、`tools/inspect-effective-config.mjs` | 基础设施检查器 |
| `tools/health-probe.mjs`、`tools/check-migration-links.mjs`、`tools/check-checkout-fidelity.mjs` | 环境/迁移/检出回归 |
| `tools/ledger-from-run.mjs`、`tools/redact-protocol.mjs`、`tools/overlay-template.mjs` | 账本输入、脱敏、overlay 模板 |
| `tests/v02-*.test.mjs`、`tests/lib/host-sim.mjs`、`tests/lib/observation-model.mjs` | 测试与宿主仿真 |
| `tests/fixtures/repair-project/**`、`tests/fixtures/repair-protocol/**` | 夹具打包与字节 |
| profile 安装/vendor 副本/链接、迁移、环境复现 | DSH 基础设施职责 |
| `docs/handoffs/**`、`README.md`、`ROADMAP`、发布 | 文档与发布 |

### 需要双方对齐的接口文件

| 文件 | 规则 |
| --- | --- |
| `tests/fixtures/repair-loop-policy.v3.json`、`repair-policy.v2.json` | 规则语义由 ChatGPT 定；DSH 负责字节、哈希与回归，改语义需双方确认 |
| `orchestration/interceptor-plugin/package.json` | 运行时由 ChatGPT 负责；DSH 负责 profile 内副本与指纹同步 |
| `tests/fixtures/host-tool-schemas.dsh-0.2.1-rc.2.json` | 宿主工具契约夹具；DSH 维护字节，ChatGPT 确认语义 |
| `tools/experiment-command.mjs` 的 spec 字段 | 契约变更必须同时更新文档、夹具和回归，不能单边改 |

**冻结规则**：交接后 DSH 不修改上表 ChatGPT 文件；如发现缺陷，只提交复现和证据，由 ChatGPT 决定修改。接口变更先写进本目录的后续 handoff，再动代码；禁止双方各自重写同一逻辑。

## 7. 已知限制与风险

- round13 spec 已过期，不能启动；必须在最终提交上重新生成并完整核验。
- profile 的插件是**副本**，不是指向工作区的链接；副本与源码的 digest 必须继续一致，否则身份门禁会拒绝。
- pnpm 11.28.5 离线全量解析因 `[ERR_PNPM_NO_OFFLINE_META] @nanmicoder/dsh-agent-teams` 不可用；manifest/lock 目前是**结构校验**（23 项 audit），不等于 pnpm 已完成全量解析。
- 常态沙箱下子进程不能写 `tests/`、`docs/` 和 Git 元数据；测试、提交、Push 需要一次性外层放宽。未改 ACL，也未改现用 Desktop profile。
- 最近一次真实宿主运行仍是 run10；run11/12/13 未启动。真实外部模型调用累计 0；历史假模型请求 151 次。
- `tests/.scratch/**` 中的日志、旧 spec、备份不随仓库提交；本包不包含聊天记录。

## 8. 文件清单与哈希

- 本目录：[`README.md`](README.md)、[`MANIFEST.json`](MANIFEST.json)。
- `MANIFEST.json` 记录本包文件与核心基线文件的 `bytes` / `sha256` / `git blob`；生成后逐项校验。
- 交接基线提交：`943901ed9ee1b21e74c44f1fd1bfc7628a284d2e`。本包提交只新增本目录，不改代码基线。
