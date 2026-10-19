// 反应式假模型的响应引擎（正式测试用，v2）。
//
// 与 v1 的差别：v1 用"最后一条工具结果文本里包含某个子串"来猜状态，结果把
// 错误消息里的文件路径当成了"写入成功"，在真实宿主上把一个失败的写入记成了
// 已完成。v2 只按**结构化的工具结果**推进：
//
//   - 用 tool_use_id 把 tool_result 关联回发起它的工具名与参数；
//   - 读 is_error、以及 content 里真正的文本块（数组或字符串都支持）；
//   - attempt_id 只从**当前这一轮**的 claim 结果取，不从历史里抓第一个 UUID；
//   - 状态按成员会话隔离（captain / worker / reviewer 各自独立计数）；
//   - 每条规则必须显式声明有限的 maxUses，没有隐式默认；
//   - 没有规则匹配、结果形态不认识、状态回退，一律抛错，调用方必须当成失败。
//
// 它只能决定"下一步发哪个工具调用"，不能伪造工具输出，也不能替测试宣布成功：
// 真正的成功判定在测试里（文件哈希 + 测试退出码 + 任务终态一起看）。

export const REACTIVE_SCHEMA = 'tla.reactive-model/v2';

export class ReactiveRuleError extends Error {
  constructor(code, detail) {
    super(code + ': ' + detail);
    this.code = code;
    this.detail = detail;
  }
}

const KNOWN_MATCH_KEYS = new Set([
  'tool',
  'isError',
  'resultMatches',
  'resultNotMatches',
  'noToolResult',
  'toolPresent',
  // 队长"被唤醒"的方式：这条请求没有工具结果，而是宿主塞进来的一段文本。
  // mailbox = 成员报告的投递（AgentTeams inbox receipt），settlement = 宿主自己
  // 的"后台子代理结束了"通知，none = 有文本但两者都不是。
  'wakeKind',
  'textMatches',
  'textNotMatches',
  // 按事实值精确匹配，避免用正则去猜"这次派的是 t1 还是 t3"。
  'claimTaskId',
  'promptTaskId',
]);

// 规则的意图要显式标出来，否则统计会把"合法等待"和"动作"混成一个数字。
// action    = 调工具推进流程
// idle-wait = 结束当前回合并等待（文本回复、不调工具）
// poll      = 查看状态，不改任何东西
const RULE_KINDS = new Set(['action', 'idle-wait', 'poll']);

// 等待的硬上限：宿主每次唤醒都算一次请求，这里不允许用"无限豁免"掩盖空转。
const MAX_IDLE_USES = 40;
const WAKE_KINDS = new Set(['mailbox', 'settlement', 'none']);

const KNOWN_FACT_KEYS = new Set([
  'claimTaskId',
  'claimAttemptId',
  'claimRole',
  'updateTaskId',
  'updateStatus',
  'fileOutcome',
  'filePath',
  'promptTaskId',
  'currentAttemptId',
  'wakeKind',
  'reportFrom',
  'reportTaskId',
  'reportAttemptId',
  'reportStatus',
]);

// 宿主的两种唤醒文本（来自 @nanmicoder/dsh-agent-teams 0.1.23 的 mailbox.js；
// 2026-10-19 在 0.1.25 的 lib/mailbox.js 复核，PREFIX / 'AgentTeams message from member' /
// 'Background subagent … will do no further work unless you send it more.' 均未变）。
const WAKE_RECEIPT_RE = /^AgentTeams inbox receipt: /m;
const WAKE_MESSAGE_RE = /AgentTeams message from (?:member )?([A-Za-z0-9_-]+):/;
const WAKE_SETTLEMENT_RE = /Background subagent \S+ finished and will do no further work/;
const REPORT_SOURCE_RE = /\[Source task (t\d+), attempt_id ([0-9a-fA-F-]{8,})(?:, status=(\w+))?\]/;

// 角色名不写死：队长固定是 captain，成员则用它 claim 结果里的成员名
// （worker / reviewer …）。这样加一个角色不需要改引擎。

function fail(code, detail) {
  throw new ReactiveRuleError(code, detail);
}

