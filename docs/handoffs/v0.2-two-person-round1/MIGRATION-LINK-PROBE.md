# 迁移链接差异诊断（Round 6）

日期：2026-10-20。审查对象代码
`88c9fe527e67ee885918d253c90de4caa1eafc56`，文档 tip
`fee7ea925e0b7e7703838d2c644cc5131b08b12c`，父提交
`8bf26d38bf86052974c47029ae75ab7fd20545f1`。DSH 工作区基线
`2c4d63caf7baedaa645d65a3701787b6cefefb82`，分支
`feat/v0.2-component-reuse`，status 只含本轮未跟踪文件。

本轮只新增诊断工具和测试，没有修改 `tools/check-migration-links.mjs`、
验收判定器、采集器、隔离 profile 或 ACL。没有启动宿主、假模型服务或模型；
没有安装依赖、合并 main、强推或读取凭据。真实宿主启动授权仍为 0。

## 结论

差异已定位到**链接创建阶段/执行环境**，不是 C/D 卷、不是创建方法
（Node / cmd / PowerShell）、也不是观察进程：

- 在常态受限环境（DSH workspace-write）中创建目录 junction，reparse 的
  `Substitute Name` 是 `\??\Global\...`；Node v24.21.0 对该链接
  `lstat.isSymbolicLink() === false`、`readlink` 抛 `EINVAL`、`realpath`
  返回链接自身。PowerShell/`Get-Item` 仍能看到
  `LinkType=Junction`、`Target={Global\...}`。
- 在已获批准的普通用户 full-access 执行环境中创建同一链接，`Substitute
  Name` 是 `\??\...`（没有 `Global`）；Node 的 `lstat=true`、`readlink`
  正常、`realpath` 指向 target。
- 同一链接跨环境观察不改变结论：normal 创建的 Global 链接在 full 下仍然
  `lstat=false`；full 创建的非 Global 链接在 normal 下 `lstat=true`。
- 真实隔离 profile 的现有链接是非 Global 形态，normal 下可识别；所以真实
  profile 审计仍通过，并不矛盾。
- 作者声称的 C/D 双卷 10/10 在 DSH normal 下不可复现。C normal 甚至不能
  `mkdtemp/mkdir`；D normal 能创建 Node junction，但 `fsutil` 和独立 Node
  子进程 `spawnSync` 均被 `EPERM` 阻断。full 下 C/D 均为 6/6 可识别。

这不是 false acceptance：检查器对无法识别的链接仍保守拒绝，真实 profile
仍通过。它说明的是 **`readlink` 证据不足以覆盖“目录式 lstat”形态**，以及
作者的环境自检不能直接外推到 DSH normal 沙箱。

根因机制尚未隔离：为什么 normal 创建会注入 `Global` 前缀，是受限令牌、
DSH 宿主 shim、Windows 重解析点 API 还是其他层，需要 Codex 结合宿主实现判断；
本报告不把它归因为 Node 缺陷或卷类型。

## 运行时

| 项 | 值 |
|---|---|
| Node | `v24.21.0` |
| platform / arch | `win32` / `x64` |
| OS release | `10.0.26200` |
| Node 可执行文件 | `<node>`（真实路径已脱敏） |
| 工具 schema | `tla.migration-link-probe/v1` |
| full 工具退出码 | `0`（C 与 D 均完成并清理） |
| normal 工具退出码 | `1`（仅因 C 根不可写；D 根已清理） |

`DSH_FILE_POLICY`、`DSH_SANDBOX_MODE`、`DSH_WORKSPACE` 在子进程中不可见，
记录为 `null`；执行环境以“normal workspace-write / 一次性 full access”标识，
不以环境变量推断。

## 对照表

