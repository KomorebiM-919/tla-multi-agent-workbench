// Output path safety for offline trace/report files. Uses the same reparse
// point rule as the existing evidence tools; no lexical-only fallback.
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export class OutputPathError extends Error {
  constructor(detail) { super(detail); this.name = 'OutputPathError'; this.code = 'OUTPUT_PATH_UNSAFE'; }
}

function reparse(path) {
  const result = spawnSync('fsutil', ['reparsepoint', 'query', path], { windowsHide: true, encoding: 'utf8' });
  if (result.error || typeof result.status !== 'number') return { available: false };
  if (result.status !== 0) {
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (/not a reparse point|不是重分析点/iu.test(text)) return { available: true, reparse: false };
    return { available: false };
  }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tag = text.match(/0x[0-9a-f]{8}/iu)?.[0]?.toLowerCase() ?? null;
  return { available: true, reparse: tag !== null, tag };
}

function check(path, label) {
  let info;
  try { info = lstatSync(path); }
  catch (error) { throw new OutputPathError(`${label} cannot be inspected: ${error.message}`); }
  if (info.isSymbolicLink()) throw new OutputPathError(`${label} is a symbolic link`);
  const probe = reparse(path);
  if (probe.available && probe.reparse) throw new OutputPathError(`${label} is a reparse point`);
  // If fsutil cannot run in this sandbox, realpath is still a physical check:
  // a junction resolves elsewhere, while a normal directory resolves to itself.
  let resolved;
  try { resolved = realpathSync(path); }
  catch (error) { throw new OutputPathError(`${label} cannot be resolved: ${error.message}`); }
  const same = process.platform === 'win32'
    ? resolved.toLowerCase() === resolve(path).toLowerCase()
    : resolved === resolve(path);
  if (!same) throw new OutputPathError(`${label} resolves elsewhere`);
}

export function assertFreshOutputPath(file) {
  const target = resolve(file);
  if (existsSync(target)) throw new OutputPathError('output already exists');
  const parent = dirname(target);
  if (!existsSync(parent)) throw new OutputPathError('output parent does not exist');
  let cursor = parent;
  for (;;) {
    check(cursor, 'output ancestor');
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
