import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateMountProbe, readMountProbeInput } from './lib/observer-mount-probe.mjs'

export const MOUNT_PROBE_CLI_SCHEMA = 'tla.observer-mount-probe/v1'

function parseCli (argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--input') {
      index += 1
      if (argv[index] === undefined) throw new Error('--input requires a value')
      options.input = argv[index]
    } else if (arg === '--json') {
      options.json = true
    } else {
      throw new Error('unknown argument: ' + arg)
    }
  }
  if (options.input === undefined) throw new Error('--input is required')
  return options
}

export function main (argv = process.argv.slice(2)) {
  let options
  try {
    options = parseCli(argv)
  } catch (error) {
    process.stderr.write('mount-probe: ' + error.message + '\n')
    return 1
  }
  let report
  try {
    report = evaluateMountProbe(readMountProbeInput(resolve(options.input)))
  } catch (error) {
    process.stderr.write('mount-probe: ' + String(error.message) + '\n')
    return 1
  }
  if (options.json === true) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    process.stdout.write('MOUNT PROBE ' + report.status + ' (hostVerified=false, coverage=unknown, closed=false)\n')
    for (const check of report.checks) if (!check.ok) process.stdout.write('  ' + check.code + ': ' + check.detail + '\n')
  }
  if (report.status === 'probe-passed') return 0
  return report.status === 'failed' ? 2 : 1
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
