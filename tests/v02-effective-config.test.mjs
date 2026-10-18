// The effective-config inspection exists because checking the overlay *text* is not the same as
// checking what the host loads: on 2026-10-18 an overlay rewrote baseURL but no apiKeyEnv, the
// host merged it happily and died with MISSING_CREDENTIAL. These tests pin both halves 鈥?the
// template that renders the overlay and the rules that judge the merged configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_NON_PROVIDER_ADAPTERS, KNOWN_PROVIDER_ADAPTERS, parseDumpConfigStrict } from '../orchestration/gate/preflight.mjs';
import { evaluateEffectiveConfig } from '../tools/inspect-effective-config.mjs';
import { FAKE_CREDENTIAL, OverlayTemplateError, renderOverlay, templateContract } from '../tools/overlay-template.mjs';

const GATE = 'http://127.0.0.1:18921';
const ENV = { [FAKE_CREDENTIAL.envName]: FAKE_CREDENTIAL.value };

function entriesOf(yaml) {
  const parsed = parseDumpConfigStrict(yaml);
  assert.equal(parsed.ok, true, 'fixture must parse: ' + String(parsed.code) + ' ' + String(parsed.detail));
  return parsed.entries;
}

function failed(report) {
  return report.checks.filter((check) => !check.ok).map((check) => check.name);
}

// Fixture identities: these tests exercise the configuration rules, not the install on disk.
// Supplying them explicitly keeps "no evidence" from silently looking like "verified".
function identitiesOf(entries) {
  const names = [...new Set(entries.map((entry) => entry.name).filter((name) => typeof name === 'string' && name !== ''))];
  return names
    .filter((name) => name === 'tla-prelaunch-budget' || name === '@nanmicoder/dsh-agent-teams')
    .map((name) => ({ name, status: 'verified', detail: 'fixture identity' }));
}

const FAILED_OVERLAY_DUMP = [
  '- id: llm-deepseek',
  "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
  '  config:',
  '    baseURL: ' + GATE,
  '- id: llm-deepseek-account',
  "  name: '@deepseek-ai/dsh-llm-deepseek-account'",
  '- id: deepseek-account',
  "  name: '@deepseek-ai/dsh-deepseek-account-platform'",
  '- id: web-search-deepseek',
  "  name: '@deepseek-ai/dsh-web-search-deepseek'",
  '- id: tla-prelaunch-budget',
  '  name: tla-prelaunch-budget',
  '  config:',
  '    modelRequests: 40',
  '    eventLog: >-',
  '      D:/run/plugin-events.jsonl',
  ''
].join('\n');

const GOOD_DUMP = [
  '- id: llm-deepseek',
  "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
  '  config:',
  '    apiKeyEnv: ' + FAKE_CREDENTIAL.envName,
  '    baseURL: ' + GATE,
  '- id: llm-deepseek-account',
  "  name: '@deepseek-ai/dsh-llm-deepseek-account'",
  '  disabled: true',
  '- id: deepseek-account',
  "  name: '@deepseek-ai/dsh-deepseek-account-platform'",
  '  disabled: true',
  '- id: web-search-deepseek',
  "  name: '@deepseek-ai/dsh-web-search-deepseek'",
  '  disabled: true',
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '- id: tla-prelaunch-budget',
  '  name: tla-prelaunch-budget',
  '  config:',
  '    modelRequests: 40',
  '    eventLog: >-',
  '      D:/run/plugin-events.jsonl',
  ''
].join('\n');

test('the configuration that cost a run is reported as failing', () => {
  const report = evaluateEffectiveConfig({ entries: entriesOf(FAILED_OVERLAY_DUMP), gateUrl: GATE, env: ENV, identities: identitiesOf(entriesOf(FAILED_OVERLAY_DUMP)) });
  const names = failed(report);
  assert.equal(report.checks.every((check) => check.ok), false);
  // The exact defect: baseURL points at the gate but no key variable is named.
  assert.ok(names.includes('provider:llm-deepseek'), 'expected provider:llm-deepseek to fail, got ' + names.join(', '));
  assert.ok(names.includes('channel:account-disabled'), 'expected the account channel to be named');
  assert.ok(names.includes('provider:web-search-deepseek'), 'expected the web-search instance to be named');
});

test('the rendered template produces a configuration that passes', () => {
  const report = evaluateEffectiveConfig({ entries: entriesOf(GOOD_DUMP), gateUrl: GATE, env: ENV, identities: identitiesOf(entriesOf(GOOD_DUMP)) });
  assert.deepEqual(failed(report), []);
  assert.deepEqual(report.coverage.guarded, ['llm-deepseek']);
  assert.deepEqual(report.coverage.unguarded, []);
  assert.deepEqual(report.coverage.unknown, []);
  // An aggregator with no endpoints is not a bypass, but it is still named.
  assert.deepEqual(report.coverage.notConfigured, ['llm-pi-ai']);
});

