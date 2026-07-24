import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from '../src/queue.mjs';

function request(id, createdAtMs, overrides = {}) {
  return {
    schema_version: 1,
    request_id: id,
    created_at_ms: createdAtMs,
    source: { agent: 'claude', pane_id: 'w1:p1', workspace_id: 'w1', session_id: 's1' },
    kind: 'question',
    transport: 'hook-response',
    status: 'waiting',
    ...overrides,
  };
}

async function withQueue(t) {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openQueue(root);
}

async function seedJson(root, directory, id, value) {
  const target = join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, `${id}.json`), `${JSON.stringify(value)}\n`);
}

test('enqueue is idempotent and list is FIFO with a stable ID tie-breaker', async (t) => {
  const queue = await withQueue(t);
  await queue.enqueue(request('c', 20));
  await queue.enqueue(request('b', 10));
  await queue.enqueue(request('a', 10));
  await queue.enqueue(request('a', 10));

  assert.deepEqual((await queue.list()).map((entry) => entry.request_id), ['a', 'b', 'c']);
});

test('same-ID concurrent enqueues preserve one complete first payload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [leftQueue, rightQueue] = await Promise.all([openQueue(root), openQueue(root)]);
  const left = request('same', 10, { title: 'short' });
  const right = request('same', 10, { title: 'x'.repeat(64_000) });

  const [leftResult, rightResult] = await Promise.all([
    leftQueue.enqueue(left),
    rightQueue.enqueue(right),
  ]);
  const [stored] = await leftQueue.list();

  assert.deepEqual(leftResult, rightResult);
  assert.deepEqual(stored, leftResult);
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

test('a consumed response remains complete during publisher races and duplicate hooks', async (t) => {
  const queue = await withQueue(t);
  await queue.enqueue(request('a', 10));
  const base = { schema_version: 1, request_id: 'a', value: null, created_at_ms: 11 };

  const consumer = queue.waitForResponse('a', { timeoutMs: 1_000 });
  const publications = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => (
    queue.respond({ ...base, action: index % 2 === 0 ? 'deny' : 'handoff' })
  )));
  assert.match((await consumer).action, /^(deny|handoff)$/);
  assert.equal(publications.filter(({ status }) => status === 'fulfilled').length, 1);

  await queue.enqueue(request('a', 10, { title: 'duplicate hook must stay completed' }));
  assert.deepEqual(await queue.list(), []);
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

test('concurrent stale-lock recoverers never remove a new popup owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-stale-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedJson(root, 'locks/popup.lock', 'owner', {
    pid: 999_999_999,
    created_at_ms: 0,
    token: 'stale-owner',
  });
  const queue = await openQueue(root);
  let active = 0;
  let maximumActive = 0;

  await Promise.all(Array.from({ length: 20 }, () => queue.withPopupLock(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, { timeoutMs: 5_000 })));

  assert.equal(maximumActive, 1);
});

test('stale lock recovery handles current-PID fingerprints, corrupt owners, and future timestamps', async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

  async function recover(ownerContents, { oldDirectory = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'ask-inbox-owner-'));
    roots.push(root);
    const lockDirectory = join(root, 'locks', 'popup.lock');
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(join(lockDirectory, 'owner.json'), ownerContents);
    if (oldDirectory) await utimes(lockDirectory, new Date(0), new Date(0));
    const queue = await openQueue(root);
    return queue.withPopupLock(async () => 'recovered', { timeoutMs: 2_000 });
  }

  assert.equal(await recover(JSON.stringify({
    pid: process.pid,
    process_started_at_ms: 0,
    acquired_at_ms: 0,
    nonce: 'previous-process',
  })), 'recovered');
  assert.equal(await recover('{broken-json', { oldDirectory: true }), 'recovered');
  assert.equal(await recover(JSON.stringify({
    pid: 999_999_999,
    process_started_at_ms: Date.now() + 60_000,
    acquired_at_ms: Date.now() + 60_000,
    nonce: 'future-clock',
  }), { oldDirectory: true }), 'recovered');
});

test('an abandoned legacy recovery guard cannot block concurrent popup recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-recovery-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedJson(root, 'locks/popup.lock', 'owner', {
    pid: 999_999_999,
    created_at_ms: 0,
    token: 'stale-owner',
  });
  await seedJson(root, 'locks/popup.lock.recovery', 'owner', {
    pid: 999_999_999,
    acquired_at_ms: 0,
    nonce: 'abandoned-recovery',
  });
  const queue = await openQueue(root);
  let active = 0;
  let maximumActive = 0;

  await Promise.all(Array.from({ length: 8 }, () => queue.withPopupLock(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, { timeoutMs: 2_000 })));
  assert.equal(maximumActive, 1);
});

