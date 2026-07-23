import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizeRequest, validateResponse } from './schema.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const LOCK_STALE_MS = 30_000;
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);
const TOMBSTONE_MIN_RETENTION_MS = 60 * 60 * 1_000;
const TOMBSTONE_MAX_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TOMBSTONE_MAX_COUNT = 128;

function processIsAbsent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function lockIsStale(owner, lockStat, now = Date.now()) {
  const validOwner = owner
    && Number.isInteger(owner.pid)
    && Number.isSafeInteger(owner.process_started_at_ms)
    && Number.isSafeInteger(owner.acquired_at_ms)
    && typeof owner.nonce === 'string'
    && owner.nonce.length > 0;
  const recordedAt = Number.isSafeInteger(owner?.acquired_at_ms)
    ? owner.acquired_at_ms
    : Number.isSafeInteger(owner?.created_at_ms)
      ? owner.created_at_ms
      : lockStat?.mtimeMs ?? now;
  const age = Math.max(0, now - recordedAt, now - (lockStat?.mtimeMs ?? now));
  if (age <= LOCK_STALE_MS) return false;
  if (!validOwner) return true;

  const reusedCurrentPid = owner.pid === process.pid
    && Math.abs(owner.process_started_at_ms - PROCESS_STARTED_AT_MS) > 1_000;
  return reusedCurrentPid || processIsAbsent(owner.pid);
}

function jsonFilename(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(requestId)) {
    throw new Error('invalid request_id for queue storage');
  }
  return `${requestId}.json`;
}

function exists(path) {
  return access(path).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`queue path must be a real directory, not a symlink: ${path}`);
  }
  await chmod(path, 0o700);
}

async function secureStateFiles(directory) {
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith('.json') || filename.startsWith('.')) continue;
    const path = join(directory, filename);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`queue state must be a regular file, not a symlink: ${path}`);
    }
    await chmod(path, 0o600);
  }
}

