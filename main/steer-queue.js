'use strict';

/**
 * Shared policy for the short window in which a queued work adjustment can be
 * edited or deleted before the active turn consumes it.
 */
const STEER_EDIT_WINDOW_MS = 4000;

/**
 * In-memory queue used by the built-in engine while one turn is active.
 *
 * The queue owns every timing and wake-up invariant. Backend orchestration only
 * decides what to do with ready records, so hold/resume/update/delete behavior
 * cannot drift between the tool loop and the post-turn continuation path.
 */
class DirectSteerQueue {
  constructor({
    signal = null,
    editWindowMs = STEER_EDIT_WINDOW_MS,
    now = Date.now,
  } = {}) {
    if (!Number.isFinite(editWindowMs) || editWindowMs < 0) {
      throw new TypeError('editWindowMs must be a non-negative number');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    this.signal = signal;
    this.editWindowMs = editWindowMs;
    this.now = now;
    this.items = [];
    this.waiters = new Set();
  }

  get size() {
    return this.items.length;
  }

  enqueue({ id, text }) {
    const createdAt = this.now();
    const item = {
      id,
      text,
      createdAt,
      editableUntil: createdAt + this.editWindowMs,
      held: false,
    };
    this.items.push(item);
    this.wake();
    return item;
  }

  hold(id) {
    const item = this._find(id);
    if (!item) return null;
    item.held = true;
    item.editableUntil = Infinity;
    this.wake();
    return item;
  }

  resume(id) {
    const item = this._find(id);
    if (!item) return null;
    item.held = false;
    item.editableUntil = this.now() + this.editWindowMs;
    this.wake();
    return item;
  }

  update(id, text) {
    const item = this._find(id);
    if (!item) return null;
    item.text = text;
    item.held = false;
    item.editableUntil = this.now() + this.editWindowMs;
    this.wake();
    return item;
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.wake();
    return true;
  }

  clear() {
    this.items = [];
    this.wake();
  }

  /**
   * Remove and return every adjustment whose edit window has elapsed.
   * Held adjustments remain pending until resume/update/delete is called.
   */
  takeReady() {
    const now = this.now();
    const ready = [];
    const waiting = [];
    for (const item of this.items) {
      if (!item.held && item.editableUntil <= now) ready.push(item);
      else waiting.push(item);
    }
    this.items = waiting;
    return ready;
  }

  /** Milliseconds until the next unheld item is ready; Infinity if all are held. */
  timeUntilNextReady() {
    if (!this.items.length) return 0;
    let nextReadyAt = Infinity;
    for (const item of this.items) {
      if (!item.held) nextReadyAt = Math.min(nextReadyAt, item.editableUntil);
    }
    return Number.isFinite(nextReadyAt)
      ? Math.max(0, nextReadyAt - this.now())
      : Infinity;
  }

  /**
   * Wait until queue contents change, the timeout elapses, or the turn aborts.
   * Multiple waiters are supported so a future caller cannot overwrite an
   * existing wake-up callback.
   */
  waitForChange(waitMs) {
    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.signal?.removeEventListener('abort', done);
        this.waiters.delete(done);
        resolve();
      };

      this.waiters.add(done);
      if (Number.isFinite(waitMs)) timer = setTimeout(done, Math.max(0, waitMs));
      if (this.signal?.aborted) done();
      else this.signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Wait for and consume the next ready batch. A bounded poll while every item
   * is held protects against a caller that never resumes an abandoned editor.
   */
  async waitForReady({ heldPollMs = 60000 } = {}) {
    while (this.size && !this.signal?.aborted) {
      const delay = this.timeUntilNextReady();
      if (delay > 0) {
        await this.waitForChange(Number.isFinite(delay) ? delay : heldPollMs);
      }
      const ready = this.takeReady();
      if (ready.length) return ready;
    }
    return [];
  }

  wake() {
    for (const resolve of [...this.waiters]) resolve();
  }

  _find(id) {
    return this.items.find((item) => item.id === id) || null;
  }
}

module.exports = { DirectSteerQueue, STEER_EDIT_WINDOW_MS };
