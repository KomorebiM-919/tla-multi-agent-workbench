// The migration-link suite must distinguish three outcomes:
//   PASS                 the fixture prerequisite held and the audit assertion held;
//   FAIL                 the prerequisite held but a product assertion failed;
//   ENVIRONMENT_BLOCKED  the fixture could not produce the evidence the case needs.
//
// A blocked capability is never a pass. It also never becomes a product failure.
// The caller is responsible for turning this report into exit code 0/1/2.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMigrationLinks, parsePnpmLockEntry } from '../../tools/check-migration-links.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = join(ROOT, 'orchestration', 'interceptor-plugin');
const PLUGIN = 'tla-prelaunch-budget';
const SPEC = 'link:./vendor/interceptor-plugin';
const LOCK_VERSION = 'link:vendor/interceptor-plugin';
const DEFAULT_CHECKOUT_ROOT = join(ROOT, 'tests', '.scratch', 'migration-links');

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ENVIRONMENT_BLOCKED: 'ENVIRONMENT_BLOCKED'
});

const ENVIRONMENT_CODES = new Set([
  'EPERM',
  'EACCES',
  'ENOENT',
  'ENOTDIR',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EBUSY'
]);

class CaseFailure extends Error {}

function errorInfo(error) {
  return { code: error?.code ?? null, message: String(error?.message ?? error) };
}

function isEnvironmentError(error) {
  return ENVIRONMENT_CODES.has(error?.code);
}

export function statusCase(id, status, stage, detail, extra = {}) {
  return { id, status, stage, detail, ...extra };
}

export function summarizeCases(cases) {
  const counts = {
    pass: cases.filter((item) => item.status === STATUS.PASS).length,
    fail: cases.filter((item) => item.status === STATUS.FAIL).length,
    environmentBlocked: cases.filter((item) => item.status === STATUS.ENVIRONMENT_BLOCKED).length,
    syntheticPass: cases.filter((item) => item.status === STATUS.PASS && item.synthetic === true).length
  };
  // counts are case verdicts: each case contributes exactly once. A case can
  // also carry independent diagnostics (assertion failure/block plus cleanup);
  // diagnosticCounts is separate so a FAIL with a cleanup block is still one
  // case and one FAIL in counts.
  const diagnosticCounts = {
    assertionFail: cases.filter((item) => (item.assertion ?? item).status === STATUS.FAIL).length,
    assertionBlocked: cases.filter((item) => (item.assertion ?? item).status === STATUS.ENVIRONMENT_BLOCKED).length,
    cleanupBlocked: cases.filter((item) => Array.isArray(item.cleanupResiduals) && item.cleanupResiduals.length > 0).length,
    cleanupResiduals: cases.reduce((total, item) => total + (item.cleanupResiduals?.length ?? 0), 0)
  };
  // A real assertion failure outranks an environment block: the caller must not
  // lose a product regression behind an unavailable fixture.
  const status = counts.fail > 0
    ? STATUS.FAIL
    : counts.environmentBlocked > 0
      ? STATUS.ENVIRONMENT_BLOCKED
      : STATUS.PASS;
  const exitCode = counts.fail > 0 ? 1 : counts.environmentBlocked > 0 ? 2 : 0;
  return { status, exitCode, counts, diagnosticCounts, cases };
}

function normalizeTarget(value) {
  return resolve(String(value).replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, ''));
}

function targetMatches(capability, expectedTarget) {
  const expected = normalizeTarget(expectedTarget);
  if (capability.realpath?.ok) return normalizeTarget(capability.realpath.value) === expected;
  if (capability.readlink?.ok) return normalizeTarget(capability.readlink.value) === expected;
  return false;
}

export function observeLink(linkPath, expectedTarget) {
  const capability = {
    lstat: null,
    readlink: null,
    realpath: null,
    targetMatches: false
  };
  try {
    const stat = lstatSync(linkPath);
    capability.lstat = {
      ok: true,
      isSymbolicLink: stat.isSymbolicLink(),
      isDirectory: stat.isDirectory()
    };
  } catch (error) {
    capability.lstat = { ok: false, ...errorInfo(error) };
  }
  try {
    capability.readlink = { ok: true, value: readlinkSync(linkPath) };
  } catch (error) {
    capability.readlink = { ok: false, ...errorInfo(error) };
  }
  try {
    capability.realpath = { ok: true, value: realpathSync(linkPath) };
  } catch (error) {
    capability.realpath = { ok: false, ...errorInfo(error) };
  }
  capability.targetMatches = targetMatches(capability, expectedTarget);
  return capability;
}

