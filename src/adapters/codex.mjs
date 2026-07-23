import { isDeepStrictEqual } from 'node:util';

import { normalizeRequest, requestId, validateResponse } from '../schema.mjs';

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function sourceFrom(payload, env) {
  const source = {
    agent: 'codex',
    pane_id: requireNonEmptyString(env?.HERDR_PANE_ID, 'HERDR_PANE_ID'),
    workspace_id: requireNonEmptyString(env?.HERDR_WORKSPACE_ID, 'HERDR_WORKSPACE_ID'),
    session_id: requireNonEmptyString(payload?.session_id, 'session_id'),
  };
  if (typeof payload.turn_id === 'string' && payload.turn_id.length > 0) source.turn_id = payload.turn_id;
  if (typeof payload.cwd === 'string' && payload.cwd.length > 0) source.cwd = payload.cwd;
  return source;
}

function questionsFrom(payload) {
  const questions = payload?.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) {
    throw new Error('request_user_input requires one to three questions');
  }

  for (const [questionIndex, question] of questions.entries()) {
    requireNonEmptyString(question?.id, `questions[${questionIndex}].id`);
    requireNonEmptyString(question?.question, `questions[${questionIndex}].question`);
    requireNonEmptyString(question?.header, `questions[${questionIndex}].header`);
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) {
      throw new Error(`questions[${questionIndex}].options must contain two or three choices`);
    }
    for (const [optionIndex, option] of question.options.entries()) {
      requireNonEmptyString(option?.label, `questions[${questionIndex}].options[${optionIndex}].label`);
      requireNonEmptyString(option?.description, `questions[${questionIndex}].options[${optionIndex}].description`);
    }
  }

  return structuredClone(questions);
}

export function normalizeHook(payload, env = process.env) {
  const isQuestion = payload?.hook_event_name === 'PreToolUse' && payload?.tool_name === 'request_user_input';
  const isPermission = payload?.hook_event_name === 'PermissionRequest';
  if (!isQuestion && !isPermission) {
    throw new Error('unsupported Codex hook payload');
  }

  const source = sourceFrom(payload, env);
  const questions = isQuestion ? questionsFrom(payload) : null;
  const permission = isPermission ? {
    tool_name: requireNonEmptyString(payload.tool_name, 'tool_name'),
    tool_input: structuredClone(payload.tool_input),
    suggestions: structuredClone(payload.permission_suggestions ?? []),
  } : null;
  if (isPermission && (payload.tool_input === null || typeof payload.tool_input !== 'object')) {
    throw new Error('tool_input must be structured data');
  }
  if (isPermission && !Array.isArray(payload.permission_suggestions ?? [])) {
    throw new Error('permission_suggestions must be an array');
  }
  const id = requestId({
    agent: 'codex',
    paneId: source.pane_id,
    sessionId: source.session_id,
    turnId: source.turn_id ?? null,
    toolUseId: payload.tool_use_id ?? null,
    event: payload.hook_event_name,
    toolName: payload.tool_name,
    input: payload.tool_input,
    permissionSuggestions: payload.permission_suggestions ?? [],
  });
  const firstQuestion = questions?.[0];
  const detail = {
    hook_event_name: payload.hook_event_name,
    tool_name: payload.tool_name,
  };
  if (isQuestion) {
    detail.screen_profile = 'codex-request-user-input-v1';
    detail.screen_signature = {
      question_id: firstQuestion.id,
      question: firstQuestion.question,
      options: firstQuestion.options.map(({ label }) => label),
    };
  }
  if (typeof payload.tool_use_id === 'string' && payload.tool_use_id.length > 0) {
    detail.tool_use_id = payload.tool_use_id;
  }
  if (typeof env?.CODEX_VERSION === 'string' && env.CODEX_VERSION.length > 0) {
    detail.agent_version = env.CODEX_VERSION;
  }

  return normalizeRequest({
    schema_version: 1,
    request_id: id,
    created_at_ms: Date.now(),
    source,
    kind: isQuestion ? 'question' : 'permission',
    transport: isQuestion ? 'terminal-keys' : 'hook-response',
    title: isQuestion ? firstQuestion.header : `Approve ${payload.tool_name}`,
    detail,
    questions,
    permission,
    status: isQuestion ? 'armed' : 'waiting',
  });
}

