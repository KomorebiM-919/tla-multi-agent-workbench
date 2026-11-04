// 渲染层编辑模型的纯函数测试：不涉及 DOM、React 或 Electron。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TASK_DRAFT_LENGTH,
  cloneSession,
  createDraftProject,
  describeProjectStatus,
  dirtyProjectIds,
  isProjectDirty,
  mergeRecoveryEntry,
  needsCancelConfirmation,
  newProjectId,
  projectFieldErrors,
  recoveryEntryToProject,
  removeProjectFromSession,
  toWorkspacePayload,
} from '../src/lib/workspace-editing.js'

function workspace() {
  return {
    schemaVersion: 1,
    activeProjectId: 'alpha',
    projects: [
      { id: 'alpha', name: '甲项目', description: '说明', taskDraft: '草稿\n第二行' },
      { id: 'beta', name: '乙项目', description: '', taskDraft: '' },
    ],
  }
}

test('会话副本是深拷贝，编辑不会回写只读来源', () => {
  const source = workspace()
  const session = cloneSession(source)
  session.projects[0].name = '改过的名字'
  session.projects[0].taskDraft = '改过的草稿'
  assert.equal(source.projects[0].name, '甲项目')
  assert.equal(source.projects[0].taskDraft, '草稿\n第二行')
})

test('提交给主进程的 payload 只含契约字段且版本固定', () => {
  const payload = toWorkspacePayload(
    [{ id: 'alpha', name: '甲', description: '', taskDraft: '', extra: '不应出现' }],
    'alpha',
  )
  assert.deepEqual(payload, {
    schemaVersion: 1,
    activeProjectId: 'alpha',
    projects: [{ id: 'alpha', name: '甲', description: '', taskDraft: '' }],
  })
})

test('新建项目使用唯一且合法的 ID，重名时自动加序号', () => {
  const first = createDraftProject([])
  assert.equal(first.name, '新建项目')
  assert.match(first.id, /^[a-z0-9][a-z0-9-]{0,39}$/)
  assert.equal(first.description, '')
  assert.equal(first.taskDraft, '')

  const second = createDraftProject([{ id: first.id, name: first.name, description: '', taskDraft: '' }])
  assert.equal(second.name, '新建项目 2')
  assert.notEqual(second.id, first.id)

  const third = createDraftProject([
    { id: first.id, name: '新建项目', description: '', taskDraft: '' },
    { id: second.id, name: '新建项目 2', description: '', taskDraft: '' },
  ])
  assert.equal(third.name, '新建项目 3')
})

test('newProjectId 每次调用都不同，且满足主进程的 ID 规则', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newProjectId()))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{0,39}$/)
})

test('dirty 判定按字段比较，未保存过的新项目视为有更改', () => {
  const [alpha, beta] = workspace().projects
  assert.equal(isProjectDirty({ ...alpha }, alpha), false)
  assert.equal(isProjectDirty({ ...alpha, taskDraft: '改了' }, alpha), true)
  assert.equal(isProjectDirty({ ...alpha, description: '改了' }, alpha), true)
  assert.equal(isProjectDirty(beta, undefined), true)

  const session = workspace()
  session.projects[1].taskDraft = '乙的草稿'
  assert.deepEqual(dirtyProjectIds(session, workspace().projects), ['beta'])
})

test('状态优先级：保存中 > 保存失败 > 未保存 > 尚未保存 > 已保存', () => {
  assert.deepEqual(describeProjectStatus({ dirty: true, saveState: { kind: 'saving' } }), {
    tone: 'saving',
    label: '保存中',
  })
  assert.deepEqual(describeProjectStatus({ dirty: true, saveState: { kind: 'failed', message: 'x' } }), {
    tone: 'failed',
    label: '保存失败',
  })
  assert.deepEqual(describeProjectStatus({ dirty: true, saveState: { kind: 'saved' } }), {
    tone: 'dirty',
    label: '未保存',
  })
  assert.deepEqual(describeProjectStatus({ dirty: false, saveState: { kind: 'empty' } }), {
    tone: 'empty',
    label: '尚未保存',
  })
  assert.deepEqual(describeProjectStatus({ dirty: false, saveState: { kind: 'saved' } }), {
    tone: 'saved',
    label: '已保存',
  })
})

