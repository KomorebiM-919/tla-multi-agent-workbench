// Summarise what one supervised run actually proved.
//
// The three things people keep conflating must stay separate:
//   supervisor  the supervisor finished its own bookkeeping (exit 0)
//   host        the DSH host started and exited on its own terms
//   closure     the business loop finished: tests green, tasks completed, review done
//
// A run can be supervisor-completed, host-ok and still prove nothing about the
// loop. This tool derives the three verdicts from artefacts, never from a
// hand-written label, and lists the conditions that are still unmet.
//
// Usage:
//   node tools/acceptance-summary.mjs --runner <runner.json> --run-dir <dir> \
//     --upstream-log <file> --project <dir> [--test test/sum.test.mjs] \
//     [--require-file src/sum.mjs]... [--json]
import { existsSync, openSync, closeSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { ledgerForRun } from './ledger-from-run.mjs'

export const ACCEPTANCE_SCHEMA = 'tla.acceptance-summary/v1'

export class AcceptanceInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AcceptanceInputError'
    this.code = 'ACCEPTANCE_INPUT_MISSING'
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
}

/** Parse the fixture's own summary line, e.g. "sum tests: 1 passed, 2 failed". */
export function parseTestLine(text) {
  const match = /tests:\s*(\d+)\s+passed,\s*(\d+)\s+failed/u.exec(text)
  if (match === null) return { passed: null, failed: null }
  return { passed: Number(match[1]), failed: Number(match[2]) }
}

/** Read the rule usage out of the upstream log: which decisions actually ran. */
export function readRuleUsage(lines) {
  const usage = []
  const writes = []
  const reads = []
  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    if (entry.event !== 'arrived' && typeof entry.accepted !== 'boolean') continue
    // A request the gate or the budget refused never reached a decision, so it is not usage.
    if (entry.accepted === false) continue
    if (typeof entry.policyRule !== 'string') continue
    const facts = entry.policyFacts === null || typeof entry.policyFacts !== 'object' ? {} : entry.policyFacts
    usage.push({ rule: entry.policyRule, sessionId: entry.sessionId ?? null, facts })
    if (typeof facts.filePath === 'string' && facts.filePath !== '') {
      const record = { rule: entry.policyRule, path: facts.filePath, outcome: facts.fileOutcome ?? null }
      if (facts.fileOutcome === 'updated' || facts.fileOutcome === 'created') writes.push(record)
      if (facts.fileOutcome === 'read') reads.push(record)
    }
  }
  return { usage, writes, reads }
}

function readTasks(project) {
  const teamsDir = join(project, 'teams')
  if (!existsSync(teamsDir)) return { team: null, tasks: [] }
  for (const name of readdirSync(teamsDir)) {
    const file = join(teamsDir, name, 'team.json')
    if (!existsSync(file)) continue
    const team = JSON.parse(readFileSync(file, 'utf8'))
    const tasks = Array.isArray(team.tasks) ? team.tasks.map((task) => ({ id: task.id, status: task.status })) : []
    return { team: { id: team.id ?? name, members: Array.isArray(team.members) ? team.members.length : 0 }, tasks }
  }
  return { team: null, tasks: [] }
}

function runProjectTest(project, testRel) {
  const script = join(project, testRel)
  if (!existsSync(script)) throw new AcceptanceInputError('project test is missing: ' + script)
  const logPath = join(project, '.acceptance-test.log')
  const fd = openSync(logPath, 'w')
  try {
    const result = spawnSync(process.execPath, [script], { cwd: project, stdio: ['ignore', fd, fd] })
    const output = readFileSync(logPath, 'utf8')
    const counts = parseTestLine(output)
    return { exitCode: result.status, passed: counts.passed, failed: counts.failed, output: output.trim().split('\n').slice(-4).join('\n') }
  } finally {
    closeSync(fd)
  }
}

/**
 * Pure verdict derivation, so the rules can be tested without a host.
 * `closed` needs every condition; a host that merely started is `partial`.
 */
