# V0.2 交接包（2026-10-19）

本包用于在**不继承任何启动授权**的前提下接续 V0.2。它记录状态、证据与下一步，不是验收证书。
**V0.2 尚未整体验收**：真实 DSH 宿主上的完整返工闭环从未跑通一次。

## 1. 状态摘要

- 分支 `feat/v0.2-component-reuse`，交接时的修复提交 **`95d76184e8ca25f48892fb8f739ed6eeb801beef`**
  （`fix(v0.2): decide the launch from one pre-flight`）。工作区在提交时干净。
- 本轮做了什么：把“能否启动”的判定收敛为唯一 `preflightSpec()`，生成器、`--check`、正式
  `runExperiment()` 共用；覆盖 spec 结构、源码 SHA、检出洁净（含未跟踪）、夹具字节、policy 是否
  在 pin 修订内、外部假上游/策略文件的哈希；`SPEC OK` 语义作废。
- 为什么：round11 已经拿到审批，却因“夹具已改、spec 仍指向改前修订”在启动前被拒。旧 `--check`
  只验形状，pin 校验留到正式 run，导致“结构合法”被误读成“来源已验证”。
- 当前状态：`v02-experiment-runner` 117 项、`v02-experiment-package` 80 项，19 个 `v02-*.test.mjs`
  全过（本地替身，不启动 DSH、不连模型）。
- 真实外部模型调用：**0**。历史本地假模型请求：**151**（13 次早期 130 + 第五次 15 + run10 6）。
- 最近一次真实宿主运行（run10）**业务闭环未通过**；round11 在预检阶段被拒，**0 进程、0 请求**。

## 2. Git 与远端

| 项 | 值 |
| --- | --- |
| 分支 | `feat/v0.2-component-reuse` |
| 交接基线 HEAD | `95d76184e8ca25f48892fb8f739ed6eeb801beef`（本包提交紧随其后，见下） |
| 基线 `main` | `2f01992`（`origin/main`，Merge PR #1） |
| 与 `main` 关系 | 基线 ahead 134 / behind 0（本包提交后为 135） |
| 远端 | `https://github.com/KomorebiM-919/tla-multi-agent-workbench` |
| upstream | 本地未设置（`git rev-parse @{upstream}` 为空）；推送前需 `git push -u origin feat/v0.2-component-reuse` |
| Draft PR | **本地无法核实**：本机未安装 `gh`。不要凭猜测写 PR 号；推送后用网页确认 |

本包自身会作为**后续提交**加入该分支，因此它的提交 SHA 不等于 `95d7618`；用
`git log -1 --format=%H -- docs/handoffs/v0.2-2026-10-19` 读取包提交。启动 pin 必须在启动当时
用 `git rev-parse HEAD` 重新确定，不能沿用包里的任何 SHA。

## 3. 环境版本

| 组件 | 版本/事实 |
| --- | --- |
| 宿主 | DeepSeek Harness 桌面版 `0.2.1-rc.2`（安装目录 `version` 文件 `44.7.0`）；2026-10-19 10:54 自动更新，旧版为 `0.2.0-rc.2` |
| 团队插件 | `@nanmicoder/dsh-agent-teams@0.1.25`（`recommendedHost 0.2.1-rc.2`，126 文件，buildDigest `54c53836fa85e3e367b6b0f57815896c120b4d98eacb9c6d0ea508c96ac50904`，`cordis.patch.yml` sha256 `699b8ba7…`） |
| 插件来源 | 隔离 profile `stage1` 的 `package.json` 为 `0.1.25`；升级经用户明确批准，只动隔离 profile，未触碰现用 Desktop profile/ACL |
| pnpm | 11.28.5（DSH 自带，`<dsh-install>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs`）；store `<repo>\.pnpm-store\v11` |
| Node | 24.21.0 |
| 隔离 DSH_HOME | `<repo>\tests\.scratch\v02-stage1\dshhome`（不入库） |
| 操作系统 | Windows；测试必须逐个 `node tests/v02-*.test.mjs` 跑（`node --test` 会因沙箱禁管道报 `spawn EPERM`） |
| 沙箱事实 | 进程表枚举（`Get-CimInstance Win32_Process`/`tasklist`/`wmic`）在本沙箱被拒；`descendantsProof` 会记 `unavailable`，`treeProof` 退化为 `tree-killed`，但 `taskkill /T /F` 对自己派生的进程仍有效 |

## 4. 已验证 / 未验证

**已验证（离线替身，真实本机进程与端口）**

- 监督器生命周期：正常完成、端口被占、上游起不来、就绪后上游退出、运行中上游退出、宿主失败、
  宿主 spawn 失败、超时、取消、异常仍收尾；结束后端口释放、pid 不存活。
