# TLA Desktop（V0.3 首批桌面壳）

独立桌面子工程，不改变仓库根 `package.json`（V0.2 observer 包）与冻结内核。当前交付“能启动、能看、边界诚实”的桌面壳，
并支持**本机多项目、项目计划、独立对话输入、未发送文字自动保留和按项目手动角色设置**。
界面采用对话优先的布局（对话 / 团队 / 流程，项目设置从左侧独立入口打开）；组织关系图与工作流阶段模板放在辅助页；
模型标签只记录计划分工，**不连接任何模型**。
视觉按已确认的暖黑稿实现；Source Sans 3、Source Serif 4 与思源黑体作为开源字体随构建产物本地加载，不依赖网络或系统安装。

## 对话优先的页面布局

- **对话页（默认）**：中栏是对话工作区，下方是**独立的对话输入框**，不再复用项目的 `taskDraft`。
  每个项目自动保留最新一份未发送文字到 `conversation-drafts.json`，界面上显示“保留中 / 输入已保留（时间）/ 保留失败”；
  这不是正式保存。当前没有执行引擎，“发送”固定禁用并标注“未接入”；不生成回复、不伪造忙碌状态，也不预建聊天记录。
  空态只说明尚无消息，不预置设计样稿里的成员对话。项目名称、简介与计划不在对话页编辑，统一放到左侧“项目设置”。
- **项目设置（左侧入口）**：独立页面，编辑项目名称、简介和项目计划（旧版本的 `taskDraft` 原样沿用该字段与长度上限），
  保存按钮写正式 `workspace.json`。对话输入与未发送文字不随项目设置保存，也不会被它清空。
- **团队页**：角色卡片、只读组织关系图与手动角色设置都在这里；流程模板移到**流程页**，仍是整体“未运行”的只读模板。
  角色详情只在团队页占用右侧辅助列；切到对话、流程或设置页时该列直接释放，选中角色保留但不渲染。
- **团队动态**：顶部“团队动态”是固定入口，每次启动默认收起。展开后是**参与网格布局**的 docked 侧栏，与角色详情共用右侧
  同一列，不覆盖主区或输入框；可切成右下浮窗。头部有 ×（`aria-label="收起团队动态"`）和“Esc 收起”提示，收起后焦点回到
  触发按钮。所有会进入 docked、并可能隐藏角色表单的入口——首次展开，以及浮窗的“收进侧栏”——
  都先走同一个 `mayLeave` 离开保护；被拦下时保持浮窗、表单与提示可见，不自动保存、取消或延迟转换。
  收起和 docked→浮窗只改变显示，不会启动、暂停或取消任何工作。
  没有真实活动时只显示“尚无运行中的任务”，不伪造记录。
- **未保存保护**：对话、团队、流程、设置任意两页之间的切换都先经过同一个角色 `mayLeave` 检查，不只在离开团队页时检查；
  切换项目、关闭角色详情也复用同一保护。被拦下时保留当前页、表单和可操作的提示，不自动保存、丢弃或延迟执行这次导航。
  页面切换是普通状态，不引入路由库、图形库或独立窗口框架。
- **滚动与页脚**：主区是固定高度的纵向布局，提示区单独限高滚动，对话消息区与设置页各自滚动，输入框不再 sticky，
  不会压在页脚上；1024×680、1280×820、1440×900 三档下输入与按钮保持可达。

## 目录

