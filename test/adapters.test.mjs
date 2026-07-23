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

test('Codex PermissionRequest retains exact native input without fabricating suggestions', async () => {
  const payload = await fixture('codex/permission-request.json');
  const request = codex.normalizeHook(payload, env);

  assert.equal(request.kind, 'permission');
  assert.equal(request.transport, 'hook-response');
  assert.equal(request.status, 'waiting');
  assert.deepEqual(request.permission, {
    tool_name: payload.tool_name,
    tool_input: payload.tool_input,
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

test('Codex permission emits only current allow/deny decisions and hands persistent choices native', async () => {
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
    null,
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

test('Codex key planning rejects unknown versions, stale scrollback, and ambiguous cursors', async () => {
  const payload = await fixture('codex/request-user-input.json');
  const missingVersion = codex.normalizeHook(payload, { ...env, CODEX_VERSION: undefined });
  const unknownVersion = codex.normalizeHook(payload, { ...env, CODEX_VERSION: '9.9.9' });
  const activeScreen = [
    '? Which framework?',
    '› React  Use React for the example UI.',
    '  Vue    Use Vue for the example UI.',
  ].join('\n');
  for (const request of [missingVersion, unknownVersion]) {
    assert.deepEqual(codex.planQuestionKeys(request, 'Vue', activeScreen), {
      ok: false,
      reason: 'unsupported_version',
      keys: [],
    });
  }

  const request = codex.normalizeHook(payload, env);
  const staleThenDangerous = [
    activeScreen,
    '? Approve production deletion?',
    '› Delete everything',
    '  Cancel',
  ].join('\n');
  assert.deepEqual(codex.planQuestionKeys(request, 'Vue', staleThenDangerous), {
    ok: false,
    reason: 'screen_mismatch',
    keys: [],
  });
  assert.deepEqual(codex.planQuestionKeys(request, 'Vue', activeScreen.replace('  Vue', '› Vue')), {
    ok: false,
    reason: 'screen_mismatch',
    keys: [],
  });
  assert.deepEqual(codex.planQuestionKeys(request, 'Vue', `${activeScreen}\nUnrelated trailing prompt`), {
    ok: false,
    reason: 'screen_mismatch',
    keys: [],
  });
  const changedDescription = activeScreen.replace(
    'Use Vue for the example UI.',
    'Use Vue for the example UI. Then deploy to production.',
  );
  assert.deepEqual(codex.planQuestionKeys(request, 'Vue', changedDescription), {
    ok: false,
    reason: 'screen_mismatch',
    keys: [],
  });
});

test('Claude defaults optional multiSelect and answers multi-question, multiselect, and free text', async () => {
  const payload = await fixture('claude/ask-user-question.json');
  delete payload.tool_input.questions[0].multiSelect;
  payload.tool_input.questions.push({
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
  });
  const request = claude.normalizeHook(payload, env);
  assert.equal(request.questions[0].multiSelect, false);
  const answers = {
    'Which framework?': 'React',
    'Which extras?': 'Tests, Docs',
    'Release note?': 'A custom free-text release note',
  };
  assert.equal(
    claude.encodeResponse(request, response(request, 'answer', { answers }))
      .hookSpecificOutput.updatedInput.answers['Release note?'],
    answers['Release note?'],
  );
});

test('adapters trim identity strings, reject duplicates, and drop unknown raw values', async () => {
  for (const agent of [claude, codex]) {
    const relative = agent === claude
      ? 'claude/ask-user-question.json'
      : 'codex/request-user-input.json';
    const payload = await fixture(relative);
    payload.tool_input.questions[0].question = '   ';
    assert.throws(() => agent.normalizeHook(payload, env), /question/);
  }

  const claudePayload = await fixture('claude/ask-user-question.json');
  claudePayload.tool_input.questions.push(structuredClone(claudePayload.tool_input.questions[0]));
  assert.throws(() => claude.normalizeHook(claudePayload, env), /duplicate question/);

  const codexPayload = await fixture('codex/request-user-input.json');
  codexPayload.tool_input.questions[0].options[1].label = 'React';
  assert.throws(() => codex.normalizeHook(codexPayload, env), /duplicate option/);

  const privateValue = 'raw-private-unknown-value';
  const payload = await fixture('claude/ask-user-question.json');
  payload.unknown_private = privateValue;
  payload.tool_input.questions[0].unknown_private = privateValue;
  payload.tool_input.questions[0].options[0].unknown_private = privateValue;
  const request = claude.normalizeHook(payload, env);
  assert.equal(JSON.stringify(request).includes(privateValue), false);
});

test('identical requests without stable upstream invocation IDs receive distinct IDs', async () => {
  const payload = await fixture('claude/permission-request.json');
  assert.notEqual(
    claude.normalizeHook(payload, env).request_id,
    claude.normalizeHook(payload, env).request_id,
  );
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

});
