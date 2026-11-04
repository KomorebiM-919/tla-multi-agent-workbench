import { app, BrowserWindow, Menu, ipcMain, session } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { IPC_CHANNELS } from './ipc-channels.mjs'
import { createDiagnostics } from './diagnostics.mjs'
import { isAllowedPage, isTrustedSender } from './security.mjs'
import { createWorkspaceStore, resolveWorkspaceFilePath } from './workspace-store.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(__dirname, '..')
const RENDERER_ENTRY = path.join(__dirname, '..', 'renderer-dist', 'index.html')
// 业务数据固定落在工作区根目录的 .local/ 下；路径按源码位置解析，与启动时的 cwd 无关，
// 也不接受渲染层传路径。文件不存在时只返回默认项目，不主动创建。
const WORKSPACE_FILE = resolveWorkspaceFilePath(DESKTOP_ROOT)
const workspaceStore = createWorkspaceStore({ filePath: WORKSPACE_FILE })
const APP_URL = pathToFileURL(RENDERER_ENTRY).href
const DEV_SERVER_URL = (process.env.TLA_DEV_SERVER_URL ?? '').replace(/\/+$/, '')
const PAGE_URL = DEV_SERVER_URL || APP_URL

const WINDOW_TITLE = 'TLA 多智能体工作台'
const WINDOW_BACKGROUND = '#F7F3EC'
const APP_ID = 'com.tailoredlogic.tla.workbench'
// 窗口默认隐藏以避免白屏闪烁；若 ready-to-show 因渲染器异常始终不来，
// 这个兜底必须让窗口出现，否则用户看到的就是“双击没反应”。
const SHOW_FALLBACK_DELAY_MS = 2500

/**
 * 诊断日志目录：固定为 %APPDATA%\\TLA\\logs，与 app.getName() 无关，方便用户按固定
 * 路径找到日志；appData 取不到或不可写时退到系统临时目录，保证启动失败仍有据可查。
 */
function resolveLogDirectory() {
  try {
    return path.join(app.getPath('appData'), 'TLA', 'logs')
  } catch {
    return path.join(os.tmpdir(), 'tla-desktop-logs')
  }
}

let diagnostics = createDiagnostics({ directory: resolveLogDirectory() })
if (!diagnostics.writable) {
  const preferred = diagnostics
  diagnostics = createDiagnostics({ directory: path.join(os.tmpdir(), 'TLA', 'logs') })
  diagnostics.record('logs-fallback', {
    from: preferred.file,
    error: preferred.failureReason,
    to: diagnostics.file,
  })
}
const log = (step, detail) => diagnostics.record(step, detail)

let mainWindow = null

log('bootstrap', {
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  packaged: app.isPackaged,
  page: PAGE_URL,
  logs: diagnostics.file,
  logsWritable: diagnostics.writable,
  workspaceFile: WORKSPACE_FILE,
})

process.on('uncaughtException', (error) => {
  log('uncaught-exception', { name: error?.name, message: error?.message, stack: error?.stack })
  showStartupFailure('主进程未捕获异常', error)
})

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  log('unhandled-rejection', { name: error.name, message: error.message, stack: error.stack })
  showStartupFailure('主进程存在未处理的 Promise 拒绝', error)
})

app.on('child-process-gone', (_event, details) => {
  log('child-process-gone', { type: details?.type, reason: details?.reason, exitCode: details?.exitCode })
})

app.on('render-process-gone', (_event, contents, details) => {
  log('render-process-gone', { reason: details?.reason, exitCode: details?.exitCode, url: contents?.getURL() })
})

function describeError(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  return String(value)
}

