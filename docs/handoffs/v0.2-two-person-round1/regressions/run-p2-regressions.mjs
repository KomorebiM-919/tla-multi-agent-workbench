#!/usr/bin/env node
// Round-4 P2 diagnostic regression.
//
// This runner is intentionally outside the repository test suite. It is an
// expected-red regression package for an independently reviewed core copy.
// Pass --core-root explicitly; the runner never reads environment variables and
// never treats the copy as a Git checkout.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildScenarios, BINDING, ROOT } from './inputs.mjs'

function usage() {
  return 'usage: node run-p2-regressions.mjs --core-root <isolated-core-copy> [--json]'
}

function parseArgs(argv) {
  let coreRoot = null
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--core-root') {
      coreRoot = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--core-root=')) {
      coreRoot = arg.slice('--core-root='.length)
    } else if (arg === '--json') {
      json = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!coreRoot) throw new Error('--core-root is required')
  return { coreRoot: resolve(coreRoot), json }
}

function issueHaystack(issues) {
  try {
    return JSON.stringify(issues)
  } catch {
    return String(issues)
  }
}

function locatesWrite(issues, taskId, attemptId, writePath) {
  const text = issueHaystack(issues)
  const paths = [writePath, writePath.replaceAll('/', '\\')]
  return text.includes(taskId)
    && text.includes(attemptId)
    && paths.some(candidate => text.includes(candidate))
}

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail }
}

function evaluateNegative(scenario, report) {
  const closed = report.status === 'COMPLETE' && report.verdict === 'synthetic-closed'
  const signaled = report.status === 'INCOMPLETE'
    || (Array.isArray(report.issues) && report.issues.length > 0)
  return [
    check('not-synthetic-closed', !closed, `status=${report.status} verdict=${report.verdict}`),
    check('has-diagnostic-signal', signaled,
      `status=${report.status} issues=${Array.isArray(report.issues) ? report.issues.length : 'n/a'}`),
    check('locates-write', locatesWrite(report.issues ?? [], scenario.taskId, scenario.attemptId, scenario.writePath),
      `need ${scenario.taskId}/${scenario.attemptId}/${scenario.writePath}`),
  ]
}

function evaluatePositive(report) {
  const closed = report.status === 'COMPLETE' && report.verdict === 'synthetic-closed'
  return [
    check('synthetic-closed', closed, `status=${report.status} verdict=${report.verdict}`),
    check('no-issues', Array.isArray(report.issues) && report.issues.length === 0,
      `issues=${Array.isArray(report.issues) ? report.issues.length : 'n/a'}`),
  ]
}

function describeIssues(report) {
  if (!Array.isArray(report.issues) || report.issues.length === 0) return '(none)'
  return report.issues.map(issue => issue?.code ?? JSON.stringify(issue)).join(', ')
}

async function main() {
  const { coreRoot, json } = parseArgs(process.argv.slice(2))
  const collectorPath = resolve(coreRoot, 'tools/collect-run-evidence.mjs')
  const acceptancePath = resolve(coreRoot, 'tools/acceptance-summary.mjs')
  if (!existsSync(collectorPath) || !existsSync(acceptancePath)) {
    console.error(`not an isolated core copy: ${coreRoot}`)
    console.error('expected tools/collect-run-evidence.mjs and tools/acceptance-summary.mjs')
    process.exitCode = 2
    return
  }

  const { collectEvidence } = await import(pathToFileURL(collectorPath).href)
  const scenarios = buildScenarios()
  const results = []

  for (const scenario of scenarios) {
    const report = collectEvidence(scenario.input, { binding: BINDING, projectRoot: ROOT })
    const checks = scenario.positive ? evaluatePositive(report) : evaluateNegative(scenario, report)
    const extraWrites = Array.isArray(report.evidence?.files)
      ? report.evidence.files.filter(item => item.kind === 'write' && item.path?.endsWith('extra.mjs')).length
      : 0
    const ok = checks.every(item => item.pass)
    results.push({
      id: scenario.id,
      description: scenario.description,
      positive: Boolean(scenario.positive),
      ok,
      actual: {
        status: report.status,
        verdict: report.verdict,
        issues: describeIssues(report),
        extraWrites,
      },
      checks,
    })

    if (!json) {
      console.log(`scenario: ${scenario.id}${scenario.positive ? ' (positive control)' : ''}`)
      console.log(`  ${scenario.description}`)
      console.log(`  actual: status=${report.status} verdict=${report.verdict} issues=${describeIssues(report)} extraWrites=${extraWrites}`)
      for (const item of checks) {
        console.log(`  ${item.pass ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
      }
      console.log(`  result: ${ok ? 'PASS' : 'FAIL'}`)
    }
  }

  const failures = results.filter(item => !item.ok)
  if (json) {
    console.log(JSON.stringify({ coreRoot, results, failures: failures.length }, null, 2))
  } else {
    console.log(`summary: ${results.length - failures.length} passed, ${failures.length} failed`)
    if (failures.length > 0) {
      console.log('expected-red on c71dbc9: the negative scenarios still need a locatable diagnostic.')
      console.log('This file is not part of the formal repository test suite.')
    }
  }
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch(error => {
  console.error(`regression runner error: ${error.message}`)
  console.error(usage())
  process.exitCode = 2
})
