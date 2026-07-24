import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from '../src/queue.mjs';
import {
  ACTIVE_STALE_MS,
  OPENING_GRACE_MS,
  leaseFresh,
  leaseIsAlive,
  pidAlive,
  electOpener,
  claimForPopup,
  renewLease,
  clearLease,
  readLease,
  checkAliveOrClear,
} from '../src/lease.mjs';

const DEAD_PID = 2 ** 22; // implausibly high pid, ~certainly not running
const alwaysAlive = () => true;
const neverAlive = () => false;

async function tempQueue() {
  const root = await mkdtemp(join(tmpdir(), 'hq-lease-'));
  const queue = await openQueue(root);
  return { queue, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function lease(overrides = {}) {
  return {
    schema_version: 1,
    token: '11111111-1111-4111-8111-111111111111',
    state: 'active',
    owner_pid: process.pid,
    heartbeat_ms: 1_000,
    ...overrides,
  };
}

test('leaseFresh: active within stale window is fresh', () => {
  assert.equal(leaseFresh(lease({ state: 'active', heartbeat_ms: 1_000 }), 1_000 + ACTIVE_STALE_MS), true);
  assert.equal(leaseFresh(lease({ state: 'active', heartbeat_ms: 1_000 }), 1_000 + ACTIVE_STALE_MS + 1), false);
});

test('leaseFresh: opening uses the longer boot-grace window', () => {
  assert.ok(OPENING_GRACE_MS >= ACTIVE_STALE_MS - 1); // opening grace is at least as forgiving
  assert.equal(leaseFresh(lease({ state: 'opening', heartbeat_ms: 1_000 }), 1_000 + OPENING_GRACE_MS), true);
  assert.equal(leaseFresh(lease({ state: 'opening', heartbeat_ms: 1_000 }), 1_000 + OPENING_GRACE_MS + 1), false);
});

test('leaseFresh: a future heartbeat (clock skew) is not treated as fresh-forever', () => {
  // now before heartbeat → negative age → still bounded, treated as fresh (not stale)
  assert.equal(leaseFresh(lease({ heartbeat_ms: 5_000 }), 1_000), true);
});

test('pidAlive: current process alive, absurd pid dead', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(DEAD_PID), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
});

test('leaseIsAlive: fresh + owner alive', () => {
  assert.equal(leaseIsAlive(lease({ heartbeat_ms: 1_000 }), 1_500, alwaysAlive), true);
});

test('leaseIsAlive: fresh but owner dead → not alive', () => {
  assert.equal(leaseIsAlive(lease({ heartbeat_ms: 1_000 }), 1_500, neverAlive), false);
});

test('leaseIsAlive: owner alive but stale heartbeat → not alive', () => {
  assert.equal(leaseIsAlive(lease({ heartbeat_ms: 1_000 }), 1_000 + ACTIVE_STALE_MS + 5, alwaysAlive), false);
});

test('leaseIsAlive: invalid lease → not alive', () => {
  assert.equal(leaseIsAlive(null, 1_000, alwaysAlive), false);
  assert.equal(leaseIsAlive({ token: 'x' }, 1_000, alwaysAlive), false);
});

test('electOpener: first caller becomes opener, writes opening lease', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const token = '22222222-2222-4222-8222-222222222222';
    const result = await electOpener(queue, token, 10_000);
    assert.equal(result.role, 'opener');
    const stored = await readLease(queue);
    assert.equal(stored.token, token);
    assert.equal(stored.state, 'opening');
    assert.equal(stored.owner_pid, process.pid);
    assert.equal(stored.heartbeat_ms, 10_000);
  } finally {
    await cleanup();
  }
});

test('electOpener: second caller becomes waiter while a live lease exists', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const first = await electOpener(queue, '33333333-3333-4333-8333-333333333333', 10_000);
    assert.equal(first.role, 'opener');
    // a moment later, still within grace → waiter
    const second = await electOpener(queue, '44444444-4444-4444-8444-444444444444', 10_500);
    assert.equal(second.role, 'waiter');
    // lease unchanged (first opener still owns)
    const stored = await readLease(queue);
    assert.equal(stored.token, '33333333-3333-4333-8333-333333333333');
  } finally {
    await cleanup();
  }
});

test('electOpener: takes over when the existing lease is stale', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    await electOpener(queue, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10_000);
    // far in the future → previous opening lease is stale → new caller becomes opener
    const later = await electOpener(queue, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 10_000 + OPENING_GRACE_MS + 5_000);
    assert.equal(later.role, 'opener');
    const stored = await readLease(queue);
    assert.equal(stored.token, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  } finally {
    await cleanup();
  }
});

test('claimForPopup: promotes matching opening lease to active with popup pid', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await electOpener(queue, token, 10_000);
    const claimed = await claimForPopup(queue, token, 10_100);
    assert.equal(claimed, true);
    const stored = await readLease(queue);
    assert.equal(stored.state, 'active');
    assert.equal(stored.owner_pid, process.pid);
    assert.equal(stored.heartbeat_ms, 10_100);
  } finally {
    await cleanup();
  }
});

test('claimForPopup: refuses when token does not match current lease', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    await electOpener(queue, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 10_000);
    const claimed = await claimForPopup(queue, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 10_100);
    assert.equal(claimed, false);
  } finally {
    await cleanup();
  }
});

test('renewLease: advances heartbeat only for the owning token+pid', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const token = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await electOpener(queue, token, 10_000);
    await claimForPopup(queue, token, 10_100);
    await renewLease(queue, token, 10_900);
    assert.equal((await readLease(queue)).heartbeat_ms, 10_900);
    // wrong token → no change
    await renewLease(queue, '00000000-0000-4000-8000-000000000000', 11_500);
    assert.equal((await readLease(queue)).heartbeat_ms, 10_900);
  } finally {
    await cleanup();
  }
});

test('clearLease: removes only the matching token', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const token = '12121212-1212-4121-8121-121212121212';
    await electOpener(queue, token, 10_000);
    assert.equal(await clearLease(queue, 'nope-nope'), false);
    assert.notEqual(await readLease(queue), null);
    assert.equal(await clearLease(queue, token), true);
    assert.equal(await readLease(queue), null);
  } finally {
    await cleanup();
  }
});

test('checkAliveOrClear: clears a stale lease and reports not-alive', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const token = '34343434-3434-4343-8343-343434343434';
    await electOpener(queue, token, 10_000);
    // far future → stale → cleared
    const alive = await checkAliveOrClear(queue, 10_000 + OPENING_GRACE_MS + 9_999, alwaysAlive);
    assert.equal(alive, false);
    assert.equal(await readLease(queue), null);
  } finally {
    await cleanup();
  }
});

test('checkAliveOrClear: keeps a fresh, owner-alive lease', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const token = '56565656-5656-4565-8565-565656565656';
    await electOpener(queue, token, 10_000);
    await claimForPopup(queue, token, 10_100);
    const alive = await checkAliveOrClear(queue, 10_200, alwaysAlive);
    assert.equal(alive, true);
    assert.notEqual(await readLease(queue), null);
  } finally {
    await cleanup();
  }
});
