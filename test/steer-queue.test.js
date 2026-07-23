'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DirectSteerQueue } = require('../main/steer-queue');

test('queued adjustments become ready only after the edit window', () => {
  let now = 1000;
  const queue = new DirectSteerQueue({ editWindowMs: 4000, now: () => now });
  const item = queue.enqueue({ id: 'prompt_1', text: 'Use the compact layout.' });

  assert.equal(item.editableUntil, 5000);
  assert.equal(queue.timeUntilNextReady(), 4000);
  assert.deepEqual(queue.takeReady(), []);

  now = 5000;
  assert.deepEqual(queue.takeReady().map(({ id, text }) => ({ id, text })), [{
    id: 'prompt_1',
    text: 'Use the compact layout.',
  }]);
  assert.equal(queue.size, 0);
});

test('hold, update, resume, and delete preserve queue invariants', () => {
  let now = 10;
  const queue = new DirectSteerQueue({ editWindowMs: 50, now: () => now });
  queue.enqueue({ id: 'prompt_1', text: 'First' });

  assert.equal(queue.hold('prompt_1').held, true);
  now = 1000;
  assert.deepEqual(queue.takeReady(), []);
  assert.equal(queue.timeUntilNextReady(), Infinity);

  const updated = queue.update('prompt_1', 'Revised');
  assert.equal(updated.text, 'Revised');
  assert.equal(updated.held, false);
  assert.equal(updated.editableUntil, 1050);

  assert.equal(queue.hold('prompt_1').held, true);
  now = 1100;
  assert.equal(queue.resume('prompt_1').editableUntil, 1150);
  assert.equal(queue.remove('prompt_1'), true);
  assert.equal(queue.remove('prompt_1'), false);
  assert.equal(queue.size, 0);
});

test('queue changes and turn aborts release waiters', async () => {
  const controller = new AbortController();
  const queue = new DirectSteerQueue({
    signal: controller.signal,
    editWindowMs: 4000,
  });

  const changed = queue.waitForChange(10000);
  queue.enqueue({ id: 'prompt_1', text: 'Wake the worker.' });
  await changed;

  queue.hold('prompt_1');
  const aborted = queue.waitForReady({ heldPollMs: 10000 });
  controller.abort();
  assert.deepEqual(await aborted, []);
});
