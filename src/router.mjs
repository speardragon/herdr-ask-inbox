import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

const POPUP_MODAL_FILENAME = 'popup-modal.json';
const MAX_POPUP_MODAL_BYTES = 4_096;
const MODAL_LEASE_STALE_MS = 30_000;
const MAX_NATIVE_UI_WAIT_MS = 2_000;
const POPUP_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function processIsAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function validModalLease(value) {
  return value?.schema_version === 1
    && POPUP_TOKEN_PATTERN.test(value.token)
    && ['opening', 'active'].includes(value.state)
    && Number.isInteger(value.owner_pid)
    && value.owner_pid > 0
    && Number.isSafeInteger(value.updated_at_ms)
    && value.updated_at_ms >= 0;
}

function modalLeaseIsStale(lease, now = Date.now()) {
  const age = Math.max(0, now - lease.updated_at_ms);
  return age > MODAL_LEASE_STALE_MS && processIsAbsent(lease.owner_pid);
}

async function readPopupModal(queue) {
  if (typeof queue?.root !== 'string' || queue.root.length === 0) {
    throw new Error('queue root is required for popup modal lease');
  }
  const path = join(queue.root, POPUP_MODAL_FILENAME);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') {
      throw new Error('popup modal lease must be a regular file, not a symlink');
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('popup modal lease must be a regular file, not a symlink');
    if (metadata.size > MAX_POPUP_MODAL_BYTES) throw new Error('popup modal lease is oversized');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!validModalLease(value)) throw new Error('popup modal lease is invalid');
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('popup modal lease is invalid');
    throw error;
  } finally {
    await handle.close();
  }
}

async function syncQueueRoot(queue) {
  let directory;
  try {
    directory = await open(queue.root, 'r');
    await directory.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(error.code)) throw error;
  } finally {
    await directory?.close().catch(() => {});
  }
}

async function writePopupModal(queue, lease) {
  if (!validModalLease(lease)) throw new Error('popup modal lease is invalid');
  const path = join(queue.root, POPUP_MODAL_FILENAME);
  try {
    const existingHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!(await existingHandle.stat()).isFile()) {
        throw new Error('popup modal lease must be a regular file, not a symlink');
      }
    } finally {
      await existingHandle.close();
    }
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error('popup modal lease must be a regular file, not a symlink');
    }
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = join(queue.root, `.${POPUP_MODAL_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
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
    await syncQueueRoot(queue);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function clearPopupModalUnlocked(queue, token) {
  const lease = await readPopupModal(queue);
  if (!lease || lease.token !== token) return false;
  await unlink(join(queue.root, POPUP_MODAL_FILENAME));
  await syncQueueRoot(queue);
  return true;
}

async function livePopupModal(queue) {
  const lease = await readPopupModal(queue);
  if (!lease) return null;
  if (!modalLeaseIsStale(lease)) return lease;
  await clearPopupModalUnlocked(queue, lease.token);
  return null;
}

export async function claimPopupModal(queue, token) {
  if (!POPUP_TOKEN_PATTERN.test(token)) return false;
  return queue.withPopupLock(async () => {
    const lease = await livePopupModal(queue);
    if (!lease || lease.token !== token) return false;
    await writePopupModal(queue, {
      ...lease,
      state: 'active',
      owner_pid: process.pid,
      updated_at_ms: Date.now(),
    });
    return true;
  });
}

export async function clearPopupModal(queue, token) {
  if (!POPUP_TOKEN_PATTERN.test(token)) return false;
  return queue.withPopupLock(() => clearPopupModalUnlocked(queue, token));
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

async function withinDeadline(factory, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error('native UI readiness deadline exceeded');
    error.code = 'NATIVE_UI_DEADLINE';
    throw error;
  }
  let timer;
  return Promise.race([
    Promise.resolve().then(() => factory(remaining)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('native UI readiness deadline exceeded');
        error.code = 'NATIVE_UI_DEADLINE';
        reject(error);
      }, remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function defaultWaitForNativeUi(request, timeoutMs, { herdr }) {
  const deadline = Date.now() + timeoutMs;
  let previousReadyScreen = null;
  while (true) {
    try {
      const snapshot = await withinDeadline(
        (remaining) => herdr.snapshot({ timeoutMs: remaining }),
        deadline,
      );
      const live = liveAgentFor(request, snapshot);
      const screen = await withinDeadline(
        (remaining) => herdr.readPane(request.source.pane_id, { timeoutMs: remaining }),
        deadline,
      );
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
    } catch (error) {
      // Readiness is advisory. Continue until the bounded deadline and always
      // attempt source focus afterward.
      if (error?.code === 'NATIVE_UI_DEADLINE') return false;
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

  let modalPlan;
  try {
    modalPlan = await queue.withPopupLock(async () => {
      // Event processes can race after taking their initial reconciliation
      // snapshot. Refresh only after acquiring the cross-process lock so the
      // second process observes the pane opened by the first.
      const routingSnapshot = await herdr.snapshot();
      if (!liveAgentFor(request, routingSnapshot)) {
        await cancelStaleRequest(request, queue);
        return { status: 'no-live-request' };
      }
      const lease = await livePopupModal(queue);
      if (lease) {
        return {
          status: 'active',
          request_id: request.request_id,
          modal: true,
        };
      }

      const token = randomUUID();
      const openingLease = {
        schema_version: 1,
        token,
        state: 'opening',
        owner_pid: process.pid,
        updated_at_ms: Date.now(),
      };
      try {
        await writePopupModal(queue, openingLease);
      } catch (error) {
        await clearPopupModalUnlocked(queue, token).catch(() => {});
        throw error;
      }
      return { status: 'opening', token };
    });
  } catch {
    return routeFailureToNative(request, {
      queue,
      herdr,
      waitForNativeUi,
      nativeUiTimeoutMs,
    });
  }

  if (modalPlan.status !== 'opening') return modalPlan;

  // The popup command is session-modal and remains pending until the popup
  // exits. Never hold the queue lock while waiting: the popup process must
  // claim and later clear this exact token through the same lock.
  let openFailed = false;
  try {
    await herdr.openPopup(modalPlan.token);
  } catch {
    openFailed = true;
  }

  let clearFailed = false;
  try {
    await clearPopupModal(queue, modalPlan.token);
  } catch {
    clearFailed = true;
  }

  if (openFailed || clearFailed) {
    return routeFailureToNative(request, {
      queue,
      herdr,
      waitForNativeUi,
      nativeUiTimeoutMs,
    });
  }
  return {
    status: 'opened',
    request_id: request.request_id,
    modal: true,
  };
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
