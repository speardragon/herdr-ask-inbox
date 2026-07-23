import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRequest, requestId, safeDiagnostic, validateResponse } from '../src/schema.mjs';

test('request IDs are stable for canonical input', () => {
  const unordered = requestId({
    paneId: 'w1:p1',
    sessionId: 's1',
    event: 'PermissionRequest',
    input: { b: 2, a: 1 },
  });
  const ordered = requestId({
    event: 'PermissionRequest',
    input: { a: 1, b: 2 },
    paneId: 'w1:p1',
    sessionId: 's1',
  });

  assert.equal(unordered, ordered);
  assert.equal(ordered, 'c683816efe34278a3bd78c04e8a9f24a91eab88fe454c65daaaceff05594caa2');
});

test('response must target the exact request', () => {
  assert.throws(
    () => validateResponse({ schema_version: 1, request_id: 'other', action: 'answer', value: {} }, 'expected'),
    /request_id/,
  );
});

test('unknown transports are rejected', () => {
  assert.throws(() => normalizeRequest({
    schema_version: 1,
    request_id: 'r1',
    source: { pane_id: 'w1:p1', workspace_id: 'w1', session_id: 's1', agent: 'claude' },
    kind: 'question',
    transport: 'magic',
  }), /transport/);
});

test('request normalization enforces the identity contract and returns an isolated value', () => {
  const valid = {
    schema_version: 1,
    request_id: 'r1',
    created_at_ms: 10,
    source: { pane_id: 'w1:p1', workspace_id: 'w1', session_id: 's1', agent: 'claude' },
    kind: 'question',
    transport: 'hook-response',
    status: 'waiting',
  };

  assert.throws(() => normalizeRequest({ ...valid, schema_version: 2 }), /schema_version/);
  assert.throws(() => normalizeRequest({ ...valid, kind: 'message' }), /kind/);
  assert.throws(() => normalizeRequest({ ...valid, source: {} }), /identity/);
  const normalized = normalizeRequest(valid);
  normalized.source.agent = 'codex';
  assert.equal(valid.source.agent, 'claude');
});

test('response validation accepts only exact versioned actions', () => {
  const valid = { schema_version: 1, request_id: 'r1', action: 'handoff', value: null, created_at_ms: 11 };
  assert.equal(validateResponse(valid, 'r1').action, 'handoff');
  assert.throws(() => validateResponse({ ...valid, schema_version: 2 }, 'r1'), /schema_version/);
  assert.throws(() => validateResponse({ ...valid, action: 'allow' }, 'r1'), /action/);
});

test('safe diagnostics omit request content and answers', () => {
  const diagnostic = safeDiagnostic({
    schema_version: 1,
    request_id: 'r1',
    created_at_ms: 10,
    source: { agent: 'claude', pane_id: 'w1:p1', workspace_id: 'w1', env: { TOKEN: 'secret' } },
    kind: 'permission',
    transport: 'hook-response',
    status: 'waiting',
    title: 'Run secret command',
    detail: { command: 'private' },
    questions: [{ question: 'private' }],
    permission: { command: 'private' },
    answer: 'private',
    outcome: 'handoff',
  });

  assert.deepEqual(diagnostic, {
    schema_version: 1,
    request_id: 'r1',
    created_at_ms: 10,
    agent: 'claude',
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    kind: 'permission',
    transport: 'hook-response',
    status: 'waiting',
    outcome: 'handoff',
  });
});

test('request normalization rejects malformed scalars and non-JSON data', () => {
  const valid = {
    schema_version: 1,
    request_id: 'r1',
    created_at_ms: 10,
    source: {
      agent: 'claude',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      session_id: 's1',
    },
    kind: 'question',
    transport: 'hook-response',
    status: 'waiting',
    detail: {},
  };

  for (const malformed of [
    { ...valid, request_id: { secret: true } },
    { ...valid, created_at_ms: Number.NaN },
    { ...valid, created_at_ms: 1.5 },
    { ...valid, status: 'approved' },
    { ...valid, source: { ...valid.source, workspace_id: 1 } },
    { ...valid, source: { ...valid.source, session_id: null } },
    { ...valid, detail: { value: undefined } },
    { ...valid, detail: new Date() },
  ]) {
    assert.throws(() => normalizeRequest(malformed));
  }
});

test('safe diagnostics never copy structured or unknown outcomes', () => {
  const structured = safeDiagnostic({ request_id: 'r1', outcome: { answer: 'secret' } });
  const unknown = safeDiagnostic({ request_id: 'r1', outcome: 'allowed-secret-command' });

  assert.equal(structured.outcome, undefined);
  assert.equal(unknown.outcome, undefined);
  assert.equal(JSON.stringify(structured).includes('secret'), false);
});

test('plain JSON question and permission arrays are valid schema data', () => {
  const base = {
    schema_version: 1,
    request_id: 'arrays',
    created_at_ms: 10,
    source: {
      agent: 'claude',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      session_id: 's1',
    },
    kind: 'question',
    transport: 'hook-response',
    status: 'waiting',
  };
  const questions = [{
    question: 'Choose?',
    options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }],
    multiSelect: false,
  }];
  const permissionSuggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }] }];

  assert.deepEqual(normalizeRequest({ ...base, questions, permission: { suggestions: permissionSuggestions } }).questions, questions);
  assert.equal(typeof requestId({ questions, permissionSuggestions }), 'string');

  const exotic = [...questions];
  Object.defineProperty(exotic, 'secret', { enumerable: true, value: 'do-not-copy' });
  assert.throws(() => normalizeRequest({ ...base, questions: exotic }), /array|JSON/);
});

test('safe diagnostics emit only allowlisted scalar metadata', () => {
  const secret = { token: 'do-not-copy' };
  const diagnostic = safeDiagnostic({
    schema_version: secret,
    request_id: ['secret-id'],
    created_at_ms: secret,
    source: { agent: secret, pane_id: ['secret-pane'], workspace_id: secret },
    kind: secret,
    transport: ['hook-response'],
    status: secret,
    outcome: secret,
  });

  assert.equal(Object.values(diagnostic).every((value) => value === undefined || ['string', 'number', 'boolean'].includes(typeof value)), true);
  assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
});
