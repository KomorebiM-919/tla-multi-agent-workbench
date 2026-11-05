import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC_CHANNELS, IPC_CHANNEL_LIST, IPC_EVENT_CHANNELS } from '../electron/ipc-channels.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.join(here, '..', 'electron')

test('IPC 白名单只有已审查的通道', () => {
  assert.equal(IPC_CHANNELS.APP_INFO, 'tla:app-info')
  assert.equal(IPC_CHANNELS.WORKSPACE_LOAD, 'tla:workspace-load')
  assert.equal(IPC_CHANNELS.WORKSPACE_SAVE, 'tla:workspace-save')
  assert.equal(IPC_CHANNELS.RECOVERY_LOAD, 'tla:recovery-load')
  assert.equal(IPC_CHANNELS.RECOVERY_SAVE, 'tla:recovery-save')
  assert.equal(IPC_CHANNELS.RECOVERY_DISCARD, 'tla:recovery-discard')
  assert.equal(IPC_CHANNELS.TEAM_LOAD, 'tla:team-load')
  assert.equal(IPC_CHANNELS.TEAM_SAVE_ROLE, 'tla:team-save-role')
  assert.equal(IPC_CHANNELS.CONVERSATION_LOAD, 'tla:conversation-load')
  assert.equal(IPC_CHANNELS.CONVERSATION_SAVE, 'tla:conversation-save')
  assert.equal(IPC_CHANNELS.CONVERSATION_DISCARD, 'tla:conversation-discard')
  assert.equal(IPC_CHANNELS.CLOSE_CONFIRM, 'tla:close-confirm')
  assert.equal(IPC_CHANNELS.CLOSE_FORCE, 'tla:close-force')
  assert.equal(IPC_CHANNELS.CLOSE_REQUEST, 'tla:close-request')
  assert.equal(IPC_CHANNELS.CLOSE_TIMEOUT, 'tla:close-timeout')
  assert.deepEqual(
    [...IPC_CHANNEL_LIST],
    [
      'tla:app-info',
      'tla:workspace-load',
      'tla:workspace-save',
      'tla:recovery-load',
      'tla:recovery-save',
      'tla:recovery-discard',
      'tla:team-load',
      'tla:team-save-role',
      'tla:conversation-load',
      'tla:conversation-save',
      'tla:conversation-discard',
      'tla:close-confirm',
      'tla:close-force',
    ],
  )
  assert.deepEqual([...IPC_EVENT_CHANNELS], ['tla:close-request', 'tla:close-timeout'])
  for (const channel of IPC_EVENT_CHANNELS) {
    assert.equal(IPC_CHANNEL_LIST.includes(channel), false, '主→渲染事件不得注册为 handler 通道')
  }
  assert.ok(Object.isFrozen(IPC_CHANNELS))
  assert.ok(Object.isFrozen(IPC_CHANNEL_LIST))
  assert.ok(Object.isFrozen(IPC_EVENT_CHANNELS))
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

test('预加载脚本只暴露版本信息、工作区与恢复稿读写以及关闭握手', async () => {
  const preload = await readFile(path.join(electronDir, 'preload.cjs'), 'utf8')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('tla'/)
  for (const method of [
    'getAppInfo',
    'loadWorkspace',
    'saveWorkspace',
    'loadRecovery',
    'saveRecovery',
    'discardRecovery',
    'loadTeamSettings',
    'saveRoleSettings',
    'loadConversationDrafts',
    'saveConversationDraft',
    'discardConversationDraft',
    'onCloseRequest',
    'onCloseTimeout',
    'confirmClose',
    'forceClose',
  ]) {
    assert.match(preload, new RegExp(`${method}:`), `预加载应暴露 ${method}`)
  }
  for (const channel of [...IPC_CHANNEL_LIST, ...IPC_EVENT_CHANNELS]) {
    assert.ok(
      preload.includes(`'${channel}'`),
      `预加载脚本的通道字面量必须与 ipc-channels.mjs 一致：${channel}`,
    )
  }
  assert.equal(
    /ipcRenderer\.(send|sendSync)\(/.test(preload),
    false,
    '预加载不应暴露双向或单向发送通道',
  )
  assert.equal(
    (preload.match(/ipcRenderer\.on\(/g) ?? []).length,
    1,
    '只允许一个受控事件订阅入口',
  )
  assert.match(preload, /subscribe\(CLOSE_REQUEST_CHANNEL, callback\)/)
  assert.match(preload, /subscribe\(CLOSE_TIMEOUT_CHANNEL, callback\)/)
  assert.equal(
    /ipcRenderer\.on\((?!channel)/.test(preload),
    false,
    '事件订阅只允许走内部 subscribe(channel)',
  )
  assert.equal(
    /require\(['"](?:node:)?(?:fs|path|child_process)['"]\)/.test(preload),
    false,
    '预加载不得直接访问文件系统',
  )
})

test('工作区路径由主进程按源码位置解析，不接受渲染层传入', async () => {
  const main = await readFile(path.join(electronDir, 'main.mjs'), 'utf8')
  assert.match(main, /const DESKTOP_ROOT = path\.resolve\(__dirname, '\.\.'\)/)
  assert.match(main, /resolveWorkspaceFilePath\(DESKTOP_ROOT\)/)
  assert.equal(main.includes('process.cwd()'), false, '存储路径不得依赖启动时的 cwd')
  assert.match(main, /workspaceStore\.save\(payload\)/, '保存只接收结构化 payload')
  assert.equal(
    /workspaceStore\.save\((?!payload)/.test(main),
    false,
    '不得把渲染层传入的路径交给存储层',
  )
  assert.match(main, /resolveRecoveryFilePath\(DESKTOP_ROOT\)/, '恢复稿路径同样由源码位置解析')
  assert.match(main, /recoveryStore\.save\(snapshot\)/)
  assert.equal(
    /recoveryStore\.save\((?!snapshot)/.test(main),
    false,
    '不得把渲染层传入的路径交给恢复稿存储层',
  )
  assert.match(main, /resolveConversationFilePath\(DESKTOP_ROOT\)/, '未发送文字路径同样由源码位置解析')
  assert.match(main, /conversationStore\.save\(draft\)/)
  assert.equal(
    /conversationStore\.save\((?!draft)/.test(main),
    false,
    '不得把渲染层传入的路径交给未发送文字存储层',
  )
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
