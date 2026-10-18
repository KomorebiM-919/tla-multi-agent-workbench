// The only sanctioned way to produce an experiment overlay. Hand-assembled overlays already
// cost one authorised run: the hand-made file rewrote baseURL but forgot apiKeyEnv, so the
// host stopped at credential resolution before a single request reached the gate.
//
// The template is deliberately rigid: loopback gate URL, one dedicated fake credential
// variable whose value is a fixed placeholder, account-backed channels disabled (they would
// otherwise require the interactive account login), and the pre-launch budget plugin inserted
// with paths inside the run directory.

export const OVERLAY_TEMPLATE_SCHEMA = 'tla.overlay-template/v1';

/** The one fake credential the experiment is allowed to use. Never a real key. */
export const FAKE_CREDENTIAL = Object.freeze({ envName: 'TLA_STAGE2_FAKE_KEY', value: 'stage2-fake-key' });

/** Provider instances that must be pointed at the gate. */
export const GUARDED_PROVIDERS = Object.freeze(['llm-deepseek']);

/** Provider instances that must be switched off: they resolve credentials through the account. */
export const ACCOUNT_PROVIDERS = Object.freeze(['llm-deepseek-account', 'deepseek-account']);

/** Provider instances switched off entirely — the experiment does not use web search. */
export const DISABLED_PROVIDERS = Object.freeze(['web-search-deepseek']);

/** Plugins the experiment does not need and that would make outbound title requests. */
export const DISABLED_PLUGINS = Object.freeze(['session-title', 'session-title-llm']);

/** The pre-launch budget interceptor registered by the overlay. */
export const BUDGET_PLUGIN_ID = 'tla-prelaunch-budget';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/u;

export class OverlayTemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OverlayTemplateError';
    this.code = 'OVERLAY_TEMPLATE_INVALID';
  }
}

function loopbackUrl(value, label) {
  const match = LOOPBACK.exec(String(value === undefined ? '' : value));
  if (match === null) throw new OverlayTemplateError(label + ' must be a loopback http URL, got ' + JSON.stringify(value));
  const port = Number(match[1]);
  if (!(port >= 1024 && port <= 65535)) throw new OverlayTemplateError(label + ' port out of range: ' + String(port));
  return 'http://127.0.0.1:' + port;
}

function positiveInt(value, label, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new OverlayTemplateError(label + ' must be a positive integer');
  if (max !== undefined && number > max) throw new OverlayTemplateError(label + ' must not exceed ' + String(max));
  return number;
}

function evidencePath(value, label, runDir) {
  const text = String(value === undefined ? '' : value).replace(/\\/gu, '/');
  if (text === '' || text.includes('<') || text.includes('>')) throw new OverlayTemplateError(label + ' must be a real path, got ' + JSON.stringify(value));
  if (!text.startsWith(runDir.replace(/\\/gu, '/') + '/')) throw new OverlayTemplateError(label + ' must live inside the run directory ' + runDir);
  return text;
}

function renderEntry(id, lines) {
  return ['- id: ' + id, ...lines].join('\n');
}

/**
 * Renders the complete overlay. Every value is validated here so a typo cannot silently
 * produce an overlay that starts a host without a guard.
 */
export function renderOverlay(spec) {
  const gateUrl = loopbackUrl(spec.gateUrl, 'gateUrl');
  const runDir = String(spec.runDir === undefined ? '' : spec.runDir).replace(/\\/gu, '/');
  if (runDir === '' || runDir.includes('<')) throw new OverlayTemplateError('runDir must be a real path');
  const modelRequests = positiveInt(spec.modelRequests === undefined ? 40 : spec.modelRequests, 'modelRequests', 40);
  const heartbeatIntervalMs = positiveInt(spec.heartbeatIntervalMs === undefined ? 500 : spec.heartbeatIntervalMs, 'heartbeatIntervalMs', 60_000);
  const stateFile = evidencePath(spec.stateFile === undefined ? runDir + '/budget-state.json' : spec.stateFile, 'stateFile', runDir);
  const eventLog = evidencePath(spec.eventLog === undefined ? runDir + '/plugin-events.jsonl' : spec.eventLog, 'eventLog', runDir);
  const teamStateDir = String(spec.teamStateDir === undefined ? 'teams' : spec.teamStateDir);
  if (teamStateDir === '' || teamStateDir.includes(':') || teamStateDir.startsWith('/')) {
    throw new OverlayTemplateError('teamStateDir must be a relative directory inside the project');
  }

  const blocks = [
    '# Rendered by tools/overlay-template.mjs — do not edit by hand.',
    '# Every model request is sent to the loopback gate; the gate forwards only while a lease',
    '# and a budget remain. The API key is a dedicated placeholder, never a real credential.',
    '',
    renderEntry('llm-deepseek', ['  config:', '    apiKeyEnv: ' + FAKE_CREDENTIAL.envName, '    baseURL: ' + gateUrl])
  ];
  for (const id of ACCOUNT_PROVIDERS) blocks.push(renderEntry(id, ['  disabled: true']));
  for (const id of DISABLED_PROVIDERS) blocks.push(renderEntry(id, ['  disabled: true']));
  for (const id of DISABLED_PLUGINS) blocks.push(renderEntry(id, ['  disabled: true']));
  blocks.push(renderEntry('agent-teams', ['  config:', '    stateDir: ' + teamStateDir]));
  blocks.push([
    '- insert:',
    '    - id: ' + BUDGET_PLUGIN_ID,
    '      config:',
    '        modelRequests: ' + String(modelRequests),
    '        heartbeatIntervalMs: ' + String(heartbeatIntervalMs),
    '        stateFile: ' + stateFile,
    '        eventLog: ' + eventLog
  ].join('\n'));
  return blocks.join('\n') + '\n';
}

/** Value contract the static pre-flight checks against, so both sides stay in one place. */
export function templateContract() {
  return {
    schema: OVERLAY_TEMPLATE_SCHEMA,
    fakeCredential: { ...FAKE_CREDENTIAL },
    guardedProviders: [...GUARDED_PROVIDERS],
    accountProviders: [...ACCOUNT_PROVIDERS],
    disabledProviders: [...DISABLED_PROVIDERS],
    disabledPlugins: [...DISABLED_PLUGINS],
    budgetPluginId: BUDGET_PLUGIN_ID,
    maxModelRequests: 40
  };
}