test('字段校验与主进程上限一致，超长只报错不截断', () => {
  const project = { id: 'alpha', name: '甲', description: '', taskDraft: '' }
  assert.deepEqual(projectFieldErrors(project), {})

  assert.ok(projectFieldErrors({ ...project, name: '  ' }).name)
  assert.ok(projectFieldErrors({ ...project, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }).name)
  assert.ok(
    projectFieldErrors({ ...project, description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }).description,
  )
  assert.ok(
    projectFieldErrors({ ...project, taskDraft: 'x'.repeat(MAX_TASK_DRAFT_LENGTH + 1) }).taskDraft,
  )

  const tooLong = 'x'.repeat(MAX_NAME_LENGTH + 1)
  const errors = projectFieldErrors({ ...project, name: tooLong })
  assert.match(errors.name, new RegExp(String(MAX_NAME_LENGTH)))
})

test('恢复稿可以插入正式文件里不存在的项目，并成为当前项目', () => {
  const session = workspace()
  const entry = {
    id: 'gamma',
    name: '新建但没保存',
    description: '',
    taskDraft: '恢复出来的正文',
    revision: 3,
    updatedAt: '2026-11-05T00:00:00.000Z',
  }

  const merged = mergeRecoveryEntry(session, entry)
  assert.equal(merged.activeProjectId, 'gamma')
  assert.equal(merged.projects.length, 3)
  assert.deepEqual(merged.projects[2], recoveryEntryToProject(entry))
  assert.deepEqual(merged.projects[2], {
    id: 'gamma',
    name: '新建但没保存',
    description: '',
    taskDraft: '恢复出来的正文',
  })
  assert.equal(entry.revision, 3, '不应把恢复稿元数据写进编辑项目')
  assert.equal(session.projects.length, 2, '原会话不被修改')
  assert.equal(merged.schemaVersion, 1)
})

test('已有项目的恢复稿只覆盖正文，不改变项目顺序与选中项', () => {
  const session = workspace()
  const merged = mergeRecoveryEntry(session, {
    id: 'beta',
    name: '乙项目（恢复）',
    description: '恢复的简介',
    taskDraft: '恢复的草稿',
    revision: 4,
    updatedAt: '2026-11-05T00:00:00.000Z',
  })
  assert.equal(merged.activeProjectId, 'alpha')
  assert.deepEqual(merged.projects.map((item) => item.id), ['alpha', 'beta'])
  assert.deepEqual(merged.projects[1], {
    id: 'beta',
    name: '乙项目（恢复）',
    description: '恢复的简介',
    taskDraft: '恢复的草稿',
  })
  assert.equal(merged.projects[0], session.projects[0])
})

test('取消可以移除最后一个项目：会话进入空态，不自动补充替代项目', () => {
  const only = {
    schemaVersion: 1,
    activeProjectId: 'alpha',
    projects: [workspace().projects[0]],
  }
  const empty = removeProjectFromSession(only, 'alpha')
  assert.deepEqual(empty, { projects: [], activeProjectId: null })

  const session = workspace()
  const remaining = removeProjectFromSession(session, 'beta')
  assert.deepEqual(remaining.projects.map((item) => item.id), ['alpha'])
  assert.equal(remaining.activeProjectId, 'alpha')

  const untouched = removeProjectFromSession(session, 'missing')
  assert.deepEqual(untouched, { projects: session.projects, activeProjectId: 'alpha' })
})

test('取消新建的确认规则：默认空项目直接取消，有内容或改过名才确认', () => {
  const draft = createDraftProject([])
  assert.equal(needsCancelConfirmation(draft), false)
  assert.equal(
    needsCancelConfirmation({ ...draft, taskDraft: '写了几个字' }),
    true,
    '填写过正文必须先确认',
  )
  assert.equal(needsCancelConfirmation({ ...draft, name: '改过的名字' }), true, '改过名必须先确认')
  assert.equal(
    needsCancelConfirmation({ ...draft, name: '' }),
    false,
    '名称中间态被清空但正文也为空时不算有内容',
  )
})
