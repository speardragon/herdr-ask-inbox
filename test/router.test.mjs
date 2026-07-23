import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseEventContext, runEvent } from '../bin/event.mjs';
import { openQueue } from '../src/queue.mjs';
import { handleAgentStatusChanged, handoff } from '../src/router.mjs';
import { fakeHerdr } from './helpers/fake-herdr.mjs';

function requestFor({
  id = 'request-a',
  paneId = 'w-source:p1',
  workspaceId = 'w-source',
  sessionId = 'session-a',
  agent = 'claude',
  transport = 'hook-response',
  createdAt = 10,
} = {}) {
  return {
    schema_version: 1,
    request_id: id,
    created_at_ms: createdAt,
    source: {
      agent,
      pane_id: paneId,
      workspace_id: workspaceId,
      session_id: sessionId,
    },
    kind: 'question',
    transport,
    title: 'Choose',
    detail: {},
    questions: [],
    permission: null,
    status: transport === 'terminal-keys' ? 'armed' : 'waiting',
  };
}

async function temporaryQueue(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-router-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openQueue(root);
}

function liveSnapshot({
  popupPaneId,
  paneId = 'w-source:p1',
  sessionId = 'session-a',
  agent = 'claude',
} = {}) {
  const source = {
    pane_id: paneId,
    workspace_id: 'w-source',
    agent,
    agent_status: 'blocked',
    agent_session: { kind: 'id', value: sessionId, agent },
  };
  return {
    focused_workspace_id: 'w-current',
    panes: popupPaneId ? [source, { pane_id: popupPaneId, workspace_id: 'w-current' }] : [source],
    agents: [source],
  };
}

test('non-blocked agent events are ignored without reading queue or snapshot', async () => {
  const queue = {
    list: async () => { throw new Error('must not list'); },
    withPopupLock: async () => { throw new Error('must not lock'); },
  };
  const { api, calls } = fakeHerdr();

  assert.deepEqual(
    await handleAgentStatusChanged({ agent_status: 'working', pane_id: 'w-source:p1' }, { queue, herdr: api }),
    { status: 'ignored' },
  );
  assert.deepEqual(calls, []);
});

test('blocked event opens one popup for a matching pane and exact agent session', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  let popupPaneId;
  const { api, calls } = fakeHerdr({
    snapshot: () => liveSnapshot({ popupPaneId }),
    openPopup: () => {
      popupPaneId = 'w-current:p-popup';
      return popupPaneId;
    },
  });

  assert.deepEqual(
    await handleAgentStatusChanged(
      { agent_status: 'blocked', pane_id: 'w-source:p1' },
      { queue, herdr: api },
    ),
    { status: 'opened', request_id: 'request-a', pane_id: 'w-current:p-popup' },
  );
  assert.deepEqual(
    await handleAgentStatusChanged(
      { agent_status: 'blocked', pane_id: 'w-source:p1' },
      { queue, herdr: api },
    ),
    { status: 'focused', request_id: 'request-a', pane_id: 'w-current:p-popup' },
  );
  assert.deepEqual(calls.filter(({ name }) => name === 'openPopup').map(({ args }) => args), [['w-current']]);
  assert.deepEqual(calls.filter(({ name }) => name === 'focusPopup').map(({ args }) => args), [['w-current:p-popup']]);
});

test('concurrent blocked events refresh inside the global lock and never open duplicate popups', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  let popupPaneId;
  let openCalls = 0;
  let focusCalls = 0;
  const herdr = {
    snapshot: async () => liveSnapshot({ popupPaneId }),
    openPopup: async () => {
      openCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      popupPaneId = 'w-current:p-popup';
      return popupPaneId;
    },
    focusPopup: async () => { focusCalls += 1; },
  };
  const event = { agent_status: 'blocked', pane_id: 'w-source:p1' };

  const results = await Promise.all([
    handleAgentStatusChanged(event, { queue, herdr }),
    handleAgentStatusChanged(event, { queue, herdr }),
  ]);

  assert.equal(openCalls, 1);
  assert.equal(focusCalls, 1);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['focused', 'opened']);
});

