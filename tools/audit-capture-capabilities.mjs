// Validate an analyst-authored capture-capability report against explicitly
// supplied source entries. This tool never imports, executes, installs or probes
// the source under audit; it only reads the mapped bytes.
import { pathToFileURL } from 'node:url';
import {
  ContractError,
  IoError,
  decodeUtf8,
  fields,
  fail,
  hashBytes,
  hashValue,
  idValue,
  lineCount,
  readJsonFile,
  readRegularFile,
  safeInt,
  stringArray,
  stringValue,
  relativePathValue
} from './lib/evidence-contracts.mjs';

export const CAPABILITY_SCHEMA = 'tla.capture-capabilities/v1';
export const CAPABILITY_IDS = Object.freeze([
  'launch-binding',
  'member-call-result',
  'task-attempt-lineage',
  'read-bytes',
  'write-before-after',
  'path-containment',
  'test-process-exit',
  'causal-order',
  'capture-completeness'
]);
export const CAPABILITY_STATUSES = new Set(['source-supported', 'unavailable', 'unknown']);
const COMPONENTS = new Set(['host', 'agent-teams']);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CONTAINER_BYTES = 512 * 1024 * 1024;

function optionalVersion(value, label) {
  if (value !== null && typeof value !== 'string') fail('VERSION_INVALID', label);
  if (typeof value === 'string' && value.length > 200) fail('VERSION_INVALID', label);
  return value;
}

function validateSource(source, mappings, containers) {
  fields(source, ['id', 'component', 'productVersion', 'packageVersion', 'containerSha256', 'entry', 'entryBytes', 'entrySha256'], 'source');
  idValue(source.id);
  if (!COMPONENTS.has(source.component)) fail('COMPONENT_INVALID', source.id);
  optionalVersion(source.productVersion, 'productVersion');
  optionalVersion(source.packageVersion, 'packageVersion');
  if (source.containerSha256 !== null) hashValue(source.containerSha256, 'CONTAINER_HASH_INVALID');
  relativePathValue(source.entry);
  safeInt(source.entryBytes, 'ENTRY_BYTES_INVALID');
  hashValue(source.entrySha256, 'ENTRY_HASH_INVALID');
  const mapping = mappings.get(source.id);
  if (!mapping) fail('SOURCE_MAP_MISSING', source.id);
  if (mapping.length !== source.entryBytes) {
    fail('ENTRY_BYTES_MISMATCH', `${source.id}: ${mapping.length} != ${source.entryBytes}`);
  }
  if (hashBytes(mapping) !== source.entrySha256) fail('ENTRY_HASH_MISMATCH', source.id);
  if (source.containerSha256 !== null) {
    const container = containers.get(source.id);
    if (!container) fail('CONTAINER_MAP_MISSING', source.id);
    if (hashBytes(container) !== source.containerSha256) fail('CONTAINER_HASH_MISMATCH', source.id);
  }
  return { ...source, lineCount: lineCount(decodeUtf8(mapping, 'ENTRY_UTF8_INVALID')) };
}

function validateEvidence(evidence, sourceById) {
  fields(evidence, ['sourceId', 'startLine', 'endLine', 'symbol', 'finding'], 'evidence');
  idValue(evidence.sourceId, 'EVIDENCE_SOURCE_ID_INVALID');
  const source = sourceById.get(evidence.sourceId);
  if (!source) fail('EVIDENCE_SOURCE_UNKNOWN', evidence.sourceId);
  safeInt(evidence.startLine, 'EVIDENCE_LINE_INVALID', 1);
  safeInt(evidence.endLine, 'EVIDENCE_LINE_INVALID', 1);
  if (evidence.endLine < evidence.startLine) fail('EVIDENCE_RANGE_INVALID', evidence.sourceId);
  if (evidence.endLine > source.lineCount) {
    fail('EVIDENCE_LINE_OUT_OF_RANGE', `${evidence.sourceId}: ${evidence.endLine} > ${source.lineCount}`);
  }
  stringValue(evidence.symbol, 'EVIDENCE_SYMBOL_INVALID', 256);
  stringValue(evidence.finding, 'EVIDENCE_FINDING_INVALID', 4096);
}

function validateCapability(capability, sourceById) {
  fields(capability, ['id', 'status', 'evidence', 'limitations'], 'capability');
  idValue(capability.id, 'CAPABILITY_ID_INVALID');
  if (!CAPABILITY_IDS.includes(capability.id)) fail('CAPABILITY_UNKNOWN', capability.id);
  if (!CAPABILITY_STATUSES.has(capability.status)) fail('CAPABILITY_STATUS_INVALID', capability.id);
  if (!Array.isArray(capability.evidence)) fail('CAPABILITY_EVIDENCE_INVALID', capability.id);
  for (const evidence of capability.evidence) validateEvidence(evidence, sourceById);
  stringArray(capability.limitations, 'CAPABILITY_LIMITATIONS_INVALID');
  if (capability.status === 'source-supported' && capability.evidence.length === 0) {
    fail('SOURCE_SUPPORTED_WITHOUT_EVIDENCE', capability.id);
  }
  return capability;
}