function textOfContent(content, where) {
  if (typeof content === 'string') {
    if (content.length === 0) fail('RESULT_EMPTY', where + ': 工具结果文本为空');
    return content;
  }
  if (Array.isArray(content)) {
    if (content.length === 0) fail('RESULT_EMPTY', where + ': 工具结果的 content 是空数组');
    const parts = [];
    for (const part of content) {
      if (part === null || typeof part !== 'object') fail('RESULT_SHAPE_UNKNOWN', where + ': content 数组里有非对象元素');
      if (part.type === 'text') {
        if (typeof part.text !== 'string') fail('RESULT_SHAPE_UNKNOWN', where + ': text 块缺少字符串 text');
        parts.push(part.text);
      } else if (part.type === 'image') {
        // 图片块没有可判定文本；保留占位，避免把它当成"成功"
        parts.push('<image>');
      } else {
        fail('RESULT_SHAPE_UNKNOWN', where + ': 未知的结果块类型 ' + String(part.type));
      }
    }
    return parts.join('\n');
  }
  if (content === undefined || content === null) fail('RESULT_EMPTY', where + ': 工具结果没有 content');
  fail('RESULT_SHAPE_UNKNOWN', where + ': content 既不是字符串也不是数组');
  return '';
}

// 把一次请求体解析成结构化上下文：工具调用、结果、以及"当前这一轮"的结果。
export function parseBody(body) {
  if (body === null || typeof body !== 'object') fail('BODY_SHAPE_UNKNOWN', 'body 不是对象');
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages === null) fail('BODY_SHAPE_UNKNOWN', 'body.messages 不是数组');
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = tools.map((tool) => (tool && typeof tool.name === 'string' ? tool.name : null));
  if (toolNames.some((name) => name === null)) fail('BODY_SHAPE_UNKNOWN', 'tools 里有缺少 name 的条目');

  const calls = new Map();
  const results = [];
  let lastAssistantIndex = -1;

  for (const [messageIndex, message] of messages.entries()) {
    if (message === null || typeof message !== 'object') fail('BODY_SHAPE_UNKNOWN', 'messages[' + messageIndex + '] 不是对象');
    const role = message.role;
    const content = message.content;
    if (role === 'assistant') lastAssistantIndex = messageIndex;
    if (typeof content === 'string') continue;
    if (!Array.isArray(content)) fail('BODY_SHAPE_UNKNOWN', 'messages[' + messageIndex + '].content 形态未知');
    for (const [partIndex, part] of content.entries()) {
      if (part === null || typeof part !== 'object') fail('BODY_SHAPE_UNKNOWN', 'messages[' + messageIndex + '][' + partIndex + '] 不是对象');
      const where = 'messages[' + messageIndex + '][' + partIndex + ']';
      if (part.type === 'tool_use') {
        if (typeof part.id !== 'string' || typeof part.name !== 'string') fail('CALL_SHAPE_UNKNOWN', where + ': tool_use 缺少 id 或 name');
        if (part.input !== undefined && (part.input === null || typeof part.input !== 'object')) fail('CALL_SHAPE_UNKNOWN', where + ': tool_use.input 不是对象');
        calls.set(part.id, { id: part.id, name: part.name, input: part.input ?? {}, messageIndex });
      } else if (part.type === 'tool_result') {
        if (typeof part.tool_use_id !== 'string') fail('RESULT_SHAPE_UNKNOWN', where + ': tool_result 缺少 tool_use_id');
        if (typeof part.is_error !== 'boolean') fail('RESULT_SHAPE_UNKNOWN', where + ': tool_result 缺少布尔 is_error（不能靠文本猜成功与否）');
        const call = calls.get(part.tool_use_id) ?? null;
        results.push({
          toolUseId: part.tool_use_id,
          toolName: call === null ? null : call.name,
          input: call === null ? null : call.input,
          messageIndex,
          isError: part.is_error,
          text: textOfContent(part.content, where),
        });
      } else if (part.type === 'text') {
        if (typeof part.text !== 'string') fail('BODY_SHAPE_UNKNOWN', where + ': text 块缺少字符串 text');
      } else {
        fail('BODY_SHAPE_UNKNOWN', where + ': 未知内容块类型 ' + String(part.type));
      }
    }
  }

  const turnResults = results.filter((result) => result.messageIndex > lastAssistantIndex);

  return {
    tools: toolNames,
    calls,
    results,
    turnResults,
    lastResult: turnResults.length === 0 ? null : turnResults[turnResults.length - 1],
    toolCount: toolNames.length,
    lastText: (() => {
      if (messages.length === 0) return '';
      const content = messages[messages.length - 1].content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n');
    })(),
    whole: JSON.stringify(body),
  };
}

