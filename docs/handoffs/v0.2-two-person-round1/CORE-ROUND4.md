# Core round 4: closure per lineage and reviewer-owned observations

Date: 2026-10-20. Parent: `1d316c62fc99dcbeefd8da5b8e93afdf3909a4ac`.
Review input: DSH round 3 report, published separately in
`0fb46d02f6f8ed4e79e3f73545c71cecbba9ebc9`. That branch was not merged or
cherry-picked into this independent core branch.

## Review disposition

| Finding | Result |
| --- | --- |
| P1: another chain's pass masks unreviewed rejected work | Reproduced before patch using seven completed tasks, then fixed by per-work rejection/repair/review closure |
| P2: reviewer never reads target files | Reproduced before patch; both decisions now need the assigned review session/attempt's post-target-completion reads |
| P2: subject preservation not auditable in output | Exact UTF-8 subject hash and byte count emitted; raw subject remains private |
| P3: generic nested `acceptance.closed` can be misread | Breaking output schema v2 uses `syntheticAcceptance`; no `acceptance` alias |
| P3: latest path write, not every intermediate write | Explicitly retained and documented; no claim that every write was read |
| Identity / physical properties are assertions | Unchanged synthetic limitation; no real producer/authentication added |

One additional variant was reproduced and fixed during this round: an
implementation-changing work with no review at all could hide behind another
closed chain. Such work now fails `WORK_REVIEW_CHAIN_INCOMPLETE` in this
repair-loop profile. Direct non-repair approval remains unsupported.

## Implementation and audit

- Rejection identity includes work and attempt plus its rejection event index.
  Repair creation freezes that index. A newer rejection cannot borrow a repair
  created for an older rejection.
- Each rejected work selects its newest-created repair for the current rejection
  epoch, then requires the passing review of that exact repair attempt. All
  completed repairs, including older ones, need corresponding historical passes.
- The reviewer must read every target implementation path's latest written
  bytes in its own task/attempt/session after target completion. Another worker,
  session or attempt cannot provide that evidence.
- Subsequent writes to approved paths invalidate the selected snapshot. This
  conservatively rejects unresolved cross-chain shared-path interference.
- `evidence.chains` publishes selected IDs, attempts, rejection/pass indices,
  reviewer read provenance, closed status and problem. `evidence.tasks` adds
  `subjectSha256` / `subjectBytes` without exposing subject text.

Contract: `docs/COLLECTED-EVIDENCE-v2.md`. Input shape stays
`tla.observation-protocol/v1`; verdict semantics are stricter. Consumers must
explicitly support output v2 and read `syntheticAcceptance`, checking outer
schema/scope/status/verdict. There is no v1 compatibility alias or automatic
migration of old reports. CLI success is still synthetic only.

This is a protocol revision inside TLA V0.2, not a new product version/workspace.
The legacy `acceptance-summary` schema/conditions/CLI, production fixtures,
runner/spec, plugin and V0.1 code remain unchanged. The bare legacy predicate
still has global-rule/latest-write limits; do not bypass the collector boundary.

## Tests

All nine commands completed with exit 0 in the independent worktree:

| File under `tests/` | Result |
| --- | --- |
| `v02-core-acceptance.test.mjs` | 30 checks |
| `v02-acceptance-summary.test.mjs` | original 19 checks |
| `v02-evidence-collector.test.mjs` | 68 scenarios, migrated to output v2 |
| `v02-evidence-lineage.test.mjs` | 18 new scenarios |
| `v02-ledger.test.mjs` | 59 checks |
| `v02-reactive-model.test.mjs` | 45 checks |
| `v02-repair-loop-v3.test.mjs` | 43 checks |
| `preflight-script.test.mjs` | 9 scenarios / 42 assertions |
| `workflow-logic.test.mjs` | 114 scenarios / 547 assertions |

The invented protocol builder is shared in
`tests/lib/evidence-protocol-fixture.mjs`. Positive records now actually include
reviewer reads. Old valid records without them are intentionally incomplete
under the tightened rules; this is not an unchanged-input compatibility claim.
Tests cover two closed chains, one unclosed chain, old/new repair borrowing,
new rejection epoch, session/attempt isolation, multiple files, stale approvals,
replay/input immutability, exact non-ASCII subject hashes and output migration.
Unpaired UTF-16 surrogates are rejected so UTF-8 subject digests do not silently
hash replacement characters in place of the original input.
The existing CLI read-path test also checks the new schema and absence of alias.

## Next independent review and boundaries

DSH should challenge per-lineage obligations and reviewer byte-read provenance,
especially interleaved chains, superseding repairs and shared paths. Check
consumer/schema migration and disclosure of stricter inputs. Review in a
separate copy; core files remain ChatGPT-owned. Publish notes separately.

Original handoff hashes remain frozen at their original baseline. Do not refresh
them to match patched source; compare this round's Git commit against its parent.

No real host or fake-model service started, no model experiment, installation,
ACL/profile modification, merge or force-push. Live identity/physical byte
capture and observer provenance remain unimplemented. Host experiment startup
authorization remains zero. **V0.2 real repair-loop acceptance is unverified.**
