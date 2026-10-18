// Recompute one supervised run's ledger with the formal tool.
//
// Why this exists: the supervisor keeps the upstream request log in its own log
// directory, while `recompute-ledger.mjs` expects the four inputs in one run
// directory. Copying them by hand is how the arithmetic drifts, so this tool
// assembles a throw-away view and hands it to the same measurement code.
//
// It only reads. The run directory and the upstream log are never modified.
//
// Usage:
//   node tools/ledger-from-run.mjs --run-dir <dir> --upstream-log <file> [--label text] [--json]
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureRun } from './recompute-ledger.mjs'

export class LedgerInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerInputError'
    this.code = 'LEDGER_INPUT_MISSING'
  }
}

/** Files the measurement code expects inside the run directory. */
export const RUN_DIR_INPUTS = ['plugin-events.jsonl', 'gate-events.jsonl', 'gate-summary.json']

/**
 * Measure one run from its two locations. Throws LedgerInputError instead of
 * reporting an unverifiable zero when an input is missing.
 */
export function ledgerForRun({ runDir, upstreamLog, label }) {
  if (typeof runDir !== 'string' || runDir === '') throw new LedgerInputError('--run-dir is required')
  if (typeof upstreamLog !== 'string' || upstreamLog === '') {
    throw new LedgerInputError('--upstream-log is required')
  }
  if (!existsSync(runDir)) throw new LedgerInputError('run dir is missing: ' + runDir)
  if (!existsSync(upstreamLog)) throw new LedgerInputError('upstream log is missing: ' + upstreamLog)
  for (const name of RUN_DIR_INPUTS) {
    if (!existsSync(join(runDir, name))) {
      throw new LedgerInputError('run dir is missing ' + name)
    }
  }
  const view = mkdtempSync(join(tmpdir(), 'tla-ledger-'))
  try {
    for (const name of RUN_DIR_INPUTS) copyFileSync(join(runDir, name), join(view, name))
    copyFileSync(upstreamLog, join(view, 'upstream.jsonl'))
    return measureRun(view, label === undefined ? runDir : label)
  } finally {
    rmSync(view, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const options = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new LedgerInputError('missing value for ' + flag)
      return argv[index]
    }
    switch (flag) {
      case '--run-dir': options.runDir = next(); break
      case '--upstream-log': options.upstreamLog = next(); break
      case '--label': options.label = next(); break
      case '--json': options.json = true; break
      default: throw new LedgerInputError('unknown argument: ' + flag)
    }
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  let row
  try {
    row = ledgerForRun(parseArgs(argv))
  } catch (error) {
    process.stderr.write('ledger-from-run: ' + error.message + '\n')
    return 1
  }
  process.stdout.write(JSON.stringify(row, null, 2) + '\n')
  return row.completeness === 'COMPLETE' ? 0 : 3
}

if (process.argv[1] && process.argv[1].endsWith('ledger-from-run.mjs')) {
  process.exitCode = main()
}