// 角色只看工具清单的结构：有建队工具的是队长，其余是成员。
// 不用工具数量硬编码（不同版本 38/26 会变）。
export function detectRole(parsed) {
  if (parsed.tools.includes('agent_teams_create')) return 'captain';
  if (parsed.tools.includes('agent_teams_claim_task')) return 'member';
  fail('ROLE_UNKNOWN', '工具清单里既没有建队工具也没有领任务工具，无法判定角色');
  return null;
}

const CLAIM_RE = /Task\s+(\S+)\s+claimed\s+by\s+([A-Za-z0-9_-]+)\s+\(attempt\s+(\d+),\s+attempt_id\s+([0-9a-fA-F-]{8,}),\s+status\s+(\w+)\)/;

// 身份（谁、哪个 attempt）可以从整个会话里最近的 claim 结果获得——它是稳定的。
// 但"当前这一轮发生了什么"只取 turnResults，避免把历史里的旧 attempt 当成新的。
export function identityOf(parsed) {
  let claim = null;
  for (const result of parsed.results) {
    if (result.toolName !== 'agent_teams_claim_task') continue;
    if (result.isError) continue;
    const match = CLAIM_RE.exec(result.text);
    if (match === null) fail('CLAIM_SHAPE_UNKNOWN', 'claim 结果无法解析出 task/attempt：' + JSON.stringify(result.text.slice(0, 120)));
    claim = { taskId: match[1], memberRole: match[2], attemptNumber: Number(match[3]), attemptId: match[4], status: match[5] };
  }
  return claim;
}

function factsOf(parsed, identity) {
  const facts = {
    claimTaskId: identity === null ? null : identity.taskId,
    claimAttemptId: identity === null ? null : identity.attemptId,
    claimRole: identity === null ? null : identity.memberRole,
    updateTaskId: null,
    updateStatus: null,
    fileOutcome: null,
    filePath: null,
    promptTaskId: null,
    currentAttemptId: null,
    // 最近一次工具结果的原文：规则用它把真实测试输出贴进报告，避免手抄数字。
    lastToolText: null,
  };

  if (parsed.lastResult !== null) facts.lastToolText = parsed.lastResult.text;

  const promptMatch = /\b(t\d+)\b/i.exec(parsed.lastText);
  if (promptMatch !== null) facts.promptTaskId = promptMatch[1].toLowerCase();

  for (const result of parsed.turnResults) {
    if (result.toolName === 'agent_teams_claim_task' && result.isError === false) {
      const match = CLAIM_RE.exec(result.text);
      if (match === null) fail('CLAIM_SHAPE_UNKNOWN', 'claim 结果无法解析：' + JSON.stringify(result.text.slice(0, 120)));
      facts.claimTaskId = match[1];
      facts.claimAttemptId = match[4];
      facts.claimRole = match[2];
      facts.currentAttemptId = match[4];
    }
    if (result.toolName === 'agent_teams_update_task' && result.isError === false) {
      const match = /Task\s+(\S+)\s+attempt\s+\d+\s+→\s+(\w+)/.exec(result.text);
      if (match === null) fail('UPDATE_SHAPE_UNKNOWN', 'update 结果无法解析：' + JSON.stringify(result.text.slice(0, 120)));
      facts.updateTaskId = match[1];
      facts.updateStatus = match[2];
    }
    if ((result.toolName === 'write' || result.toolName === 'edit') && result.isError === false) {
      const path = /<path>([\s\S]*?)<\/path>/.exec(result.text);
      const outcome = /<content>\s*(Created file|Updated file)\s*<\/content>/.exec(result.text);
      if (path === null || outcome === null) fail('WRITE_SHAPE_UNKNOWN', '写操作的"成功"结果里没有 <path> + Created/Updated file：' + JSON.stringify(result.text.slice(0, 160)));
      facts.filePath = path[1].trim();
      facts.fileOutcome = outcome[1] === 'Created file' ? 'created' : 'updated';
    }
  }

  // 唤醒：这一轮没有工具结果，只有宿主塞进来的一段文本。区分"成员报告送到了"
  // 和"宿主只是通知后台子代理结束了"，否则队长会被自己的等待逻辑反复叫醒。
  if (parsed.turnResults.length === 0) {
    const text = parsed.lastText;
    if (WAKE_RECEIPT_RE.test(text) || WAKE_MESSAGE_RE.test(text)) {
      facts.wakeKind = 'mailbox';
      const from = WAKE_MESSAGE_RE.exec(text);
      if (from !== null) facts.reportFrom = from[1];
      const source = REPORT_SOURCE_RE.exec(text);
      if (source !== null) {
        facts.reportTaskId = source[1];
        facts.reportAttemptId = source[2];
        if (source[3] !== undefined) facts.reportStatus = source[3];
      }
    } else if (WAKE_SETTLEMENT_RE.test(text)) {
      facts.wakeKind = 'settlement';
    } else if (text.trim() !== '') {
      facts.wakeKind = 'none';
    }
  }
  return facts;
}