export function linkEvidence(capability) {
  return Boolean(
    capability?.create?.ok === true &&
    capability.lstat?.ok === true &&
    capability.lstat.isSymbolicLink === true &&
    capability.readlink?.ok === true &&
    capability.realpath?.ok === true &&
    capability.targetMatches === true
  );
}

export function evidenceSummary(capability) {
  if (!capability) return 'no capability observation';
  const parts = [
    `create=${capability.create?.ok ? 'ok' : (capability.create?.code ?? 'failed')}`,
    `lstat=${capability.lstat?.ok ? String(capability.lstat.isSymbolicLink) : (capability.lstat?.code ?? 'failed')}`,
    `readlink=${capability.readlink?.ok ? 'ok' : (capability.readlink?.code ?? 'failed')}`,
    `realpath=${capability.realpath?.ok ? 'ok' : (capability.realpath?.code ?? 'failed')}`,
    `targetMatches=${String(capability.targetMatches === true)}`
  ];
  return parts.join('; ');
}

export function writeProfile(dir, {
  spec = SPEC,
  lockSpecifier = spec,
  lockVersion = LOCK_VERSION,
  linkTarget = join(dir, 'vendor', 'interceptor-plugin'),
  createLink = true
} = {}) {
  mkdirSync(join(dir, 'vendor'), { recursive: true });
  cpSync(SOURCE, join(dir, 'vendor', 'interceptor-plugin'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-profile', private: true, dependencies: { [PLUGIN]: spec } }, null, 2) + '\n'
  );
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      `      ${PLUGIN}:`,
      `        specifier: ${lockSpecifier}`,
      `        version: ${lockVersion}`,
      ''
    ].join('\n')
  );
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  const linkPath = join(dir, 'node_modules', PLUGIN);
  let create = null;
  if (createLink) {
    try {
      symlinkSync(linkTarget, linkPath, 'junction');
      create = { ok: true };
    } catch (error) {
      create = { ok: false, ...errorInfo(error) };
    }
  }
  const capability = observeLink(linkPath, linkTarget);
  capability.create = create;
  return { linkPath, linkTarget, capability };
}

function pass(id, stage, detail, extra = {}) {
  return statusCase(id, STATUS.PASS, stage, detail, extra);
}

function blocked(id, stage, detail, capability, extra = {}) {
  return statusCase(id, STATUS.ENVIRONMENT_BLOCKED, stage, detail, { capability, ...extra });
}

function requireLink(id, capability) {
  if (linkEvidence(capability)) return null;
  return blocked(
    id,
    'capability',
    `the fixture did not expose a link with create+lstat+readlink+realpath evidence (${evidenceSummary(capability)})`,
    capability
  );
}

function fail(id, stage, detail, extra = {}) {
  return statusCase(id, STATUS.FAIL, stage, detail, extra);
}

export function subprocessFailure(id, child) {
  if (child.error) {
    return blocked(id, 'capability', `fixture subprocess unavailable: ${child.error.message}`, null, {
      errorCode: child.error.code ?? null
    });
  }
  if (child.signal) {
    return blocked(id, 'capability', `fixture subprocess terminated by ${child.signal}`, null, {
      errorCode: child.signal
    });
  }
  if (child.status === null) {
    return blocked(id, 'capability', 'fixture subprocess did not complete', null, {
      errorCode: 'ETIMEDOUT'
    });
  }
  if (child.status !== 0) {
    return fail(id, 'product', `fixture subprocess exited ${child.status}`);
  }
  return null;
}

export function parseChildReport(stdout) {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, detail: `fixture child returned non-JSON: ${error.message}` };
  }
}

function addCleanup(result, residuals) {
  const assertion = { status: result.status, stage: result.stage, detail: result.detail };
  const cleanupDiagnostic = {
    status: STATUS.ENVIRONMENT_BLOCKED,
    stage: 'cleanup',
    detail: `temporary container cleanup left: ${residuals.map((item) => item.path).join(', ')}`,
    errorCode: 'CLEANUP_RESIDUAL',
    residuals
  };
  const cleanupDetail = cleanupDiagnostic.detail;
  if (result.status === STATUS.FAIL) {
    return {
      ...result,
      status: STATUS.FAIL,
      detail: `${result.detail}; ${cleanupDetail}`,
      assertion,
      diagnostics: [assertion, cleanupDiagnostic],
      cleanupResiduals: residuals
    };
  }
  return {
    ...result,
    status: STATUS.ENVIRONMENT_BLOCKED,
    stage: 'cleanup',
    detail: result.status === STATUS.PASS ? cleanupDetail : `${result.detail}; ${cleanupDetail}`,
    assertion,
    diagnostics: [assertion, cleanupDiagnostic],
    cleanupResiduals: residuals
  };
}

