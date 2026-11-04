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
    this.sentMessages = []
  }

  getURL() {
    return this.url
  }

  send(channel, payload) {
    this.sentMessages.push({ channel, payload })
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
    // 真实 BrowserWindow 的 close 事件可被 preventDefault 拦下；只有没被拦下才真正销毁。
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    this.emit('close', event)
    if (!event.defaultPrevented) this.destroy()
  }

  destroy() {
    if (this.destroyed) return
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
const ipcHandlers = new Map()
const ipcMain = {
  handle: (channel, handler) => {
    ipcHandlers.set(channel, handler)
  },
}
/** 测试用：取出主进程注册过的 IPC 处理器，直接以伪造事件调用。 */
export function getIpcHandler(channel) {
  return ipcHandlers.get(channel)
}

/** 测试用：主进程实际注册了哪些通道。 */
export function listIpcChannels() {
  return [...ipcHandlers.keys()]
}
const session = {
  defaultSession: {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  },
}

export { app, ipcMain, session }
export const BrowserWindow = FakeBrowserWindow
export const Menu = menu
