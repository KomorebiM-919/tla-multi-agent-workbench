# Core round 1: acceptance counterexamples

Base: `afead09bdbc996b4d428dbf95fc01dcf002f3e1f` (documentation handoff),
code baseline: `943901ed9ee1b21e74c44f1fd1bfc7628a284d2e`.

This independent fix branch changes only the acceptance predicate, adds its own
regression file, and records the result. The DSH worktree is untouched. No host,
upstream service, model request, dependency or profile is involved.

## Contract

The existing CLI, schema and ten condition codes remain unchanged. Inputs that
previously falsely passed now fail their existing condition:

- Read-back requires two valid SHA-256 values; two absent or malformed hashes
  cannot establish equality. Hexadecimal letter case is immaterial.
- A passing review must occur after a rejection in the supplied event sequence.
- A red test needs an integer positive exit status, a positive failure count,
  and a nonempty command. A later green entry must use that same command.
- Final green requires at least one passed test.
- Completed tasks need distinct nonempty identifiers.
- Implementation paths cannot contain empty, dot or parent-directory segments,
  or Windows separators. Collector inputs use canonical project-relative paths.

## Verification

Run `node tests/v02-core-acceptance.test.mjs`: one positive case plus eight
counterexamples. All eight counterexamples reproduced before the fix; all pass
after it. Existing `node tests/v02-acceptance-summary.test.mjs`: 19 passed.
The incoming manifest's 19 recorded files were checked against Git object bytes.

## Remaining core blockers

This is predicate hardening, not a completed evidence collector. `summariseRun`
currently receives policy facts lacking the ordered read/write hashes expected
by `deriveAcceptance`, drops read events, and does not produce test history.
`readTasks` also discards task subjects used for repair identification. Therefore
the CLI still cannot demonstrate a valid closed real run. Do not insert invented
history/hashes or weaken the predicate to compensate.

Policy rule names remain hints rather than independent proof that a review tool
succeeded. A subsequent core package must pair actual tool calls/results, retain
task identity and ordered test evidence, bind them to this run, and test the
collector-to-verdict path. DSH should not modify that core implementation in
parallel; it can independently review these changes and prepare sanitized
protocol samples with successful and failed tool results.

No new host-run permission is granted by this handoff. V0.2 is not accepted.