export function sessionKeyOf(parsed, identity) {
  const role = detectRole(parsed);
  if (role === 'captain') return 'captain';
  const promptMatch = /\b(t\d+)\b/i.exec(parsed.lastText);
  const promptTaskId = promptMatch === null ? null : promptMatch[1].toLowerCase();
  // 新派工提示会开一个新的 attempt：即使会话历史里还有上一次 claim，
  // 这一轮必须从 'new' 开始，否则上一轮的终态会把新任务卡死。
  const freshDispatch = parsed.turnResults.length === 0 && promptTaskId !== null &&
    (identity === null || identity.taskId !== promptTaskId);
  if (freshDispatch) return 'member:' + roleOf(parsed, identity) + ':pending:' + promptTaskId;
  if (identity !== null) return 'member:' + identity.memberRole + ':' + identity.attemptId;
  // 还没 claim 的第一次请求：按"角色 + 派工任务号"区分，否则同一个 worker
  // 第一次派工 t1 和后来的修复任务 t3 会共用一个状态，把单次规则用光。
  return 'member:' + roleOf(parsed, null) + ':pending:' + (promptTaskId === null ? 'unknown' : promptTaskId);
}

// 规则里的 role 用它匹配：队长看工具清单；成员先看 claim 结果里的成员名，
// 还没 claim 的第一次请求则看派工提示里的 "You are <name>, a member"。
// 提示里的名字只是**选择**下一步，claim 结果才是权威，随后由 identity 接管。
const PROMPT_ROLE_RE = /You are ([A-Za-z0-9_-]+), a member/;

export function roleOf(parsed, identity) {
  if (detectRole(parsed) === 'captain') return 'captain';
  if (identity !== null) return identity.memberRole;
  const match = PROMPT_ROLE_RE.exec(parsed.whole);
  return match === null ? 'member' : match[1];
}

function resultTextFor(parsed, toolName) {
  const matches = parsed.turnResults.filter((result) => result.toolName === toolName);
  if (matches.length === 0) return null;
  // 同一轮里同名工具调用多个结果时，取最后一个；多个不同结果是合法的。
  return matches[matches.length - 1];
}

