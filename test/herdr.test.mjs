import assert from 'node:assert/strict';
import test from 'node:test';

import { createHerdr, HerdrOperationError } from '../src/herdr.mjs';
import { captureExecFile } from './helpers/fake-herdr.mjs';

test('herdr operations pass untrusted values as individual argv items', async () => {
  const snapshot = {
    focused_workspace_id: 'w1',
    panes: [{ pane_id: 'w1:p1' }],
    agents: [],
  };
  const { calls, execFile } = captureExecFile([
    { stdout: JSON.stringify({ result: { type: 'session_snapshot', snapshot } }), stderr: '' },
    { stdout: 'Choose carefully\n', stderr: '' },
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
    {
      stdout: JSON.stringify({
        result: {
          type: 'plugin_pane_opened',
          plugin_pane: {
            plugin_id: 'ray.herdr-question',
            entrypoint: 'question',
            pane: { pane_id: 'w1:p-popup' },
          },
        },
      }),
      stderr: '',
    },
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
  ]);
  const api = createHerdr({
    bin: '/fake/herdr',
    env: { SAFE_VISIBLE: 'yes', SECRET_TOKEN: 'not-for-errors' },
    execFile,
  });

  assert.deepEqual(await api.snapshot(), snapshot);
  assert.equal(await api.readPane('w1:p1; touch /tmp/nope'), 'Choose carefully\n');
  await api.sendAgentKeys('w1:p1; touch /tmp/nope', ['down', 'enter']);
  await api.focusAgent('w1:p1; touch /tmp/nope');
  assert.equal(await api.openPopup(), 'w1:p-popup');
  await api.focusPopup('w1:p-popup; touch /tmp/nope');
  await api.notify('Needs "attention"', 'body; touch /tmp/nope');
  await api.reportBlocked({
    source: { pane_id: 'w1:p1', agent: 'claude', session_id: 'session one' },
  });
  await api.releaseBlocked({
    source: { pane_id: 'w1:p1', agent: 'claude', session_id: 'session one' },
  });

  assert.deepEqual(calls.map(({ args }) => args), [
    ['api', 'snapshot'],
    ['pane', 'read', 'w1:p1; touch /tmp/nope', '--source', 'detection', '--format', 'text'],
    ['pane', 'send-keys', 'w1:p1; touch /tmp/nope', 'down', 'enter'],
    ['agent', 'focus', 'w1:p1; touch /tmp/nope'],
    [
      'plugin', 'pane', 'open',
      '--plugin', 'ray.herdr-question',
      '--entrypoint', 'question',
      '--placement', 'popup',
      '--focus',
    ],
    ['plugin', 'pane', 'focus', 'w1:p-popup; touch /tmp/nope'],
    ['notification', 'show', 'Needs "attention"', '--body', 'body; touch /tmp/nope', '--sound', 'request'],
    [
      'pane', 'report-agent', 'w1:p1',
      '--source', 'ray.herdr-question',
      '--agent', 'claude',
      '--state', 'blocked',
      '--agent-session-id', 'session one',
    ],
    [
      'pane', 'release-agent', 'w1:p1',
      '--source', 'ray.herdr-question',
      '--agent', 'claude',
    ],
  ]);
  for (const call of calls) {
    assert.equal(call.bin, '/fake/herdr');
    assert.equal(call.options.timeout, 5_000);
    assert.equal(call.options.maxBuffer, 1_048_576);
    assert.equal(call.options.shell, false);
  }
});

test('named key transport rejects empty, unknown, and excessive key sequences', async () => {
  const { calls, execFile } = captureExecFile();
  const api = createHerdr({ execFile });

  await assert.rejects(api.sendAgentKeys('w1:p1', []), /key/i);
  await assert.rejects(api.sendAgentKeys('w1:p1', ['ctrl-x']), /key/i);
  await assert.rejects(api.sendAgentKeys('w1:p1', Array(33).fill('down')), /key/i);
  assert.equal(calls.length, 0);
});

test('snapshot and popup responses require documented structured JSON shapes', async () => {
  const malformed = captureExecFile([
    { stdout: '{"result":{"snapshot":[]}}', stderr: '' },
    { stdout: '{"result":{"unexpected":true}}', stderr: '' },
  ]);
  const api = createHerdr({ execFile: malformed.execFile });

  await assert.rejects(api.snapshot(), (error) => (
    error instanceof HerdrOperationError
      && error.operation === 'snapshot'
      && !error.message.includes('SECRET')
  ));
  await assert.rejects(api.openPopup('w1'), (error) => (
    error instanceof HerdrOperationError && error.operation === 'openPopup'
  ));
});

test('subprocess failures become typed errors without environment or stderr disclosure', async () => {
  const failure = Object.assign(new Error('spawn failed: SECRET_TOKEN=abc'), {
    code: 17,
    stderr: 'private prompt and SECRET_TOKEN=abc',
  });
  const { execFile } = captureExecFile([failure]);
  const api = createHerdr({
    env: { SECRET_TOKEN: 'abc' },
    execFile,
  });

  await assert.rejects(api.focusAgent('w1:p1'), (error) => {
    assert.ok(error instanceof HerdrOperationError);
    assert.equal(error.operation, 'focusAgent');
    assert.equal(error.exitCode, 17);
    assert.equal(error.message, 'herdr focusAgent failed');
    assert.equal(JSON.stringify(error).includes('SECRET_TOKEN'), false);
    return true;
  });
});