- 有界收尾：先枚举后代再杀树，`descendants`/`descendantsProof`/`survivors` 入摘要；
  `requireTreeProof` 下 `exited-before-teardown` 判 `cleanup-anomaly`（进程表不可读时不谎称“无后代”）。
- 启动前预检：旧 round11 spec 被拒（`FULL PREFLIGHT REJECTED`）；夹具变更而 pin 不变、错 SHA、
  未知修订、源码漂移（含未跟踪文件）、外部哈希与声明不符全部失败；新 spec 9 项全过；
  `--check` 与正式 run 共用同一函数、输出相同问题列表。
- 真实宿主上已证明（run10，`0.2.1-rc.2` + `0.1.25`）：插件加载、固定来源/argv/收尾、闸门 6/6
  关联、端口释放、宿主 `exit 0`。

**未验证（不得声称）**

- 完整返工闭环：读→写→红→复审拒绝→返修→绿→复审通过→账本 COMPLETE→验收 `closed`。
- 成员写既有实现文件、写后回读、真实复审拒绝/通过。
- 真实付费多模型协作（真实外部调用 0）、并发、跨进程预算、按角色配额、跨 provider。
- 闸门是本地实验工具，不是宿主级强制保护。
- 升级后的 `0.1.25` 只做过静态扫描，行为未在真实宿主上验证到“闭环”级别。

## 5. 实验索引

| 批次 | 位置（均不入库，保留在现场） | 结果 |
| --- | --- | --- |
| 早期 13 次（B-1 / repair / closure） | `tests/.scratch/v02-stage2/**` | 放行 130 / 到达 130；账本逐次见 `docs/V0.2-EXPERIMENT-LEDGER.md` |
| 第五次受控宿主（run8，源码 `11084b2`） | `host1/run8` | 放行 15/40；宿主 `exit 0`；停在队长轮询额度，`verdict=partial`，`unmet=[TESTS_GREEN,TASKS_COMPLETED,REVIEW_RAN]` |
| 第一次受控运行（run10，源码 `2ccbb57`） | `host1/round10`，`runId exp-mvetu4cl-b631b01f` | 放行 6/40；只建队；`read`/`update_task` 工具契约错误 → `NO_PROGRESS`；`partial` |
| round11（源码 `f0aa1ba`，夹具 pin `5090677`） | `host1/round11` | **`spec-invalid`**：夹具字节与 pin 不符；进程 0、请求 0 |
| round12（离线预检，源码=夹具 `95d7618`） | `host1/round12`（仅 spec 与预检输出，**未启动**） | `FULL PREFLIGHT OK`（9 项）+ `STATIC PREFLIGHT OK` |

## 6. 已消耗授权（必须分开记）

| 事项 | 审批 | 命令执行 | 进程 | 模型请求 | 说明 |
| --- | --- | --- | --- | --- | --- |
| run8 | 1 次（已授予） | 1 | 宿主 1 | 15 | 外层放宽，内部 workspace-write |
| run10 | 1 次（已授予） | 1 | 宿主 1 + 上游 1 | 6 | 同上；40 额度只用了 6 |
| round11 | 1 次（已授予） | 1 | **0** | **0** | 预检拒绝；40 额度未消耗，但审批已随命令用掉 |
| 当前剩余启动授权 | **0** | — | — | — | 下一次启动必须重新申请外层升级；不得继承 |

真实外部模型调用累计 **0**；没有购买、没有安装 `dsh-ops`、没有改现用 profile/ACL、没有开放公网。

## 7. 复算命令

```powershell
# 逐个测试（不要用 node --test：本沙箱禁管道）
Get-ChildItem tests\v02-*.test.mjs | ForEach-Object { node $_.FullName }

# 账本复算（单次运行）
node tools/recompute-ledger.mjs --json '<run-dir>'

# 验收（三判据分开）
node tools/acceptance-summary.mjs --runner '<runner.json>' --run-dir '<run-dir>' \
  --upstream-log '<log-dir>\upstream-requests.jsonl' --project '<project>' --test test/sum.test.mjs

# 预算预演
node tools/budget-plan.mjs --policy tests/fixtures/repair-loop-policy.v3.json

# 完整预检（不启动进程）
node tools/experiment-runner.mjs --spec '<spec.json>' --check

# 生成 spec（会先跑完整预检；失败不写文件）
node tools/experiment-command.mjs --dsh-exe '<dsh-exe>' --dsh-cli '<dsh-cli>' \
  --dsh-home '<repo>\tests\.scratch\v02-stage1\dshhome' --profile stage1 \
  --project-cwd '<new-project>' --run-dir '<new-run-dir>' \
  --gate-port 18921 --upstream-port 18920 --model-requests 40 \
  --require-file src/sum.mjs --require-file src/note.txt --require-file test/sum.test.mjs \
  --prompt '<captain prompt>' --fake-server '<repo>\tests\.scratch\v02-stage2\fake-model-server.mjs' \
  --policy '<repo>\tests\fixtures\repair-loop-policy.v3.json' \
  --pin-source '<HEAD sha>' --pin-fixtures '<HEAD sha>'
```

