import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openQueue } from '../src/queue.mjs';
import {
  createViewModel,
  deliverSelection,
  layoutViewModel,
  reduceKey,
  render,
} from '../src/terminal-ui.mjs';

function questionRequest({
  agent = 'claude',
  transport = 'hook-response',
  questions,
} = {}) {
  return {
    schema_version: 1,
    request_id: 'request-question',
    created_at_ms: 10,
    source: {
      agent,
      pane_id: 'workspace-a:pane-a',
      workspace_id: 'workspace-a',
      session_id: 'session-a',
      cwd: '/workspace/project',
    },
    kind: 'question',
    transport,
    title: 'Framework',
    detail: transport === 'terminal-keys' ? {
      agent_version: '0.101.0',
      screen_profile: 'codex-request-user-input-v1',
      screen_signature: {
        question_id: 'framework',
        question: 'Which framework?',
        options: [
          { label: 'React', description: 'Use React.' },
          { label: 'Vue', description: 'Use Vue.' },
        ],
      },
    } : {},
    questions: questions ?? [{
      ...(agent === 'codex' ? { id: 'framework' } : {}),
      question: 'Which framework?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'Use React.' },
        { label: 'Vue', description: 'Use Vue.' },
      ],
      ...(agent === 'claude' ? { multiSelect: false } : {}),
    }],
    permission: null,
    status: transport === 'terminal-keys' ? 'armed' : 'waiting',
  };
}

function permissionRequest({
  agent = 'claude',
  suggestions = [{
    type: 'addRules',
    behavior: 'allow',
    destination: 'localSettings',
    rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
  }],
} = {}) {
  return {
    schema_version: 1,
    request_id: `request-${agent}-permission`,
    created_at_ms: 10,
    source: {
      agent,
      pane_id: 'workspace-a:pane-a',
      workspace_id: 'workspace-a',
      session_id: 'session-a',
      cwd: '/workspace/project',
    },
    kind: 'permission',
    transport: 'hook-response',
    title: 'Approve Bash',
    detail: { tool_name: 'Bash' },
    questions: null,
    permission: {
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run tests.' },
      ...(agent === 'claude' ? { suggestions } : {}),
    },
    status: 'waiting',
  };
}

test('reducer navigates safely and g or escape always requests native handoff', () => {
  const initial = createViewModel(questionRequest(), { index: 1, total: 2 });

  assert.equal(reduceKey(initial, 'down').cursor, 1);
  assert.equal(reduceKey(initial, 'j').cursor, 1);
  assert.equal(reduceKey({ ...initial, cursor: 1 }, 'up').cursor, 0);
  assert.equal(reduceKey({ ...initial, cursor: 1 }, 'k').cursor, 0);
  assert.equal(reduceKey(initial, 'g').effect.type, 'handoff');
  assert.equal(reduceKey(initial, 'escape').effect.type, 'handoff');
});

test('space toggles only multi-select options', () => {
  const questions = questionRequest().questions;
  questions[0].multiSelect = true;
  const multi = createViewModel(questionRequest({ questions }), { index: 1, total: 1 });
  const single = createViewModel(questionRequest(), { index: 1, total: 1 });

  assert.deepEqual([...reduceKey(multi, 'space').selected], [0]);
  assert.deepEqual([...reduceKey(single, 'space').selected], []);
});

test('number keys confirm single choices and only toggle multi-select choices', () => {
  const single = createViewModel(questionRequest(), { index: 1, total: 1 });
  const singleNumber = reduceKey(single, '2');
  assert.equal(singleNumber.cursor, 1);
  assert.deepEqual(singleNumber.effect.selection, {
    type: 'answer',
    value: { answers: { 'Which framework?': 'Vue' } },
  });

  const questions = questionRequest().questions;
  questions[0].multiSelect = true;
  const multi = createViewModel(questionRequest({ questions }), { index: 1, total: 1 });
  const multiNumber = reduceKey(multi, '2');
  assert.equal(multiNumber.cursor, 1);
  assert.deepEqual([...multiNumber.selected], [1]);
  assert.equal(multiNumber.effect, null);

  const permission = createViewModel(permissionRequest(), { index: 1, total: 1 });
  const focusedPersistent = reduceKey(permission, '2');
  assert.equal(focusedPersistent.cursor, 1);
  assert.equal(focusedPersistent.effect, null);
  assert.equal(reduceKey(focusedPersistent, 'enter').effect.type, 'handoff');
  const informed = layoutViewModel(focusedPersistent, { columns: 82, rows: 26 });
  assert.equal(reduceKey(informed, 'enter').effect.selection.type, 'persistent');
});

