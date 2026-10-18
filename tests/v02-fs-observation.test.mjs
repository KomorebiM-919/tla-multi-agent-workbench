// 读后写契约的离线检查（不启动宿主、不碰真实文件）。
//
// 目的：把 closure/run4 里"明明读过还是被拒"这件事查清楚，并把契约的边界钉住：
//   同会话 + 同一 realpath + 同一版本 才允许覆盖；
//   不同路径写法、跨会话、读失败、读后文件变化 各自的结果是什么。
//
// 模型来自宿主随包源码（见 tests/lib/observation-model.mjs 顶部引用），
// 断言的是"我们的夹具假设与契约一致"，不是宿主实测。

import { ObservationModel, CODES, collapseSpelling } from './lib/observation-model.mjs';

const failures = [];
let checks = 0;
function check(condition, label, detail = '') {
  checks += 1;
  if (!condition) failures.push(label + (detail === '' ? '' : ' — ' + String(detail)));
}

const ROOT = 'C:\\work\\project';
const NOTE = ROOT + '\\src\\note.txt';
const SUM = ROOT + '\\src\\sum.mjs';

// A pretend realpath: case-insensitive on Windows, resolves . and ..
function realpathOf(path) {
  return collapseSpelling(path).toLowerCase().replace(/\\+$/, '');
}

function model() {
  return new ObservationModel({ realpathOf });
}

// ---------------------------------------------------------------- run4 的真实顺序
{
  const m = model();
  const session = { id: 'worker-session' };
  const version = 'dev:1:ino:10:100:100';

  // 记录到的顺序：读了 sum.mjs，然后直接写 note.txt —— note.txt 从未被读。
  m.read(session, { displayPath: SUM, exists: true, version });
  const refused = m.write(session, { displayPath: NOTE, exists: true, version: 'dev:1:ino:20:200:200' });
  check(refused.ok === false && refused.code === CODES.unobserved, 'writing a file this session never read is refused', refused.code);
  check(/has not been read/.test(refused.message), 'the refusal is the host message we captured', refused.message.slice(0, 60));

  // 补上读之后，同一会话的写才被允许。
  m.read(session, { displayPath: NOTE, exists: true, version: 'dev:1:ino:20:200:200' });
  const allowed = m.write(session, { displayPath: NOTE, exists: true, version: 'dev:1:ino:20:200:200' });
  check(allowed.ok === true, 'reading the same target first allows the overwrite', JSON.stringify(allowed));
}

// ---------------------------------------------------------------- 路径写法
{
  const m = model();
  const session = { id: 's' };
  const version = 'v1';
  m.read(session, { displayPath: NOTE, exists: true, version });
  const spellings = [
    NOTE,
    NOTE.toLowerCase(),
    ROOT + '\\src\\.\\note.txt',
    ROOT + '\\src\\..\\src\\note.txt',
    NOTE + '\\'.repeat(0),
    'src/note.txt',
    '.\\src\\note.txt',
  ];
  for (const spelling of spellings) {
    const key = m.keyOf(collapseSpelling(spelling, ROOT));
    const sameKey = key === m.keyOf(NOTE);
    check(sameKey, `"${spelling}" resolves to the same target key`, key);
  }
  const allowed = m.write(session, { displayPath: ROOT + '\\src\\.\\note.txt', exists: true, version });
  check(allowed.ok === true, 'a different spelling of the same file is accepted', JSON.stringify(allowed));
}

// ---------------------------------------------------------------- 跨会话
{
  const m = model();
  const a = { id: 'session-a' };
  const b = { id: 'session-b' };
  const version = 'v1';
  m.read(a, { displayPath: NOTE, exists: true, version });
  const cross = m.write(b, { displayPath: NOTE, exists: true, version });
  check(cross.ok === false && cross.code === CODES.unobserved, 'a read in another session does not authorize this one', cross.code);
  check(m.write(null, { displayPath: NOTE, exists: true, version }).code === CODES.unobserved, 'no session at all can never authorize a guarded write');
}

// ---------------------------------------------------------------- 读失败 / 读后变化
{
  const m = model();
  const session = { id: 's' };

  m.failedRead();
  const afterFailed = m.write(session, { displayPath: NOTE, exists: true, version: 'v1' });
  check(afterFailed.ok === false && afterFailed.code === CODES.unobserved, 'a failed read records nothing, so the write is still unobserved', afterFailed.code);

  m.read(session, { displayPath: NOTE, exists: true, version: 'v1' });
  const stale = m.write(session, { displayPath: NOTE, exists: true, version: 'v2' });
  check(stale.ok === false && stale.code === CODES.stale, 'a file changed after the read is stale, not silently overwritten', stale.code);
  check(/re-read/.test(stale.message), 'the stale refusal tells the model to re-read', stale.message.slice(-30));

  // 读缺失 → 记录 absent → 建新文件可以，但如果文件随后出现，不静默覆盖
  const created = m.read(session, { displayPath: ROOT + '\\src\\new.txt', exists: false });
  check(created.ok === true && created.absent === true, 'reading a missing path records confirmed absence');
  check(m.write(session, { displayPath: ROOT + '\\src\\new.txt', exists: true, version: 'v1' }).code === CODES.exists, 'a concurrent creator is not clobbered');
  check(m.write(session, { displayPath: ROOT + '\\src\\new.txt', exists: false }).ok === true, 'the guarded create still works when the path is really absent');
}

// ---------------------------------------------------------------- 结论文字
const summary = '同会话 + 同一 realpath + 同一版本才允许覆盖；跨会话、未读、读后变化都不行。';
check(summary.length > 0, 'summary present');

process.stdout.write(`v02-fs-observation: ${checks} checks, ${failures.length} failures\n`);
for (const failure of failures) process.stdout.write('  FAIL ' + failure + '\n');
if (failures.length > 0) process.exitCode = 1;
