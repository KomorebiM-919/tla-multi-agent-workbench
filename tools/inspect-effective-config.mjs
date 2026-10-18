// Reads the configuration the host will actually load — by asking the same CLI the launcher
// asks (`--dump-config`) — and inspects the provider blocks in it. A grep for "apiKeyEnv" in
// the overlay is not enough: the overlay can be right while another patch re-enables a
// provider, and the host resolves credentials per provider instance, not per file.
//
// Reading the dump does not start a session and sends no request; it only asks the CLI to
// print the merged configuration. The launch attempt count is tracked separately.
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fetchEffectiveConfig } from './gated-run.mjs';
import { ACCOUNT_PROVIDERS, BUDGET_PLUGIN_ID, DISABLED_PROVIDERS, FAKE_CREDENTIAL, GUARDED_PROVIDERS } from './overlay-template.mjs';

export const INSPECTION_SCHEMA = 'tla.effective-config-inspection/v1';

const MODEL_PROVIDER_PREFIX = '@deepseek-ai/dsh-llm-';

/** Block scalars (`>-`, `|`) come back as `{ __tagged: 'text', raw }`; everything else is scalar. */
function plain(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value.__tagged === 'text' && typeof value.raw === 'string') return value.raw;
  return value;
}

function configOf(entry) {
  return entry.config === undefined || entry.config === null ? {} : entry.config;
}

function isDisabled(entry) {
  // `disabled: !!js '...'` is a runtime expression: not statically off, so it counts as on.
  return entry.disabled === true;
}

function providerInventory(entries) {
  return entries
    .filter((entry) => typeof entry.name === 'string' && entry.name.startsWith(MODEL_PROVIDER_PREFIX))
    .filter((entry) => entry.name !== '@deepseek-ai/dsh-llm-retry')
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      disabled: isDisabled(entry),
      baseURL: plain(configOf(entry).baseURL),
      apiKeyEnv: plain(configOf(entry).apiKeyEnv),
      providers: plain(configOf(entry).providers)
    }));
}

/**
 * @param {{ dshExe: string, dshCli: string, dshHome: string, profile: string, patches: string[],
 *           gateUrl: string, runId: string, runDir: string, configTimeoutMs?: number,
 *           env?: Record<string, string|undefined> }} spec
 */
export function inspectEffectiveConfig(spec) {
  const env = spec.env === undefined ? process.env : spec.env;
  // The dump is written into the run directory; inspection happens before the launcher runs,
  // so create it here instead of failing with a bare ENOENT.
  mkdirSync(spec.runDir, { recursive: true });
  const config = fetchEffectiveConfig(
    {
      dshExe: spec.dshExe,
      dshCli: spec.dshCli,
      dshHome: spec.dshHome,
      profile: spec.profile,
      patches: spec.patches,
      runId: spec.runId,
      projectCwd: spec.runDir,
      configTimeoutMs: spec.configTimeoutMs
    },
    { runDir: spec.runDir }
  );

  if (config.ok !== true) {
    const detail = config.reason + ': ' + config.detail;
    return {
      schema: INSPECTION_SCHEMA,
      ok: false,
      checks: [{ name: 'config:readable', ok: false, detail }],
      coverage: emptyCoverage(),
      providers: [],
      dump: null,
      problems: ['config:readable: ' + detail]
    };
  }

  const evaluation = evaluateEffectiveConfig({ entries: config.entries, gateUrl: spec.gateUrl, env });
  const checks = [
    {
      name: 'config:readable',
      ok: true,
      detail: basename(config.path) + ', ' + String(config.bytes) + ' bytes, sha256 ' + config.sha256.slice(0, 16) + '…'
    },
    ...evaluation.checks
  ];
  return {
    schema: INSPECTION_SCHEMA,
    ok: checks.every((check) => check.ok),
    checks,
    coverage: evaluation.coverage,
    providers: evaluation.providers,
    dump: { path: config.path, bytes: config.bytes, sha256: config.sha256, binding: config.binding },
    problems: checks.filter((check) => !check.ok).map((check) => check.name + ': ' + check.detail)
  };
}

