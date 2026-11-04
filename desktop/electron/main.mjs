import { app, BrowserWindow, Menu, ipcMain, session, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { IPC_CHANNELS } from './ipc-channels.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_ENTRY = path.join(__dirname, '..', 'renderer-dist', 'index.html')
const DEV_SERVER_URL = process.env.TLA_DEV_SERVER_URL ?? ''

const WINDOW_TITLE = 'TLA 多智能体工作台'
const WINDOW_BACKGROUND = '#F7F3EC'

/** 只允许渲染层留在自身页面内；任何外部导航与新窗口一律拒绝。 */
function lockDownContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    // 显式外部链接交给系统浏览器，其余一律拒绝；本批不提供任何外链入口。
    if (url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
    }
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

function registerIpc() {
  ipcMain.handle(IPC_CHANNELS.APP_INFO, (event) => {
    const frameUrl = event.senderFrame?.url ?? ''
    const trusted = DEV_SERVER_URL
      ? frameUrl.startsWith(DEV_SERVER_URL)
      : frameUrl.startsWith('file://')
    if (!trusted) {
      throw new Error('untrusted renderer')
    }
    return {
      productName: 'TLA 多智能体工作台',
      productVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      platform: process.platform,
    }
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

  win.once('ready-to-show', () => {
    win.show()
  })

  if (DEV_SERVER_URL) {
    await win.loadURL(DEV_SERVER_URL)
  } else {
    await win.loadFile(RENDERER_ENTRY)
  }
}

app.enableSandbox()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.tailoredlogic.tla.workbench')
    Menu.setApplicationMenu(null)

    // 本批不申请摄像头、麦克风、通知等任何权限。
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
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

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