```
desktop/
  electron/
    main.mjs            # 主进程：窗口、权限、导航与 IPC 加固、启动诊断、工作区 IPC
    diagnostics.mjs     # 同步追加的启动日志（%APPDATA%\TLA\logs\main.log）
    security.mjs        # 页面地址与 IPC 调用方的信任判定（纯函数，可单测）
    workspace-store.mjs # 工作区文件的校验、读取与原子保存（不依赖 Electron，可真实文件测试）
    recovery-store.mjs  # 恢复稿 recovery.json 的校验、保存、放弃与版本水位（同样可真实文件测试）
    team-settings-store.mjs # 独立角色设置、目标角色合并与原子写入
    conversation-drafts-store.mjs # conversation-drafts.json 的校验、原子保存、放弃与迟到写入保护
    preload.cjs         # 沙箱预加载：只有 tla.getAppInfo / 工作区 / 恢复稿 / 角色 / 未发送文字 / 关闭握手
    ipc-channels.mjs    # 主进程使用的 IPC 白名单（十三个 handler 通道 + 关闭请求/超时两个事件）
  scripts/
    build-renderer.mjs  # 渲染层构建（含受限沙箱下的 exec 兼容）
    before-build.cjs    # 告知 electron-builder：依赖树由外部处理
  src/
    App.jsx             # 对话优先三页状态、工作区读取/保存、恢复稿提示与关闭握手
    lib/workspace-editing.js # 会话副本、dirty 判定、状态与字段校验（纯函数）
    lib/workspace-saver.js   # 保存协调：单请求在途、baseline 同步更新、失败释放
    lib/recovery-drafts.js   # 恢复稿协调：防抖、写入顺序、清理与放弃（定时器可注入）
    lib/conversation-drafts.js # 未发送文字协调：防抖、版本顺序、刷新与取消（定时器可注入）
    lib/team-settings.js     # 主进程与前端共用的纯角色数据契约
    lib/team-settings-controller.js # 角色表单、请求身份、保存与关闭保护
    lib/page-navigation.js   # 页面切换统一经过角色离开保护（纯函数，可单测）
    lib/layout-state.js      # 辅助列归属与动态侧栏/浮窗开合规则（纯函数，可单测）
    lib/dynamics-transition.js # 动态模式转换：进入 docked 前统一走角色离开保护（纯函数，可单测）
    lib/org-chart.js         # 只读组织关系模板：稳定 roleId 引用与节点完整性校验
    components/         # 项目导航、对话工作区、项目设置、团队卡片/组织关系图、团队动态、角色详情、工作流模板
    data/team.js        # 初始团队模板（唯一数据源）
    data/workflow-template.js # 冻结工作流的阶段顺序模板（只读，不读取历史记录）
    assets/fonts/       # 内置开源 WOFF2 变量字体（Source Sans 3 / Source Serif 4 / 思源黑体）
    styles.css          # 暖黑主题、三列/双列布局与本地 @font-face
  public/licenses/fonts/ # 字体许可证、来源清单与 font-manifest.json（随 renderer-dist 复制）
  tests/                # node:test 单元测试（工作区/恢复稿/角色/未发送文字存储、IPC、角色数据、诊断、安全边界、启动流程、布局规则、字体资源校验）
  index.html
  vite.config.mjs
  package.json          # 精确版本依赖 + electron-builder 配置
```

## 工具链

需要 Node 24。本机用的是工作区内的便携包 `<workspace>\.tools\node-v24.22.2-win-x64`
（Node 24.22.2 / npm 11.19.1，官方 zip 校验 SHA-256 后解压），缓存放在同一目录下：

| 目录 | 用途 |
| --- | --- |
| `<workspace>\.tools\cache` | Node 官方 zip 与 `SHASUMS256.txt` |
| `<workspace>\.tools\npm-cache` | `npm_config_cache` |
| `<workspace>\.tools\electron-cache` | `electron_config_cache`（Electron 二进制） |
| `<workspace>\.tools\localappdata` | 沙箱内 `%LOCALAPPDATA%` 的替身（env-paths 的默认缓存根） |

`.tools/` 已被 `.gitignore` 忽略，工具链、依赖和缓存都不入库。下面只改当前进程的环境变量，不动系统 PATH：

```powershell
$env:PATH = '<workspace>\.tools\node-v24.22.2-win-x64;' + $env:PATH
$env:npm_config_cache = '<workspace>\.tools\npm-cache'
# @electron/get 通过 env-paths 读 LOCALAPPDATA，不认 ELECTRON_CACHE；
# electron-builder 的下载缓存也落在同一目录下。
$env:LOCALAPPDATA = '<workspace>\.tools\localappdata'
$env:electron_config_cache = '<workspace>\.tools\electron-cache'
```

## 常用命令

在本目录执行：