export function encodeResponse(requestValue, responseValue) {
  const request = normalizeRequest(requestValue);
  const response = validateResponse(responseValue, request.request_id);
  if (request.source.agent !== 'codex') throw new Error('request is not for Codex');
  if (response.action === 'handoff') return null;
  if (request.kind !== 'permission' || request.transport !== 'hook-response') {
    throw new Error('unsupported Codex response request');
  }
  const hasPermission = Object.hasOwn(response.value ?? {}, 'permission');
  const hasSuggestionIndex = Object.hasOwn(response.value ?? {}, 'suggestion_index');
  if (response.action === 'answer' && hasPermission && hasSuggestionIndex) {
    throw new Error('ambiguous permission selection');
  }

  let decision;
  if (response.action === 'deny') {
    decision = { behavior: 'deny' };
    if (typeof response.value?.message === 'string' && response.value.message.length > 0) {
      decision.message = response.value.message;
    }
  } else if (response.action === 'answer' && response.value?.permission === null) {
    decision = { behavior: 'allow' };
  } else if (response.action === 'answer') {
    const suggestionIndex = response.value?.suggestion_index;
    const selected = Number.isSafeInteger(suggestionIndex)
      ? request.permission.suggestions[suggestionIndex]
      : request.permission.suggestions.find((suggestion) => (
        isDeepStrictEqual(suggestion, response.value?.permission)
      ));
    if (!selected || selected.behavior !== 'allow') {
      throw new Error('response must select an exact upstream permission suggestion');
    }
    decision = structuredClone(selected);
  } else {
    throw new Error('Codex permission requires an answer or denial');
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
    },
  };
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '');
}

function normalizedText(value) {
  return stripAnsi(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function mismatch(reason) {
  return { ok: false, reason, keys: [] };
}

export function planQuestionKeys(requestValue, answer, screen) {
  const request = normalizeRequest(requestValue);
  if (request.source.agent !== 'codex'
    || request.kind !== 'question'
    || request.transport !== 'terminal-keys'
    || request.detail?.screen_profile !== 'codex-request-user-input-v1') {
    return mismatch('unsupported_request');
  }
  if (request.questions.length !== 1) return mismatch('unsupported_question_count');

  const screenText = typeof screen === 'string' ? screen : screen?.text;
  if (typeof screenText !== 'string') return mismatch('screen_mismatch');
  const question = request.questions[0];
  const signature = request.detail?.screen_signature;
  if (signature?.question_id !== question.id
    || signature.question !== question.question
    || !isDeepStrictEqual(signature.options, question.options.map(({ label }) => label))) {
    return mismatch('screen_mismatch');
  }

  const haystack = normalizedText(screenText);
  let offset = 0;
  for (const fragment of [signature.question, ...signature.options]) {
    const needle = normalizedText(fragment);
    const next = haystack.indexOf(needle, offset);
    if (next < 0) return mismatch('screen_mismatch');
    offset = next + needle.length;
  }

  const selectedLabel = typeof answer === 'string' ? answer : answer?.[question.id];
  const targetIndex = question.options.findIndex(({ label }) => label === selectedLabel);
  if (targetIndex < 0) return mismatch('unsupported_answer');

  const plainLines = stripAnsi(screenText).split(/\r?\n/u);
  let currentIndex = -1;
  for (const [index, option] of question.options.entries()) {
    const line = plainLines.find((candidate) => normalizedText(candidate).includes(normalizedText(option.label)));
    if (!line) return mismatch('screen_mismatch');
    const labelOffset = normalizedText(line).indexOf(normalizedText(option.label));
    const normalizedLine = normalizedText(line);
    const prefix = normalizedLine.slice(0, labelOffset);
    if (/[›>❯●]\s*(?:\d+[.)]\s*)?$/u.test(prefix)) currentIndex = index;
  }
  if (currentIndex < 0) return mismatch('screen_mismatch');

  const direction = targetIndex >= currentIndex ? 'down' : 'up';
  const keys = Array.from({ length: Math.abs(targetIndex - currentIndex) }, () => direction);
  keys.push('enter');
  return { ok: true, reason: null, keys };
}
