# Installed host source audit: 2026-10-21

Status: static inspection only. No host code was imported or executed. No
installation, profile/ACL change, model call or host experiment occurred.
Design baseline: `d287b6cdd9262c5d50a8fa7ae1270a929565f818`.

## Installed artifact identity

- Archive bytes: 182794869.
- Archive SHA256: `47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a` (unchanged before/after audit).
- Archived root package: @deepseek-ai/dsh-desktop, version `0.2.1-rc.2`.
- Archived build commit: `332895e0f7c9d4dbfb29729f5eb367fa263ff986`.
- This identifies the installed archive, not a currently loaded Desktop process.
  The earlier 44.7.0 runtime value was not used as product version.
- Entry content hashes matched the archive's SHA256 integrity metadata. This
  checks consistency, not publisher authentication or signed supply-chain trust.

## Reading method and reproducibility

No @electron/asar or asar module resolved in the two explicitly checked existing
runtime/profile module roots. This is not a scan of every installed program.
The audit used Python standard-library reads following Electron's ASAR format:
read the 8-byte size pickle, bounded JSON header pickle, then seek directly to
8 + header_pickle_size + entry.offset for the explicitly selected packed file.
Reject archive links, unpacked entries, malformed/short headers, invalid offsets,
out-of-bounds reads and content integrity mismatches. No whole archive extraction,
archive imports, dependency installation or host invocation was needed.

Format source: https://github.com/electron/asar#format

The local read method, source-map.json, extracted entries, raw validator result
and reader self-check are retained in the local audit output directory. They
are not public runtime artifacts. The inspection helper contains machine paths
and is not installed or represented as a hardened general-purpose ASAR tool.
DSH can reuse that local method after inspecting it, or independently read the
same explicit archive entries and compare the hashes below. It must not execute
archive modules or install dependencies to reproduce this source inspection.
The public capability report gives exact archive-relative names and source
locators; no installed source or private source-map paths are committed.

## Findings and scoped support

1. **Final tool-result seam located.** dsh-tools exposes tools/result after
   materialization, with exec identity and final structured value on success.
   scopeTarget permits an unscoped listener through the agent scope filter.
   This supports a same-process passive candidate, not proof of live member
   coverage, fork seed replay or out-of-process child coverage.
2. **Foreground pwsh DTO located.** Structured result retains cwd, exitCode,
   signal, timeout/abort and stdout/stderr truncation facts. Background/persistent
   jobs, immutable suite bytes and full test history are not proven by this.
3. **Raw byte gap confirmed for selected seams.** read returns bounded lines;
   fs/observed contains version. writeText diff bases are bounded and decoded,
   and after text normalizes CRLF to LF. Do not hash these as exact historical
   file bytes. This does not assert that no other capability could ever provide
   bytes; the inspected path does not supply the required proof.
4. **Chronology gap confirmed.** Parallel tool bodies can settle before their
   model-ordered finalization. tools/result delivery order is therefore not an
   authoritative cross-session/body-completion total order. Session call/result
   links are useful correlation, not physical file chronology.
5. **Completeness remains unknown.** Observer callback errors are warned/contained
   and promises are not awaited. A host exit or clean observer log cannot by
   itself establish lossless capture. Seeded session history need not re-emit.
6. Task/attempt fields were inspected in installed agent-teams source, but full
   lineage and actual member composition were not established. The normalized
   synthetic task kinds must not be assumed identical to real tool semantics.

These findings are encoded in HOST-CAPABILITIES-2026-10-21.json: 2 narrowly
source-supported capabilities, 7 unknown, hostVerified=false. The existing Phase A
validator accepted the exact source bytes, source locators and archive hashes.
Format acceptance is not an independent semantic review or runtime validation.

| Source ID | Bytes | Exact entry SHA256 |
|---|---:|---|
| host-package | 797 | `53ee01d3b1accfbd037d245fb4752fb5fa5f8e2a76b7de634a4223558ee54bb9` |
| host-tools | 162201 | `1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a` |
| host-scope | 12151 | `2829df71d76e08941457d4dd173eac60783e55354921137c8b75e8b5c0d2ecca` |
| host-loop | 74599 | `cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033` |
| host-session | 94982 | `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf` |
| host-fs-tool | 49445 | `b11d3fa50b9042019a91cc38a6abe35d74ed651374278f95e60b42734e079df1` |
| host-fs-local | 41311 | `63fbb41d2c33e07111884b798be507e68c2752acab8249c821c20ade436e894f` |
| host-pwsh | 31025 | `94c7f68c425e62c8006907b3f4fea771935321581fd2327b7ee1f0ba8d15eec1` |

## Self-check and limits

- Read method: 9 invented-archive checks passed (valid entry, truncated prefix,
  short header, wrong integrity hash, out-of-bounds offset, unpacked entry,
  link entry, invalid offset and oversized header).
- Real selected entry hashes matched archive integrity metadata; source entry
  counts and line locations passed Phase A validation with shared archive bytes.
- The archive hash stayed identical before and after reading.
- Documents contain no live trace or new acceptance verdict. B0/B1 remain design.
- Source-supported is explicitly scoped, not equivalent to full capture support.
- Code was not modified, so no unrelated implementation suite was rerun.
- The two receipt examples are illustrative, not actual runtime provenance.

## Handoff

See docs/V0.2-OBSERVER-B-DESIGN.md. DSH's next package is B0 explicit receipt
production plus strict bundle joining, tested with invented records/local test
helpers only. Do not install or activate an observer or start a host. Codex
reviews B0 before assigning B1 passive tracing. Real-host authorization remains 0.