function validateIssue(issue, capabilityIds) {
  fields(issue, ['code', 'capabilityId', 'detail'], 'issue');
  stringValue(issue.code, 'ISSUE_CODE_INVALID', 128);
  if (issue.capabilityId !== null) {
    idValue(issue.capabilityId, 'ISSUE_CAPABILITY_INVALID');
    if (!capabilityIds.has(issue.capabilityId)) fail('ISSUE_CAPABILITY_UNKNOWN', issue.capabilityId);
  }
  stringValue(issue.detail, 'ISSUE_DETAIL_INVALID', 4096);
}

export function validateCapabilityReport(report, mappings = new Map(), containers = new Map()) {
  fields(report, ['schema', 'scope', 'hostVerified', 'sources', 'capabilities', 'issues'], 'report');
  if (report.schema !== CAPABILITY_SCHEMA) fail('SCHEMA_INVALID', String(report.schema));
  if (report.scope !== 'source-audit') fail('SCOPE_INVALID');
  if (report.hostVerified !== false) fail('HOST_VERIFIED_MUST_BE_FALSE');
  if (!Array.isArray(report.sources)) fail('SOURCES_INVALID');
  if (!Array.isArray(report.capabilities)) fail('CAPABILITIES_INVALID');
  if (!Array.isArray(report.issues)) fail('ISSUES_INVALID');

  const sourceIds = new Set();
  const sourceById = new Map();
  for (const source of report.sources) {
    const validated = validateSource(source, mappings, containers);
    if (sourceIds.has(validated.id)) fail('DUPLICATE_SOURCE_ID', validated.id);
    sourceIds.add(validated.id);
    sourceById.set(validated.id, validated);
  }

  const capabilityIds = new Set();
  for (const capability of report.capabilities) {
    const validated = validateCapability(capability, sourceById);
    if (capabilityIds.has(validated.id)) fail('DUPLICATE_CAPABILITY_ID', validated.id);
    capabilityIds.add(validated.id);
  }
  for (const required of CAPABILITY_IDS) {
    if (!capabilityIds.has(required)) fail('CAPABILITY_MISSING', required);
  }

  for (const issue of report.issues) validateIssue(issue, capabilityIds);
  return {
    schema: report.schema,
    scope: report.scope,
    hostVerified: false,
    sourceCount: report.sources.length,
    capabilityCounts: {
      sourceSupported: report.capabilities.filter((item) => item.status === 'source-supported').length,
      unavailable: report.capabilities.filter((item) => item.status === 'unavailable').length,
      unknown: report.capabilities.filter((item) => item.status === 'unknown').length
    },
    issueCount: report.issues.length
  };
}

function parseArgs(argv) {
  const options = { report: null, sources: new Map(), containers: new Map(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { options.json = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) fail('CLI_USAGE', `${arg} needs a value`, 'cli');
    if (arg === '--report') options.report = value;
    else if (arg === '--source' || arg === '--container') {
      const separator = value.indexOf('=');
      if (separator <= 0) fail('CLI_USAGE', `${arg} expects id=path`, 'cli');
      const target = arg === '--source' ? options.sources : options.containers;
      const id = value.slice(0, separator);
      idValue(id, 'CLI_ID_INVALID');
      if (target.has(id)) fail('CLI_DUPLICATE_ID', id, 'cli');
      target.set(id, value.slice(separator + 1));
    } else fail('CLI_USAGE', `unknown argument ${arg}`, 'cli');
    index += 1;
  }
  if (!options.report) fail('CLI_USAGE', '--report is required', 'cli');
  if (options.sources.size === 0) fail('CLI_USAGE', 'at least one --source is required', 'cli');
  return options;
}

function loadMapping(paths, maximum) {
  const result = new Map();
  for (const [id, path] of paths) {
    const file = readRegularFile(path, maximum);
    result.set(id, file.bytes);
  }
  return result;
}

export function main(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return error instanceof ContractError && error.kind === 'cli' ? 1 : 1;
  }
  try {
    const { value: report } = readJsonFile(options.report);
    const sources = loadMapping(options.sources, MAX_SOURCE_BYTES);
    const containers = loadMapping(options.containers, MAX_CONTAINER_BYTES);
    const summary = validateCapabilityReport(report, sources, containers);
    if (options.json) io.stdout.write(`${JSON.stringify(summary)}\n`);
    else {
      io.stdout.write(`capability audit valid: sources=${summary.sourceCount} capabilities=${summary.capabilityCounts.sourceSupported + summary.capabilityCounts.unavailable + summary.capabilityCounts.unknown} unknown=${summary.capabilityCounts.unknown} issues=${summary.issueCount}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    if (error instanceof IoError) return 1;
    if (error instanceof ContractError) return error.kind === 'cli' ? 1 : 2;
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
