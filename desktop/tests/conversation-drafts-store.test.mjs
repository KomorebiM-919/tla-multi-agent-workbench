import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  CONVERSATION_ERROR_CODES,
  CONVERSATION_SCHEMA_VERSION,
  MAX_CONVERSATION_FILE_BYTES,
  MAX_CONVERSATION_TEXT_LENGTH,
  createConversationStore,
  parseConversationText,
  resolveConversationFilePath,
} from '../electron/conversation-drafts-store.mjs'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

const FILE_NAME = 'conversation-drafts.json'

async function withStore(run) {
  const dir = await makeTempDir()
  const filePath = path.join(dir, FILE_NAME)
  try {
    await run({ dir, filePath, store: createConversationStore({ filePath }) })
  } finally {
    await removeTempDir(dir)
  }
}

async function readBytes(filePath) {
  return readFile(filePath)
}

test('文件不存在时返回空列表，不主动创建文件', async () => {
  await withStore(async ({ filePath, store }) => {
    const loaded = await store.load()
    assert.deepEqual(loaded.drafts, [])
    assert.equal(loaded.source, 'empty')
    assert.equal(loaded.savedAt, null)
    await assert.rejects(readBytes(filePath), /ENOENT/)
  })
})

test('保存后重读保留中文、换行与制表符，并且只保留最新一份', async () => {
  await withStore(async ({ filePath, store }) => {
    const text = '第一行\n第二行\t带制表符\n结尾'
    await store.save({ projectId: 'project-a', text, revision: 1 })
    await store.save({ projectId: 'project-a', text: `${text}\n更晚的版本`, revision: 2 })
    const loaded = await store.load()
    assert.equal(loaded.source, 'file')
    assert.equal(loaded.drafts.length, 1)
    assert.equal(loaded.drafts[0].projectId, 'project-a')
    assert.equal(loaded.drafts[0].revision, 2)
    assert.equal(loaded.drafts[0].text, `${text}\n更晚的版本`)
    assert.ok(Number.isNaN(Date.parse(loaded.drafts[0].updatedAt)) === false)
  })
})

test('两个项目的未发送文字互不覆盖', async () => {
  await withStore(async ({ store }) => {
    await store.save({ projectId: 'project-a', text: '给 A 的话', revision: 1 })
    await store.save({ projectId: 'project-b', text: '给 B 的话', revision: 1 })
    const loaded = await store.load()
    assert.equal(loaded.drafts.length, 2)
    const byId = new Map(loaded.drafts.map((entry) => [entry.projectId, entry.text]))
    assert.equal(byId.get('project-a'), '给 A 的话')
    assert.equal(byId.get('project-b'), '给 B 的话')
  })
})

test('清空输入以空字符串保存，不会被当成未保存或删除其他项目', async () => {
  await withStore(async ({ store }) => {
    await store.save({ projectId: 'project-a', text: '要清掉的话', revision: 1 })
    await store.save({ projectId: 'project-b', text: '保留的话', revision: 1 })
    await store.save({ projectId: 'project-a', text: '', revision: 2 })
    const loaded = await store.load()
    const a = loaded.drafts.find((entry) => entry.projectId === 'project-a')
    const b = loaded.drafts.find((entry) => entry.projectId === 'project-b')
    assert.equal(a.text, '')
    assert.equal(a.revision, 2)
    assert.equal(b.text, '保留的话')
  })
})

test('过期 revision 被拒绝，磁盘内容不变', async () => {
  await withStore(async ({ filePath, store }) => {
    await store.save({ projectId: 'project-a', text: '最新稿', revision: 5 })
    const before = await readBytes(filePath)
    await assert.rejects(
      store.save({ projectId: 'project-a', text: '迟到旧稿', revision: 4 }),
      (error) => error.code === CONVERSATION_ERROR_CODES.STALE_SNAPSHOT,
    )
    assert.deepEqual(await readBytes(filePath), before)
  })
})

test('放弃后删除条目，同版本迟到写入被拒绝，更高版本可以重新开始', async () => {
  await withStore(async ({ store }) => {
    await store.save({ projectId: 'project-a', text: '旧话', revision: 3 })
    const result = await store.discard({ projectId: 'project-a', revision: 4 })
    assert.equal(result.removed, true)
    assert.equal((await store.load()).drafts.length, 0)
    await assert.rejects(
      store.save({ projectId: 'project-a', text: '迟到', revision: 4 }),
      (error) => error.code === CONVERSATION_ERROR_CODES.DISCARDED,
    )
    await store.save({ projectId: 'project-a', text: '取消后重新写', revision: 5 })
    const loaded = await store.load()
    assert.equal(loaded.drafts[0].text, '取消后重新写')
    assert.equal(loaded.drafts[0].revision, 5)
  })
})

test('放弃不存在的项目不会创建文件', async () => {
  await withStore(async ({ filePath, store }) => {
    const result = await store.discard({ projectId: 'project-a', revision: 1 })
    assert.equal(result.removed, false)
    await assert.rejects(readBytes(filePath), /ENOENT/)
  })
})