test('reconciliation cancels disappeared or session-mismatched requests and chooses newest exact match', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor({ id: 'missing-pane', paneId: 'w-missing:p1', createdAt: 1 }));
  await queue.enqueue(requestFor({ id: 'wrong-session', sessionId: 'old-session', createdAt: 2 }));
  await queue.enqueue(requestFor({ id: 'matching-old', createdAt: 3 }));
  await queue.enqueue(requestFor({ id: 'matching-new', createdAt: 4 }));
  const { api } = fakeHerdr({ snapshot: liveSnapshot() });

  const result = await handleAgentStatusChanged(
    { agent_status: 'blocked', pane_id: 'w-source:p1' },
    { queue, herdr: api },
  );

  assert.equal(result.request_id, 'matching-new');
  assert.equal((await queue.takeResponse('missing-pane')).action, 'handoff');
  assert.equal((await queue.takeResponse('wrong-session')).action, 'handoff');
  assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), ['matching-old', 'matching-new']);
});

test('blocked event with no exact live request neither opens nor focuses a popup', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor({ sessionId: 'stale' }));
  const { api, calls } = fakeHerdr({ snapshot: liveSnapshot() });

  assert.deepEqual(
    await handleAgentStatusChanged(
      { agent_status: 'blocked', pane_id: 'w-source:p1' },
      { queue, herdr: api },
    ),
    { status: 'no-live-request' },
  );
  assert.equal(calls.some(({ name }) => ['openPopup', 'focusPopup'].includes(name)), false);
});

test('unsafe popup state symlink fails closed without opening a pane', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  await symlink('/tmp/not-owned', join(queue.root, 'popup-pane.json'));
  const { api, calls } = fakeHerdr({ snapshot: liveSnapshot() });

  await assert.rejects(
    handleAgentStatusChanged(
      { agent_status: 'blocked', pane_id: 'w-source:p1' },
      { queue, herdr: api },
    ),
    /popup state/i,
  );
  assert.equal(calls.some(({ name }) => name === 'openPopup'), false);
});

test('hook-response handoff publishes first, waits bounded, releases owned authority, then focuses', async (t) => {
  const queue = await temporaryQueue(t);
  const request = requestFor();
  await queue.enqueue(request);
  const events = [];
  const herdr = {
    sendAgentKeys: async () => { events.push('keys'); },
    releaseBlocked: async () => { events.push('release'); },
    focusAgent: async () => { events.push('focus'); },
  };

  const result = await handoff(request, {
    queue,
    herdr,
    waitForNativeUi: async (_request, timeoutMs) => {
      assert.ok(timeoutMs <= 2_000);
      assert.equal((await queue.takeResponse(request.request_id)).action, 'handoff');
      events.push('wait');
    },
  });

  assert.deepEqual(result, { status: 'handed-off' });
  assert.deepEqual(events, ['wait', 'release', 'focus']);
});

test('terminal handoff sends zero keys and releases before focusing exact source pane', async () => {
  const request = requestFor({ transport: 'terminal-keys', agent: 'codex' });
  const events = [];
  const herdr = {
    sendAgentKeys: async () => { events.push('keys'); },
    releaseBlocked: async (value) => { events.push(`release:${value.source.pane_id}`); },
    focusAgent: async (paneId) => { events.push(`focus:${paneId}`); },
  };

  await handoff(request, {
    queue: { respond: async () => { events.push('respond'); } },
    herdr,
    waitForNativeUi: async () => { events.push('wait'); },
  });

  assert.deepEqual(events, ['release:w-source:p1', 'focus:w-source:p1']);
});

test('event context parser accepts only bounded plain event identity', () => {
  assert.deepEqual(
    parseEventContext('{"agent_status":"blocked","pane_id":"w1:p1","secret":"drop-me"}'),
    { agent_status: 'blocked', pane_id: 'w1:p1' },
  );
  for (const raw of [
    '',
    'not-json',
    '[]',
    '{"agent_status":"blocked"}',
    '{"agent_status":7,"pane_id":"w1:p1"}',
    `{"agent_status":"blocked","pane_id":"${'x'.repeat(1025)}"}`,
    ' '.repeat(65_537),
  ]) {
    assert.equal(parseEventContext(raw), null);
  }
});

test('runEvent fails open on malformed plugin context', async () => {
  const result = await runEvent({
    env: { HERDR_PLUGIN_CONTEXT_JSON: 'not-json' },
    queue: { list: async () => { throw new Error('must not run'); } },
    herdr: {},
  });
  assert.deepEqual(result, { status: 'invalid-context' });
});
