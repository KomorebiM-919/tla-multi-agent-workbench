# DSH review — core round 4 (lineage and reviewer-owned reads)

Date: 2026-10-20. Reviewer: DSH. Review target: `c71dbc95edd57082756719b1eec572996f325305`
(`fix/v0.2-core-acceptance`). Parent: `1d316c62fc99dcbeefd8da5b8e93afdf3909a4ac`.
Increment: `1d316c6..c71dbc9`, 9 files, +571/−82.

The review used an independent archive copy of the commit, not the V0.2 feature
worktree. Nothing was merged or cherry-picked. No host, fake model, model call,
dependency install, ACL/profile change, merge or force-push was performed.
Real host experiment authorization remains zero.

## Verdict

**Conditionally accept the synthetic lineage and reviewer-read fixes; do not
treat this as real host closure.**

- The previous P1 (a pass from one chain masking an unfinished rejected chain)
  is fixed for closed collection: every rejected work must close through its
  current rejection epoch and its own newest repair.
- Reviewer reads are now bound to the review task's own session, task and
  attempt, must follow target completion and must cover every changed
  implementation path. Later writes invalidate the selected approval.
- Output v2 replaces `acceptance` with `syntheticAcceptance`, emits no alias,
  and emits exact UTF-8 subject hashes/counts without raw subject text.
- Nine specified suites pass in the independent copy (counts below).
- **P2 diagnostic gap found:** an incomplete or failed repair can leave an
  implementation write that is present in `evidence.files` but is not attached
  to any chain. Collection still reports `status: COMPLETE` with `issues: []`;
  only the nested predicate's `TASKS_COMPLETED` makes the report `partial`.
  It is not a false `synthetic-closed`, but the write is not attributed or
  flagged as unreviewed.

## What was exercised

All commands ran from the independent copy and each process exited 0:

| Suite | Result |
| --- | --- |
| `tests/v02-core-acceptance.test.mjs` | 30 checks |
| `tests/v02-acceptance-summary.test.mjs` | 19 checks |
| `tests/v02-evidence-collector.test.mjs` | 68 checks, migrated to v2 |
| `tests/v02-evidence-lineage.test.mjs` | 18 checks |
| `tests/v02-ledger.test.mjs` | 59 checks |
| `tests/v02-reactive-model.test.mjs` | 45 checks |
| `tests/v02-repair-loop-v3.test.mjs` | 43 checks |
| `tests/preflight-script.test.mjs` | 9 scenarios / 42 assertions |
| `tests/workflow-logic.test.mjs` | 114 scenarios / 547 assertions |

This is the handoff's nine-command set. It is not the whole project test suite,
and no V0.1 scenario was re-run this round.

## Lineage

The collector now records, for each `needs_revision`, the rejected work, work
attempt, review task and rejection index. A repair freezes the rejection index
current at creation. Closure selects the newest-created repair for the current
rejection epoch and requires the pass of that exact repair attempt. Completed
repairs from older epochs also need their own pass. A completed repair whose
pass is stale, and a review pass that borrows another repair's approval, are
rejected.

Independently reproduced checks:

- one unclosed chain plus one closed chain → `REJECTED_WORK_CHAIN_INCOMPLETE`;
- two independently closed chains → `synthetic-closed`;
- a completed later repair without its own pass → `REJECTED_WORK_CHAIN_INCOMPLETE`
  or `REPAIR_REVIEW_INCOMPLETE`;
- a newer rejection borrowing an older repair → `PASS_LINEAGE_UNPROVEN`;
- an implementation-changing work with no review → `WORK_REVIEW_CHAIN_INCOMPLETE`;
- a shared path written again after approval → `REVIEW_STALE_AFTER_WRITE`.

These are accepted for the synthetic protocol. They do not prove a live
producer supplies correct task/attempt/rejection lineage.

## Reviewer-owned reads

`reviewerReadsFor` requires, for each latest write of every implementation path
changed by the review target:

- `taskId` = the review task, `attemptId` = that task's current attempt;
- `sessionId` = the review task's assigned session;
- operation index after target completion and after the write;
- SHA-256 equal to the target's latest write.

A different reviewer session, a worker read, a review task's earlier attempt,
a read before target completion, a read of only some changed paths and a write
after the read are all rejected. A later write to an approved path invalidates
the selected snapshot even when the later bytes are identical.

