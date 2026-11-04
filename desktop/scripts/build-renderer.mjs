// 渲染层构建入口。
//
// 为什么不用 `vite build` 直接跑：Vite 在 Windows 上第一次解析路径时会调用
// `exec('net use', ...)` 去建立“网络盘 ↔ 盘符”映射表。受限沙箱不允许创建子进程
// 管道（spawn EPERM），这个可选探测会直接把构建打挂。
//
// 处理方式是“只替换已证实的那个探测，其余命令如实报错”：只有 spawn 确实被拒时，
// 才把 exec 换成受限实现——命令恰好是 Vite 的 `net use` 探测时回一个 EPERM 错误
// （Vite 的 `if (error) return` 分支会保持映射表为空，等价于没有网络盘）；
// 其他任何命令都返回 EPERM，而不是伪造成功，避免把无关的执行失败伪装成正常输出。
//
// 注意：必须用 CJS 的 require 取到 child_process 并在导入 vite 之前替换 exec，
// 否则 ESM 命名导入会先固化原始函数。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')

// Vite 打在 vite/dist/node/chunks/node.js 里的网络盘探测（optimizeSafeRealPathSync）。
const VITE_NETWORK_DRIVE_PROBE = /^net\s+use$/i

function spawnRejectedBySandbox() {
  try {
    const probe = childProcess.spawnSync(process.execPath, ['-e', '0'], {
      stdio: 'pipe',
      timeout: 5000,
    })
    return probe.error?.code === 'EPERM'
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sandboxDeniedError(command) {
  const error = new Error(
    `sandbox denied subprocess spawn (EPERM); refusing to run: ${String(command).slice(0, 120)}`,
  )
  error.code = 'EPERM'
  return error
}

function networkProbeError() {
  const error = new Error('sandbox denied subprocess spawn (EPERM); Vite network-drive probe skipped')
  error.code = 'EPERM'
  return error
}

if (spawnRejectedBySandbox()) {
  childProcess.exec = function execWithoutSpawn(command, options, callback) {
    const done = typeof options === 'function' ? options : callback
    const isNetworkProbe =
      typeof command === 'string' && VITE_NETWORK_DRIVE_PROBE.test(command.trim())
    const error = isNetworkProbe ? networkProbeError() : sandboxDeniedError(command)
    if (typeof done === 'function') {
      queueMicrotask(() => done(error, '', ''))
    }
    return { on() {}, kill() {} }
  }
  console.warn(
    '[build-renderer] 子进程被沙箱拒绝：仅 Vite 的 `net use` 探测按失败处理，其余 exec 一律报 EPERM',
  )
}

const { build } = await import('vite')
await build()
