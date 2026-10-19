# Core round 6: portable link evidence and reproducible self-checks

Date: 2026-10-20. Code: `88c9fe527e67ee885918d253c90de4caa1eafc56`.
Parent: `8bf26d38bf86052974c47029ae75ab7fd20545f1`.
Review input: DSH round5, `e7396879b2e93b6ed74f290b5f8586eda321424f`.
No merge or cherry-pick of the DSH branch was performed.

## Review dispositions

1. **Intermediate writes: scope clarified, not expanded.** A reviewed attempt's
   final bytes per changed path must be read back and observed by its reviewer.
   Earlier versions in that same reviewed attempt are not individually reviewed.
   Unreviewed attempts still receive one issue per accepted implementation write.
   The new positive case writes twice in one repair and reviews only final bytes;
   it remains synthetic-closed. This is not proof of every historical version.
2. **Junction portability: evidence strengthened, original cause unresolved.**
   The old checker relied on lstat.isSymbolicLink alone. The checker now requires
   a nonempty readlink result and retains lstat observation in diagnostic detail.
   realpath, containment, manifest/lock agreement, registered bytes and identity
   remain mandatory. Ordinary directories and broken/external links still fail.
   No PowerShell fallback, ACL change, profile edit or skip was introduced.
   In this environment Node v24.21.0 reports true for fresh links on both C: and
   D:. The original DSH failure was not reproduced, so volume type is not asserted
   as its cause. A child-process simulation changes only lstat's link bit to
   false while preserving real readlink/realpath and bytes. Old checker + new
   tests fails that case; new checker passes. This models a discrepancy; it is
   not evidence that the old machine produced identical readlink observations.
3. **Mutation evidence: reproducible fresh executions supplied.** The committed
   tool contains exact one-occurrence old/replacement recipes. Each run requires
   a passing baseline and records patch.json, before/after SHA256, commands,
   syntax/test exit codes and test-log hash. Mutants execute in independent copies;
   module-loading errors and timeouts do not count as killed mutations. The three
   recipes (remove audit, remove call locator, retain latest writes only) each
   passed syntax then failed assertions. This fresh audit does not retrospectively
   establish the exact contents of last round's unpublished mutant copies.

The external-link test now owns a unique container for both profile and external
target, so its cleanup removes its own fixture target as well.

## Reproduce

Run from a fixed independent checkout of the code commit above:

```text
node tests/v02-migration-links.test.mjs
node tests/v02-write-review-diagnostics.test.mjs
node tools/self-check/write-review-mutations.mjs
```

An optional first argument to the mutation tool selects a new/empty output
directory. Without it a unique OS-temp directory is created. It refuses nonempty
outputs and never mutates source. Outputs remain untracked, contain local test
paths and must be sanitized before any publication. Report source hashes cover
actual checkout bytes; canonical Git-blob hashes are separately listed in the
self-check JSON, because checkout line endings may differ.

To run all link cases on a selected volume in PowerShell:

```powershell
$env:TLA_LINK_TEST_ROOT = Join-Path $env:TEMP 'tla-link-review'
node tests/v02-migration-links.test.mjs
Remove-Item Env:TLA_LINK_TEST_ROOT
```

This variable relocates only newly created test fixtures. No existing profile is
used. No unsupported-capability test is silently skipped.

## Validation

- Working checkout: all 29 commands exit 0.
- Independent clean clone at the fixed code commit, core.autocrlf=true:
  all 29 commands exit 0 (24 v02 suites + three V0.1/integration Node entries +
  Python tests 43 + Python example tests 97).
- Link suite: 10/10 on D: checkout fixtures and 10/10 with C: temp fixtures;
  it also probes OS-temp links. No skipped cases.
- Write-review diagnostics: 18/18, including final-byte scope control.
- Original external DSH P2 regression package: all six cases pass, including
  both valid controls. No diagnostic or acceptance semantics regressed.
- Published mutation tool: baseline green, 3/3 mutants killed by assertions,
  syntax success for all three, source unchanged.
- Before finalizing, an initially invalid new positive fixture was corrected:
  it had omitted a read before its second write. The existing contract correctly
  rejected it. No collector change was made to accommodate the invalid fixture.

`CORE-ROUND6-SELF-CHECK.json` records relative commands, output hashes, canonical
source hashes and complete mutation recipes. Original raw logs stay local.

## Boundaries and next review

This is offline maintenance only. No DSH host, fake model server or real model
call was started; startup authorization remains **0**. No dependency installation,
ACL/profile edits, merge to main or force push. No live observer, signed provenance
or physical-history collection was added. V0.2 real-host repair closure remains
unverified; synthetic-closed is not live closed.

DSH should independently rerun the fixed source, C/D link cases, three published
mutations, six external P2 cases and related compatibility tests. It should inspect
the new readlink trust boundary, ordinary-directory rejection, intermediate-write
scope and evidence reproducibility. Perform a complete self-check before handing
back; report environmental blockers separately, preserve frozen MANIFEST entries,
and do not promote the synthetic milestone to real-host acceptance.
