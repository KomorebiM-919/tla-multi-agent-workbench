# DSH review — core round 5 (locatable P2 diagnostics)

Date: 2026-10-20. Review object: code
`a0b445048a65dbd63c08d3c52cfdbc9d0d99b90b`, parent
`c71dbc95edd57082756719b1eec572996f325305`, documentation tip
`8bf26d38bf86052974c47029ae75ab7fd20545f1`.

The target was replayed in an independent clone and a writable copy. It was not
merged or cherry-picked into the DSH V0.2 branch. The V0.2 workspace baseline was
`356e902d4d31c3d030cc9a915c7c93815e83ba7a` (clean). No host, fake model service,
model call, dependency install, ACL/profile change or real experiment was made.
Real-host startup authorization remains zero.

## Verdict

**Conditionally accepted.** The P2 defect is fixed for the tested synthetic
contract: an unowned implementation write now produces a locatable
`IMPLEMENTATION_WRITE_REVIEW_UNPROVEN` diagnostic instead of a COMPLETE/partial
report with no issue. The original six-scenario package now returns four
`INCOMPLETE` / `partial` negatives with bound issue fields and two
`COMPLETE` / `synthetic-closed` positive controls. The new 17-scenario diagnostic
suite passes.

This is not a real-host closure claim. The evidence is still a synthetic
protocol with no live observer, no physical file verification and no independent
run-ID authentication. The residual items below must be read before treating the
contract as production verification.

## What was checked

### Commit boundary

- `a0b4450` parent is `c71dbc9`.
- `c71dbc9..a0b4450` is six files, `+305/−4`: `README.md`,
  `docs/COLLECTED-EVIDENCE-v2.md`, `docs/ROADMAP.md`, `tests/README.md`,
  `tests/v02-write-review-diagnostics.test.mjs`, `tools/collect-run-evidence.mjs`.
- `8bf26d3` parent is `a0b4450`; the tip adds only `CORE-ROUND5.md` and
  `CORE-ROUND5-SELF-CHECK.json` (`+508`).
- The six canonical Git-blob `bytes`/`sha256` values in the self-check match the
  actual blobs, including the collector at `28211` bytes /
  `5cb2b4fee70ccaffb1e8261ba1df96198b097a29acb03b021129683776269e99`.

### The fix

`tools/collect-run-evidence.mjs` now records each write's call ID and, after all
operations have been validated, appends one issue for each implementation write
whose task is not covered by a closed work chain or does not have its own
historical repair approval (`implementationWriteIssues`). It does not append
these diagnostics when collection stopped on an invalid/failed operation, so the
primary error is not replaced by a partial-stream claim.

The issue contains `callId`, `writeIndex`, `taskId`, `attemptId`, `sessionId`,
normalized `path`, `taskKind` and final `taskStatus`. I checked those fields
against the observation on each issue, not just against the JSON text:

| negative | issue fields |
|---|---|
| incomplete repair | `c17`, index `35`, `t3` / `a-t3` / `worker`, `src/extra.mjs`, `repair`, `in_progress` |
| failed repair | same write identity, `taskStatus=failed` |
| superseded rejection | same write identity, `taskStatus=in_progress` |
| multi-path | `c18`/index `37` and `c20`/index `41`, two distinct write events |

The task/attempt/session/path on each issue matched the same write event; no
duplicate issue was emitted for a single write. The multi-path case did produce
two issues, each for a different event.

### Reviewer and lineage boundaries

- A review pass now requires the review task's own session, task and attempt to
  read every latest implementation path produced by the repair, after the target
  completed, with a matching hash. Removing the reviewer's file read produced
  `REVIEWER_READ_UNPROVEN` and did not close.
- A later write to an approved path invalidates the earlier pass
  (`REVIEW_STALE_AFTER_WRITE`).
- A completed repair that has its own historical passing review remains accepted
  when a later rejection epoch supersedes its chain; the new test covers this and
  the original six-scenario positive controls remain green.
- An invalid operation in the prefix preserves the first error; supplemental
  write diagnostics are not claimed from a partial stream.

### Output and interface

- `schema=tla.collected-evidence/v2`, `scope=synthetic-protocol`,
  `hostVerified=false`; the legacy `acceptance` key is absent and
  `syntheticAcceptance` is present.
- Valid negative input exits `2` with `INCOMPLETE` / `partial`; valid positive
  exits `0` with `COMPLETE` / `synthetic-closed`; no-argument CLI misuse exits
  `1`, which matches the CLI contract.
