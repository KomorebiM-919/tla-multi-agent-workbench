import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const OBSERVER_PLAN_SCHEMA = 'tla.observer-plan/v1'
export const OBSERVER_PLUGIN_NAME = 'tla-tool-observer'
export const OBSERVER_VERSION = '0.0.0-local'
export const OBSERVER_FILE_COUNT = 12
export const OBSERVER_LIMITS = Object.freeze({
  maxBytes: Object.freeze({ min: 131_072, max: 8_388_608 }),
  maxObservations: Object.freeze({ min: 1, max: 10_000 }),
  maxPending: Object.freeze({ min: 1, max: 1_000 }),
  cleanupTimeoutMs: Object.freeze({ min: 1, max: 5_000 })
})

export class ObserverPlanError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'ObserverPlanError'
    this.code = code
  }
}

function fail (code, message) {
  throw new ObserverPlanError(code, message)
}

function exactKeys (value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('PLAN_INVALID', label + ' must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('PLAN_INVALID', label + ' must contain exactly ' + expected.join(', '))
  }
}

function integerInRange (value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('PLAN_LIMIT_INVALID', name + ' must be an integer in ' + String(min) + '..' + String(max))
  }
  return value
}

/** Validate the runner-owned observer plan. The plan carries no run identity. */
export function validateObserverPlan (plan) {
  exactKeys(plan, ['schema', 'plugin', 'packageRoot', 'version', 'fileCount', 'digest', 'limits', 'cleanupTimeoutMs'], 'observer')
  if (plan.schema !== OBSERVER_PLAN_SCHEMA) fail('PLAN_SCHEMA_UNSUPPORTED', 'observer.schema must be ' + OBSERVER_PLAN_SCHEMA)
  if (plan.plugin !== OBSERVER_PLUGIN_NAME) fail('PLAN_PLUGIN_INVALID', 'observer.plugin must be ' + OBSERVER_PLUGIN_NAME)
  if (typeof plan.packageRoot !== 'string' || !isAbsolute(plan.packageRoot)) fail('PLAN_PACKAGE_ROOT_INVALID', 'observer.packageRoot must be an absolute path')
  if (!existsSync(plan.packageRoot)) fail('PLAN_PACKAGE_ROOT_MISSING', 'observer.packageRoot does not exist')
  if (plan.version !== OBSERVER_VERSION) fail('PLAN_VERSION_INVALID', 'observer.version must be ' + OBSERVER_VERSION)
  if (plan.fileCount !== OBSERVER_FILE_COUNT) fail('PLAN_FILE_COUNT_INVALID', 'observer.fileCount must be ' + String(OBSERVER_FILE_COUNT))
  if (typeof plan.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(plan.digest)) fail('PLAN_DIGEST_INVALID', 'observer.digest must be a 64-character lowercase hex digest')
  exactKeys(plan.limits, ['maxBytes', 'maxObservations', 'maxPending'], 'observer.limits')
  integerInRange(plan.limits.maxBytes, 'observer.limits.maxBytes', OBSERVER_LIMITS.maxBytes.min, OBSERVER_LIMITS.maxBytes.max)
  integerInRange(plan.limits.maxObservations, 'observer.limits.maxObservations', OBSERVER_LIMITS.maxObservations.min, OBSERVER_LIMITS.maxObservations.max)
  integerInRange(plan.limits.maxPending, 'observer.limits.maxPending', OBSERVER_LIMITS.maxPending.min, OBSERVER_LIMITS.maxPending.max)
  integerInRange(plan.cleanupTimeoutMs, 'observer.cleanupTimeoutMs', OBSERVER_LIMITS.cleanupTimeoutMs.min, OBSERVER_LIMITS.cleanupTimeoutMs.max)
  return plan
}

export function readObserverPlan (path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ObserverPlanError('PLAN_UNREADABLE', 'observer plan could not be read: ' + String(error instanceof Error ? error.message : error))
  }
  return validateObserverPlan(parsed)
}

export function observerPlanPaths (runDir) {
  const root = resolve(runDir)
  const observerDir = join(root, 'observer')
  return Object.freeze({
    planPath: join(root, 'observer-plan.json'),
    patchPath: join(root, 'observer-launch.patch.yml'),
    observerDir,
    traceFile: join(observerDir, 'trace.jsonl'),
    lifecycleFile: join(observerDir, 'lifecycle.jsonl')
  })
}

/**
 * Render the single observer patch used by both the mount probe and the real
 * host invocation. Identity values must already be the actual values produced
 * by the gate; this function never invents fallbacks.
 */
export function renderObserverPatch (plan, facts) {
  const validated = validateObserverPlan(plan)
  for (const name of ['runnerRunId', 'launchId', 'gateRunId', 'budgetRunId']) {
    if (typeof facts[name] !== 'string' || facts[name].trim() === '') fail('PLAN_IDENTITY_MISSING', 'observer ' + name + ' is required')
  }
  if (facts.gateRunId !== facts.budgetRunId) fail('PLAN_IDENTITY_CONFLICT', 'observer gateRunId and budgetRunId must be equal')
  const paths = observerPlanPaths(facts.runDir)
  const quote = (value) => JSON.stringify(String(value))
  const lines = [
    '- insert:',
    '    - id: tla-tool-observer',
    '      name: tla-tool-observer',
    '      config:',
    '        enabled: true',
    '        runDir: ' + quote(paths.observerDir.replaceAll('\\', '/')),
    '        traceFile: ' + quote(paths.traceFile.replaceAll('\\', '/')),
    '        lifecycleFile: ' + quote(paths.lifecycleFile.replaceAll('\\', '/')),
    '        runnerRunId: ' + quote(facts.runnerRunId),
    '        launchId: ' + quote(facts.launchId),
    '        gateRunId: ' + quote(facts.gateRunId),
    '        budgetRunId: ' + quote(facts.budgetRunId),
    '        maxBytes: ' + String(validated.limits.maxBytes),
    '        maxObservations: ' + String(validated.limits.maxObservations),
    '        maxPending: ' + String(validated.limits.maxPending),
    '        cleanupTimeoutMs: ' + String(validated.cleanupTimeoutMs),
    ''
  ]
  return { patch: lines.join('\n'), paths }
}
