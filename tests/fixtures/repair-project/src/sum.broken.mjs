// BUG-SKIP-NEGATIVE: this version drops negative values, so sum([1,-2,3]) is 4 instead of 2.
// The regression test in ../test/sum.test.mjs fails on it; the repair loop has to find that out
// through the real test command, not by reading this comment.
export function sum(values) {
  if (!Array.isArray(values)) throw new TypeError('sum expects an array');
  let total = 0;
  for (const value of values) if (value > 0) total += value;
  return total;
}
