import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openQueue } from '../src/queue.mjs';
import { runHook } from '../bin/hook.mjs';

const alwaysAlive = () => true;
const neverAlive = () => false;

const ENV = { HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1' };

async function fixture() {
  const raw = await readFile(new URL('../fixtures/claude/ask-user-question.json', import.meta.url), 'utf8');
  return JSON.parse(raw);
}

async function tempQueue() {
  const root = await mkdtemp(join(tmpdir(), 'hq-hook-'));
  const queue = await openQueue(root);
  return { queue, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// A herdr stub whose openPopup drives the queue the way a real popup would.
function stubHerdr({ onOpen } = {}) {
  return {
    reportBlocked: async () => {},
    releaseBlocked: async () => {},
    focusAgent: async () => {},
    openPopup: async (token) => { await onOpen?.(token); },
  };
}

test('runHook: popup answer becomes an updatedInput hook decision', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const herdr = stubHerdr({
      onOpen: async () => {
        const [req] = await queue.list();
        await queue.respond({
          schema_version: 1,
          request_id: req.request_id,
          action: 'answer',
          value: { answers: { 'Which framework?': 'React' } },
          created_at_ms: Date.now(),
        });
      },
    });
    const result = await runHook({ payload: await fixture(), env: ENV, queue, herdr, isAlive: alwaysAlive });
    assert.equal(result.status, 'answered');
    assert.equal(result.output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(result.output.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(result.output.hookSpecificOutput.updatedInput.answers, { 'Which framework?': 'React' });
  } finally {
    await cleanup();
  }
});

test('runHook: popup hand-off yields no decision (native picker)', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const herdr = stubHerdr({
      onOpen: async () => {
        const [req] = await queue.list();
        await queue.cancel(req.request_id); // handoff
      },
    });
    const result = await runHook({ payload: await fixture(), env: ENV, queue, herdr, isAlive: alwaysAlive });
    assert.equal(result.status, 'handoff');
    assert.equal(result.output, null);
  } finally {
    await cleanup();
  }
});

test('runHook: no live popup → fail open with no decision', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const herdr = stubHerdr({ onOpen: async () => {} }); // popup never answers
    const result = await runHook({ payload: await fixture(), env: ENV, queue, herdr, isAlive: neverAlive });
    assert.equal(result.status, 'fail-open');
    assert.equal(result.output, null);
  } finally {
    await cleanup();
  }
});

test('runHook: popup open refused (disabled plugin) → fail open', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const herdr = stubHerdr({ onOpen: async () => { throw new Error('plugin_disabled'); } });
    const result = await runHook({ payload: await fixture(), env: ENV, queue, herdr, isAlive: alwaysAlive });
    assert.equal(result.status, 'fail-open');
    assert.equal(result.output, null);
  } finally {
    await cleanup();
  }
});

test('runHook: a duplicate invocation defers to the first owner', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const payload = await fixture(); // stable tool_use_id → stable request_id
    let openCount = 0;
    const answering = stubHerdr({
      onOpen: async () => {
        openCount += 1;
        const [req] = await queue.list();
        await queue.respond({
          schema_version: 1,
          request_id: req.request_id,
          action: 'answer',
          value: { answers: { 'Which framework?': 'Vue' } },
          created_at_ms: Date.now(),
        });
      },
    });
    const first = await runHook({ payload, env: ENV, queue, herdr: answering, isAlive: alwaysAlive });
    assert.equal(first.status, 'answered');
    // second call, same payload → same request_id, already responded/consumed
    const second = await runHook({ payload, env: ENV, queue, herdr: answering, isAlive: alwaysAlive });
    assert.equal(second.status, 'duplicate');
    assert.equal(second.output, null);
    assert.equal(openCount, 1); // the duplicate never opened a second popup
  } finally {
    await cleanup();
  }
});

test('runHook: an aborted signal closes the request with no decision', async () => {
  const { queue, cleanup } = await tempQueue();
  try {
    const controller = new AbortController();
    controller.abort();
    const herdr = stubHerdr({ onOpen: async () => {} });
    const result = await runHook({
      payload: await fixture(),
      env: ENV,
      queue,
      herdr,
      isAlive: alwaysAlive,
      signal: controller.signal,
    });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.output, null);
  } finally {
    await cleanup();
  }
});
