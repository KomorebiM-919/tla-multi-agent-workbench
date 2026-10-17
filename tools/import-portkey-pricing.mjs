#!/usr/bin/env node
// tools/import-portkey-pricing.mjs
//
// 从本地 portkey-models 检出生成 TLA 离线价格快照。
//
// 用法（只读源仓库，不联网、不调用模型）：
//   node tools/import-portkey-pricing.mjs \
//     --pricing-dir <portkey-models>/pricing \
//     --commit <40 位 commit> \
//     --captured-at <带时区 ISO 时刻> \
//     --out orchestration/data/<name>.json
//
// 说明：本工具只是把"人已经核对过的少数真实条目"转成快照，不自动追踪上游变化。
//
// --channel 标注这些价格属于哪个**计费渠道**（默认 portkey-pay-as-you-go）。
// portkey 的价格是第三方网关的 pay-as-you-go 报价，不等于 DeepSeek 官方 API 的
// 计费，二者不得因为模型同名而共用一条价格。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildSnapshotFromPortkey } from '../orchestration/importers/portkey.mjs';

const DEFAULT_CHANNEL = 'portkey-pay-as-you-go';

const MODELS = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  moonshot: ['moonshot-v1-8k'],
  zhipu: ['glm-5.2'],
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error('无法识别的参数 ' + token);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('参数 ' + token + ' 缺少值');
    args[key] = value;
    i += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['pricing-dir', 'commit', 'captured-at', 'out']) {
    if (!args[required]) throw new Error('缺少 --' + required);
  }
  if (!/^[0-9a-f]{40}$/.test(args.commit)) throw new Error('--commit 必须是 40 位小写十六进制');
  const pricingDir = resolve(args['pricing-dir']);
  const sources = Object.entries(MODELS).map(([provider, models]) => ({
    filePath: join(pricingDir, provider + '.json'),
    provider,
    models,
  }));
  const snapshot = buildSnapshotFromPortkey({
    sources,
    repository: 'https://github.com/Portkey-AI/models',
    commit: args.commit,
    license: 'MIT',
    capturedAt: args['captured-at'],
    channel: args.channel || DEFAULT_CHANNEL,
    snapshotId: args['snapshot-id'] || 'portkey-' + args.commit.slice(0, 7) + '-pinned',
  });
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  process.stdout.write('wrote ' + outPath + '\nentries: ' + snapshot.entries.length + '\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(error.name + ': ' + error.message + '\n');
  process.exitCode = 1;
}