The read is still a synthetic observation. It proves an asserted byte read by
the asserted session/attempt; it does not prove a distinct model identity,
reviewer understanding or an independent test run.

## Output v2 and subjects

Observed and tested:

- schema is `tla.collected-evidence/v2`; `scope: synthetic-protocol` and
  `hostVerified: false` are unconditional;
- `syntheticAcceptance` replaces the nested `acceptance`; there is no alias;
- `evidence.tasks` adds `subjectSha256` and `subjectBytes`; raw subject text is
  omitted;
- the hash is taken over the exact UTF-8 bytes with no trim, Unicode or newline
  normalization; unpaired UTF-16 surrogates are rejected rather than hashed as
  replacement characters;
- old v1 consumers must reject v2; old protocol records without reviewer reads
  now produce incomplete reports. This is a stricter input contract, not an
  unchanged-input compatibility promise.

The generic nested `closed` value still exists inside `syntheticAcceptance`.
Consumers must gate on the outer schema, scope, status and verdict; the nested
value alone is not host acceptance. This is documented, but remains a
consumer-risk P3.

## Findings

### P2 — unfinished repairs can leave unattributed implementation writes

Reproduction (invented records, no host):

1. Work `t1` writes `src/sum.mjs` broken; review `t2` rejects it.
2. Repair `t3` is created for that rejection, writes `src/extra.mjs`, reads it,
   and never completes.
3. A second repair `t5` for the same rejection writes and completes `src/sum.mjs`;
   review `t4` reads `src/sum.mjs` and passes.
4. Collection returns `status: COMPLETE`, `issues: []`, `verdict: partial`.
   `evidence.files` contains two reads and one write of `src/extra.mjs`;
   `evidence.chains` contains only `t1 → t5`.

The nested predicate is `partial` because `t3` is still `in_progress`, so this
is not a false `synthetic-closed`. But the collector does not attribute the
extra write to a chain and emits no `REPAIR_REVIEW_INCOMPLETE`-class issue. A
consumer that gates on `status` and `issues` while ignoring `verdict` can read
this as a clean collection. The same occurs when the abandoned repair is
`failed`, and when its rejection epoch was superseded by a later rejection.

The fix should make any implementation-changing task that is not part of a
closed chain produce an issue, including incomplete/failed repairs, or make
`status: INCOMPLETE` when such a write is present. This is a collection
diagnostic gap, not evidence of a false acceptance in the current predicate.

### P2 — run identity and physical properties remain assertions

`binding.runnerRunId`, `gateRunId` and `budgetRunId` are checked against the
payload; they are not cross-checked against independent runner/gate/budget
evidence and are not authenticated. `links: none`, `fileKind: regular`,
`coverage: full`, suite bytes, snapshots and exact bytes are supplied and
validated as synthetic records; no filesystem, live transcript or signing
authority is consulted. The round handoff says this explicitly. It remains a
blocker for converting a synthetic success into host acceptance.

### P3 — latest-write scope

`readBackFor`, reviewer reads and the final implementation read-back operate on
the latest write per path. A path written more than once needs only the latest
read-back. This is explicitly documented and was not presented as every-write
coverage; it is acceptable for the declared contract but should not be described
as complete write history.

## Compatibility and boundaries

- Input schema remains `tla.observation-protocol/v1`; no new input fields.
- Legacy `tools/acceptance-summary.mjs`, its CLI, its ten condition codes and
  the V0.1 interfaces are unchanged by this round.
- The collector remains opt-in and is not integrated into `summariseRun`.
- Output v2 is a breaking wire change; old reports are not migrated.
- Strictness increased: old positive records without reviewer reads now fail.
- No live observer, member transcript capture, physical containment, retry or
  concurrency support is added.
- No real host, fake-model service or model was started. Real V0.2 repair-loop
  acceptance remains unverified.

## Recommendation

Accept the per-lineage closure, reviewer-read binding, output-v2 migration and
subject hashing as synthetic-protocol work. Before claiming that "unreviewed
implementation changes cannot hide", close the P2 unattributed-write gap and
make `status`/`issues` reflect it. Do not promote `synthetic-closed` to host
acceptance; the run/physical/identity assertions and the missing live observer
remain outside this commit.

The original handoff MANIFEST remains frozen at its original core baseline; this
review adds only its own entry and does not refresh the old core-file hashes.
