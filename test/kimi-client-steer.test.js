'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { KimiClient } = require('../main/kimi-client');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('CLI steer remains editable while held, then promotes after resume', async (t) => {
  const client = new KimiClient({ baseUrl: 'http://127.0.0.1:1', token: 'test-token' });
  t.after(() => {
    for (const record of client.pendingSteers.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    client.pendingSteers.clear();
  });

  client.steerEditWindowMs = 20;
  client.sendPrompt = async () => ({ prompt_id: 'prompt_1', status: 'queued' });

  const promoted = [];
  client.request = async (method, requestPath, body) => {
    promoted.push({ method, requestPath, body });
    return { ok: true };
  };

  const events = [];
  client.on('event', ({ event }) => events.push(event.type));

  const submitted = await client.steer('session_1', 'Prefer the smaller diff.');
  assert.equal(submitted.prompt_id, 'prompt_1');
  assert.equal(client.holdSteer('session_1', 'prompt_1').status, 'held');

  await wait(40);
  assert.equal(promoted.length, 0);

  assert.equal(client.resumeSteer('session_1', 'prompt_1').status, 'queued');
  await wait(60);

  assert.equal(promoted.length, 1);
  assert.deepEqual(promoted[0], {
    method: 'POST',
    requestPath: '/sessions/session_1/prompts:steer',
    body: { prompt_ids: ['prompt_1'] },
  });
  assert.deepEqual(events, ['prompt.steer_sending', 'prompt.steered']);
  assert.equal(client.pendingSteers.size, 0);
});

test('CLI steer update replaces first, then aborts the original prompt', async (t) => {
  const client = new KimiClient({ baseUrl: 'http://127.0.0.1:1', token: 'test-token' });
  t.after(() => {
    for (const record of client.pendingSteers.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    client.pendingSteers.clear();
  });
  client.steerEditWindowMs = 10000;

  let nextPrompt = 0;
  client.sendPrompt = async () => ({
    prompt_id: `prompt_${++nextPrompt}`,
    status: 'queued',
  });
  const aborted = [];
  client.abortPrompt = async (_sessionId, promptId) => {
    aborted.push(promptId);
    return { ok: true };
  };

  await client.steer('session_1', 'Original');
  client.holdSteer('session_1', 'prompt_1');
  const replacement = await client.updateSteer('session_1', 'prompt_1', 'Revised');

  assert.equal(replacement.prompt_id, 'prompt_2');
  assert.equal(replacement.replaced_prompt_id, 'prompt_1');
  assert.deepEqual(aborted, ['prompt_1']);
  assert.equal(client.pendingSteers.has(client._steerKey('session_1', 'prompt_1')), false);
  assert.equal(client.pendingSteers.has(client._steerKey('session_1', 'prompt_2')), true);
});
