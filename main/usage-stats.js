'use strict';

// Daily token-usage aggregation over local session wire logs.
//
// Scans `usage.record` lines in `agents/main/wire.jsonl` under BOTH session
// roots: the CLI root (<KIMI_CODE_HOME|~/.kimi-code>/sessions) and the direct
// engine root (<userData>/direct-sessions). Verified line schema (kimi 0.28.1,
// 249/249 records across 10 real sessions identical):
//   {"type":"usage.record","model":"kimi-code/k3",
//    "usage":{"inputOther":2412,"output":320,"inputCacheRead":19200,
//             "inputCacheCreation":0},
//    "usageScope":"turn","time":1784513478209}        // time = epoch ms
// Field reads are defensive (snake_case alternates accepted) so direct-store
// records with slightly different key spellings still count.
//
// Layouts handled (discovered by depth, no assumptions about dir names):
//   <root>/<wd_*>/<session_*>/agents/main/wire.jsonl   (CLI root)
//   <root>/<sid>/agents/main/wire.jsonl                (direct-sessions root)
//
// input_tokens = inputOther + inputCacheRead + inputCacheCreation (all input
// processed that turn); output_tokens = output. Records are bucketed per LOCAL
// day into a rolling 7-day window (today + previous 6). Parsing is cached per
// file by (mtimeMs, size) exactly like main/search.js, so a warm call is
// readdir + stats + in-memory aggregation only.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_FILES = 500; // scan at most the 500 most recently active wire logs
const DAYS = 7;

// wirePath -> { mtimeMs, size, records: [{ t, input, output, cost: number|null }] }
const wireCache = new Map();

function kimiHome() {
  const home = process.env.KIMI_CODE_HOME;
  return home && home.trim() ? home.trim() : path.join(os.homedir(), '.kimi-code');
}

// Default roots: CLI sessions + direct sessions (electron userData). The
// electron require is guarded so this module also loads in plain node tests —
// pass explicit roots there via getDailyUsage({ roots }).
function defaultRoots() {
  const roots = [path.join(kimiHome(), 'sessions')];
  try {
    const { app } = require('electron');
    const userData = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
    if (userData) roots.push(path.join(userData, 'direct-sessions'));
  } catch {
    // not running inside electron main — CLI root only
  }
  return roots;
}

async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

// First finite number >= 0 among the given keys; { v, found } so callers can
// distinguish "0" from "absent" (cost_usd must be omitted when never present).
function numField(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return { v, found: true };
  }
  return { v: 0, found: false };
}

// Parse usage.record lines out of one wire.jsonl. Pure function of contents.
// Tolerates corrupt/truncated lines (writer crash mid-append) and any other
// line types — anything unparseable or unusable is skipped.
function parseWireUsage(contents) {
  const records = [];
  for (const line of contents.split('\n')) {
    if (!line || line[0] !== '{') continue;
    if (!line.includes('"usage.record"')) continue; // cheap pre-filter
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== 'usage.record') continue;
    const t = typeof j.time === 'number' && Number.isFinite(j.time) ? j.time : null;
    if (t === null) continue; // no timestamp -> cannot bucket, skip
    const u = j.usage && typeof j.usage === 'object' ? j.usage : {};
    const inputOther = numField(u, ['inputOther', 'input', 'input_tokens']);
    const cacheRead = numField(u, ['inputCacheRead', 'cacheRead', 'cache_read', 'cache_read_tokens']);
    const cacheCreation = numField(u, [
      'inputCacheCreation',
      'cacheCreation',
      'cache_creation',
      'cache_creation_tokens',
    ]);
    const output = numField(u, ['output', 'output_tokens']);
    // Cost is not part of the CLI schema; accept it inside usage or top-level.
    let cost = numField(u, ['cost_usd', 'costUsd', 'total_cost_usd', 'cost']);
    if (!cost.found) cost = numField(j, ['cost_usd', 'costUsd', 'total_cost_usd']);
    records.push({
      t,
      input: inputOther.v + cacheRead.v + cacheCreation.v,
      output: output.v,
      cost: cost.found ? cost.v : null,
    });
  }
  return records;
}

