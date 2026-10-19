# DSH review — core round 6 (readlink evidence, final-byte scope, mutation audit)

Date: 2026-10-20. Review object: code
`88c9fe527e67ee885918d253c90de4caa1eafc56`, parent
`8bf26d38bf86052974c47029ae75ab7fd20545f1`, documentation tip
`fee7ea925e0b7e7703838d2c644cc5131b08b12c`.

The target was fixed in an independent clone; the V0.2 workspace was not merged
into or cherry-picked. The workspace baseline was
`e7396879b2e93b6ed74f290b5f8586eda321424f` (clean). No host, fake model,
dependency install, ACL/profile change, merge or force-push was performed.
Real-host startup authorization remains zero.

## Verdict

**Conditionally accepted, with one real P2 defect in the new link evidence.**
The write-diagnostic P2 fix and the final-bytes scope are accepted. The new
`readlink` evidence does **not** reproduce the author's 10/10 link result on
either a C: or a D: writable temporary root: both runs are 5/10, and the five
failures include the valid-link cases. The checker remains conservative on the
real DSH profile (23/23), so this is not a false acceptance, but the published
claim that the new evidence supports the directory-like `lstat` case is not
established by the committed tests.

## Accepted

### Write-diagnostic P2

The original six-scenario package now returns:

- four negatives: `INCOMPLETE` / `partial` with
  `IMPLEMENTATION_WRITE_REVIEW_UNPROVEN`, including locatable `callId`,
  `taskId`, `attemptId`, `sessionId` and normalized path;
- multi-path: two issues for two distinct write events;
- two positives: `COMPLETE` / `synthetic-closed`, no issues.

`tests/v02-write-review-diagnostics.test.mjs` is 18/18. The added positive test
is explicitly named as “final bytes per path, not every historical intermediate
write”, so it does not claim that every historical write was reviewed. The
unreviewed-attempt intermediate writes are still diagnosed per write.

### Final-byte scope

A reviewed repair that writes the same path twice before the reviewer reads the
final bytes is not separately diagnosed for the earlier intermediate write. The
reviewer did read the final approved bytes; this is a **scope limit**, not a
false closure of the current state. It should be stated wherever the contract is
described as “final bytes per path”.

### Mutation audit

`tools/self-check/write-review-mutations.mjs` was run on the fixed clone. In the
normal sandbox its baseline fails with `spawnSync ... EPERM` before any assertion;
with the one-shot outer permission it completes:

- `killed: 3`, `total: 3`, `sourceUnchanged: true`;
- `sourceSha256=ce23b5bb24bee79f213480695481cadf2d7f9b15688a48ce34a99bf2e7e2b8e7`;
- each recipe: `occurrences: 1`, `--check` exit 0, test exit 1, `killed: true`;
- each `test.log` contains `AssertionError` and does **not** contain
  `ERR_MODULE_NOT_FOUND`; no timeout;
- source hash after the run equals the baseline hash.

The three recipes and the exact old/replacement strings are in the generated
`report.json`; they match the committed descriptions.

### Regression and compatibility

Twenty-nine commands were run in a writable copy of the fixed commit. **28 exit
0; one exits 1**:

| group | result |
|---|---|
| 24 `tests/v02-*.test.mjs` | 23 exit 0; `v02-migration-links` exit 1 (5/10) |
| `workflow-logic` | exit 0, 114 scenarios / 547 assertions |
| `preflight-script` | exit 0, 9 scenarios / 42 assertions |
| `preflight-claim-integration` | exit 0, 6 scenarios / 59 assertions |
| Python `tests` | exit 0, 43 tests |
| Python `examples/text-stats` | exit 0, 97 tests |

Other v02 counts include acceptance 19, b1 5, checkout 6, core 30,
effective-config 8, collector 68, lineage 18, experiment-package 80, runner 117,
fs 20, gate 18/187, health 22, ledger 59, orchestration 12/267, plugin-identity
33, prelaunch 11/53, reactive 45, repair-loop 55, v3 43, protocol 123,
rehearsal 38, static 6, write-review 18.

Output v2, the old acceptance suite (19 checks), the legacy interface and the ten
condition codes remain compatible. No host was started.

## Real defect — P2 link evidence

