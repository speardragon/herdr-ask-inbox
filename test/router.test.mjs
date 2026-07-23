import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(calls.filter(({ name }) => name === 'openPopup').map(({ args }) => args), [[]]);
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

test('terminal stale cancellation is consumed immediately instead of leaving an orphan response', async (t) => {
  const queue = await temporaryQueue(t);
  const stale = requestFor({
    id: 'terminal-stale',
    transport: 'terminal-keys',
    agent: 'codex',
    sessionId: 'old-session',
  });
  await queue.enqueue(stale);
  const { api } = fakeHerdr({
    snapshot: liveSnapshot({ agent: 'codex', sessionId: 'new-session' }),
  });

  await handleAgentStatusChanged(
    { agent_status: 'blocked', pane_id: stale.source.pane_id },
    { queue, herdr: api },
  );

  assert.equal(await queue.takeResponse(stale.request_id), null);
  assert.deepEqual(await queue.list(), []);
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

test('unsafe popup state fails closed to native handoff without leaving the hook waiting', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  await symlink('/tmp/not-owned', join(queue.root, 'popup-pane.json'));
  const calls = [];
  const herdr = {
    snapshot: async () => liveSnapshot(),
    openPopup: async () => { calls.push('open'); },
    releaseBlocked: async () => { calls.push('release'); },
    focusAgent: async () => { calls.push('focus'); },
    notify: async () => { calls.push('notify'); },
  };

  const result = await handleAgentStatusChanged(
    { agent_status: 'blocked', pane_id: 'w-source:p1' },
    { queue, herdr, waitForNativeUi: async () => {} },
  );

  assert.equal(result.status, 'native-handoff');
  assert.equal((await queue.takeResponse('request-a')).action, 'handoff');
  assert.deepEqual(calls, ['focus', 'notify']);
});

test('a transient focus failure on a positively live recorded popup never opens a duplicate', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  let popupPaneId;
  let openCalls = 0;
  let focusAttempts = 0;
  const events = [];
  const herdr = {
    snapshot: async () => liveSnapshot({ popupPaneId }),
    openPopup: async () => {
      openCalls += 1;
      popupPaneId = 'w-current:p-popup';
      return popupPaneId;
    },
    focusPopup: async () => {
      focusAttempts += 1;
      throw new Error('transient focus error');
    },
    focusAgent: async () => { events.push('source-focus'); },
    notify: async () => { events.push('notify'); },
  };
  const context = { agent_status: 'blocked', pane_id: 'w-source:p1' };
  await handleAgentStatusChanged(context, { queue, herdr });

  const result = await handleAgentStatusChanged(context, {
    queue,
    herdr,
    waitForNativeUi: async () => true,
  });

  assert.equal(result.status, 'native-handoff');
  assert.equal(openCalls, 1);
  assert.equal(focusAttempts, 1);
  assert.deepEqual(events, ['source-focus', 'notify']);
  assert.equal((await queue.takeResponse('request-a')).action, 'handoff');
});

test('snapshot, lock, popup open, and popup state write failures hand a matching hook back natively', async (t) => {
  for (const failure of ['snapshot', 'lock', 'open', 'state-write']) {
    await t.test(failure, async (t2) => {
      const queue = await temporaryQueue(t2);
      const request = requestFor({ id: `failure-${failure}` });
      await queue.enqueue(request);
      const realLock = queue.withPopupLock.bind(queue);
      if (failure === 'lock') {
        queue.withPopupLock = async () => { throw new Error('lock failed'); };
      }
      let snapshotCalls = 0;
      const events = [];
      const herdr = {
        snapshot: async () => {
          snapshotCalls += 1;
          if (failure === 'snapshot' && snapshotCalls === 1) throw new Error('snapshot failed');
          return liveSnapshot();
        },
        openPopup: async () => {
          if (failure === 'open') throw new Error('open failed');
          if (failure === 'state-write') {
            await symlink('/tmp/not-owned', join(queue.root, 'popup-pane.json'));
          }
          return 'w-current:p-popup';
        },
        focusAgent: async () => { events.push('focus'); },
        notify: async () => { events.push('notify'); },
      };

      const result = await handleAgentStatusChanged(
        { agent_status: 'blocked', pane_id: request.source.pane_id },
        { queue, herdr, waitForNativeUi: async () => true },
      );

      assert.equal(result.status, 'native-handoff');
      assert.equal((await queue.takeResponse(request.request_id)).action, 'handoff');
      assert.deepEqual(events, ['focus', 'notify']);
      queue.withPopupLock = realLock;
    });
  }
});

