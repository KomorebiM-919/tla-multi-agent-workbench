// 冻结工作流的阶段顺序模板：只描述流程结构，不代表任何一次真实运行。
// 阶段顺序与职责取自 workflows/three-agent-mvp.js 的编排说明；本模块不读取历史记录、不执行任务。

export const WORKFLOW_TEMPLATE_STATE = Object.freeze({
  title: '工作流阶段顺序模板',
  status: '未运行',
  note: '按冻结工作流结构展示，仅作流程参考；还没有真实运行记录，因此不显示成功、失败、耗时、费用或进度。',
})

export const WORKFLOW_STAGES = Object.freeze([
  Object.freeze({
    id: 'preflight',
    order: 1,
    title: '环境预检',
    role: 'Verifier',
    duty: '在开始前确认证据目录可被本次运行排他认领、上报路径都在仓库内、角色提示词文件齐全；发现问题即终止，不进入后续阶段。',
    inputs: '运行标识、证据目录、提示词目录与交付路径配置',
    outputs: '预检结论与问题清单；问题清单非空时不继续',
  }),
  Object.freeze({
    id: 'requirement',
    order: 2,
    title: '需求理解',
    role: 'Requirement Agent',
    duty: '把自然语言需求整理成结构化任务、可检验的验收条件与边界条件，并对验收条件和边界做一致性自检。',
    inputs: '原始需求、运行标识、证据目录与允许的依赖边界',
    outputs: '结构化需求、验收条件清单与一致性自检结果',
  }),
  Object.freeze({
    id: 'coding',
    order: 3,
    title: '编码实现',
    role: 'Coding Agent',
    duty: '在指定交付目录内实现代码与测试，真实运行规范化测试命令，并报告实际结果与偏离项。',
    inputs: '结构化需求、交付目录、模块与测试文件约定、规范化测试命令',
    outputs: '代码与测试改动、测试运行报告及偏离说明',
  }),
  Object.freeze({
    id: 'verify',
    order: 4,
    title: '独立验证',
    role: 'Verifier',
    duty: '在独立执行实例中原样复跑规范化测试命令，只回传原始输出、退出码与交付文件哈希，不修改文件。',
    inputs: '交付目录、规范化测试命令、运行标识与证据目录',
    outputs: '原始命令输出、退出码、文件哈希与验证结论',
  }),
  Object.freeze({
    id: 'review',
    order: 5,
    title: '独立审核',
    role: 'Review Agent',
    duty: '在独立上下文中读取需求与真实代码，自行复跑测试，并逐条判定验收条件，给出通过或退回修改的结论。',
    inputs: '结构化需求、编码报告、交付目录、规范化测试命令',
    outputs: '审核结论、逐条验收判定与复核所用的原始证据',
  }),
])