test('a provider pointed somewhere else is an unguarded channel, not a pass', () => {
  const dump = GOOD_DUMP.replace(
    "- id: llm-pi-ai",
    "- id: llm-something-else\n  name: '@deepseek-ai/dsh-llm-something-else'\n  config:\n    baseURL: https://api.example.com\n- id: llm-pi-ai"
  );
  const report = evaluateEffectiveConfig({ entries: entriesOf(dump), gateUrl: GATE, env: ENV, identities: identitiesOf(entriesOf(dump)) });
  assert.deepEqual(report.coverage.unguarded, ['llm-something-else']);
  assert.ok(failed(report).includes('coverage:every-enabled-provider'));
});

test('a real-looking key in the launching environment fails the credential check', () => {
  const report = evaluateEffectiveConfig({
    entries: entriesOf(GOOD_DUMP),
    gateUrl: GATE,
    env: { [FAKE_CREDENTIAL.envName]: 'sk-real-looking-value' },
    identities: identitiesOf(entriesOf(GOOD_DUMP))
  });
  assert.ok(failed(report).includes('credential:dedicated-fake'));
});

test('an absent identity list is a failure, not a pass', () => {
  const entries = entriesOf(GOOD_DUMP);
  const report = evaluateEffectiveConfig({ entries, gateUrl: GATE, env: ENV });
  const names = failed(report);
  assert.ok(names.includes('identity:per-instance'), 'expected identity:per-instance to fail, got ' + names.join(', '));
  assert.ok(names.includes('identity:no-conflict-or-duplicate'), 'expected identity:no-conflict-or-duplicate to fail, got ' + names.join(', '));
});

test('the renderer refuses specs that would weaken the guard', () => {
  const base = { gateUrl: GATE, runDir: 'D:/run', modelRequests: 40 };
  assert.throws(() => renderOverlay({ ...base, gateUrl: 'http://10.0.0.5:18921' }), OverlayTemplateError);
  assert.throws(() => renderOverlay({ ...base, modelRequests: 41 }), OverlayTemplateError);
  assert.throws(() => renderOverlay({ ...base, stateFile: 'D:/elsewhere/budget-state.json' }), OverlayTemplateError);
});

test('the rendered overlay carries the guard and the contract names it', () => {
  const text = renderOverlay({ gateUrl: GATE, runDir: 'D:/run', modelRequests: 40 });
  assert.ok(text.includes('apiKeyEnv: ' + FAKE_CREDENTIAL.envName), 'overlay must name the key variable');
  assert.ok(text.includes('baseURL: ' + GATE), 'overlay must point at the gate');
  assert.ok(text.includes('- id: web-search-deepseek\n  disabled: true'), 'web search must be off');
  assert.ok(text.includes('- id: llm-deepseek-account\n  disabled: true'), 'account channel must be off');
  assert.ok(text.includes('stateFile: D:/run/budget-state.json'), 'evidence must live in the run directory');
  const contract = templateContract();
  assert.deepEqual(contract.disabledProviders, ['web-search-deepseek']);
  assert.deepEqual(contract.guardedProviders, ['llm-deepseek']);
  assert.equal(contract.maxModelRequests, 40);
});

// The fixtures above are hand-written reductions of a real dump, and on 2026-10-18 they drifted:
// they named the key route `@deepseek-ai/dsh-llm-deepseek` while the host actually loads
// `@deepseek-ai/dsh-llm-deepseek-api-key`. The inspector still passed (it accepted any
// `dsh-llm-*` pointing at the gate) and the launcher called the same entry unknown. Pin the
// adapter names to the launcher's own registry so a fixture cannot silently describe a host
// that does not exist.
test('every adapter named in the fixtures is one the launcher knows', () => {
  const names = new Set();
  for (const dump of [GOOD_DUMP, FAILED_OVERLAY_DUMP]) {
    for (const match of dump.matchAll(/name: '([^']+)'/gu)) names.add(match[1]);
  }
  const llmNames = [...names].filter((name) => name.startsWith('@deepseek-ai/dsh-llm-'));
  assert.ok(llmNames.length > 0, 'fixtures must name at least one model adapter');
  for (const name of llmNames) {
    const known = Object.prototype.hasOwnProperty.call(KNOWN_PROVIDER_ADAPTERS, name) || KNOWN_NON_PROVIDER_ADAPTERS.has(name);
    assert.ok(known, name + ' is not in the launcher adapter registry; the fixture describes a host that does not exist');
  }
});
