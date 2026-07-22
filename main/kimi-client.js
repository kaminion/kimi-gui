'use strict';
/**
 * KimiClient — Node-side client for a spawned `kimi web` daemon (kimi 0.28.1).
 *
 * Protocol facts (verified live, see docs/protocol.md):
 *  - REST base: <baseUrl>/api/v1, `Authorization: Bearer <token>`,
 *    envelope `{code, msg, data}` — code 0 means success.
 *  - WS: ws://<host>/api/v1/ws, auth via subprotocol `kimi-code.bearer.<token>`.
 *    server_hello → client_hello → subscribe; server pushes event frames whose
 *    `type` is the event name (protocol events carry an `event.` prefix, which
 *    this client strips before re-emitting).
 *  - Stop button: REST `POST /sessions/{id}:abort` (WS abort is ignored).
 *
 * Never logs the auth token.
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const API = '/api/v1';
const BANNER_RE = /(https?:\/\/[\w.-]+):(\d+)\/#token=([^\s]+)/;
const REDACTED = '<redacted>';

/** Error raised for daemon responses with code != 0 or HTTP failures. */
class KimiApiError extends Error {
  constructor(message, { code, status, path } = {}) {
    super(message);
    this.name = 'KimiApiError';
    this.code = code;       // daemon envelope code (e.g. 40001), if any
    this.status = status;   // HTTP status, if any
    this.path = path;
  }
}

