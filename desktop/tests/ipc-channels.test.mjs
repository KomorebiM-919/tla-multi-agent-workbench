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