```powershell
npm ci --no-audit --no-fund --foreground-scripts   # 按 package-lock.json 复现，不改依赖版本
npm run build:renderer                             # 渲染层构建到 renderer-dist/
npm test                                           # 工作区/恢复稿存储、编辑模型、IPC 边界、角色数据、诊断、安全边界、启动流程
npm start                                          # 用本机 electron 启动（需先 build:renderer）
npm run pack:dir                                   # 构建 + Windows dir 便携打包到 release/
```

`npm ci` 必须带 `--foreground-scripts`：受限沙箱不允许 npm 用管道 stdio 起子进程，否则在重建阶段报
`spawn EPERM`（`@npmcli/promise-spawn` → arborist `rebuild.js`）。装完依赖后 `package-lock.json`
不应有任何变化，可用 `Get-FileHash desktop\package-lock.json -Algorithm SHA256` 对照。

Electron 45.2.1 的包**没有** `postinstall`：二进制由 `node_modules/electron/index.js` 在第一次
`require('electron')`（也就是 `npm start`）时懒下载。想提前预热、或想单独确认二进制可用：

```powershell
node -e "console.log(require('electron'))"   # 打印 dist\electron.exe 的绝对路径
```

渲染层开发时可单独跑 `npx vite`，再用 `TLA_DEV_SERVER_URL=http://localhost:5173` 启动主进程加载开发服务器。

打包时 electron-builder 会调用 `npm ls` 收集依赖树，在受限沙箱里会 spawn 失败。
本工程没有运行时依赖（渲染层已打进 `renderer-dist/`），因此用 `scripts/before-build.cjs`
返回 `false` 声明“node_modules 由外部处理”，从而跳过这次收集。
**以后若加入运行时依赖，必须删掉 `build.beforeBuild` 这个钩子**，否则依赖不会被打进包里。

## 本地项目、项目计划与对话输入

桌面壳支持本机多项目：从左侧“项目设置”新建、改名称与简介、编辑项目计划，并切换项目。
项目计划与对话输入是两套独立数据：前者随项目正式保存，后者自动保留未发送文字。
这些数据只存在本机工作区文件里，不入库、不联网、不连接模型。

- **位置固定**：`<workspace>\.local\tla-desktop\workspace.json`。路径由 `electron/workspace-store.mjs`
  按源码位置解析（`desktop/` 的上一级），不依赖 cwd，也不接受渲染层传入；`.local/` 已加入 `.gitignore`。
- **结构**：`{ schemaVersion: 1, activeProjectId, projects: [{ id, name, description, taskDraft }] }`。
  最多 20 个项目；名称 60、简介 500、项目计划 5000 字符；文件上限 512 KiB。ID 只允许小写字母、数字和连字符，
  且必须唯一，`activeProjectId` 必须指向已有项目。字段名仍沿用 `taskDraft` 以兼容旧数据与既有存储，
  界面统一称为“项目计划”，不会把旧内容清空或迁移成另一份文件。
- **校验在写入前**：主进程按上面的规则校验字段、版本、ID 与选中关系；任何越界、未知字段或多余键都直接拒绝，
  返回错误码与原因，**不做静默截断或修补**。渲染层只保存当前项目的新内容，其他项目写回最近一次成功保存的版本，
  因此“保存这个项目”不会顺带提交别的项目的未保存修改。
- **文件不存在**：返回一个默认项目（`我的第一个项目`），不主动创建文件；用户点保存才落盘。
- **文件损坏、版本不认识或读不出来**：界面显示错误码与原因，本窗口停止保存，原文件原样保留，不会被“重置成默认值”。
- **写入是原子的**：同目录唯一临时文件写完后 `rename` 覆盖，不先删除旧文件；保存请求串行执行，
  失败时保留旧数据并只清理本次临时文件。
- **同一时刻只允许一次保存**：请求在途时，其他项目的保存按钮禁用并提示“另一个项目正在保存”；
  切换项目与继续编辑不受影响。保存结果回来、baseline 同步更新之后才接受下一次保存，
  避免拿过期快照把刚写进去的内容覆盖掉。
