#!/usr/bin/env node
// Migration-link test entry. The outcome is deliberately three-valued:
//   0  PASS                  every fixture prerequisite and assertion held;
//   1  FAIL                  at least one assertion failed; env blocks are also reported;
//   2  ENVIRONMENT_BLOCKED   no assertion failed, but a required fixture capability was unavailable.
// A blocked capability is neither skipped nor converted into a pass.
import {
  formatReport,
  runMigrationLinkSuite
} from './lib/migration-link-suite.mjs';

const report = await runMigrationLinkSuite();
const asJson = process.argv.includes('--json');
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatReport(report));
  console.log('Note: rules 0=PASS, 1=FAIL (assertion), 2=ENVIRONMENT_BLOCKED.');
}
process.exitCode = report.exitCode;
