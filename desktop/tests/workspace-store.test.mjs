// 工作区文件的读取/校验/原子保存测试：全部使用真实文件，目录放在仓库内的
// desktop/tests/.tmp（普通 UUID 目录），避免系统临时目录的权限差异。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_FILE_BYTES,
  MAX_NAME_LENGTH,
  MAX_PROJECTS,
  MAX_TASK_DRAFT_LENGTH,
  WORKSPACE_ERROR_CODES,
  WorkspaceError,
  createDefaultWorkspace,
  createWorkspaceStore,
  resolveWorkspaceFilePath,
  validateWorkspace,
} from '../electron/workspace-store.mjs'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

function makeWorkspace(overrides = {}) {
  return {
    schemaVersion: 1,
    activeProjectId: 'alpha',
    projects: [
      { id: 'alpha', name: '甲项目', description: '第一行\n第二行', taskDraft: '任务一\n· 子项' },
      { id: 'beta', name: '乙项目', description: '', taskDraft: '任务二' },
    ],
    ...overrides,
  }
}

function makeStore(directory) {
  return createWorkspaceStore({ filePath: path.join(directory, 'workspace.json') })
}

async function readBytes(filePath) {
  return readFile(filePath)
}

async function assertErrorCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WorkspaceError, `应抛出 WorkspaceError，实际：${error}`)
    assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}：${error.message}`)
    return true
  })
}

test('文件不存在时返回默认项目，且不主动创建文件', async () => {
  const directory = await makeTempDir()
  try {
    const store = makeStore(directory)
    const result = await store.load()
    assert.equal(result.source, 'default')
    assert.equal(result.savedAt, null)
    assert.deepEqual(result.workspace, createDefaultWorkspace())
    await assert.rejects(stat(path.join(directory, 'workspace.json')), { code: 'ENOENT' })
  } finally {
    await removeTempDir(directory)
  }
})

test('保存后重读：中文、换行与制表符原样保留', async () => {
  const directory = await makeTempDir()
  try {
    const store = makeStore(directory)
    const workspace = makeWorkspace()
    workspace.projects[0].taskDraft = '第一行\n第二行\t缩进\n“引号”与 emoji 🧪'
    const saved = await store.save(workspace)
    assert.ok(saved.savedAt)

    const onDisk = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'))
    assert.deepEqual(onDisk, workspace)

    const reopened = makeStore(directory)
    const loaded = await reopened.load()
    assert.equal(loaded.source, 'file')
    assert.deepEqual(loaded.workspace, workspace)
    assert.ok(loaded.savedAt)
  } finally {
    await removeTempDir(directory)
  }
})

test('两个项目的草稿互相隔离：保存一个项目不会改动另一个项目', async () => {
  const directory = await makeTempDir()
  try {
    const store = makeStore(directory)
    await store.save(makeWorkspace())

    const second = makeWorkspace({
      activeProjectId: 'beta',
      projects: [
        { id: 'alpha', name: '甲项目', description: '第一行\n第二行', taskDraft: '任务一\n· 子项' },
        { id: 'beta', name: '乙项目（改名）', description: '乙的简介', taskDraft: '任务二改' },
      ],
    })
    await store.save(second)

    const loaded = await makeStore(directory).load()
    assert.deepEqual(loaded.workspace.projects[0], second.projects[0])
    assert.deepEqual(loaded.workspace.projects[1], second.projects[1])
    assert.equal(loaded.workspace.activeProjectId, 'beta')
  } finally {
    await removeTempDir(directory)
  }
})

test('非法输入一律拒绝，且已有文件字节不变', async () => {
  const directory = await makeTempDir()
  const filePath = path.join(directory, 'workspace.json')
  try {
    const store = makeStore(directory)
    await store.save(makeWorkspace())
    const before = await readBytes(filePath)

    const tooMany = {
      ...makeWorkspace(),
      projects: Array.from({ length: MAX_PROJECTS + 1 }, (_, index) => ({
        id: `p-${index}`,
        name: `项目 ${index}`,
        description: '',
        taskDraft: '',
      })),
    }
    tooMany.activeProjectId = 'p-0'

    const cases = [
      ['空名称', { ...makeWorkspace(), projects: [{ ...makeWorkspace().projects[0], name: '   ' }], activeProjectId: 'alpha' }],
      ['未知字段', { ...makeWorkspace(), extra: true }],
      ['重复 ID', { ...makeWorkspace(), projects: [makeWorkspace().projects[0], { ...makeWorkspace().projects[1], id: 'alpha' }] }],
      ['选中项目不存在', { ...makeWorkspace(), activeProjectId: 'gamma' }],
      ['ID 大写', { ...makeWorkspace(), projects: [{ ...makeWorkspace().projects[0], id: 'Alpha' }], activeProjectId: 'Alpha' }],
      [
        '名称超长',
        {
          ...makeWorkspace(),
          projects: [{ ...makeWorkspace().projects[0], name: 'x'.repeat(MAX_NAME_LENGTH + 1) }],
          activeProjectId: 'alpha',
        },
      ],
      [
        '简介超长',
        {
          ...makeWorkspace(),
          projects: [{ ...makeWorkspace().projects[0], description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }],
          activeProjectId: 'alpha',
        },
      ],
      [
        '草稿超长',
        {
          ...makeWorkspace(),
          projects: [{ ...makeWorkspace().projects[0], taskDraft: 'x'.repeat(MAX_TASK_DRAFT_LENGTH + 1) }],
          activeProjectId: 'alpha',
        },
      ],
      ['项目过多', tooMany],
      ['版本不支持', { ...makeWorkspace(), schemaVersion: 2 }],
      ['名称含换行', { ...makeWorkspace(), projects: [{ ...makeWorkspace().projects[0], name: '甲\n乙' }], activeProjectId: 'alpha' }],
    ]

    for (const [label, input] of cases) {
      await assert.rejects(
        store.save(input),
        (error) => {
          assert.ok(error instanceof WorkspaceError, `${label} 应抛出 WorkspaceError`)
          assert.ok(
            [WORKSPACE_ERROR_CODES.INVALID_INPUT, WORKSPACE_ERROR_CODES.UNSUPPORTED_VERSION].includes(
              error.code,
            ),
            `${label} 的错误码不应是 ${error.code}`,
          )
          return true
        },
      )
      assert.deepEqual(await readBytes(filePath), before, `${label} 不应改动磁盘文件`)
    }
  } finally {
    await removeTempDir(directory)
  }
})

test('文件损坏时报错并禁止保存，原文件不被重置', async () => {
  const directory = await makeTempDir()
  const filePath = path.join(directory, 'workspace.json')
  try {
    await writeFile(filePath, '{"schemaVersion":1,"activeProjectId":', 'utf8')
    const before = await readBytes(filePath)

    await assertErrorCode(makeStore(directory).load(), WORKSPACE_ERROR_CODES.CORRUPT_FILE)

    const store = makeStore(directory)
    await assert.rejects(store.load(), WorkspaceError)
    await assertErrorCode(store.save(makeWorkspace()), WORKSPACE_ERROR_CODES.BLOCKED_BY_LOAD_ERROR)
    assert.deepEqual(await readBytes(filePath), before)
  } finally {
    await removeTempDir(directory)
  }
})

test('未知 schemaVersion 同样禁止覆盖', async () => {
  const directory = await makeTempDir()
  const filePath = path.join(directory, 'workspace.json')
  try {
    const future = { ...makeWorkspace(), schemaVersion: 99 }
    await writeFile(filePath, `${JSON.stringify(future, null, 2)}\n`, 'utf8')
    const before = await readBytes(filePath)

    await assertErrorCode(makeStore(directory).load(), WORKSPACE_ERROR_CODES.UNSUPPORTED_VERSION)

    const store = makeStore(directory)
    await assert.rejects(store.load(), WorkspaceError)
    await assertErrorCode(store.save(makeWorkspace()), WORKSPACE_ERROR_CODES.BLOCKED_BY_LOAD_ERROR)
    assert.deepEqual(await readBytes(filePath), before)
  } finally {
    await removeTempDir(directory)
  }
})

test('文件超过大小上限时拒绝读取与保存', async () => {
  const directory = await makeTempDir()
  const filePath = path.join(directory, 'workspace.json')
  try {
    await writeFile(filePath, `${'x'.repeat(MAX_FILE_BYTES + 1)}`, 'utf8')
    const before = await readBytes(filePath)

    await assertErrorCode(makeStore(directory).load(), WORKSPACE_ERROR_CODES.TOO_LARGE)

    const store = makeStore(directory)
    await assert.rejects(store.load(), WorkspaceError)
    await assertErrorCode(store.save(makeWorkspace()), WORKSPACE_ERROR_CODES.BLOCKED_BY_LOAD_ERROR)
    assert.deepEqual(await readBytes(filePath), before)
  } finally {
    await removeTempDir(directory)
  }
})

test('保存请求串行执行，成功或失败都不留下临时文件', async () => {
  const directory = await makeTempDir()
  try {
    const store = makeStore(directory)
    const first = makeWorkspace({ activeProjectId: 'alpha' })
    const second = makeWorkspace({ activeProjectId: 'beta' })

    const results = await Promise.all([store.save(first), store.save(second)])
    assert.equal(results.length, 2)

    const entries = await readdir(directory)
    assert.deepEqual(entries, ['workspace.json'])
    const onDisk = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'))
    assert.ok(
      JSON.stringify(onDisk) === JSON.stringify(first) || JSON.stringify(onDisk) === JSON.stringify(second),
      '最后写入的应是两次保存中的完整一份',
    )

    const invalid = { ...second, activeProjectId: 'missing' }
    const settled = await Promise.allSettled([store.save(invalid), store.save(first)])
    assert.equal(settled[0].status, 'rejected')
    assert.equal(settled[1].status, 'fulfilled')
    assert.deepEqual(await readdir(directory), ['workspace.json'])
    const afterFailure = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'))
    assert.equal(afterFailure.activeProjectId, 'alpha')
  } finally {
    await removeTempDir(directory)
  }
})

test('工作区路径不是普通文件时报读取错误', async () => {
  const directory = await makeTempDir()
  try {
    await mkdir(path.join(directory, 'workspace.json'))
    await assertErrorCode(makeStore(directory).load(), WORKSPACE_ERROR_CODES.READ_FAILED)
  } finally {
    await removeTempDir(directory)
  }
})

test('存储路径固定为源码上级的 .local/tla-desktop/workspace.json', () => {
  const desktopRoot = path.resolve('C:', 'work', 'tla', 'desktop')
  assert.equal(
    resolveWorkspaceFilePath(desktopRoot),
    path.resolve('C:', 'work', 'tla', '.local', 'tla-desktop', 'workspace.json'),
  )
})

test('validateWorkspace 不修改输入对象，也不做静默截断', () => {
  const input = makeWorkspace()
  const snapshot = structuredClone(input)
  validateWorkspace(input)
  assert.deepEqual(input, snapshot)

  const longName = 'x'.repeat(MAX_NAME_LENGTH + 1)
  assert.throws(
    () => validateWorkspace({ ...makeWorkspace(), projects: [{ ...makeWorkspace().projects[0], name: longName }] }),
    (error) => error.code === WORKSPACE_ERROR_CODES.INVALID_INPUT,
  )
})