- **界面状态**：每个项目标注“未保存 / 保存中 / 已保存（时间）/ 保存失败”，新建项目在首次保存前显示“尚未保存”；
  切换项目时未保存的修改留在会话中，并自动备份到恢复稿；重开窗口时可以恢复，正式文件仍是最近一次成功保存的内容。

### 恢复稿与取消新建

正式保存是显式动作，恢复稿只负责“别让没保存的内容丢掉”，两者分开：

- **位置**：同一 `.local\tla-desktop\` 下的 `recovery.json`，结构
  `{ schemaVersion: 1, projects: [{ id, name, description, taskDraft, revision, updatedAt }] }`。
  每个项目只保留最新一份快照，不存历史；`.local/` 已整体加入 `.gitignore`。
- **何时写**：编辑时按 400 ms 防抖备份；名称被临时清空、只剩正文等中间态也会备份。界面显示
  “恢复稿备份中 / 恢复稿已备份（时间）/ 备份失败”，与正式保存的“已保存”明确区分，不会把备份说成保存成功。
- **顺序与身份**：写入按项目串行，`revision` 单调递增；磁盘上已有更高版本的请求会被拒绝（`STALE_SNAPSHOT`）。
  放弃/取消后记录内存水位，迟到的旧备份不会覆盖新稿，也不会让已放弃的项目重新出现（`DISCARDED`）；
  清理掉一份已被正式文件覆盖的恢复稿后，协调器保留版本水位，下一次编辑仍用更高 `revision` 继续备份。
- **重开**：读到恢复稿时提示“发现未保存内容”，逐个项目提供“恢复 / 放弃”。候选包括正式文件里还没有的
  新建项目；恢复会把它插入本次编辑会话并选中，但仍保持“未正式保存”的身份，不自动改写 `workspace.json`。
  插入同样受 20 个项目上限约束：已满时不插入、不标记候选、不改会话或正式文件，并明确提示先处理现有项目。
  选择“稍后处理”只会收起面板，候选不会丢失，可用提示条重新展开。放弃只删该项目的恢复稿，正式文件保持原样。
- **正式保存与恢复稿**：保存成功后，只有恢复稿内容正好等于刚保存的内容、且没有更新的编辑时才清理；
  清理是异步的，期间继续输入的新稿会保留并重新备份，不会被一起删掉。保存失败不清理恢复稿。
  清理与备份按同一项目串行，`revision` 不会并发分配；关闭前的 `flush()` 会等清理（包括尚未返回的 discard）
  结束，只有最新待备份内容确实落盘才报告成功，否则如实返回错误。
- **关闭窗口**：主进程先拦下 close，请渲染层把防抖中的最新编辑写完再确认；等待有界（2 秒）。
  超时不会静默处理，而是发出 `tla:close-timeout`，界面提示“返回编辑 / 仍然关闭”；这次请求随即作废，
  迟到的确认会被当作过期请求拒绝，不会误关后续窗口。刷新失败时窗口同样不关闭。
  每次关闭请求都有独立 ID，只接受当次请求的确认。
- **取消新建**：只对从未成功写入 `workspace.json` 的项目显示。空项目直接移除；已经填了文字或改过名时先确认。
  取消最后一个项目后会显示可新建的空态，不会自动创建替代项目，也不写入正式文件；已保存项目没有取消入口。
  取消失败会保留项目并明确报错；保存正在进行或刚好成功时，不会把项目误当作未保存草稿移除。
  是否“已保存”以实际成功落盘为准，缺文件时的默认内存项目不算。

### 未发送文字（对话输入）

对话输入与项目计划分开存储，避免把“还没发出去的话”混进正式项目文件：

- **位置**：同一 `.local\tla-desktop\` 下的 `conversation-drafts.json`，结构
  `{ schemaVersion: 1, drafts: [{ projectId, text, revision, updatedAt }] }`。
  每个项目只保留最新一份文字，包含空字符串（用户主动清空也算一次最新状态）；最多 20 个项目、每项 5000 字符、
  文件上限 512 KiB。文件不存在时返回空列表，不主动创建。
- **何时写**：输入时按 400 ms 防抖自动保留，界面显示“保留中 / 输入已保留（时间）/ 保留失败”。
  这里只表示文字留在了本机草稿文件，**不等于**项目已保存，也不表示消息已发送。
- **顺序与迟到写入**：按项目串行，`revision` 单调递增；过期请求被拒绝（`STALE_SNAPSHOT`）。
  放弃/取消后记录水位，迟到的旧文字不能复活该项目（`DISCARDED`）。
  清空输入会以空字符串写入，不会因为“看起来为空”而跳过，也不会删除其他项目的文字。
- **重开**：读取 `conversation-drafts.json` 后按 `projectId` 回填输入框。对应项目既不在正式 `workspace.json`
  也不在恢复候选里时，文字仍原样保留，界面提示“暂时找不到对应项目”，不会删除或挂到别的项目上。
- **取消新建**：同时清理该项目的恢复稿与未发送文字；任一步失败都保留项目并报错，可以重试。
  有未发送文字时，即使项目名称为空也要先确认，不能无声丢弃。
- **关闭窗口**：关闭握手先刷新恢复稿，再刷新未发送文字；两者都成功才确认关闭。
  任一项失败都会显示失败提示，并保留“返回编辑 / 仍然关闭”，不会把未完成说成成功。
- **文件损坏或版本不认识**：保留原文件、停止本窗口的未发送文字写入并明确报错；项目设置与正式保存不受影响，
  不会用空数据覆盖原文件。

### 窗口与键盘

- **窗口**：最小窗口 1024×680；在 1024×680、1280×820、1440×900 下检查导航、阅读列与辅助列。窗口较窄时两侧栏收窄
  （≤1180px 为 208px / 312px，≤1024px 为 196px / 286px），中栏保持可读宽度。角色详情只在团队页占用右侧列；
  对话与流程页不预留空列。docked 团队动态与角色详情复用同一列，作为网格项参与布局，不用 fixed/absolute 覆盖主区；
  只有用户显式切换的浮窗是固定定位，尺寸克制在右下角，不盖住输入框。
  长项目名、多行中文、角色详情、恢复候选与错误提示在各自区域内换行，
  中栏、左栏项目列表与右栏辅助列各自滚动，按钮不被遮挡。没有用整体缩放或缩小字体的方式规避溢出。
- **键盘与焦点**：全部使用原生 `button` / `input` / `textarea`，输入框由包裹的 `label` 或隐藏标签提供名称，Tab 顺序即阅读顺序。
  “对话 / 团队 / 流程”三个入口在左侧导航中，是原生按钮；切换页面不自动移动焦点。团队动态面板打开时焦点进入面板，
  面板头部有 × 与“Esc 收起”提示；面板内 Escape 只收起面板并把焦点送回“团队动态”按钮；面板无遮罩，不锁定背景滚动。
  “关闭前备份失败/超时/角色未保存”提示出现时，焦点先落到安全选项“返回继续编辑”；背景内容设为 `inert`，Tab 不会进入遮罩后的控件，
  提示内 Tab 循环；提示层始终高于团队动态侧栏与浮动面板，提示文字和安全按钮不被面板遮挡；头部 ×、“返回继续编辑”或 Escape
  都只收起提示，不强制关闭、不放弃草稿，焦点回到打开提示前的控件。Escape 不承担“仍然关闭”；强制关闭只能点“仍然关闭”。
  没有新增快捷键框架。
- **文案边界**：区分“已保存（正式文件）/ 恢复稿备份中或已备份 / 保存或备份失败”；恢复稿只降低丢失概率，
  不承诺断电或强制退出零丢失；所有角色仍标注为未连接模型。

## 组织关系与工作流模板

两块视图都是只读模板，不会产生调度、调用、进度或真实运行记录。

- **组织关系图**：在“团队”页用“管理关系”按钮切换到只读关系图。固定结构为
  `用户总控制 → 主管位 → 其它四个 AI 角色位`，关系按稳定 `roleId` 引用，不按名称或品牌推断。
  节点显示的名称、定位与计划模型和角色卡、右侧详情来自同一份项目角色数据；重命名后图形同步。
  点击节点沿用角色详情与未保存离开保护。界面标注“初始组织关系模板 · 只读 · 非真实调度”，
  箭头只表示职责汇报关系，不代表权限、依赖或真实调用。没有拖拽、排序、增删或关系编辑。
- **工作流阶段顺序模板**：在“流程”页展示冻结顺序 `环境预检 → 需求理解 → 编码实现 → 独立验证 → 独立审核`
  （`Verifier(preflight) → Requirement → Coding → Verifier(verify) → Review`），整体标为“未运行”。
  点击阶段可查看职责与输入/输出说明；没有真实记录，因此不显示成功、失败、耗时、费用或进度。
  阶段文案不绑定任何品牌模型，也不读取历史运行记录；真实历史与费用展示留待后续契约。
  数据来自 `src/data/workflow-template.js`，由纯数据测试校验顺序、字段与节点完整性。

## 主题与内置字体

暖黑主题按已确认稿实现（`--bg: #141310`、`--accent: #c86f4a`），版式分三列：左侧导航、中央阅读列、右侧辅助列；
对话页不显示大块说明卡，空态只保留一行真实说明，不预置演示对话。