test('坏 JSON 报 CORRUPT_FILE，保存被禁止且原字节不变', async () => {
  await withStore(async ({ filePath, store }) => {
    await mkdir(path.dirname(filePath), { recursive: true })
    const broken = '{ 这不是 JSON'
    await writeFile(filePath, broken, 'utf8')
    const before = await readBytes(filePath)
    await assert.rejects(store.load(), (error) => error.code === CONVERSATION_ERROR_CODES.CORRUPT_FILE)
    await assert.rejects(
      store.save({ projectId: 'project-a', text: '新话', revision: 1 }),
      (error) => error.code === CONVERSATION_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
    )
    assert.deepEqual(await readBytes(filePath), before)
  })
})

test('未知版本报 UNSUPPORTED_VERSION 并禁止覆盖', async () => {
  await withStore(async ({ filePath, store }) => {
    const raw = JSON.stringify({ schemaVersion: 99, drafts: [] })
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, raw, 'utf8')
    await assert.rejects(
      store.load(),
      (error) => error.code === CONVERSATION_ERROR_CODES.UNSUPPORTED_VERSION,
    )
    await assert.rejects(
      store.save({ projectId: 'project-a', text: '新话', revision: 1 }),
      (error) => error.code === CONVERSATION_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
    )
    assert.equal(await readFile(filePath, 'utf8'), raw)
  })
})

test('超过文件大小上限报 TOO_LARGE 并保留原文件', async () => {
  await withStore(async ({ filePath, store }) => {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'x'.repeat(MAX_CONVERSATION_FILE_BYTES + 1), 'utf8')
    await assert.rejects(store.load(), (error) => error.code === CONVERSATION_ERROR_CODES.TOO_LARGE)
    await assert.rejects(
      store.save({ projectId: 'project-a', text: '新话', revision: 1 }),
      (error) => error.code === CONVERSATION_ERROR_CODES.BLOCKED_BY_LOAD_ERROR,
    )
  })
})

test('非法输入被拒绝，不写文件也不截断', async () => {
  await withStore(async ({ filePath, store }) => {
    const invalidCases = [
      { projectId: 'Project-A', text: '大写 ID', revision: 1 },
      { projectId: 'project-a', text: 'x'.repeat(MAX_CONVERSATION_TEXT_LENGTH + 1), revision: 1 },
      { projectId: 'project-a', text: '带 \u0000 控制字符', revision: 1 },
      { projectId: 'project-a', text: '未知字段', revision: 1, extra: true },
      { projectId: 'project-a', text: '版本号错误', revision: 0 },
    ]
    for (const input of invalidCases) {
      await assert.rejects(
        store.save(input),
        (error) => error.code === CONVERSATION_ERROR_CODES.INVALID_INPUT,
        JSON.stringify(input).slice(0, 80),
      )
    }
    await assert.rejects(readBytes(filePath), /ENOENT/)
  })
})

test('条目录入受 20 项上限限制，超限整体拒绝且不挤掉旧内容', async () => {
  await withStore(async ({ filePath, store }) => {
    const updatedAt = new Date().toISOString()
    const drafts = Array.from({ length: 20 }, (_, index) => ({
      projectId: `project-${index}`,
      text: `第 ${index} 条`,
      revision: 1,
      updatedAt,
    }))
    const document = { schemaVersion: CONVERSATION_SCHEMA_VERSION, drafts }
    assert.equal((await parseConversationText(JSON.stringify(document))).drafts.length, 20)

    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(document), 'utf8')
    // 已有 20 项时新增第 21 个项目必须整体拒绝，不能挤掉旧内容。
    await assert.rejects(
      store.save({ projectId: 'project-20', text: '第 21 条', revision: 1 }),
      (error) => error.code === CONVERSATION_ERROR_CODES.INVALID_INPUT,
    )
    const after = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(after.drafts.length, 20)

    const extra = {
      ...document,
      drafts: [...drafts, { projectId: 'project-20', text: '第 21 条', revision: 1, updatedAt }],
    }
    assert.throws(() => parseConversationText(JSON.stringify(extra)), /超过 20 个/)
  })
})

test('串行保存后目录中只留下最终文件，临时文件被清理', async () => {
  await withStore(async ({ dir, store }) => {
    const results = await Promise.allSettled([
      store.save({ projectId: 'project-a', text: '并发一', revision: 1 }),
      store.save({ projectId: 'project-a', text: '并发二', revision: 2 }),
      store.save({ projectId: 'project-b', text: '并发三', revision: 1 }),
    ])
    assert.ok(results.some((item) => item.status === 'fulfilled'))
    const entries = (await readFile(path.join(dir, FILE_NAME), 'utf8')).trim()
    assert.ok(entries.length > 0)
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    assert.deepEqual(names, [FILE_NAME])
  })
})

test('工作区路径按源码位置解析为固定文件', () => {
  const desktopRoot = path.join('E:', 'workspace', 'desktop')
  assert.equal(
    resolveConversationFilePath(desktopRoot),
    path.join('E:', 'workspace', '.local', 'tla-desktop', FILE_NAME),
  )
})