export async function executeCase(def, context) {
  context.beginCase(def.id);
  let result;
  try {
    result = await def.run(context);
  } catch (error) {
    if (error instanceof CaseFailure) {
      result = fail(def.id, 'product', error.message);
    } else if (isEnvironmentError(error)) {
      result = blocked(def.id, 'setup', `fixture setup failed: ${error.message}`, null, errorInfo(error));
    } else {
      result = fail(def.id, 'product', `unexpected exception: ${error.message}`, errorInfo(error));
    }
  }
  const residuals = context.takeResiduals();
  if (residuals.length > 0) result = addCleanup(result, residuals);
  if (def.synthetic) result = { ...result, synthetic: true };
  return result;
}

function withContainer(context, callback, base = undefined) {
  const dir = context.scratch(base);
  try {
    return callback(dir);
  } finally {
    context.cleanup(dir);
  }
}

function withScratchContainer(context, callback) {
  const container = context.scratch();
  try {
    return callback(container);
  } finally {
    context.cleanup(container);
  }
}

function audit(dir, options = {}) {
  try {
    return auditMigrationLinks({ profile: dir, sourceDir: SOURCE, ...options });
  } catch (error) {
    throw new CaseFailure(`auditMigrationLinks threw: ${error.message}`);
  }
}

function shouldBeRejected(result, id, detail) {
  if (result.ok) return fail(id, 'product', `expected rejection but audit returned ok: ${detail}`);
  if (!result.problems.some((item) => item.id === detail)) {
    return fail(id, 'product', `expected problem ${detail}; got ${result.problems.map((item) => item.id).join(',')}`);
  }
  return null;
}