function duplicateError(requestId) {
  const error = new Error(`request ${requestId} is already complete`);
  error.code = 'EEXIST';
  return error;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function durableRename(source, target) {
  await rename(source, target);
  await syncDirectory(dirname(source));
  if (dirname(target) !== dirname(source)) await syncDirectory(dirname(target));
}

async function durableUnlink(path) {
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function atomicWriteJson(directory, filename, value, { exclusive = false } = {}) {
  const target = join(directory, filename);
  const temporary = join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);

  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }

  try {
    if (exclusive) {
      await link(temporary, target);
      await syncDirectory(directory);
      await durableUnlink(temporary);
    } else {
      await durableRename(temporary, target);
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

class Queue {
  constructor(root) {
    this.root = root;
    this.requestsDirectory = join(root, 'requests');
    this.responsesDirectory = join(root, 'responses');
    this.requestClaimsDirectory = join(root, 'request-claims');
    this.responseClaimsDirectory = join(root, 'response-claims');
    this.tombstonesDirectory = join(root, 'tombstones');
    this.locksDirectory = join(root, 'locks');
  }

  paths(requestId) {
    const filename = jsonFilename(requestId);
    return {
      filename,
      request: join(this.requestsDirectory, filename),
      response: join(this.responsesDirectory, filename),
      requestClaim: join(this.requestClaimsDirectory, filename),
      responseClaim: join(this.responseClaimsDirectory, filename),
      tombstone: join(this.tombstonesDirectory, filename),
    };
  }

  async withDirectoryLock(lockDirectory, callback, { timeoutMs = 2_000 } = {}) {
    if (typeof callback !== 'function') throw new Error('lock callback is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('timeoutMs must be a non-negative number');

    const ownerPath = join(lockDirectory, 'owner.json');
    const legacyRecoveryDirectory = `${lockDirectory}.recovery`;
    const staleDirectory = `${lockDirectory}.stale`;
    const nonce = randomUUID();
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (Date.now() >= deadline) {
        const timeoutError = new Error('lock acquisition timed out');
        timeoutError.code = 'QUEUE_LOCK_TIMEOUT';
        throw timeoutError;
      }
      if (await exists(legacyRecoveryDirectory)) {
        const legacyQuarantine = `${legacyRecoveryDirectory}.legacy.${process.pid}.${randomUUID()}`;
        await rename(legacyRecoveryDirectory, legacyQuarantine).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await rm(legacyQuarantine, { recursive: true, force: true });
      }
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        try {
          await atomicWriteJson(lockDirectory, 'owner.json', {
            pid: process.pid,
            process_started_at_ms: PROCESS_STARTED_AT_MS,
            acquired_at_ms: Date.now(),
            nonce,
          });
        } catch (error) {
          const failedDirectory = `${lockDirectory}.failed.${process.pid}.${randomUUID()}`;
          await rename(lockDirectory, failedDirectory).catch(() => {});
          await rm(failedDirectory, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        await rm(staleDirectory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;

        const before = await lstat(lockDirectory).catch(() => null);
        if (!before) continue;
        let owner = null;
        try {
          owner = await readJson(ownerPath);
        } catch (readError) {
          if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError;
        }
        const lockStat = await lstat(lockDirectory).catch(() => null);
        if (!lockStat || before.dev !== lockStat.dev || before.ino !== lockStat.ino) continue;

        if (lockStat && lockIsStale(owner, lockStat)) {
          const quarantine = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
          try {
            await rename(lockDirectory, quarantine);
          } catch (renameError) {
            if (renameError.code !== 'ENOENT') throw renameError;
          }
          await rm(quarantine, { recursive: true, force: true });
          continue;
        }

        if (await exists(staleDirectory)) {
          await rm(staleDirectory, { recursive: true, force: true });
        }

        if (Date.now() >= deadline) {
          const timeoutError = new Error('lock acquisition timed out');
          timeoutError.code = 'QUEUE_LOCK_TIMEOUT';
          throw timeoutError;
        }
        await delay(5 + Math.floor(Math.random() * 11));
      }
    }

    try {
      return await callback();
    } finally {
      let owner;
      try {
        owner = await readJson(ownerPath);
      } catch {
        owner = null;
      }
      if (owner?.nonce === nonce) {
        const releasedDirectory = `${lockDirectory}.released.${process.pid}.${nonce}`;
        try {
          await rename(lockDirectory, releasedDirectory);
          await rm(releasedDirectory, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  withRequestLock(requestId, callback, options) {
    return this.withDirectoryLock(join(this.locksDirectory, `request-${requestId}.lock`), callback, options);
  }

  async readTombstone(path) {
    try {
      return await readJson(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeTombstone(paths, state) {
    await atomicWriteJson(this.tombstonesDirectory, paths.filename, {
      schema_version: 1,
      request_id: paths.filename.slice(0, -'.json'.length),
      state,
      updated_at_ms: Date.now(),
    });
  }

  async recoverRequestState(requestId) {
    const paths = this.paths(requestId);
    let tombstone = await this.readTombstone(paths.tombstone);

    if (await exists(paths.responseClaim)) {
      if (tombstone?.state === 'consumed') {
        await durableUnlink(paths.responseClaim).catch(() => {});
      } else if (!(await exists(paths.response))) {
        await durableRename(paths.responseClaim, paths.response);
      } else {
        await durableUnlink(paths.responseClaim).catch(() => {});
      }
    }

    if (await exists(paths.response)) {
      if (!tombstone) {
        await this.writeTombstone(paths, 'responded');
        tombstone = await this.readTombstone(paths.tombstone);
      }
      if (tombstone?.state === 'consumed') await durableUnlink(paths.response).catch(() => {});
      await durableUnlink(paths.request).catch(() => {});
      await durableUnlink(paths.requestClaim).catch(() => {});
      return;
    }

    if (tombstone) {
      await durableUnlink(paths.request).catch(() => {});
      await durableUnlink(paths.requestClaim).catch(() => {});
      return;
    }

    if (await exists(paths.requestClaim)) {
      if (await exists(paths.request)) {
        await durableUnlink(paths.requestClaim);
      } else {
        await durableRename(paths.requestClaim, paths.request);
      }
    }
  }

  async enqueue(value) {
    const request = normalizeRequest(value);
    return this.withRequestLock(request.request_id, async () => {
      await this.recoverRequestState(request.request_id);
      const paths = this.paths(request.request_id);
      if (await exists(paths.tombstone) || await exists(paths.response)) return null;
      if (await exists(paths.request)) return normalizeRequest(await readJson(paths.request));
      await atomicWriteJson(this.requestsDirectory, paths.filename, request, { exclusive: true });
      return request;
    });
  }

  async list() {
    await this.recoverAll();
    const filenames = (await readdir(this.requestsDirectory)).filter((name) => name.endsWith('.json'));
    const requests = await Promise.all(filenames.map(async (filename) => {
      try {
        return normalizeRequest(await readJson(join(this.requestsDirectory, filename)));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }));

    return requests.filter(Boolean).sort((left, right) => (
      left.created_at_ms - right.created_at_ms || left.request_id.localeCompare(right.request_id)
    ));
  }

  async respond(value) {
    const response = validateResponse(value, value?.request_id);
    return this.withRequestLock(response.request_id, async () => {
      await this.recoverRequestState(response.request_id);
      const paths = this.paths(response.request_id);
      if (await exists(paths.tombstone) || await exists(paths.response)) throw duplicateError(response.request_id);
      try {
        await durableRename(paths.request, paths.requestClaim);
      } catch (error) {
        if (error.code === 'ENOENT') throw duplicateError(response.request_id);
        throw error;
      }

      await atomicWriteJson(this.responsesDirectory, paths.filename, response, { exclusive: true });
      await this.writeTombstone(paths, 'responded');
      await durableUnlink(paths.requestClaim).catch(() => {});
      return response;
    });
  }

  async takeResponse(requestId) {
    return this.withRequestLock(requestId, async () => {
      await this.recoverRequestState(requestId);
      const paths = this.paths(requestId);
      const tombstone = await this.readTombstone(paths.tombstone);
      if (tombstone?.state === 'consumed' || !(await exists(paths.response))) return null;

      await durableRename(paths.response, paths.responseClaim);
      const response = validateResponse(await readJson(paths.responseClaim), requestId);
      await this.writeTombstone(paths, 'consumed');
      await durableUnlink(paths.responseClaim).catch(() => {});
      return response;
    });
  }

  async waitForResponse(requestId, { timeoutMs } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error('timeoutMs must be a non-negative number');
    }

    const deadline = Date.now() + timeoutMs;
    while (true) {
      const response = await this.takeResponse(requestId);
      if (response) return response;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await delay(Math.min(25, remaining));
    }
  }

  async cancel(requestId) {
    try {
      await this.respond({
        schema_version: 1,
        request_id: requestId,
        action: 'handoff',
        value: null,
        created_at_ms: Date.now(),
      });
      return true;
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
      throw error;
    }
  }

  withPopupLock(callback, options) {
    return this.withDirectoryLock(join(this.locksDirectory, 'popup.lock'), callback, options);
  }

  async recoverAll() {
    const directories = [
      this.requestsDirectory,
      this.responsesDirectory,
      this.requestClaimsDirectory,
      this.responseClaimsDirectory,
    ];
    const identifiers = new Set();
    for (const directory of directories) {
      for (const filename of await readdir(directory)) {
        if (filename.endsWith('.json') && !filename.startsWith('.')) {
          identifiers.add(filename.slice(0, -'.json'.length));
        }
      }
    }
    for (const requestId of identifiers) {
      await this.withRequestLock(requestId, () => this.recoverRequestState(requestId));
    }
  }

  async gcTombstones(now = Date.now()) {
    const entries = [];
    for (const filename of await readdir(this.tombstonesDirectory)) {
      if (!filename.endsWith('.json') || filename.startsWith('.')) continue;
      const path = join(this.tombstonesDirectory, filename);
      let tombstone;
      try {
        tombstone = await readJson(path);
      } catch {
        continue;
      }
      const requestId = filename.slice(0, -'.json'.length);
      const statePaths = this.paths(requestId);
      const hasRecoverableState = await Promise.all([
        exists(statePaths.request),
        exists(statePaths.response),
        exists(statePaths.requestClaim),
        exists(statePaths.responseClaim),
      ]).then((states) => states.some(Boolean));
      entries.push({
        path,
        hasRecoverableState,
        updatedAt: Number.isSafeInteger(tombstone?.updated_at_ms) ? tombstone.updated_at_ms : Number.POSITIVE_INFINITY,
      });
    }

    entries.sort((left, right) => right.updatedAt - left.updatedAt || left.path.localeCompare(right.path));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.hasRecoverableState) continue;
      const age = Math.max(0, now - entry.updatedAt);
      const expired = age > TOMBSTONE_MAX_RETENTION_MS;
      const overLimitAndRetrySafe = index >= TOMBSTONE_MAX_COUNT && age > TOMBSTONE_MIN_RETENTION_MS;
      if (expired || overLimitAndRetrySafe) await durableUnlink(entry.path).catch(() => {});
    }
  }
}

export async function openQueue(root) {
  const queue = new Queue(root);
  await secureDirectory(root);
  await Promise.all([
    secureDirectory(queue.requestsDirectory),
    secureDirectory(queue.responsesDirectory),
    secureDirectory(queue.requestClaimsDirectory),
    secureDirectory(queue.responseClaimsDirectory),
    secureDirectory(queue.tombstonesDirectory),
    secureDirectory(queue.locksDirectory),
  ]);
  await Promise.all([
    secureStateFiles(queue.requestsDirectory),
    secureStateFiles(queue.responsesDirectory),
    secureStateFiles(queue.requestClaimsDirectory),
    secureStateFiles(queue.responseClaimsDirectory),
    secureStateFiles(queue.tombstonesDirectory),
  ]);
  await queue.gcTombstones();
  await queue.recoverAll();
  return queue;
}