字体随仓库内置，不通过 CDN、npm 字体包或系统安装：

| 用途 | 字体 | 文件（`src/assets/fonts/`） | 字重 |
| --- | --- | --- | --- |
| 界面西文 | Source Sans 3 | `SourceSans3VF-Upright.ttf.woff2`（170,188 B） | 200–900 |
| 标题/字标 | Source Serif 4 | `SourceSerif4Variable-Roman.ttf.woff2`（429,100 B） | 200–900 |
| 中文回退 | 思源黑体 CN | `SourceHanSansCN-VF.ttf.woff2`（7,711,988 B） | 250–900 |

- 三个 `@font-face` 都用相对路径 `./assets/fonts/…` 和 `font-display: swap`；`font-family` 栈为
  Source Sans 3 → Source Han Sans CN → 系统中文字体，Source Serif 4 只用于标题与字标。
- 许可证、来源清单与 `font-manifest.json` 在 `public/licenses/fonts/`，Vite 会原样复制到
  `renderer-dist/licenses/fonts/`；三份字体也会以哈希文件名进入 `renderer-dist/assets/`。
- `npm test` 中的字体资源用例校验清单、字节数与 SHA-256，并在构建后核对产物中的字体和许可逐字节一致。
  这些是资源与构建校验，不代替真实窗口中的字体加载和视觉验收。

