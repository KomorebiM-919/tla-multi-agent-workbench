// Regression test for the repair loop fixture. Plain node, no test framework:
// the exit code and the "sum tests: N passed, M failed" line are the evidence.
import { sum } from '../src/sum.mjs';

const cases = [
  ['sum([]) is 0', sum([]), 0],
  ['sum([1,-2,3]) is 2', sum([1, -2, 3]), 2],
  ['sum([0]) is 0', sum([0]), 0],
];

let passed = 0;
let failed = 0;
for (const [label, actual, expected] of cases) {
  if (Object.is(actual, expected)) {
    passed += 1;
  } else {
    failed += 1;
    console.log('not ok - ' + label + ' (got ' + String(actual) + ')');
  }
}
console.log('sum tests: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