function emptyCoverage() {
  return { guarded: [], unguarded: [], disabled: [], notConfigured: [], unknown: [] };
}

/**
 * Pure evaluation over already-parsed configuration entries: no CLI, no files, so the rules can
 * be exercised against synthetic dumps in tests and against the real dump before a launch.
 *
 * @param {{ entries: Array<{id: string, name?: string, disabled?: boolean, config?: object}>,
 *           gateUrl: string, env: Record<string, string|undefined> }} input
 */
export function evaluateEffectiveConfig({ entries, gateUrl, env }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const providers = providerInventory(entries);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const coverage = { guarded: [], unguarded: [], disabled: [], notConfigured: [], unknown: [] };
  for (const provider of providers) {
    if (provider.disabled) {
      coverage.disabled.push(provider.id);
    } else if (provider.baseURL === gateUrl) {
      coverage.guarded.push(provider.id);
    } else if (provider.baseURL === null && (provider.providers === null || (Array.isArray(provider.providers) && provider.providers.length === 0))) {
      // An aggregator with no endpoints configured cannot reach a model at all: not a bypass,
      // but it must be named so the reader knows it was looked at.
      coverage.notConfigured.push(provider.id);
    } else if (provider.baseURL === null) {
      coverage.unknown.push(provider.id);
    } else {
      coverage.unguarded.push(provider.id);
    }
  }

  const deepseek = byId.get('llm-deepseek');
  const deepseekConfig = configOf(deepseek === undefined ? {} : deepseek);
  const deepseekBase = plain(deepseekConfig.baseURL);
  const deepseekKeyEnv = plain(deepseekConfig.apiKeyEnv);
  add(
    'provider:llm-deepseek',
    deepseek !== undefined && deepseekBase === gateUrl && deepseekKeyEnv === FAKE_CREDENTIAL.envName,
    deepseek === undefined
      ? 'the effective configuration has no llm-deepseek instance'
      : 'baseURL ' + String(deepseekBase) + ', apiKeyEnv ' + String(deepseekKeyEnv)
  );

  // The credential must be the dedicated placeholder, both by name and by value: a real key
  // exported into the launching shell would otherwise be picked up silently.
  const credentialValue = env[FAKE_CREDENTIAL.envName];
  const credentialLooksFake = typeof credentialValue === 'string' && credentialValue === FAKE_CREDENTIAL.value;
  add(
    'credential:dedicated-fake',
    credentialLooksFake,
    credentialValue === undefined
      ? FAKE_CREDENTIAL.envName + ' is not set in the launching environment'
      : credentialLooksFake
        ? FAKE_CREDENTIAL.envName + ' is the dedicated placeholder'
        : FAKE_CREDENTIAL.envName + ' is set to a value that is not the dedicated placeholder'
  );
  const unexpectedKeyEnv = providers.filter(
    (provider) => !provider.disabled && provider.apiKeyEnv !== null && provider.apiKeyEnv !== FAKE_CREDENTIAL.envName
  );
  add(
    'credential:no-other-env',
    unexpectedKeyEnv.length === 0,
    unexpectedKeyEnv.length === 0
      ? 'no enabled provider reads a different key variable'
      : 'unexpected apiKeyEnv on: ' + unexpectedKeyEnv.map((provider) => provider.id + '=' + String(provider.apiKeyEnv)).join(', ')
  );

  // Account-backed instances would resolve through the interactive login; the experiment must
  // not depend on it, so they have to be off in the loaded configuration.
  const accountOn = ACCOUNT_PROVIDERS.filter((id) => {
    const entry = byId.get(id);
    return entry === undefined || isDisabled(entry) !== true;
  });
  add(
    'channel:account-disabled',
    accountOn.length === 0,
    accountOn.length === 0
      ? ACCOUNT_PROVIDERS.join(' / ') + ' are disabled in the loaded configuration'
      : 'enabled account channel(s): ' + accountOn.join(', ')
  );

  for (const id of GUARDED_PROVIDERS) {
    if (id === 'llm-deepseek') continue;
    const provider = providers.find((candidate) => candidate.id === id);
    add(
      'provider:' + id,
      provider !== undefined && (provider.disabled === true || provider.baseURL === gateUrl),
      provider === undefined
        ? 'missing from the effective configuration'
        : 'baseURL ' + String(provider.baseURL) + ', disabled ' + String(provider.disabled)
    );
  }

  // A provider the experiment does not use has to be off, not merely reachable: an enabled
  // instance could still resolve credentials through the account or hit an unguarded endpoint.
  // Look the entry up by id: web search is not an `@deepseek-ai/dsh-llm-*` adapter, so the
  // provider inventory above deliberately does not carry it.
  for (const id of DISABLED_PROVIDERS) {
    const entry = byId.get(id);
    add(
      'provider:' + id,
      entry !== undefined && isDisabled(entry) === true,
      entry === undefined ? 'missing from the effective configuration' : 'disabled ' + String(isDisabled(entry))
    );
  }

  add(
    'coverage:every-enabled-provider',
    coverage.unguarded.length === 0 && coverage.unknown.length === 0 && coverage.guarded.length > 0,
    'guarded [' + coverage.guarded.join(', ') + '], unguarded [' + coverage.unguarded.join(', ') + '], unknown [' + coverage.unknown.join(', ') + '], disabled [' + coverage.disabled.join(', ') + '], notConfigured [' + coverage.notConfigured.join(', ') + ']'
  );

  // The budget interceptor has to be part of the same loaded configuration; a plugin that is
  // installed but not inserted is exactly the failure mode observed earlier.
  const budget = entries.find((entry) => entry.id === BUDGET_PLUGIN_ID);
  const budgetConfig = configOf(budget === undefined ? {} : budget);
  const budgetRequests = number(plain(budgetConfig.modelRequests));
  add(
    'plugin:budget-inserted',
    budget !== undefined && budgetRequests !== null && budgetRequests > 0 && budgetRequests <= 40,
    budget === undefined
      ? 'no ' + BUDGET_PLUGIN_ID + ' entry in the loaded configuration'
      : 'modelRequests ' + String(plain(budgetConfig.modelRequests)) + ', eventLog ' + String(plain(budgetConfig.eventLog))
  );

  return { checks, coverage, providers };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgv(argv) {
  const spec = { patches: [] };
  const next = (index) => {
    if (argv[index] === undefined) throw new Error(argv[index - 1] + ' requires a value');
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dsh-exe') spec.dshExe = next(++index);
    else if (arg === '--dsh-cli') spec.dshCli = next(++index);
    else if (arg === '--dsh-home') spec.dshHome = next(++index);
    else if (arg === '--profile') spec.profile = next(++index);
    else if (arg === '--patch') spec.patches.push(next(++index));
    else if (arg === '--gate-url') spec.gateUrl = next(++index);
    else if (arg === '--run-id') spec.runId = next(++index);
    else if (arg === '--run-dir') spec.runDir = next(++index);
    else throw new Error('unknown argument: ' + arg);
  }
  for (const key of ['dshExe', 'dshCli', 'dshHome', 'profile', 'gateUrl', 'runId', 'runDir']) {
    if (spec[key] === undefined) throw new Error('--' + key.replace(/[A-Z]/gu, (letter) => '-' + letter.toLowerCase()) + ' is required');
  }
  if (spec.patches.length === 0) throw new Error('--patch is required');
  return spec;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = inspectEffectiveConfig(parseArgv(process.argv.slice(2)));
    for (const check of report.checks) {
      process.stderr.write('inspect: ' + (check.ok ? 'ok   ' : 'FAIL ') + check.name + ' — ' + check.detail + '\n');
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write('inspect: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

export { parseArgv as parseInspectArgv, providerInventory, isDisabled };
export const inspectPaths = { join };
