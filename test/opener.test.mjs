import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from '../src/queue.mjs';
import { readLease, electOpener } from '../src/lease.mjs';
import { ensurePopup, waitForOutcome } from '../src/opener.mjs';

const alwaysAlive = () => true;
const neverAlive = () => false;
const immediateDelay = () => Promise.resolve();

async function tempQueue() {
  const root = await mkdtemp(join(tmpdir(), 'hq-opener-'));
  const queue = await openQueue(root);
  return { queue, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function questionRequest(id = 'req-open-1') {
  return {
    schema_version: 1,
    request_id: id,
    created_at_ms: 1_000,
    source: { agent: 'claude', pane_id: 'w1:p1', workspace_id: 'w1', session_id: 's1' },
    kind: 'question',
    transport: 'hook-response',
    status: 'waiting',
    questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }],
  };
}

function answer(id, value = { answers: { 'Q?': 'A' } }) {
  return { schema_version: 1, request_id: id, action: 'answer', value, created_at_ms: 2_000 };
}

test('ensurePopup: opener opens the popup and reports opened', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const opened = [];
    const herdr = { openPopup: async (token) => opened.push(token) };
    const result = await ensurePopup(queue, herdr, { isAlive: alwaysAlive });
    assert.equal(result.role, 'opener');
    assert.equal(result.opened, true);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], result.token);
    assert.equal((await readLease(queue)).token, result.token); // lease left in place
  } finally {
    await cleanup();
  }
});

test('ensurePopup: a waiter does not open when a live lease already exists', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    await electOpener(queue, '99999999-9999-4999-8999-999999999999', Date.now(), alwaysAlive);
    let openCalls = 0;
    const herdr = { openPopup: async () => { openCalls += 1; } };
    const result = await ensurePopup(queue, herdr, { isAlive: alwaysAlive });
    assert.equal(result.role, 'waiter');
    assert.equal(result.opened, false);
    assert.equal(openCalls, 0);
  } finally {
    await cleanup();
  }
});

test('ensurePopup: opener clears its lease when open is refused', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const herdr = { openPopup: async () => { throw new Error('plugin_disabled'); } };
    const result = await ensurePopup(queue, herdr, { isAlive: alwaysAlive });
    assert.equal(result.role, 'opener');
    assert.equal(result.opened, false);
    assert.equal(await readLease(queue), null); // lease dropped → waiters fail open
  } finally {
    await cleanup();
  }
});

test('waitForOutcome: returns answer when the popup responds', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const request = questionRequest();
    await queue.enqueue(request);
    await queue.respond(answer(request.request_id));
    const outcome = await waitForOutcome(queue, request, { isAlive: alwaysAlive, delay: immediateDelay });
    assert.equal(outcome.status, 'answer');
    assert.deepEqual(outcome.response.value, { answers: { 'Q?': 'A' } });
  } finally {
    await cleanup();
  }
});

test('waitForOutcome: returns handoff when the popup hands off', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const request = questionRequest('req-ho');
    await queue.enqueue(request);
    await queue.cancel(request.request_id); // cancel writes a handoff response
    const outcome = await waitForOutcome(queue, request, { isAlive: alwaysAlive, delay: immediateDelay });
    assert.equal(outcome.status, 'handoff');
  } finally {
    await cleanup();
  }
});

test('waitForOutcome: fails open when no popup is alive', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const request = questionRequest('req-fo');
    await queue.enqueue(request);
    // no lease at all → not alive → fail open
    const outcome = await waitForOutcome(queue, request, { isAlive: neverAlive, delay: immediateDelay });
    assert.equal(outcome.status, 'fail-open');
    // request is closed out (consumed) so nothing leaks
    assert.equal(await queue.takeResponse(request.request_id), null);
  } finally {
    await cleanup();
  }
});

test('waitForOutcome: fails open when the popup owner pid is dead', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const request = questionRequest('req-dead');
    await queue.enqueue(request);
    // an active lease owned by an absurd (dead) pid → real pidAlive says dead → fail open
    await electOpener(queue, '77777777-7777-4777-8777-777777777777', Date.now(), () => false);
    const outcome = await waitForOutcome(queue, request, { delay: immediateDelay });
    assert.equal(outcome.status, 'fail-open');
  } finally {
    await cleanup();
  }
});

test('waitForOutcome: answer that lands during the alive window is returned', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const request = questionRequest('req-race');
    await queue.enqueue(request);
    await electOpener(queue, '88888888-8888-4888-8888-888888888888', Date.now(), alwaysAlive); // live popup
    let ticks = 0;
    // stay "alive" for a couple polls, then the answer appears
    const delay = async () => {
      ticks += 1;
      if (ticks === 2) await queue.respond(answer(request.request_id, { answers: { 'Q?': 'B' } }));
    };
    const outcome = await waitForOutcome(queue, request, { isAlive: alwaysAlive, delay });
    assert.equal(outcome.status, 'answer');
    assert.deepEqual(outcome.response.value, { answers: { 'Q?': 'B' } });
  } finally {
    await cleanup();
  }
});

test('waitForOutcome: aborts on signal and closes the request', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const request = questionRequest('req-abort');
    await queue.enqueue(request);
    const controller = new AbortController();
    controller.abort();
    const outcome = await waitForOutcome(queue, request, {
      isAlive: alwaysAlive,
      delay: immediateDelay,
      signal: controller.signal,
    });
    assert.equal(outcome.status, 'interrupted');
    assert.equal(await queue.takeResponse(request.request_id), null);
  } finally {
    await cleanup();
  }
});

test('waitForOutcome: times out past the deadline and closes the request', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const request = questionRequest('req-timeout');
    await queue.enqueue(request);
    const outcome = await waitForOutcome(queue, request, {
      isAlive: alwaysAlive,
      delay: immediateDelay,
      now: () => 5_000,
      deadlineMs: 4_000, // already past
    });
    assert.equal(outcome.status, 'timeout');
  } finally {
    await cleanup();
  }
});
