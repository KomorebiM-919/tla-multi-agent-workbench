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

test('主进程只注册白名单内的通道，且拒绝不受信任的调用方', async () => {
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
    const recoveryLoad = getIpcHandler(IPC_CHANNELS.RECOVERY_LOAD)
    const recoverySave = getIpcHandler(IPC_CHANNELS.RECOVERY_SAVE)
    const recoveryDiscard = getIpcHandler(IPC_CHANNELS.RECOVERY_DISCARD)
    const closeConfirm = getIpcHandler(IPC_CHANNELS.CLOSE_CONFIRM)
    const closeForce = getIpcHandler(IPC_CHANNELS.CLOSE_FORCE)
    assert.equal(typeof load, 'function')
    assert.equal(typeof save, 'function')
    for (const handler of [
      recoveryLoad,
      recoverySave,
      recoveryDiscard,
      closeConfirm,
      closeForce,
    ]) {
      assert.equal(typeof handler, 'function')
    }

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
        ['RECOVERY_LOAD', recoveryLoad, undefined],
        [
          'RECOVERY_SAVE',
          recoverySave,
          { id: 'project-a', name: 'A', description: '', taskDraft: '', revision: 1 },
        ],
        ['RECOVERY_DISCARD', recoveryDiscard, { projectId: 'project-a', revision: 2 }],
        ['CLOSE_CONFIRM', closeConfirm, { requestId: 1, ok: true }],
        ['CLOSE_FORCE', closeForce, undefined],
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

    // 关闭握手：第一次 close 被拦下，请渲染层刷新恢复稿；失败可中止，确认后才真正关闭。
    const closeRequests = () =>
      win.webContents.sentMessages.filter(
        (message) => message.channel === IPC_CHANNELS.CLOSE_REQUEST,
      )
    const closeTimeouts = () =>
      win.webContents.sentMessages.filter(
        (message) => message.channel === IPC_CHANNELS.CLOSE_TIMEOUT,
      )

    win.close()
    assert.equal(win.destroyed, false, '握手期间窗口不得直接销毁')
    assert.equal(closeRequests().length, 1, '应发出一次关闭刷新请求')
    const firstRequestId = closeRequests()[0].payload.requestId
    assert.equal(typeof firstRequestId, 'number')

    // 伪造或过期的 requestId 不能关闭窗口，也不能打断仍在进行的请求。
    const stale = await closeConfirm(trustedEvent(win), { requestId: firstRequestId + 99, ok: true })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'STALE_CLOSE_REQUEST')
    assert.equal(win.destroyed, false)

    const aborted = await closeConfirm(trustedEvent(win), {
      requestId: firstRequestId,
      ok: false,
      error: { code: 'RECOVERY_WRITE_FAILED', message: '备份没写完' },
    })
    assert.deepEqual(aborted, { ok: true, aborted: true })
    assert.equal(win.destroyed, false, '刷新失败必须中止关闭，而不是当作完成')

    win.close()
    assert.equal(closeRequests().length, 2, '中止后再次关闭应重新发起刷新请求')
    const secondRequestId = closeRequests()[1].payload.requestId
    assert.notEqual(secondRequestId, firstRequestId, '每次关闭请求都应有独立身份')

    // 超时必须把“没写完”明确通知界面，而不是静默当作成功。
    await delay(2100)
    assert.equal(win.destroyed, false, '超时只退出这一次握手，不关闭窗口')
    assert.equal(closeTimeouts().length, 1, '超时应发出可操作的提示事件')
    assert.equal(closeTimeouts()[0].payload.requestId, secondRequestId)

    // 超时之后才到的确认属于上一轮请求，不得误关后续窗口。
    const late = await closeConfirm(trustedEvent(win), { requestId: secondRequestId, ok: true })
    assert.equal(late.ok, false)
    assert.equal(late.error.code, 'STALE_CLOSE_REQUEST')
    assert.equal(win.destroyed, false)

    win.close()
    assert.equal(closeRequests().length, 3, '超时后再次关闭应能重新请求')
    const thirdRequestId = closeRequests()[2].payload.requestId
    const confirmed = await closeConfirm(trustedEvent(win), {
      requestId: thirdRequestId,
      ok: true,
    })
    assert.equal(confirmed.ok, true)
    assert.equal(win.destroyed, true, '确认写入成功后窗口才关闭')

    const ignored = await closeConfirm(trustedEvent(win), { requestId: thirdRequestId, ok: true })
    assert.equal(ignored.ok, false)
    assert.equal(ignored.error.code, 'STALE_CLOSE_REQUEST')

    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /step=ipc-rejected channel=tla:workspace-save/)
    assert.match(log, /step=close-flushed/)
    assert.match(log, /step=close-flush-failed/)
    assert.match(log, /step=close-flush-timeout/)
    assert.match(log, /step=close-confirm-stale/)
  } finally {
    closeAllWindows()
    await removeTempDir(appDataDirectory)
  }
})
