import { randomUUID } from 'node:crypto';
import { access, link, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeRequest, validateResponse } from './schema.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const POPUP_LOCK_STALE_MS = 30_000;

function processIsAbsent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function jsonFilename(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(requestId)) {
    throw new Error('invalid request_id for queue storage');
  }
  return `${requestId}.json`;
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
      await unlink(temporary);
    } else {
      await rename(temporary, target);
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
    this.locksDirectory = join(root, 'locks');
  }

  async enqueue(value) {
    const request = normalizeRequest(value);
    const filename = jsonFilename(request.request_id);
    const target = join(this.requestsDirectory, filename);

    try {
      await access(target);
      return request;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await atomicWriteJson(this.requestsDirectory, filename, request);
    return request;
  }

  async respond(value) {
    const filename = jsonFilename(value?.request_id);
    const requestPath = join(this.requestsDirectory, filename);
    await access(requestPath);
    const response = validateResponse(value, value.request_id);
    await atomicWriteJson(this.responsesDirectory, filename, response, { exclusive: true });
    await unlink(requestPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return response;
  }

  async takeResponse(requestId) {
    const filename = jsonFilename(requestId);
    const target = join(this.responsesDirectory, filename);
    const claimed = join(this.responsesDirectory, `.${filename}.${process.pid}.${randomUUID()}.claimed`);

    try {
      await rename(target, claimed);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    try {
      const response = JSON.parse(await readFile(claimed, 'utf8'));
      return validateResponse(response, requestId);
    } finally {
      await unlink(claimed).catch(() => {});
    }
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
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async withPopupLock(callback, { timeoutMs = 2_000 } = {}) {
    if (typeof callback !== 'function') throw new Error('popup lock callback is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('timeoutMs must be a non-negative number');

    const lockDirectory = join(this.locksDirectory, 'popup.lock');
    const ownerPath = join(lockDirectory, 'owner.json');
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        try {
          await atomicWriteJson(lockDirectory, 'owner.json', {
            pid: process.pid,
            created_at_ms: Date.now(),
            token,
          });
        } catch (error) {
          await rmdir(lockDirectory).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;

        let owner;
        try {
          owner = JSON.parse(await readFile(ownerPath, 'utf8'));
        } catch (readError) {
          if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError;
          const lockStat = await stat(lockDirectory).catch(() => null);
          owner = { pid: null, created_at_ms: lockStat?.mtimeMs ?? Date.now() };
        }

        const stale = Date.now() - owner.created_at_ms > POPUP_LOCK_STALE_MS;
        if (stale && processIsAbsent(owner.pid)) {
          await unlink(ownerPath).catch(() => {});
          await rmdir(lockDirectory).catch(() => {});
          continue;
        }

        if (Date.now() >= deadline) {
          const timeoutError = new Error('popup lock acquisition timed out');
          timeoutError.code = 'POPUP_LOCK_TIMEOUT';
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
        owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      } catch {
        owner = null;
      }
      if (owner?.token === token) {
        await unlink(ownerPath).catch(() => {});
        await rmdir(lockDirectory).catch(() => {});
      }
    }
  }

  async list() {
    const filenames = (await readdir(this.requestsDirectory)).filter((name) => name.endsWith('.json'));
    const requests = await Promise.all(filenames.map(async (filename) => {
      try {
        const contents = await readFile(join(this.requestsDirectory, filename), 'utf8');
        return normalizeRequest(JSON.parse(contents));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }));

    return requests.filter(Boolean).sort((left, right) => (
      left.created_at_ms - right.created_at_ms || left.request_id.localeCompare(right.request_id)
    ));
  }
}

export async function openQueue(root) {
  const queue = new Queue(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(queue.requestsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(queue.responsesDirectory, { recursive: true, mode: 0o700 }),
    mkdir(queue.locksDirectory, { recursive: true, mode: 0o700 }),
  ]);
  return queue;
}