test('reducer completes multiple and multi-select questions without changing option text', () => {
  const request = questionRequest({
    questions: [{
      question: 'Which extras?',
      header: 'Extras',
      options: [
        { label: 'Tests', description: 'Include tests.' },
        { label: 'Docs', description: 'Include docs.' },
      ],
      multiSelect: true,
    }, {
      question: 'Release note?',
      header: 'Release',
      options: [
        { label: 'Short', description: 'Use a short note.' },
        { label: 'Detailed', description: 'Use a detailed note.' },
      ],
      multiSelect: false,
    }],
  });
  let state = createViewModel(request, { index: 1, total: 1 });
  state = reduceKey(state, 'space');
  state = reduceKey(state, 'down');
  state = reduceKey(state, 'space');
  state = reduceKey(state, 'enter');
  assert.equal(state.questionIndex, 1);
  assert.equal(state.answers['Which extras?'], 'Tests, Docs');

  state = { ...state, cursor: 2 };
  state = reduceKey(state, 'enter');
  assert.equal(state.editing, true);
  state = reduceKey(state, 'A custom note');
  state = reduceKey(state, 'enter');
  assert.deepEqual(state.effect.selection, {
    type: 'answer',
    value: {
      answers: {
        'Which extras?': 'Tests, Docs',
        'Release note?': 'A custom note',
      },
    },
  });
});

test('renderer shows exact provenance, choices, permission scope, and fixed footer', () => {
  let vm = createViewModel(permissionRequest(), { index: 2, total: 3 });
  vm = layoutViewModel(reduceKey(vm, '2'), { columns: 82, rows: 60 });
  const output = render(vm, { columns: 82, rows: 60 });

  const continuous = output.replace(/\n\s*/gu, '');
  for (const expected of [
    '2/3',
    'claude',
    'workspace-a',
    'workspace-a:pane-a',
    '/workspace/project',
    'permission',
    'Allow once',
    'Persist upstream suggestion 1',
    'localSettings',
    'npm test',
    'Deny',
    'Go to agent',
    'Enter answer · g go to agent · Esc native handoff',
  ]) {
    assert.equal(continuous.includes(expected), true, `missing ${expected}`);
  }
});

test('renderer clamps dimensions, wraps long tokens, and neutralizes terminal controls', () => {
  const request = permissionRequest();
  request.title = `unsafe\u001b]8;;https://bad.example\u0007click\u001b[31m${'x'.repeat(120)}`;
  request.permission.tool_input.command = `\u009b31m${'y'.repeat(120)}\u202E`;
  const output = render(createViewModel(request, { index: 1, total: 1 }), {
    columns: 19,
    rows: 14,
  });

  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202E]/u.test(output), false);
  assert.equal(output.includes('omitted'), true);
  assert.equal(output.split('\n').every((line) => [...line].length <= 19), true);
  assert.equal(output.split('\n').length <= 14, true);
  assert.equal(output.replace(/\n\s*/gu, '').endsWith('native handoff'), true);

  const tiny = render(createViewModel(questionRequest(), { index: 1, total: 1 }), {
    columns: 4,
    rows: 100,
  });
  assert.equal(tiny.split('\n').every((line) => [...line].length <= 4), true);
});

test('renderer reserves every permission action and footer when details are very long', () => {
  const request = permissionRequest();
  request.permission.tool_input.command = 'x'.repeat(2_200);
  let vm = createViewModel(request, { index: 1, total: 1 });
  vm = reduceKey(vm, '2');
  vm = layoutViewModel(vm, { columns: 82, rows: 26 });
  const output = render(vm, {
    columns: 82,
    rows: 26,
  });

  for (const label of [
    'Allow once',
    'Persist upstream suggestion 1',
    'Exact scope',
    'localSettings',
    'npm test',
    'Deny',
    'Go to agent',
    'Enter answer · g go to agent · Esc native handoff',
    'omitted',
  ]) {
    assert.equal(output.includes(label), true, `missing reserved text: ${label}`);
  }
  assert.equal(output.split('\n').length <= 26, true);
  assert.equal(output.split('\n').every((line) => [...line].length <= 82), true);
});

