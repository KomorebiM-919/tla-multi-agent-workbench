// 恢复稿存储的真实文件测试：每个用例只用工作区内的普通 UUID 临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_FILE_BYTES,
  MAX_TASK_DRAFT_LENGTH,
  RECOVERY_ERROR_CODES,
  createRecoveryStore,
  resolveRecoveryFilePath,
} from '../electron/recovery-store.mjs'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

function snapshot(overrides = {}) {
  return {
    id: 'project-a',
    name: '项目 A',
    description: '第一行\n第二行',
    taskDraft: '写草稿\t制表符\n换行',
    revision: 1,
    ...overrides,
  }
}

async function setup(t) {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const filePath = path.join(dir, 'recovery.json')
  const store = createRecoveryStore({ filePath })
  return { dir, filePath, store }
}

test('恢复稿不存在时返回空条目，且不主动创建文件', async (t) => {
  const { dir, store } = await setup(t)
  const result = await store.load()
  assert.deepEqual(result.entries, [])
  assert.equal(result.source, 'empty')
  assert.equal(result.savedAt, null)
  assert.deepEqual(await readdir(dir), [])
})

test('保存后重读保留中文、换行与制表符，每个项目一份', async (t) => {
  const { filePath, store } = await setup(t)
  const saved = await store.save(snapshot())
  assert.equal(saved.entry.revision, 1)
  assert.match(saved.entry.updatedAt, /^\d{4}-\d{2}-\d{2}T/)

  const loaded = await store.load()
  assert.equal(loaded.source, 'file')
  const [entry] = loaded.entries
  assert.equal(entry.name, '项目 A')
  assert.equal(entry.description, '第一行\n第二行')
  assert.equal(entry.taskDraft, '写草稿\t制表符\n换行')

  await store.save(snapshot({ name: '项目 A2', revision: 2 }))
  const again = await store.load()
  assert.equal(again.entries.length, 1, '同一项目只保留最新一份')
  assert.equal(again.entries[0].name, '项目 A2')
  assert.equal(again.entries[0].revision, 2)

  const onDisk = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(onDisk.schemaVersion, 1)
})

test('两个项目互不覆盖', async (t) => {
  const { store } = await setup(t)
  await store.save(snapshot({ id: 'project-a', taskDraft: 'A 的草稿' }))
  await store.save(snapshot({ id: 'project-b', taskDraft: 'B 的草稿' }))
  const loaded = await store.load()
  assert.deepEqual(
    loaded.entries.map((entry) => [entry.id, entry.taskDraft]),
    [
      ['project-a', 'A 的草稿'],
      ['project-b', 'B 的草稿'],
    ],
  )
})

test('版本过期或重复的写入被拒绝，磁盘内容保持不变', async (t) => {
  const { filePath, store } = await setup(t)
  await store.save(snapshot({ revision: 2 }))
  const before = await readFile(filePath)

  await assert.rejects(
    () => store.save(snapshot({ revision: 2, taskDraft: '迟到的旧稿' })),
    (error) => error.code === RECOVERY_ERROR_CODES.STALE_SNAPSHOT,
  )
  await assert.rejects(
    () => store.save(snapshot({ revision: 1, taskDraft: '更旧的稿' })),
    (error) => error.code === RECOVERY_ERROR_CODES.STALE_SNAPSHOT,
  )
  assert.deepEqual(await readFile(filePath), before)
})

test('放弃会删除条目并挡住迟到的同版本写入，更高版本仍可保存', async (t) => {
  const { store } = await setup(t)
  await store.save(snapshot({ revision: 3 }))
  const discarded = await store.discard({ projectId: 'project-a', revision: 4 })
  assert.equal(discarded.removed, true)
  assert.deepEqual((await store.load()).entries, [])

  await assert.rejects(
    () => store.save(snapshot({ revision: 4, taskDraft: '放弃后迟到的备份' })),
    (error) => error.code === RECOVERY_ERROR_CODES.DISCARDED,
  )
  const revived = await store.save(snapshot({ revision: 5, taskDraft: '重新编辑' }))
  assert.equal(revived.entry.revision, 5)

  const missing = await store.discard({ projectId: 'project-b', revision: 1 })
  assert.equal(missing.removed, false)
})

