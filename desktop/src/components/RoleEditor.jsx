import { ROLE_LIMITS } from '../lib/team-settings.js'

const FIELDS = [
  ['name', '角色名称', false],
  ['badge', '定位', false],
  ['summary', '职责摘要', true],
  ['duty', '详细职责', true],
  ['provider', '计划供应商标签', false],
  ['model', '计划模型标识', false],
]

export default function RoleEditor({ editor, onChange, onSave, onCancel }) {
  return (
    <form className="role-editor" onSubmit={(event) => { event.preventDefault(); onSave() }} aria-label="编辑角色设置">
      <p className="role-settings-hint">只记录本项目的分工和计划模型，不会连接API。不要填写密钥、令牌或接口地址。</p>
      <fieldset disabled={editor.busy}>
        {FIELDS.map(([field, label, multiline]) => (
          <label className="field" key={field}>
            <span className="field-label">{label}</span>
            {multiline
              ? <textarea className="text-input" rows={field === 'duty' ? 5 : 3} value={editor.draft[field]} onChange={(event) => onChange(field, event.target.value)} />
              : <input className="text-input" type="text" value={editor.draft[field]} onChange={(event) => onChange(field, event.target.value)} />}
            <span className="field-meta">{editor.draft[field].length} / {ROLE_LIMITS[field]}</span>
          </label>
        ))}
        <p className="role-settings-hint">供应商与模型同时留空表示未指定；填了标签也仍然是“未连接”。角色编辑不会自动备份，离开前请保存或取消。</p>
        {editor.error && <p className="save-error" role="alert">{editor.error.message}</p>}
        <div className="role-editor-actions">
          <button type="submit" className="primary">{editor.busy ? '保存中…' : '保存角色设置'}</button>
          <button type="button" className="ghost" onClick={onCancel}>取消编辑</button>
        </div>
      </fieldset>
    </form>
  )
}
