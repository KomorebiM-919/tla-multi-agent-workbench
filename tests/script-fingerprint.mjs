/**
 * 内联脚本指纹：生成 / 校验 `workflows/three-agent-mvp.js` 的提示词与 schema 指纹。
 *
 * 为什么需要它：workflow 脚本必须以**纯文本**内联进 `workflow` 调用（脚本没有文件系统 API，
 * 无法 `require` 仓库文件）。2000+ 行逐字转录时可能漏行——v0.3-run3 就漏了 `REVIEW_SCHEMA`
 * 里 `issues.items.type`，宿主在第 5 次调用前以"schema 不在支持子集内"拒绝，4 次调用白花。
 *
 * 用法：
 *   node tests/script-fingerprint.mjs            # 打印 JSON（可直接作为 args.selfCheck）
 *   node tests/script-fingerprint.mjs --check    # 打印并跑自检（同一份指纹喂回脚本必须通过，
 *                                                #  篡改必须被拦在启动子代理之前）
 *
 * 指纹算法（driftHash）必须与脚本内部实现逐字节一致：这里是**第二实现**，
 * 之所以让它单独存在，就是为了让"两份实现对同一份文本得出同一个指纹"本身成为可测试的性质。
 */
import { runWith, happyPlan, baseArgs, reviewOk, criteria } from './workflow-harness.mjs';

/** 与 workflows/three-agent-mvp.js 里的 driftHash 完全一致（FNV-1a + djb2 + 长度）。 */
export function driftHash(text) {
  const value = typeof text === 'string' ? text : String(text);
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) + code) >>> 0;
  }
  return h1.toString(16) + '-' + h2.toString(16) + '-' + value.length.toString(16);
}

/** 第 1 轮审核不通过（一条验收项未满足），第 2 轮通过：用来覆盖两轮共 10 次调用的全部提示词。 */
function twoAttemptPlan() {
  return happyPlan({
    review: function (attempt) {
      if (attempt === 1) {
        const checks = criteria(3).map(function (item, index) {
          return index === 2 ? Object.assign({}, item, { satisfied: false, evidence: '未验证' }) : item;
        });
        return reviewOk({ verdict: 'CHANGES_REQUESTED', criteria_check: checks, summary: '第 3 条验收未满足' });
      }
      return reviewOk();
    }
  });
}

/** 采集一次两轮运行收到的全部提示词与 schema，返回 { label: { prompt, schema } }。 */
export async function fingerprints() {
  const captured = [];
  const outcome = await runWith(twoAttemptPlan(), baseArgs({ task: { maxAgentCalls: 8 } }), { capture: captured });
  if (!outcome.result || outcome.result.status !== 'OK') {
    throw new Error('指纹采集失败：基准运行没有通过（status=' + (outcome.result && outcome.result.status) + '）');
  }
  const map = {};
  const labels = [];
  for (const call of captured) {
    if (typeof call.schema === 'undefined') {
      throw new Error('调用 ' + call.label + ' 没有收到 schema：指纹无法固定');
    }
    map[call.label] = {
      prompt: driftHash(call.prompt),
      schema: driftHash(JSON.stringify(call.schema))
    };
    labels.push(call.label);
  }
  return { map: map, labels: labels, callCount: captured.length };
}

/** 构造带指纹自检的运行参数（baseArgs 只透传固定几个键，selfCheck 需显式附加）。 */
function argsWithSelfCheck(selfCheck, required) {
  const args = baseArgs({ task: { maxAgentCalls: 8 } });
  args.selfCheck = selfCheck;
  if (required) { args.selfCheckRequired = true; }
  return args;
}

/** 自检：同一份指纹喂回脚本必须通过；篡改 schema 指纹必须在启动该子代理之前被拦下。 */
export async function selfTest() {
  const failures = [];
  const { map, labels, callCount } = await fingerprints();
  // 两轮 = 5 次（预检/需求/编码/验证/审核）+ 3 次（编码/验证/审核修订），Cache Collector 已删除。
  if (callCount !== 8) { failures.push('两轮运行的调用数应为 8，实际 ' + callCount); }
  if (labels.length !== 8) { failures.push('采集到的 label 数应为 8，实际 ' + labels.length); }

  // 1) 正确的指纹：运行必须通过（同时证明两份 driftHash 实现对同一文本结果一致）。
  const good = await runWith(happyPlan(), argsWithSelfCheck(map, true));
  if (!good.result || good.result.status !== 'OK') {
    failures.push('喂回正确指纹后运行未通过：' + (good.result && good.result.status) +
      '（' + (good.result && good.result.error) + '）');
  }
  if (good.calls.length !== 5) { failures.push('单轮运行应为 5 次调用，实际 ' + good.calls.length); }
  if (!good.result || !good.result.scriptSelfCheck || good.result.scriptSelfCheck.enabled !== true) {
    failures.push('返回值应说明本次运行启用了脚本指纹自检');
  }

  // 2) 篡改 Review 的 schema 指纹：必须在第 5 次调用**之前**中止（只有 4 次调用真正发出）。
  const tampered = Object.assign({}, map);
  tampered['Review Agent'] = { prompt: map['Review Agent'].prompt, schema: 'deadbeef-0-0' };
  const bad = await runWith(happyPlan(), argsWithSelfCheck(tampered, true));
  if (!bad.result || bad.result.status !== 'SCRIPT_DRIFT') {
    failures.push('篡改 schema 指纹后状态应为 SCRIPT_DRIFT，实际 ' + (bad.result && bad.result.status));
  }
  if (bad.calls.length !== 4) {
    failures.push('篡改 Review 指纹后应只发出 4 次调用（Review 未启动），实际 ' + bad.calls.length);
  }
  if (bad.result && String(bad.result.error).indexOf('schema 指纹不一致') === -1) {
    failures.push('SCRIPT_DRIFT 的错误信息没有指出 schema 指纹不一致：' + (bad.result && bad.result.error));
  }

  // 3) 要求比对但完全没给指纹：fail-closed，0 次调用。
  const missing = await runWith(happyPlan(), argsWithSelfCheck({}, true));
  if (!missing.result || missing.result.status !== 'SCRIPT_DRIFT') {
    failures.push('缺少指纹且 selfCheckRequired 时状态应为 SCRIPT_DRIFT，实际 ' + (missing.result && missing.result.status));
  }
  if (missing.calls.length !== 0) {
    failures.push('缺少指纹时应 0 次调用，实际 ' + missing.calls.length);
  }

  // 4) 不提供 selfCheck 的旧调用方式仍然可用（向后兼容，不因自检缺失而失败）。
  const legacy = await runWith(happyPlan(), baseArgs({ task: { maxAgentCalls: 8 } }));
  if (!legacy.result || legacy.result.status !== 'OK') {
    failures.push('未提供 selfCheck 的旧调用方式应仍然通过，实际 ' + (legacy.result && legacy.result.status));
  }
  if (!legacy.result || !legacy.result.scriptSelfCheck || legacy.result.scriptSelfCheck.enabled !== false) {
    failures.push('返回值应如实说明本次运行没有启用脚本指纹自检');
  }
  return failures;
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tests/script-fingerprint.mjs');
if (invokedDirectly) {
  const { map, labels, callCount } = await fingerprints();
  console.log('# 调用数 ' + callCount + '，label ' + labels.length + ' 个');
  console.log(JSON.stringify(map, null, 2));
  if (process.argv.includes('--check')) {
    const failures = await selfTest();
    if (failures.length > 0) {
      console.error('FAIL ' + failures.join(' | '));
      process.exit(1);
    }
    console.log('PASS 指纹自检 4 项');
  }
}
