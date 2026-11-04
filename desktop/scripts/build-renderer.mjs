// 渲染层构建入口。
//
// 为什么不用 `vite build` 直接跑：Vite 在 Windows 上第一次解析路径时会调用
// `exec('net use')` 去建立“网络盘 ↔ 盘符”映射表。受限沙箱不允许创建子进程管道
// （spawn EPERM），这个可选探测会直接把构建打挂。它只影响网络盘路径归一化，
// 不影响本仓库（本地磁盘）的构建结果，因此这里先探测一次：只有 spawn 确实被拒时，
// 才把 exec 换成空实现并让窗口映射表保持为空；正常机器上行为与 `vite build` 一致。
//
// 注意：必须用 CJS 的 require 取到 child_process 并在导入 vite 之前替换 exec，
// 否则 ESM 命名导入会先固化原始函数。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')

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

if (spawnRejectedBySandbox()) {
  childProcess.exec = function execWithoutSpawn(_command, options, callback) {
    const done = typeof options === 'function' ? options : callback
    if (typeof done === 'function') {
      queueMicrotask(() => done(null, '', ''))
    }
    return { on() {}, kill() {} }
  }
  console.warn(
    '[build-renderer] 子进程被沙箱拒绝，已跳过 Vite 的网络盘探测（仅影响网络盘路径归一化）',
  )
}

const { build } = await import('vite')
await build()
