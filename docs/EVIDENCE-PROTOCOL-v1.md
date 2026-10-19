# Observation protocol v1 (synthetic adapter only)

Status: a new independent collector contract. It is not a DSH API or a retrofit
of old experiment logs. No live observer is implemented. Its output cannot
certify a real host run, even when its nested acceptance predicate is `closed`.

## Envelope and trust

`schema` is `tla.observation-protocol/v1`; `origin` must be `synthetic`.
`binding` has nonempty `runnerRunId`, `gateRunId`, `budgetRunId` strings.
Gate and budget IDs must agree, while the runner ID may differ. The caller must
independently pass the expected binding and project root; the payload cannot
choose its own expected IDs. There is no authentication or signed provenance.

`projectRoot` is an absolute drive path or POSIX path. `observer` has `{id,
ordering: 'serial-total', complete: true}`. `sessions` is an array of `{id, role}`
with unique IDs and roles `captain`, `worker`, `reviewer`. Member operations are
explicitly present, not inferred from subagent descriptors or catalog entries.

`runner` has `{runId, status, hostStarted}`; `ledger` has `{gateRunId, budgetRunId,
completeness, ledgerConsistent}`. They describe synthetic context only, must
match the binding, and are not read from real runner/gate files by this adapter.

`operations` is an array of the following completed-operation records. Unknown
fields, versions, operation types, roles and ordering modes are rejected.

```text
{
  runId: <gateRunId>, sessionId: <registered session>,
  call: {id, name, input},
  result: {toolUseId: <same call id>, isError: <boolean>, complete: true},
  order: {authority: <observer id>, call: <safe integer>, result: <safe integer>},
  observation: {type: <one of the types below>, ...}
}
```

This adapter consumes normalized paired observations. It does not parse raw
DSH transcripts, and the normalized `observation` fields are not asserted to
exist in DSH tool responses. Tool names use the existing schema fixture's
names, but any live adapter must verify its own versioned host contract.

## Ordering, replay and failures

The single observer assigns globally unique nonnegative safe integers at call
start and result completion. Each call precedes its result. V1 supports serial
operations across registered sessions: one result must precede the next call.
Overlaps, unknown cross-session order and wall-clock/per-session-only order are
unprovable in v1 and block closure; timestamps never become an invented index.
Storage order is irrelevant. Exact replays of the same `(sessionId, call.id)`
record are deduplicated; changed replays, duplicate sequence indices, orphan
results and missing/partial results are rejected. Retry calls need new IDs.

Any unsuccessful non-test tool blocks this v1 collection, even if later retried.
Failed attempts are not converted into successful observations. A test tool may
return `isError: true` only when an independently observed process exit is
positive and the complete structured test output reports failed tests. No text
alone establishes a process exit. Missing data remains `INCOMPLETE`.

## Observation types

Every task-bound observation includes `taskId` and the current `attemptId`.

| type | Tool | Additional fields and checks |
| --- | --- | --- |
| `task-create` | `agent_teams_create_task` | `taskId, subject, taskKind, assignee, sourceTaskId, reviewedTaskId`; captain only. Kind is `work`, `repair`, or `review`; input subject/kind/assignee and nullable lineage fields must match. IDs are unique. |
| `task-claim` | `agent_teams_claim_task` | `taskId, attemptId`; owner only, pending -> claimed. Attempt IDs are unique. |
| `task-update` | `agent_teams_update_task` | `taskId, attemptId, status`; owner only, claimed -> in_progress -> completed/failed. Input task/attempt/status must match. Review completion uses `review` instead. |
| `file-read` / `file-write` | `read` / `write` | `taskId, attemptId, path, fileKind:'regular', links:'none', coverage:'full', bytesBase64`; writes also have `beforeBase64`. Active owner only. Writes require a worker, a same-session read of those prior bytes, and changed bytes. Input file_path must resolve to the same path; write input UTF-8 content must exactly match observed after-bytes. |
| `test` | `pwsh` | `taskId, attemptId, command, cwd:'.', exitCode, stdoutBase64, suitePath, suiteBase64`; input command and nonempty description required. Command is exactly `node <canonical suitePath>`, suite under `test/`. Integer exit in 0..255, complete UTF-8 stdout with exactly one `tests: N passed, M failed` summary, positive total count, and exit/count agreement required. Suite bytes must stay fixed across the run. |
| `review` | `agent_teams_update_task` | `taskId, attemptId, reviewedTaskId, verdict`; active reviewer only, task kind review, input status completed and matching verdict. `needs_revision` requires completed work and red test evidence. `passed` requires completed repair of that rejected work, repair-time green test with unchanged suite/command, and read-back of every implementation file changed by that repair. |

