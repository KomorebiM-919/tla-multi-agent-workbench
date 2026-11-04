import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC_CHANNELS, IPC_CHANNEL_LIST } from '../electron/ipc-channels.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.join(here, '..', 'electron')

test('IPC 白名单只有已审查的通道', () => {
  assert.equal(IPC_CHANNELS.APP_INFO, 'tla:app-info')
  assert.deepEqual([...IPC_CHANNEL_LIST], ['tla:app-info'])
  assert.ok(Object.isFrozen(IPC_CHANNELS))
  assert.ok(Object.isFrozen(IPC_CHANNEL_LIST))
})

test('主进程只注册白名单内的通道', async () => {
  const main = await readFile(path.join(electronDir, 'main.mjs'), 'utf8')
  const registered = [...main.matchAll(/ipcMain\.handle\(\s*IPC_CHANNELS\.(\w+)/g)].map((m) => m[1])
  assert.ok(registered.length > 0, '主进程应至少注册一个通道')
  for (const name of registered) {
    assert.ok(name in IPC_CHANNELS, `未在 ipc-channels.mjs 中声明的通道：${name}`)
  }
  assert.equal(new Set(registered).size, registered.length, '通道不得重复注册')
})

test('预加载脚本只暴露 getAppInfo 且通道与白名单一致', async () => {
  const preload = await readFile(path.join(electronDir, 'preload.cjs'), 'utf8')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('tla'/)
  assert.match(preload, /getAppInfo/)
  assert.ok(
    preload.includes(`'${IPC_CHANNELS.APP_INFO}'`),
    '预加载脚本的通道字面量必须与 ipc-channels.mjs 一致',
  )
  assert.equal(/ipcRenderer\.(send|sendSync|on)\(/.test(preload), false, '预加载不应暴露双向或事件通道')
})

test('窗口启用隔离与沙箱并禁用 Node 集成', async () => {
  const main = await readFile(path.join(electronDir, 'main.mjs'), 'utf8')
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /webviewTag:\s*false/)
  assert.match(main, /setWindowOpenHandler/)
  assert.match(main, /will-navigate/)
  assert.match(main, /will-attach-webview/)
  assert.match(main, /setPermissionRequestHandler/)
})

test('新窗口一律拒绝，不调用 shell.openExternal', async () => {
  const main = await readFile(path.join(electronDir, 'main.mjs'), 'utf8')
  assert.match(main, /setWindowOpenHandler\(\s*\(\{\s*url\s*\}\)\s*=>/)
  assert.match(main, /return \{ action: 'deny' \}/)
  assert.equal(main.includes('openExternal'), false, '本批没有外链需求，不得打开系统浏览器')
  assert.equal(/\bshell\b/.test(main), false, '主进程不应再引入 shell 模块')
})

test('IPC 来源校验绑定本窗口主 frame 与应用页面', async () => {
  const main = await readFile(path.join(electronDir, 'main.mjs'), 'utf8')
  assert.match(main, /from '\.\/security\.mjs'/)
  assert.match(main, /isTrustedSender\(\{/)
  assert.match(main, /frame: event\.senderFrame/)
  assert.match(main, /sender: event\.sender/)
  assert.match(main, /windowWebContents: mainWindow\?\.webContents/)
})

test('启动诊断在单实例锁之前就写入日志', async () => {
  const main = await readFile(path.join(electronDir, 'main.mjs'), 'utf8')
  const bootstrapAt = main.indexOf("log('bootstrap'")
  const lockAt = main.indexOf('requestSingleInstanceLock')
  assert.ok(bootstrapAt > 0 && lockAt > 0)
  assert.ok(bootstrapAt < lockAt, 'bootstrap 记录必须早于单实例锁判定')
  for (const step of [
    'single-instance-lock',
    'app-ready',
    'window-created',
    'did-finish-load',
    'did-fail-load',
    'render-process-gone',
    'uncaught-exception',
    'unhandled-rejection',
    'quit',
  ]) {
    assert.ok(main.includes(`'${step}'`), `缺少启动诊断步骤：${step}`)
  }
})

test('构建脚本只放行已证实的 net use 探测，其余 exec 如实报错', async () => {
  const script = await readFile(path.join(here, '..', 'scripts', 'build-renderer.mjs'), 'utf8')
  assert.match(script, /VITE_NETWORK_DRIVE_PROBE\s*=\s*\/\^net\\s\+use\$\//i)
  assert.match(script, /isNetworkProbe\s*\?[\s\S]{0,40}networkProbeError\(\)\s*:\s*sandboxDeniedError\(command\)/)
  assert.equal(
    /done\(null,\s*'',\s*''\)/.test(script),
    false,
    '不得用“空输出成功”冒充被拒绝的子进程',
  )
})
