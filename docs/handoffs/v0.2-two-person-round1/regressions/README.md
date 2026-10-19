# P2 regression runner

Expected-red regression package for the unowned implementation-write diagnostic
gap found in the fourth-round review of `c71dbc9`.

## Usage

```text
node docs/handoffs/v0.2-two-person-round1/regressions/run-p2-regressions.mjs \
  --core-root <path-to-isolated-c71dbc9>
```

`--core-root` is required. The runner imports
`<core-root>/tools/collect-run-evidence.mjs` directly; it uses no environment
variable and no Git command, so it does not mistake a nested copy for its own
repository. It does not write to the core root.

Exit code 1 is expected on `c71dbc9`: four negative scenarios fail the
diagnostic assertions, while both positive controls pass. Treat this as a red
regression, not a green milestone.

## What it checks

The four negatives place an implementation write (`t3` / `a-t3` /
`src/extra.mjs`) outside every closed chain, then close a later chain. The
required contract is a locatable diagnostic (task, attempt, path) or
`INCOMPLETE`; a specific issue code is not prescribed. The positives are one
legal chain and two independent legal chains.

See `../P2-REGRESSION.md` for the observed output table and the boundary
statement. The package is not part of the formal `tests/` suite.
