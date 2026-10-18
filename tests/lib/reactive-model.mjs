// 反应式假模型的响应引擎（正式测试用）。
//
// 这套规则只根据**真实工具结果里的字面内容**决定下一步回复，因此它不能
// 替测试宣布成功：规则只能选择"发哪个工具调用"，不能伪造工具输出。
// 任何无法归类的输入都抛错（调用方据此返回 500），不默认返回成功。

export const REACTIVE_SCHEMA = 'tla.reactive-model/v1';

export class ReactiveRuleError extends Error {
  constructor(code, detail) {
    super(code + ': ' + detail);
    this.code = code;
    this.detail = detail;
  }
}

const KNOWN_MATCHERS = new Set([
  'lastToolContains',
  'lastToolExcludes',
  'lastMessageContains',
  'lastMessageExcludes',
  'wholeContains',
  'wholeExcludes',
  'factsPresent',
  'noToolResult',
  'toolCountAtLeast',
  'toolCountAtMost',
]);

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new ReactiveRuleError('POLICY_INVALID', 'policy.rules must be a non-empty array');
  }
  const seen = new Set();
  for (const [index, rule] of policy.rules.entries()) {
    const where = 'rules[' + index + ']';
    if (typeof rule.name !== 'string' || rule.name.length === 0) throw new ReactiveRuleError('POLICY_INVALID', where + '.name must be a non-empty string');
    if (seen.has(rule.name)) throw new ReactiveRuleError('POLICY_INVALID', where + '.name is duplicated: ' + rule.name);
    seen.add(rule.name);
    for (const key of Object.keys(rule.match || {})) {
      if (!KNOWN_MATCHERS.has(key)) throw new ReactiveRuleError('POLICY_INVALID', where + '.match.' + key + ' is not a supported matcher');
    }
    if (rule.maxUses !== undefined && (!Number.isInteger(rule.maxUses) || rule.maxUses < 1)) {
      throw new ReactiveRuleError('POLICY_INVALID', where + '.maxUses must be a positive integer');
    }
    if (rule.reply === undefined && rule.replyWith === undefined) throw new ReactiveRuleError('POLICY_INVALID', where + ' has neither reply nor replyWith');
  }
  if (!policy.rules.some((rule) => rule.terminal === true)) {
    throw new ReactiveRuleError('POLICY_INVALID', 'policy must declare at least one terminal rule');
  }
  return policy;
}

export function contextOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.length === 0 ? null : messages[messages.length - 1];
  const toolResult = last === null || !Array.isArray(last.content) ? null : last.content.find((part) => part?.type === 'tool_result');
  const text = toolResult === undefined || toolResult === null ? '' : String(toolResult.content ?? '');
  return {
    whole: JSON.stringify(body ?? null),
    lastRole: last?.role ?? null,
    lastText: last === null ? '' : String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '')),
    toolText: text,
    hasToolResult: text.length > 0,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
  };
}

// attempt_id 只在工具结果里出现，而且是 UUID；派工消息里的 "attempt t1 attempt 1"
// 没有 UUID，所以这里只取 UUID 形态的那个。
export function factsOf(context) {
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const attemptMatch = context.whole.match(/"attempt_id"\s*:\s*"([^"]+)"/) || context.whole.match(uuid);
  const taskMatch = context.toolText.match(/Task:\s*([A-Za-z]\d+)/i) || context.toolText.match(/t\d+/i) || context.whole.match(/"taskId"\s*:\s*"([^"]+)"/);
  return {
    attemptId: attemptMatch === null ? null : attemptMatch[1],
    taskId: taskMatch === null ? null : String(taskMatch[1] ?? taskMatch[0]).toLowerCase(),
  };
}

function matches(rule, context, facts) {
  const match = rule.match || {};
  if (match.lastToolContains !== undefined && !context.toolText.includes(match.lastToolContains)) return false;
  if (match.lastToolExcludes !== undefined && context.toolText.includes(match.lastToolExcludes)) return false;
  if (match.lastMessageContains !== undefined && !context.lastText.includes(match.lastMessageContains)) return false;
  if (match.lastMessageExcludes !== undefined && context.lastText.includes(match.lastMessageExcludes)) return false;
  if (match.wholeContains !== undefined && !context.whole.includes(match.wholeContains)) return false;
  if (match.wholeExcludes !== undefined && context.whole.includes(match.wholeExcludes)) return false;
  if (match.factsPresent !== undefined && Boolean(facts[match.factsPresent]) !== true) return false;
  if (match.noToolResult === true && context.hasToolResult) return false;
  if (match.toolCountAtLeast !== undefined && context.toolCount < match.toolCountAtLeast) return false;
  if (match.toolCountAtMost !== undefined && context.toolCount > match.toolCountAtMost) return false;
  return true;
}

export function createReactiveModel(policy) {
  validatePolicy(policy);
  const counts = new Map();

  return {
    policy,
    // 返回 {rule, reply}；没有规则匹配或多轮无进展时抛错，调用方必须把它
    // 当成失败（HTTP 500），不能退化成"返回成功"。
    decide(body) {
      const context = contextOf(body);
      const facts = factsOf(context);
      for (const rule of policy.rules) {
        if (!matches(rule, context, facts)) continue;
        const used = counts.get(rule.name) ?? 0;
        if (rule.maxUses !== undefined && used >= rule.maxUses) continue;
        counts.set(rule.name, used + 1);
        return { rule: rule.name, reply: rule.reply ?? rule.replyWith, used: used + 1, facts };
      }
      throw new ReactiveRuleError('NO_PROGRESS', 'no rule matched the current tool result; refusing to answer with a success');
    },
    counts() {
      return Object.fromEntries(counts);
    },
  };
}
