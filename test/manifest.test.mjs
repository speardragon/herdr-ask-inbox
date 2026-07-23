import assert from 'node:assert/strict';
import { access, constants, readFile } from 'node:fs/promises';
import test from 'node:test';

import { defaultPlan, parseArgs, runSmoke } from '../bin/smoke.mjs';

const manifestUrl = new URL('../herdr-plugin.toml', import.meta.url);

test('manifest references existing entrypoints and declares all operator actions', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  for (const file of [
    'bin/open.mjs',
    'bin/popup.mjs',
    'bin/event.mjs',
    'bin/install-hooks.mjs',
    'bin/status.mjs',
    'bin/uninstall-hooks.mjs',
  ]) {
    assert.match(text, new RegExp(file.replace('.', '\\.')));
    await access(new URL(`../${file}`, import.meta.url), constants.R_OK);
  }
  for (const action of ['open', 'install-hooks', 'hook-status', 'uninstall-hooks']) {
    assert.match(text, new RegExp(`id = "${action}"`));
  }
  assert.match(text, /on = "pane\.agent_status_changed"/);
  assert.match(text, /placement = "popup"/);
  assert.doesNotMatch(text, /\["bash", "-c"/);
});

test('manifest build pipeline checks Node, tests, and idempotently installs hooks', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /Node\.js >= 22 required/);
  assert.match(text, /command = \["npm", "test"\]/);
  assert.match(text, /command = \["node", "bin\/install-hooks\.mjs"\]/);
});

test('operator README uses herdr 0.7.5 action argument order', async () => {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const action of ['hook-status', 'open', 'install-hooks', 'uninstall-hooks']) {
    assert.match(text, new RegExp(`herdr plugin action invoke ${action} --plugin ray\\.herdr-question`));
  }
});

test('smoke defaults are non-mutating and explicit live identifiers are paired', () => {
  assert.deepEqual(parseArgs([]), { confirmLocal: false, paneId: null, sessionId: null });
  assert.throws(() => parseArgs(['--pane-id', 'pane-a']), /session-id/i);
  assert.throws(() => parseArgs(['--session-id', 'session-a']), /pane-id/i);
  assert.throws(() => parseArgs(['--confirm-local']), /pane-id.*session-id/i);
  assert.throws(() => parseArgs(['--pane-id', 'pane\u0000a', '--session-id', 'session-a']), /NUL/i);

  const plan = defaultPlan();
  assert.equal(plan.mutates, false);
  assert.equal(plan.opensPopup, false);
  assert.equal(plan.sendsKeys, false);
  assert.match(plan.manualValidation, /g/i);
});

test('confirmed smoke gates on an exact blocked Claude session, waits for handoff, verifies focus, and cleans up', async () => {
  const calls = [];
  const queue = {
    enqueue: async (request) => { calls.push(['enqueue', request]); },
    cancel: async (id) => { calls.push(['cancel', id]); },
    takeResponse: async (id) => { calls.push(['takeResponse', id]); },
  };
  const output = [];
  const source = {
    pane_id: 'workspace:pane',
    workspace_id: 'workspace',
    agent: 'claude',
    agent_status: 'blocked',
    agent_session: { value: 'session-a' },
  };
  let snapshotCall = 0;
  const herdr = {
    snapshot: async () => {
      snapshotCall += 1;
      return snapshotCall === 1
        ? { panes: [source], agents: [source], focused_pane_id: 'other:pane' }
        : { panes: [source], agents: [source], focused_pane_id: 'workspace:pane' };
    },
    sendAgentKeys: async () => assert.fail('smoke must never send agent keys'),
  };
  const events = [];
  const result = await runSmoke({
    args: ['--confirm-local', '--pane-id', 'workspace:pane', '--session-id', 'session-a'],
    env: { HERDR_QUESTION_CONFIG_DIR: '/tmp/herdr-question-test' },
    stdout: { write: (text) => output.push(text) },
    stderr: { write: () => assert.fail('unexpected smoke error') },
    openQueueAt: async (root) => {
      assert.equal(root, '/tmp/herdr-question-test');
      return queue;
    },
    createHerdrApi: () => herdr,
    handleStatusChanged: async (event, dependencies) => {
      events.push([event, dependencies]);
      return { status: 'opened' };
    },
    installSignalHandlers: false,
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(calls.map(([name]) => name), ['enqueue', 'cancel', 'takeResponse']);
  assert.equal(calls[0][1].source.pane_id, 'workspace:pane');
  assert.equal(calls[0][1].source.workspace_id, 'workspace');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][0], { agent_status: 'blocked', pane_id: 'workspace:pane' });
  assert.match(output.join(''), /handoff/i);
});