export function matches(rule, parsed, state, facts) {
  const match = rule.match ?? {};
  if (match.wakeKind !== undefined && (facts.wakeKind ?? null) !== match.wakeKind) return false;
  if (match.textMatches !== undefined && !new RegExp(match.textMatches).test(parsed.lastText)) return false;
  if (match.textNotMatches !== undefined && new RegExp(match.textNotMatches).test(parsed.lastText)) return false;
  for (const key of ['claimTaskId', 'promptTaskId']) {
    if (match[key] === undefined) continue;
    if ((facts[key] ?? null) !== match[key]) return false;
  }
  const toolNames = Object.keys(match).filter((key) => key === 'tool' || key === 'isError' || key === 'resultMatches' || key === 'resultNotMatches' || key === 'toolPresent');
  if (match.noToolResult === true) {
    if (parsed.turnResults.length !== 0) return false;
    return toolNames.length === 0;
  }
  const toolName = match.tool ?? (match.toolPresent ?? null);
  if (toolName === null) {
    // 只按"有没有结果"判断的规则：不允许顺带要求结果内容
    if (match.resultMatches !== undefined || match.resultNotMatches !== undefined || match.isError !== undefined) {
      fail('POLICY_INVALID', rule.name + ': resultMatches/isError 必须和 tool 一起用');
    }
    // 唤醒规则（wakeKind/textMatches）本身就是"这一轮没有工具结果"，不能要求有结果。
    if (match.wakeKind !== undefined) return true;
    if (parsed.turnResults.length === 0) return false;
    return true;
  }
  const result = resultTextFor(parsed, toolName);
  if (result === null) return false;
  if (match.isError !== undefined && result.isError !== match.isError) return false;
  if (match.resultMatches !== undefined && !new RegExp(match.resultMatches).test(result.text)) return false;
  if (match.resultNotMatches !== undefined && new RegExp(match.resultNotMatches).test(result.text)) return false;
  return true;
}

