import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseEventContext, runEvent } from '../bin/event.mjs';
import { HerdrOperationError } from '../src/herdr.mjs';
import { openQueue } from '../src/queue.mjs';
import {
  claimPopupModal,
  clearPopupModal,
  handleAgentStatusChanged,
  handoff,
} from '../src/router.mjs';
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
    panes: [source],
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
  let popupToken;
  let popupClaimed = false;
  let popupCleared = false;
  const { api, calls } = fakeHerdr({
    snapshot: () => liveSnapshot(),
    openPopup: async (token) => {
      popupToken = token;
      popupClaimed = await claimPopupModal(queue, token);
      assert.equal(await claimPopupModal(queue, '00000000-0000-4000-8000-000000000000'), false);
      assert.equal(await clearPopupModal(queue, '00000000-0000-4000-8000-000000000000'), false);
      popupCleared = await clearPopupModal(queue, token);
      return { ok: true, modal: true };
    },
  });

  assert.deepEqual(
    await handleAgentStatusChanged(
      { agent_status: 'blocked', pane_id: 'w-source:p1' },
      { queue, herdr: api },
    ),
    { status: 'opened', request_id: 'request-a', modal: true },
  );
  assert.deepEqual(calls.filter(({ name }) => name === 'openPopup').map(({ args }) => args), [[popupToken]]);
  assert.match(popupToken, /^[0-9a-f-]{36}$/);
  assert.equal(popupClaimed, true);
  assert.equal(popupCleared, true);
  assert.equal(calls.some(({ name }) => name === 'focusPopup'), false);
  await assert.rejects(readFile(join(queue.root, 'popup-pane.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(queue.root, 'popup-modal.json')), { code: 'ENOENT' });
});

test('popup claims its lease while blocking open is unresolved and concurrent events reuse it', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  let openCalls = 0;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let claimedResolve;
  const claimed = new Promise((resolve) => { claimedResolve = resolve; });
  let claimAttempt;
  let finishOpen;
  const openFinished = new Promise((resolve) => { finishOpen = resolve; });
  const herdr = {
    snapshot: async () => liveSnapshot(),
    openPopup: async (token) => {
      openCalls += 1;
      startedResolve(token);
      claimAttempt = claimPopupModal(queue, token);
      void claimAttempt.then(claimedResolve, () => claimedResolve(false));
      await openFinished;
      return { ok: true, modal: true };
    },
  };
  const event = { agent_status: 'blocked', pane_id: 'w-source:p1' };
  const first = handleAgentStatusChanged(event, { queue, herdr });
  const token = await started;

  let timer;
  try {
    const claimedWhileOpen = await Promise.race([
      claimed,
      new Promise((resolve) => { timer = setTimeout(resolve, 100, false); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(claimedWhileOpen, true);

    const second = await handleAgentStatusChanged(event, { queue, herdr });
    assert.equal(second.status, 'active');
    assert.equal(openCalls, 1);
    assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), ['request-a']);
    assert.equal(await queue.takeResponse('request-a'), null);

    assert.equal(await clearPopupModal(queue, token), true);
    finishOpen();
    assert.equal((await first).status, 'opened');
    await assert.rejects(readFile(join(queue.root, 'popup-modal.json')), { code: 'ENOENT' });
  } finally {
    finishOpen();
    await first.catch(() => {});
    await claimAttempt?.catch(() => {});
    await clearPopupModal(queue, token).catch(() => {});
  }
});

test('exact ui_busy without a valid owned modal lease fails to native handoff', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  const events = [];
  const herdr = {
    snapshot: async () => liveSnapshot(),
    openPopup: async () => {
      throw new HerdrOperationError('openPopup', 1, 'ui_busy');
    },
    focusAgent: async () => { events.push('focus'); },
    notify: async () => { events.push('notify'); },
  };

  const result = await handleAgentStatusChanged(
    { agent_status: 'blocked', pane_id: 'w-source:p1' },
    { queue, herdr, waitForNativeUi: async () => true },
  );

  assert.equal(result.status, 'native-handoff');
  assert.equal((await queue.takeResponse('request-a')).action, 'handoff');
  assert.deepEqual(events, ['focus', 'notify']);
  await assert.rejects(readFile(join(queue.root, 'popup-modal.json')), { code: 'ENOENT' });
});

test('stale opening modal lease is recovered only after its owner is absent and age is bounded', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  await writeFile(join(queue.root, 'popup-modal.json'), JSON.stringify({
    schema_version: 1,
    token: '11111111-1111-4111-8111-111111111111',
    state: 'opening',
    owner_pid: 999_999,
    updated_at_ms: Date.now() - 31_000,
  }), { mode: 0o600 });
  let openedToken;
  const herdr = {
    snapshot: async () => liveSnapshot(),
    openPopup: async (token) => {
      openedToken = token;
      return { ok: true, modal: true };
    },
  };

  const result = await handleAgentStatusChanged(
    { agent_status: 'blocked', pane_id: 'w-source:p1' },
    { queue, herdr },
  );

  assert.equal(result.status, 'opened');
  assert.notEqual(openedToken, '11111111-1111-4111-8111-111111111111');
});

