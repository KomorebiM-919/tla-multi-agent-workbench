import ProjectEditor from './ProjectEditor.jsx'
import { describeProjectStatus } from '../lib/workspace-editing.js'

function formatClock(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function backupLabel(backupState) {
  if (!backupState || backupState.kind === 'idle') return ''
  if (backupState.kind === 'saving') return '恢复稿备份中…'
  if (backupState.kind === 'failed') return `备份失败：${backupState.message}`
  return backupState.backedUpAt ? `恢复稿已备份 ${formatClock(backupState.backedUpAt)}` : '恢复稿已备份'
}

export default function ChatWorkspace({
  project,
  fieldErrors,
  limits,
  dirty,
  saveState,
  backupState,
  blockedByOtherSave,
  canCancel,
  cancelBusy,
  cancelConfirm,
  cancelError,
  onChange,
  onSave,
  onCancel,
  onCancelConfirm,
  onCancelDismiss,
}) {
  const status = describeProjectStatus({ dirty, saveState })
  const saving = saveState?.kind === 'saving'
  const invalid = Object.keys(fieldErrors).length > 0
  const saveDisabled = saving || blockedByOtherSave || cancelBusy || invalid || !dirty
  const statusText =
    status.tone === 'saved' && saveState?.savedAt
      ? `已保存 ${formatClock(saveState.savedAt)}`
      : status.label

  return (
    <section className="chat" aria-labelledby="chat-title">
      <h2 id="chat-title" className="visually-hidden">
        对话
      </h2>

      <div className="chat-stream" role="log" aria-label="对话记录">
        <p className="chat-caption">任务草稿 · 仅保存在本机</p>
        <p className="chat-empty">
          还没有消息。当前版本不连接模型，也不会生成回复；在下方写下这个项目下一步要做什么，
          保存后重开可以继续编辑。
        </p>
      </div>

      <div className="composer">
        <label className="composer-field">
          <span className="visually-hidden">任务草稿</span>
          <textarea
            className={fieldErrors.taskDraft ? 'composer-input is-invalid' : 'composer-input'}
            rows={3}
            value={project.taskDraft}
            aria-invalid={fieldErrors.taskDraft ? 'true' : undefined}
            placeholder="描述这个项目下一步要推进的事，保存为任务草稿…"
            onChange={(event) => onChange('taskDraft', event.target.value)}
          />
        </label>
        <span className="field-meta composer-meta">
          <span>
            {project.taskDraft.length} / {limits.taskDraft}
          </span>
          {fieldErrors.taskDraft && <span className="field-error">{fieldErrors.taskDraft}</span>}
        </span>

        <div className="composer-actions">
          <button
            type="button"
            className="primary"
            onClick={onSave}
            disabled={saveDisabled}
            title={
              blockedByOtherSave
                ? '另一个项目正在保存，完成后再保存这个项目'
                : dirty
                  ? '保存当前项目的名称、简介与任务草稿'
                  : '没有需要保存的更改'
            }
          >
            {saving ? '保存中…' : '保存任务草稿'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled
            title="当前版本未接入执行，不能发送；草稿只保存在本机。"
          >
            发送（未接入）
          </button>
          <span className={`save-status tone-${status.tone}`} role="status">
            {statusText}
          </span>
          {backupLabel(backupState) && (
            <span className={`backup-status backup-${backupState.kind}`} role="status">
              {backupLabel(backupState)}
            </span>
          )}
        </div>

        {blockedByOtherSave && (
          <p className="save-blocked" role="status">
            另一个项目正在保存，完成后再保存这个项目；当前编辑不会丢失。
          </p>
        )}
        {saveState?.kind === 'failed' && (
          <p className="save-error" role="alert">
            保存失败：{saveState.message}
          </p>
        )}
        <p className="composer-note">保存只写入本机 workspace.json；编辑仍会自动备份到恢复稿，不保证断电零丢失。</p>
      </div>

      <details className="chat-project">
        <summary>项目名称与简介</summary>
        <ProjectEditor
          draftMode="meta"
          project={project}
          fieldErrors={fieldErrors}
          limits={limits}
          dirty={dirty}
          saveState={saveState}
          backupState={backupState}
          blockedByOtherSave={blockedByOtherSave}
          canCancel={canCancel}
          cancelBusy={cancelBusy}
          cancelConfirm={cancelConfirm}
          cancelError={cancelError}
          onChange={onChange}
          onSave={onSave}
          onCancel={onCancel}
          onCancelConfirm={onCancelConfirm}
          onCancelDismiss={onCancelDismiss}
        />
      </details>
    </section>
  )
}
