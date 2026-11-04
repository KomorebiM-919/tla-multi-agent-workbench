// 测试用 electron 模块替身：让主进程的启动/单实例/窗口流程能在纯 Node 里跑一遍，
// 不需要真的启动 Chromium。只实现 electron/main.mjs 实际用到的 API。
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

const state = {
  lockAcquired: true,
  loadFails: false,
  emitReadyToShow: true,
  emitLoadEvents: true,
  whenReadyFails: false,
  appDataDirectory: '',
  logsDirectory: '',
  windows: [],
}

export function configure(options) {
  Object.assign(state, options)
}

export function getState() {
  return state
}

class FakeWebContents extends EventEmitter {
  constructor(window, preload) {
    super()
    this.window = window
    this.preload = preload
    this.url = ''
  }

  getURL() {
    return this.url
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler
    return () => {}
  }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super()
    this.id = state.windows.length + 1
    this.options = options
    this.visible = false
    this.destroyed = false
    this.minimized = false
    this.webContents = new FakeWebContents(this, options.webPreferences?.preload)
    state.windows.push(this)
  }

  static getAllWindows() {
    return state.windows.filter((win) => !win.destroyed)
  }

  static fromWebContents(contents) {
    return contents?.window ?? null
  }

  isDestroyed() {
    return this.destroyed
  }

  isVisible() {
    return this.visible
  }

  isMinimized() {
    return this.minimized
  }

  restore() {
    this.minimized = false
  }

  show() {
    this.visible = true
  }

  focus() {}

  close() {
    this.destroyed = true
    this.emit('closed')
  }

  async loadURL(url) {
    this.webContents.url = url
    this.#emitLoadedEvents()
  }

  async loadFile(filePath) {
    if (state.loadFails) {
      throw Object.assign(new Error('ERR_FILE_NOT_FOUND'), { code: 'ERR_FILE_NOT_FOUND' })
    }
    this.webContents.url = pathToFileURL(filePath).href
    this.#emitLoadedEvents()
  }

  #emitLoadedEvents() {
    if (!state.emitLoadEvents) return
    setTimeout(() => {
      if (this.destroyed) return
      if (state.emitReadyToShow) {
        this.emit('ready-to-show')
      }
      this.webContents.emit('did-finish-load')
    }, 0)
  }
}

const app = new EventEmitter()
Object.assign(app, {
  isPackaged: true,
  getVersion: () => '0.3.0',
  getPath: (name) => (name === 'appData' ? state.appDataDirectory : state.logsDirectory),
  requestSingleInstanceLock: () => state.lockAcquired,
  whenReady: () =>
    state.whenReadyFails ? Promise.reject(new Error('whenReady-failed')) : Promise.resolve(),
  setAppUserModelId: () => {},
  enableSandbox: () => {},
  quit: () => {},
})

const menu = { setApplicationMenu: () => {} }
const ipcMain = { handle: () => {} }
const session = {
  defaultSession: {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  },
}

export { app, ipcMain, session }
export const BrowserWindow = FakeBrowserWindow
export const Menu = menu