test('a recent modal lease is retained even when the short-lived opener has exited', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  await writeFile(join(queue.root, 'popup-modal.json'), JSON.stringify({
    schema_version: 1,
    token: '11111111-1111-4111-8111-111111111111',
    state: 'opening',
    owner_pid: 999_999,
    updated_at_ms: Date.now(),
  }), { mode: 0o600 });
  let openCalls = 0;
  const herdr = {
    snapshot: async () => liveSnapshot(),
    openPopup: async () => { openCalls += 1; },
  };

  const result = await handleAgentStatusChanged(
    { agent_status: 'blocked', pane_id: 'w-source:p1' },
    { queue, herdr },
  );

  assert.equal(result.status, 'active');
  assert.equal(openCalls, 0);
});

test('modal lease symlink is never followed and fails the hook back to native UI', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor());
  const target = join(queue.root, 'outside-state.json');
  await writeFile(target, 'do-not-change', { mode: 0o600 });
  await symlink(target, join(queue.root, 'popup-modal.json'));
  const events = [];
  const herdr = {
    snapshot: async () => liveSnapshot(),
    openPopup: async () => { events.push('open'); },
    focusAgent: async () => { events.push('focus'); },
    notify: async () => { events.push('notify'); },
  };

  const result = await handleAgentStatusChanged(
    { agent_status: 'blocked', pane_id: 'w-source:p1' },
    { queue, herdr, waitForNativeUi: async () => true },
  );

  assert.equal(result.status, 'native-handoff');
  assert.deepEqual(events, ['focus', 'notify']);
  assert.equal(await readFile(target, 'utf8'), 'do-not-change');
  assert.equal((await queue.takeResponse('request-a')).action, 'handoff');
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

test('snapshot, lock, and popup modal open failures hand a matching hook back natively', async (t) => {
  for (const failure of ['snapshot', 'lock', 'open']) {
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
          return { ok: true, modal: true };
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

test('native readiness enforces the total deadline around a slow snapshot call', async () => {
  const request = requestFor();
  const queue = {
    respond: async () => {},
  };
  const herdr = {
    snapshot: async () => new Promise((resolve) => {
      setTimeout(() => resolve(liveSnapshot()), 300);
    }),
    readPane: async () => 'screen',
    focusAgent: async () => {},
  };
  const startedAt = Date.now();

  const result = await handoff(request, {
    queue,
    herdr,
    nativeUiTimeoutMs: 10,
  });

  assert.ok(Date.now() - startedAt < 100);
  assert.equal(result.native_ui_ready, false);
  assert.equal(result.focused, true);
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
  process.stdout.write(JSON.stringify({ id: 'cli:plugin', result: { type: 'ok' } }));
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
    '--env', openCall.at(-1),
  ]);
  assert.match(openCall.at(-1), /^HERDR_QUESTION_POPUP_TOKEN=[0-9a-f-]{36}$/);
  assert.equal(openCall.includes('--workspace'), false);
});
