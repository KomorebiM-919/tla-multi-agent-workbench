// Shared, dependency-free validators for the Phase A offline evidence tools.
// Nothing in this module reads a profile, a credential store or a host archive.
import { lstatSync, readFileSync } from 'node:fs';
import { win32, posix } from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export class ContractError extends Error {
  constructor(code, detail, kind = 'data') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ContractError';
    this.code = code;
    this.kind = kind;
  }
}

export class IoError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'IoError';
    this.code = code;
  }
}

export function fail(code, detail, kind = 'data') {
  throw new ContractError(code, detail, kind);
}

export function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function fields(value, required, label = 'object') {
  if (!plainObject(value)) fail('OBJECT_INVALID', label);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('FIELDS_INVALID', `${label} expected ${expected.join(',')}; got ${actual.join(',')}`);
  }
}

export function stringValue(value, code = 'TEXT_INVALID', max = 1024) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    fail(code, `expected a non-empty string <=${max} characters`);
  }
  return value;
}

export function idValue(value, code = 'ID_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    fail(code, 'expected a non-empty identifier <=128 characters');
  }
  return value;
}

export function hashValue(value, code = 'HASH_INVALID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(code, 'expected lowercase 64-character SHA-256');
  }
  return value;
}

export function safeInt(value, code, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(code, `expected an integer >=${minimum}`);
  return value;
}

export function stringArray(value, code = 'LIMITATIONS_INVALID') {
  if (!Array.isArray(value)) fail(code, 'expected an array');
  for (const item of value) {
    if (typeof item !== 'string') fail(code, 'expected only strings');
  }
  return value;
}

export function assertJsonValue(value, seen = new Set(), depth = 0) {
  if (depth > MAX_JSON_DEPTH) fail('JSON_DEPTH_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSON_NUMBER_INVALID');
    return;
  }
  if (!plainObject(value) && !Array.isArray(value)) fail('JSON_VALUE_INVALID');
  if (seen.has(value)) fail('JSON_CYCLE');
  const prototype = Object.getPrototypeOf(value);
  if (!(Array.isArray(value) ? prototype === Array.prototype : plainObject(value))) {
    fail('JSON_VALUE_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 ||
      !Object.entries(descriptors).every(([key, descriptor]) =>
        Object.hasOwn(descriptor, 'value') && (descriptor.enumerable || (Array.isArray(value) && key === 'length')))) {
    fail('JSON_ACCESSOR_INVALID');
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length ||
        !Object.keys(value).every((key, index) => key === String(index))) fail('JSON_ARRAY_INVALID');
  }
  seen.add(value);
  for (const key of Object.keys(value)) assertJsonValue(descriptors[key].value, seen, depth + 1);
  seen.delete(value);
}

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readRegularFile(path, maxBytes = MAX_ENTRY_BYTES) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new IoError('FILE_UNREADABLE', `${path}: ${error.code ?? error.message}`);
  }
  if (stat.isSymbolicLink()) fail('SYMLINK_REJECTED', path);
  if (!stat.isFile()) fail('NOT_A_REGULAR_FILE', path);
  if (stat.size > maxBytes) fail('FILE_TOO_LARGE', `${path}: ${stat.size} > ${maxBytes}`);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new IoError('FILE_UNREADABLE', `${path}: ${error.code ?? error.message}`);
  }
  return { bytes, stat };
}

export function decodeUtf8(bytes, code = 'UTF8_INVALID') {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

export function readJsonFile(path, maxBytes = MAX_JSON_BYTES) {
  const { bytes } = readRegularFile(path, maxBytes);
  const text = decodeUtf8(bytes, 'JSON_UTF8_INVALID');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail('JSON_INVALID', error.message);
  }
  assertJsonValue(value);
  return { value, bytes };
}

export function relativePathValue(value, { reservedManifest = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    fail('RELATIVE_PATH_INVALID', 'expected a non-empty string <=1024 characters');
  }
  if (/[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\')) {
    fail('RELATIVE_PATH_INVALID', 'control characters and backslashes are not allowed');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.startsWith('//')) {
    fail('RELATIVE_PATH_INVALID', 'absolute, drive and UNC paths are not allowed');
  }
  if (value.endsWith('/')) fail('RELATIVE_PATH_INVALID', 'trailing slash is not allowed');
  const components = value.split('/');
  if (components.some((part) => part === '' || part === '.' || part === '..' ||
      part.includes(':') || /[. ]$/u.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) {
    fail('RELATIVE_PATH_INVALID', 'dot, empty, alternate-stream or reserved component');
  }
  if (reservedManifest && components.some((part) => pathKey(part) === 'manifest.json')) {
    fail('RELATIVE_PATH_INVALID', 'manifest.json is reserved in any case and at any prefix');
  }
  return components.join('/');
}

export function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function lineCount(text) {
  return text.split('\n').length;
}

export function canonicalRelative(value, options) {
  const normalized = relativePathValue(value, options);
  return { value: normalized, key: pathKey(normalized) };
}

export function validateArrayLimit(value, maximum, code) {
  if (!Array.isArray(value)) fail(code, 'expected an array');
  if (value.length > maximum) fail(code, `${value.length} > ${maximum}`);
  return value;
}

export function checkLocalPath(raw, label = 'sourcePath') {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 4096) {
    fail('LOCAL_PATH_INVALID', label);
  }
  if (/[\u0000-\u001f\u007f]/u.test(raw)) fail('LOCAL_PATH_INVALID', label);
  return raw;
}

export function pathModuleFor(raw) {
  return /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('\\\\') ? win32 : posix;
}

export function readStableSource(path, maxBytes) {
  const first = readRegularFile(path, maxBytes);
  const before = first.stat;
  const firstHash = hashBytes(first.bytes);
  const second = readRegularFile(path, maxBytes);
  const after = second.stat;
  const secondHash = hashBytes(second.bytes);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino || firstHash !== secondHash) {
    fail('SOURCE_CHANGED_DURING_CAPTURE', path);
  }
  return { bytes: first.bytes, sha256: firstHash, stat: after };
}