export function deriveAcceptance({ supervisor, ledger, tests, tasks, usage, writes }) {
  const conditions = [
    { code: 'SUPERVISOR_COMPLETED', ok: supervisor.status === 'completed', detail: 'supervisor status ' + String(supervisor.status) },
    { code: 'HOST_STARTED', ok: supervisor.hostStarted === true, detail: 'hostStarted ' + String(supervisor.hostStarted) },
    {
      code: 'LEDGER_COMPLETE',
      ok: ledger !== null && ledger.completeness === 'COMPLETE' && ledger.ledgerConsistent === true,
      detail: ledger === null ? 'no ledger' : 'completeness ' + String(ledger.completeness) + ', consistent ' + String(ledger.ledgerConsistent)
    },
    {
      code: 'MEMBER_WROTE_A_FILE',
      ok: Array.isArray(writes) && writes.length > 0,
      detail: writes === null ? 'no evidence' : String(writes.length) + ' write(s)'
    },
    { code: 'TESTS_GREEN', ok: tests !== null && tests.exitCode === 0 && tests.failed === 0, detail: tests === null ? 'no test run' : 'exit ' + String(tests.exitCode) + ', ' + String(tests.failed) + ' failed' },
    {
      code: 'TASKS_COMPLETED',
      ok: Array.isArray(tasks) && tasks.length > 0 && tasks.every((task) => task.status === 'completed'),
      detail: Array.isArray(tasks) && tasks.length > 0 ? tasks.map((task) => task.id + '=' + String(task.status)).join(', ') : 'no tasks'
    },
    {
      code: 'REVIEW_RAN',
      ok: Array.isArray(usage) && usage.some((entry) => /review/iu.test(entry.rule)),
      detail: Array.isArray(usage) ? String(usage.filter((entry) => /review/iu.test(entry.rule)).length) + ' review decision(s)' : 'no usage'
    }
  ]
  const unmet = conditions.filter((condition) => condition.ok === false).map((condition) => condition.code)
  const started = supervisor.hostStarted === true
  const provedSomething = started && (Array.isArray(writes) && writes.length > 0 || (tests !== null && tests.exitCode !== undefined))
  const verdict = unmet.length === 0 ? 'closed' : provedSomething ? 'partial' : started ? 'partial' : 'not-started'
  return {
    schema: ACCEPTANCE_SCHEMA,
    verdict,
    unmet,
    conditions,
    note: 'supervisor completed, host exit code and business closure are three different claims; this object keeps them separate'
  }
}

export function summariseRun({ runnerPath, runDir, upstreamLog, project, testRel = 'test/sum.test.mjs', requireFiles = [] }) {
  if (!existsSync(runnerPath)) throw new AcceptanceInputError('runner summary is missing: ' + runnerPath)
  const supervisor = JSON.parse(readFileSync(runnerPath, 'utf8'))
  const ledger = ledgerForRun({ runDir, upstreamLog, label: runDir })
  const lines = readFileSync(upstreamLog, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
  const { usage, writes } = readRuleUsage(lines)
  const { team, tasks } = readTasks(project)
  const tests = runProjectTest(project, testRel)
  const files = requireFiles.map((rel) => {
    const path = resolve(join(project, rel))
    if (!existsSync(path)) return { path: rel, missing: true }
    return { path: rel, bytes: readFileSync(path).length, sha256: sha256File(path) }
  })
  const verdict = deriveAcceptance({ supervisor, ledger, tests, tasks, usage, writes })
  return {
    ...verdict,
    supervisor: {
      status: supervisor.status ?? null,
      hostStarted: supervisor.hostStarted ?? null,
      hostExit: supervisor.hostExit ?? null,
      treeProof: supervisor.treeProof ?? null,
      phases: Array.isArray(supervisor.phases) ? supervisor.phases.map((phase) => phase.phase) : []
    },
    host: { started: supervisor.hostStarted === true, exitCode: supervisor.hostExit?.code ?? null },
    ledger: {
      reserved: ledger.reservedDelta,
      allowed: ledger.gateAllowed,
      received: ledger.upstreamReceived,
      completed: ledger.upstreamCompleted,
      respondedOk: ledger.upstreamRespondedOk,
      respondedError: ledger.upstreamRespondedError,
      correlationOk: ledger.correlation?.ok ?? null,
      completeness: ledger.completeness
    },
    ruleUsage: usage.map((entry) => entry.rule),
    writes: writes.map((write) => ({ rule: write.rule, outcome: write.outcome, file: write.path.split(/[\\/]/u).slice(-1)[0] })),
    team,
    tasks,
    tests,
    files
  }
}

function parseArgs(argv) {
  const options = { json: false, requireFiles: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new AcceptanceInputError('missing value for ' + flag)
      return argv[index]
    }
    switch (flag) {
      case '--runner': options.runnerPath = next(); break
      case '--run-dir': options.runDir = next(); break
      case '--upstream-log': options.upstreamLog = next(); break
      case '--project': options.project = next(); break
      case '--test': options.testRel = next(); break
      case '--require-file': options.requireFiles.push(next()); break
      case '--json': options.json = true; break
      default: throw new AcceptanceInputError('unknown argument: ' + flag)
    }
  }
  if (options.runnerPath === undefined) throw new AcceptanceInputError('--runner is required')
  if (options.runDir === undefined) throw new AcceptanceInputError('--run-dir is required')
  if (options.upstreamLog === undefined) throw new AcceptanceInputError('--upstream-log is required')
  if (options.project === undefined) throw new AcceptanceInputError('--project is required')
  return options
}

export function main(argv = process.argv.slice(2)) {
  let summary
  try {
    summary = summariseRun(parseArgs(argv))
  } catch (error) {
    process.stderr.write('acceptance-summary: ' + error.message + '\n')
    return 1
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  return summary.verdict === 'closed' ? 0 : 2
}

if (process.argv[1] && process.argv[1].endsWith('acceptance-summary.mjs')) {
  process.exitCode = main()
}
