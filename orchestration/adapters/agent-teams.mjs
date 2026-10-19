// orchestration/adapters/agent-teams.mjs
//
// dsh-agent-teams 的**最薄适配层**：只做三件事
// 1. 用可核对的公开事实（包名、版本、宿主版本、导出名）判断"能不能用"；
// 2. 把 TLA 计划翻译成该插件 create 工具的入参形状（纯数据，不调用）；
// 3. 如实登记它的模型请求发生点与"没有全局调用上限"的事实。
//
// 三条硬约束（来自本轮授权）：
// - 不模拟工具成功：执行函数只返回"未实现"，不会伪造 agent_teams_* 的返回；
// - 不直接改写插件内部状态文件：本模块不 import 任何 fs 写入 API（有测试断言）；
// - 插件缺失/版本不符/接口不明时明确报不可用，不静默切换到别的后端。

export const AGENT_TEAMS_PACKAGE = '@nanmicoder/dsh-agent-teams';
export const AGENT_TEAMS_REVIEWED_VERSION = '0.1.24-rc.1';
export const AGENT_TEAMS_REVIEWED_COMMIT = '6768de25aede12056a497b0a79ebf6cd8bb1e987';
export const AGENT_TEAMS_INSTALLED_VERSION = '0.1.25';
export const AGENT_TEAMS_LICENSE = 'MIT';
export const AGENT_TEAMS_RECOMMENDED_HOST = '0.2.1-rc.2';

/** compatibility.json 里列出的宿主版本（0.1.25 的清单；track 只是上游自己的分级，不代表已验证程度）。 */
export const AGENT_TEAMS_SUPPORTED_HOSTS = Object.freeze([
  { version: '0.2.1-rc.2', track: 'recommended' },
  { version: '0.2.1-rc.1', track: 'legacy' },
  { version: '0.2.0-rc.2', track: 'legacy' },
  { version: '0.1.7-rc.2', track: 'legacy' },
  { version: '0.1.5-rc.3', track: 'legacy' },
  { version: '0.1.5-rc.2', track: 'legacy' },
  { version: '0.1.5-rc.1', track: 'legacy' },
  { version: '0.1.2-rc.1', track: 'legacy' },
  { version: '0.1.2-alpha.5', track: 'preview' },
  { version: '0.1.2-alpha.2', track: 'legacy' },
]);

/** 插件公开导出的 5 个名字（lib/index.js:40-118）。缺一个就说明接口已变，不能猜。 */
export const AGENT_TEAMS_PUBLIC_EXPORTS = Object.freeze(['name', 'inject', 'Config', 'usageSectionText', 'apply']);
export const AGENT_TEAMS_INJECTED_SERVICES = Object.freeze(['tools', 'llm', 'subagents', 'systemPrompt', 'agents']);

/**
 * 模型请求真正被发起的位置（只读核对结果，供审计与文档引用）。
 * 关键结论：成员创建不调模型；首次派工、followup、自动修复、resume、fallback 各自独立发起。
 */
export const AGENT_TEAMS_CALL_SITES = Object.freeze([
  { seam: 'member-create', file: 'src/tools.ts', line: 1280, modelCall: false, note: '规划/空闲成员行不调用模型' },
  { seam: 'first-dispatch', file: 'src/members.ts', line: 945, modelCall: true, note: 'startMember(...) 的 agentOptions 指定 provider/model/reasoningEffort' },
  { seam: 'followup-message', file: 'src/members.ts', line: 1002, modelCall: true, note: 'deliverToMember → steerMemberPrompt / queueMemberPrompt 唤醒成员' },
  { seam: 'auto-repair', file: 'src/quality-gates.ts', line: 1047, modelCall: true, note: 'planQualityFollowUp 创建 repair+recheck 任务对并派工' },
  { seam: 'resume', file: 'src/tools.ts', line: 2420, modelCall: true, note: 'resumeTeamState → kickTeam 重新派工' },
  { seam: 'fallback-route', file: 'src/members.ts', line: 746, modelCall: true, note: 'agent/request-error 时 selectFallbackRoute 换 provider/model 重试' },
]);

