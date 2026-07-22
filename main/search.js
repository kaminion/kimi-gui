'use strict';

// Local full-text search over Kimi Code session transcripts on disk.
//
// On-disk layout (kimi 0.28.1, verified):
//   <KIMI_CODE_HOME|~/.kimi-code>/sessions/<wd_*>/<session_id>/
//     state.json                    { id, cwd, title, lastPrompt, createdAt, updatedAt, ... }
//     agents/main/wire.jsonl        event-sourced transcript, one JSON object per line
//
// wire.jsonl line types relevant here (all others ignored):
//   {"type":"metadata", ...}                                        file header
//   {"type":"context.append_message","message":{"role","content":[{"type":"text","text"}],
//      "id"?,"origin":{"kind"}},"time":<ms>}                        user-side message
//   {"type":"context.append_loop_event","event":{"type":"step.begin"|"content.part"|
//      "tool.call"|"tool.result"|"step.end", ...},"time":<ms>}      assistant/tool activity
//
// The REST API (GET /sessions/{id}/messages) replays this log with rules that
// were reverse-engineered and verified live (14/15 sessions byte-identical, the
// last differing only in server-side UTF-8 mojibake):
//   - one message per context.append_message (skips origin.kind "task" and
//     "<notification …" texts — the server never exposes those);
//   - one assistant message per step.begin (aggregates the step's text parts;
//     may stay empty, e.g. slash commands);
//   - one tool message per tool.result (not searchable, but occupies an id slot);
//   - a user message appended mid-step lands AFTER that step's tool results;
//   - messages without a wire "id" get msg_<sessionId>_<6-digit 0-based index>
//     over the full replayed sequence (user + assistant + tool).
// Reproducing that numbering lets search hits deep-link to the exact message
// the chat view renders (Chat.scrollToMessage via data-message-id).

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_SESSIONS = 500; // scan at most the 500 most recently active sessions
const SNIPPET_RADIUS = 40; // chars kept on each side of the match
const ID_PAD = 6;

// wirePath -> { mtimeMs, size, entries: [{ sessionId, messageId, role, text, createdAtMs }] }
const wireCache = new Map();
// sessionDir -> { mtimeMs, title, cwd, updatedAtMs }
const metaCache = new Map();
// session_index.jsonl path -> { mtimeMs, byId: Map<sessionId, workDir> }
const indexCache = new Map();

function kimiHome() {
  const home = process.env.KIMI_CODE_HOME;
  return home && home.trim() ? home.trim() : path.join(os.homedir(), '.kimi-code');
}

async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

function padSeq(n) {
  return String(n).padStart(ID_PAD, '0');
}

// Replay one wire.jsonl into searchable user/assistant text entries.
// Pure function of file contents — result is cached by (mtimeMs, size).
function parseWire(contents, sessionId) {
  const entries = [];
  let seq = 0; // global message slot counter, mirrors REST id numbering
  let inStep = false;
  let pendingUsers = []; // mid-step user appends, flushed at step end
  let assistant = null; // current step's assistant slot

  const nextId = (wireId) => {
    const id = wireId || `msg_${sessionId}_${padSeq(seq)}`;
    seq += 1;
    return id;
  };

  for (const line of contents.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // tolerate a truncated tail line (writer crashed mid-append)
    }

    if (j.type === 'context.append_message' && j.message) {
      const m = j.message;
      const text = Array.isArray(m.content)
        ? m.content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
        : '';
      const kind = m.origin && m.origin.kind;
      // The REST transcript excludes task notifications entirely (no id slot).
      if (kind === 'task' || text.startsWith('<notification')) continue;
      const rec = { role: m.role || 'user', wireId: m.id || null, text, time: j.time, kind };
      if (inStep) pendingUsers.push(rec);
      else commitUser(rec);
    } else if (j.type === 'context.append_loop_event' && j.event) {
      const e = j.event;
      if (e.type === 'step.begin') {
        inStep = true;
        // The assistant slot always exists (even when it stays empty, e.g.
        // slash commands) and takes its id now; tool results follow after.
        assistant = { role: 'assistant', seqSlot: seq, text: '', time: j.time };
        seq += 1;
      } else if (e.type === 'content.part') {
        if (assistant && e.part && e.part.type === 'text' && typeof e.part.text === 'string') {
          assistant.text += (assistant.text ? '\n' : '') + e.part.text;
        }
      } else if (e.type === 'tool.result') {
        seq += 1; // tool message slot (never searchable)
      } else if (e.type === 'step.end') {
        endStep();
      }
    }
  }
  endStep(); // session may have died mid-step
  return entries;

  function commitUser(rec) {
    const id = nextId(rec.wireId);
    // Only genuine user input is searchable; injected system reminders and
    // skill-activation notices keep their id slots but are noise for search.
    if (rec.kind !== 'user' && rec.kind !== null && rec.kind !== undefined) return;
    if (!rec.text.trim()) return;
    entries.push({ sessionId, messageId: id, role: 'user', text: rec.text, createdAtMs: rec.time ?? 0 });
  }

  function endStep() {
    if (assistant) {
      if (assistant.text.trim()) {
        entries.push({
          sessionId,
          messageId: `msg_${sessionId}_${padSeq(assistant.seqSlot)}`,
          role: 'assistant',
          text: assistant.text,
          createdAtMs: assistant.time ?? 0,
        });
      }
      assistant = null;
    }
    inStep = false;
    for (const rec of pendingUsers) commitUser(rec);
    pendingUsers = [];
  }
}

