import RoleEditor from './RoleEditor.jsx'

function DetailRow({ label, children }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export default function RoleDetail({ role, onClear, canEdit, editor, notice, noticeSeq, onEdit, onFieldChange, onSave, onCancel }) {
  if (!role) {
    return (
      <aside className="detail" aria-label="角色详情">
        <div className="detail-empty">
          <h2>角色详情</h2>
          <p>从左侧团队模板中选择一个角色，查看它的职责与边界。</p>
          <span className="detail-empty-hint">当前没有选中角色</span>
        </div>
      </aside>
    )
  }

  const isHuman = role.kind === 'human'
  // 只有编辑器正对应当前角色时才显示快捷操作，避免对人类角色或别的角色误触发保存。
  const editorForRole = Boolean(editor && editor.draft.roleId === role.id)
  const saving = editorForRole && editor.busy
  const message = saving
    ? '角色设置正在保存，请等待完成；窗口关闭会暂时被拦截。'
    : notice || (editorForRole && editor.error ? '角色设置没有保存成功，请重试。' : '')

  return (
    <aside className="detail" aria-label={`角色详情：${role.name}`}>
      <header className="detail-head">
        <div>
          <span className="detail-kicker">角色详情</span>
          <h2>{role.name}</h2>
        </div>
        <button type="button" className="detail-close" onClick={onClear} aria-label="关闭角色详情">
          关闭
        </button>
      </header>

      {message && (
        <div
          key={notice ? `blocked-${noticeSeq}` : 'notice'}
          className={notice ? 'role-local-notice is-attention' : 'role-local-notice'}
        >
          <p className="role-local-message" role="alert">{message}</p>
          {editorForRole && editor.error && !saving && (
            <p className="role-local-error" role="alert">保存失败：{editor.error.message}</p>
          )}
          {editorForRole && (
            <div className="role-local-actions">
              <button type="button" className="primary" disabled={saving} onClick={onSave}>
                {saving ? '保存中…' : '保存角色设置'}
              </button>
              <button type="button" className="ghost" disabled={saving} onClick={onCancel}>
                取消编辑
              </button>
            </div>
          )}
        </div>
      )}
      <div className="detail-badges">
        <span className={isHuman ? 'chip chip-human' : 'chip chip-quiet'}>
          {isHuman ? '人类角色' : 'AI角色'}
        </span>
        <span className="chip chip-model">{role.model}</span>
      </div>

      {role.modelRef && <p className="role-settings-hint">计划模型：{role.modelRef.provider} / {role.modelRef.model} · 仅标签，未连接</p>}
      {!isHuman && !editor && <button type="button" className="ghost" disabled={!canEdit} onClick={onEdit}>编辑角色设置</button>}
      {!isHuman && !canEdit && <p className="role-settings-hint">仅已正式保存且角色设置可读取的项目可编辑。</p>}
      {editor && editor.draft.roleId === role.id && <RoleEditor editor={editor} onChange={onFieldChange} onSave={onSave} onCancel={onCancel} />}
      <p className="detail-summary">{role.summary}</p>

      <dl className="detail-list">
        <DetailRow label="定位">{role.badge}</DetailRow>
        <DetailRow label="职责">{role.duty}</DetailRow>
        <DetailRow label="输入">{role.inputs}</DetailRow>
        <DetailRow label="输出">{role.outputs}</DetailRow>
        <DetailRow label="边界">{role.boundary}</DetailRow>
      </dl>

      <p className="detail-note">
        角色名称与职责可按项目设置；输入、输出与边界是初始模板参考，不改变执行权限。所有模型均未连接，不代表有任务在运行。
      </p>
    </aside>
  )
}
