import { useEffect, useState } from 'react'

function formatClock(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 未发送文字的保留状态：措辞只描述本机保留，不说“已发送”或“已保存项目设置”。 */
function conversationLabel(state) {
  if (!state || state.kind === 'idle') return ''
  if (state.kind === 'saving') return '保留中…'
  if (state.kind === 'failed') return `保留失败：${state.message}`
  return state.backedUpAt
    ? `输入已保留在本机 ${formatClock(state.backedUpAt)}`
    : '输入已保留在本机'
}

export default function ChatWorkspace({
  project,
  text,
  limit,
  conversationState,
  onChangeText,
  disabledReason,
  recoveryState,
  candidate,
  onRestore,
  onRestoreConfirm,
  unretained,
  unretainedMessage,
}) {
  const [confirmRestore, setConfirmRestore] = useState(false)
  const tooLong = text.length > limit
  const label = conversationLabel(conversationState)
  const inputDisabled = Boolean(disabledReason)
  const hasCandidate = Boolean(candidate?.text)

  useEffect(() => {
    setConfirmRestore(false)
  }, [candidate?.projectId, candidate?.text])

  function handleRestore() {
    if (hasCandidate && text.length > 0 && !confirmRestore) {
      setConfirmRestore(true)
      return
    }
    setConfirmRestore(false)
    if (confirmRestore) onRestoreConfirm?.()
    else onRestore?.()
  }

  return (
    <section className="chat" aria-labelledby="chat-title">
      <h2 id="chat-title" className="visually-hidden">
        对话
      </h2>

      <div className="chat-stream" role="log" aria-label="对话记录">
        <p className="chat-caption">对话 · 未接入模型</p>
        <p className="chat-empty">
          还没有消息。当前版本不连接模型，也不会生成回复；写下的文字只是本机未发送内容，
          重开时输入框保持空白，需要点“恢复上次未发送内容”才会填回。
        </p>
      </div>

      <div className="composer">
        {hasCandidate && (
          <div className="restore-banner" role="status">
            <p>
              有一条上次未发送的文字（{formatClock(candidate.updatedAt) || '时间未知'}，
              {candidate.text.length} 字），当前输入框不会自动填入。
            </p>
            {confirmRestore ? (
              <div className="restore-actions">
                <p className="restore-warning">
                  恢复会替换输入框里现有的文字；现有内容不会自动保存为新草稿。
                </p>
                <button type="button" className="ghost" onClick={handleRestore}>
                  确认恢复并替换
                </button>
                <button type="button" className="ghost" onClick={() => setConfirmRestore(false)}>
                  保留当前输入
                </button>
              </div>
            ) : (
              <button type="button" className="ghost" onClick={handleRestore}>
                恢复上次未发送内容
              </button>
            )}
          </div>
        )}

        <label className="composer-field">
          <span className="composer-label">给团队的消息</span>
          <textarea
            className={tooLong || unretained ? 'composer-input is-invalid' : 'composer-input'}
            rows={3}
            value={text}
            disabled={inputDisabled}
            aria-invalid={tooLong || unretained ? 'true' : undefined}
            aria-describedby="composer-limit"
            placeholder={
              inputDisabled
                ? '未发送文字文件不可用，本窗口暂不接受新输入'
                : '给团队写一条消息…（当前未接入模型，不能发送）'
            }
            onChange={(event) => onChangeText(event.target.value)}
          />
        </label>
        <span className="field-meta composer-meta" id="composer-limit">
          <span>
            {text.length} / {limit}
          </span>
          {tooLong && (
            <span className="field-error">
              未发送文字不能超过 {limit} 个字符（当前 {text.length} 个）；超出部分没有保留，关闭前需要缩短
            </span>
          )}
        </span>

        <div className="composer-actions">
          <button
            type="button"
            className="ghost"
            disabled
            title="当前版本未接入执行，不能发送；文字只保留在本机。"
          >
            发送（未接入）
          </button>
          {label && (
            <span
              className={
                conversationState?.kind === 'failed'
                  ? 'conversation-status is-failed'
                  : 'conversation-status'
              }
              role="status"
            >
              {label}
            </span>
          )}
          {unretained && (
            <span className="backup-status backup-failed" role="alert">
              {unretainedMessage || '最新输入没有保留'}
            </span>
          )}
          {recoveryState?.kind === 'failed' && (
            <span className="backup-status backup-failed" role="status">
              项目恢复稿备份失败
            </span>
          )}
        </div>

        <p className="composer-note">
          未发送文字只保留在本机 conversation-drafts.json，不是正式项目计划，也不是已发送消息；
          不保证断电或强制退出零丢失。项目名称、简介与计划在左侧“项目设置”里编辑。
        </p>
        {disabledReason && (
          <p className="save-error" role="alert">
            {disabledReason}
          </p>
        )}
        {project && (
          <p className="composer-project">当前项目：{project.name.trim() || '未命名项目'}</p>
        )}
      </div>
    </section>
  )
}
