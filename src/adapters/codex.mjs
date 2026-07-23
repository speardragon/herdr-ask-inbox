import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { normalizeRequest, requestId, validateResponse } from '../schema.mjs';

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
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

  const projected = [];
  const seenQuestionIds = new Set();
  const seenQuestions = new Set();
  for (const [questionIndex, question] of questions.entries()) {
    requireNonEmptyString(question?.id, `questions[${questionIndex}].id`);
    requireNonEmptyString(question?.question, `questions[${questionIndex}].question`);
    requireNonEmptyString(question?.header, `questions[${questionIndex}].header`);
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) {
      throw new Error(`questions[${questionIndex}].options must contain two or three choices`);
    }
    const questionId = question.id.trim();
    const questionText = question.question.trim();
    if (seenQuestionIds.has(questionId)) throw new Error('duplicate question id');
    if (seenQuestions.has(questionText)) throw new Error('duplicate question text');
    seenQuestionIds.add(questionId);
    seenQuestions.add(questionText);
    const seenLabels = new Set();
    const options = question.options.map((option, optionIndex) => {
      requireNonEmptyString(option?.label, `questions[${questionIndex}].options[${optionIndex}].label`);
      requireNonEmptyString(option?.description, `questions[${questionIndex}].options[${optionIndex}].description`);
      const label = option.label.trim();
      if (seenLabels.has(label)) throw new Error('duplicate option label');
      seenLabels.add(label);
      return { label: option.label, description: option.description };
    });
    projected.push({
      id: question.id,
      question: question.question,
      header: question.header,
      options,
    });
  }

  return projected;
}

const SUPPORTED_QUESTION_PROFILES = new Map([
  ['0.101.0', 'codex-request-user-input-v1'],
]);

export function normalizeHook(payload, env = process.env) {
  const isQuestion = payload?.hook_event_name === 'PreToolUse' && payload?.tool_name === 'request_user_input';
  const isPermission = payload?.hook_event_name === 'PermissionRequest';
  if (!isQuestion && !isPermission) {
    throw new Error('unsupported Codex hook payload');
  }

  const source = sourceFrom(payload, env);
  const invocationNonce = randomUUID();
  const upstreamInvocationId = typeof payload.tool_use_id === 'string' && payload.tool_use_id.trim().length > 0
    ? payload.tool_use_id
    : typeof payload.turn_id === 'string' && payload.turn_id.trim().length > 0
      ? payload.turn_id
      : null;
  const questions = isQuestion ? questionsFrom(payload) : null;
  const permission = isPermission ? {
    tool_name: requireNonEmptyString(payload.tool_name, 'tool_name'),
    tool_input: structuredClone(payload.tool_input),
  } : null;
  if (isPermission && (payload.tool_input === null || typeof payload.tool_input !== 'object')) {
    throw new Error('tool_input must be structured data');
  }
  const id = requestId({
    agent: 'codex',
    paneId: source.pane_id,
    sessionId: source.session_id,
    turnId: source.turn_id ?? null,
    invocationId: upstreamInvocationId ?? invocationNonce,
    event: payload.hook_event_name,
    toolName: payload.tool_name,
    input: payload.tool_input,
  });
  const firstQuestion = questions?.[0];
  const detail = {
    hook_event_name: payload.hook_event_name,
    tool_name: payload.tool_name,
    invocation_nonce: invocationNonce,
  };
  if (isQuestion) {
    detail.screen_profile = SUPPORTED_QUESTION_PROFILES.get(env?.CODEX_VERSION) ?? 'unsupported';
    detail.screen_signature = {
      question_id: firstQuestion.id,
      question: firstQuestion.question,
      options: structuredClone(firstQuestion.options),
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
  let decision;
  if (response.action === 'deny') {
    decision = { behavior: 'deny' };
    if (typeof response.value?.message === 'string' && response.value.message.length > 0) {
      decision.message = response.value.message;
    }
  } else if (response.action === 'answer' && response.value?.permission === null) {
    decision = { behavior: 'allow' };
  } else if (response.action === 'answer') {
    return null;
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
    || request.transport !== 'terminal-keys') {
    return mismatch('unsupported_request');
  }
  if (request.detail?.screen_profile !== 'codex-request-user-input-v1'
    || !SUPPORTED_QUESTION_PROFILES.has(request.detail?.agent_version)) {
    return mismatch('unsupported_version');
  }
  if (request.questions.length !== 1) return mismatch('unsupported_question_count');

  const screenText = typeof screen === 'string' ? screen : screen?.text;
  if (typeof screenText !== 'string') return mismatch('screen_mismatch');
  const question = request.questions[0];
  const signature = request.detail?.screen_signature;
  if (signature?.question_id !== question.id
    || signature.question !== question.question
    || !isDeepStrictEqual(signature.options, question.options)) {
    return mismatch('screen_mismatch');
  }

  const selectedLabel = typeof answer === 'string' ? answer : answer?.[question.id];
  const targetIndex = question.options.findIndex(({ label }) => label === selectedLabel);
  if (targetIndex < 0) return mismatch('unsupported_answer');

  const plainLines = stripAnsi(screenText).split(/\r?\n/u);
  const markerPattern = /^\s*[›>❯●]\s*/u;
  if (plainLines.filter((line) => markerPattern.test(line)).length !== 1) {
    return mismatch('screen_mismatch');
  }
  const questionLines = plainLines
    .map((line, index) => ({ line: normalizedText(line), index }))
    .filter(({ line }) => line.includes(normalizedText(signature.question)));
  if (questionLines.length !== 1) return mismatch('screen_mismatch');
  let lineIndex = questionLines[0].index + 1;
  let currentIndex = -1;
  for (const [index, option] of question.options.entries()) {
    while (lineIndex < plainLines.length && normalizedText(plainLines[lineIndex]).length === 0) lineIndex += 1;
    const line = plainLines[lineIndex];
    if (!line) return mismatch('screen_mismatch');
    const normalizedLine = normalizedText(line);
    const labelOffset = normalizedLine.indexOf(normalizedText(option.label));
    const descriptionOffset = normalizedLine.indexOf(normalizedText(option.description));
    if (labelOffset < 0 || descriptionOffset < labelOffset) return mismatch('screen_mismatch');
    const prefix = normalizedLine.slice(0, labelOffset);
    if (/[›>❯●]\s*(?:\d+[.)]\s*)?$/u.test(prefix)) currentIndex = index;
    lineIndex += 1;
  }
  if (currentIndex < 0) return mismatch('screen_mismatch');
  const knownFooter = /^(?:(?:press )?enter to (?:select|confirm)|(?:esc|escape) to cancel|(?:↑|↓|up|down).*(?:navigate|move))\b/iu;
  for (; lineIndex < plainLines.length; lineIndex += 1) {
    const trailing = normalizedText(plainLines[lineIndex]);
    if (trailing.length > 0 && !knownFooter.test(trailing)) return mismatch('screen_mismatch');
  }

  const direction = targetIndex >= currentIndex ? 'down' : 'up';
  const keys = Array.from({ length: Math.abs(targetIndex - currentIndex) }, () => direction);
  keys.push('enter');
  return { ok: true, reason: null, keys };
}
