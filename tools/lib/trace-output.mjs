// Output path safety for offline trace/report files. Uses the same reparse
// point rule as the existing evidence tools; no lexical-only fallback.
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export class OutputPathError extends Error {
  constructor(detail) { super(detail); this.name = 'OutputPathError'; this.code = 'OUTPUT_PATH_UNSAFE'; }
}

function decodeFsutil(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8');
  try { return new TextDecoder('gbk', { fatal: false }).decode(bytes); }
  catch { return bytes.toString('utf8'); }
}

function reparse(path) {
  const result = spawnSync('fsutil', ['reparsepoint', 'query', path], { windowsHide: true });
  if (result.error || typeof result.status !== 'number') return { available: false };
  const text = decodeFsutil(Buffer.concat([
    Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0)
  ]));
  if (result.status !== 0) {
    if (/not a reparse point|不是.{0,4}重分析点/iu.test(text)) return { available: true, reparse: false };
    return { available: false };
  }
  const tag = text.match(/0x[0-9a-f]{8}/iu)?.[0]?.toLowerCase() ?? null;
  if (tag === null) return { available: false };
  return { available: true, reparse: true, tag };
}

function check(path, label, reparseProbe) {
  let info;
  try { info = lstatSync(path); }
  catch (error) { throw new OutputPathError(`${label} cannot be inspected: ${error.message}`); }
  if (info.isSymbolicLink()) throw new OutputPathError(`${label} is a symbolic link`);
  const probe = reparseProbe(path);
  if (!probe || probe.available !== true) throw new OutputPathError(`${label} reparse probe unavailable`);
  if (probe.reparse) throw new OutputPathError(`${label} is a reparse point`);
  try {
    const resolved = realpathSync(path);
    const actual = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const expected = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (actual !== expected) throw new OutputPathError(`${label} resolves elsewhere`);
  } catch (error) {
    if (error instanceof OutputPathError) throw error;
    throw new OutputPathError(`${label} cannot be resolved: ${error.message}`);
  }
}

export function assertFreshOutputPath(file, { reparseProbe = reparse } = {}) {
  const target = resolve(file);
  if (existsSync(target)) throw new OutputPathError('output already exists');
  const parent = dirname(target);
  if (!existsSync(parent)) throw new OutputPathError('output parent does not exist');
  let cursor = parent;
  for (;;) {
    check(cursor, 'output ancestor', reparseProbe);
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return target;
}

export function assertInputFile(file) {
  const target = resolve(file);
  let info;
  try { info = statSync(target); }
  catch (error) { throw new OutputPathError(`input cannot be read: ${error.message}`); }
  if (!info.isFile()) throw new OutputPathError('input is not a regular file');
  return target;
}