test('permission choice viewport follows the cursor and marks hidden adjacent choices', () => {
  const suggestions = Array.from({ length: 14 }, (_, index) => ({
    type: 'addRules',
    behavior: 'allow',
    destination: `scope-${index + 1}`,
    rules: [{ toolName: 'Bash', ruleContent: `command-${index + 1}` }],
  }));
  let vm = createViewModel(permissionRequest({ suggestions }), { index: 1, total: 1 });
  for (let count = 0; count < 10; count += 1) vm = reduceKey(vm, 'down');
  vm = layoutViewModel(vm, { columns: 82, rows: 26 });
  const output = render(vm, { columns: 82, rows: 26 });

  assert.equal(output.includes('Persist upstream suggestion 10'), true);
  assert.equal(output.includes('↑ more choices'), true);
  assert.equal(output.includes('↓ more choices'), true);
  assert.equal(output.split('\n').length <= 26, true);
});

test('number keys cannot choose an option hidden by the current viewport', () => {
  const request = questionRequest({
    questions: [{
      question: 'Choose one?',
      header: 'Many choices',
      options: Array.from({ length: 12 }, (_, index) => ({
        label: `Choice ${index + 1}`,
        description: `Description ${index + 1}.`,
      })),
      multiSelect: false,
    }],
  });
  let vm = createViewModel(request, { index: 1, total: 1 });
  for (let count = 0; count < 9; count += 1) vm = reduceKey(vm, 'down');
  vm = layoutViewModel(vm, { columns: 82, rows: 26 });
  assert.equal(vm.layout.visible_option_indices.includes(0), false);

  const hidden = reduceKey(vm, '1');
  assert.equal(hidden.cursor, vm.cursor);
  assert.equal(hidden.effect, null);

  const withoutLayout = reduceKey({ ...vm, layout: null }, '1');
  assert.deepEqual(withoutLayout.effect.selection, {
    type: 'answer',
    value: { answers: { 'Choose one?': 'Choice 1' } },
  });
});

test('persistent approval without a fully visible exact scope becomes native handoff', () => {
  const suggestions = [{
    type: 'addRules',
    behavior: 'allow',
    destination: 'localSettings',
    rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(3_000) }],
  }];
  let vm = createViewModel(permissionRequest({ suggestions }), { index: 1, total: 1 });
  vm = reduceKey(vm, '2');
  vm = layoutViewModel(vm, { columns: 40, rows: 12 });
  const result = reduceKey(vm, 'enter');
  assert.equal(result.effect.type, 'handoff');
  assert.match(result.effect.selection.reason, /scope/i);
});

test('long permission input cannot be approved at the default 82x26 popup size', () => {
  const request = permissionRequest();
  request.permission.tool_input.command = 'x'.repeat(3_000);
  const vm = layoutViewModel(createViewModel(request, { index: 1, total: 1 }), {
    columns: 82,
    rows: 26,
  });

  const result = reduceKey(vm, 'enter');
  assert.equal(vm.layout.permission_detail_fully_visible, false);
  assert.deepEqual(result.effect, {
    type: 'handoff',
    selection: {
      type: 'handoff',
      reason: 'permission detail was not fully visible',
    },
  });
});

test('Codex permission view never invents a persistent rule', () => {
  const vm = createViewModel(permissionRequest({ agent: 'codex' }), { index: 1, total: 1 });
  assert.deepEqual(vm.options.map(({ type }) => type), ['allow-once', 'deny', 'handoff']);
});

test('Codex terminal choices require the exact supported one-question screen contract', () => {
  const supported = questionRequest({ agent: 'codex', transport: 'terminal-keys' });
  assert.equal(createViewModel(supported, { index: 1, total: 1 }).unsupported, undefined);

  const unknownVersion = structuredClone(supported);
  unknownVersion.detail.agent_version = '9.9.9';
  const multiple = structuredClone(supported);
  multiple.questions.push(structuredClone(multiple.questions[0]));
  multiple.questions[1].id = 'second';
  multiple.questions[1].question = 'Second question?';
  const invalidSignature = structuredClone(supported);
  invalidSignature.detail.screen_signature.options[0].description = 'Changed.';

  for (const request of [unknownVersion, multiple, invalidSignature]) {
    const vm = createViewModel(request, { index: 1, total: 1 });
    assert.equal(vm.unsupported, true);
    assert.deepEqual(vm.options.map(({ type }) => type), ['handoff']);
  }
});

