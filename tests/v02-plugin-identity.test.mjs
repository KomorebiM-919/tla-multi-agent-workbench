// Identity resolution has to be one judgement, not two half-judgements.
//
// On 2026-10-18 the classifier accepted an entry because its *id* was our attendance plugin
// (`tla-prelaunch-budget`) while the identity verifier collected nothing at all: the entry had
// no `name`, and identity verification only looked at declared names. The launcher would therefore
// have started with an unverified plugin instance and an empty identity list that "passed".
// These tests pin the rule that both halves use one normalized result:
//
//   * an id never proves which package is loaded;
//   * a conflicting name for a registered id is rejected;
//   * a nameless instance is only accepted when the profile declares the package *and* the
//     installed bytes match the reviewed build digest;
//   * every enabled instance that needs identity must end up `verified`; an empty or short list
//     fails instead of passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideStart, judgePluginInstances, resolveInstancePackages } from '../orchestration/gate/preflight.mjs';
import { verifyPluginIdentities } from '../tools/gated-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE = join(HERE, '..', 'orchestration', 'interceptor-plugin');
const PLUGIN_FILES = ['package.json', 'index.js', 'lib/budget.mjs'];
const GATE = 'http://127.0.0.1:18921';
const BUDGET = 'tla-prelaunch-budget';

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  process.stderr.write('FAIL ' + label + (detail === undefined ? '' : ' — ' + String(detail)) + '\n');
}

/** A profile home with the review bytes installed, plus a package.json that may or may not declare it. */
function makeHome({ declared = true, tamper = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tla-plugin-identity-'));
  const profileRoot = join(root, 'profiles', 'stage1');
  const modules = join(profileRoot, 'node_modules', BUDGET);
  mkdirSync(join(modules, 'lib'), { recursive: true });
  for (const relative of PLUGIN_FILES) {
    let bytes = readFileSync(join(PLUGIN_SOURCE, relative));
    if (tamper && relative === 'index.js') bytes = Buffer.concat([bytes, Buffer.from('\n// tampered\n')]);
    writeFileSync(join(modules, relative), bytes);
  }
  const manifest = {
    name: 'dsh-profile-stage1',
    dependencies: declared ? { [BUDGET]: 'link:../../../orchestration/interceptor-plugin' } : {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } }
  };
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return root;
}

/** One provider instance that does point at the gate, so "no gated provider" never masks a case. */
function gatedProvider() {
  return {
    id: 'llm-deepseek',
    name: '@deepseek-ai/dsh-llm-deepseek-api-key',
    config: { baseURL: GATE, apiKeyEnv: 'DEDICATED_FAKE_KEY' }
  };
}

function decide(entries, home) {
  const identities = verifyPluginIdentities(entries, { profile: 'stage1', home });
  const judgement = judgePluginInstances(entries, { gateBaseUrl: GATE, identities });
  const decision = decideStart({
    gateReady: true,
    baseUrl: { ok: true },
    heartbeat: { ok: true },
    gateUrl: GATE,
    coverage: judgement.coverage,
    pluginIdentities: identities,
    pluginProblems: judgement.problems,
    identityComplete: judgement.identityComplete
  });
  return { identities, judgement, decision, codes: decision.blockers.map((blocker) => blocker.code) };
}

const homes = [];
function home(options) {
  const root = makeHome(options);
  homes.push(root);
  return root;
}

test('resolveInstancePackages never turns an id into a package name on its own', async () => {
  const { instances, problems } = resolveInstancePackages([
    { id: BUDGET, config: {} },
    { id: BUDGET, name: '@acme/router', config: { baseURL: 'https://example.invalid' } },
    { id: 'other', name: 42 }
  ]);
  check('instances kept', instances.length === 3, String(instances.length));
  check('id-only has no resolved name yet', instances[0].candidate === BUDGET && instances[0].nameSource === 'id-needs-installed-package', JSON.stringify(instances[0]));
  check('conflicting name is flagged', problems.some((problem) => problem.code === 'PLUGIN_IDENTITY_CONFLICT'), JSON.stringify(problems));
  check('non-string name is unevaluable', problems.some((problem) => problem.code === 'PLUGIN_INSTANCE_UNEVALUABLE'), JSON.stringify(problems));
});

test('nameless registered id passes only with a declared, byte-identical install', async () => {
  const root = home({ declared: true });
  const entries = [gatedProvider(), { id: BUDGET, config: {} }];
  const { identities, judgement, decision, codes } = decide(entries, root);
  const budgetIdentity = identities.find((identity) => identity.name === BUDGET);
  check('identity verified', budgetIdentity !== undefined && budgetIdentity.status === 'verified', JSON.stringify(budgetIdentity));
  const row = judgement.instances.find((instance) => instance.id === BUDGET);
  check('classified from verified identity', row.kind === 'plumbing' && row.identity.status === 'verified', JSON.stringify(row));
  check('no judgement problems', judgement.problems.length === 0, JSON.stringify(judgement.problems));
  check('launcher allows this configuration', decision.allow === true, codes.join(','));
});