export const AGENT_TEAMS_CALL_ACCOUNTING = Object.freeze({
  mode: 'per-spawn-resolveCallConfig',
  hardCapApplicable: false,
  synchronousLimit: null,
  note: '插件内没有模型调用计数器；每次 startMember 才解析一次调用配置，followup/修复/resume/fallback 都会独立发起新的模型请求，编排层无法在每次实际启动前同步拦截。',
});

export const AGENT_TEAMS_LIMITATIONS = Object.freeze([
  '该后端尚无全局调用硬上限：不能在编排层承诺"最多 8 次模型调用"这类硬限制。',
  '插件没有公开的读状态 API，运行状态只能读 team.json 或走带鉴权的 HTTP 路由；本适配层不读也不写这些文件。',
  '插件的事件（agent-teams/*）只有宿主在 KNOWN_SESSION_EVENT_TYPES 里登记时才会落盘，否则被静默丢弃。',
  '状态文件只保证单进程串行（withTeamLock 是进程内 promise 队列），两个 TLA 进程共用 stateDir 会竞争。',
]);

export const AGENT_TEAMS_NOT_PROOF_OF = Object.freeze([
  '没有在本机安装、启用或运行该插件，兼容性判断只基于上游 compatibility.json 与公开导出名',
  '0.2.1-rc.2 上的真实行为尚未验证；这里只确认了宿主愿意加载 0.1.25、compatibility.json 把它标为 recommended',
  '没有证明 create 工具参数在 0.1.25 上语义一致（调用点仍按 0.1.24-rc.1 的 schema 核对，0.1.25 只做了静态扫描）',
]);

export class AgentTeamsAdapterError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'AgentTeamsAdapterError';
    this.code = code;
    this.detail = detail;
  }
}

function hostEntry(hostVersion) {
  return AGENT_TEAMS_SUPPORTED_HOSTS.find((entry) => entry.version === hostVersion) || null;
}

function unavailable(compatibility, reason, detail) {
  return {
    kind: 'agent-teams',
    status: 'unavailable',
    reason,
    detail,
    compatibility,
    callAccounting: AGENT_TEAMS_CALL_ACCOUNTING,
    execution: { implementation: 'not-implemented', reason: 'BACKEND_EXECUTION_NOT_IMPLEMENTED' },
    limitations: [...AGENT_TEAMS_LIMITATIONS],
    notProofOf: [...AGENT_TEAMS_NOT_PROOF_OF],
  };
}

/**
 * 探测插件能否被使用。纯函数：入参都是调用方读到的公开事实，不读文件、不发网络请求。
 *
 * @param {{hostVersion?:string, pluginInstalled?:boolean, pluginVersion?:string, exports?:string[], services?:string[]}} facts
 */