## 启动与验证

有两条互不等价的启动路径：运行目录里的桌面入口（现在正常使用的那条）和自己打出来的 `TLA.exe`
（仍需单独验证）。2026-11-04 用户确认**运行目录入口能打开窗口**并看到角色卡与详情；这只是入口可用的证据，
不代表完整 V0.3、`npm start` 或打包 `TLA.exe` 已通过验收。

### 桌面入口：独立运行时 + 源码目录

正常桌面入口是运行目录里的启动脚本，不是 `npm start`，也不是 `release\win-unpacked\TLA.exe`
（`<run-dir>` 指与源码仓库分离的桌面运行目录，下同）：

```
<run-dir>\launch-tla.cmd
```

脚本把 `TLA_DESKTOP` 指向本仓库的 `desktop/`，用运行目录自带的 Electron 45.2.1
（`runtime-45-normal\electron.exe`，与本仓库 `node_modules/electron/dist/electron.exe` 同一份二进制，
SHA-256 `32e357fc…`）加载已构建的 `renderer-dist/`；只清除子进程继承的 `ELECTRON_RUN_AS_NODE`、
`TLA_DEV_SERVER_URL`，不改系统环境。

- **运行目录不得注册为 DSH 工作区**：DSH 会给工作区目录写入显式 ACL 与
  `Mandatory Label\Low Mandatory Level`；启动故障已定位为原开发目录继承了 Low 完整性标签，
  而迁移出的运行目录与 `electron.exe` 是 `no-label`（普通 Medium）。
- 运行目录由 `robocopy /COPY:DAT` 复制（只带数据/属性/时间，不带安全描述符），不随仓库迁移。
- 这是“独立运行时 + 源码目录”的开发式启动，**不等于** `npm start` 或打包 `TLA.exe` 已修复。
- 2026-11-04 用户确认该入口能打开窗口、显示角色卡与对应详情（见
  [`../docs/v0.3-desktop-first-batch.md`](../docs/v0.3-desktop-first-batch.md) §4.2）；入口可用性已得到反馈，
  但完整 V0.3 与打包路径仍未验收；出问题先看下面的诊断日志。