async function loadWireEntries(wirePath, sessionId) {
  const st = await statOrNull(wirePath);
  if (!st || !st.isFile()) return [];
  const hit = wireCache.get(wirePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entries;
  let contents;
  try {
    contents = await fs.readFile(wirePath, 'utf8');
  } catch {
    return [];
  }
  const entries = parseWire(contents, sessionId);
  wireCache.set(wirePath, { mtimeMs: st.mtimeMs, size: st.size, entries });
  return entries;
}

// state.json -> { title, cwd, updatedAtMs }, cached by mtime. Null when unreadable.
async function loadSessionMeta(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  const st = await statOrNull(statePath);
  if (!st) return null;
  const hit = metaCache.get(sessionDir);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta;
  const j = await readJsonOrNull(statePath);
  const meta = j
    ? {
        title: typeof j.title === 'string' ? j.title : '',
        lastPrompt: typeof j.lastPrompt === 'string' ? j.lastPrompt : '',
        cwd: typeof j.cwd === 'string' ? j.cwd : '',
        updatedAtMs: typeof j.updatedAt === 'number' ? j.updatedAt : st.mtimeMs,
      }
    : null;
  metaCache.set(sessionDir, { mtimeMs: st.mtimeMs, meta });
  return meta;
}

// ~/.kimi-code/session_index.jsonl lines: {"sessionId","sessionDir","workDir"}.
async function loadSessionIndex(home) {
  const indexPath = path.join(home, 'session_index.jsonl');
  const st = await statOrNull(indexPath);
  if (!st) return new Map();
  const hit = indexCache.get(indexPath);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.byId;
  const byId = new Map();
  try {
    for (const line of (await fs.readFile(indexPath, 'utf8')).split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j && typeof j.sessionId === 'string' && typeof j.workDir === 'string') byId.set(j.sessionId, j.workDir);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // unreadable index — fall back to state.json / dir name only
  }
  indexCache.set(indexPath, { mtimeMs: st.mtimeMs, byId });
  return byId;
}

// wd_<name>_<hash> -> <name> (last-resort cwd fallback).
function cwdFromDirName(workspaceDir) {
  const m = /^wd_(.+)_[0-9a-f]{8,}$/i.exec(workspaceDir);
  return m ? m[1] : workspaceDir;
}

// List session dirs (up to MAX_SESSIONS, most recently active first).
async function listSessionDirs(home) {
  const root = path.join(home, 'sessions');
  let workspaces;
  try {
    workspaces = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    let dirs;
    try {
      dirs = await fs.readdir(path.join(root, ws.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || !d.name.startsWith('session_')) continue;
      sessions.push({ sessionId: d.name, dir: path.join(root, ws.name, d.name), workspaceDir: ws.name });
    }
  }
  return sortByMtime(sessions);
}

// V3 (B3): direct-engine sessions live FLAT under <root>/<sid>/ (no wd_*
// workspace level, and ids are not necessarily session_-prefixed), with the
// same state.json + agents/main/wire.jsonl contents (CONTRACT-V3).
async function listFlatSessionDirs(root) {
  let dirs;
  try {
    dirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    sessions.push({ sessionId: d.name, dir: path.join(root, d.name), workspaceDir: null });
  }
  return sortByMtime(sessions);
}

// Activity order: state.json mtime is a good proxy and one stat per session is cheap.
async function sortByMtime(sessions) {
  const withMtime = await Promise.all(
    sessions.map(async (s) => {
      const st = await statOrNull(path.join(s.dir, 'state.json'));
      return { ...s, mtimeMs: st ? st.mtimeMs : 0 };
    })
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.slice(0, MAX_SESSIONS);
}

function firstUserLine(entries) {
  for (const e of entries) {
    if (e.role === 'user') {
      const line = e.text.split('\n').find((l) => l.trim());
      if (line) return line.trim().slice(0, 80);
    }
  }
  return '';
}

function makeSnippet(text, lowerText, lowerQuery) {
  const i = lowerText.indexOf(lowerQuery);
  if (i < 0) return '';
  const flat = text.replace(/\s+/g, ' ');
  // Re-locate the match in the whitespace-collapsed text approximately:
  // indexOf on the flattened text keeps snippet offsets consistent.
  const lowerFlat = flat.toLowerCase();
  const j = lowerFlat.indexOf(lowerQuery);
  const at = j >= 0 ? j : i;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + lowerQuery.length + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

/**
 * Search all local session transcripts for a case-insensitive substring.
 * @param {string} query
 * @param {number} [limit=50]
 * @param {{extraRoots?: string[]}} [opts] V3 (B3): additional FLAT session
 *   roots (<root>/<sid>/, e.g. the direct engine's direct-sessions dir) to
 *   search alongside the CLI's ~/.kimi-code/sessions tree. Omitting opts
 *   keeps the v2 behavior exactly.
 * @returns {Promise<Array<{sessionId:string, sessionTitle:string, cwd:string,
 *   messageId:string, role:string, snippet:string, createdAt:string}>>}
 *   Hits ranked newest-first.
 */
async function searchAll(query, limit = 50, opts) {
  const q = typeof query === 'string' ? query.trim() : '';
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  if (!q) return [];
  const lowerQuery = q.toLowerCase();
  const home = kimiHome();
  const extraRoots =
    opts && Array.isArray(opts.extraRoots)
      ? opts.extraRoots.filter((r) => typeof r === 'string' && r.length > 0)
      : [];

  const [sessions, indexById, extraSessions] = await Promise.all([
    listSessionDirs(home),
    loadSessionIndex(home),
    Promise.all(extraRoots.map((r) => listFlatSessionDirs(r))).then((r) => r.flat()),
  ]);
  const allSessions = sessions.concat(extraSessions);

  // Load transcripts for candidate sessions (cache makes this stat-only when warm).
  const perSession = await Promise.all(
    allSessions.map(async (s) => {
      const [meta, entries] = await Promise.all([
        loadSessionMeta(s.dir),
        loadWireEntries(path.join(s.dir, 'agents', 'main', 'wire.jsonl'), s.sessionId),
      ]);
      return { s, meta, entries };
    })
  );

  // Flatten and rank newest-first across all sessions.
  const all = [];
  for (const { entries } of perSession) all.push(...entries);
  all.sort((a, b) => b.createdAtMs - a.createdAtMs);

  const hits = [];
  for (const e of all) {
    if (hits.length >= cap) break;
    const lowerText = e.text.toLowerCase();
    if (!lowerText.includes(lowerQuery)) continue;
    const ctx = perSession.find((p) => p.s.sessionId === e.sessionId);
    const meta = ctx && ctx.meta;
    const cwd =
      (meta && meta.cwd) ||
      indexById.get(e.sessionId) ||
      (ctx && ctx.s.workspaceDir ? cwdFromDirName(ctx.s.workspaceDir) : '');
    const title =
      (meta && (meta.title || meta.lastPrompt)) ||
      firstUserLine(ctx ? ctx.entries : []) ||
      e.sessionId;
    hits.push({
      sessionId: e.sessionId,
      sessionTitle: title,
      cwd,
      messageId: e.messageId,
      role: e.role,
      snippet: makeSnippet(e.text, lowerText, lowerQuery),
      createdAt: e.createdAtMs ? new Date(e.createdAtMs).toISOString() : '',
    });
  }
  return hits;
}

/** Test hook: drop all caches so the next search re-reads everything. */
function _clearCache() {
  wireCache.clear();
  metaCache.clear();
  indexCache.clear();
}

module.exports = { searchAll, _clearCache };
