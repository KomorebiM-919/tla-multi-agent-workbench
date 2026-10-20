# Migration-link fixture capability classification

Date: 2026-10-21. This document **appends** a correction to the Round6
migration-link conclusion. It does not edit or replace `CORE-ROUND6.md`, and it
does not change `CORE-ROUND6-SELF-CHECK.json`. The original reports remain the
record of what was observed then.

## Fixed objects

- Code under test: `88c9fe527e67ee885918d253c90de4caa1eafc56`.
- Documentation tip: `fee7ea925e0b7e7703838d2c644cc5131b08b12c`.
- Parent: `8bf26d38bf86052974c47029ae75ab7fd20545f1`.

## What the earlier reports said

- Codex reported `10/10` on both the checkout/D: and OS-temp/C: runs.
- DSH replayed `88c9fe5` and observed `5/10` in both locations: valid-link
  cases failed because the fixture-created junction was directory-like to
  `lstat`, and `readlink` raised `EINVAL`.
- The real isolated profile link was still recognised and its audit passed.

Those observations are not withdrawn. The difference is now classified rather
than treated as either “all green” or “the checker is broken”.

## Three outcomes

The migrated test entry is:

```text
node tests/v02-migration-links.test.mjs [--json]
```

It exits:

- `0` — `PASS`: every fixture prerequisite and every assertion held.
- `1` — `FAIL`: a prerequisite held, but a product assertion failed. If a
  simultaneous case is `ENVIRONMENT_BLOCKED`, both counts remain in the report
  and the exit code is still `1`.
- `2` — `ENVIRONMENT_BLOCKED`: no assertion failed, but at least one required
  capability was unavailable (writable root, link creation, `lstat` link
  evidence, `readlink`, `realpath`, target agreement).

Before a link-dependent assertion runs, the suite records `create`, `lstat`,
`readlink`, `realpath` and target agreement. A path that is merely reachable is
not enough. A blocked case is printed with its id, stage, error code and raw
capability; it is not skipped and does not make the summary a pass.

## Results for this fixed target

The suite has 11 cases (the original 10 plus a separately labelled OS-temp
volume case). The synthetic `lstat` case is marked `[synthetic]`.

| environment | PASS | FAIL | ENVIRONMENT_BLOCKED | synthetic PASS | exit |
|---|---:|---:|---:|---:|---:|
| normal DSH, checkout/D: root | 2 | 0 | 9 | 0 | 2 |
| normal DSH, OS-temp/C: root | 1 | 0 | 10 | 0 | 2 |
| full (approved one-shot), C: root | 11 | 0 | 0 | 1 | 0 |
| full (approved one-shot), D: root | 11 | 0 | 0 | 1 | 0 |

Normal D: passes are `lock-parser` and `ordinary-directory`; every case that
needs a real link is blocked with `lstat=false`, `readlink=EINVAL`,
`realpath=<link path>`, `targetMatches=false`. Normal C: only `lock-parser`
passes; the C: root cannot even `mkdtemp`, so the FS cases are blocked at setup.

These numbers are a capability census, not a product verdict for the blocked
cases. In particular, normal DSH cannot assess the link-dependent assertions;
full can, and full shows 11/11 with no assertion failure. Full is a separate,
explicitly approved diagnostic environment, not the ordinary user environment.

## Controlled classification counterexamples

`node tests/v02-migration-link-classification.test.mjs` is the controlled set
(7/7, exit 0). It verifies:

- a fully observed link is evidence; an ordinary directory is not;
- failed create, `readlink`, `realpath` or target mismatch removes evidence;
- blocked-only is `ENVIRONMENT_BLOCKED` / exit 2, never success;
- a fail plus a block keeps both counts and exits 1;
- synthetic passes are counted separately.

The suite reports `fail=0` in the table above because no assertion failed in
those runs. The fail-plus-block exit priority is exercised by the controlled
counterexample; it is not claimed that a product failure occurred in the suite.

## Product counts and boundaries

- Product assertion failures in the fixed-target suite: **0**.
- Environment blocks: **9** normal D, **10** normal C, **0** full C/D.
- Successes: **2** normal D, **1** normal C, **11** full C/D (one synthetic).
- The synthetic directory-like `lstat` case is explicitly `[synthetic]`; it
  proves only the checker's fallback logic, not that the real environment
  produces that link form.
- The checker still refuses ordinary directories, broken links and external
  targets; no Global-reparse support or privilege fallback was added.
- The suite never reads, rebuilds or modifies the real isolated profile. It does
  not treat the real profile's success as evidence that a fixture link is valid.

## Compatibility

- Only the migration test entry, its library, a classification counterexample
  test and `tests/README.md` are changed in this work package. The checker,
  gate, collector, acceptance and profile are untouched.
- The previous `node tests/v02-migration-links.test.mjs` command now has exit
  codes 0/1/2 instead of the old node:test single failure code. `--json` emits
  the full report. This is an intentional test-interface change; no production
  checker interface changed.
- `CORE-ROUND6.md` and its self-check remain unchanged. This correction must be
  read together with them.

## Remaining unverified

- The exact Windows mechanism that turns a normal-sandbox-created junction into
  a `Global` reparse target is still not isolated; the `normal` vs `full`
  correlation is evidence, not a proven root cause.
- A normal environment that can create a non-Global junction has not been
  produced without the approved outer execution; Codex should not read the full
  run as ordinary-user evidence.
- No live DSH host, model call or real experiment was started. The V0.2 real
  repair-loop closure status is unchanged and the host-start authorization is
  still zero.

## Reproduction

```text
node tests/v02-migration-links.test.mjs --json
node tests/v02-migration-link-classification.test.mjs
```

For the normal C/D comparison, set `TLA_LINK_TEST_ROOT` to a writable root in
each location. The full comparison requires the separately approved outer
execution; it is not available to the ordinary test runner.