export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object') fail('POLICY_INVALID', 'policy 不是对象');
  if (policy.schema !== REACTIVE_SCHEMA) fail('POLICY_INVALID', 'policy.schema 必须是 ' + REACTIVE_SCHEMA);
  const rules = policy.rules;
  if (!Array.isArray(rules) || rules.length === 0) fail('POLICY_INVALID', 'rules 必须是非空数组');
  const names = new Set();
  for (const [index, rule] of rules.entries()) {
    const where = 'rules[' + index + ']';
    if (rule === null || typeof rule !== 'object') fail('POLICY_INVALID', where + ' 不是对象');
    if (typeof rule.name !== 'string' || rule.name.length === 0) fail('POLICY_INVALID', where + '.name 必须是非空字符串');
    if (names.has(rule.name)) fail('POLICY_INVALID', where + '.name 重复：' + rule.name);
    names.add(rule.name);
    if (typeof rule.role !== 'string' || rule.role.length === 0) fail('POLICY_INVALID', where + '.role 必须是非空字符串（any 表示任意角色）');
    if (typeof rule.state !== 'string' || rule.state.length === 0) fail('POLICY_INVALID', where + '.state 必须显式声明');
    if (!Number.isInteger(rule.maxUses) || rule.maxUses < 1) fail('POLICY_INVALID', where + '.maxUses 必须是显式的正整数（不允许无限）');
    const match = rule.match;
    if (match === null || typeof match !== 'object' || Array.isArray(match)) fail('POLICY_INVALID', where + '.match 必须是对象');
    for (const key of Object.keys(match)) {
      if (!KNOWN_MATCH_KEYS.has(key)) fail('POLICY_INVALID', where + '.match.' + key + ' 不是受支持的匹配项');
    }
    if (match.noToolResult !== undefined && typeof match.noToolResult !== 'boolean') fail('POLICY_INVALID', where + '.match.noToolResult 必须是布尔');
    if (match.isError !== undefined && typeof match.isError !== 'boolean') fail('POLICY_INVALID', where + '.match.isError 必须是布尔');
    for (const key of ['tool', 'toolPresent', 'resultMatches', 'resultNotMatches', 'claimTaskId', 'promptTaskId']) {
      if (match[key] !== undefined && typeof match[key] !== 'string') fail('POLICY_INVALID', where + '.match.' + key + ' 必须是字符串');
    }
    for (const key of ['resultMatches', 'resultNotMatches']) {
      if (match[key] === undefined) continue;
      try { new RegExp(match[key]); } catch (error) { fail('POLICY_INVALID', where + '.match.' + key + ' 不是合法正则：' + error.message); }
    }
    const reply = rule.reply;
    if (reply === null || typeof reply !== 'object') fail('POLICY_INVALID', where + '.reply 必须是对象');
    const hasText = typeof reply.text === 'string';
    const hasCalls = Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0;
    if (hasText === hasCalls) fail('POLICY_INVALID', where + '.reply 必须恰好有 text 或 toolCalls 之一');
    if (hasCalls) {
      for (const call of reply.toolCalls) {
        if (call === null || typeof call !== 'object' || typeof call.name !== 'string' || call.name.length === 0) {
          fail('POLICY_INVALID', where + '.reply.toolCalls 里有缺少 name 的调用');
        }
        if (call.input !== undefined && (call.input === null || typeof call.input !== 'object')) fail('POLICY_INVALID', where + '.reply.toolCalls.input 必须是对象');
      }
    }
    if (rule.next !== undefined && (typeof rule.next !== 'string' || rule.next.length === 0)) fail('POLICY_INVALID', where + '.next 必须是非空字符串');
    if (rule.progressExempt !== undefined && typeof rule.progressExempt !== 'boolean') fail('POLICY_INVALID', where + '.progressExempt 必须是布尔');
    // 既有策略没有显式 kind：只调 agent_teams_status 的规则按快照轮询处理，
    // 其余按推进动作处理（两者对"无进展"的判据不同）。
    const inferredPoll = Array.isArray(reply.toolCalls) && reply.toolCalls.length === 1 && reply.toolCalls[0].name === 'agent_teams_status';
    const kind = rule.kind ?? (inferredPoll ? 'poll' : 'action');
    if (!RULE_KINDS.has(kind)) fail('POLICY_INVALID', where + '.kind 必须是 action / idle-wait / poll 之一');
    if (rule.kind !== undefined && rule.kind !== kind) fail('POLICY_INVALID', where + '.kind 类型错误');
    if (kind === 'idle-wait') {
      // 结束回合只能是文本回复；带上工具调用就又成了动作。
      if (!hasText) fail('POLICY_INVALID', where + ': idle-wait 规则必须用文本回复结束回合，不能带 toolCalls');
      if (rule.next !== undefined) fail('POLICY_INVALID', where + ': idle-wait 规则不能改状态');
      if (rule.maxUses > MAX_IDLE_USES) fail('POLICY_INVALID', where + ': idle-wait 的 maxUses 不能超过 ' + MAX_IDLE_USES + '（等待有界，但不是无限豁免）');
    }
    if (kind === 'action' && rule.progressExempt === true) {
      fail('POLICY_INVALID', where + ': 只有 idle-wait / poll 才可以 progressExempt；推进动作必须能体现"没有进展"');
    }
    if (kind === 'poll' && hasCalls && reply.toolCalls.length > 1) {
      fail('POLICY_INVALID', where + ': poll 规则一次只能查看一个状态');
    }
    if (match.wakeKind !== undefined) {
      if (typeof match.wakeKind !== 'string' || !WAKE_KINDS.has(match.wakeKind)) {
        fail('POLICY_INVALID', where + '.match.wakeKind 必须是 mailbox / settlement / none 之一');
      }
      if (kind !== 'idle-wait' && kind !== 'action') fail('POLICY_INVALID', where + ': wakeKind 只能用于 action 或 idle-wait');
    }
    for (const key of ['textMatches', 'textNotMatches']) {
      if (match[key] === undefined) continue;
      if (typeof match[key] !== 'string') fail('POLICY_INVALID', where + '.match.' + key + ' 必须是字符串');
      try { new RegExp(match[key]); } catch (error) { fail('POLICY_INVALID', where + '.match.' + key + ' 不是合法正则：' + error.message); }
    }
  }
  for (const key of Object.keys(policy.facts ?? {})) {
    if (!KNOWN_FACT_KEYS.has(key)) fail('POLICY_INVALID', 'policy.facts.' + key + ' 不是受支持的模板变量');
  }
  return policy;
}

function applyTemplates(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, name) => {
      if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== null && vars[name] !== undefined) return String(vars[name]);
      fail('TEMPLATE_UNRESOLVED', '模板变量没有值：' + whole);
      return whole;
    });
  }
  if (Array.isArray(value)) return value.map((item) => applyTemplates(item, vars));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = applyTemplates(item, vars);
    return out;
  }
  return value;
}