`v02-migration-links.test.mjs` was run with `TLA_LINK_TEST_ROOT` set to a
writable C: temp root and to a writable D: root. **Both runs are 5 pass / 5
fail**, not 10/10:

- fail: `an in-profile link with a matching manifest and lock passes`
- fail: `an external link target fails the inside-profile checks`
- fail: `legacy text in an active file fails, but the pnpm .ignored store is not
  active`
- fail: `OS temp volume and checkout volume expose real link targets`
- fail: `readlink proves a junction even when lstat reports directory-like
  metadata`

The valid-link cases report:

```text
link:junction not-a-link; lstat-link=false; readlink=unavailable
```

A direct probe shows the cause of the test failure: on both writable roots, a
junction created by Node `symlinkSync(..., 'junction')` or `cmd mklink /J` is
reported by `fs.lstatSync(...).isSymbolicLink()` as false, and
`fs.readlinkSync(...)` throws `EINVAL`. The real DSH profile junction is a
different form: it reports `isSymbolicLink=true`, `readlink` succeeds, and the
real audit returns `MIGRATION LINKS OK (23 checks)`.

Consequences:

1. The committed test fixture does not reproduce the link form it intends to
   cover; the new `readlink` branch cannot be exercised by these fixtures.
2. The external-target assertion loses its `link:inside-profile` marker because
   the link is never recognized; the test result is still not an acceptance.
3. Broken link, lock mismatch, mirror drift, lock parser and ordinary-directory
   rejection still pass. No false acceptance was observed.
4. The author's `linkChecks: 10/10` and the CORE-ROUND6 “10/10 D: and C:” are
   **not reproduced**. The self-check already records
   `originalDshCVolumeFailureReproduced:false`; that is honest, but it does not
   justify the 10/10 claim.

This is a real test/evidence defect, severity **P2**: the product checker is
conservative, but the claim that the new evidence supports the directory-like
`lstat` scenario is unsupported. Fix the fixture/link creation (or the evidence
model), then rerun on both volumes; do not describe the old C: failure as
“root-caused” merely because a different test fixture passes.

## Environment blockers — not product failures

- A normal-sandbox `git fetch` of the review branch failed with
  `FETCH_HEAD: Permission denied`; the one-shot outer permission was needed. The
  fetch itself then succeeded.
- The committed mutation tool's baseline calls `spawnSync`; the normal sandbox
  returns `EPERM`, so the tool exits before mutation. The tool logic is verified
  with the one-shot permission, as recorded above. This is an execution
  environment limit, not an assertion failure.
- The C: clone's `tests/.scratch` is not writable; a writable copy under the
  host temp area was used. This is not a product assertion.
- The formal skill-ledger write is still blocked by ACL; no cell was changed and
  no ACL was modified. The TDD and agent-handoff entries were read for this
  round; no reinstall or upgrade was performed.

## Scope limits

- The evidence is still synthetic (`scope=synthetic-protocol`,
  `hostVerified=false`); no live DSH observer, physical symlink/byte history or
  authenticated run-ID provenance exists.
- “Reviewed” means the reviewer read the final bytes of each path, not every
  historical write. The committed positive test states this; the limitation
  should be repeated in the contract.
- The old C: `lstat` failure is not root-caused by this round. The new evidence
  covers a different link shape; do not infer that the original failure is
  resolved.
- The 29-command self-check's “all exit 0” is not reproducible here: 28/29, with
  the migration test failing as above. The code hashes and mutation report are
  otherwise internally consistent.
- No V0.2 real repair-loop closure is verified; the authorization remains zero.

## Reproduction summary

```text
# link evidence, either writable root
TLA_LINK_TEST_ROOT=<writable-root> node tests/v02-migration-links.test.mjs
# -> 5/10 on this host; link:junction not-a-link; readlink=unavailable

# write diagnostics
node tests/v02-write-review-diagnostics.test.mjs
# -> 18/18

# mutation audit (needs the one-shot outer permission for child processes)
node tools/self-check/write-review-mutations.mjs <output-dir>
# -> killed 3/3, sourceUnchanged true
```

The target diff is `8bf26d3..88c9fe5`: eight files, `+161/−13`; the tip
`88c9fe5..fee7ea9` adds only `CORE-ROUND6.md` and
`CORE-ROUND6-SELF-CHECK.json` (`+569`).
