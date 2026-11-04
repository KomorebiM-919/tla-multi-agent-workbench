// 启动诊断日志。
//
// 为什么同步写文件：启动期崩溃往往发生在事件循环还没排到定时器之前，异步写会丢掉
// 最后几行关键记录。这里每条记录都同步 append，宁可慢一点也要保证顺序与持久性。
// 只记录步骤名与有限的结构化字段，不写环境变量、命令行和任何凭据。

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 1024 * 1024
const MAX_VALUE_LENGTH = 300

function formatValue(value) {
  if (value === undefined || value === null) return ''
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  // 单行化：换行与制表符会破坏“一行一条”的日志格式。
  return text.replace(/\s+/g, ' ').slice(0, MAX_VALUE_LENGTH)
}

export function createDiagnostics({
  directory,
  fileName = 'main.log',
  maxBytes = DEFAULT_MAX_BYTES,
  now = () => new Date(),
  pid = process.pid,
} = {}) {
  const file = path.join(directory, fileName)
  let writable = true
  let failureReason = ''

  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    writable = false
    failureReason = formatValue(error)
  }

  function rotateIfNeeded() {
    if (!writable) return
    try {
      const { size } = statSync(file)
      if (size < maxBytes) return
      renameSync(file, `${file}.1`)
    } catch {
      // 文件不存在或轮转失败都不该影响主流程：继续写当前文件即可。
    }
  }

  function record(step, detail = {}) {
    const fields = Object.entries(detail)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .filter((field) => !field.endsWith('='))
    const line = `${now().toISOString()} pid=${pid} step=${step}${fields.length ? ` ${fields.join(' ')}` : ''}`
    if (!writable) return line
    try {
      rotateIfNeeded()
      appendFileSync(file, `${line}\n`, 'utf8')
    } catch (error) {
      writable = false
      failureReason = formatValue(error)
    }
    return line
  }

  return {
    file,
    get writable() {
      return writable
    },
    get failureReason() {
      return failureReason
    },
    record,
  }
}