test('hook-response handoff publishes first, never double-releases hook authority, and focuses despite wait failure', async (t) => {
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
      throw new Error('transient readiness failure');
    },
  });

  assert.deepEqual(result, { status: 'handed-off', focused: true, native_ui_ready: false });
  assert.deepEqual(events, ['wait', 'focus']);
});

test('default hook handoff polls fresh blocked screen readiness only after response publication', async (t) => {
  const queue = await temporaryQueue(t);
  const request = requestFor();
  await queue.enqueue(request);
  let responseObserved = false;
  let snapshotCalls = 0;
  const events = [];
  const herdr = {
    snapshot: async () => {
      snapshotCalls += 1;
      if (!responseObserved) {
        responseObserved = (await queue.takeResponse(request.request_id))?.action === 'handoff';
      }
      return liveSnapshot();
    },
    readPane: async () => 'Native question is ready',
    releaseBlocked: async () => { events.push('release'); },
    focusAgent: async () => { events.push('focus'); },
  };

  const result = await handoff(request, {
    queue,
    herdr,
    nativeUiTimeoutMs: 200,
  });

  assert.equal(responseObserved, true);
  assert.ok(snapshotCalls >= 2);
  assert.deepEqual(events, ['focus']);
  assert.deepEqual(result, { status: 'handed-off', focused: true, native_ui_ready: true });
});

test('terminal handoff consumes cancellation, sends zero keys, and focuses even when release fails', async (t) => {
  const queue = await temporaryQueue(t);
  const request = requestFor({ transport: 'terminal-keys', agent: 'codex' });
  await queue.enqueue(request);
  const events = [];
  const herdr = {
    sendAgentKeys: async () => { events.push('keys'); },
    releaseBlocked: async (value) => {
      events.push(`release:${value.source.pane_id}`);
      throw new Error('newer lifecycle already owns pane');
    },
    focusAgent: async (paneId) => { events.push(`focus:${paneId}`); },
  };

  const result = await handoff(request, { queue, herdr });

  assert.deepEqual(events, ['release:w-source:p1', 'focus:w-source:p1']);
  assert.equal(await queue.takeResponse(request.request_id), null);
  assert.deepEqual(result, { status: 'handed-off', focused: true, native_ui_ready: true });
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
    env: { HERDR_PLUGIN_EVENT_JSON: 'not-json' },
    queue: { list: async () => { throw new Error('must not run'); } },
    herdr: {},
  });
  assert.deepEqual(result, { status: 'invalid-context' });
});

test('event CLI consumes HERDR_PLUGIN_EVENT_JSON and opens popup with the actual 0.7.5 argv contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-event-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await openQueue(root);
  await queue.enqueue(requestFor());
  const logPath = join(root, 'herdr-calls.jsonl');
  const fakeBin = join(root, 'fake-herdr.mjs');
  const snapshot = liveSnapshot();
  await writeFile(fakeBin, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'plugin' && args[1] === 'config-dir') {
  process.stdout.write(process.env.FAKE_QUEUE_ROOT + '\\n');
} else if (args[0] === 'api' && args[1] === 'snapshot') {
  process.stdout.write(JSON.stringify({ result: { type: 'session_snapshot', snapshot: JSON.parse(process.env.FAKE_SNAPSHOT) } }));
} else if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open') {
  process.stdout.write(JSON.stringify({ result: { type: 'plugin_pane_opened', plugin_pane: {
    plugin_id: 'ray.herdr-question', entrypoint: 'question', pane: { pane_id: 'w-current:p-popup' }
  } } }));
} else {
  process.exitCode = 2;
}
`, { mode: 0o700 });
  await chmod(fakeBin, 0o700);
  const child = spawn(process.execPath, [new URL('../bin/event.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: fakeBin,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        type: 'pane.agent_status_changed',
        pane_id: 'w-source:p1',
        agent_status: 'blocked',
      }),
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        pane_id: 'w-source:p1',
        agent_status: 'working',
      }),
      FAKE_LOG: logPath,
      FAKE_QUEUE_ROOT: root,
      FAKE_SNAPSHOT: JSON.stringify(snapshot),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0);
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const openCall = calls.find((args) => args.slice(0, 3).join(' ') === 'plugin pane open');
  assert.deepEqual(openCall, [
    'plugin', 'pane', 'open',
    '--plugin', 'ray.herdr-question',
    '--entrypoint', 'question',
    '--placement', 'popup',
    '--focus',
  ]);
  assert.equal(openCall.includes('--workspace'), false);
});
