#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createHerdr } from '../src/herdr.mjs';
import { openQueue } from '../src/queue.mjs';
import { ensurePopup } from '../src/opener.mjs';
import { resolveQueueRoot } from '../src/config.mjs';

// The "open pending queue" action. If requests are waiting and no popup is alive,
// open one; otherwise report the current state. Never waits — it is a menu action.
export async function openPendingQueue({ env = process.env } = {}) {
  const queue = await openQueue(await resolveQueueRoot(env));
  const requests = await queue.list();
  if (requests.length === 0) return { status: 'empty' };
  const herdr = createHerdr({ bin: env.HERDR_BIN_PATH || 'herdr', env });
  const result = await ensurePopup(queue, herdr);
  if (result.role === 'waiter') return { status: 'already-open' };
  return { status: result.opened ? 'opened' : 'open-failed' };
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  try {
    const result = await openPendingQueue();
    process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  } catch {
    process.stderr.write('ask-inbox: pending queue could not be opened safely\n');
    process.exitCode = 1;
  }
}
