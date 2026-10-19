# P2 regression package: unowned implementation writes

Baseline under test: `c71dbc95edd57082756719b1eec572996f325305` (parent
`1d316c6`). This package is an **expected-red** regression package, not a passed
milestone and not part of the repository's formal test suite.

## Contract

The fourth-round review found that an implementation write can exist in the
evidence without belonging to any closed review chain and without producing an
issue. The predicate stays `partial`, so this is not a false `synthetic-closed`;
however a consumer that reads only `status` and `issues` cannot locate the
unowned write. The expected contract for the fix is:

- every implementation write not covered by a closed chain must produce a
  locatable diagnostic, or make collection `INCOMPLETE`;
- the diagnostic must identify the write event's task, attempt and path;
- `TASKS_COMPLETED` alone is not sufficient evidence that the write was reviewed;
- no particular issue code is required; the ChatGPT implementation chooses it.

## Scenarios

Four negative scenarios and two positive controls are built by
`regressions/inputs.mjs`. Each negative scenario has an extra write by `t3` /
`a-t3` to `src/extra.mjs` and a later, separate repair that closes the chain:

1. the extra-writing repair stays `in_progress`;
2. the extra-writing repair ends `failed`;
3. the extra write belongs to a rejection later superseded by another rejection;
4. one repair writes both `src/sum.mjs` and `src/extra.mjs`; only `sum` is covered
   by the closing chain.

Positive controls: one legal closed chain, and two independent legal closed chains.

## Observed on c71dbc9

Command:

```text
node docs/handoffs/v0.2-two-person-round1/regressions/run-p2-regressions.mjs \
  --core-root <isolated-c71dbc9>
```

The runner requires an explicit `--core-root`, imports
`<core-root>/tools/collect-run-evidence.mjs`, and uses no implicit environment
variable or Git repository. Result: exit code 1 (expected red).

| scenario | actual | required signal | result |
|---|---|---|---|
| incomplete repair extra write | `COMPLETE`, `partial`, issues none, extraWrites 1 | issue locating `t3/a-t3/src/extra.mjs` or `INCOMPLETE` | FAIL |
| failed repair extra write | `COMPLETE`, `partial`, issues none, extraWrites 1 | same | FAIL |
| superseded rejection extra write | `COMPLETE`, `partial`, issues none, extraWrites 1 | same | FAIL |
| multi-path uncovered extra write | `COMPLETE`, `partial`, issues none, extraWrites 1 | same | FAIL |
| single legal chain | `COMPLETE`, `synthetic-closed`, issues none | positive control | PASS |
| two independent legal chains | `COMPLETE`, `synthetic-closed`, issues none | positive control | PASS |

The failing assertions are `has-diagnostic-signal` and `locates-write`. The
`not-synthetic-closed` assertion already passes for the four negatives. The
package therefore records the diagnostic gap, not a false acceptance.

The first multi-path draft wrote identical bytes and hit the legitimate
`WRITE_PRIOR_READ_UNPROVEN` error; the fixture now writes `FIXED2` so the final
observed signature is the same unowned-write gap as the other three scenarios.
That earlier result was a fixture error, not a product result.

## Files

- `regressions/inputs.mjs` — minimal synthetic observation documents.
- `regressions/run-p2-regressions.mjs` — portable runner with `--core-root`.
- `regressions/README.md` — usage and boundaries.

The core implementation was not modified; the script does not write to the core
copy. The package is intentionally absent from `tests/` until ChatGPT supplies
the diagnostic contract and the assertions can be turned green.