class KimiClient extends EventEmitter {
  /** @param {{baseUrl: string, token: string}} opts */
  constructor({ baseUrl, token }) {
    super();
    if (!baseUrl || !token) throw new Error('KimiClient: baseUrl and token are required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;

    // WS state
    this.ws = null;
    this.wsReady = false;          // server_hello seen
    this.closed = false;           // shutdown() called — no more reconnects
    this.clientId = `kimi-desktop-${randomUUID()}`;
    this.subscriptions = new Map(); // sessionId -> cursor {seq, epoch?}
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this._msgSeq = 0;

    this.child = null;             // set by launch()
    this._defaultModel = null;     // cached from auth()
  }

  // ---------------------------------------------------------------- spawn --

  /**
   * Spawn `kimi web --no-open --port <port>` and wait for the stdout banner.
   * The daemon may bump the port (+1) when busy — always use the parsed URL.
   * @returns {Promise<{client: KimiClient, child: ChildProcess, baseUrl: string, token: string}>}
   */
  static async launch({ kimiPath = 'kimi', port = 58900 } = {}) {
    const args = ['web', '--no-open', '--port', String(port)];
    const child = spawn(kimiPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const banner = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(new Error('Timed out waiting for kimi server banner')), 30000);
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(val);
      };
      const onData = (buf) => {
        const text = buf.toString();
        const m = BANNER_RE.exec(text);
        if (m) done(null, { baseUrl: `${m[1]}:${m[2]}`, token: m[3] });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData); // banner is on stdout; scan both to be safe
      child.on('error', (err) => done(err));
      child.on('exit', (code) => done(new Error(`kimi server exited during startup (code ${code})`)));
    });

    // Forward server output to the main-process console, token redacted.
    const forward = (buf) => {
      const text = buf.toString().split(banner.token).join(REDACTED);
      for (const line of text.split(/\r?\n/)) if (line.trim()) console.log(`[kimi-server] ${line}`);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);

    const client = new KimiClient({ baseUrl: banner.baseUrl, token: banner.token });
    client.child = child;
    child.on('exit', (code, signal) => {
      if (!client.closed) client.emit('status', { ready: false, error: `server exited (code ${code ?? signal})` });
    });
    return { client, child, baseUrl: banner.baseUrl, token: banner.token };
  }

  // ----------------------------------------------------------------- REST --

  /**
   * fetch wrapper: adds auth header, unwraps `{code,msg,data}`,
   * throws KimiApiError when the envelope code is not 0.
   */
  async request(method, path, body) {
    const url = `${this.baseUrl}${API}${path}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new KimiApiError(`Network error on ${method} ${path}: ${err.message}`, { path });
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      throw new KimiApiError(json?.msg || `HTTP ${res.status} on ${method} ${path}`, {
        code: json?.code, status: res.status, path,
      });
    }
    if (json && typeof json.code === 'number' && json.code !== 0) {
      throw new KimiApiError(json.msg || `Daemon error ${json.code}`, { code: json.code, path });
    }
    return json ? json.data : null;
  }

  healthz() { return this.request('GET', '/healthz'); }
  meta() { return this.request('GET', '/meta'); }
  auth() { return this.request('GET', '/auth'); }
  listModels() { return this.request('GET', '/models').then((d) => d?.items ?? []); }

  listSessions() { return this.request('GET', '/sessions').then((d) => d?.items ?? []); }
  getSession(id) { return this.request('GET', `/sessions/${encodeURIComponent(id)}`); }

  /**
   * Session profile. 0.28.1 keeps profile.usage all-zero even after completed
   * turns (docs/protocol.md), while GET /status has the accurate live context
   * numbers — merge those into usage so callers (context meter, usage view)
   * see real data.
   */
  async getProfile(id) {
    const profile = await this.request('GET', `/sessions/${encodeURIComponent(id)}/profile`);
    try {
      const status = await this.getSessionStatus(id);
      if (status && typeof status === 'object') {
        profile.usage = {
          ...(profile?.usage ?? {}),
          context_tokens: status.context_tokens ?? profile?.usage?.context_tokens ?? 0,
          context_limit: status.max_context_tokens ?? profile?.usage?.context_limit ?? 0,
        };
      }
    } catch { /* status enrichment is best-effort */ }
    return profile;
  }

  getSessionStatus(id) { return this.request('GET', `/sessions/${encodeURIComponent(id)}/status`); }

  /**
   * Set the session's model: POST /profile {agent_config:{model}} (verified:
   * GET /status then reports the model; the profile response body itself may
   * still echo stale agent_config on 0.28.1 — re-read status for truth).
   */
  setSessionModel(id, model) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/profile`, {
      agent_config: { model: String(model) },
    });
  }

  /**
   * Enable/disable swarm mode for a session (verified live: POST /profile
   * {agent_config:{swarm_mode}} merges into agent_config, GET /status reflects
   * it as swarm_mode).
   */
  setSessionSwarm(id, enabled) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/profile`, {
      agent_config: { swarm_mode: Boolean(enabled) },
    });
  }

  /**
   * Rename a session (v3; verified live on 0.28.1: POST /profile {title} —
   * the session list and on-disk state.json reflect it, isCustomTitle is set
   * server-side). Matches the official web UI's updateSession (webui-bundle).
   */
  renameSession(id, title) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/profile`, {
      title: String(title),
    });
  }

  /**
   * Set the session's thinking effort (v3; verified live: POST /profile
   * {agent_config:{thinking:'off'|'low'|'high'|'max'}} — GET /status then
   * reports thinking_level; the server does not validate the value).
   */
  setSessionThinking(id, thinking) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/profile`, {
      agent_config: { thinking: String(thinking) },
    });
  }

  /**
   * Soft-delete a session (v3; verified live: POST :archive {} ->
   * {archived:true}; the session list filter already hides archived entries).
   */
  archiveSession(id) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}:archive`, {});
  }

  /**
   * Background tasks for a session (subagent/bash/tool):
   * [{id, session_id, kind, description, status, command?, created_at, ...}].
   */
  listTasks(id) {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/tasks`)
      .then((d) => d?.items ?? []);
  }

  /**
   * Create a session rooted at `cwd`. The daemon ignores `agent_config.model`
   * in the create body (0.28.1), so the model is applied via POST /profile.
   * Falls back to the daemon's default model when `model` is omitted —
   * sessions without any model fail their first turn (model.not_configured).
   */
  async createSession({ cwd, model } = {}) {
    const session = await this.request('POST', '/sessions', { metadata: { cwd } });
    const wanted = model ?? await this._getDefaultModel();
    if (wanted) {
      try {
        await this.request('POST', `/sessions/${encodeURIComponent(session.id)}/profile`, {
          agent_config: { model: wanted },
        });
        session.agent_config = { ...(session.agent_config ?? {}), model: wanted };
      } catch (err) {
        // Non-fatal: report the session anyway; the first turn will surface the error.
        console.warn(`[kimi-client] failed to set model on session: ${err.message}`);
      }
    }
    return session;
  }

  /** GET /messages — returns messages in chronological order (wire is newest-first). */
  async getMessages(id) {
    const d = await this.request('GET', `/sessions/${encodeURIComponent(id)}/messages`);
    return (d?.items ?? []).slice().reverse();
  }

  /** Queue/send a user prompt. Returns {prompt_id, user_message_id, status, ...}. */
  sendPrompt(id, text) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/prompts`, {
      content: [{ type: 'text', text: String(text) }],
    });
  }

  /**
   * Steer text into the active turn: submit the prompt (it queues while the
   * session is busy), then promote the queued prompt via prompts:steer.
   */
  async steer(id, text) {
    const submitted = await this.sendPrompt(id, text);
    if (submitted?.status === 'queued' && submitted.prompt_id) {
      try {
        await this.request('POST', `/sessions/${encodeURIComponent(id)}/prompts:steer`, {
          prompt_ids: [submitted.prompt_id],
        });
      } catch (err) {
        console.warn(`[kimi-client] steer failed, prompt stays queued: ${err.message}`);
      }
    }
    return submitted;
  }

  /** Stop the current turn. Session-level REST abort (WS abort is ignored by the daemon). */
  abort(id) {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}:abort`, {});
  }

  /** Pending approvals. `?status=pending` is required by the daemon. */
  listApprovals(id) {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/approvals?status=pending`)
      .then((d) => d?.items ?? []);
  }

  /** decision: 'approve'|'reject' (UI) or wire values 'approved'|'rejected'|'cancelled'. */
  respondApproval(id, approvalId, decision) {
    const map = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };
    const wire = map[decision] ?? decision;
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision: wire },
    );
  }

  listQuestions(id) {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/questions?status=pending`)
      .then((d) => d?.items ?? []);
  }

  /** body: {answers: {...}, method?, note?} — see docs/protocol.md / openapi. */
  answerQuestion(id, tail, body) {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(tail)}`,
      body,
    );
  }

  async _getDefaultModel() {
    if (this._defaultModel) return this._defaultModel;
    try {
      this._defaultModel = (await this.auth())?.default_model ?? null;
    } catch { this._defaultModel = null; }
    return this._defaultModel;
  }

  // -------------------------------------------------------------- WebSocket --

  /** Open the event WebSocket (idempotent). Auto-reconnects until shutdown(). */
  connect() {
    if (this.closed || this.ws) return;
    if (typeof WebSocket !== 'function') {
      this.emit('status', { ready: false, error: 'global WebSocket unavailable (need Node 22+ / Electron 37+)' });
      return;
    }
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}${API}/ws`;
    // Auth is the `kimi-code.bearer.<token>` subprotocol (never logged).
    const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${this.token}`]);
    this.ws = ws;

    ws.onmessage = (e) => {
      let frame;
      try { frame = JSON.parse(String(e.data)); } catch { return; }
      this._handleFrame(frame);
    };
    ws.onerror = () => { /* onclose follows and handles reconnect */ };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      const wasReady = this.wsReady;
      this.wsReady = false;
      if (!this.closed) {
        if (wasReady) this.emit('status', { ready: false });
        this._scheduleReconnect();
      }
    };
  }

  _handleFrame(frame) {
    switch (frame.type) {
      case 'server_hello': {
        this.wsReady = true;
        this.reconnectAttempts = 0;
        // (Re)subscribe everything we track, with last cursors for resync.
        const cursors = {};
        for (const [sid, cur] of this.subscriptions) cursors[sid] = cur;
        this._send({
          type: 'client_hello',
          id: this._nextId(),
          payload: { client_id: this.clientId, subscriptions: [...this.subscriptions.keys()], cursors },
        });
        this.emit('status', { ready: true });
        return;
      }
      case 'ping':
        this._send({ type: 'pong', payload: { nonce: frame.payload?.nonce } });
        return;
      case 'ack':
        return; // subscribe/hello confirmations; cursors tracked from events
      case 'resync_required': {
        const sid = frame.payload?.session_id;
        if (sid) {
          this.subscriptions.set(sid, {
            seq: frame.payload.current_seq ?? 0,
            ...(frame.payload.epoch ? { epoch: frame.payload.epoch } : {}),
          });
          this._emitSessionEvent(sid, {
            type: 'resync_required',
            session_id: sid,
            timestamp: frame.timestamp,
            payload: frame.payload,
          });
        }
        return;
      }
      case 'error': {
        // Session-scoped errors are delivered as events; connection-level as status.
        if (typeof frame.session_id === 'string') return this._emitSessionEvent(frame.session_id, frame);
        this.emit('status', { ready: this.wsReady, error: frame.payload?.msg ?? 'daemon error' });
        return;
      }
      default: {
        if (typeof frame.session_id === 'string') this._emitSessionEvent(frame.session_id, frame);
      }
    }
  }

  /** Track cursors, strip the `event.` prefix, emit 'event' and derived 'usage'. */
  _emitSessionEvent(sessionId, frame) {
    if (typeof frame.seq === 'number') {
      const cur = this.subscriptions.get(sessionId);
      if (cur && frame.seq > (cur.seq ?? 0)) {
        cur.seq = frame.seq;
        if (frame.epoch) cur.epoch = frame.epoch;
      }
    }
    const type = String(frame.type ?? '').replace(/^event\./, '');
    const event = { ...frame, type, session_id: sessionId };
    this.emit('event', { sessionId, event });

    // Derived usage signal for the context meter / usage view.
    if (type === 'agent.status.updated' && frame.payload) {
      const p = frame.payload;
      const total = p.usage?.total;
      if (total || typeof p.contextTokens === 'number') {
        this.emit('usage', {
          sessionId,
          usage: {
            input_tokens: total?.inputOther ?? 0,
            output_tokens: total?.output ?? 0,
            cache_read_tokens: total?.inputCacheRead ?? 0,
            cache_creation_tokens: total?.inputCacheCreation ?? 0,
            context_tokens: p.contextTokens ?? 0,
            context_limit: p.maxContextTokens ?? 0,
          },
        });
      }
    } else if (type === 'session.usage_updated' && frame.payload) {
      this.emit('usage', { sessionId, usage: frame.payload });
    }
  }

  /** Subscribe to a session's event stream (survives reconnects). */
  subscribeSession(id) {
    if (!this.subscriptions.has(id)) this.subscriptions.set(id, { seq: 0 });
    if (this.wsReady) this._send({ type: 'subscribe', id: this._nextId(), payload: { session_ids: [id] } });
  }

  unsubscribeSession(id) {
    this.subscriptions.delete(id);
    if (this.wsReady) this._send({ type: 'unsubscribe', id: this._nextId(), payload: { session_ids: [id] } });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  _nextId() { return `c${++this._msgSeq}`; }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts) + Math.floor(Math.random() * 250);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // -------------------------------------------------------------- lifecycle --

  /** Close the WS, ask the daemon to exit, and kill the child process. */
  async shutdown() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.wsReady = false;
    try { await this.request('POST', '/shutdown'); } catch { /* daemon may already be gone */ }
    const child = this.child;
    if (child && !child.killed) {
      try { child.kill(); } catch { /* ignore */ }
      // Give it a moment to exit on its own before force-killing.
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 2000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  }
}