export function probeAgentTeams(facts = {}) {
  const { hostVersion, pluginInstalled = false, pluginVersion, exports: exported, services } = facts;
  const compatibility = {
    package: AGENT_TEAMS_PACKAGE,
    reviewedVersion: AGENT_TEAMS_REVIEWED_VERSION,
    reviewedCommit: AGENT_TEAMS_REVIEWED_COMMIT,
    recommendedHost: AGENT_TEAMS_RECOMMENDED_HOST,
    hostVersion: hostVersion === undefined ? null : hostVersion,
    hostTrack: hostVersion === undefined ? null : (hostEntry(hostVersion) || {}).track || null,
  };
  if (!pluginInstalled) {
    return unavailable(compatibility, 'BACKEND_NOT_INSTALLED', AGENT_TEAMS_PACKAGE + ' 未安装：本阶段不安装第三方插件');
  }
  if (pluginVersion !== AGENT_TEAMS_REVIEWED_VERSION) {
    return unavailable(
      compatibility,
      'BACKEND_VERSION_UNVERIFIED',
      '已安装版本 ' + String(pluginVersion) + ' 不是只读核对过的版本 ' + AGENT_TEAMS_REVIEWED_VERSION,
    );
  }
  const entry = hostEntry(hostVersion);
  if (entry === null) {
    return unavailable(
      compatibility,
      'BACKEND_HOST_UNSUPPORTED',
      '宿主版本 ' + String(hostVersion) + ' 不在插件 compatibility.json 的 supportedHosts 里',
    );
  }
  const missingExports = AGENT_TEAMS_PUBLIC_EXPORTS.filter((name) => !Array.isArray(exported) || !exported.includes(name));
  const missingServices = AGENT_TEAMS_INJECTED_SERVICES.filter((name) => !Array.isArray(services) || !services.includes(name));
  if (missingExports.length > 0 || missingServices.length > 0) {
    return unavailable(
      compatibility,
      'BACKEND_INTERFACE_UNVERIFIABLE',
      '缺少公开导出 ' + JSON.stringify(missingExports) + ' 或注入服务 ' + JSON.stringify(missingServices),
    );
  }
  return {
    kind: 'agent-teams',
    // 兼容：宿主/插件/导出都对得上。但 TLA 侧的执行适配还没实现，所以计划仍然阻断。
    status: 'compatible',
    reason: null,
    detail: '插件 ' + AGENT_TEAMS_REVIEWED_VERSION + ' 声明支持宿主 ' + hostVersion + '（track=' + entry.track + '）',
    compatibility: { ...compatibility, hostTrack: entry.track },
    callAccounting: AGENT_TEAMS_CALL_ACCOUNTING,
    execution: {
      implementation: 'not-implemented',
      reason: 'BACKEND_EXECUTION_NOT_IMPLEMENTED',
      detail: '本阶段只实现计划翻译与兼容探测：未实现 create/approve/send_message/resume 的调用，不伪造成功',
    },
    limitations: [...AGENT_TEAMS_LIMITATIONS],
    notProofOf: [...AGENT_TEAMS_NOT_PROOF_OF],
  };
}

/** 把探测结果转成 buildPlan 需要的后端状态（只要不能真正执行，计划里就是 unavailable）。 */
export function backendStatusForPlan(probe) {
  if (probe.status === 'compatible') {
    const implemented = probe.execution !== undefined && probe.execution.implementation === 'implemented';
    return {
      kind: probe.kind,
      // 兼容 ≠ 可执行：宿主/插件/导出都对得上，但 TLA 侧执行适配未实现时，
      // 状态仍是 compatible，由计划单独把"执行实现"维度标为缺失并阻断。
      status: 'compatible',
      reason: implemented ? null : 'BACKEND_EXECUTION_NOT_IMPLEMENTED',
      detail: probe.execution.detail || '执行适配未实现',
      compatibility: probe.compatibility,
      callAccounting: probe.callAccounting,
      execution: probe.execution,
      limitations: probe.limitations,
      notProofOf: probe.notProofOf,
    };
  }
  return {
    kind: probe.kind,
    status: 'unavailable',
    reason: probe.reason,
    detail: probe.detail,
    compatibility: probe.compatibility,
    callAccounting: probe.callAccounting,
    execution: probe.execution === undefined
      ? { implementation: 'not-implemented', reason: probe.reason || 'BACKEND_UNAVAILABLE' }
      : probe.execution,
    limitations: probe.limitations,
    notProofOf: probe.notProofOf,
  };
}

/** 现有 workflow-script 后端（已完成验收的 three-agent-mvp）的状态描述。 */
export function workflowScriptBackendStatus({ workflow = 'three-agent-mvp', maxAgentCalls = 8 } = {}) {
  return {
    kind: 'workflow-script',
    status: 'ready',
    reason: null,
    detail: '已验证的 ' + workflow + ' 工作流（V0.1 验收基线）；本次只描述不执行',
    callAccounting: {
      mode: 'synchronous-agent-call-guard',
      hardCapApplicable: true,
      synchronousLimit: maxAgentCalls,
      note: '每次 agent() 启动前同步检查 maxAgentCalls；只限制次数，单次调用的 token 仍无法硬限制',
    },
    execution: {
      implementation: 'implemented',
      reason: null,
      detail: workflow + ' 已在 V0.1 真实运行中通过验收；本阶段只描述，不启动',
    },
    limitations: ['只限制模型调用次数，不限制单次调用消耗的 token，也不覆盖插件内部自行发起的请求'],
    notProofOf: ['没有启动任何代理：这是计划，不是运行记录'],
  };
}

