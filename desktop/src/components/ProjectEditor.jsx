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

export default function ProjectEditor({
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
    <section className="editor settings-editor" aria-labelledby="editor-title">
      <div className="editor-head">
        <h2 id="editor-title">项目设置</h2>
        <span className="editor-hint">仅保存在本机 · 未连接模型</span>
      </div>

      <label className="field">
        <span className="field-label">项目名称</span>
        <input
          type="text"
          className={fieldErrors.name ? 'text-input is-invalid' : 'text-input'}
          value={project.name}
          aria-invalid={fieldErrors.name ? 'true' : undefined}
          onChange={(event) => onChange('name', event.target.value)}
        />
        <span className="field-meta">
          <span>
            {project.name.length} / {limits.name}
          </span>
          {fieldErrors.name && <span className="field-error">{fieldErrors.name}</span>}
        </span>
      </label>

      <label className="field">
        <span className="field-label">项目简介</span>
        <textarea
          className={fieldErrors.description ? 'text-input is-invalid' : 'text-input'}
          rows={3}
          value={project.description}
          aria-invalid={fieldErrors.description ? 'true' : undefined}
          onChange={(event) => onChange('description', event.target.value)}
        />
        <span className="field-meta">
          <span>
            {project.description.length} / {limits.description}
          </span>
          {fieldErrors.description && (
            <span className="field-error">{fieldErrors.description}</span>
          )}
        </span>
      </label>

      <div className="draft">
        <div className="draft-head">
          <h3>项目计划</h3>
          <span className="field-meta">
            <span>
              {project.taskDraft.length} / {limits.taskDraft}
            </span>
          </span>
        </div>
        <p className="field-hint">
          总体安排与预期。旧版本保存的“任务草稿”会原样显示在这里，仍使用原字段与长度上限。
        </p>
        <textarea
          className={fieldErrors.taskDraft ? 'draft-input is-invalid' : 'draft-input'}
          rows={9}
          value={project.taskDraft}
          aria-label="项目计划"
          aria-invalid={fieldErrors.taskDraft ? 'true' : undefined}
          placeholder="写下这个项目的总体安排与预期；只保存在本机，不会发送给任何模型。"
          onChange={(event) => onChange('taskDraft', event.target.value)}
        />
        {fieldErrors.taskDraft && <p className="field-error">{fieldErrors.taskDraft}</p>}

        <div className="draft-actions">
          <button
            type="button"
            className="primary"
            onClick={onSave}
            disabled={saveDisabled}
            title={
              blockedByOtherSave
                ? '另一个项目正在保存，完成后再保存这个项目'
                : dirty
                  ? '保存当前项目的名称、简介与计划'
                  : '没有需要保存的更改'
            }
          >
            {saving ? '保存中…' : '保存项目设置'}
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

        {canCancel && (
          <div className="cancel-new">
            {cancelConfirm ? (
              <>
                <p className="cancel-hint">
                  这个项目还没有正式保存到 workspace.json，取消会移除条目与对应恢复稿；磁盘上的项目目录和已保存项目不受影响。
                </p>
                <div className="cancel-actions">
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={onCancelConfirm}
                    disabled={cancelBusy}
                  >
                    {cancelBusy ? '取消中…' : '确认取消'}
                  </button>
                  <button type="button" className="ghost" onClick={onCancelDismiss}>
                    保留项目
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="ghost"
                onClick={onCancel}
                disabled={cancelBusy}
              >
                {cancelBusy ? '取消中…' : '取消新建'}
              </button>
            )}
            {cancelError && (
              <p className="save-error" role="alert">
                取消失败：{cancelError}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