### 打包产物：`release\win-unpacked\TLA.exe`

```powershell
# 先清掉可能继承的 ELECTRON_RUN_AS_NODE，否则 exe 会按 Node 运行、不开窗
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\release\win-unpacked\TLA.exe
```

启动过程会同步写入诊断日志，路径固定为：

```
%APPDATA%\TLA\logs\main.log
```

（`%APPDATA%` 不可写时退到 `%TEMP%\TLA\logs\main.log`，并在日志里记一条 `logs-fallback`。）

窗口打不开时按这个顺序看日志：

| 日志里最后出现的步骤 | 含义 |
| --- | --- |
| 什么都没有 | 主进程脚本没执行到，问题在 Chromium/Electron 初始化（渲染无关） |
| `step=bootstrap` 之后 | 看下一条：`single-instance-lock` |
| `step=single-instance-lock acquired=false` | 已有实例占用锁，本次按设计静默退出（会先写 `quit-secondary-instance`） |
| `step=app-ready` 之后停在 `window-created` | 窗口建好了但没显示，看 `window-shown` 的 reason 与 `did-fail-load` |
| `step=did-fail-load` | 页面加载失败，窗口会改为显示一页中文错误说明，含错误码与日志路径 |
| `step=window-shown reason=fallback-timeout` | `ready-to-show` 没来，兜底计时器强制显示窗口 |

窗口显示策略：正常情况下等 `ready-to-show`；`did-finish-load` 也会触发显示；
两者都没有时 2.5 秒兜底显示；页面加载失败则显示错误页——不会再有“进程活着但没窗口”的状态。

在 DSH 受限会话里，Chromium 建不起 mojo 通道（`Check failed: 拒绝访问 (0x5)`），进程在脚本执行前就退出，
连 `bootstrap` 都不会写入。这是**会话级**限制，和下面这条**目录级**线索要分开看：桌面双击无窗口的故障已定位为
原开发目录继承了 Low 完整性标签，迁移出的运行目录与 `electron.exe` 都是 `no-label`（普通 Medium）。
用户已在 2026-11-04 确认运行目录入口能打开窗口；这不等同于完整 V0.3、`npm start` 或打包 `TLA.exe` 已验收，
见 [`../docs/v0.3-desktop-first-batch.md`](../docs/v0.3-desktop-first-batch.md) §4。

