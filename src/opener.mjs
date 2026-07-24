import { randomUUID } from 'node:crypto';

import { checkAliveOrClear, clearLease, electOpener, pidAlive } from './lease.mjs';

// Hook-side popup orchestration. Unlike v1 — which reported a blocked status and
// waited for herdr to emit an event that never fired while screen detection said
// "working" — the hook opens the popup itself and treats popup liveness as the
// sole gate. If no popup is alive, the hook fails open to the native picker.

const defaultDelay = (milliseconds, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, milliseconds);
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  signal?.addEventListener('abort', done, { once: true });
});

async function failOpen(queue, requestId) {
  await queue.cancel(requestId).catch(() => false);
  await queue.takeResponse(requestId).catch(() => null);
}

// Become the popup opener and open it, or defer to the popup a live lease points at.
export async function ensurePopup(queue, herdr, { now = Date.now, isAlive = pidAlive } = {}) {
  const token = randomUUID();
  const { role } = await electOpener(queue, token, now(), isAlive);
  if (role !== 'opener') return { role: 'waiter', token, opened: false };
  try {
    await herdr.openPopup(token);
  } catch {
    // Open refused (e.g. plugin disabled — spike P3). Drop our lease so the wait
    // loop sees no live popup and falls open immediately.
    await clearLease(queue, token).catch(() => {});
    return { role: 'opener', token, opened: false };
  }
  return { role: 'opener', token, opened: true };
}

// Wait for this request's outcome. Returns as soon as the popup answers/hands off,
// or the moment no popup is alive to answer it.
export async function waitForOutcome(queue, request, {
  now = Date.now,
  isAlive = pidAlive,
  pollMs = 100,
  deadlineMs,
  signal,
  delay = defaultDelay,
} = {}) {
  const id = request.request_id;
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : now() + 30 * 60 * 1_000;

  const classify = (response) => (
    response.action === 'answer'
      ? { status: 'answer', response }
      : { status: 'handoff' }
  );

  while (true) {
    if (signal?.aborted) {
      await failOpen(queue, id);
      return { status: 'interrupted' };
    }
    const response = await queue.takeResponse(id);
    if (response) return classify(response);

    if (now() >= deadline) {
      await failOpen(queue, id);
      return { status: 'timeout' };
    }

    const alive = await checkAliveOrClear(queue, now(), isAlive);
    if (!alive) {
      // The popup may have answered and then exited between our takeResponse and
      // this liveness read; give the response one last chance before failing open.
      const late = await queue.takeResponse(id);
      if (late) return classify(late);
      await failOpen(queue, id);
      return { status: 'fail-open' };
    }

    await delay(pollMs, signal);
  }
}