export function createReactiveModel(policy, options = {}) {
  validatePolicy(policy);
  const states = new Map();
  const counts = new Map();
  const progress = new Map();
  const stats = { modelRequests: 0, byKind: {}, idleWaits: 0, polls: 0, stateChanges: 0 };
  const maxNoProgress = options.maxNoProgress === undefined ? 3 : options.maxNoProgress;
  if (!Number.isInteger(maxNoProgress) || maxNoProgress < 1) {
    fail('POLICY_INVALID', 'maxNoProgress 必须是正整数');
  }

  // 一轮请求是否"有进展"：状态变了，或者最近一次工具结果的内容变了。
  // 只靠调大 maxUses 会让夹具在同一个点上无限重试；这里把"原地打转"直接
  // 判为失败，让实验以 NO_PROGRESS_LOOP 收场，而不是装成完成。
  function progressSignature(parsed, state) {
    const last = parsed.lastResult;
    const tail = last === null ? 'no-result' : last.toolName + '|' + last.isError + '|' + last.text;
    return state + '||' + tail;
  }

  function stateOf(key) {
    return states.get(key) ?? 'new';
  }

  return {
    policy,
    decide(body) {
      const parsed = parseBody(body);
      const identity = identityOf(parsed);
      const key = sessionKeyOf(parsed, identity);
      const role = roleOf(parsed, identity);
      const state = stateOf(key);
      const facts = factsOf(parsed, identity);

      const signature = progressSignature(parsed, state);
      if (parsed.turnResults.length === 0 && parsed.results.length > 0 && parsed.lastText === '') {
        fail('NO_PROGRESS', key + ': 没有新的工具结果，也没有新的文本，拒绝重复回复');
      }

      for (const rule of policy.rules) {
        if (rule.role !== 'any' && rule.role !== role) continue;
        if (rule.state !== state) continue;
        if (!matches(rule, parsed, state, facts)) continue;
        const used = counts.get(key + '|' + rule.name) ?? 0;
        if (used >= rule.maxUses) continue;

        // 显式标为 progressExempt 的规则是"等别人干活的轮询"：查看状态本身
        // 不改变任何东西，重复是预期的。它的次数由 maxUses 兜住；其余规则
        // 只要在同一个状态上原地重复就按阈值失败。
        //
        // idle-wait 是"结束回合、等下一次唤醒"：它把一次请求花在合法的等待上，
        // 没有工具结果可以比较，所以按种类豁免原地重复，但同样受 maxUses 约束，
        // 并且单独计数——不能被算成推进，也不能被算成轮询。
        const kind = rule.kind ?? 'action';
        const exempt = kind === 'idle-wait' || kind === 'poll' || rule.progressExempt === true;
        if (exempt) {
          progress.set(key, { signature, count: 1 });
        } else {
          const seen = progress.get(key);
          if (seen !== undefined && seen.signature === signature) {
            seen.count += 1;
            if (seen.count > maxNoProgress) {
              fail('NO_PROGRESS_LOOP', key + ': 连续 ' + seen.count + ' 次请求没有任何新的工具结果或状态变化（阈值 ' + maxNoProgress + '）');
            }
          } else {
            progress.set(key, { signature, count: 1 });
          }
        }

        const vars = { ...Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== null)), promptTaskId: facts.promptTaskId };
        let reply;
        try {
          reply = applyTemplates(rule.reply, vars);
        } catch (error) {
          if (error instanceof ReactiveRuleError) throw error;
          throw new ReactiveRuleError('TEMPLATE_UNRESOLVED', String(error && error.message));
        }

        counts.set(key + '|' + rule.name, used + 1);
        if (rule.next !== undefined) states.set(key, rule.next);
        stats.modelRequests += 1;
        stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
        if (kind === 'idle-wait') stats.idleWaits += 1;
        if (kind === 'poll') stats.polls += 1;
        if (rule.next !== undefined) stats.stateChanges += 1;
        return { rule: rule.name, kind, reply, state: stateOf(key), previousState: state, role, sessionKey: key, facts };
      }

      fail('NO_PROGRESS', key + ': state=' + state + ' 下没有可用规则（最近结果 ' +
        (parsed.lastResult === null ? '无' : parsed.lastResult.toolName + ' is_error=' + parsed.lastResult.isError) +
        '，唤醒 ' + String(facts.wakeKind ?? 'n/a') + '）');
      return null;
    },
    stateOf,
    stats() {
      return { ...stats, byKind: { ...stats.byKind } };
    },
    counts() {
      return Object.fromEntries(counts);
    },
    states() {
      return Object.fromEntries(states);
    },
  };
}