test('the reported counterexample is refused when nothing was verified', async () => {
  const root = home({ declared: true });
  const entries = [gatedProvider(), { id: BUDGET, config: {} }];
  // Identities that were never collected (the reported bug produced an empty array).
  const judgement = judgePluginInstances(entries, { gateBaseUrl: GATE, identities: [] });
  const decision = decideStart({
    gateReady: true,
    baseUrl: { ok: true },
    heartbeat: { ok: true },
    coverage: judgement.coverage,
    pluginIdentities: [],
    pluginProblems: judgement.problems,
    identityComplete: judgement.identityComplete
  });
  const codes = decision.blockers.map((blocker) => blocker.code);
  check('empty identity list cannot pass', decision.allow === false, codes.join(','));
  check('reason is a missing identity result', codes.includes('PLUGIN_IDENTITY_UNPROVEN'), codes.join(','));
  check('completeness flag is false', judgement.identityComplete === false);
  check('coverage no longer claims plumbing', !judgement.coverage.plumbing.includes(BUDGET), JSON.stringify(judgement.coverage));
  void root;
});

test('a conflicting name for a registered id is refused', async () => {
  const root = home({ declared: true });
  const entries = [gatedProvider(), { id: BUDGET, name: '@acme/router', config: { baseURL: 'https://example.invalid' } }];
  const { identities, judgement, decision, codes } = decide(entries, root);
  check('no identity is claimed for the conflicting name', identities.length === 0, JSON.stringify(identities));
  check('conflict is a blocker', codes.includes('PLUGIN_IDENTITY_CONFLICT'), codes.join(','));
  check('launcher refuses', decision.allow === false, codes.join(','));
  check('instance is not plumbing', judgement.instances.some((instance) => instance.id === BUDGET && instance.kind !== 'plumbing'));
});

test('a package the profile never declares is not accepted by id', async () => {
  const root = home({ declared: false });
  const entries = [gatedProvider(), { id: BUDGET, config: {} }];
  const { identities, decision, codes } = decide(entries, root);
  const budgetIdentity = identities.find((identity) => identity.name === BUDGET);
  check('identity is not-declared', budgetIdentity !== undefined && budgetIdentity.status === 'not-declared', JSON.stringify(budgetIdentity));
  check('launcher refuses', decision.allow === false, codes.join(','));
  check('reason names the identity', codes.includes('PLUGIN_NOT_VERIFIED'), codes.join(','));
});

test('changed package bytes fail the build digest even under the right name', async () => {
  const root = home({ declared: true, tamper: true });
  const entries = [gatedProvider(), { id: BUDGET, name: BUDGET, config: {} }];
  const { identities, decision, codes } = decide(entries, root);
  const budgetIdentity = identities.find((identity) => identity.name === BUDGET);
  check('identity is build-mismatch', budgetIdentity !== undefined && budgetIdentity.status === 'build-mismatch', JSON.stringify(budgetIdentity));
  check('launcher refuses', decision.allow === false, codes.join(','));
  check('reason names the identity', codes.includes('PLUGIN_NOT_VERIFIED'), codes.join(','));
});

test('the same package enabled twice cannot be pinned to one instance', async () => {
  const root = home({ declared: true });
  const entries = [gatedProvider(), { id: BUDGET, config: {} }, { id: 'budget-copy', name: BUDGET, config: {} }];
  const { judgement, decision, codes } = decide(entries, root);
  check('duplicate instance is reported', judgement.problems.some((problem) => problem.code === 'PLUGIN_DUPLICATE_INSTANCE'), JSON.stringify(judgement.problems));
  check('launcher refuses', decision.allow === false, codes.join(','));
  check('duplicate code blocks', codes.includes('PLUGIN_DUPLICATE_INSTANCE'), codes.join(','));
});

test('a disabled instance needs no identity and is not counted as covered', async () => {
  const root = home({ declared: true });
  const entries = [gatedProvider(), { id: BUDGET, config: { disabled: true } }];
  const { identities, judgement, decision } = decide(entries, root);
  check('no identity demanded for a disabled instance', identities.length === 0, JSON.stringify(identities));
  const row = judgement.instances.find((instance) => instance.id === BUDGET);
  check('row is disabled', row.kind === 'disabled', JSON.stringify(row));
  check('coverage lists it as disabled', judgement.coverage.disabled.includes(BUDGET), JSON.stringify(judgement.coverage));
  check('launcher allows', decision.allow === true, decision.blockers.map((blocker) => blocker.code).join(','));
});

test('an explicit registered name still verifies and passes', async () => {
  const root = home({ declared: true });
  const entries = [gatedProvider(), { id: BUDGET, name: BUDGET, config: {} }];
  const { identities, judgement, decision } = decide(entries, root);
  check('identity verified', identities.length === 1 && identities[0].status === 'verified', JSON.stringify(identities));
  check('no problems', judgement.problems.length === 0, JSON.stringify(judgement.problems));
  check('launcher allows', decision.allow === true, decision.blockers.map((blocker) => blocker.code).join(','));
});

test('blockers are deduplicated across the two code paths', async () => {
  const root = home({ declared: false });
  const entries = [gatedProvider(), { id: BUDGET, config: {} }];
  const { decision } = decide(entries, root);
  const keys = decision.blockers.map((blocker) => blocker.code + '|' + blocker.detail);
  check('no duplicated blocker text', new Set(keys).size === keys.length, keys.join(' ; '));
});

test.after(() => {
  for (const root of homes) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (_ignored) {
      // Best effort: a leftover temp directory must not fail the suite.
    }
  }
});

process.on('exit', () => {
  if (failures > 0) process.exitCode = 1;
  process.stdout.write('plugin identity: ' + String(checks) + ' checks, ' + String(failures) + ' failed\n');
});

// node:test runs the cases; the tally above reports them the way the other v02 suites do.
void assert;
