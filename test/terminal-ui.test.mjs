import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createViewModel,
  reduceKey,
  render,
  layoutViewModel,
  deliverSelection,
} from '../src/terminal-ui.mjs';

function req(overrides = {}) {
  return {
    schema_version: 1,
    request_id: 'r1',
    created_at_ms: 1_000,
    source: { agent: 'claude', pane_id: 'w1:p1', workspace_id: 'w1', session_id: 's1', cwd: '/work' },
    kind: 'question',
    transport: 'hook-response',
    status: 'waiting',
    title: 'Framework',
    questions: [{
      question: 'Which framework?',
      header: 'Framework',
      options: [{ label: 'React', description: 'A UI library' }, { label: 'Vue', description: 'A framework' }],
      multiSelect: false,
    }],
    ...overrides,
  };
}

const SIZE = { columns: 82, rows: 26 };

// press a sequence of keys, laying out between each so number-key guards see a layout
function drive(view, keys) {
  let state = view;
  for (const key of keys) {
    state = layoutViewModel(state, SIZE);
    state = reduceKey(state, key);
  }
  return state;
}

test('createViewModel builds a question view with answer options plus a custom option', () => {
  const view = createViewModel(req(), { index: 2, total: 3 });
  assert.equal(view.kind, 'question');
  assert.equal(view.queuePosition.index, 2);
  assert.equal(view.queuePosition.total, 3);
  const options = view.questionOptions[0];
  assert.deepEqual(options.map((o) => o.type), ['answer-option', 'answer-option', 'custom']);
});

test('createViewModel marks an unsupported request as handoff-only', () => {
  const view = createViewModel(req({ source: { agent: 'codex', pane_id: 'w1:p1', workspace_id: 'w1', session_id: 's1' } }));
  assert.equal(view.unsupported, true);
  assert.deepEqual(view.options.map((o) => o.type), ['handoff']);
});

test('reduceKey navigates with arrows and vi keys and wraps', () => {
  const view = createViewModel(req());
  assert.equal(reduceKey(view, 'down').cursor, 1);
  assert.equal(reduceKey(view, 'j').cursor, 1);
  assert.equal(reduceKey(view, 'up').cursor, 2); // wrap to custom
  assert.equal(reduceKey(view, 'k').cursor, 2);
});

test('a number key selects and confirms a single-select answer', () => {
  const view = createViewModel(req());
  const next = drive(view, ['2']);
  assert.equal(next.effect.type, 'deliver');
  assert.deepEqual(next.effect.selection, { type: 'answer', value: { answers: { 'Which framework?': 'Vue' } } });
});

test('enter confirms the cursor answer', () => {
  const view = createViewModel(req());
  const next = reduceKey(view, 'enter');
  assert.deepEqual(next.effect.selection.value, { answers: { 'Which framework?': 'React' } });
});

test('g and escape both request a native handoff', () => {
  const view = createViewModel(req());
  assert.equal(reduceKey(view, 'g').effect.type, 'handoff');
  assert.equal(reduceKey(view, 'escape').effect.type, 'handoff');
});

test('multi-select toggles with space and joins the chosen labels on enter', () => {
  const view = createViewModel(req({
    questions: [{
      question: 'Which?',
      header: 'H',
      options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }, { label: 'C', description: 'c' }],
      multiSelect: true,
    }],
  }));
  let state = reduceKey(view, 'space'); // toggle A (cursor 0)
  state = reduceKey(state, 'down');
  state = reduceKey(state, 'down'); // cursor 2 (C)
  state = reduceKey(state, 'space'); // toggle C
  state = reduceKey(state, 'enter');
  assert.deepEqual(state.effect.selection.value, { answers: { 'Which?': 'A, C' } });
});

test('the custom option opens an editor and free text becomes the answer', () => {
  const view = createViewModel(req());
  let state = drive(view, ['3']); // custom option
  assert.equal(state.editing, true);
  for (const ch of ['S', 'o', 'l', 'i', 'd']) state = reduceKey(state, ch);
  state = reduceKey(state, 'backspace');
  state = reduceKey(state, 'enter');
  assert.deepEqual(state.effect.selection.value, { answers: { 'Which framework?': 'Soli' } });
});

