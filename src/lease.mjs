import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Popup singleton lease. One popup exists across all workspaces; the file lives
// under the queue root and every mutation runs under queue.withPopupLock.
//
// Dismiss detection (spike P1, herdr 0.7.5): `plugin pane open` returns before the
// popup exits, so the opener cannot learn a dismiss from the open call. The popup
// instead writes a heartbeat and we treat a lease as live only while the heartbeat
// is fresh AND its owning process is still running.

export const OPENING_GRACE_MS = 3_000; // popup boot window before it claims the lease
export const ACTIVE_STALE_MS = 3_000; // max age of a running popup's heartbeat
const LEASE_FILENAME = 'popup-modal.json';
const MAX_LEASE_BYTES = 4_096;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validLease(value) {
  return !!value
    && value.schema_version === 1
    && typeof value.token === 'string'
    && TOKEN_PATTERN.test(value.token)
    && (value.state === 'opening' || value.state === 'active')
    && Number.isInteger(value.owner_pid)
    && value.owner_pid > 0
    && Number.isSafeInteger(value.heartbeat_ms)
    && value.heartbeat_ms >= 0;
}

export function leaseFresh(lease, now) {
  const bound = lease.state === 'opening' ? OPENING_GRACE_MS : ACTIVE_STALE_MS;
  // A future heartbeat (clock skew) yields a negative age and stays within bound.
  return now - lease.heartbeat_ms <= bound;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export function leaseIsAlive(lease, now = Date.now(), isAlive = pidAlive) {
  return validLease(lease) && leaseFresh(lease, now) && isAlive(lease.owner_pid);
}

function leasePath(queue) {
  if (typeof queue?.root !== 'string' || queue.root.length === 0) {
    throw new Error('queue root is required for the popup lease');
  }
  return join(queue.root, LEASE_FILENAME);
}

async function syncDir(queue) {
  let handle;
  try {
    handle = await open(queue.root, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Lock-free read. Corrupt/invalid content is reported as absent so the next
// opener overwrites it; a symlink at the lease path is refused outright.
export async function readLease(queue) {
  const path = leasePath(queue);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new Error('popup lease must be a regular file, not a symlink');
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_LEASE_BYTES) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    return validLease(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle.close();
  }
}

// Lock-free atomic write. Only ever called while holding the popup lock.
async function writeLease(queue, lease) {
  if (!validLease(lease)) throw new Error('refusing to write an invalid popup lease');
  const path = leasePath(queue);
  const temporary = join(queue.root, `.${LEASE_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDir(queue);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function removeLease(queue) {
  await unlink(leasePath(queue)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await syncDir(queue);
}

// Hook side: become the popup opener, or a waiter if a live popup already exists.
export function electOpener(queue, token, now = Date.now(), isAlive = pidAlive) {
  if (!TOKEN_PATTERN.test(token)) throw new Error('opener token must be a UUID v4');
  return queue.withPopupLock(async () => {
    const current = await readLease(queue);
    if (leaseIsAlive(current, now, isAlive)) return { role: 'waiter' };
    await writeLease(queue, {
      schema_version: 1,
      token,
      state: 'opening',
      owner_pid: process.pid,
      heartbeat_ms: now,
    });
    return { role: 'opener' };
  });
}

// Popup side: promote the opener's lease to active under this popup's pid.
export function claimForPopup(queue, token, now = Date.now()) {
  if (!TOKEN_PATTERN.test(token)) return Promise.resolve(false);
  return queue.withPopupLock(async () => {
    const current = await readLease(queue);
    if (!current || current.token !== token) return false;
    await writeLease(queue, {
      schema_version: 1,
      token,
      state: 'active',
      owner_pid: process.pid,
      heartbeat_ms: now,
    });
    return true;
  });
}

// Popup side: advance the heartbeat, but only while this process still owns the token.
export function renewLease(queue, token, now = Date.now()) {
  if (!TOKEN_PATTERN.test(token)) return Promise.resolve(false);
  return queue.withPopupLock(async () => {
    const current = await readLease(queue);
    if (!current || current.token !== token || current.owner_pid !== process.pid) return false;
    await writeLease(queue, { ...current, heartbeat_ms: now });
    return true;
  });
}

export function clearLease(queue, token) {
  return queue.withPopupLock(async () => {
    const current = await readLease(queue);
    if (!current || current.token !== token) return false;
    await removeLease(queue);
    return true;
  });
}

// Hook side: is a popup still live? If not, drop the stale lease so the next
// question can open a fresh popup.
export function checkAliveOrClear(queue, now = Date.now(), isAlive = pidAlive) {
  return queue.withPopupLock(async () => {
    const current = await readLease(queue);
    if (leaseIsAlive(current, now, isAlive)) return true;
    if (current) await removeLease(queue);
    return false;
  });
}
