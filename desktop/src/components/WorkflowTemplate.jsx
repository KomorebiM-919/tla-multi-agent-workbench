import { useState } from 'react'
import { WORKFLOW_STAGES, WORKFLOW_TEMPLATE_STATE } from '../data/workflow-template.js'

export default function WorkflowTemplate() {
  const [selectedId, setSelectedId] = useState(WORKFLOW_STAGES[0].id)
  const selected = WORKFLOW_STAGES.find((stage) => stage.id === selectedId) ?? WORKFLOW_STAGES[0]

  return (
    <section className="workflow-template" aria-labelledby="workflow-title">
      <div className="workflow-head">
        <h2 id="workflow-title">{WORKFLOW_TEMPLATE_STATE.title}</h2>
        <span className="chip chip-quiet">{WORKFLOW_TEMPLATE_STATE.status}</span>
      </div>
      <p className="workflow-note">{WORKFLOW_TEMPLATE_STATE.note}</p>

      <ol className="workflow-stages">
        {WORKFLOW_STAGES.map((stage) => (
          <li key={stage.id}>
            <button
              type="button"
              className={stage.id === selected.id ? 'workflow-stage is-active' : 'workflow-stage'}
              aria-pressed={stage.id === selected.id}
              onClick={() => setSelectedId(stage.id)}
            >
              <span className="workflow-stage-order">第 {stage.order} 步</span>
              <span className="workflow-stage-title">{stage.title}</span>
              <span className="workflow-stage-role">{stage.role}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="workflow-detail" role="region" aria-live="polite" aria-label={`${selected.title}说明`}>
        <h3>
          第 {selected.order} 步 · {selected.title}
          <span className="workflow-detail-role">{selected.role}</span>
        </h3>
        <p className="workflow-duty">{selected.duty}</p>
        <dl className="workflow-io">
          <div>
            <dt>输入</dt>
            <dd>{selected.inputs}</dd>
          </div>
          <div>
            <dt>输出</dt>
            <dd>{selected.outputs}</dd>
          </div>
        </dl>
        <p className="workflow-footnote">流程参考：阶段顺序来自仓库内的冻结工作流结构；本界面不读取历史运行记录。</p>
      </div>
    </section>
  )
}
