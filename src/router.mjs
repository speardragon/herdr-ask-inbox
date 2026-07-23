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

async function cancelStaleRequest(request, queue) {
  await queue.cancel(request.request_id);
  if (request.transport === 'terminal-keys') {
    await queue.takeResponse(request.request_id);
  }
}

function newestForPane(requests, paneId) {
  return requests
    .filter((request) => request.source.pane_id === paneId)
    .sort((left, right) => (
      right.created_at_ms - left.created_at_ms
      || right.request_id.localeCompare(left.request_id)
    ))[0];
}

async function defaultWaitForNativeUi(request, timeoutMs, { herdr }) {
  const deadline = Date.now() + timeoutMs;
  let previousReadyScreen = null;
  while (true) {
    try {
      const snapshot = await herdr.snapshot();
      const live = liveAgentFor(request, snapshot);
      const screen = await herdr.readPane(request.source.pane_id);
      if (
        live?.agent_status === 'blocked'
        && typeof screen === 'string'
        && screen.length > 0
      ) {
        if (screen === previousReadyScreen) return true;
        previousReadyScreen = screen;
      } else {
        previousReadyScreen = null;
      }
    } catch {
      // Readiness is advisory. Continue until the bounded deadline and always
      // attempt source focus afterward.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
}

async function focusBestEffort(herdr, paneId) {
  try {
    await herdr.focusAgent(paneId);
    return true;
  } catch {
    return false;
  }
}

async function routeFailureToNative(request, {
  queue,
  herdr,
  waitForNativeUi,
  nativeUiTimeoutMs,
}) {
  let result = {
    status: 'handed-off',
    focused: false,
    native_ui_ready: false,
  };
  try {
    result = await handoff(request, {
      queue,
      herdr,
      waitForNativeUi,
      nativeUiTimeoutMs,
    });
  } catch {
    result.focused = await focusBestEffort(herdr, request.source.pane_id);
  }
  try {
    await herdr.notify(
      'Herdr Question returned control',
      `Request ${request.request_id} is available in the native agent UI.`,
    );
  } catch {
    // Notification is advisory and must never keep a native request blocked.
  }
  return {
    status: 'native-handoff',
    request_id: request.request_id,
    focused: result.focused,
  };
}

export async function handleAgentStatusChanged(context, {
  queue,
  herdr,
  waitForNativeUi,
  nativeUiTimeoutMs,
}) {
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

  const requests = await queue.list();
  const tentative = newestForPane(requests, context.pane_id);
  let snapshot;
  try {
    snapshot = await herdr.snapshot();
  } catch (error) {
    if (!tentative) throw error;
    return routeFailureToNative(tentative, {
      queue,
      herdr,
      waitForNativeUi,
      nativeUiTimeoutMs,
    });
  }
  const liveRequests = [];
  try {
    for (const request of requests) {
      if (liveAgentFor(request, snapshot)) {
        liveRequests.push(request);
      } else {
        await cancelStaleRequest(request, queue);
      }
    }
  } catch (error) {
    if (!tentative) throw error;
    return routeFailureToNative(tentative, {
      queue,
      herdr,
      waitForNativeUi,
      nativeUiTimeoutMs,
    });
  }

  const request = newestForPane(liveRequests, context.pane_id);
  if (!request) return { status: 'no-live-request' };

  try {
    return await queue.withPopupLock(async () => {
      // Event processes can race after taking their initial reconciliation
      // snapshot. Refresh only after acquiring the cross-process lock so the
      // second process observes the pane opened by the first.
      const routingSnapshot = await herdr.snapshot();
      if (!liveAgentFor(request, routingSnapshot)) {
        await cancelStaleRequest(request, queue);
        return { status: 'no-live-request' };
      }
      const recordedPaneId = await readPopupPaneId(queue);
      const recordedPaneIsLive = recordedPaneId
        && routingSnapshot.panes.some((pane) => pane?.pane_id === recordedPaneId);
      if (recordedPaneIsLive) {
        // A transient focus error is not positive evidence that the popup pane
        // disappeared. Propagate to native handoff rather than opening another.
        await herdr.focusPopup(recordedPaneId);
        return {
          status: 'focused',
          request_id: request.request_id,
          pane_id: recordedPaneId,
        };
      }

      const paneId = await herdr.openPopup();
      await writePopupPaneId(queue, paneId);
      return {
        status: 'opened',
        request_id: request.request_id,
        pane_id: paneId,
      };
    });
  } catch {
    return routeFailureToNative(request, {
      queue,
      herdr,
      waitForNativeUi,
      nativeUiTimeoutMs,
    });
  }
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
  let nativeUiReady = true;

  if (request.transport === 'hook-response') {
    // Publishing first lets the hook return no decision and retain sole
    // ownership of its finally/release lifecycle.
    await queue.respond({
      schema_version: 1,
      request_id: request.request_id,
      action: 'handoff',
      value: null,
      created_at_ms: Date.now(),
    });
    try {
      const readiness = await waitForNativeUi(request, boundedTimeoutMs, { herdr });
      nativeUiReady = readiness !== false;
    } catch {
      nativeUiReady = false;
    }
  } else {
    await cancelStaleRequest(request, queue);
    try {
      await herdr.releaseBlocked(request);
    } catch {
      // Terminal transport has no hook waiter. A newer lifecycle owner may
      // already have superseded this plugin-owned source; focus still proceeds.
    }
  }

  const focused = await focusBestEffort(herdr, request.source.pane_id);
  return {
    status: 'handed-off',
    focused,
    native_ui_ready: nativeUiReady,
  };
}
