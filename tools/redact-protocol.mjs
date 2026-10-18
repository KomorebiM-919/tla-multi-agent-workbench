// Converts locally captured request bodies into the redacted protocol fixture
// that is safe to keep in the repository.
//
// The fixture keeps what the policy reasons about — role, tool calls, tool
// results and their failure markers — and drops everything that is only host
// or harness context:
//
//   - system prompt                      -> one normalized role sentence
//   - tool list                          -> the names the policy dispatches on
//   - tool_result text                   -> kept, truncated to MAX_RESULT_CHARS
//   - absolute paths / team / uuids      -> placeholders (see below)
//
// Rules for the placeholders:
//   - absolute host path under the captured project  -> <PROJECT>
//   - absolute path under the worktree               -> <WORKTREE>
//   - any other absolute host path                   -> <HOST_PATH>
//   - team name (closure1..closureN, fixture-loop)   -> <TEAM>
//   - attempt / session uuid                         -> <UUID:n> (stable order)
//
// The raw captures stay in tests/.scratch and are never published.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const IN_DIR = join(ROOT, '..', 'v02-stage2', 'closure', 'run4', 'bodies');
const OUT_DIR = join(ROOT, 'tests', 'fixtures', 'repair-protocol');
const MAX_RESULT_CHARS = 600;

const CAPTAIN_TOOLS = ['agent_teams_create', 'agent_teams_status', 'agent_teams_create_task'];
const MEMBER_TOOLS = ['agent_teams_claim_task', 'agent_teams_update_task', 'read', 'write', 'pwsh'];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TEAM = /\bclosure\d*\b|\bfixture-loop\b/g;

const PATH_RULES = [
  [/[A-Za-z]:\\[^"'\s<>]*?\\v02-stage2\\closure\\project/gi, '<PROJECT>'],
  [/[A-Za-z]:\\[^"'\s<>]*?\\v02-worktree/gi, '<WORKTREE>'],
  [/[A-Za-z]:\\(?:Users|AI)\\[^"'\s<>]*/gi, '<HOST_PATH>'],
];

function redactText(text) {
  let out = text;
  // Harness context (skills catalog, workspace instructions, runtime snapshot)
  // is not part of the protocol under test; drop it instead of publishing it.
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  out = out.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, '');
  if (/^\s*Current runtime context\./.test(out)) out = out.slice(0, 200);
  for (const [pattern, replacement] of PATH_RULES) out = out.replace(pattern, replacement);
  return out.replace(TEAM, '<TEAM>').replace(/\n{3,}/g, '\n\n').trim();
}

const uuids = new Map();

function redactDeep(value) {
  if (typeof value === 'string') {
    return redactText(value).replace(UUID, (match) => {
      const key = match.toLowerCase();
      if (!uuids.has(key)) uuids.set(key, '<UUID:' + (uuids.size + 1) + '>');
      return uuids.get(key);
    });
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item);
    return out;
  }
  return value;
}

function roleOf(raw) {
  const names = (raw.tools || []).map((tool) => (tool && tool.name) || '');
  if (names.includes('agent_teams_create')) return 'captain';
  if (names.includes('agent_teams_claim_task')) return 'member';
  return 'unknown';
}

/** Picks the member name out of the spawn prompt, which lives in a user message. */
function memberNameOf(raw) {
  for (const message of raw.messages) {
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (part && part.text) || '').join('\n')
        : '';
    const match = text.match(/You are ([a-z][a-z-]*), a member of team/i) || text.match(/configured member "([a-z][a-z-]*)"/i);
    if (match) return match[1];
  }
  return null;
}

function normalizeMessages(raw, role) {
  const memberName = role === 'member' ? memberNameOf(raw) : null;
  const messages = [];
  const roleSeen = role === 'captain' ? 'captain' : memberName;
  const roleSentence = role === 'captain'
    ? 'You are the captain of team <TEAM>.'
    : memberName
      ? `You are ${memberName}, a member of team <TEAM>.`
      : 'You are a member of team <TEAM>.';
  // Member sessions captured here start with the spawn prompt and carry no
  // system message; the fixture adds the normalized role sentence instead.
  if (!raw.messages.some((message) => message.role === 'system')) {
    messages.push({ role: 'system', content: roleSentence });
  }
  for (const message of raw.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: roleSentence });
      continue;
    }
    const parts = [];
    const content = message.content;
    if (typeof content === 'string') {
      parts.push({ type: 'text', text: redactText(content) });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') parts.push({ type: 'text', text: redactText(String(part.text || '')) });
        else if (part.type === 'tool_use') parts.push({ type: 'tool_use', id: part.id, name: part.name, input: redactDeep(part.input ?? {}) });
        else if (part.type === 'tool_result') {
          const inner = Array.isArray(part.content)
            ? part.content.map((item) => ({ type: item.type, text: redactText(String(item.text || '')).slice(0, MAX_RESULT_CHARS) }))
            : [{ type: 'text', text: redactText(String(part.content || '')).slice(0, MAX_RESULT_CHARS) }];
          parts.push({ type: 'tool_result', tool_use_id: part.tool_use_id, is_error: part.is_error === true, content: inner });
        }
      }
    }
    messages.push({ role: message.role, content: parts });
  }
  return { messages, roleSeen };
}

function main() {
  if (!existsSync(IN_DIR)) {
    console.error('capture directory not found:', relative(ROOT, IN_DIR));
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(IN_DIR).filter((name) => /^request-\d+\.json$/.test(name)).sort();
  const manifest = [];
  for (const name of files) {
    const raw = JSON.parse(readFileSync(join(IN_DIR, name), 'utf8'));
    const role = roleOf(raw);
    const { messages } = normalizeMessages(raw, role);
    const body = {
      tools: (role === 'captain' ? CAPTAIN_TOOLS : MEMBER_TOOLS).map((toolName) => ({ name: toolName })),
      messages,
    };
    const text = JSON.stringify(body, null, 2) + '\n';
    writeFileSync(join(OUT_DIR, name), text, 'utf8');
    manifest.push({
      file: name,
      role,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(text, 'utf8'),
      messages: body.messages.length,
    });
  }
  writeFileSync(
    join(OUT_DIR, 'MANIFEST.json'),
    JSON.stringify(
      {
        schema: 'tla.repair-protocol/v1',
        source: 'local capture, raw bodies not published',
        captured: 'closure/run4 (2026-10-18)',
        conversion: [
          'system prompt -> one normalized role sentence',
          'tool list -> the names the policy dispatches on',
          'tool_result text kept and truncated to ' + MAX_RESULT_CHARS + ' chars',
          'host project path -> <PROJECT>',
          'worktree path -> <WORKTREE>',
          'other host path -> <HOST_PATH>',
          'team name -> <TEAM>',
          'uuid -> <UUID:n> (stable across files)',
        ],
        files: manifest,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log('redacted ' + manifest.length + ' bodies -> ' + relative(ROOT, OUT_DIR));
}

main();