test('损坏的恢复稿原样保留，读取与写入都明确报错', async (t) => {
  const { filePath, store } = await setup(t)
  await writeFile(filePath, '{ 这不是 JSON', 'utf8')
  const before = await readFile(filePath)

  await assert.rejects(
    () => store.load(),
    (error) => error.code === RECOVERY_ERROR_CODES.CORRUPT_FILE,
  )
  await assert.rejects(
    () => store.save(snapshot()),
    (error) => error.code === RECOVERY_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
  )
  assert.deepEqual(await readFile(filePath), before, '损坏文件不得被重置')
})

test('未知版本同样保留原文件并停止写入', async (t) => {
  const { filePath, store } = await setup(t)
  const document = { schemaVersion: 99, projects: [] }
  await writeFile(filePath, JSON.stringify(document), 'utf8')
  const before = await readFile(filePath)

  await assert.rejects(
    () => store.load(),
    (error) => error.code === RECOVERY_ERROR_CODES.UNSUPPORTED_VERSION,
  )
  await assert.rejects(
    () => store.save(snapshot()),
    (error) => error.code === RECOVERY_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
  )
  assert.deepEqual(await readFile(filePath), before)
})

test('超过大小上限的恢复稿不会被读入或覆盖', async (t) => {
  const { filePath, store } = await setup(t)
  await writeFile(filePath, 'x'.repeat(MAX_FILE_BYTES + 1), 'utf8')
  const before = await readFile(filePath)

  await assert.rejects(
    () => store.load(),
    (error) => error.code === RECOVERY_ERROR_CODES.TOO_LARGE,
  )
  await assert.rejects(
    () => store.save(snapshot()),
    (error) => error.code === RECOVERY_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
  )
  assert.deepEqual(await readFile(filePath), before)
})

test('条目数量、内容与结构非法时拒绝，不静默截断', async (t) => {
  const { store } = await setup(t)
  await assert.rejects(
    () => store.save(snapshot({ name: 'x'.repeat(61) })),
    (error) => error.code === RECOVERY_ERROR_CODES.INVALID_INPUT,
  )
  await assert.rejects(
    () => store.save(snapshot({ taskDraft: 'x'.repeat(MAX_TASK_DRAFT_LENGTH + 1) })),
    (error) => error.code === RECOVERY_ERROR_CODES.INVALID_INPUT,
  )
  await assert.rejects(
    () => store.save(snapshot({ extra: true })),
    (error) => error.code === RECOVERY_ERROR_CODES.INVALID_INPUT,
  )
  await assert.rejects(
    () => store.save(snapshot({ id: 'Project-A' })),
    (error) => error.code === RECOVERY_ERROR_CODES.INVALID_INPUT,
  )
  assert.deepEqual((await store.load()).entries, [], '被拒绝的输入不得留下文件')

  const emptyName = await store.save(snapshot({ name: '' }))
  assert.equal(emptyName.entry.name, '', '名称被清空的中间态仍要能备份正文')
})

test('打开时发现重复 ID 或过多条目会整体拒绝', async (t) => {
  const { filePath, store } = await setup(t)
  const entry = (id) => ({
    id,
    name: id,
    description: '',
    taskDraft: '',
    revision: 1,
    updatedAt: new Date().toISOString(),
  })
  await writeFile(
    filePath,
    JSON.stringify({ schemaVersion: 1, projects: [entry('project-a'), entry('project-a')] }),
    'utf8',
  )
  await assert.rejects(
    () => store.load(),
    (error) => error.code === RECOVERY_ERROR_CODES.INVALID_INPUT,
  )

  const many = Array.from({ length: 21 }, (_, index) => entry(`project-${index}`))
  await writeFile(filePath, JSON.stringify({ schemaVersion: 1, projects: many }), 'utf8')
  await assert.rejects(
    () => store.load(),
    (error) => error.code === RECOVERY_ERROR_CODES.INVALID_INPUT,
  )
})

test('写入使用同目录临时文件后 rename，成功后不留临时文件', async (t) => {
  const { dir, store } = await setup(t)
  await store.save(snapshot({ revision: 1 }))
  await store.save(snapshot({ revision: 2 }))
  await store.discard({ projectId: 'project-a', revision: 3 })
  assert.deepEqual(await readdir(dir), ['recovery.json'])
})

test('恢复稿路径按源码位置固定解析', () => {
  const desktopRoot = path.resolve('C:/example/repo/desktop')
  assert.equal(
    resolveRecoveryFilePath(desktopRoot),
    path.resolve('C:/example/repo/.local/tla-desktop/recovery.json'),
  )
})