test('confirmed smoke refuses a stale or non-Claude source before queue mutation', async () => {
  const calls = [];
  const result = await runSmoke({
    args: ['--confirm-local', '--pane-id', 'workspace:pane', '--session-id', 'old-session'],
    env: { HERDR_QUESTION_CONFIG_DIR: '/tmp/herdr-question-test' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    openQueueAt: async () => ({ enqueue: async () => calls.push('enqueue') }),
    createHerdrApi: () => ({
      snapshot: async () => ({
        panes: [{ pane_id: 'workspace:pane' }],
        agents: [{ pane_id: 'workspace:pane', agent: 'claude', agent_status: 'blocked', agent_session: { value: 'new-session' } }],
      }),
    }),
    installSignalHandlers: false,
  });

  assert.equal(result.status, 'error');
  assert.deepEqual(calls, []);
});

test('confirmed smoke cancels its synthetic request when routing fails', async () => {
  const calls = [];
  const queue = {
    enqueue: async () => { throw new Error('disk unavailable'); },
    cancel: async (id) => { calls.push(['cancel', id]); },
    takeResponse: async (id) => { calls.push(['takeResponse', id]); },
  };
  const errors = [];
  const result = await runSmoke({
    args: ['--confirm-local', '--pane-id', 'workspace:pane', '--session-id', 'session-a'],
    env: { HERDR_QUESTION_CONFIG_DIR: '/tmp/herdr-question-test' },
    stdout: { write: () => {} },
    stderr: { write: (text) => errors.push(text) },
    openQueueAt: async () => queue,
    createHerdrApi: () => {
      let callsToSnapshot = 0;
      return {
        snapshot: async () => {
          callsToSnapshot += 1;
          return {
            panes: [{ pane_id: 'workspace:pane' }],
            agents: [{ pane_id: 'workspace:pane', workspace_id: 'workspace', agent: 'claude', agent_status: 'blocked', agent_session: { value: 'session-a' } }],
            focused_pane_id: callsToSnapshot === 1 ? 'other:pane' : 'workspace:pane',
          };
        },
      };
    },
    handleStatusChanged: async () => { throw new Error('popup unavailable'); },
    installSignalHandlers: false,
  });

  assert.equal(result.status, 'error');
  assert.deepEqual(calls.map(([name]) => name), ['cancel', 'takeResponse']);
  assert.match(errors.join(''), /failed/i);
});

test('confirmed smoke rejects a router result other than opened and cleans up', async () => {
  const calls = [];
  const queue = {
    enqueue: async () => { calls.push('enqueue'); },
    cancel: async () => { calls.push('cancel'); },
    takeResponse: async () => { calls.push('takeResponse'); },
  };
  const result = await runSmoke({
    args: ['--confirm-local', '--pane-id', 'workspace:pane', '--session-id', 'session-a'],
    env: { HERDR_QUESTION_CONFIG_DIR: '/tmp/herdr-question-test' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    openQueueAt: async () => queue,
    createHerdrApi: () => {
      let callsToSnapshot = 0;
      return {
        snapshot: async () => {
          callsToSnapshot += 1;
          return {
            panes: [{ pane_id: 'workspace:pane' }],
            agents: [{ pane_id: 'workspace:pane', workspace_id: 'workspace', agent: 'claude', agent_status: 'blocked', agent_session: { value: 'session-a' } }],
            focused_pane_id: callsToSnapshot === 1 ? 'other:pane' : 'workspace:pane',
          };
        },
      };
    },
    handleStatusChanged: async () => ({ status: 'native-handoff' }),
    installSignalHandlers: false,
  });

  assert.equal(result.status, 'error');
  assert.deepEqual(calls, ['enqueue', 'cancel', 'takeResponse']);
});