## 安全边界

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`。
- 预加载脚本只暴露冻结的 `window.tla.getAppInfo()`、`loadWorkspace()`、`saveWorkspace(workspace)`，
  以及 `loadRecovery()`、`saveRecovery(snapshot)`、`discardRecovery({ projectId, revision })`、
  `onCloseRequest(callback)`、`onCloseTimeout(callback)`、`confirmClose(result)`、`forceClose()`；
  另有 `loadTeamSettings(projectId)`、`saveRoleSettings(projectId, setting)`、
  `loadConversationDrafts()`、`saveConversationDraft(draft)`、`discardConversationDraft({ projectId, revision })`；
  不暴露 `ipcRenderer` 本体、通用 `on` / `send`、任意文件读写或 shell。
- 主进程只注册十三个 handler 通道（`tla:app-info`、`tla:workspace-load`、`tla:workspace-save`、
  `tla:recovery-load`、`tla:recovery-save`、`tla:recovery-discard`、`tla:team-load`、`tla:team-save-role`、
  `tla:conversation-load`、`tla:conversation-save`、`tla:conversation-discard`、`tla:close-confirm`、`tla:close-force`），
  主→渲染事件只有关闭请求 `tla:close-request` 与超时提示 `tla:close-timeout`。每个 handler 都先用
  `electron/security.mjs` 校验：
  调用方必须是主窗口的 `webContents`、主 frame，且页面地址与应用页面（或开发服务器地址）完全相等。
- 工作区、恢复稿与未发送文字的写入固定在主进程解析出的路径，渲染层只能提交符合契约的数据；路径、版本、字段、
  数量、长度、文件大小与快照 revision 全部由主进程复验，非法输入被拒绝而不是截断。
- 拒绝所有新窗口（不调用 `shell.openExternal`，不交给系统浏览器）、外部导航与 `<webview>` 挂载；
  拒绝所有权限申请（摄像头、麦克风、通知等）。
- 渲染层带 CSP：`default-src 'self'`，脚本仅允许同源文件。

## 按项目手动角色设置

先保存项目信息，再点AI角色的“编辑角色设置”，可修改名称、定位、职责摘要和详细职责，
以及计划供应商/模型标签。标签同时留空表示未指定，填一项会报错；所有模型仍是**未连接**，
没有API Key、接口地址、连接测试、账号扫描或任何模型请求。人类总控制不可改成AI，六个稳定角色位不增删排序。
输入/输出/边界仍是初始模板参考，不产生执行权限。

- 文件固定为 `<workspace>\.local\tla-desktop\team-settings.json`，独立schemaVersion=1，
  不改变workspace.json或recovery.json。每个正式项目最多五个AI角色覆盖条目，缺少的角色复用唯一初始模板；
  缺文件只读默认、不主动建文件。设置按项目隔离，保存仅合并目标角色，其他角色/项目保留。
- 校验项目确实已正式保存、五个AI roleId白名单、未知字段、重复项与512KiB总上限。
  名称60、定位20、摘要500、职责2000、供应商80、模型160字符；不截断。
  坏JSON、未知版本或读取失败不覆盖原文件；项目草稿仍可使用。
- 同目录唯一临时文件写入、fsync后rename，不先删旧文件；请求串行。加载和保存结果绑定项目/角色身份，
  角色保存时不允许重复提交或修改表单，失败保留文字并可重试。
- 角色表单不自动进入项目恢复稿。未保存编辑时先保存或取消，才能切换项目/角色。
  正常关闭遇到角色脏编辑或保存中，会立即中止本次关闭并显示准确提示；返回保留表单，
  只有明确点“仍然关闭”才放弃。角色处理完成后继续沿用原项目草稿关闭刷新。
- 被未保存编辑拦住关闭或切换时，右侧提示会用一次短暂填充色脉冲提醒（不持续闪烁，尊重
  `prefers-reduced-motion`），并在提示内直接给出“保存角色设置 / 取消编辑”。保存中两个按钮禁用；
  保存失败在提示区显示错误，表单保留可重试。快捷操作只对当前正在编辑的角色出现，
  人类角色或没有对应编辑器时不显示按钮，也不会自动切换回先前点击的角色。
- 主进程复用 `src/data/team.js` 和纯数据契约 `src/lib/team-settings.js`，打包白名单仅补这两个模块，
  不包含整个src或新增运行时依赖。本批未重新打包，实际桌面交互仍需用户验收。

本批自动测试166例通过（上一批140 + 未发送文字存储14 + 协调器9 + 端到端3），其中Electron使用替身，
不将此结果称为真实窗口验收。字体资源、构建产物和许可证已完成字节级校验；字体在窗口中的实际加载、
暖黑主题的视觉还原、项目设置页与对话输入是否仍与页脚重叠、三档窗口宽度、动态侧栏/浮窗与关闭提示的键盘行为
仍需用户从正常桌面入口确认，在取得真实窗口截图前不记为视觉验收通过。

## 首批不做的事

聊天、智能分工、API 接入、自动替补、余额/用量展示、真实仓库读取、登录与审批流均未实现；
项目管理也只做了本机新建、改名、切换与草稿保存——不删除已保存项目（只能取消从未落盘的新建项目）、
不导入导出、不添加/删除/排序角色。角色职责和计划模型可手动记录，但没有真实连接、模型调用或云端同步；正式项目保存仍为手动，恢复稿另外自动备份。
界面上不出现任何伪造的回复、余额或“运行中”状态。

角色详情关闭被未保存编辑阻止时，提示直接显示在右侧详情顶部并随滚动保持可见；保存或取消编辑后即可关闭详情。