生成器要求环境变量 `TLA_STAGE2_FAKE_KEY=stage2-fake-key`（占位假键，不是秘密）通过
`overlay:credentials` 静态检查。

## 8. 文件清单与哈希

本目录的逐文件 `sha256`/字节数见 [`MANIFEST.json`](MANIFEST.json)；round11 原件与脱敏副本的对应
关系见 [`evidence/ORIGINALS.json`](evidence/ORIGINALS.json)。原件保留在
`tests/.scratch/v02-stage2/host1/round11/` 与 `round12/`，**不入库**。

- `README.md`：本文件。
- `evidence/round11-experiment-spec.json`：被拒 spec 的脱敏副本（pins `f0aa1ba` / `5090677`）。
- `evidence/round11-runner-exp-mvev7adf-ec166edb.json`：`spec-invalid` 摘要，`owned: []`。
- `evidence/round11-launch.out.txt`：当时的失败输出。
- `evidence/round11-check-old-spec.txt`：新 `--check` 对旧 spec 的拒绝（源码不匹配 + 夹具字节不同）。
- `evidence/round12-experiment-spec.json`：在 `95d7618` 洁净检出上生成并 9 项预检全过的 spec；
  **不是启动授权**，HEAD 一旦前进它就会被（且应当被）预检拒绝。
- `evidence/round12-generator-preflight.txt`：生成器同一时刻的完整预检与生效配置输出。

## 9. 已知阻塞

1. **没有启动授权**：下一次 `experiment-runner` 需要新的、一次性外层放宽审批；不得从本包推断“还剩
   一次”。
2. **完整闭环未验证**：run10 的失败已离线修复（工具参数、`attempt_id`、策略预演），但修复后从未
   在真实宿主上跑过。
3. **环境会漂移**：DSH 桌面端会自动更新（本轮就从 `0.2.0-rc.2` 跳到 `0.2.1-rc.2`）。每次启动前必须
   重跑生成器，确认没有 `skipping profile bundle`、没有 `unknown` 组件；团队插件版本与宿主
   `recommendedHost` 必须匹配。
4. **pin 必须等于启动时 HEAD**：任何交接包/文档里的 SHA 都只是历史记录。修改夹具后必须提交，再用
   新 HEAD 同时作为 `--pin-source` 与 `--pin-fixtures`。
5. **进程表不可读**：本沙箱拿不到后代枚举，`treeProof` 只能退化为 `tree-killed`；收尾断言依赖
   `taskkill /T`，不能把 `descendantsProof: unavailable` 读成“没有后代”。

## 10. 下一工作包（建议顺序）

1. 新会话先读本包与 `docs/V0.2-NEXT-EXPERIMENT.md` §4/§14，再核对现场：`git status`、HEAD、分支、
   端口 18920/18921、插件版本与 `--dump-config`。
2. 用缺陷项目新建 project + run 目录（`src/sum.mjs` 必须是 455 字节红测试版本，`src/note.txt`
   基线存在），预算预演必须 `fits:true`（当前 31/35/38）。
3. 以当时 HEAD 同时作为源码与夹具 pin，跑生成器；只有 `FULL PREFLIGHT OK` + `STATIC PREFLIGHT OK`
   才进入审批。
4. 单独申请**一次**外层放宽，只覆盖 `experiment-runner` 这一条命令；失败即停，不重试。
5. 运行后用 `ledger-from-run` + `acceptance-summary` 出 `verdict`；只有 `closed` 且 10 条件全满足
   才能更新 V0.2 验收表述。任何 `partial` 都必须原样记录 unmet。

## 11. 新会话启动词

```text
接续 TLA V0.2。先读 docs/handoffs/v0.2-2026-10-19/README.md 与 evidence/ORIGINALS.json，
再只读核对：分支、HEAD、git status、DSH/agent-teams 版本、端口 18920/18921、§4 生成器的
--dump-config 结果。不要继承任何启动授权：当前剩余授权为 0。
V0.2 尚未整体验收；监督器 completed、宿主 exit 0 都不等于业务闭环通过。
先报告“实际 HEAD、已完成、未完成、是否消耗过本轮授权”，再继续不需要审批的开发。
```