const cases = [
  {
    id: 'in-profile-link',
    async run(context) {
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir);
        const unavailable = requireLink('in-profile-link', capability);
        if (unavailable) return unavailable;
        writeFileSync(join(dir, 'cordis.yml'), 'plugins:\n  - id: llm-deepseek\n');
        const result = audit(dir, { legacyPath: 'v02-worktree' });
        if (!result.ok) return fail('in-profile-link', 'product', JSON.stringify(result.problems), { capability });
        if (result.checks.length !== 23) return fail('in-profile-link', 'product', `checks=${result.checks.length}`, { capability });
        return pass('in-profile-link', 'product', 'in-profile link passes 23 checks', { capability });
      });
    }
  },
  {
    id: 'external-target',
    async run(context) {
      return withScratchContainer(context, (container) => {
        const dir = join(container, 'profile');
        const outside = join(container, 'outside-plugin');
        cpSync(SOURCE, outside, { recursive: true });
        const { capability } = writeProfile(dir, {
          spec: 'link:../outside-interceptor-plugin',
          lockSpecifier: 'link:../outside-interceptor-plugin',
          lockVersion: 'link:../outside-interceptor-plugin',
          linkTarget: outside
        });
        const unavailable = requireLink('external-target', capability);
        if (unavailable) return unavailable;
        const result = audit(dir);
        const checks = [
          ['manifest:inside-profile', result],
          ['link:inside-profile', result],
          ['lock:inside-profile', result]
        ];
        for (const [problem, value] of checks) {
          const rejected = shouldBeRejected(value, 'external-target', problem);
          if (rejected) return { ...rejected, capability };
        }
        return pass('external-target', 'product', 'external target rejected by all containment checks', { capability });
      });
    }
  },
  {
    id: 'broken-link',
    async run(context) {
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir);
        const unavailable = requireLink('broken-link', capability);
        if (unavailable) return unavailable;
        rmSync(join(dir, 'vendor', 'interceptor-plugin'), { recursive: true, force: true });
        const result = audit(dir);
        for (const problem of ['link:resolves', 'manifest:target-exists']) {
          const rejected = shouldBeRejected(result, 'broken-link', problem);
          if (rejected) return { ...rejected, capability };
        }
        return pass('broken-link', 'product', 'broken link rejected before plugin read', { capability });
      });
    }
  },
  {
    id: 'lock-specifier',
    async run(context) {
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir, { lockSpecifier: 'link:./vendor/other-plugin' });
        const unavailable = requireLink('lock-specifier', capability);
        if (unavailable) return unavailable;
        const result = audit(dir);
        if (result.ok || !result.problems.some((item) => item.id === 'lock:specifier')) {
          return fail('lock-specifier', 'product', `wrong lock specifier was not rejected: ${JSON.stringify(result.problems)}`, { capability });
        }
        return pass('lock-specifier', 'product', 'lock specifier mismatch rejected', { capability });
      });
    }
  },
  {
    id: 'mirror-drift',
    async run(context) {
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir);
        const unavailable = requireLink('mirror-drift', capability);
        if (unavailable) return unavailable;
        appendFileSync(join(dir, 'vendor', 'interceptor-plugin', 'index.js'), '\n// unregistered drift\n');
        const result = audit(dir);
        for (const problem of ['mirror:registered', 'mirror:source-match', 'identity:verified']) {
          const rejected = shouldBeRejected(result, 'mirror-drift', problem);
          if (rejected) return { ...rejected, capability };
        }
        return pass('mirror-drift', 'product', 'mirror drift rejected against registered and source evidence', { capability });
      });
    }
  },
  {
    id: 'legacy-active',
    async run(context) {
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir);
        const unavailable = requireLink('legacy-active', capability);
        if (unavailable) return unavailable;
        writeFileSync(join(dir, '.ignored_tla-prelaunch-budget'), 'old: D:/old/v02-worktree/orchestration\n');
        const clean = audit(dir, { legacyPath: 'v02-worktree' });
        if (!clean.ok) return fail('legacy-active', 'product', 'ignored store was treated as active', { capability, problems: clean.problems });
        writeFileSync(join(dir, 'cordis.yml'), 'pluginRoot: D:/old/v02-worktree/orchestration\n');
        const dirty = audit(dir, { legacyPath: 'v02-worktree' });
        const rejected = shouldBeRejected(dirty, 'legacy-active', 'active:legacy-path');
        if (rejected) return { ...rejected, capability };
        return pass('legacy-active', 'product', 'legacy text active rejection; ignored store excluded', { capability });
      });
    }
  },
  {
    id: 'lock-parser',
    async run() {
      const text = [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        `      ${PLUGIN}:`,
        '        specifier: link:./vendor/interceptor-plugin',
        '        version: link:vendor/interceptor-plugin',
        '      other-plugin:',
        '        specifier: 1.0.0',
        '        version: 1.0.0',
        ''
      ].join('\n');
      const parsed = parsePnpmLockEntry(text, PLUGIN);
      if (JSON.stringify(parsed) !== JSON.stringify({
        specifier: 'link:./vendor/interceptor-plugin',
        version: 'link:vendor/interceptor-plugin'
      })) {
        return fail('lock-parser', 'product', `unexpected parser result: ${JSON.stringify(parsed)}`);
      }
      return pass('lock-parser', 'product', 'lock parser reads only the importer entry');
    }
  },
  {
    id: 'ordinary-directory',
    async run(context) {
      return withContainer(context, (dir) => {
        writeProfile(dir, { createLink: false });
        cpSync(SOURCE, join(dir, 'node_modules', PLUGIN), { recursive: true });
        const result = audit(dir);
        for (const problem of ['link:junction', 'link:matches-manifest']) {
          const rejected = shouldBeRejected(result, 'ordinary-directory', problem);
          if (rejected) return rejected;
        }
        return pass('ordinary-directory', 'product', 'ordinary directory rejected as a link substitute');
      });
    }
  },
  {
    id: 'volume-checkout',
    async run(context) {
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir);
        const unavailable = requireLink('volume-checkout', capability);
        if (unavailable) return unavailable;
        const result = audit(dir);
        if (!result.ok) return fail('volume-checkout', 'product', JSON.stringify(result.problems), { capability });
        return pass('volume-checkout', 'product', 'checkout-volume link passes', { capability });
      });
    }
  },
  {
    id: 'volume-os-temp',
    async run(context) {
      const base = tmpdir();
      context.ensureRoot(base);
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir);
        const unavailable = requireLink('volume-os-temp', capability);
        if (unavailable) return unavailable;
        const result = audit(dir);
        if (!result.ok) return fail('volume-os-temp', 'product', JSON.stringify(result.problems), { capability });
        return pass('volume-os-temp', 'product', 'OS-temp-volume link passes', { capability });
      }, base);
    }
  },
  {
    id: 'synthetic-lstat',
    synthetic: true,
    async run(context) {
      return withContainer(context, (dir) => {
        const { capability } = writeProfile(dir);
        const unavailable = requireLink('synthetic-lstat', capability);
        if (unavailable) {
          return { ...unavailable, synthetic: true };
        }
        const moduleUrl = new URL('../../tools/check-migration-links.mjs', import.meta.url).href;
        const code = `import fs from 'node:fs';
          import {syncBuiltinESMExports} from 'node:module';
          const original=fs.lstatSync;
          fs.lstatSync=(...args)=>{ const stat=original(...args);
            if(String(args[0]).endsWith('tla-prelaunch-budget')) stat.isSymbolicLink=()=>false;
            return stat; };
          syncBuiltinESMExports();
          const {auditMigrationLinks}=await import(${JSON.stringify(moduleUrl)});
          console.log(JSON.stringify(auditMigrationLinks({profile:process.argv[1]})));`;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, dir], {
          encoding: 'utf8',
          timeout: 10000
        });
        const childUnavailable = subprocessFailure('synthetic-lstat', child);
        if (childUnavailable) return { ...childUnavailable, capability, synthetic: true };
        const parsed = parseChildReport(child.stdout);
        if (!parsed.ok) return fail('synthetic-lstat', 'product', parsed.detail, { capability });
        const report = parsed.value;
        if (report.ok !== true) return fail('synthetic-lstat', 'product', JSON.stringify(report.problems), { capability });
        const detail = report.checks.find((item) => item.id === 'link:junction')?.detail ?? '';
        if (!/lstat-link=false; readlink=/.test(detail)) {
          return fail('synthetic-lstat', 'product', `unexpected synthetic detail: ${detail}`, { capability });
        }
        return pass('synthetic-lstat', 'synthetic', 'simulated directory-like lstat; readlink/realpath remain real', { capability, synthetic: true });
      });
    }
  }
];

