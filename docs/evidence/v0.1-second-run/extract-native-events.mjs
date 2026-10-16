/**
 * Extract sanitised DSH native execution evidence for one workflow run.
 *
 * Written by the orchestrating agent.  It reads the DSH session logs that the
 * harness itself wrote for the subagent sessions spawned by
 * workflows/three-agent-mvp.js, decompresses them (each log is a JSONL stream
 * cut into many zstd frames) and keeps a strict whitelist of non-content
 * fields: session identity, sandbox/approval policy, model configuration,
 * turn/step boundaries, tool call identifiers and timestamps.
 *
 * Deliberately NOT extracted (privacy boundary): user and assistant message
 * text, system prompts, tool arguments and tool result payloads, and anything
 * from the credentials store.
 *
 * Usage (from the repository root):
 *
 *   node docs/evidence/v0.1-second-run/extract-native-events.mjs \
 *        --parent session-3f96bf08-83ae-48d6-a239-0223d4b1c12c \
 *        --since 2026-10-16T19:48:21+08:00 \
 *        --out docs/evidence/v0.1-second-run/dsh-native-events.json
 *
 * The harness home is always taken from the DSH_HOME environment variable, so
 * no local user path is baked into this file.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function parseArgs(argv) {
  const out = { parent: null, since: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--parent') out.parent = argv[++i];
    else if (key === '--since') out.since = argv[++i];
    else if (key === '--out') out.out = argv[++i];
  }
  if (!out.parent || !out.since || !out.out) {
    throw new Error('usage: --parent <session id> --since <ISO timestamp> --out <file>');
  }
  return out;
}

/** Decompress every concatenated zstd frame in a session log buffer. */
function decompressAllFrames(buffer) {
  const offsets = [];
  for (let i = 0; i <= buffer.length - 4; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i);
  }
  const parts = [];
  for (const offset of offsets) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset)));
    } catch {
      // A partially written trailing frame is not an error for this purpose.
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function readRecords(file) {
  const text = decompressAllFrames(readFileSync(file));
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // ignore a torn final line
    }
  }
  return records;
}