`lstat` 为 Node `fs.lstatSync` 的 `isSymbolicLink()`；`readlink` 为
`fs.readlinkSync`；`realpath` 为 `fs.realpathSync`。`Global` 指 `fsutil`
的 `Substitute Name` 是否以 `\??\Global\` 开头。

| # | 环境 | 创建者/方法 | reparse prefix | lstat | readlink | realpath |
|---|---|---|---|---|---|---|
| 1 | normal D | Node `symlinkSync(...,'junction')` | `Global` | false | EINVAL | 链接自身 |
| 2 | normal D | cmd `mklink /J`（host shell） | `Global` | false | EINVAL | 链接自身 |
| 3 | normal D | PowerShell `New-Item -ItemType Junction` | `Global` | false | EINVAL | 链接自身 |
| 4 | full C | Node / cmd | 非 Global | true | target | target |
| 5 | full D | Node / cmd | 非 Global | true | target | target |
| 6 | normal D | 观察第 1 行创建的链接（独立后续调用） | `Global` | false | EINVAL | 链接自身 |
| 7 | normal D | 观察 full 创建的非 Global 链接（独立后续调用） | 非 Global | true | target | target |
| 8 | normal D | 现有隔离 profile 的 `node_modules/tla-prelaunch-budget` | 非 Global | true | `vendor/interceptor-plugin` | target |

full C/D 的 ordinary directory 均为 `ordinary-directory`，missing 为
`missing`，broken junction 为 `link` 且 `realpath=ENOENT`；external target
为 `link` 且 `targetOutsideContainer=true`。normal 下 ordinary/broken 因
`fsutil`/子进程被阻断而只能记为 `reparse-probe-unavailable` 或 `missing`，
工具不会把它们误判为 link。

## 交叉矩阵

| 创建环境 | normal 观察 | full 观察 |
|---|---|---|
| normal（Global） | `lstat=false`、`readlink=EINVAL` | `lstat=false`、`readlink=EINVAL` |
| full（非 Global） | `lstat=true`、`readlink` 正常 | `lstat=true`、`readlink` 正常 |
| 现有 profile（非 Global） | `lstat=true`、`readlink` 正常 | 未重建，只读形态一致 |

因此观察进程不是变量；差异在创建时已形成。

## 哪些假设已排除

- **C/D 卷类型**：full 下 C 与 D 都生成非 Global 且 Node 可识别；normal 下
  D 生成 Global。卷不是决定因素。C normal 的不可写是权限阻塞，无法参与
  创建对照，不能反过来当作卷证据。
- **创建方法**：normal 下 Node、cmd、PowerShell 都产生 Global；full 下
  Node 与 cmd 都产生非 Global。方法不是决定因素。
- **观察进程**：normal 创建的链接在 full 下仍不可见；full 创建的链接在
  normal 下可见。
- **路径/仓库位置**：同一个 D 工作区在 normal 与 full 下分别得到 Global
  与非 Global。
- **真实 profile 链接损坏**：profile 链接在 normal 下仍 `lstat=true`、
  `readlink` 正常；真实审计 23/23 通过。

## 哪些仍不能证明

- `Global` 前缀由哪一层注入、是否与 DSH 沙箱令牌/宿主 shim 有关，未隔离。
- normal 下 `fsutil` 和独立 Node 子进程被 `EPERM` 阻断，因此不能用它们
  在 normal 内部独立复核 `Global`；该字段来自 normal host shell 的
  `Get-Item`/`fsutil` 以及 full 下的交叉观察。
- C normal 不可写，无法在 C 上完成“normal 创建”对照组。
- 没有真实宿主的链接创建路径样本；不能据此断言生产环境一定使用 normal
  的 Global 形态，也不能断言 Codex 环境与 DSH full 环境完全等价。
- 根因未定位，因此本轮不建议直接改核心检查器；任何修复应由 Codex 决定。

## 对修复方向的建议（不实施）

1. 迁移链接 fixture 必须在与生产相同的执行环境中创建，或显式注入
   reparse 元数据；不能用 full 环境创建的 fixture 代替 normal 环境样本。
2. 检查器不能只依赖 `lstat/readlink`。在 `lstat=false` 且 `readlink=EINVAL`
   时，应把“无法读取 reparse 元数据”作为环境阻塞/保守拒绝，而不是判为
   ordinary directory 或测试通过。
3. 若需要跨环境识别，应由宿主提供只读 reparse 元数据接口，或使用能在
   normal 下工作的系统 API；不要通过放宽 ACL、改为 full 执行或删除断言
   来追求全绿。
4. 作者自检的 C/D 10/10 应标注执行环境；normal DSH 的 5/10 应作为环境
   限定结果保留。

## 复算命令

```text
node tools/probe-migration-links.mjs --root <c-root> --root <d-root> \
  --existing <profile-link> --out <report.json>

node tools/probe-migration-links.mjs --root <d-root> \
  --existing <normal-created-link> --out <normal-report.json>

node tests/v02-migration-probe.test.mjs
node tests/workflow-logic.test.mjs
node tests/preflight-script.test.mjs
```

C/D 必须是显式指定的可写根；工具只在 root 下创建唯一
`dsh-link-probe-*` 容器，默认清理并校验无残留。`--existing` 只读，不重建
profile 链接。

## 原始证据与脱敏映射

原始 JSON 保留在审查机本地，不提交（包含绝对路径）。公开表只保留上文的
环境/形态字段。完整性哈希如下：

| 本地原始文件 | bytes | sha256 | 对应公开内容 |
|---|---:|---|---|
| `.probe-full-report.json` | 84947 | `e0d8b86d78875c667a81164e8d1bfc307f5aa7592b820af40106eeb74a962fd3` | full C/D 对照表第 4-5 行、ordinary/missing/broken/external |
| `.probe-normal-report.json` | 23232 | `b9b0d52eabeb7ab5a473147518ad8eeae2d537a4876487207e229260aa59f996` | normal D、C 根 EPERM、environment blocker |
| `.probe-profile-normal.json` | 22959 | `6d0ac32e425bfa25dd1e30e579c356708d99e15362540866191c6a7cb10b0ee0` | 第 8 行真实 profile 只读观察 |
| `.probe-cross-full-normal.json` | 22674 | `5c82814ca9b194a993cbf162e01a9f2fee7f5699eb43a47f0899faa1d6c66891` | 第 7 行 full 创建、normal 观察 |

## 回归与边界

- `tests/v02-migration-probe.test.mjs`：7/7，exit 0（普通目录、缺失、可见
  link、reparse 隐藏、断链、external）。
- `tests/workflow-logic.test.mjs`：114/114 场景、547 断言，exit 0。
- `tests/preflight-script.test.mjs`：9/9 场景、42 断言，exit 0。
- 未修改的核心检查器不在本轮重跑全套 29 条；`v02-migration-links` 的
  normal 结果仍为 5/10，已作为环境限定证据保留。
- 未启动宿主/模型，未改 ACL/profile，未安装依赖。V0.2 真实返工闭环状态
  不变。
