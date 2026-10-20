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
  // A real assertion failure outranks an environment block: the caller must not
  // lose a product regression behind an unavailable fixture.
  const status = counts.fail > 0
    ? STATUS.FAIL
    : counts.environmentBlocked > 0
      ? STATUS.ENVIRONMENT_BLOCKED
      : STATUS.PASS;
  const exitCode = counts.fail > 0 ? 1 : counts.environmentBlocked > 0 ? 2 : 0;
  return { status, exitCode, counts, cases };
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

async function executeCase(def, context) {
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
  if (context.residual.length > 0) {
    result = blocked(
      def.id,
      'cleanup',
      `temporary container cleanup left: ${context.residual.join(', ')}`,
      result.capability ?? null,
      { errorCode: 'CLEANUP_RESIDUAL' }
    );
  }
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
        if (child.error) {
          return blocked('synthetic-lstat', 'capability', `synthetic child unavailable: ${child.error.code ?? child.error.message}`, capability, { errorCode: child.error.code ?? null, synthetic: true });
        }
        if (child.status === null) {
          return blocked('synthetic-lstat', 'capability', 'synthetic child timed out', capability, { errorCode: 'ETIMEDOUT', synthetic: true });
        }
        if (child.status !== 0) {
          return fail('synthetic-lstat', 'product', `synthetic child exited ${child.status}: ${child.stderr}`, { capability });
        }
        let report;
        try {
          report = JSON.parse(child.stdout);
        } catch (error) {
          return fail('synthetic-lstat', 'product', `synthetic child returned non-JSON: ${error.message}`, { capability });
        }
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

// The checkout and OS-temp cases both create a container; this wrapper lets the
// caller choose a different root for the OS-temp case without editing the case.
function createContext(scratchRoot) {
  const residual = [];
  return {
    residual,
    scratch(base = scratchRoot) {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, 'case-'));
    },
    ensureRoot(base) {
      mkdirSync(base, { recursive: true });
    },
    cleanup(dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        residual.push(`${dir}:${error.code ?? error.message}`);
        return;
      }
      if (existsSync(dir)) residual.push(dir);
    }
  };
}

export async function runMigrationLinkSuite(options = {}) {
  const scratchRoot = options.scratchRoot
    ?? process.env.TLA_LINK_TEST_ROOT
    ?? DEFAULT_CHECKOUT_ROOT;
  const context = createContext(scratchRoot);
  const results = [];
  for (const definition of cases) {
    if (definition.id === 'volume-os-temp') {
      // Run this case only after the checkout case so one bad volume does not
      // hide the other volume's result.
      results.push(await executeCase(definition, context));
    } else {
      results.push(await executeCase(definition, context));
    }
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
    ...summary
  };
}

export function formatReport(report) {
  const lines = [];
  for (const item of report.cases) {
    const suffix = item.synthetic ? ' [synthetic]' : '';
    const code = item.errorCode ? ` code=${item.errorCode}` : '';
    lines.push(`${item.status} ${item.id}${suffix} stage=${item.stage}${code}`);
    lines.push(`  ${item.detail}`);
  }
  lines.push(`SUMMARY ${report.status} pass=${report.counts.pass} fail=${report.counts.fail} environmentBlocked=${report.counts.environmentBlocked} syntheticPass=${report.counts.syntheticPass}`);
  lines.push(`EXIT ${report.exitCode}`);
  return lines.join('\n');
}