Task creation starts at pending with no attempt; the successful claim supplies
the attempt. Review targets and repair source tasks must already exist. A repair
may only be created after the successful rejected review of its source work.
Task subjects are preserved; normalized task kind/lineage, not subject regexes,
establish repair identity. A repair completion requires actual implementation
change, read-back and green evidence in its own active attempt, following the
source work's red run. All task completions are derived from paired results.

## Bytes and paths

Snapshots are canonical base64 of exact full-file bytes, not UTF-8-decoded text,
line-numbered tool output, or an after-run file hash. SHA-256 is computed by the
collector. CRLF, LF and encodings are not normalized. Empty files are allowed;
partial/redacted byte snapshots cannot prove equality. Suite bytes are likewise
hashed without newline conversion. Only write *input* content and test stdout
are decoded as UTF-8; neither substitutes for a file snapshot.

Paths must remain under the expected project root. Separators normalize to `/`;
drive-root paths are compared case-insensitively. Parent/dot segments, UNC,
device paths, alternate streams, control characters, trailing dot/space and
Windows reserved component names are rejected. `links:'none'` and
`fileKind:'regular'` are synthetic observer assertions, **not physical symlink
verification**. No filesystem is accessed during collection. A future live
observer must prove realpath/handle containment and byte capture at the operation;
this adapter alone cannot secure real paths against symlinks or races.

## Limits, output and compatibility

Input JSON is at most 1 MiB and 32 nesting levels, operations at most 128, each decoded snapshot at most
64 KiB, IDs at most 128 characters and paths at most 1024 characters. These are
hard limits. Unknown schemas and non-JSON input are rejected; there is no
automatic upgrade or migration of legacy logs. Full bytes are processed only
in memory. Output omits snapshot contents, stdout, subjects and command text;
only hashes, counts, IDs, normalized paths and condition codes are emitted.
Keep raw inputs local, outside published evidence; public review fixtures must
use invented data. The collector never writes files or executes any command.

Output schema: `tla.collected-evidence/v1`. `binding` retains the validated ID mapping
(or null if it could not be validated). `scope:'synthetic-protocol'` and
`hostVerified:false` are unconditional. `status` is `COMPLETE` or `INCOMPLETE`.
`verdict` is `synthetic-closed`, `partial` or `not-started`. The nested
`acceptance` uses the existing v1 predicate; it can be closed only when collection
has no issues. Failed collection feeds empty evidence into that predicate.
All changed implementation paths additionally need read-back at collection
boundary (the legacy predicate alone still checks only its latest write).

The old acceptance CLI, ten conditions, fixtures, spec and V0.1 interfaces remain
unchanged. No automatic integration into `summariseRun` is provided. The new CLI
requires `--protocol`, `--runner-run-id`, `--gate-run-id`, `--budget-run-id` and
`--project-root`; it prints a report, with exit 0 for synthetic-closed, 2 for
incomplete/unmet evidence and 1 for CLI/I/O errors. No live closure claim follows
from exit 0. Run10 lacks these observations and cannot be migrated by filling
missing hashes, call IDs or order.