test('unsupported but schema-valid requests expose only native handoff', () => {
  const request = questionRequest();
  request.questions = [];
  const vm = createViewModel(request, { index: 1, total: 1 });
  assert.equal(vm.unsupported, true);
  assert.deepEqual(vm.options.map(({ type }) => type), ['handoff']);
  assert.equal(render(vm, { columns: 82, rows: 26 }).includes('Go to agent'), true);
});

async function temporaryQueue(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openQueue(root);
}

function herdrFor(request, {
  screen,
  sessionId = request.source.session_id,
  paneId = request.source.pane_id,
  workspaceId = request.source.workspace_id,
  status = 'blocked',
} = {}) {
  const calls = [];
  const api = {
    snapshot: async () => ({
      focused_workspace_id: request.source.workspace_id,
      panes: [],
      agents: [{
        pane_id: paneId,
        workspace_id: workspaceId,
        agent: request.source.agent,
        agent_status: status,
        agent_session: { kind: 'id', value: sessionId, agent: request.source.agent },
      }],
    }),
    readPane: async (id) => {
      calls.push({ name: 'readPane', id });
      return screen;
    },
    sendAgentKeys: async (id, keys) => {
      calls.push({ name: 'sendAgentKeys', id, keys: [...keys] });
    },
    focusAgent: async (id) => {
      calls.push({ name: 'focusAgent', id });
    },
    releaseBlocked: async (value) => {
      calls.push({ name: 'releaseBlocked', id: value.request_id });
    },
    notify: async (title, body) => {
      calls.push({ name: 'notify', title, body });
    },
  };
  return { api, calls };
}

test('Claude delivery publishes exact multi-question answers and upstream persistent suggestion', async (t) => {
  const request = questionRequest({
    questions: [{
      question: 'Which framework?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'Use React.' },
        { label: 'Vue', description: 'Use Vue.' },
      ],
      multiSelect: false,
    }, {
      question: 'Which extras?',
      header: 'Extras',
      options: [
        { label: 'Tests', description: 'Include tests.' },
        { label: 'Docs', description: 'Include docs.' },
      ],
      multiSelect: true,
    }],
  });
  const queue = await temporaryQueue(t);
  await queue.enqueue(request);
  const { api } = herdrFor(request);
  await deliverSelection(request, {
    type: 'answer',
    value: {
      answers: {
        'Which framework?': 'React',
        'Which extras?': 'Tests, Docs',
      },
    },
  }, { queue, herdr: api, now: () => 20 });
  assert.deepEqual(await queue.takeResponse(request.request_id), {
    schema_version: 1,
    request_id: request.request_id,
    action: 'answer',
    value: {
      answers: {
        'Which framework?': 'React',
        'Which extras?': 'Tests, Docs',
      },
    },
    created_at_ms: 20,
  });

  const permission = permissionRequest();
  await queue.enqueue(permission);
  let vm = createViewModel(permission, { index: 1, total: 1 });
  vm = layoutViewModel(reduceKey(vm, '2'), { columns: 82, rows: 26 });
  const selection = reduceKey(vm, 'enter').effect.selection;
  await deliverSelection(permission, selection, {
    queue,
    herdr: api,
    now: () => 21,
  });
  const response = await queue.takeResponse(permission.request_id);
  assert.deepEqual(response.value.permission, permission.permission.suggestions[0]);
  assert.notEqual(response.value.permission, permission.permission.suggestions[0]);
});

test('allow once and deny use only official hook response decisions', async (t) => {
  const queue = await temporaryQueue(t);
  const allowRequest = permissionRequest();
  const allowSelection = reduceKey(layoutViewModel(
    createViewModel(allowRequest, { index: 1, total: 1 }),
    { columns: 82, rows: 26 },
  ), 'enter').effect.selection;
  for (const [request, selection, expected] of [
    [allowRequest, allowSelection, ['answer', { permission: null }]],
    [permissionRequest({ agent: 'codex' }), { type: 'deny' }, ['deny', {}]],
  ]) {
    await queue.enqueue(request);
    const { api } = herdrFor(request);
    await deliverSelection(request, selection, { queue, herdr: api, now: () => 20 });
    const response = await queue.takeResponse(request.request_id);
    assert.equal(response.action, expected[0]);
    assert.deepEqual(response.value, expected[1]);
  }
});

