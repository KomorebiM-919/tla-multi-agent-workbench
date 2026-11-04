# TLA 版本与工作区规范

本文件是 [`AGENTS.md`](../AGENTS.md) §2 的配套规范：定义每个主要版本如何占用分支、工作区与会话，
以及一个版本在“可交付”之前必须交出什么。它约束人机双方，AI 开发者必须先读再动手。

## 1. 一句话规则

**一个主要版本 = 一个长期分支 + 一个并列的正式工作区 + 一个专属 DSH 会话；小修复留在原工作区，不换目录。**

## 2. 分支与工作区

| 版本 | 分支 | 正式工作区 | 状态 |
| --- | --- | --- | --- |
| V0.1 | `feat/v0.1-three-agent-mvp`（`b2b48ab`） | 主仓库工作树 `<repo>`（当前检出该分支） | 未合并；归档标签 `archive/v0.1-verbatim` |
| V0.2 | `feat/v0.2-component-reuse` | `<repo>\..\workspaces\v0.2-component-reuse` | 开发中，**未验收** |
| V0.3 | `feat/v0.3-desktop-ui`（基线 `release/v1.0-minimal`，`95d4e7d`） | 独立仓库 `<active-workspace>`（旧 C 盘仓库保留，不再开发） | 首批桌面壳 + 本地项目/任务草稿开发中，完整 V0.3 **未验收** |

### 2.1 V0.3 的工作区例外与迁移（2026-11-04 人工批准，一次性）

- **基线例外**：V0.3 没有从“已验收的 `main`”起步。已验收的发布分支是 `release/v1.0-minimal`，
  其 tip 为 `95d4e7d045a00e172f0deb21e1e2d22c484946bd`
  （提交信息 `docs: publish accepted minimal workflow baseline`，2026-11-04 02:18:50 +0800）；
  `feat/v0.3-desktop-ui` 是基于该提交建立的开发分支。该独立仓库本地只检出这个开发分支，没有 `main`。
  用户知情并批准了这次一次性例外；它**不**推翻 §3 第 1 条，后续版本仍须回到已验收的 `main`。
- **独立仓库，不是 worktree**：`<active-workspace>` 自带 `.git`，`git worktree list` 只有它自己一条登记项；
  `origin` 指向既有 GitHub 仓库（本批未 fetch，`refs/remotes` 为空）。
- **活动源码已迁到 E 盘的 active 独立仓库**：2026-11-04 用 `git clone --no-hardlinks` 从旧 C 盘仓库
  `C:\Users\<user>\TLA-Workspaces\v0.3-desktop-ui` 复制到 `<active-workspace>`，分支、`HEAD`
  （`b8c5f27`）与 tracked 508 条目保持一致，`.git/config` 的 `[tla]` 段记下迁移来源与时间；
  `renderer-dist/` 是忽略产物、不带进 clone，按字节复制并校验。
  旧 C 盘仓库从此只作旧现场保留，不再开发。
- **旧工作区保留**：C 盘旧仓库与 E 盘旧工作区（与本仓库并列的 `v0.3-desktop-ui`）都不迁移、不删除、
  不改写其工作树；本批不并发使用其中任何一处。

- 主要版本各用独立分支（`feat/vX.Y-<feature>`）、**并列**工作区、新 DSH 会话；不同版本不共享工作区，
  也不并发使用同一工作区。
- 小修复（同版本内的缺陷、测试、文档）留在该版本工作区内完成，不新建目录、不新建分支。
- 工作区必须由 `git worktree` 管理，或直接是主仓库的工作树。**不得**把长期开发放在
  `tests/.scratch/` 这类被 `.gitignore` 忽略的临时路径下：那里的内容不会随仓库迁移、不受版本登记保护，
  也容易被清理脚本扫掉。
- 迁移工作区只能用 Git 支持的方式（`git worktree move`），**不得**用剪切、整目录复制或强推替代；
  迁移前必须列出源/目标、受影响的 `git worktree` 登记项、以及回退步骤。
- 换会话先核对：分支、`HEAD`、`git status`、`git worktree list`、以及新位置的**常态**写权限。
  如果新位置在常态沙箱下不可写，先报告，不要靠反复放宽外层权限来维持日常开发。
- 迁移后必须核对**工作区之外**的活动引用：隔离 DSH profile 的 `package.json`、包管理器 lock、
  `node_modules` 链接（Junction/符号链接）是否仍指向旧路径。Git 迁移只改写 Git 登记，不改写这些链接。
  历史日志、旧 spec、备份目录与 `package.before-uninstall.json` 属于证据，原样保留，不参与全局替换。
- 若身份门禁要求插件解析根位于 profile 内，采用 **profile 内副本 + profile 内链接**；副本必须与已审查源码的
  版本、文件清单和构建指纹一致，并把修复前后证据写进迁移记录。公开文档只写占位符，profile 备份与绝对路径留本地。
- 迁移检查必须可复跑（例如 `tools/check-migration-links.mjs`），覆盖外部链接、断链、manifest/lock 不一致与
  副本漂移；检查失败不得进入实验审批。

### 2.2 桌面运行目录（不是工作区）

- 正常桌面入口是运行目录里的启动脚本 `<run-dir>\launch-tla.cmd`：它把 `TLA_DESKTOP` 指向
  `<active-workspace>\desktop`，用运行目录自带的 Electron 45.2.1（`runtime-45-normal\electron.exe`）
  加载已构建的 `renderer-dist/`，只清除子进程继承的 `ELECTRON_RUN_AS_NODE`、`TLA_DEV_SERVER_URL`。
