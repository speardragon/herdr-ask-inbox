import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as claude from '../src/adapters/claude.mjs';
import * as codex from '../src/adapters/codex.mjs';

const env = {
  HERDR_PANE_ID: 'w1:p1',
  HERDR_WORKSPACE_ID: 'w1',
  CLAUDE_CODE_VERSION: '2.1.0',
  CODEX_VERSION: '0.101.0',
};

function response(request, action, value) {
  return {
    schema_version: 1,
    request_id: request.request_id,
    action,
    value,
    created_at_ms: request.created_at_ms + 1,
  };
}

async function fixture(relativePath) {
  return JSON.parse(await readFile(new URL(`../fixtures/${relativePath}`, import.meta.url), 'utf8'));
}

test('Claude AskUserQuestion keeps exact structured choices for hook response transport', async () => {
  const payload = await fixture('claude/ask-user-question.json');
  const request = claude.normalizeHook(payload, env);

  assert.equal(request.kind, 'question');
  assert.equal(request.transport, 'hook-response');
  assert.equal(request.status, 'waiting');
  assert.deepEqual(request.questions, payload.tool_input.questions);
  assert.deepEqual(request.questions[0].options.map(({ label }) => label), ['React', 'Vue']);
});

test('Claude PermissionRequest retains only exact native input and permission suggestions', async () => {
  const payload = await fixture('claude/permission-request.json');
  const request = claude.normalizeHook(payload, env);

  assert.equal(request.kind, 'permission');
  assert.equal(request.transport, 'hook-response');
  assert.deepEqual(request.permission, {
    tool_name: payload.tool_name,
    tool_input: payload.tool_input,
    suggestions: payload.permission_suggestions,
  });
  request.permission.suggestions[0].rules[0].ruleContent = 'changed';
  assert.equal(payload.permission_suggestions[0].rules[0].ruleContent, 'npm test');
});

test('Codex request_user_input is armed with exact choices for terminal transport', async () => {
  const payload = await fixture('codex/request-user-input.json');
  const request = codex.normalizeHook(payload, env);

  assert.equal(request.kind, 'question');
  assert.equal(request.transport, 'terminal-keys');
  assert.equal(request.status, 'armed');
  assert.deepEqual(request.questions, payload.tool_input.questions);
  assert.deepEqual(request.questions[0].options.map(({ label }) => label), ['React', 'Vue']);
});

test('Codex PermissionRequest retains exact native input and upstream suggestions', async () => {
  const payload = await fixture('codex/permission-request.json');
  const request = codex.normalizeHook(payload, env);

  assert.equal(request.kind, 'permission');
  assert.equal(request.transport, 'hook-response');
  assert.equal(request.status, 'waiting');
  assert.deepEqual(request.permission, {
    tool_name: payload.tool_name,
    tool_input: payload.tool_input,
    suggestions: payload.permission_suggestions,
  });
});

test('Claude question answers echo the exact questions and add the selected answers', async () => {
  const payload = await fixture('claude/ask-user-question.json');
  const request = claude.normalizeHook(payload, env);
  const answers = { 'Which framework?': 'React' };

  assert.deepEqual(
    claude.encodeResponse(request, response(request, 'answer', { answers })),
    {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          questions: payload.tool_input.questions,
          answers,
        },
      },
    },
  );
});

test('Claude persistent permission copies only the exact selected upstream suggestion', async () => {
  const payload = await fixture('claude/permission-request.json');
  const request = claude.normalizeHook(payload, env);
  const suggestion = request.permission.suggestions[0];

  assert.deepEqual(
    claude.encodeResponse(request, response(request, 'answer', { permission: suggestion })),
    {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [payload.permission_suggestions[0]],
        },
      },
    },
  );
  assert.throws(
    () => claude.encodeResponse(request, response(request, 'answer', {
      permission: { ...suggestion, destination: 'userSettings' },
    })),
    /upstream permission suggestion/,
  );
  assert.deepEqual(
    claude.encodeResponse(request, response(request, 'answer', { suggestion_index: 0 })),
    {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [payload.permission_suggestions[0]],
        },
      },
    },
  );
});

test('Claude permission allows once, denies with a message, and emits nothing on handoff', async () => {
  const request = claude.normalizeHook(await fixture('claude/permission-request.json'), env);

  assert.deepEqual(
    claude.encodeResponse(request, response(request, 'answer', { permission: null })),
    {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    },
  );
  assert.deepEqual(
    claude.encodeResponse(request, response(request, 'deny', { message: 'Not now.' })),
    {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Not now.' },
      },
    },
  );
  assert.equal(claude.encodeResponse(request, response(request, 'handoff', null)), null);
});

test('Codex permission encodes native decisions and copies persistent suggestions unchanged', async () => {
  const payload = await fixture('codex/permission-request.json');
  const request = codex.normalizeHook(payload, env);

  assert.deepEqual(
    codex.encodeResponse(request, response(request, 'answer', { permission: null })),
    {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    },
  );
  assert.deepEqual(
    codex.encodeResponse(request, response(request, 'answer', { suggestion_index: 0 })),
    {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: payload.permission_suggestions[0],
      },
    },
  );
  assert.deepEqual(
    codex.encodeResponse(request, response(request, 'deny', { message: 'Not now.' })),
    {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Not now.' },
      },
    },
  );
  assert.equal(codex.encodeResponse(request, response(request, 'handoff', null)), null);
});

test('Codex question key planning validates the captured screen before naming keys', async () => {
  const request = codex.normalizeHook(await fixture('codex/request-user-input.json'), env);
  const matchingScreen = [
    '? Which framework?',
    '› React  Use React for the example UI.',
    '  Vue    Use Vue for the example UI.',
  ].join('\n');

  assert.deepEqual(codex.planQuestionKeys(request, 'Vue', matchingScreen), {
    ok: true,
    reason: null,
    keys: ['down', 'enter'],
  });
  assert.deepEqual(codex.planQuestionKeys(request, 'Vue', 'Different prompt'), {
    ok: false,
    reason: 'screen_mismatch',
    keys: [],
  });
});

test('adapters reject malformed choices and ambiguous persistent selections', async () => {
  const claudePayload = await fixture('claude/ask-user-question.json');
  claudePayload.tool_input.questions[0].options[0].description = '';
  assert.throws(() => claude.normalizeHook(claudePayload, env), /description/);

  const codexPayload = await fixture('codex/request-user-input.json');
  delete codexPayload.tool_input.questions[0].options[0].label;
  assert.throws(() => codex.normalizeHook(codexPayload, env), /label/);

  const permissionRequest = claude.normalizeHook(
    await fixture('claude/permission-request.json'),
    env,
  );
  assert.throws(() => claude.encodeResponse(
    permissionRequest,
    response(permissionRequest, 'answer', { permission: null, suggestion_index: 0 }),
  ), /ambiguous|permission selection/);

  const codexPermission = codex.normalizeHook(
    await fixture('codex/permission-request.json'),
    env,
  );
  assert.throws(() => codex.encodeResponse(
    codexPermission,
    response(codexPermission, 'answer', { permission: null, suggestion_index: 0 }),
  ), /ambiguous|permission selection/);
});
