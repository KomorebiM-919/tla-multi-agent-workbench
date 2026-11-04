# TLA Desktop（V0.3 首批桌面壳）

独立桌面子工程，不改变仓库根 `package.json`（V0.2 observer 包）与冻结内核。当前交付“能启动、能看、边界诚实”的桌面壳，
并支持**本机多项目与任务草稿**：项目导航、项目编辑、初始团队模板、角色详情四块内容，**不连接任何模型**。

## 目录

```
desktop/
  electron/
    main.mjs            # 主进程：窗口、权限、导航与 IPC 加固、启动诊断、工作区 IPC
    diagnostics.mjs     # 同步追加的启动日志（%APPDATA%\TLA\logs\main.log）
    security.mjs        # 页面地址与 IPC 调用方的信任判定（纯函数，可单测）
    workspace-store.mjs # 工作区文件的校验、读取与原子保存（不依赖 Electron，可真实文件测试）
    preload.cjs         # 沙箱预加载：只有 tla.getAppInfo / loadWorkspace / saveWorkspace
    ipc-channels.mjs    # 主进程使用的 IPC 白名单（三个通道）
  scripts/
    build-renderer.mjs  # 渲染层构建（含受限沙箱下的 exec 兼容）
    before-build.cjs    # 告知 electron-builder：依赖树由外部处理
  src/
    App.jsx             # 三栏骨架、工作区读取/保存状态机
    lib/workspace-editing.js # 会话副本、dirty 判定、状态与字段校验（纯函数）
    lib/workspace-saver.js   # 保存协调：单请求在途、baseline 同步更新、失败释放
    components/         # 项目导航、项目编辑、团队卡片、角色详情
    data/team.js        # 初始团队模板（唯一数据源）
    styles.css          # 暖白简洁样式
  tests/                # node:test 单元测试（工作区存储、IPC、角色数据、诊断、安全边界、启动流程）
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
npm test                                           # 工作区存储/编辑模型、IPC 边界、角色数据、诊断、安全边界、启动流程
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

## 本地项目与任务草稿

桌面壳支持本机多项目：新建项目、改名称与简介、切换项目，每个项目各有一份任务草稿，并有明确的保存按钮。
这些数据只存在本机工作区文件里，不入库、不联网、不连接模型。

- **位置固定**：`<workspace>\.local\tla-desktop\workspace.json`。路径由 `electron/workspace-store.mjs`
  按源码位置解析（`desktop/` 的上一级），不依赖 cwd，也不接受渲染层传入；`.local/` 已加入 `.gitignore`。
- **结构**：`{ schemaVersion: 1, activeProjectId, projects: [{ id, name, description, taskDraft }] }`。
  最多 20 个项目；名称 60、简介 500、任务草稿 5000 字符；文件上限 512 KiB。ID 只允许小写字母、数字和连字符，
  且必须唯一，`activeProjectId` 必须指向已有项目。
- **校验在写入前**：主进程按上面的规则校验字段、版本、ID 与选中关系；任何越界、未知字段或多余键都直接拒绝，
  返回错误码与原因，**不做静默截断或修补**。渲染层只保存当前项目的新内容，其他项目写回最近一次成功保存的版本，
  因此“保存这个项目”不会顺带提交别的项目的未保存草稿。
- **文件不存在**：返回一个默认项目（`我的第一个项目`），不主动创建文件；用户点保存才落盘。
- **文件损坏、版本不认识或读不出来**：界面显示错误码与原因，本窗口停止保存，原文件原样保留，不会被“重置成默认值”。
- **写入是原子的**：同目录唯一临时文件写完后 `rename` 覆盖，不先删除旧文件；保存请求串行执行，
  失败时保留旧数据并只清理本次临时文件。
- **同一时刻只允许一次保存**：请求在途时，其他项目的保存按钮禁用并提示“另一个项目正在保存”；
  切换项目与继续编辑不受影响。保存结果回来、baseline 同步更新之后才接受下一次保存，
  避免拿过期快照把刚写进去的内容覆盖掉。
- **界面状态**：每个项目标注“未保存 / 保存中 / 已保存（时间）/ 保存失败”，新建项目在首次保存前显示“尚未保存”；
  切换项目时未保存的修改留在本次会话里，重开窗口后回到最近一次成功保存的内容。

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
- 预加载脚本只暴露冻结的 `window.tla.getAppInfo()`、`loadWorkspace()`、`saveWorkspace(workspace)`；
  不暴露 `ipcRenderer`、任意文件读写或 shell。
- 主进程只注册 `tla:app-info`、`tla:workspace-load`、`tla:workspace-save` 三个通道，每个都先用
  `electron/security.mjs` 校验：调用方必须是主窗口的 `webContents`、主 frame，且页面地址与应用页面
  （或开发服务器地址）完全相等。
- 工作区写入固定在主进程解析出的路径，渲染层只能提交符合契约的数据；路径、版本、字段、数量、长度与文件大小
  全部由主进程复验，非法输入被拒绝而不是截断。
- 拒绝所有新窗口（不调用 `shell.openExternal`，不交给系统浏览器）、外部导航与 `<webview>` 挂载；
  拒绝所有权限申请（摄像头、麦克风、通知等）。
- 渲染层带 CSP：`default-src 'self'`，脚本仅允许同源文件。

## 首批不做的事

聊天、智能分工、API 接入、自动替补、余额/用量展示、真实仓库读取、登录与审批流均未实现；
项目管理也只做了本机新建、改名与草稿保存——不删除、不导入导出、不编辑角色、不绑定模型，也没有自动保存或云端同步。
界面上不出现任何伪造的回复、余额或“运行中”状态。