test('delivery rejects an approval selection without the current layout digest', async (t) => {
  const request = permissionRequest();
  const queue = await temporaryQueue(t);
  await queue.enqueue(request);
  const { api } = herdrFor(request);
  let handedOff = false;

  const result = await deliverSelection(request, { type: 'allow-once' }, {
    queue,
    herdr: api,
    handoff: async () => {
      handedOff = true;
      await queue.cancel(request.request_id);
      return { status: 'handed-off', focused: true };
    },
  });

  assert.equal(handedOff, true);
  assert.equal(result.status, 'handed-off');
  assert.equal((await queue.takeResponse(request.request_id)).action, 'handoff');
});

test('delivery refuses an unverified Claude persistent selection and hands off natively', async (t) => {
  const request = permissionRequest();
  const queue = await temporaryQueue(t);
  await queue.enqueue(request);
  const { api, calls } = herdrFor(request);
  let handedOff = false;
  const result = await deliverSelection(request, { type: 'persistent', index: 0 }, {
    queue,
    herdr: api,
    handoff: async () => {
      handedOff = true;
      await queue.cancel(request.request_id);
      return { status: 'handed-off', focused: true };
    },
  });

  assert.equal(handedOff, true);
  assert.equal(result.status, 'handed-off');
  assert.equal((await queue.takeResponse(request.request_id)).action, 'handoff');
  assert.equal(calls.some(({ name }) => name === 'notify'), true);
});

test('validated Codex terminal delivery sends only planned named keys and retires response state', async (t) => {
  const request = questionRequest({ agent: 'codex', transport: 'terminal-keys' });
  const queue = await temporaryQueue(t);
  await queue.enqueue(request);
  const screen = [
    '? Which framework?',
    '› React  Use React.',
    '  Vue  Use Vue.',
  ].join('\n');
  const { api, calls } = herdrFor(request, { screen });

  assert.deepEqual(
    await deliverSelection(request, { type: 'answer', value: 'Vue' }, { queue, herdr: api }),
    { status: 'answered', keys: ['down', 'enter'] },
  );
  assert.deepEqual(
    calls.filter(({ name }) => name === 'sendAgentKeys'),
    [{ name: 'sendAgentKeys', id: request.source.pane_id, keys: ['down', 'enter'] }],
  );
  assert.deepEqual(await queue.list(), []);
  assert.equal(await queue.takeResponse(request.request_id), null);
  assert.deepEqual(await readdir(join(queue.root, 'responses')), []);
  assert.deepEqual(await readdir(join(queue.root, 'response-claims')), []);
});

test('stale workspace, session, or screen mismatch sends zero keys and performs native focus handoff', async (t) => {
  const matchingScreen = [
    '? Which framework?',
    '› React  Use React.',
    '  Vue  Use Vue.',
  ].join('\n');
  for (const variant of ['stale-workspace', 'stale-session', 'screen-mismatch']) {
    const request = questionRequest({ agent: 'codex', transport: 'terminal-keys' });
    request.request_id = `request-${variant}`;
    const queue = await temporaryQueue(t);
    await queue.enqueue(request);
    const { api, calls } = herdrFor(request, variant === 'stale-session'
      ? { screen: matchingScreen, sessionId: 'other-session' }
      : variant === 'stale-workspace'
        ? { screen: matchingScreen, workspaceId: 'other-workspace' }
        : { screen: 'Different prompt' });

    const result = await deliverSelection(
      request,
      { type: 'answer', value: 'Vue' },
      { queue, herdr: api },
    );
    assert.equal(result.status, 'handed-off');
    assert.deepEqual(calls.filter(({ name }) => name === 'sendAgentKeys'), []);
    assert.equal(calls.some(({ name, id }) => (
      name === 'focusAgent' && id === request.source.pane_id
    )), true);
    assert.equal(calls.some(({ name }) => name === 'notify'), true);
  }
});

test('Codex persistent selection is always handed to the native agent', async (t) => {
  const request = permissionRequest({ agent: 'codex' });
  const queue = await temporaryQueue(t);
  await queue.enqueue(request);
  const { api, calls } = herdrFor(request);
  const result = await deliverSelection(request, { type: 'persistent', index: 0 }, {
    queue,
    herdr: api,
  });

  assert.equal(result.status, 'handed-off');
  assert.equal(calls.some(({ name }) => name === 'focusAgent'), true);
  assert.equal((await queue.takeResponse(request.request_id)).action, 'handoff');
});
