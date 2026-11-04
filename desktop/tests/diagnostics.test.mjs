import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDiagnostics } from '../electron/diagnostics.mjs'

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'tla-diagnostics-'))
}

test('诊断日志写到固定文件名，且每条一行、带时间与步骤', () => {
  const dir = makeTempDir()
  try {
    const diagnostics = createDiagnostics({
      directory: dir,
      now: () => new Date('2026-11-04T07:00:00.000Z'),
      pid: 4242,
    })
    assert.equal(diagnostics.writable, true)
    assert.equal(diagnostics.file, path.join(dir, 'main.log'))

    diagnostics.record('bootstrap', { version: '0.3.0' })
    diagnostics.record('app-ready', {})
    diagnostics.record('did-fail-load', { errorCode: -6, errorDescription: 'ERR_FILE_NOT_FOUND' })

    const lines = readFileSync(diagnostics.file, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 3)
    assert.equal(
      lines[0],
      '2026-11-04T07:00:00.000Z pid=4242 step=bootstrap version=0.3.0',
    )
    assert.equal(lines[1], '2026-11-04T07:00:00.000Z pid=4242 step=app-ready')
    assert.match(lines[2], /step=did-fail-load errorCode=-6 errorDescription=ERR_FILE_NOT_FOUND$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('诊断日志把多行值压成单行，避免破坏一行一条的格式', () => {
  const dir = makeTempDir()
  try {
    const diagnostics = createDiagnostics({ directory: dir, now: () => new Date(0) })
    diagnostics.record('uncaught-exception', {
      message: new Error('boom').message,
      stack: 'Error: boom\n    at one\n    at two',
    })

    const lines = readFileSync(diagnostics.file, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /stack=Error: boom at one at two$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('诊断日志写不进去时不抛错，只标记为不可写', () => {
  const dir = makeTempDir()
  try {
    const blocked = path.join(dir, 'blocked')
    writeFileSync(blocked, 'not a directory', 'utf8')
    const diagnostics = createDiagnostics({ directory: blocked })

    assert.equal(diagnostics.writable, false)
    assert.doesNotThrow(() => diagnostics.record('bootstrap', { version: '0.3.0' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('诊断日志超过上限后轮转成 main.log.1', () => {
  const dir = makeTempDir()
  try {
    const diagnostics = createDiagnostics({ directory: dir, maxBytes: 120, now: () => new Date(0) })
    for (let index = 0; index < 4; index += 1) {
      diagnostics.record('step', { index, padding: 'x'.repeat(20) })
    }
    const rotated = readFileSync(`${diagnostics.file}.1`, 'utf8')
    assert.match(rotated, /step=step index=0/)
    const current = readFileSync(diagnostics.file, 'utf8')
    assert.match(current, /step=step index=3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
