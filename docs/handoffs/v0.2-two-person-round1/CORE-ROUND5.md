# Core round 5: locatable diagnostics for unreviewed implementation writes

Date: 2026-10-20. Code commit: `a0b445048a65dbd63c08d3c52cfdbc9d0d99b90b`.
Parent: `c71dbc95edd57082756719b1eec572996f325305`.
Review/regression input: DSH `356e902d4d31c3d030cc9a915c7c93815e83ba7a`.
No merge or cherry-pick of the DSH branch was used.

## Result

The original external regression package produced four expected negative failures
and two passing controls on the pinned original baseline. On the fixed commit,
the same package produces **six passing scenarios**: all four negatives are
`INCOMPLETE` / `partial` with locatable write issues, and both positives remain
`COMPLETE` / `synthetic-closed`. This is not real-host closure.

New issue code: `IMPLEMENTATION_WRITE_REVIEW_UNPROVEN`. Each uncovered write
reports its exact call ID, result-order index, task, attempt, session, normalized
path, task kind and final task status. Multiple uncovered writes get multiple
issues; replay does not duplicate them. In the external multi-path case both
writes of the unreviewed attempt are diagnosed. A later approved rewrite does
not retrospectively review an abandoned attempt's earlier write.

An older **completed and independently passed** repair is still reviewed even
when it is no longer the latest selected repair, including across a subsequent
rejection epoch. The existing current-chain freshness rules still apply.
An unfinished/failed repair with no implementation write is not a fabricated
write error; its task state can make the verdict partial with collection COMPLETE.

The collector appends supplemental diagnostics only after all operations have
been validated. An early invalid/failed operation keeps its primary error and
does not claim exhaustive write diagnostics from a partially collected stream.
Existing validation issues remain first. A closed entry in `evidence.chains`
cannot override overall INCOMPLETE. See `docs/COLLECTED-EVIDENCE-v2.md`.

Input schema v1, output schema v2, CLI flags, the legacy acceptance CLI and ten
conditions remain unchanged. New contextual issue fields and potentially more
than one issue must be supported by consumers. No live `summariseRun` integration,
physical observer, signature or independent run-ID authentication is added.

## Test-first and formal regressions

Before implementation, the new core test had eight expected diagnostic failures
and six passing boundary/positive scenarios. Three additional boundary checks
were added during self-review. Final result:

```text
node tests/v02-write-review-diagnostics.test.mjs
write review diagnostics: 17 scenarios passed
```

Cases cover unfinished/failed/completed unreviewed repairs, superseded rejections,
multiple paths and intermediate writes, same-path subsequent rewrites, legitimate
historical approvals, no-write/note-only tasks, unreviewed work, Windows path
normalization, replay/input immutability and invalid-prefix handling.

This is an independent formal core test. The original DSH package is unchanged,
remains separately maintained in its handoff, and has not been copied into tests.

## Completed author self-check

1. Re-read the full core diff and output contract against the actual review gap.
2. Reproduced the external negatives on original pinned `c71dbc9`, then verified
   the unchanged external package on the fixed independent clean checkout.
3. Ran the existing nine focused suites plus the new diagnostic suite: all ten
   commands exit 0. Collector 68, lineage 18, core acceptance 30 and old acceptance
   19 remain green. The new diagnostic suite has 17 scenarios.
4. Tested the actual collector CLI: negative exits 2 with INCOMPLETE/partial and
   all locator fields; positive exits 0 with synthetic-closed/hostVerified false.
5. In isolated copies, removed the entire audit, removed the call locator, and
   reduced coverage to latest-write-only. All three mutants pass syntax checking
   and fail real assertions in the new suite. The original source is unchanged.
   The first mutant-copy setup omitted local ledger imports; that module-resolution
   failure was rejected as invalid mutation evidence. After dependencies were
   copied, the mutations failed assertions for the intended contract reasons.
6. Committed the implementation and tested that exact commit in a separate clean
   Git clone with its own .git: **29 commands, all exit 0**. This comprises 24
   v02 suites, workflow logic, preflight script, preflight-claim integration and
   two Python commands. Python results: tests 43 OK, text-stats example 97 OK.
   Workflow logic: 114 scenarios / 547 assertions. Preflight: 9 / 42.
7. Verified the clean clone remains clean; source/plugin identity/fidelity tests
   pass. Reviewed exact staged paths, whitespace and secret-like/local-path
   patterns. No credential content, raw private evidence or test logs are committed.

`CORE-ROUND5-SELF-CHECK.json` records fixed code revision, exact relative commands,
exit codes, extra checks and SHA-256 of the six changed canonical Git blobs.
It is author evidence, not an independent-review certificate. Full local outputs
are under the user's Codex output root `outputs/tla-core-round5/` and stay out of
Git. The final handoff commit adds documentation only after the tested code commit.

## Required DSH follow-up

Review the new core commit against c71dbc9 in an independent copy. Run your
unchanged six-scenario handoff package with explicit `--core-root`, the new
17-scenario core suite, old collector/lineage/acceptance/ledger suites and V0.1
compatibility checks. Challenge historical review ownership, every write/path,
replay stability and malformed-prefix boundaries; do not merely re-run green tests.

The user now explicitly requires a complete self-check **before every delivery**,
and accepts additional effort to improve first-pass quality. Re-read your own
changes, attack counterexamples/positive controls, check actual outputs/exit codes,
version consistency, compatibility and evidence/docs. Correct issues you can find
before handoff rather than knowingly leaving basic checks for another round.
Report what self-check found/corrected and what remains unverified. This does not
mean claiming perfection or skipping independent review. Include this requirement
in subsequent DSH work packages too.

Do not change core source, merge/cherry-pick, rewrite frozen handoff hashes or
retroactively treat startup authorization as unused. Publish your own sanitized
review and only append its manifest entries. The five skills live physically at
`<codex-root>/skills`, with the old DSH directory only a Junction discovery entry.
The plugin/skill register remains under the user's Codex root; update new usage
or capability findings there without overwriting user edits. No reinstall needed.

## Boundaries

No real DSH host experiment, paid/external model invocation, dependency install,
ACL/profile change, merge or force-push. Some offline tests use owned Node child
processes and loopback HTTP stand-ins; those are not DSH experiments. The old
experiment ledger is not expanded by these unit tests. Host startup authorization
remains **0**; **V0.2 real-host repair-loop acceptance remains unverified**.
