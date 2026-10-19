# Skill discovery and resolution audit (round 5)

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
| agent-handoff | 2748 | `34b7a6a6...` |
| find-skills | 1638 | `c4ecc44c...` |
| frontend-design | 1577 | `85fed0a6...` |
| test-driven-development | 1827 | `1b2c8cef...` |

The install report and manifest themselves are 2233 B / `0140a771...` and 14482 B /
`2d3023ec...`. The browser executable is present (54 B, `be7b22a9...`); it was not
launched. The separate ChatGPT development clone exists but was not written to.

## Boundaries

- No upstream bootstrap, hook, auto-update or global install command was run.
- No credential, profile, ACL or DSH source file was read or written for this audit.
- The local adaptation entrypoints, not the upstream originals, remain the active
  entries; upstream files stay under each skill's `upstream/` directory.
