// IPC 边界测试：用 electron 替身加载真实的 main.mjs，只验证“谁能调用、注册了哪些通道”。
// 不启动 Chromium，也不向真实工作区文件写入；存储行为由 workspace-store.test.mjs 覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC_CHANNELS, IPC_CHANNEL_LIST } from '../electron/ipc-channels.mjs'
import { configure, getState, getIpcHandler, listIpcChannels } from './fixtures/electron-stub.mjs'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_ENTRY = path.join(here, '..', 'renderer-dist', 'index.html')
const APP_URL = pathToFileURL(RENDERER_ENTRY).href
const MAIN_URL = new URL('../electron/main.mjs', import.meta.url)
const CHANNELS = Object.freeze([...IPC_CHANNEL_LIST])

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForLog(logFile, marker, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes(marker)) return
    await delay(20)
  }
  assert.fail(`等待日志标记超时：${marker}`)
}

function closeAllWindows() {
  for (const win of getState().windows) {
    if (!win.destroyed) win.close()
  }
}

function trustedEvent(win, { url = APP_URL, parent = null } = {}) {
  return { senderFrame: { url, parent }, sender: win.webContents }
}

test('主进程只注册三个通道，且拒绝不受信任的调用方', async () => {
  const appDataDirectory = await makeTempDir()
  const logsDirectory = path.join(appDataDirectory, 'TLA', 'logs')
  const state = getState()
  state.windows.length = 0
  configure({
    appDataDirectory,
    logsDirectory,
    lockAcquired: true,
    loadFails: false,
    emitReadyToShow: true,
    emitLoadEvents: true,
    whenReadyFails: false,
  })

  const moduleUrl = new URL(MAIN_URL)
  moduleUrl.search = '?case=workspace-ipc'
  await import(moduleUrl.href)

  const logFile = path.join(logsDirectory, 'main.log')
  await waitForLog(logFile, 'step=window-created')

  try {
    assert.deepEqual(new Set(listIpcChannels()), new Set(CHANNELS))

    const win = getState().windows[0]
    assert.ok(win, '应已创建主窗口')

    const load = getIpcHandler(IPC_CHANNELS.WORKSPACE_LOAD)
    const save = getIpcHandler(IPC_CHANNELS.WORKSPACE_SAVE)
    const info = getIpcHandler(IPC_CHANNELS.APP_INFO)
    assert.equal(typeof load, 'function')
    assert.equal(typeof save, 'function')

    const untrustedCases = [
      ['没有 frame', { senderFrame: null, sender: win.webContents }],
      ['子 frame', { senderFrame: { url: APP_URL, parent: {} }, sender: win.webContents }],
      ['其他 sender', { senderFrame: { url: APP_URL, parent: null }, sender: {} }],
      [
        '非应用页面',
        { senderFrame: { url: 'https://example.com/', parent: null }, sender: win.webContents },
      ],
    ]

    for (const [label, event] of untrustedCases) {
      for (const [name, handler, args] of [
        ['APP_INFO', info, undefined],
        ['WORKSPACE_LOAD', load, undefined],
        ['WORKSPACE_SAVE', save, { schemaVersion: 1, activeProjectId: 'a', projects: [] }],
      ]) {
        await assert.rejects(
          async () => handler(event, args),
          /untrusted renderer/,
          `${label} 调用 ${name} 应被拒绝`,
        )
      }
    }

    // 受信任的主 frame 可以拿到版本信息；该通道不触碰文件系统。
    const appInfo = await info(trustedEvent(win))
    assert.equal(appInfo.productVersion, '0.3.0')
    assert.equal(appInfo.productName, 'TLA 多智能体工作台')

    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /step=ipc-rejected channel=tla:workspace-save/)
  } finally {
    closeAllWindows()
    await removeTempDir(appDataDirectory)
  }
})