// mtime+size cached per-file records, mirroring main/search.js loadWireEntries.
async function loadWireRecords(wirePath, st) {
  const hit = wireCache.get(wirePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.records;
  let contents;
  try {
    contents = await fs.readFile(wirePath, 'utf8');
  } catch {
    return [];
  }
  const records = parseWireUsage(contents);
  wireCache.set(wirePath, { mtimeMs: st.mtimeMs, size: st.size, records });
  return records;
}

// Candidate wire.jsonl paths under one root, covering both the 2-level CLI
// layout (<wd_*>/<sid>) and the 1-level direct layout (<sid>).
async function listWireCandidates(root) {
  const out = [];
  let lvl1;
  try {
    lvl1 = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out; // root missing/unreadable
  }
  for (const e1 of lvl1) {
    if (!e1.isDirectory()) continue;
    const p1 = path.join(root, e1.name);
    out.push(path.join(p1, 'agents', 'main', 'wire.jsonl'));
    let lvl2;
    try {
      lvl2 = await fs.readdir(p1, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e2 of lvl2) {
      if (!e2.isDirectory()) continue;
      out.push(path.join(p1, e2.name, 'agents', 'main', 'wire.jsonl'));
    }
  }
  return out;
}

// 'YYYY-MM-DD' in LOCAL time (renderer renders the same local days).
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Oldest-first window of the last DAYS local days ending today.
// Built with Date(y, m, d - i) so DST transitions cannot shift a bucket.
function windowKeys(now) {
  const keys = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    keys.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

/**
 * Aggregate per-day token usage across all local session wire logs.
 * @param {{ roots?: string[], now?: Date }} [opts] roots override defaults
 *   (CLI sessions root + direct-sessions root); `now` is a test hook.
 * @returns {Promise<{ today: { input_tokens:number, output_tokens:number, cost_usd?:number },
 *   days: Array<{ date:string, input_tokens:number, output_tokens:number }> }>}
 *   `days` is exactly 7 entries, oldest first, today last.
 */
async function getDailyUsage(opts = {}) {
  const roots = Array.isArray(opts.roots) && opts.roots.length ? opts.roots : defaultRoots();
  const now = opts.now instanceof Date ? opts.now : new Date();
  const keys = windowKeys(now);
  const inWindow = new Set(keys);

  // Collect candidate files from every root, keep the MAX_FILES most recent.
  const candidates = (await Promise.all(roots.map(listWireCandidates))).flat();
  const statted = await Promise.all(
    candidates.map(async (p) => ({ p, st: await statOrNull(p) }))
  );
  const files = statted
    .filter((f) => f.st && f.st.isFile())
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, MAX_FILES);

  const perFile = await Promise.all(files.map((f) => loadWireRecords(f.p, f.st)));

  const buckets = new Map(); // key -> { input, output, cost, hasCost }
  for (const records of perFile) {
    for (const r of records) {
      const key = dayKey(new Date(r.t));
      if (!inWindow.has(key)) continue;
      let b = buckets.get(key);
      if (!b) {
        b = { input: 0, output: 0, cost: 0, hasCost: false };
        buckets.set(key, b);
      }
      b.input += r.input;
      b.output += r.output;
      if (r.cost !== null) {
        b.cost += r.cost;
        b.hasCost = true;
      }
    }
  }

  const days = keys.map((date) => {
    const b = buckets.get(date);
    return {
      date,
      input_tokens: b ? b.input : 0,
      output_tokens: b ? b.output : 0,
    };
  });
  const todayKey = keys[keys.length - 1];
  const tb = buckets.get(todayKey);
  const today = {
    input_tokens: tb ? tb.input : 0,
    output_tokens: tb ? tb.output : 0,
  };
  if (tb && tb.hasCost) today.cost_usd = tb.cost;
  return { today, days };
}

/** Test hook: drop all caches so the next call re-reads everything. */
function _clearCache() {
  wireCache.clear();
}

module.exports = { getDailyUsage, _clearCache };
