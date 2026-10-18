// 宿主"读后写"契约的最小模型（不是宿主实现）。
//
// 依据（只读抽取，未改安装目录）：
//   - `@deepseek-ai/dsh-fs-observation-policy/lib/index.js`
//       owner = actor.agent.session；`writeIntent` = 未观察 → createIfAbsent，
//       已观察 present → replaceIfVersion(version)；`editIntent` 未观察 → FS_NOT_OBSERVED；
//       `observe` 记录 present(version) / absent。
//   - `@deepseek-ai/dsh-fs-local/lib/index.js`
//       targetKey = realpath(displayPath)（缺失目标取 realpath(最近存在祖先)+后缀）；
//       version = `dev:ino:size:mtimeNs:ctimeNs`。
//   - `@deepseek-ai/dsh-tool-fs/lib/index.js`
//       FS_NOT_OBSERVED → `cannot modify "<path>": file has not been read — read the file, then retry`；
//       FS_STALE_VERSION → 原文追加 `— re-read the file, then retry`。
//
// 这些行号对应 DSH 0.2.0-rc.2 随包文件；模型只用来检验"我们的夹具假设"，
// 用它下结论时也只能说"与契约一致/不一致"，不能冒充宿主实测。

import { normalize, sep } from 'node:path';

/** Canonical key as the host derives it: realpath for an existing file. */
function targetKeyFor(realpathOf, displayPath) {
  return normalize(realpathOf(displayPath));
}

export const CODES = Object.freeze({
  unobserved: 'FS_NOT_OBSERVED',
  stale: 'FS_STALE_VERSION',
  notFound: 'FS_NOT_FOUND',
  exists: 'FS_ALREADY_EXISTS',
});

export class ObservationModel {
  /** @param {{ realpathOf: (path: string) => string }} options */
  constructor({ realpathOf }) {
    this.realpathOf = realpathOf;
    /** @type {Map<object, Map<string, {kind:'present'|'absent', version?:string}>>} */
    this.byOwner = new Map();
  }

  keyOf(displayPath) {
    return targetKeyFor(this.realpathOf, displayPath);
  }

  record(owner, displayPath, observation) {
    if (!owner) return; // no session → read freely but can never satisfy a guarded write
    let byTarget = this.byOwner.get(owner);
    if (!byTarget) {
      byTarget = new Map();
      this.byOwner.set(owner, byTarget);
    }
    byTarget.set(this.keyOf(displayPath), observation);
  }

  prior(owner, displayPath) {
    return this.byOwner.get(owner)?.get(this.keyOf(displayPath));
  }

  /** A successful read records the version the host computed at that moment. */
  read(owner, { displayPath, exists, version }) {
    if (!exists) {
      this.record(owner, displayPath, { kind: 'absent' });
      return { ok: true, absent: true };
    }
    this.record(owner, displayPath, { kind: 'present', version });
    return { ok: true, version };
  }

  /** A failed read records nothing: the host only observes authoritative presence/absence. */
  failedRead() {
    return { ok: false };
  }

  write(owner, { displayPath, exists, version }) {
    const prior = owner ? this.prior(owner, displayPath) : undefined;
    if (exists && prior === undefined) {
      return { ok: false, code: CODES.unobserved, message: `cannot modify "${displayPath}": file has not been read — read the file, then retry` };
    }
    if (prior !== undefined && prior.kind === 'absent' && exists) {
      return { ok: false, code: CODES.exists, message: `cannot create "${displayPath}": the file appeared after it was observed absent` };
    }
    if (prior !== undefined && prior.kind === 'present') {
      if (prior.version !== version) {
        return { ok: false, code: CODES.stale, message: `cannot modify "${displayPath}": the file changed since it was read — re-read the file, then retry` };
      }
      return { ok: true, written: true };
    }
    return { ok: true, written: true };
  }
}

/** Windows-style path spellings that must collapse to one key. */
export function collapseSpelling(path, cwd = 'C:\\work') {
  let out = path.replace(/\//g, sep);
  if (!/^[A-Za-z]:/.test(out)) out = cwd + sep + out;
  return normalize(out);
}