test('multi-question flow advances then delivers all answers', () => {
  const view = createViewModel(req({
    title: 'Q1',
    questions: [
      { question: 'Q1?', header: 'Q1', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false },
      { question: 'Q2?', header: 'Q2', options: [{ label: 'C', description: 'c' }, { label: 'D', description: 'd' }], multiSelect: false },
    ],
  }));
  let state = reduceKey(view, 'enter'); // Q1 → A, advance
  assert.equal(state.questionIndex, 1);
  assert.equal(state.effect, null);
  state = reduceKey(state, 'down'); // cursor D
  state = reduceKey(state, 'enter');
  assert.deepEqual(state.effect.selection.value, { answers: { 'Q1?': 'A', 'Q2?': 'D' } });
});

test('render shows provenance, the question, choices, and the fixed footer', () => {
  const view = createViewModel(req());
  const out = render(view, SIZE);
  assert.match(out, /Agent claude · Workspace w1/);
  assert.match(out, /Pane w1:p1/);
  assert.match(out, /Which framework\?/);
  assert.match(out, /React/);
  assert.match(out, /go to agent/);
});

test('render clamps dimensions and neutralizes control characters', () => {
  const view = createViewModel(req({
    questions: [{
      question: 'Badbell?',
      header: 'H',
      options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      multiSelect: false,
    }],
  }));
  const out = render(view, { columns: 5, rows: 4 });
  assert.doesNotMatch(out, //);
  for (const line of out.split('\n')) assert.ok([...line].length <= 5 * 2);
});

test('render stays plain when color is not requested', () => {
  const out = render(createViewModel(req()), SIZE);
  assert.doesNotMatch(out, /\[/);
});

test('render styles the question and cursor option when color is enabled, without changing width', () => {
  const view = createViewModel(req());
  const colored = render(view, { ...SIZE, color: true });
  assert.match(colored, /\[/); // has ANSI
  assert.match(colored, /\[1m\[36m/); // bold + cyan cursor row
  // stripping ANSI recovers the exact plain rendering (styling is width-neutral)
  const stripped = colored.replace(/\[[0-9;]*m/gu, '');
  assert.equal(stripped, render(view, SIZE));
});

test('render marks toggled multi-select rows in a distinct color', () => {
  const view = createViewModel(req({
    questions: [{
      question: 'Which?', header: 'H',
      options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      multiSelect: true,
    }],
  }));
  let toggled = reduceKey(view, 'space'); // check A (cursor 0)
  toggled = reduceKey(toggled, 'down'); // move cursor to B → A is checked but not the cursor
  const colored = render(toggled, { ...SIZE, color: true });
  assert.match(colored, /\[32m/); // green marks a checked row
});

test('deliverSelection publishes an answer response to the queue', async () => {
  const responded = [];
  const queue = { respond: async (r) => { responded.push(r); } };
  const herdr = { focusAgent: async () => {} };
  const result = await deliverSelection(
    req(),
    { type: 'answer', value: { answers: { 'Which framework?': 'React' } } },
    { queue, herdr, now: () => 5_000 },
  );
  assert.equal(result.status, 'answered');
  assert.equal(responded.length, 1);
  assert.equal(responded[0].action, 'answer');
  assert.deepEqual(responded[0].value, { answers: { 'Which framework?': 'React' } });
});

test('deliverSelection handoff responds handoff and focuses the source pane', async () => {
  const responded = [];
  const focused = [];
  const queue = { respond: async (r) => { responded.push(r); } };
  const herdr = { focusAgent: async (pane) => { focused.push(pane); } };
  const result = await deliverSelection(req(), { type: 'handoff' }, { queue, herdr, now: () => 5_000 });
  assert.equal(result.status, 'handed-off');
  assert.equal(result.focused, true);
  assert.equal(responded[0].action, 'handoff');
  assert.deepEqual(focused, ['w1:p1']);
});

test('deliverSelection falls back to native handoff on a malformed answer', async () => {
  const responded = [];
  const focused = [];
  const queue = { respond: async (r) => { responded.push(r); } };
  const herdr = { focusAgent: async (pane) => { focused.push(pane); } };
  // answers do not cover the question → encodeResponse throws → native handoff
  const result = await deliverSelection(
    req(),
    { type: 'answer', value: { answers: {} } },
    { queue, herdr, now: () => 5_000 },
  );
  assert.equal(result.status, 'handed-off');
  assert.equal(responded[0].action, 'handoff');
  assert.deepEqual(focused, ['w1:p1']);
});
