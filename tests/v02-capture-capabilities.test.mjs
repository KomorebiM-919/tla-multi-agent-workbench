// Invented-material tests for the offline capability-report validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_IDS,
  CAPABILITY_SCHEMA,
  main,
  validateCapabilityReport
} from '../tools/audit-capture-capabilities.mjs';

const ROOT = join(process.cwd(), 'tests', '.scratch', `phase-a-audit-${process.pid}`);
const SOURCE_TEXT = 'export function inspect() {\n  return 1;\n}\n';
const SOURCE_BYTES = Buffer.from(SOURCE_TEXT, 'utf8');
const SOURCE_HASH = createHash('sha256').update(SOURCE_BYTES).digest('hex');

function source(overrides = {}) {
  return {
    id: 'host',
    component: 'host',
    productVersion: null,
    packageVersion: '1.2.3',
    containerSha256: null,
    entry: 'app/main.js',
    entryBytes: SOURCE_BYTES.length,
    entrySha256: SOURCE_HASH,
    ...overrides
  };
}

function capabilities(overrides = new Map()) {
  return CAPABILITY_IDS.map((id) => overrides.get(id) ?? {
    id,
    status: 'unknown',
    evidence: [],
    limitations: ['not audited in this fixture']
  });
}

function report(overrides = {}) {
  return {
    schema: CAPABILITY_SCHEMA,
    scope: 'source-audit',
    hostVerified: false,
    sources: [source()],
    capabilities: capabilities(),
    issues: [],
    ...overrides
  };
}

function validate(value, mappings = new Map([['host', SOURCE_BYTES]])) {
  return validateCapabilityReport(value, mappings);
}

function io() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (value) => out.push(value) },
    stderr: { write: (value) => err.push(value) }
  };
}

test('valid unknown-only report stays explicitly unknown', () => {
  const summary = validate(report());
  assert.equal(summary.hostVerified, false);
  assert.equal(summary.capabilityCounts.unknown, 9);
  assert.equal(summary.capabilityCounts.sourceSupported, 0);
});

test('source-supported requires at least one locator', () => {
  const caps = capabilities(new Map([['read-bytes', {
    id: 'read-bytes', status: 'source-supported', evidence: [], limitations: []
  }]]));
  assert.throws(() => validate(report({ capabilities: caps })), /SOURCE_SUPPORTED_WITHOUT_EVIDENCE/);
});

test('a locator must resolve inside the exact source bytes', () => {
  const caps = capabilities(new Map([['read-bytes', {
    id: 'read-bytes',
    status: 'source-supported',
    evidence: [{ sourceId: 'host', startLine: 2, endLine: 9, symbol: 'x', finding: 'y' }],
    limitations: []
  }]]));
  assert.throws(() => validate(report({ capabilities: caps })), /EVIDENCE_LINE_OUT_OF_RANGE/);
});

test('unknown source ID, duplicate capability, missing capability and extra fields are rejected', () => {
  const unknownSource = capabilities(new Map([['read-bytes', {
    id: 'read-bytes', status: 'unknown', evidence: [{ sourceId: 'other', startLine: 1, endLine: 1, symbol: 'x', finding: 'y' }], limitations: []
  }]]));
  assert.throws(() => validate(report({ capabilities: unknownSource })), /EVIDENCE_SOURCE_UNKNOWN/);

  const duplicate = capabilities();
  duplicate.push(duplicate[0]);
  assert.throws(() => validate(report({ capabilities: duplicate })), /DUPLICATE_CAPABILITY_ID/);

  assert.throws(() => validate(report({ capabilities: capabilities().slice(0, 8) })), /CAPABILITY_MISSING/);
  assert.throws(() => validate({ ...report(), extra: true }), /FIELDS_INVALID/);
});

test('source hash and byte mismatches are rejected', () => {
  assert.throws(() => validate(report({ sources: [source({ entryBytes: 1 })] })), /ENTRY_BYTES_MISMATCH/);
  assert.throws(() => validate(report({ sources: [source({ entrySha256: '0'.repeat(64) })] })), /ENTRY_HASH_MISMATCH/);
  assert.throws(() => validate(report(), new Map()), /SOURCE_MAP_MISSING/);
  assert.throws(() => validate(report({ hostVerified: true })), /HOST_VERIFIED_MUST_BE_FALSE/);
  assert.throws(() => validate(report({ schema: 'old/v0' })), /SCHEMA_INVALID/);
});

test('CRLF and LF preserve exact bytes while locators use text lines', () => {
  const crlf = Buffer.from('a\r\nb\r\n', 'utf8');
  const crlfHash = createHash('sha256').update(crlf).digest('hex');
  const caps = capabilities(new Map([['read-bytes', {
    id: 'read-bytes', status: 'source-supported',
    evidence: [{ sourceId: 'host', startLine: 1, endLine: 2, symbol: 'a', finding: 'b' }],
    limitations: ['bytes are not line-ending normalized']
  }]]));
  const summary = validateCapabilityReport(report({
    sources: [source({ entryBytes: crlf.length, entrySha256: crlfHash })],
    capabilities: caps
  }), new Map([['host', crlf]]));
  assert.equal(summary.capabilityCounts.sourceSupported, 1);
});

test('an optional container hash is checked against the explicit container file', () => {
  const container = Buffer.from('invented archive bytes');
  const containerHash = createHash('sha256').update(container).digest('hex');
  const value = report({ sources: [source({ containerSha256: containerHash })] });
  const summary = validateCapabilityReport(value, new Map([['host', SOURCE_BYTES]]), new Map([['host', container]]));
  assert.equal(summary.sourceCount, 1);
  assert.throws(() => validateCapabilityReport(value, new Map([['host', SOURCE_BYTES]]), new Map([['host', Buffer.from('other')]])), /CONTAINER_HASH_MISMATCH/);
  assert.throws(() => validateCapabilityReport(value, new Map([['host', SOURCE_BYTES]])), /CONTAINER_MAP_MISSING/);
});

test('CLI exits 0 for valid and 2 for invalid report, 1 for usage', () => {
  mkdirSync(ROOT, { recursive: true });
  try {
    const sourcePath = join(ROOT, 'entry.mjs');
    const reportPath = join(ROOT, 'report.json');
    writeFileSync(sourcePath, SOURCE_BYTES);
    writeFileSync(reportPath, JSON.stringify(report()));
    const good = io();
    assert.equal(main(['--report', reportPath, '--source', `host=${sourcePath}`], good), 0);
    assert.match(good.out.join(''), /unknown=9/);

    const bad = report({ capabilities: capabilities().slice(0, 8) });
    writeFileSync(reportPath, JSON.stringify(bad));
    const invalid = io();
    assert.equal(main(['--report', reportPath, '--source', `host=${sourcePath}`], invalid), 2);
    assert.match(invalid.err.join(''), /CAPABILITY_MISSING/);

    const usage = io();
    assert.equal(main([], usage), 1);
    assert.match(usage.err.join(''), /--report is required/);
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
});
