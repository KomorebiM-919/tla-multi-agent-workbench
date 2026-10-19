# Skill discovery and resolution audit (rounds 5–6)

Status: read-only verification. No skill was reinstalled, updated, bootstrapped or
executed; no browser page, network request or frontend build was used. This audit
does not change the V0.2 acceptance state or the experiment authorization (still
zero).

## Resolution path

- `<dsh-home>\skills` is a Junction whose target is `<codex-skills>`. Resolving the
  link with `fs.realpathSync` returns `<codex-skills>`, not a second copy under the
  DSH home.
- The five installed skills are present under `<codex-skills>`:
  `find-skills`, `agent-handoff`, `test-driven-development`, `frontend-design`,
  `agent-browser`.
- No project-level `.dsh/skills` directory and no project `SKILL.md` shadow the five
  names. The DSH session catalog lists those five names; no duplicate source was
  selected.
- `agent-handoff` and `test-driven-development` were loaded through the session skill
  catalog. Their resolved base directory is the D: entity directory, confirming that
  the Junction is the discovery entry point rather than a separate source of truth.
  The other three were checked for visibility only; their full upstream text was not
  loaded.

## Install-manifest evidence

The install manifest under `<codex-skill-audit>` lists 74 files. The five entry
files match its recorded bytes and SHA-256:

| skill | bytes | sha256 (prefix) |
|---|---:|---|
| agent-browser | 2943 | `b6a694e2...` |
| agent-handoff | 3305 | `1668aabf...` |
| find-skills | 2195 | `c8952e07...` |
| frontend-design | 1577 | `85fed0a6...` |
| test-driven-development | 1827 | `1b2c8cef...` |

The install report and manifest themselves are 2456 B / `3f72f4e4...` and 14482 B /
`570ff602...`. The browser executable is present (54 B, `be7b22a9...`); it was not
launched. The separate ChatGPT development clone exists but was not written to.

`find-skills` and `agent-handoff` were re-read after the ledger-maintenance rule
update; the table above records the current entry bytes and hashes, not the
pre-update snapshot. The re-read is the basis for the match, so the changed hashes
are not treated as drift against the old table.

## Ledger update

The formal skill ledger at `<skill-ledger>` was read (five sheets; the Skill sheet
has 50 rows). A write/backup attempt was denied by the host ACL
(`UnauthorizedAccessException`) before any cell could be changed. The ledger was
therefore not modified, its manual edits remain intact, and no ACL or profile
change was made. The `find-skills` and `agent-handoff` rows still carry the old
“rule awaits the next load confirmation” wording; the owner must update those two
rows manually (or grant the normal write path) if the ledger is to reflect this
re-read.

## Boundaries

- No upstream bootstrap, hook, auto-update or global install command was run.
- No credential, profile, ACL or DSH source file was read or written for this audit.
- The local adaptation entrypoints, not the upstream originals, remain the active
  entries; upstream files stay under each skill's `upstream/` directory.
