# V0.1 compatibility re-check (round 5)

Baseline: `c71dbc95edd57082756719b1eec572996f325305`. This is a targeted
re-check of the two documented V0.1 entries, not a full V0.1 acceptance and not a
substitute for a real-host run.

## Entry points

The repository documents these V0.1 commands:

- `README.md:187` — `node tests/workflow-logic.test.mjs`;
- `tests/README.md:297` — `node tests/preflight-script.test.mjs` (9 scenarios,
  42 assertions).

No additional documented V0.1 entry was required for this round.

## Isolated baseline

The nested review archive under `tests/.scratch` is not a Git repository of its
own; `git -C <copy> rev-parse HEAD` resolves the parent V0.2 repository
(`b6e1a47`). Running the preflight test there would therefore pin the wrong
source and it also hit an `EPERM` on the nested `tests/.scratch/preflight-cases`
directory. That was an environment/placement problem, not a product failure.

For this round a detached local clone was created outside the V0.2 worktree,
the review branch was fetched from the local object store, and the clone was
checked out at `c71dbc9` (clean). Commands were then run from that clone.

## Results

| suite | command (from the c71dbc9 clone) | exit | assertions |
|---|---|---:|---|
| workflow logic | `node tests/workflow-logic.test.mjs` | 0 | 114/114 scenarios, 547 assertions, 0 failed |
| preflight script | `node tests/preflight-script.test.mjs` | 0 | 9/9 scenarios, 42 assertions, 0 failed |

The preflight suite printed `固定提交：c71dbc95edd57082756719b1eec572996f325305`,
confirming that the clone's own HEAD, not the parent worktree, was used.

## Environment notes

- The nested-copy `EPERM` and the parent-HEAD resolution are recorded as
  environment blockers; they are not counted as regression failures.
- The preflight test creates a temporary directory under the clone's
  `tests/.scratch`; it required the already-authorized one-shot outer permission
  for that exact command. No ACL, profile or repository configuration was
  changed.
- No host, fake model service, model call, dependency install or real experiment
  was started.

## Scope

This round re-ran the two named V0.1 entries on the fixed review commit. It does
not claim full V0.1 acceptance, does not rerun the full V0.2 suite, and does not
change the V0.2 acceptance state.
