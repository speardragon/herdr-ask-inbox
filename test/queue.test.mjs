import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from '../src/queue.mjs';

function request(id, createdAtMs, overrides = {}) {
  return {
    schema_version: 1,
    request_id: id,
    created_at_ms: createdAtMs,
    source: { agent: 'claude', pane_id: 'w1:p1', session_id: 's1' },
    kind: 'question',
    transport: 'hook-response',
    status: 'waiting',
    ...overrides,
  };
}

async function withQueue(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openQueue(root);
}

test('enqueue is idempotent and list is FIFO with a stable ID tie-breaker', async (t) => {
  const queue = await withQueue(t);
  await queue.enqueue(request('c', 20));
  await queue.enqueue(request('b', 10));
  await queue.enqueue(request('a', 10));
  await queue.enqueue(request('a', 10));

  assert.deepEqual((await queue.list()).map((entry) => entry.request_id), ['a', 'b', 'c']);
});

test('response publication is one-shot', async (t) => {
  const queue = await withQueue(t);
  await queue.enqueue(request('a', 10));
  await queue.respond({
    schema_version: 1,
    request_id: 'a',
    action: 'handoff',
    value: null,
    created_at_ms: 11,
  });

  assert.equal((await queue.takeResponse('a')).action, 'handoff');
  assert.equal(await queue.takeResponse('a'), null);
});

test('competing response publications accept exactly one decision', async (t) => {
  const queue = await withQueue(t);
  await queue.enqueue(request('a', 10));
  const base = { schema_version: 1, request_id: 'a', value: null, created_at_ms: 11 };

  const results = await Promise.allSettled([
    queue.respond({ ...base, action: 'deny' }),
    queue.respond({ ...base, action: 'handoff' }),
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.match((await queue.takeResponse('a')).action, /^(deny|handoff)$/);
});

test('waitForResponse returns a published response and times out without one', async (t) => {
  const queue = await withQueue(t);
  await queue.enqueue(request('a', 10));
  const publication = setTimeout(() => {
    void queue.respond({
      schema_version: 1,
      request_id: 'a',
      action: 'deny',
      value: null,
      created_at_ms: 11,
    });
  }, 20);
  t.after(() => clearTimeout(publication));

  assert.equal((await queue.waitForResponse('a', { timeoutMs: 500 })).action, 'deny');
  assert.equal(await queue.waitForResponse('missing', { timeoutMs: 30 }), null);
});

test('cancel removes a pending request and releases waiters with handoff', async (t) => {
  const queue = await withQueue(t);
  await queue.enqueue(request('a', 10));

  assert.equal(await queue.cancel('a'), true);
  assert.deepEqual(await queue.list(), []);
  assert.equal((await queue.waitForResponse('a', { timeoutMs: 100 })).action, 'handoff');
  assert.equal(await queue.cancel('missing'), false);
});

test('withPopupLock serializes competing popup work and releases afterward', async (t) => {
  const queue = await withQueue(t);
  let active = 0;
  let maximumActive = 0;
  const completed = [];

  async function work(name) {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    completed.push(name);
  }

  await Promise.all([
    queue.withPopupLock(() => work('first')),
    queue.withPopupLock(() => work('second')),
  ]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(completed.sort(), ['first', 'second']);
  assert.equal(await queue.withPopupLock(async () => 'released'), 'released');
});
