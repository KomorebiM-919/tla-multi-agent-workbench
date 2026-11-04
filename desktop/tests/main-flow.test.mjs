// 用 electron 测试替身驱动真实的 electron/main.mjs，验证启动诊断、单实例锁、
// 窗口显示兜底与加载失败可见化这四条链路；不启动 Chromium。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { configure, getState } from './fixtures/electron-stub.mjs'

const MAIN_URL = new URL('../electron/main.mjs', import.meta.url)

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForLog(logFile, marker, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes(marker)) return
    await delay(20)
  }
  const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '<no log file>'
  assert.fail(`等待日志标记超时：${marker}\n实际日志：\n${text}`)
}

async function startMain(caseId, options) {
  const appDataDirectory = mkdtempSync(path.join(tmpdir(), 'tla-main-flow-'))
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
    ...options,
  })

  const moduleUrl = new URL(MAIN_URL)
  moduleUrl.search = `?case=${caseId}`
  await import(moduleUrl.href)

  const logFile = path.join(logsDirectory, 'main.log')
  await waitForLog(logFile, options.until, options.timeoutMs ?? 2000)
  return { logsDirectory, logFile, windows: state.windows }
}

function readLog(logFile) {
  return readFileSync(logFile, 'utf8')
}

function closeAllWindows() {
  for (const win of getState().windows) {
    if (!win.destroyed) win.close()
  }
}

test('正常启动：bootstrap → 单实例锁 → ready → 建窗 → 加载 → 显示', async () => {
  const { logsDirectory, logFile, windows } = await startMain('normal', { until: 'window-shown' })
  try {
    const log = readLog(logFile)
    const steps = ['bootstrap', 'single-instance-lock', 'app-ready', 'window-created', 'page-loaded', 'window-shown', 'did-finish-load']
    let cursor = -1
    for (const step of steps) {
      const at = log.indexOf(`step=${step}`)
      assert.ok(at > cursor, `启动步骤缺失或顺序错误：${step}\n${log}`)
      cursor = at
    }
    assert.match(log, /step=single-instance-lock acquired=true/)
    assert.match(log, /step=window-shown reason=ready-to-show/)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].visible, true)
    assert.equal(windows[0].options.webPreferences.nodeIntegration, false)
    assert.equal(windows[0].options.webPreferences.sandbox, true)
  } finally {
    closeAllWindows()
    rmSync(logsDirectory, { recursive: true, force: true })
  }
})

test('没有拿到单实例锁时不建窗口，并留下可对照的日志', async () => {
  const { logsDirectory, logFile, windows } = await startMain('lock-denied', {
    lockAcquired: false,
    until: 'quit-secondary-instance',
  })
  try {
    const log = readLog(logFile)
    assert.match(log, /step=single-instance-lock acquired=false/)
    assert.equal(log.includes('step=window-created'), false)
    assert.equal(windows.length, 0)
  } finally {
    closeAllWindows()
    rmSync(logsDirectory, { recursive: true, force: true })
  }
})

test('页面加载失败时显示错误页，而不是静默退出', async () => {
  const { logsDirectory, logFile, windows } = await startMain('load-fails', {
    loadFails: true,
    until: 'window-shown',
  })
  try {
    const log = readLog(logFile)
    assert.match(log, /step=page-load-threw message=ERR_FILE_NOT_FOUND/)
    assert.match(log, /step=startup-failure message=页面加载失败/)
    assert.match(log, /step=window-shown reason=startup-failure/)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].visible, true)
    assert.ok(windows[0].webContents.getURL().startsWith('data:text/html'))
  } finally {
    closeAllWindows()
    rmSync(logsDirectory, { recursive: true, force: true })
  }
})

test('渲染器没有任何事件时，兜底计时器也要让窗口出现', async () => {
  const { logsDirectory, logFile, windows } = await startMain('no-events', {
    emitReadyToShow: false,
    emitLoadEvents: false,
    until: 'window-shown',
    timeoutMs: 6000,
  })
  try {
    const log = readLog(logFile)
    assert.match(log, /step=window-shown reason=fallback-timeout/)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].visible, true)
  } finally {
    closeAllWindows()
    rmSync(logsDirectory, { recursive: true, force: true })
  }
})

test('app ready 阶段失败时补建窗口并显示错误页', async () => {
  const { logsDirectory, logFile, windows } = await startMain('when-ready-fails', {
    whenReadyFails: true,
    until: 'window-shown',
  })
  try {
    const log = readLog(logFile)
    assert.match(log, /step=when-ready-failed message=whenReady-failed/)
    assert.match(log, /step=startup-failure message=应用初始化失败/)
    assert.match(log, /step=startup-failure-window-created/)
    assert.match(log, /step=window-shown reason=startup-failure/)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].visible, true)
    assert.ok(windows[0].webContents.getURL().startsWith('data:text/html'))
  } finally {
    closeAllWindows()
    rmSync(logsDirectory, { recursive: true, force: true })
  }
})

test('首选日志目录不可写时退回临时目录并说明原因', async () => {
  // 把 appData 指向一个普通文件，让首选目录无法创建。
  const blockedRoot = mkdtempSync(path.join(tmpdir(), 'tla-blocked-'))
  const blockedFile = path.join(blockedRoot, 'not-a-directory')
  writeFileSync(blockedFile, 'x', 'utf8')
  const fallbackDirectory = path.join(tmpdir(), 'TLA', 'logs')
  const state = getState()
  state.windows.length = 0
  configure({
    appDataDirectory: blockedFile,
    logsDirectory: '',
    lockAcquired: true,
    loadFails: false,
    emitReadyToShow: true,
    emitLoadEvents: true,
  })

  const moduleUrl = new URL(MAIN_URL)
  moduleUrl.search = '?case=log-fallback'
  await import(moduleUrl.href)

  const fallbackLog = path.join(fallbackDirectory, 'main.log')
  await waitForLog(fallbackLog, 'step=bootstrap')
  try {
    const log = readLog(fallbackLog)
    assert.match(log, /step=logs-fallback/)
    assert.match(log, /step=bootstrap/)
  } finally {
    closeAllWindows()
    rmSync(fallbackDirectory, { recursive: true, force: true })
    rmSync(blockedRoot, { recursive: true, force: true })
  }
})