// Each case gets its own cleanup bucket. The global residual list is for the
// report only; a residual from one case must never turn a later case into BLOCK.
export function createContext(scratchRoot, options = {}) {
  const residual = [];
  let currentCaseId = null;
  let currentResiduals = [];
  function addResidual(dir, error) {
    const entry = {
      caseId: currentCaseId,
      path: dir,
      errorCode: error?.code ?? null,
      message: error?.message ?? 'cleanup left the path behind'
    };
    currentResiduals.push(entry);
    residual.push(entry);
  }
  return {
    residual,
    beginCase(id) {
      currentCaseId = id;
      currentResiduals = [];
    },
    takeResiduals() {
      const items = currentResiduals;
      currentResiduals = [];
      return items;
    },
    scratch(base = scratchRoot) {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, 'case-'));
    },
    ensureRoot(base) {
      mkdirSync(base, { recursive: true });
    },
    cleanup(dir) {
      try {
        if (options.cleanupFailure) options.cleanupFailure(dir);
        else rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        addResidual(dir, error);
        return;
      }
      if (existsSync(dir)) addResidual(dir, null);
    }
  };
}

export async function runMigrationLinkSuite(options = {}) {
  const scratchRoot = options.scratchRoot
    ?? process.env.TLA_LINK_TEST_ROOT
    ?? DEFAULT_CHECKOUT_ROOT;
  const context = createContext(scratchRoot, { cleanupFailure: options.cleanupFailure });
  const definitions = options.cases ?? cases;
  const results = [];
  for (const definition of definitions) {
    results.push(await executeCase(definition, context));
  }
  const summary = summarizeCases(results);
  return {
    schema: 'tla.migration-link-test-report/v1',
    generatedAt: new Date().toISOString(),
    environment: {
      execPath: process.execPath,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    scratchRoot,
    sourceDir: SOURCE,
    cleanupResiduals: context.residual,
    ...summary
  };
}

export function formatReport(report) {
  const lines = [];
  for (const item of report.cases) {
    const suffix = item.synthetic ? ' [synthetic]' : '';
    const code = item.errorCode ? ` code=${item.errorCode}` : '';
    const assertion = item.assertion && item.assertion.status !== item.status
      ? ` assertion=${item.assertion.status}`
      : '';
    const cleanup = item.cleanupResiduals?.length
      ? ` cleanup=${item.cleanupResiduals.length}`
      : '';
    lines.push(`${item.status} ${item.id}${suffix} stage=${item.stage}${code}${assertion}${cleanup}`);
    lines.push(`  ${item.detail}`);
  }
  lines.push(`SUMMARY ${report.status} pass=${report.counts.pass} fail=${report.counts.fail} environmentBlocked=${report.counts.environmentBlocked} syntheticPass=${report.counts.syntheticPass}`);
  lines.push(`DIAGNOSTICS assertionFail=${report.diagnosticCounts.assertionFail} assertionBlocked=${report.diagnosticCounts.assertionBlocked} cleanupBlocked=${report.diagnosticCounts.cleanupBlocked} cleanupResiduals=${report.diagnosticCounts.cleanupResiduals}`);
  lines.push(`EXIT ${report.exitCode}`);
  return lines.join('\n');
}