function scrub(value, cwd) {
  if (typeof value !== 'string') return value;
  return value
    .split(cwd).join('<repo>')
    .replace(/[A-Za-z]:\\\\Users\\\\[^\\\\"']+/g, '<home>')
    .replace(/[A-Za-z]:\\Users\\[^\\"']+/g, '<home>');
}

/** Collect every session directory under $DSH_HOME/sessions. */
function listSessionFiles(home) {
  const root = join(home, 'sessions');
  const files = [];
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const sessionDir of readdirSync(groupDir)) {
      const candidate = join(groupDir, sessionDir, 'session.v4.jsonl.zstd');
      try {
        if (statSync(candidate).isFile()) files.push(candidate);
      } catch {
        // no session log in this directory
      }
    }
  }
  return files;
}

function summarize(records, cwd) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const toolCalls = [];
  const turns = [];
  const steps = [];
  let model = null;
  let descriptor = null;
  let title = null;
  let sandbox = null;
  let approval = null;
  let firstTime = null;
  let lastTime = null;

  for (const record of records) {
    bump(record.type ?? 'unknown');
    if (typeof record.time === 'number') {
      firstTime = firstTime === null ? record.time : Math.min(firstTime, record.time);
      lastTime = lastTime === null ? record.time : Math.max(lastTime, record.time);
    }
    const data = record.data ?? {};
    switch (record.type) {
      case 'sandbox/mode':
        sandbox = { mode: data.mode ?? null, source: data.source ?? null };
        break;
      case 'approval/policy':
        approval = { policy: data.policy ?? null, source: data.source ?? null };
        break;
      case 'subagent/descriptor':
        descriptor = { version: data.version ?? null, mode: data.mode ?? null, provider: data.provider ?? null };
        break;
      case 'request/context':
        model = {
          provider: data.provider ?? null,
          model: data.model ?? null,
          contextWindow: data.contextWindow ?? null,
        };
        break;
      case 'session/title':
        title = typeof data.title === 'string' ? scrub(data.title.slice(0, 80), cwd) : null;
        break;
      case 'turn/start':
        turns.push({ turn: data.turn, startedAt: new Date(record.time).toISOString() });
        break;
      case 'turn/end':
        turns.push({ turn: data.turn, endedAt: new Date(record.time).toISOString(), reason: data.reason?.kind ?? null });
        break;
      case 'step/start':
        steps.push({ turn: data.turn, step: data.step, startedAt: new Date(record.time).toISOString() });
        break;
      case 'step/end':
        steps.push({ turn: data.turn, step: data.step, endedAt: new Date(record.time).toISOString() });
        break;
      case 'tool/call': {
        let argumentKeys = [];
        let target = null;
        try {
          const args = JSON.parse(data.arguments ?? '{}');
          argumentKeys = Object.keys(args).sort();
          const pathLike = args.file_path ?? args.path ?? args.workdir ?? null;
          if (typeof pathLike === 'string') target = scrub(pathLike, cwd);
        } catch {
          argumentKeys = ['<unparseable>'];
        }
        toolCalls.push({
          callId: data.callId ?? null,
          name: data.name ?? null,
          turn: data.turn ?? null,
          step: data.step ?? null,
          at: new Date(record.time).toISOString(),
          argumentKeys,
          target,
        });
        break;
      }
      default:
        break;
    }
  }

  return {
    model,
    descriptor,
    sandbox,
    approval,
    titlePrefix: title,
    firstEventAt: firstTime === null ? null : new Date(firstTime).toISOString(),
    lastEventAt: lastTime === null ? null : new Date(lastTime).toISOString(),
    turnCount: turns.filter((t) => t.startedAt).length,
    stepCount: steps.filter((s) => s.startedAt).length,
    toolCallCount: toolCalls.length,
    recordTypeCounts: Object.fromEntries([...counts.entries()].sort()),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = process.env.DSH_HOME;
  if (!home) throw new Error('DSH_HOME is not set');
  const sinceMs = Date.parse(args.since);
  if (Number.isNaN(sinceMs)) throw new Error(`invalid --since value: ${args.since}`);

  const sessions = [];
  for (const file of listSessionFiles(home)) {
    let records;
    try {
      records = readRecords(file);
    } catch {
      continue;
    }
    const header = records.find((r) => r.type === 'session');
    if (!header) continue;
    if (header.parentSession !== args.parent) continue;
    if (typeof header.createdAt !== 'number' || header.createdAt < sinceMs) continue;
    const cwd = header.cwd ?? '';
    sessions.push({
      sessionId: header.id,
      parentSessionId: header.parentSession,
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? null,
      agentPreset: header.agentPreset ?? null,
      workspace: scrub(cwd, cwd),
      createdAt: new Date(header.createdAt).toISOString(),
      ...summarize(records, cwd),
    });
  }
  sessions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const document = {
    description: 'Sanitised DSH native execution evidence for one three-agent workflow run.',
    source: 'DSH session logs (harness-written JSONL + zstd, one file per agent session)',
    extraction: {
      script: 'docs/evidence/v0.1-second-run/extract-native-events.mjs',
      method: 'decompress every zstd frame, keep a whitelist of non-content fields',
      parentSessionFilter: args.parent,
      createdSince: args.since,
      excludedByDesign: [
        'user and assistant message text',
        'system prompts and role instructions',
        'tool call arguments and tool result payloads',
        'anything from the DSH credential store',
      ],
    },
    sessionCount: sessions.length,
    sessions,
  };

  writeFileSync(args.out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  for (const session of sessions) {
    const label = session.titlePrefix ?? '(no title)';
    console.log(
      `${session.sessionId}  created=${session.createdAt}  model=${session.model?.model}/${session.model?.provider}  ` +
        `turns=${session.turnCount} steps=${session.stepCount} toolCalls=${session.toolCallCount}  title=${label}`,
    );
  }
  console.log(`wrote ${args.out} (${sessions.length} agent sessions)`);
}

main();