- The old acceptance suite (19 checks) and the unchanged legacy interface remain
  green. Input schema v1 and the ten condition codes are unchanged.
- A real isolated-profile audit still returns `MIGRATION LINKS OK (23 checks)`,
  exit `0`.

## Regression results

The 29 documented commands were run in the writable copy of the fixed target.
**28 exited 0; one test failed for an environment/portability reason, not for a
P2 assertion.**

| group | result |
|---|---|
| 24 `tests/v02-*.test.mjs` | 23 exit 0; `v02-migration-links` exit 1 on a temporary non-code volume |
| `workflow-logic` | exit 0, 114 scenarios / 547 assertions |
| `preflight-script` | exit 0, 9 scenarios / 42 assertions |
| `preflight-claim-integration` | exit 0, 6 scenarios / 59 assertions |
| Python `tests` | exit 0, 43 tests OK |
| Python `examples/text-stats` | exit 0, 97 tests OK |

Detailed suite counts that passed: acceptance 19; b1 5; checkout 6; core 30;
effective-config 8; collector 68; lineage 18; experiment-package 80; runner 117;
fs 20; gate 18 scenarios / 187 checks; health 22; ledger 59; orchestration 12 /
267; plugin-identity 33; prelaunch 11 / 53; reactive 45; repair-loop 55; v3 43;
protocol 123; rehearsal 38; static 6; write-review 17.

### The one failure

`node tests/v02-migration-links.test.mjs` on the writable temporary copy (a
non-code volume) failed three of its seven cases. The test creates a junction and
then checks `fs.lstatSync(...).isSymbolicLink()`. On that volume Node/cmd created
a reparse point that `lstatSync` reported as a normal directory (`not-a-link`),
while the real DSH profile junction on the code volume reports a junction
correctly. The production audit of that real profile still passes all 23 checks.
This is a test portability defect on that volume, not a P2 logic failure; it does
mean the author's “29/29, all exit 0” is not reproducible on every Windows volume.

## Residual findings

### P3 — reviewed repair's earlier intermediate write is not separately diagnosed

A repair that is eventually reviewed can write the same implementation path twice
before the reviewer reads the final bytes. A probe with `FIXED` followed by
`FIXED2`, reviewer reading only `FIXED2`, returned `COMPLETE` / `synthetic-closed`
with no issue. This is not a false closure of the current bytes: the reviewer did
read the final approved snapshot. It is a scope limitation if the contract is
meant to attest every historical write event, not just every final path state.
The handoff already says the current-chain freshness rules apply; this should be
stated explicitly for consumers.

### P3 — self-check mutation evidence is not independently reproducible

`CORE-ROUND5-SELF-CHECK.json` records the three mutations only as
`{syntaxExit:0,testExit:1}`; it does not include the mutation patch, the command
lines or the resulting diff. I independently made three equivalent mutations in
a copy (remove the diagnostic call, remove `callId`, keep only the latest write
per path); each made the new 17-scenario suite exit 1. That supports the claim
that the suite detects this class of regression, but it does not prove the author
ran the exact three mutants described.

### P3 — “29/29” is environment-specific

The self-check's 29 commands are listed and the code hashes are correct, but the
junction-portability failure above means the all-green claim depends on the
volume where `tests/.scratch` is created. The failure is an environment
qualification, not a P2 assertion failure; it should not be hidden by reporting
only the author's green run.

### P2/P3 — remaining synthetic boundaries

Still not proven: a live DSH observer or hook that emits this protocol; physical
symlink/byte/history verification; independent authentication of the runner,
gate and budget run IDs; cross-session partial order; retry/concurrency behavior;
and an actual host repair-loop closure. The output says `hostVerified:false` and
`synthetic-closed`; the nested `syntheticAcceptance.closed` is not a live
verdict. Consumers must gate on the top-level `status`/`verdict`/`scope`.

## Acceptance

- P2 diagnostic fix: **conditionally accepted** for the synthetic protocol.
- New 17-scenario suite: accepted as regression coverage; it is not a host test.
- Original six-scenario package: accepted as an external expected-red/green
  package; its fixed-target result is 6/6.
- Real V0.2 closure, reviewer independence in a live host, and physical evidence
  remain **not verified**. Do not upgrade the V0.2 acceptance state from this
  review.

Recommended follow-up before a live producer is trusted: make the junction test
platform-portable, document the reviewed-repair intermediate-write scope, and
turn the mutation evidence into a reproducible patch/command artifact.
