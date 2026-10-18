# Redacted repair-loop protocol fixture

`request-NNN.json` is a **de-identified** copy of the 14 model requests captured
during the closure experiment (`closure/run4`, 2026-10-18). It exists so the
reactive policy can be replayed against real request shapes without publishing
the capture, the harness context, or any host path.

## What is kept

- the role of each request (`captain` / `member`) and the tool names the policy
  dispatches on;
- every `tool_use` with its real input (task ids, attempt ids, `file_path`,
  command lines);
- every `tool_result` with its real `is_error` flag and the first 600 characters
  of its text — including the real failure markers (`cannot modify ... file has
  not been read`, `no task "T1"`, `SetFileSecurityW EACCES`, `sum tests: 2
  passed, 1 failed`).

## What is replaced

| Source | Fixture |
| --- | --- |
| system prompt of the host | one normalized role sentence |
| full tool list with descriptions | the 3 captain / 5 member tool names |
| absolute path into the captured project | `<PROJECT>` |
| absolute path into the worktree | `<WORKTREE>` |
| any other absolute host path | `<HOST_PATH>` |
| team name (`closure1` … `closure6`) | `<TEAM>` |
| attempt / session UUID | `<UUID:n>`, stable across files |
| `<system-reminder>`, skills catalog, runtime snapshot | removed |

`toolu_fake_*` ids are kept as they are: the fake model generated them, so they
carry no host information.

## How it is regenerated

```bash
node tools/redact-protocol.mjs
```

The script reads the local capture from `tests/.scratch/v02-stage2/closure/run4/bodies`
and rewrites this directory plus `MANIFEST.json` (sha256 per file). The raw
capture stays out of the repository.

## What this fixture does **not** prove

- It is a request/response shape, not a host run. `tests/v02-repair-protocol.test.mjs`
  only checks that the fixed policy maps each recorded request to the intended
  rule.
- A match on a recorded request says nothing about a request the host has not
  produced yet. The loop still has to be closed by a real host run.
- The write that failed in this capture **never had a matching read** in that
  session — see `docs/V0.2-FS-OBSERVATION.md`. The fixture keeps that fact on
  purpose; it is evidence, not an error to be smoothed over.