/** 成员行：字段名直接对齐插件 create 工具的 plan.members 结构。 */
function roleToMember(member) {
  return {
    name: member.role,
    role: member.role,
    provider: member.provider,
    model: member.model,
    ...(member.reasoningEffort === undefined || member.reasoningEffort === null
      ? {}
      : { reasoning_effort: member.reasoningEffort }),
  };
}

/**
 * 把 TLA 计划翻译成 agent_teams_create 的入参形状。
 * 只做字段映射与显式校验，不调用工具、不写文件、不产生副作用。
 */
export function translatePlanToAgentTeams(plan, options) {
  if (!plan || plan.schema !== 'tla.v02-plan/v1') {
    throw new AgentTeamsAdapterError('PLAN_INVALID', '需要 tla.v02-plan/v1 计划');
  }
  const opts = options || {};
  const approval = opts.approval === undefined ? 'required' : opts.approval;
  if (approval !== 'required' && approval !== 'automatic') {
    throw new AgentTeamsAdapterError('APPROVAL_INVALID', 'approval 只能是 required 或 automatic');
  }
  const tasks = opts.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new AgentTeamsAdapterError('TASKS_MISSING', '翻译需要 backend.options.tasks（不在适配层替用户编任务）');
  }
  const memberNames = plan.members.map((member) => member.role);
  const seen = new Set();
  const translatedTasks = tasks.map((task, index) => {
    const where = 'tasks[' + index + ']';
    if (!task || typeof task !== 'object') throw new AgentTeamsAdapterError('TASKS_INVALID', where + ' 必须是对象');
    for (const key of ['id', 'subject']) {
      if (typeof task[key] !== 'string' || task[key].trim() === '') {
        throw new AgentTeamsAdapterError('TASKS_INVALID', where + '.' + key + ' 不能为空');
      }
    }
    if (seen.has(task.id)) throw new AgentTeamsAdapterError('TASKS_INVALID', '重复的任务 id ' + task.id);
    seen.add(task.id);
    if (task.assignee !== undefined && !memberNames.includes(task.assignee)) {
      throw new AgentTeamsAdapterError('TASKS_INVALID', where + '.assignee 不是计划里的成员: ' + task.assignee);
    }
    for (const dependency of task.dependencies || []) {
      if (!tasks.some((candidate) => candidate.id === dependency)) {
        throw new AgentTeamsAdapterError('TASKS_INVALID', where + '.dependencies 引用了不存在的任务 ' + dependency);
      }
    }
    return {
      id: task.id,
      subject: task.subject,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
      ...(task.dependencies === undefined ? {} : { dependencies: task.dependencies }),
    };
  });
  return {
    name: opts.teamName === undefined ? plan.runId : opts.teamName,
    description: 'TLA V0.2 plan ' + plan.runId + ' (owner: ' + plan.owner + ')',
    approval,
    plan: {
      members: plan.members.map((member) => roleToMember(member)),
      tasks: translatedTasks,
    },
  };
}

/**
 * 执行入口：本阶段明确不实现。返回"不可用"而不是伪造一次成功调用。
 * 单独暴露这个函数，是为了让调用方无法把"翻译成功"误当成"已执行"。
 */
export function executePlan() {
  return {
    status: 'unavailable',
    code: 'BACKEND_EXECUTION_NOT_IMPLEMENTED',
    detail: '本阶段只实现离线适配：不调用 agent_teams_create/approve/send_message/resume，也不写插件状态文件',
    executedModelCalls: 0,
  };
}
