# Core round 3: synthetic evidence collection

Starting commit: `e3f8573e086974ae52e179f4942318a310f3c63f`.
DSH review input: `a4c0afbeb3decc9cead92a6377cc1aa0610f4e4a` on the separate
V0.2 branch. No merge/cherry-pick of that branch is performed here.

## Deliverables

1. `6fe2170742669560f488be980d371f6d8bb053e7` rejects non-string SHA-256
   values in the existing predicate, with an explicit detail message. The
   regression reproduced the TypeError for BigInt, array and object values
   before the fix; four type counterexamples are now tested. The v1 schema,
   CLI and ten condition codes remain unchanged.
2. `tools/collect-run-evidence.mjs` implements an independent, pure collector
   for `tla.observation-protocol/v1`. It validates explicit expected run mapping,
   member sessions, paired observations and order; computes hashes from exact
   byte snapshots; builds test history and task/attempt/review lineage; then
   calls the existing predicate. Its CLI only reads one specified JSON file.
3. `docs/EVIDENCE-PROTOCOL-v1.md` is the concrete normative contract, enforced
   by the collector's single runtime validator. It defines all envelope and
   observation fields, version/limits, roles, operation types, deduplication,
   failure handling, bytes, paths, retention and compatibility. There is no
   second, independent schema validator that can disagree with the runtime.
4. `tests/v02-evidence-collector.test.mjs` constructs invented paired protocol
   records and exercises collection -> verdict, including the CLI read path.
   It does not execute the command strings inside those records.

## What the collector actually establishes

It accepts **synthetic normalized observations only**. These are not raw DSH
request bodies; the observation fields are our protocol, not claimed host API
fields. A live origin, old schema, policy facts or run10 log cannot be silently
upgraded into this protocol. Runner, gate and budget IDs are separately bound;
the runner's ID may legitimately differ from the other two.

Both calls and results must exist with matching IDs and active task attempts.
Serial global order comes from one declared synthetic observer. Exact replay
is deduplicated, conflicts/overlaps/unknown order fail. SHA-256 is derived from
full original bytes with no newline conversion. Changed files require prior
same-session observation and read-back; **all changed implementation paths**
are checked at the collector boundary, not just the latest path. Review pass
must belong to a completed repair of the rejected work, with actual changed
bytes and same-command/same-suite red-to-green evidence in the protocol.

Outputs always include `scope: synthetic-protocol`, `hostVerified: false`.
The top-level success is `synthetic-closed`, never a live `closed`. The nested
legacy predicate may be `closed` on valid synthetic evidence; it is withheld
from all partial/invalid collections by passing empty evidence to that predicate.
The report includes validated ID mapping, hashes and counts, not snapshots,
stdout, subjects or command text. It does not claim automatic secret detection.

## Acceptance and compatibility evidence

All commands below completed with exit 0 in the independent core worktree:

| Test | Result |
| --- | --- |
| `v02-core-acceptance.test.mjs` | 30 checks |
| `v02-acceptance-summary.test.mjs` | original 19 checks |
| `v02-evidence-collector.test.mjs` | 68 scenarios, including CLI success/invalid/truncated input |
| `v02-ledger.test.mjs` | 59 checks |
| `v02-reactive-model.test.mjs` | 45 checks |
| `v02-repair-loop-v3.test.mjs` | 43 checks |
| `preflight-script.test.mjs` | 9 scenarios / 42 assertions |
| `workflow-logic.test.mjs` | 114 scenarios / 547 assertions |

The new schema is opt-in and independent. `summariseRun`, runner/spec fields,
fixtures, budget plugin and V0.1 production code are unchanged. No compatibility
claim is made for host execution or for all repository tests. Normalized strings
are stricter than arbitrary JS values; unsafe integers/non-JSON values fail.

## Remaining work and independent review request

- A real observation producer is **not implemented**. Live member discovery,
  versioned host parsing, physical containment, byte capture at each operation,
  authenticated provenance and cross-session partial-order handling still need
  their own design/integration. Current `links: none` is a synthetic assertion.
- V1 rejects concurrent operations, unsuccessful non-test tools and failed
  attempts even if later retried. This is intentionally conservative, not full
  retry/concurrency support. A real observer must not invent serial order.
- Synthetic runner/ledger facts are supplied context, not independently measured
  real-process evidence. The adapter cannot authenticate them.
- The standalone old acceptance CLI still lacks actual event hashes/test history
  and subject preservation. It has not been connected to this new protocol.
- The bare legacy predicate still checks the latest implementation write only;
  the stronger all-path check belongs to this new collector boundary.

DSH should independently challenge binding, sequence/replay, failed tools,
attempt/review lineage, exact bytes, filesystem claims and scope classification.
Do not change core files concurrently; publish review notes separately.
The original incoming `MANIFEST.json` continues to pin its original handoff
baseline; it is not rewritten to disguise changed core bytes. Review this
round against the new Git commit and its parent, not those frozen file hashes.

No real DSH/fake-model service was started, no model request was made, and no
dependency, ACL or profile was changed. No merge or force-push. Host experiment
authorization remains zero. **V0.2 real repair-loop acceptance remains unverified.**