function buildFailurePage({ title, message, detail }) {
  const rows = [
    ['时间', new Date().toISOString()],
    ['应用版本', app.getVersion()],
    ['页面', PAGE_URL],
    ['诊断日志', diagnostics.file],
    ['详细原因', detail],
  ]
    .filter(([, value]) => value)
    .map(
      ([key, value]) =>
        `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 48px; background: #F7F3EC; color: #3B332C;
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 15px; line-height: 1.7;
  }
  main { max-width: 720px; margin: 0 auto; background: #FCFAF6; border: 1px solid #E6DCCB;
    border-radius: 12px; padding: 32px 36px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p.lead { margin: 0 0 24px; color: #7A6A58; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 8px 0; border-top: 1px solid #EFE6D8; }
  th { width: 96px; color: #8A7965; font-weight: 500; }
  td { word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="lead">窗口已打开，但应用内容没能完成启动。请把下面的诊断信息连同日志文件一起反馈。</p>
  <table>${rows}</table>
</main>
</body>
</html>`
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 启动失败时不再静默退出：把窗口显示出来并渲染一页可读的错误说明。 */
async function showStartupFailure(message, error) {
  const detail = error ? describeError(error) : ''
  log('startup-failure', { message, detail })

  // 失败可能发生在窗口创建之前（例如 app ready 阶段抛错），此时必须补一个窗口，
  // 否则用户只会看到“进程没了、什么都没发生”。
  let win = mainWindow
  if (!win || win.isDestroyed()) {
    try {
      win = new BrowserWindow({
        width: 720,
        height: 520,
        title: `${WINDOW_TITLE} · 启动失败`,
        backgroundColor: WINDOW_BACKGROUND,
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
        },
      })
      mainWindow = win
      lockDownContents(win.webContents)
      log('startup-failure-window-created', { id: win.id })
    } catch (windowError) {
      log('startup-failure-no-window', { message, error: windowError?.message })
      return
    }
  }

  try {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildFailurePage({ title: `${WINDOW_TITLE} · 启动失败`, message, detail }),
      )}`,
    )
  } catch (loadError) {
    log('startup-failure-page-error', { message: loadError?.message })
  }
  if (!win.isDestroyed()) {
    log('window-shown', { reason: 'startup-failure' })
    win.show()
    win.focus()
  }
}

/** 只允许渲染层留在自身页面内；任何外部导航与新窗口一律拒绝。 */
function lockDownContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    // 本批没有任何外链需求：新窗口直接拒绝，也不交给系统浏览器。
    log('window-open-denied', { url })
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    if (isAllowedPage(url, { appUrl: APP_URL, devUrl: DEV_SERVER_URL })) return
    log('navigation-blocked', { url })
    event.preventDefault()
  })

  contents.on('will-attach-webview', (event) => {
    log('webview-blocked')
    event.preventDefault()
  })
}

function assertTrustedSender(event, channel) {
  const trusted = isTrustedSender({
    frame: event.senderFrame,
    sender: event.sender,
    windowWebContents: mainWindow?.webContents,
    appUrl: APP_URL,
    devUrl: DEV_SERVER_URL,
  })
  if (!trusted) {
    log('ipc-rejected', { channel, url: event.senderFrame?.url })
    throw new Error('untrusted renderer')
  }
}

function workspaceErrorInfo(error) {
  return {
    code: error?.code ?? 'WORKSPACE_ERROR',
    message: error instanceof Error ? error.message : String(error),
  }
}

function registerIpc() {
  ipcMain.handle(IPC_CHANNELS.APP_INFO, (event) => {
    assertTrustedSender(event, IPC_CHANNELS.APP_INFO)
    return {
      productName: WINDOW_TITLE,
      productVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      platform: process.platform,
    }
  })

  // 读取失败与校验失败都以 { ok: false, error } 返回：错误码要能穿透 IPC 带到界面，
  // 直接 throw 只会剩下一条字符串。
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LOAD, async (event) => {
    assertTrustedSender(event, IPC_CHANNELS.WORKSPACE_LOAD)
    try {
      const { workspace, source, savedAt } = await workspaceStore.load()
      log('workspace-loaded', { source, projects: workspace.projects.length })
      return { ok: true, workspace, source, savedAt }
    } catch (error) {
      const info = workspaceErrorInfo(error)
      log('workspace-load-failed', info)
      return { ok: false, error: info }
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SAVE, async (event, payload) => {
    assertTrustedSender(event, IPC_CHANNELS.WORKSPACE_SAVE)
    try {
      const { workspace, savedAt } = await workspaceStore.save(payload)
      log('workspace-saved', { projects: workspace.projects.length })
      return { ok: true, workspace, savedAt }
    } catch (error) {
      const info = workspaceErrorInfo(error)
      log('workspace-save-failed', info)
      return { ok: false, error: info }
    }
  })
}

function attachWindowDiagnostics(win) {
  let shown = false
  const showWindow = (reason) => {
    if (shown || win.isDestroyed()) return
    shown = true
    log('window-shown', { reason })
    win.show()
  }

  const fallbackTimer = setTimeout(() => showWindow('fallback-timeout'), SHOW_FALLBACK_DELAY_MS)

  win.once('ready-to-show', () => showWindow('ready-to-show'))
  win.once('closed', () => {
    clearTimeout(fallbackTimer)
    log('window-closed')
  })

  win.webContents.on('did-finish-load', () => {
    log('did-finish-load', { url: win.webContents.getURL() })
    // 内容已经加载完成：即使 ready-to-show 没触发也要让窗口可见。
    showWindow('did-finish-load')
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame })
    if (isMainFrame && errorCode !== -3) {
      void showStartupFailure(
        '页面加载失败',
        new Error(`${errorDescription}（code ${errorCode}）：${validatedURL}`),
      )
    }
  })

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('preload-error', { preloadPath, message: error?.message })
    void showStartupFailure('预加载脚本执行失败', error)
  })

  win.webContents.on('console-message', (eventOrLevel, level, message, line, sourceId) => {
    const normalized =
      typeof eventOrLevel === 'object' && eventOrLevel !== null && 'message' in eventOrLevel
        ? {
            level: eventOrLevel.level,
            message: eventOrLevel.message,
            sourceId: eventOrLevel.sourceId,
            line: eventOrLevel.lineNumber,
          }
        : { level, message, sourceId, line }
    log('renderer-console', normalized)
  })
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: WINDOW_TITLE,
    backgroundColor: WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })
  mainWindow = win
  log('window-created', { id: win.id })

  attachWindowDiagnostics(win)

  try {
    if (DEV_SERVER_URL) {
      await win.loadURL(DEV_SERVER_URL)
    } else {
      await win.loadFile(RENDERER_ENTRY)
    }
    log('page-loaded', { url: win.webContents.getURL(), expected: APP_URL })
  } catch (error) {
    log('page-load-threw', { message: error?.message })
    await showStartupFailure('页面加载失败', error)
  }

  return win
}

app.enableSandbox()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
log('single-instance-lock', { acquired: hasSingleInstanceLock })

if (!hasSingleInstanceLock) {
  // 已有实例在跑：不创建窗口，也不静默退出，先留下可对照的日志。
  log('quit-secondary-instance', {})
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    log('second-instance', { windows: BrowserWindow.getAllWindows().length })
    if (win) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

  app.on('before-quit', () => log('before-quit'))
  app.on('quit', (_event, exitCode) => log('quit', { exitCode }))

  app
    .whenReady()
    .then(async () => {
      log('app-ready', {})
      app.setAppUserModelId(APP_ID)
      Menu.setApplicationMenu(null)

      // 本批不申请摄像头、麦克风、通知等任何权限。
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        log('permission-request-denied', { permission })
        callback(false)
      })
      session.defaultSession.setPermissionCheckHandler(() => false)

      app.on('web-contents-created', (_event, contents) => {
        lockDownContents(contents)
      })

      registerIpc()
      await createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createWindow()
        }
      })
    })
    .catch((error) => {
      log('when-ready-failed', { message: error?.message, stack: error?.stack })
      void showStartupFailure('应用初始化失败', error)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
