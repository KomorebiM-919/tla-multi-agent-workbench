# Collected evidence output v2

This is a wire-format revision within TLA V0.2, not a new TLA product version.
It replaces the offline collector's v1 output. Input remains the normalized
`tla.observation-protocol/v1` format, with stricter closure checks below.
The legacy acceptance CLI and its standalone v1 predicate are unchanged.

## Consumer contract and migration

Reports have `schema: tla.collected-evidence/v2`,
`scope: synthetic-protocol` and `hostVerified: false`. These fields apply to
success and failure reports. Success remains `verdict: synthetic-closed`.
The generic nested `acceptance` field is **removed**, with no compatibility
alias. Consumers must read `syntheticAcceptance` and must check the outer schema,
scope, status and verdict first. Its inner `closed` is a pure synthetic
derivation, not independent host acceptance. No report here can certify a live run.

Old consumers that only know `tla.collected-evidence/v1` must reject v2, not
guess missing fields. Update their supported schema and nested-field access;
do not rename old reports and treat them as newly verified v2 evidence.
Old protocol samples without reviewer reads now produce incomplete v2 reports.
No automatic log backfill, output migration or live observer is supplied.

## Closure rules

1. Each successful `needs_revision` records the rejected work ID, work attempt,
   rejected review task and rejection index. The latest rejection of a work
   defines that work's current rejection epoch.
2. A repair stores the rejection index current at its creation. It cannot use a
   pass for another work or for a newer rejection that arose after its creation.
3. **Every rejected work** must close through its own newest-created repair for
   its current rejection epoch and a successful review of that exact repair
   attempt. A global count of reject/repair/pass events is insufficient.
4. Every completed repair must have its own corresponding passing review,
   including an older completed repair superseded by a newer one. A newer
   approval cannot silently excuse an unreviewed older repair task.
5. Every work that changed a recognized implementation path must enter a
   rejection/repair/pass chain. An unrelated unreviewed work cannot piggyback
   on another chain. This adapter tests repair-loop demonstrations; direct
   approval of work without repair is not a supported profile. Work with no
   implementation writes is still subject to ordinary task-completion checks.
6. Both rejected and passed reviews require the assigned reviewer session, in
   the review task's current attempt, to read the latest written bytes of every
   implementation path changed by its target. Reads must follow target
   completion and match the target's latest write hashes. Worker reads, earlier
   review reads and other review sessions/attempts cannot substitute.
7. A subsequent write to an approved path invalidates the selected approval's
   snapshot, even if the later write eventually leaves identical bytes. Shared
   path conflicts are conservatively incomplete; the collector does not invent
   supersession or merge semantics between independent chains.

Read-back and review checks concern the **latest write per changed path**, not
every intermediate write. They establish byte observation, not that a reviewer
understood the program or ran an independent test. A distinct session/role does
not prove distinct model/provider identity. All assertions are still synthetic.

## Implementation-write diagnostics

After every normalized operation has been validated, the collector audits each
accepted implementation-write event. Work writes need that work/attempt's closed
current chain. Repair writes need the repair's own completed attempt and matching
historical passing review, including the correct work, rejection epoch and review
task/attempt/session. A later repair's pass cannot approve an abandoned, failed
or unreviewed earlier repair, even when it rewrites the same path.

Every uncovered write adds this locatable issue and makes `status: INCOMPLETE`:

```text
{
  code: IMPLEMENTATION_WRITE_REVIEW_UNPROVEN,
  callId, writeIndex, taskId, attemptId, sessionId,
  path, taskKind, taskStatus
}
```

`writeIndex` is the validated call's result-order index; `path` is the same
normalized project-relative path used in file evidence. Each write gets its own
issue, including intermediate writes to one path. Canonical replay is deduplicated
before this audit. No raw file or subject bytes are exposed by these fields.

An older completed repair with its own valid historical pass remains reviewed;
it need not be the latest selected repair in `evidence.chains`. That field still
lists current selections, not a complete historical review transcript. Current
chain freshness rules remain unchanged. This is no automatic supersession rule
for unreviewed attempts or independent chains.

Existing validation/closure errors remain first in `issues`. Supplemental write
issues are appended only when the entire operation stream was validated. An
invalid/failed/truncated protocol prefix is already incomplete and is not claimed
to provide an exhaustive list of unreviewed writes. No-write or note-only tasks
do not produce implementation-write issues; unfinished tasks can still make the
outer verdict `partial` with collection status `COMPLETE`. Consumers must continue
to check schema, scope, status and verdict together.

The input, CLI, output v2 identity, old acceptance CLI and ten condition codes
are unchanged. New issue context and multiple supplemental issues are additive;
consumers must not assume one issue or a fixed two-field issue shape. Clean-looking
reports from older collector revisions are not retrospectively revalidated.

## Audit fields

`evidence.tasks` keeps existing task IDs/kinds/statuses/attempt/lineage fields and
adds `subjectSha256` and `subjectBytes`. These hash/count the exact original
subject's UTF-8 bytes without trimming, Unicode or newline normalization. Raw
UTF-16 strings with unpaired surrogates are rejected rather than silently
replacing them during UTF-8 encoding. Raw
subjects remain omitted from output. A digest aids integrity comparison; it
does not authenticate the subject or guarantee secrecy against guessing.

`evidence.chains` lists each rejected work's selected current chain:

```text
{
  workTaskId, workAttemptId, rejectionIndex, rejectedReviewTaskId,
  repairTaskId, repairAttemptId,
  reviewTaskId, reviewAttemptId, reviewerSessionId, passIndex,
  reads: [{path, sha256, index, taskId, attemptId, sessionId}],
  closed: <boolean>, problem: <code or null>
}
```

Missing selections are null. `problem` is `REJECTED_WORK_CHAIN_INCOMPLETE` or
`REVIEW_STALE_AFTER_WRITE` for an open selected chain. Other collector issues
include `REVIEWER_READ_UNPROVEN`, `REPAIR_REVIEW_INCOMPLETE`,
`WORK_REVIEW_CHAIN_INCOMPLETE` and `PASS_LINEAGE_UNPROVEN`.
`status: INCOMPLETE` always blocks the nested predicate from receiving usable
evidence. Chain diagnostics can be empty after an earlier validation failure;
a closed chain entry alone does not establish overall report success.

The original input IDs/root/bytes/links/ledger remain caller-supplied synthetic
assertions. This revision does not add real identity authentication, physical
containment, live member capture, concurrency or retry support. A live adapter
and separate host validation remain required.