test('leftover stale quarantine cannot create an unbounded recovery loop', { timeout: 750 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-stale-quarantine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staleOwner = {
    pid: 999_999_999,
    created_at_ms: 0,
    token: 'stale-owner',
  };
  await seedJson(root, 'locks/popup.lock', 'owner', staleOwner);
  await seedJson(root, 'locks/popup.lock.stale', 'owner', staleOwner);
  const queue = await openQueue(root);

  assert.equal(
    await queue.withPopupLock(async () => 'recovered', { timeoutMs: 500 }),
    'recovered',
  );
});

test('owner publication survives concurrent stale recovery pressure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-owner-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staleOwner = { pid: 999_999_999, created_at_ms: 0, token: 'stale-owner' };
  await seedJson(root, 'locks/popup.lock', 'owner', staleOwner);
  await seedJson(root, 'locks/popup.lock.stale', 'owner', staleOwner);
  const queue = await openQueue(root);
  let active = 0;
  let maximumActive = 0;
  let completed = 0;

  await Promise.all(Array.from({ length: 64 }, () => queue.withPopupLock(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed += 1;
    active -= 1;
  }, { timeoutMs: 5_000 })));

  assert.equal(completed, 64);
  assert.equal(maximumActive, 1);
});

test('startup recovers abandoned request and response claims without reviving completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-fault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const response = (id) => ({
    schema_version: 1,
    request_id: id,
    action: 'handoff',
    value: null,
    created_at_ms: 20,
  });
  await seedJson(root, 'request-claims', 'a', request('a', 10));
  await seedJson(root, 'requests', 'b', request('b', 11));
  await seedJson(root, 'responses', 'b', response('b'));
  await seedJson(root, 'response-claims', 'c', response('c'));
  await seedJson(root, 'tombstones', 'c', {
    schema_version: 1,
    request_id: 'c',
    state: 'responded',
    updated_at_ms: 21,
  });
  await seedJson(root, 'response-claims', 'd', response('d'));
  await seedJson(root, 'tombstones', 'd', {
    schema_version: 1,
    request_id: 'd',
    state: 'consumed',
    updated_at_ms: 21,
  });

  const queue = await openQueue(root);
  assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), ['a']);
  assert.equal((await queue.takeResponse('b')).request_id, 'b');
  assert.equal((await queue.takeResponse('c')).request_id, 'c');
  assert.equal(await queue.takeResponse('d'), null);
  await queue.enqueue(request('b', 11));
  assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), ['a']);
});

test('queue storage rejects symlink directories and enforces private modes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-modes-'));
  const outside = await mkdtemp(join(tmpdir(), 'ask-inbox-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await symlink(outside, join(root, 'requests'));
  await assert.rejects(() => openQueue(root), /symlink|directory/);

  await rm(join(root, 'requests'));
  await seedJson(root, 'requests', 'preexisting', request('preexisting', 9));
  const queue = await openQueue(root);
  await queue.enqueue(request('private', 10));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, 'requests'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'requests', 'preexisting.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'requests', 'private.json'))).mode & 0o777, 0o600);
});

test('tombstone-only IDs do not acquire per-request recovery locks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-tombstone-skip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedJson(root, 'tombstones', 'complete', {
    schema_version: 1,
    request_id: 'complete',
    state: 'consumed',
    updated_at_ms: Date.now(),
  });
  await seedJson(root, 'locks/request-complete.lock', 'owner', {
    pid: process.pid,
    process_started_at_ms: Date.now(),
    acquired_at_ms: Date.now(),
    nonce: 'active-unrelated-lock',
  });

  const queue = await openQueue(root);
  assert.deepEqual(await queue.list(), []);
});

test('tombstone GC bounds old entries while retaining recent duplicate protection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-tombstone-gc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1_000;
  for (let index = 0; index < 140; index += 1) {
    const id = `old-${String(index).padStart(3, '0')}`;
    await seedJson(root, 'tombstones', id, {
      schema_version: 1,
      request_id: id,
      state: 'consumed',
      updated_at_ms: twoHoursAgo - index,
    });
  }
  await seedJson(root, 'tombstones', 'recent', {
    schema_version: 1,
    request_id: 'recent',
    state: 'consumed',
    updated_at_ms: Date.now(),
  });

  const queue = await openQueue(root);
  assert.equal((await readdir(join(root, 'tombstones'))).filter((name) => name.endsWith('.json')).length <= 128, true);
  await queue.enqueue(request('recent', Date.now()));
  assert.deepEqual(await queue.list(), []);
});
