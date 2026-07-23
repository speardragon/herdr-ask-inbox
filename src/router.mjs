import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

const POPUP_STATE_FILENAME = 'popup-pane.json';
const MAX_POPUP_STATE_BYTES = 4_096;
const MAX_NATIVE_UI_WAIT_MS = 2_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sessionIdOf(agent) {
  const session = agent?.agent_session;
  if (typeof session === 'string') return session;
  return typeof session?.value === 'string' ? session.value : null;
}

function liveAgentFor(request, snapshot) {
  return snapshot.agents.find((agent) => (
    agent?.pane_id === request.source.pane_id
    && agent?.agent === request.source.agent
    && sessionIdOf(agent) === request.source.session_id
  ));
}

async function readPopupPaneId(queue) {
  if (typeof queue?.root !== 'string' || queue.root.length === 0) {
    throw new Error('queue root is required for popup state');
  }
  const path = join(queue.root, POPUP_STATE_FILENAME);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') {
      throw new Error('popup state must be a regular file, not a symlink');
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('popup state must be a regular file, not a symlink');
    if (metadata.size > MAX_POPUP_STATE_BYTES) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    return value?.schema_version === 1
      && typeof value.pane_id === 'string'
      && value.pane_id.length > 0
      && !value.pane_id.includes('\0')
      ? value.pane_id
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle.close();
  }
}

async function writePopupPaneId(queue, paneId) {
  if (typeof paneId !== 'string' || paneId.length === 0 || paneId.includes('\0')) {
    throw new Error('popup pane ID is invalid');
  }
  const path = join(queue.root, POPUP_STATE_FILENAME);
  try {
    const existingHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!(await existingHandle.stat()).isFile()) {
        throw new Error('popup state must be a regular file, not a symlink');
      }
    } finally {
      await existingHandle.close();
    }
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error('popup state must be a regular file, not a symlink');
    }
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = join(queue.root, `.${POPUP_STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      schema_version: 1,
      pane_id: paneId,
      updated_at_ms: Date.now(),
    })}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    let directory;
    try {
      directory = await open(queue.root, 'r');
      await directory.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(error.code)) throw error;
    } finally {
      await directory?.close().catch(() => {});
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function defaultWaitForNativeUi(_request, timeoutMs) {
  await delay(Math.min(100, timeoutMs));
}

export async function handleAgentStatusChanged(context, { queue, herdr }) {
  if (context?.agent_status !== 'blocked') return { status: 'ignored' };
  if (typeof context.pane_id !== 'string' || context.pane_id.length === 0) {
    return { status: 'invalid-context' };
  }
  if (!queue || typeof queue.list !== 'function' || typeof queue.withPopupLock !== 'function') {
    throw new TypeError('router queue is required');
  }
  if (!herdr || typeof herdr.snapshot !== 'function') {
    throw new TypeError('herdr API is required');
  }

  const snapshot = await herdr.snapshot();
  const requests = await queue.list();
  const liveRequests = [];
  for (const request of requests) {
    if (liveAgentFor(request, snapshot)) {
      liveRequests.push(request);
    } else {
      await queue.cancel(request.request_id);
    }
  }

  const matching = liveRequests
    .filter((request) => request.source.pane_id === context.pane_id)
    .sort((left, right) => (
      right.created_at_ms - left.created_at_ms
      || right.request_id.localeCompare(left.request_id)
    ));
  const request = matching[0];
  if (!request) return { status: 'no-live-request' };

  return queue.withPopupLock(async () => {
    // Event processes can race after taking their initial reconciliation
    // snapshot. Refresh only after acquiring the cross-process lock so the
    // second process observes the pane opened by the first.
    const routingSnapshot = await herdr.snapshot();
    if (!liveAgentFor(request, routingSnapshot)) {
      await queue.cancel(request.request_id);
      return { status: 'no-live-request' };
    }
    const recordedPaneId = await readPopupPaneId(queue);
    const recordedPaneIsLive = recordedPaneId
      && routingSnapshot.panes.some((pane) => pane?.pane_id === recordedPaneId);
    if (recordedPaneIsLive) {
      try {
        await herdr.focusPopup(recordedPaneId);
        return {
          status: 'focused',
          request_id: request.request_id,
          pane_id: recordedPaneId,
        };
      } catch {
        // The plugin focus command validates ownership. A stale/reused pane ID is
        // never focused through the generic agent command.
      }
    }

    const paneId = await herdr.openPopup(routingSnapshot.focused_workspace_id);
    await writePopupPaneId(queue, paneId);
    return {
      status: 'opened',
      request_id: request.request_id,
      pane_id: paneId,
    };
  });
}

export async function handoff(request, {
  queue,
  herdr,
  waitForNativeUi = defaultWaitForNativeUi,
  nativeUiTimeoutMs = MAX_NATIVE_UI_WAIT_MS,
}) {
  if (!request?.source?.pane_id || !request?.source?.agent) {
    throw new TypeError('request source is required');
  }
  if (!['hook-response', 'terminal-keys'].includes(request.transport)) {
    throw new TypeError('request transport is unsupported');
  }
  if (!Number.isFinite(nativeUiTimeoutMs) || nativeUiTimeoutMs < 0) {
    throw new TypeError('native UI timeout must be a non-negative number');
  }
  const boundedTimeoutMs = Math.min(nativeUiTimeoutMs, MAX_NATIVE_UI_WAIT_MS);

  if (request.transport === 'hook-response') {
    await queue.respond({
      schema_version: 1,
      request_id: request.request_id,
      action: 'handoff',
      value: null,
      created_at_ms: Date.now(),
    });
    await waitForNativeUi(request, boundedTimeoutMs);
  } else if (typeof queue.cancel === 'function') {
    await queue.cancel(request.request_id);
  }

  await herdr.releaseBlocked(request);
  await herdr.focusAgent(request.source.pane_id);
  return { status: 'handed-off' };
}
