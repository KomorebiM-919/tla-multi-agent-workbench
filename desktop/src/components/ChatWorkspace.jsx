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
}) {
  const tooLong = text.length > limit
  const label = conversationLabel(conversationState)

  return (
    <section className="chat" aria-labelledby="chat-title">
      <h2 id="chat-title" className="visually-hidden">
        对话
      </h2>

      <div className="chat-stream" role="log" aria-label="对话记录">
        <p className="chat-caption">对话 · 未接入模型</p>
        <p className="chat-empty">
          还没有消息。当前版本不连接模型，也不会生成回复；写下的文字只是本机未发送内容，
          重开后会回到输入框，不会被当成已发送消息。
        </p>
      </div>

      <div className="composer">
        <label className="composer-field">
          <span className="composer-label">给团队的消息</span>
          <textarea
            className={tooLong ? 'composer-input is-invalid' : 'composer-input'}
            rows={3}
            value={text}
            aria-invalid={tooLong ? 'true' : undefined}
            aria-describedby="composer-limit"
            placeholder="给团队写一条消息…（当前未接入模型，不能发送）"
            onChange={(event) => onChangeText(event.target.value)}
          />
        </label>
        <span className="field-meta composer-meta" id="composer-limit">
          <span>
            {text.length} / {limit}
          </span>
          {tooLong && (
            <span className="field-error">
              未发送文字不能超过 {limit} 个字符（当前 {text.length} 个），超出部分不会写入磁盘
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
