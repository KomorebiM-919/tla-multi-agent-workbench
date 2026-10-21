#!/usr/bin/env node
// Offline inspector for tla.tool-metadata-trace/v1. It writes metadata
// diagnostics only and never calls acceptance/synthetic collectors.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  inspectTraceBytes, makeReport, emptyCounts, TRACE_LIMITS, TraceError,
  REPORT_DIAGNOSTIC_CODES
} from './lib/tool-trace-contracts.mjs';
import { assertFreshOutputPath, assertInputFile } from './lib/trace-output.mjs';

const HELP = `Usage: node tools/inspect-tool-trace.mjs --trace <file> --out <fresh-report.json>
Exit 0 VALID_METADATA, 2 INCOMPLETE/invalid input, 1 usage or output I/O failure.`;

function usage(message) {
  if (message) process.stderr.write(`inspect-tool-trace: ${message}\n`);
  process.stderr.write(`${HELP}\n`);
  process.exit(1);
}

function parse(argv) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(`${HELP}\n`); process.exit(0); }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--trace', '--out'].includes(flag) || value === undefined || value.startsWith('--')) usage('expected --trace and --out');
    if (values.has(flag)) usage('duplicate argument');
    values.set(flag, value);
  }
  if (!values.has('--trace') || !values.has('--out')) usage('both --trace and --out are required');
  return { trace: values.get('--trace'), out: values.get('--out') };
}

function errorReport(code) {
  return makeReport({
    status: 'INCOMPLETE', origin: null, traceId: null,
    binding: { status: 'unproven', claim: null },
    counts: emptyCounts(),
    diagnostics: [{ code: REPORT_DIAGNOSTIC_CODES.includes(code) ? code : 'INPUT_INVALID', receiptSeq: null, count: 1 }]
  });
}

function writeReport(out, report) {
  assertFreshOutputPath(out);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function main() {
  const args = parse(process.argv.slice(2));
  let report;
  let exitCode = 2;
  try {
    const tracePath = assertInputFile(args.trace);
    const info = statSync(tracePath);
    if (info.size > TRACE_LIMITS.maxBytes) throw new TraceError('INPUT_INVALID', 'input exceeds 8 MiB');
    const bytes = readFileSync(tracePath);
    const result = inspectTraceBytes(bytes);
    report = makeReport(result);
    exitCode = result.status === 'VALID_METADATA' ? 0 : 2;
  } catch (error) {
    if (error instanceof TraceError) {
      report = errorReport(error.code);
      exitCode = 2;
    } else {
      report = errorReport('INPUT_IO_FAILED');
      exitCode = 2;
    }
  }
  try {
    writeReport(resolve(args.out), report);
  } catch (error) {
    process.stderr.write(`inspect-tool-trace: cannot write report: ${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${report.status} ${report.counts.observations} observations\n`);
  process.exit(exitCode);
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
