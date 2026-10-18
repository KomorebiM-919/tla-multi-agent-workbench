// 用脱敏后的真实请求体回放固定策略。
//
// 它检查三件事：
//   1. 夹具完整性：MANIFEST 里的 sha256 与文件内容一致，且不含主机路径 / 用户名 / 团队名；
//   2. 回放可复算：14 条真实请求体按顺序喂给策略，每条都能得到明确判定（命中规则，
//      或在额度边界上明确报 NO_PROGRESS），没有"不知道该怎么办"的沉默；
//   3. 关键结构没被脱敏破坏：建队 → 轮询 → 认领 → 开工 → 读源码 → 读 note → 写失败回读。
//
// 它**不**证明宿主下一次会这样发请求，也不证明写文件在宿主里能成功。那是实验包的事。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReactiveModel } from './lib/reactive-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'repair-protocol');
const POLICY = JSON.parse(readFileSync(join(HERE, 'fixtures', 'repair-loop-policy.v2.json'), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(join(DIR, 'MANIFEST.json'), 'utf8'));

const failures = [];
let checks = 0;
function check(condition, label, detail = '') {
  checks += 1;
  if (!condition) failures.push(label + (detail === '' ? '' : ' — ' + String(detail)));
}

// ---------------------------------------------------------------- 夹具完整性

// 本地账号名故意不写进这个文件：它本身就是要防止外泄的标识符。
const LEAKS = [
  [/[A-Za-z]:\\\\/u, 'drive-letter path'],
  [/C:\\\\Users/u, 'user profile path'],
  [/tla-run-/u, 'raw run id'],
  [/closure\d/iu, 'raw team name'],
  [/system-reminder/u, 'harness reminder'],
  [/available_skills/u, 'skills catalog'],
];

for (const entry of MANIFEST.files) {
  const text = readFileSync(join(DIR, entry.file), 'utf8');
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  check(digest === entry.sha256, `${entry.file} matches its manifest hash`, digest.slice(0, 12));
  check(Buffer.byteLength(text, 'utf8') === entry.bytes, `${entry.file} has the recorded size`, Buffer.byteLength(text, 'utf8'));
  for (const [pattern, label] of LEAKS) {
    check(!pattern.test(text), `${entry.file} has no ${label}`);
  }
}

// ---------------------------------------------------------------- 回放

const model = createReactiveModel(POLICY, { maxNoProgress: 3 });
const replay = [];
for (const entry of MANIFEST.files) {
  const body = JSON.parse(readFileSync(join(DIR, entry.file), 'utf8'));
  try {
    const decision = model.decide(body);
    replay.push({ file: entry.file, rule: decision.rule, role: decision.role, state: decision.state });
  } catch (error) {
    replay.push({ file: entry.file, rule: null, error: error.code, message: error.message });
  }
}

const surfaced = replay.filter((row) => row.rule !== null);
check(surfaced.length >= 13, 'almost every recorded request maps to a rule', surfaced.length + '/' + replay.length);
check(
  replay.every((row) => row.rule !== null || row.error === 'NO_PROGRESS'),
  'every request either matches a rule or ends the round explicitly',
  replay.filter((row) => row.rule === null && row.error !== 'NO_PROGRESS').map((row) => row.file + ':' + row.error).join(','),
);

const rules = new Set(surfaced.map((row) => row.rule));
const structural = [
  'captain-creates-team',
  'captain-polls-after-create',
  'worker-claims-task',
  'worker-starts-task',
  'worker-reads-source',
  'worker-reads-note-before-write',
  'worker-preflight-write-failed',
];
for (const name of structural) {
  check(rules.has(name), `the replay reaches ${name}`, [...rules].join(','));
}

// 第 11 条是"写 note 被宿主拒绝"的真实请求：必须走回读分支，而不是原地重写
const eleventh = replay.find((row) => row.file === 'request-011.json');
check(eleventh !== undefined && eleventh.rule === 'worker-preflight-write-failed', 'the refused write goes back to a read', eleventh && (eleventh.rule || eleventh.error));

// 最后一条是队长轮询额度用完：必须明确结束，而不是永远轮询
const last = replay[replay.length - 1];
check(last !== undefined && (last.rule !== null || last.error === 'NO_PROGRESS'), 'the replay ends within the poll budget', last && (last.rule || last.error));

process.stdout.write(`v02-repair-protocol: ${checks} checks, ${failures.length} failures\n`);
for (const failure of failures) process.stdout.write('  FAIL ' + failure + '\n');
if (failures.length > 0) process.exitCode = 1;