module.exports = { KimiClient, KimiApiError };

// ------------------------------------------------------------ CLI self-test --
// `node main/kimi-client.js` — launch on 59099, PONG round-trip, shutdown.
if (require.main === module) {
  const os = require('node:os');
  const path = require('node:path');

  (async () => {
    console.log('[self-test] launching kimi server on port 59099…');
    const { client } = await KimiClient.launch({ port: 59099 });
    console.log('[self-test] server up:', client.baseUrl);

    client.on('status', (s) => console.log('[self-test] status:', JSON.stringify(s)));
    client.on('usage', ({ usage }) => console.log('[self-test] usage:', JSON.stringify(usage)));
    let deltas = '';
    let turnResult = null;
    client.on('event', ({ event }) => {
      if (event.type === 'assistant.delta') { deltas += event.payload?.delta ?? ''; return; }
      if (event.type === 'thinking.delta' || event.type === 'agent.status.updated' || event.type === 'context.spliced') return;
      const p = event.payload ?? {};
      console.log(`[self-test] event: ${event.type} ${JSON.stringify(p).slice(0, 140)}`);
      if (event.type === 'turn.ended') turnResult = p.reason ?? 'unknown';
    });

    const health = await client.healthz();
    console.log('[self-test] healthz ok:', health?.ok === true);
    const auth = await client.auth();
    console.log('[self-test] auth ready:', auth?.ready, '| default model:', auth?.default_model);

    client.connect();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS ready timeout')), 10000);
      client.once('status', (s) => { if (s.ready) { clearTimeout(t); resolve(); } });
    });

    const cwd = path.join(os.tmpdir(), 'kimi-client-selftest');
    require('node:fs').mkdirSync(cwd, { recursive: true });
    const session = await client.createSession({ cwd });
    console.log('[self-test] session:', session.id, '| model:', session.agent_config?.model);
    client.subscribeSession(session.id);

    const submitted = await client.sendPrompt(session.id, 'Reply with exactly: PONG');
    console.log('[self-test] prompt:', submitted.prompt_id, submitted.status);

    const deadline = Date.now() + 120000;
    while (!turnResult && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    console.log('[self-test] turn result:', turnResult, '| assistant text:', JSON.stringify(deltas));

    const messages = await client.getMessages(session.id);
    console.log('[self-test] messages:', messages.length, 'roles:', messages.map((m) => m.role).join(','));
    const status = await client.getSessionStatus(session.id);
    console.log('[self-test] session status:', JSON.stringify(status));

    await client.shutdown();
    const pass = turnResult === 'completed' && deltas.trim() === 'PONG';
    console.log(pass ? '[self-test] PASS' : '[self-test] FAIL');
    process.exit(pass ? 0 : 1);
  })().catch((err) => {
    console.error('[self-test] ERROR:', err.message);
    process.exit(1);
  });
}