- 运行目录用 `robocopy /COPY:DAT` 从原诊断目录复制（只带数据/属性/时间，不带安全描述符）；
  实测目录与 `electron.exe` 都是 `no-label`（普通 Medium）。
- **运行目录不得作为 DSH 工作区。** 本批实测：DSH 工作区目录会被写入显式 ACL 与
  `Mandatory Label\Low Mandatory Level`；原开发目录继承了 Low 完整性标签，启动故障即定位在这里，
  而迁移出的运行目录没有该标签。再把它登记成工作区，等于把问题搬回来。
- **权限/ACL 修复脚本本批不执行。** 后续权限一旦再变化，`PurgeAccessRules` 不能无条件当作
  “只删除本次新增 ACE”的精确回滚——重跑前必须先比对当时的 ACL 快照，否则可能连带删掉别人的 ACE。
- 该入口是“独立运行时 + 源码目录”的开发式启动，**不等于** `npm start` 或打包 `TLA.exe` 已永久修复。
- 2026-11-04 用户已确认该入口能打开窗口并显示角色卡与对应详情——入口本身可用；但这**不等于**完整 V0.3、
  原 `npm start` 或旧打包 `TLA.exe` 已通过验收，文档不得据此写成整体验收完成。

## 3. 起点与兼容

1. **新版本从已验收的 `main` 起步。** 未验收的分支不得充当新版本的基线，也不能用“先并进去再验收”倒过来用。
2. **每个新版本必须持续跑上一版本的兼容回归**：上一版的测试入口、样例与夹具保持可执行；
   回归结果写进本版兼容报告，红了就停，不带病前进。
3. 分支拓扑必须可复核：用 `git merge-base --is-ancestor`、`git rev-list --left-right --count` 取证，
   不靠“应该是从那里切的”这种叙述。

## 4. 当前过渡状态（2026-10-19 实测，不得假装已收口）

- `main` = `2f019920c8667378065fee947eeaa8636ca49bf4`（Merge PR #1）。
- `feat/v0.1-three-agent-mvp` = `b2b48ab686c60e7d95f8513b3876b656818269a3`，**未合并**进 `main`，
  也不是 V0.2 的祖先（`git merge-base --is-ancestor` 为假）。
- `feat/v0.2-component-reuse` 与 V0.1 分支**同源于** `2f01992`：V0.2 的基线是“尚未收口的 `main`”，
  **不是**“已验收的 V0.1 成果”。因此任何“V0.2 建立在 V0.1 之上”的表述都不成立。
- 允许的表述：V0.1 未合并、`main` 未更新、V0.2 处于待收口的过渡状态。
  不允许的表述：`main` 已包含 V0.1、V0.2 已从 V0.1 发布基线起步。
- 归档标签 `archive/v0.1-verbatim` 保留，不改写、不移动。

### 4.1 V0.3 工作区实测（2026-11-04）

- 活动仓库 `<active-workspace>`：迁移时 `HEAD` = `b8c5f27`
  （`fix(desktop): make startup failures visible and log them`），当前分支 `feat/v0.3-desktop-ui`，
  `git worktree list` 只有这一条，`refs/remotes` 为空（本批未 fetch）；此后本地提交了 `3f8837d`
  （迁移文档）与本地项目/任务草稿批次，最新提交以 `git log` 为准。
- 迁移前的旧 C 盘仓库 `C:\Users\<user>\TLA-Workspaces\v0.3-desktop-ui` 停在同一个 `HEAD`，
  工作树干净、领先 `origin` 3 个尚未推送的本地提交；现在只作旧现场保留。
- 本地**没有** `main` 分支（只检出 `feat/v0.3-desktop-ui`）；远端 refs 未 fetch，`origin/HEAD` 未核对。
  因此“从已验收 main 起步”在本仓库当前不可执行，只能按 §2.1 登记为例外。
- 允许的表述：V0.3 从发布分支基线起步、`main` 尚未参与本版本。
  不允许的表述：V0.3 已从已验收 `main` 起步、V0.3 已合并或已验收。

## 5. 每个版本的交付清单

一个版本要进入验收，必须同时具备下列六项（缺一项就不能声称“可交付”）：

1. **效果总结**：这一版解决了什么、与上一版相比的可见变化，附数字而不是形容词。
2. **测试入口**：一条（或一组）可复跑的命令，明确哪些测试是离线替身、哪些需要真实宿主。
3. **兼容报告**：上一版回归的结果，逐套列出通过/失败/被环境阻塞，并说明被阻塞的原因。
4. **已知限制**：明确“没验证过什么”，不得用“应该没问题”代替。
5. **交接包**：状态、证据、授权余量、下一步与回退路径；路径一律用相对路径或占位符。
6. **版本标签计划**：打算打的标签名、指向哪个提交、在什么验收条件下打；本轮只计划，不执行。

## 6. 合并与发布

`main` 合并、标签发布、Draft PR 转正式，都属于验收之后的独立人工决定。AI 开发者只能建议并给出证据，
不得自行合并、打标签或强推。公开证据里不写本机绝对路径：用 `<repo>`、`<dsh-install>`、
`<active-workspace>`（V0.3 活动工作区）、`<run-dir>`（桌面运行目录）、`<repo>\..\workspaces\<version>`
这类占位符。迁移记录、ACL 快照与 profile 备份留在本地。
