# Core round 2: file evidence ordering

Parent: `629992424c0d0ebabccbb0fb723dd9ab8f3c73e6`.
Input: DSH's independent review of that commit, published on the V0.2 branch
in `f971df52c3803839f514824b342324aaee41b779`.
This branch does not merge or rewrite the DSH branch.

## Review disposition

| Finding | Action |
| --- | --- |
| P2: array-last write can hide the actual latest write | Fixed: choose the greatest explicit file-event index, then the greatest subsequent read index for that path |
| P2: string indices are coerced | Fixed: every file event needs a nonnegative safe integer index |
| Ambiguous order | Duplicate indices, including duplicates across paths, reject read-back evidence; invalid entries are not silently discarded |
| P3: implementation detail counts every file event | Fixed: detail counts implementation writes only |
| P3: Windows path normalization | Assigned to the future collector boundary; the predicate continues to require canonical paths, with no silently broadened path acceptance |
| Collector drops hashes, read events, history and subjects | Confirmed by source inspection; still blocked, not claimed fixed |

Valid file events may arrive in any array order. Sorting uses a copy and does
not mutate the caller's evidence. Zero-based indices remain valid. The predicate
still checks the latest implementation write and the latest subsequent read of
its path; this round does not establish read-back for every changed file.

Malformed or duplicate indices make `READ_BACK_AFTER_WRITE` false, with an
explanation in its existing detail field. The ten condition codes, CLI flags
and `tla.acceptance-summary/v1` schema remain unchanged. This is a stricter
input contract, so a previous consumer using string indices must be corrected.

## Regression evidence

The pre-fix run reproduced seven failing negative cases: hidden latest write,
string/fractional/negative/unsafe/infinite indices, and a newer disagreeing read
hidden by array order. Additional negative cases cover missing/NaN/duplicate
indices, a null record, and duplicate indices across paths. Positive checks
cover shuffled-but-ordered evidence, input immutability and zero-based indices.

- `node tests/v02-core-acceptance.test.mjs`: 26 checks.
- `node tests/v02-acceptance-summary.test.mjs`: original 19 checks.
- Ledger and V0.1 preflight are rerun separately; see the delivery report for
  actual command outcomes. These tests do not prove a host repair loop.

## Collector interface plan (not implemented)

This section defines the next design work, not a new accepted on-disk schema.
No protocol fields or policy fixtures are changed in this round. The producer
must not construct proof by renaming rule decisions or by filling unknowns.

| Required fact | Current source / gap | Collector obligation |
| --- | --- | --- |
| Run and session identity | Ledger correlation exists, but verdict arrays are not independently run-bound | Bind every observation to runner run ID, session and paired tool call/result; reject cross-run and orphan evidence |
| File event order | `readRuleUsage` yields rule/path/outcome, no indices | Deduplicate repeated conversation history by stable session + call identity; allocate a unique event order only from proven chronology; unresolved cross-session order stays unknown |
| Project-relative path | `policyFacts.filePath` is raw, potentially Windows absolute | Resolve against the verified project root, check containment, then convert separators to `/`; reject outside-root, traversal and unresolved paths |
| Successful write and read-back bytes | Policy facts are not content hashes; final `files` hashes have no event linkage | Require successful paired tool results plus contemporaneous byte evidence; never use a later disk hash as a historical write hash; partial/truncated reads cannot prove full-file equality |
| Red-to-green test history | `runProjectTest` returns one post-run test, no history | Preserve exact command/cwd, integer exit status and parsed test counts for each observed run; distinguish collector-run verification from member-run history |
| Review and repair | Rule-name regexes are hints; `readTasks` drops subjects | Preserve task/attempt/type/subject and successful review/update results, establish rejection -> actual repair -> passing review order for the same task lineage |

The reusable `parseBody` in `tests/lib/reactive-model.mjs` already pairs calls
and results within a request and preserves explicit `is_error`. It does not by
itself solve cross-request deduplication, byte observation or cross-session
chronology. Reuse it only with those limitations explicit. The next collector
package needs an end-to-end synthetic protocol test through collection and
verdict, plus failure cases for missing bytes/results, duplicate history,
cross-run samples, outside-project paths and unsuccessful tools.

## Coordination and boundaries

DSH may independently review this patch and prepare sanitized protocol samples;
ChatGPT retains ownership of the collector and predicate. Do not start another
host experiment merely because this predicate passes. Host startup authorization
remains zero. No host, model, installation, ACL or profile operation was used.
V0.2 business closure remains unverified.
