#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createHerdr } from '../src/herdr.mjs';
import { openQueue } from '../src/queue.mjs';
import { handleAgentStatusChanged } from '../src/router.mjs';
import { resolveQueueRoot } from './smoke.mjs';

export async function openPendingQueue({ env = process.env } = {}) {
  const queue = await openQueue(await resolveQueueRoot({ env }));
  const requests = await queue.list();
  const request = requests[0];
  if (!request) return { status: 'empty' };
  return handleAgentStatusChanged({
    agent_status: 'blocked',
    pane_id: request.source.pane_id,
  }, {
    queue,
    herdr: createHerdr({ bin: env.HERDR_BIN_PATH || 'herdr', env }),
  });
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
    process.stderr.write('herdr-question: pending queue could not be opened safely\n');
    process.exitCode = 1;
  }
}
