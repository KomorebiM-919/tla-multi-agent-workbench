#!/usr/bin/env node
// orchestration/cli.mjs
//
// TLA V0.2 离线原型命令行。它只做"读配置 / 校验 / 估算 / 出计划 / 翻译成后端入参"，
// 不启动代理、不调用模型、不写证据目录、不安装插件。
//
// 用法：
//   node orchestration/cli.mjs plan --config <config.json> --pricing <snapshot.json> [--host-catalog <catalog.json>] [--now <iso>] [--json]
//   node orchestration/cli.mjs translate --config <config.json> --pricing <snapshot.json> [--out <file>]
//   node orchestration/cli.mjs save --config <config.json> --dir <dir>     # 规范化落盘并回读比对
//
// 退出码：0 = 计划 ready；2 = 计划 blocked（仍会完整打印原因）；1 = 参数/输入错误。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDigest, loadConfigFromFile, saveConfig, validateConfig } from './config.mjs';
import { validateHostCatalog } from './host-catalog.mjs';
import { formatMicro } from './money.mjs';
import { buildPlan } from './plan.mjs';
import { loadSnapshotFromFile } from './pricing.mjs';
import {
  backendStatusForPlan,
  probeAgentTeams,
  translatePlanToAgentTeams,
  workflowScriptBackendStatus,
} from './adapters/agent-teams.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error('无法识别的参数 ' + token);
    const key = token.slice(2);
    if (key === 'json' || key === 'help') {
      args[key] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new Error('参数 ' + token + ' 缺少值');
    args[key] = value;
    i += 1;
  }
  return args;
}

function requireArg(args, key) {
  if (!args[key]) throw new Error('缺少 --' + key);
  return args[key];
}

function backendFromArgs(args, config) {
  const kind = config.backend === null ? 'unknown' : config.backend.kind;
  if (kind === 'agent-teams') {
    const probe = probeAgentTeams({
      hostVersion: args['host-version'],
      pluginInstalled: args['plugin-installed'] === 'true',
      pluginVersion: args['plugin-version'],
      exports: args['plugin-installed'] === 'true' ? ['name', 'inject', 'Config', 'usageSectionText', 'apply'] : [],
      services: args['plugin-installed'] === 'true' ? ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'] : [],
    });
    return backendStatusForPlan(probe);
  }
  if (kind === 'workflow-script') {
    return workflowScriptBackendStatus({ maxAgentCalls: config.backend.task.maxAgentCalls });
  }
  return { kind, status: 'unavailable', reason: 'BACKEND_UNKNOWN', detail: '未知后端' };
}

function loadHostCatalogFrom(args) {
  if (args['host-catalog'] === undefined) return undefined;
  const raw = JSON.parse(readFileSync(path.resolve(args['host-catalog']), 'utf8'));
  return validateHostCatalog(raw);
}

function buildPlanFrom(args) {
  const configResult = loadConfigFromFile(requireArg(args, 'config'));
  const snapshot = loadSnapshotFromFile(requireArg(args, 'pricing'));
  const nowMs = args.now === undefined ? Date.now() : Date.parse(args.now);
  if (!Number.isFinite(nowMs)) throw new Error('--now 不是合法时刻');
  const plan = buildPlan({
    configResult,
    snapshot,
    nowMs,
    backend: backendFromArgs(args, configResult.config),
    hostCatalog: loadHostCatalogFrom(args),
  });
  return { configResult, snapshot, plan };
}

