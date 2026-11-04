# TLA Desktop（V0.3 首批桌面壳）

独立桌面子工程，不改变仓库根 `package.json`（V0.2 observer 包）与冻结内核。首批只交付“能启动、能看、边界诚实”的桌面壳：
项目导航、初始团队模板、角色详情三块内容，**不连接任何模型**。

## 目录

```
desktop/
  electron/
    main.mjs            # 主进程：窗口、权限、导航与 IPC 加固
    preload.cjs         # 沙箱预加载：只暴露 tla.getAppInfo()
    ipc-channels.mjs    # 主进程使用的 IPC 白名单
  src/
    App.jsx             # 三栏骨架与选中状态
    components/         # 项目导航、团队卡片、角色详情
    data/team.js        # 初始团队模板（唯一数据源）
    data/projects.js    # 项目导航条目
    styles.css          # 暖白简洁样式
  tests/                # node:test 单元测试（角色数据、IPC 白名单、窗口加固）
  index.html
  vite.config.mjs
  package.json          # 精确版本依赖 + electron-builder 配置
```

## 常用命令

在本目录执行（需要 Node 24；本机便携包见工作区 `.tools/`）：

```powershell
npm install --no-audit --no-fund      # 依赖版本已在 package.json 锁定，lockfile 一并提交
npm run build:renderer                # 渲染层构建到 renderer-dist/
npm test                              # 角色数据与 IPC 白名单测试
npm start                             # 用本机 electron 启动（需先 build:renderer）
npm run pack:dir                      # 构建 + Windows dir 便携打包到 release/
```

渲染层开发时可单独跑 `npx vite`，再用 `TLA_DEV_SERVER_URL=http://localhost:5173` 启动主进程加载开发服务器。

如果本机 `%LOCALAPPDATA%` 不可写（例如受限沙箱），把缓存指到工作区内再安装：

```powershell
$env:npm_config_cache='<workspace>\.tools\npm-cache'
# @electron/get 通过 env-paths 读 LOCALAPPDATA，不认 ELECTRON_CACHE；
# electron-builder 的下载缓存也落在同一目录下。
$env:LOCALAPPDATA='<workspace>\.tools\localappdata'
```

打包时 electron-builder 会调用 `npm ls` 收集依赖树，在受限沙箱里会 spawn 失败。
本工程没有运行时依赖（渲染层已打进 `renderer-dist/`），因此用 `scripts/before-build.cjs`
返回 `false` 声明“node_modules 由外部处理”，从而跳过这次收集。
**以后若加入运行时依赖，必须删掉 `build.beforeBuild` 这个钩子**，否则依赖不会被打进包里。

## 启动与验证

```powershell
# 先清掉可能继承的 ELECTRON_RUN_AS_NODE，否则 exe 会按 Node 运行、不开窗
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\release\win-unpacked\TLA.exe
```

在 DSH 受限会话里，Chromium 建不起 mojo 通道（`Check failed: 拒绝访问 (0x5)`），进程在开窗前退出；
这是会话级限制，普通桌面会话双击 `TLA.exe` 不受影响。详见 [`../docs/v0.3-desktop-first-batch.md`](../docs/v0.3-desktop-first-batch.md) §4。

## 安全边界

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`。
- 预加载脚本只暴露冻结的 `window.tla.getAppInfo()`，渲染层拿不到 `ipcRenderer`。
- 主进程只注册 `tla:app-info` 一个通道，并在返回前校验调用方 frame 的 URL 前缀。
- 拒绝所有新窗口、外部导航与 `<webview>` 挂载；拒绝所有权限申请（摄像头、麦克风、通知等）。
- 渲染层带 CSP：`default-src 'self'`，脚本仅允许同源文件。

## 首批不做的事

聊天、智能分工、API 接入、自动替补、余额/用量展示、真实仓库读取、登录与审批流均未实现。
界面上不出现任何伪造的回复、余额或“运行中”状态。
