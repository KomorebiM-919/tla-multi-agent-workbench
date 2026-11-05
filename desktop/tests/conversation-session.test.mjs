import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

import { createConversationStore } from '../electron/conversation-drafts-store.mjs'
import { createRecoveryStore } from '../electron/recovery-store.mjs'
import { createConversationDrafts } from '../src/lib/conversation-drafts.js'
import { createRecoveryDrafts } from '../src/lib/recovery-drafts.js'
import {
  classifyConversationEdit,
  flushBeforeClose,
  indexCandidates,
  initialConversationTexts,
  recordConversationEdit,
  restoreConversationCandidate,
} from '../src/lib/conversation-session.js'
import { makeTempDir, removeTempDir } from './fixtures/temp-dir.mjs'

const DRAFT_A = { id: 'draft-a', name: '草稿 A', description: '', taskDraft: '先做界面' }

function makeIo(dir) {
  const recoveryStore = createRecoveryStore({
    filePath: path.join(dir, 'recovery.json'),
  })
  const conversationStore = createConversationStore({
    filePath: path.join(dir, 'conversation-drafts.json'),
  })
  return { recoveryStore, conversationStore }
}

test('CD-01：重开后输入框保持空白，候选文字只在显式恢复时填入', () => {
  const entries = [
    { projectId: 'draft-a', text: '上次没发出去的话', revision: 2, updatedAt: '2026-11-05T10:00:00.000Z' },
  ]
  const candidates = indexCandidates(entries)
  assert.equal(candidates['draft-a'].text, '上次没发出去的话')

  const texts = initialConversationTexts(entries)
  assert.deepEqual(texts, {}, '启动初始化不能把候选文字塞进输入框')

  const untouched = restoreConversationCandidate({
    currentText: '',
    candidateText: candidates['draft-a'].text,
  })
  assert.equal(untouched.apply, true)
  assert.equal(untouched.text, '上次没发出去的话')

  const withNewInput = restoreConversationCandidate({
    currentText: '我正在写新的内容',
    candidateText: candidates['draft-a'].text,
  })
  assert.equal(withNewInput.needsConfirmation, true, '已有新输入时不能静默覆盖')
  assert.equal(withNewInput.apply, false)

  const confirmed = restoreConversationCandidate({
    currentText: '我正在写新的内容',
    candidateText: candidates['draft-a'].text,
    confirmed: true,
  })
  assert.equal(confirmed.apply, true)
  assert.equal(confirmed.text, '上次没发出去的话')
})

test('CD-02：只写对话的新项目，关闭后仍能恢复项目身份与文字', async () => {
  const dir = await makeTempDir()
  try {
    const { recoveryStore, conversationStore } = makeIo(dir)
    const recovery = createRecoveryDrafts({
      save: async (snapshot) => ({ ok: true, ...(await recoveryStore.save(snapshot)) }),
      discard: async (request) => ({ ok: true, ...(await recoveryStore.discard(request)) }),
    })
    const conversation = createConversationDrafts({
      save: async (draft) => ({ ok: true, ...(await conversationStore.save(draft)) }),
      discard: async (request) => ({ ok: true, ...(await conversationStore.discard(request)) }),
    })

    const result = recordConversationEdit({
      conversation,
      recovery,
      project: DRAFT_A,
      saved: false,
      text: '新项目里还没发出的话',
      limit: 5000,
    })
    assert.equal(result.retained, true)

    const closed = await flushBeforeClose({ recovery, conversation })
    assert.equal(closed.ok, true)

    const recoveryDoc = await recoveryStore.load()
    const conversationDoc = await conversationStore.load()
    assert.equal(recoveryDoc.entries.length, 1, '未保存新项目必须有可恢复的项目身份')
    assert.equal(recoveryDoc.entries[0].id, DRAFT_A.id)
    assert.equal(conversationDoc.drafts.length, 1)
    assert.equal(conversationDoc.drafts[0].text, '新项目里还没发出的话')
  } finally {
    await removeTempDir(dir)
  }
})

test('CD-03：超出上限或读取失败的文字必须让关闭返回失败', async () => {
  const dir = await makeTempDir()
  try {
    const { recoveryStore, conversationStore } = makeIo(dir)
    const recovery = createRecoveryDrafts({
      save: async (snapshot) => ({ ok: true, ...(await recoveryStore.save(snapshot)) }),
      discard: async (request) => ({ ok: true, ...(await recoveryStore.discard(request)) }),
    })
    const conversation = createConversationDrafts({
      save: async (draft) => ({ ok: true, ...(await conversationStore.save(draft)) }),
      discard: async (request) => ({ ok: true, ...(await conversationStore.discard(request)) }),
    })

    const tooLong = classifyConversationEdit({ text: 'x'.repeat(5001), limit: 5000 })
    assert.equal(tooLong.accept, true, '输入仍要可见，不能静默截断')
    assert.equal(tooLong.retain, false, '超限文字不能声称已保留')
    assert.equal(tooLong.reason, 'TOO_LONG')

    const readFailed = classifyConversationEdit({ text: '读取失败后输入', limit: 5000, loadFailed: true })
    assert.equal(readFailed.accept, false, '读取失败时不再接受不受保护的新输入')
    assert.equal(readFailed.reason, 'READ_FAILED')

    const closed = await flushBeforeClose({
      recovery,
      conversation,
      unretained: {
        'draft-a': { text: 'x'.repeat(5001), reason: 'TOO_LONG' },
      },
    })
    assert.equal(closed.ok, false, '无法保留的最新输入不能被关闭当作成功')
    assert.equal(closed.errors[0]?.error?.code, 'CONVERSATION_UNRETAINED')
  } finally {
    await removeTempDir(dir)
  }
})

test('CD-04：关闭等待对话写入期间变脏的恢复稿仍会被最终屏障写入', async () => {
  const dir = await makeTempDir()
  try {
    const { recoveryStore, conversationStore } = makeIo(dir)
    let releaseConversation
    let started
    const conversationStarted = new Promise((resolve) => {
      started = resolve
    })
    const conversationGate = new Promise((resolve) => {
      releaseConversation = resolve
    })

    const recovery = createRecoveryDrafts({
      save: async (snapshot) => ({ ok: true, ...(await recoveryStore.save(snapshot)) }),
      discard: async (request) => ({ ok: true, ...(await recoveryStore.discard(request)) }),
    })
    const conversation = createConversationDrafts({
      save: async (draft) => {
        started()
        await conversationGate
        return { ok: true, ...(await conversationStore.save(draft)) }
      },
      discard: async (request) => ({ ok: true, ...(await conversationStore.discard(request)) }),
    })

    conversation.noteEdit('draft-a', '等待中的文字')
    const closing = flushBeforeClose({ recovery, conversation })
    await conversationStarted

    // 第一类已经 flush 过；此时用户又改了项目计划，必须被最终屏障覆盖。
    recovery.noteEdit(DRAFT_A)
    releaseConversation()

    const result = await closing
    assert.equal(result.ok, true)
    const recoveryDoc = await recoveryStore.load()
    assert.equal(recoveryDoc.entries.length, 1, '等待第二类写入期间产生的恢复稿不能漏写')
    assert.equal(recoveryDoc.entries[0].id, DRAFT_A.id)
  } finally {
    await removeTempDir(dir)
  }
})

