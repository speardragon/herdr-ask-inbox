import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as claude from '../src/adapters/claude.mjs';

const env = { HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', CLAUDE_CODE_VERSION: '2.0.0' };

async function fixture(name) {
  const raw = await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
  return JSON.parse(raw);
}

function response(request, action, value) {
  return {
    schema_version: 1,
    request_id: request.request_id,
    action,
    value,
    created_at_ms: 2_000,
  };
}

test('Claude AskUserQuestion keeps exact structured choices for hook response transport', async () => {
  const request = claude.normalizeHook(await fixture('claude/ask-user-question.json'), env);
  assert.equal(request.source.agent, 'claude');
  assert.equal(request.kind, 'question');
  assert.equal(request.transport, 'hook-response');
  assert.equal(request.status, 'waiting');
  assert.equal(request.title, 'Framework');
  assert.equal(request.questions.length, 1);
  assert.deepEqual(request.questions[0].options.map((option) => option.label), ['React', 'Vue']);
  assert.equal(request.questions[0].multiSelect, false);
  assert.equal(request.detail.tool_name, 'AskUserQuestion');
  assert.equal(request.detail.agent_version, '2.0.0');
});

test('Claude rejects non-AskUserQuestion payloads (permission requests are not hooked)', async () => {
  const permission = {
    session_id: 's1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  };
  assert.throws(() => claude.normalizeHook(permission, env), /unsupported Claude hook payload/);
  const otherTool = {
    session_id: 's1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  };
  assert.throws(() => claude.normalizeHook(otherTool, env), /unsupported Claude hook payload/);
});

test('Claude question answers echo the exact questions and add the selected answers', async () => {
  const request = claude.normalizeHook(await fixture('claude/ask-user-question.json'), env);
  const encoded = claude.encodeResponse(
    request,
    response(request, 'answer', { answers: { 'Which framework?': 'React' } }),
  );
  assert.equal(encoded.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(encoded.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(encoded.hookSpecificOutput.updatedInput.answers, { 'Which framework?': 'React' });
  assert.deepEqual(
    encoded.hookSpecificOutput.updatedInput.questions.map((q) => q.question),
    ['Which framework?'],
  );
});

test('Claude answers must target every question exactly once', async () => {
  const request = claude.normalizeHook(await fixture('claude/ask-user-question.json'), env);
  assert.throws(
    () => claude.encodeResponse(request, response(request, 'answer', { answers: {} })),
    /every question/,
  );
  assert.throws(
    () => claude.encodeResponse(request, response(request, 'answer', { answers: { 'Which framework?': '' } })),
    /answer for/,
  );
  assert.throws(
    () => claude.encodeResponse(request, response(request, 'answer', { notAnswers: true })),
    /answers object/,
  );
});

test('Claude handoff emits no decision', async () => {
  const request = claude.normalizeHook(await fixture('claude/ask-user-question.json'), env);
  assert.equal(claude.encodeResponse(request, response(request, 'handoff', null)), null);
});

test('Claude defaults optional multiSelect and trims/rejects malformed choices', async () => {
  const payload = await fixture('claude/ask-user-question.json');
  delete payload.tool_input.questions[0].multiSelect;
  const request = claude.normalizeHook(payload, env);
  assert.equal(request.questions[0].multiSelect, false);

  const duplicate = await fixture('claude/ask-user-question.json');
  duplicate.tool_input.questions[0].options[1].label = 'React';
  assert.throws(() => claude.normalizeHook(duplicate, env), /duplicate option/);

  const malformed = await fixture('claude/ask-user-question.json');
  delete malformed.tool_input.questions[0].options[0].label;
  assert.throws(() => claude.normalizeHook(malformed, env), /label/);
});

test('Claude requires the injected pane and workspace identity', async () => {
  const payload = await fixture('claude/ask-user-question.json');
  assert.throws(() => claude.normalizeHook(payload, { HERDR_WORKSPACE_ID: 'w1' }), /HERDR_PANE_ID/);
  assert.throws(() => claude.normalizeHook(payload, { HERDR_PANE_ID: 'w1:p1' }), /HERDR_WORKSPACE_ID/);
});

test('identical requests reuse a stable id via tool_use_id but differ without one', async () => {
  const payload = await fixture('claude/ask-user-question.json');
  const first = claude.normalizeHook(payload, env);
  const second = claude.normalizeHook(payload, env);
  assert.equal(first.request_id, second.request_id); // stable tool_use_id

  const noId = await fixture('claude/ask-user-question.json');
  delete noId.tool_use_id;
  assert.notEqual(claude.normalizeHook(noId, env).request_id, claude.normalizeHook(noId, env).request_id);
});