function printPlanSummary(plan) {
  const lines = [];
  lines.push('runId        ' + plan.runId);
  lines.push('status       ' + plan.status);
  lines.push('owner        ' + plan.owner);
  lines.push('pricing      ' + plan.pricing.snapshotId + ' (' + plan.pricing.freshness + ', ' + plan.pricing.ageHours + 'h)');
  lines.push('members');
  for (const member of plan.members) {
    const estimate = member.estimatedMicroMinor === null
      ? 'unknown'
      : formatMicro(plan.currency, member.estimatedMicroMinor.total);
    lines.push('  - ' + member.role + (member.isOwner ? ' (owner)' : '') + ': ' + member.provider + '/' + member.model +
      ' | selection=' + member.selectionSource + ' | ' + member.calls + ' calls | est ' + estimate +
      ' | alloc ' + (member.allocationMicroMinor === null ? '-' : formatMicro(plan.currency, member.allocationMicroMinor)));
  }
  lines.push('totals       estimated ' + (plan.totals.estimatedComplete ? formatMicro(plan.currency, plan.totals.estimatedKnownMicroMinor) : 'incomplete') +
    ' / budget ' + (plan.totals.allocationMicroMinor === null ? '-' : formatMicro(plan.currency, plan.totals.allocationMicroMinor)));
  lines.push('backend      ' + plan.backend.kind + ' -> ' + plan.backend.status + (plan.backend.reason ? ' (' + plan.backend.reason + ')' : ''));
  if (plan.hostCatalog && plan.hostCatalog.provided) {
    lines.push('hostCatalog  ' + plan.hostCatalog.catalogId + ' | unlisted ' + (plan.hostCatalog.unlistedRoles.join(',') || '-') +
      ' | channelMismatch ' + (plan.hostCatalog.channelMismatchRoles.join(',') || '-') +
      ' | priceConflict ' + (plan.hostCatalog.priceConflictRoles.join(',') || '-'));
  } else {
    lines.push('hostCatalog  not provided (host model/channel not checked)');
  }
  lines.push('budgetMode   ' + plan.budgetEnforcement + ' (plan only, not a hard charge)');
  for (const blocker of plan.blockers) lines.push('BLOCKER      ' + blocker.code + (blocker.role ? ' [' + blocker.role + ']' : '') + ': ' + blocker.detail);
  for (const warning of plan.warnings) lines.push('WARNING      ' + warning.code + (warning.role ? ' [' + warning.role + ']' : '') + ': ' + warning.detail);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === undefined || args.help) {
    process.stdout.write('usage: node orchestration/cli.mjs plan|translate|save --config <file> --pricing <file>\n');
    return 0;
  }
  if (args.command === 'plan') {
    const { plan } = buildPlanFrom(args);
    process.stdout.write((args.json ? JSON.stringify(plan, null, 2) : printPlanSummary(plan)) + '\n');
    return plan.status === 'ready' ? 0 : 2;
  }
  if (args.command === 'translate') {
    const { plan, configResult } = buildPlanFrom(args);
    const options = configResult.config.backend && configResult.config.backend.options ? configResult.config.backend.options : {};
    const call = translatePlanToAgentTeams(plan, {
      teamName: options.teamName,
      approval: options.approval,
      tasks: options.tasks,
    });
    const text = JSON.stringify(call, null, 2) + '\n';
    if (args.out) {
      mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      writeFileSync(path.resolve(args.out), text, 'utf8');
      process.stdout.write('wrote ' + path.resolve(args.out) + '\n');
    } else {
      process.stdout.write(text);
    }
    return 0;
  }
  if (args.command === 'save') {
    const dir = requireArg(args, 'dir');
    const configResult = loadConfigFromFile(requireArg(args, 'config'));
    const target = path.join(dir, 'run-config.json');
    const saved = saveConfig(target, configResult.config);
    const reloadedBytes = readFileSync(target);
    const reloaded = loadConfigFromFile(target);
    const fileDigestAfter = createHash('sha256').update(reloadedBytes).digest('hex');
    const configDigestAfter = configDigest(reloaded.config);
    const result = {
      path: saved.path,
      bytes: saved.bytes,
      fileDigest: saved.fileDigest,
      fileDigestAfter,
      configDigest: saved.configDigest,
      configDigestAfter,
      bytesEqual: fileDigestAfter === saved.fileDigest,
      configEqual: configDigestAfter === saved.configDigest,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.bytesEqual && result.configEqual ? 0 : 1;
  }
  // 拒绝未知命令：不静默当作 plan。
  const probe = validateConfig({});
  process.stderr.write('未知命令 ' + args.command + '（校验器仍可用，示例问题: ' + probe.problems[0].code + '）\n');
  return 1;
}

try {
  const code = main();
  process.exitCode = typeof code === 'number' ? code : 0;
} catch (error) {
  process.stderr.write((error.name || 'Error') + ': ' + error.message + '\n');
  process.exitCode = 1;
}
