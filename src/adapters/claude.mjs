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
    agent: 'claude',
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
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
    throw new Error('AskUserQuestion requires one to four questions');
  }

  const projected = [];
  const seenQuestions = new Set();
  for (const [questionIndex, question] of questions.entries()) {
    requireNonEmptyString(question?.question, `questions[${questionIndex}].question`);
    requireNonEmptyString(question?.header, `questions[${questionIndex}].header`);
    if (question?.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') {
      throw new Error(`questions[${questionIndex}].multiSelect must be a boolean`);
    }
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) {
      throw new Error(`questions[${questionIndex}].options must contain two to four choices`);
    }
    const questionKey = question.question.trim();
    if (seenQuestions.has(questionKey)) throw new Error('duplicate question text');
    seenQuestions.add(questionKey);
    const seenLabels = new Set();
    const options = question.options.map((option, optionIndex) => {
      requireNonEmptyString(option?.label, `questions[${questionIndex}].options[${optionIndex}].label`);
      requireNonEmptyString(option?.description, `questions[${questionIndex}].options[${optionIndex}].description`);
      const labelKey = option.label.trim();
      if (seenLabels.has(labelKey)) throw new Error('duplicate option label');
      seenLabels.add(labelKey);
      return { label: option.label, description: option.description };
    });
    projected.push({
      question: question.question,
      header: question.header,
      options,
      multiSelect: question.multiSelect ?? false,
    });
  }

  return projected;
}

export function normalizeHook(payload, env = process.env) {
  const isQuestion = payload?.hook_event_name === 'PreToolUse' && payload?.tool_name === 'AskUserQuestion';
  const isPermission = payload?.hook_event_name === 'PermissionRequest';
  if (!isQuestion && !isPermission) {
    throw new Error('unsupported Claude hook payload');
  }

  const source = sourceFrom(payload, env);
  const invocationNonce = randomUUID();
  const upstreamInvocationId = typeof payload.tool_use_id === 'string' && payload.tool_use_id.trim().length > 0
    ? payload.tool_use_id
    : null;
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
    agent: 'claude',
    paneId: source.pane_id,
    sessionId: source.session_id,
    turnId: source.turn_id ?? null,
    invocationId: upstreamInvocationId ?? invocationNonce,
    event: payload.hook_event_name,
    toolName: payload.tool_name,
    input: payload.tool_input,
    permissionSuggestions: payload.permission_suggestions ?? [],
  });

  const detail = {
    hook_event_name: payload.hook_event_name,
    tool_name: payload.tool_name,
    invocation_nonce: invocationNonce,
  };
  if (typeof payload.tool_use_id === 'string' && payload.tool_use_id.length > 0) {
    detail.tool_use_id = payload.tool_use_id;
  }
  if (typeof env?.CLAUDE_CODE_VERSION === 'string' && env.CLAUDE_CODE_VERSION.length > 0) {
    detail.agent_version = env.CLAUDE_CODE_VERSION;
  }

  return normalizeRequest({
    schema_version: 1,
    request_id: id,
    created_at_ms: Date.now(),
    source,
    kind: isQuestion ? 'question' : 'permission',
    transport: 'hook-response',
    title: isQuestion ? questions[0].header : `Approve ${payload.tool_name}`,
    detail,
    questions,
    permission,
    status: 'waiting',
  });
}

export function encodeResponse(requestValue, responseValue) {
  const request = normalizeRequest(requestValue);
  const response = validateResponse(responseValue, request.request_id);
  if (request.source.agent !== 'claude') throw new Error('request is not for Claude');
  if (response.action === 'handoff') return null;
  if (request.kind === 'permission' && request.transport === 'hook-response') {
    if (response.action === 'deny') {
      const decision = { behavior: 'deny' };
      if (typeof response.value?.message === 'string' && response.value.message.length > 0) {
        decision.message = response.value.message;
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision,
        },
      };
    }
    if (response.action !== 'answer') throw new Error('Claude permission requires an answer');
    const hasPermission = Object.hasOwn(response.value ?? {}, 'permission');
    const hasSuggestionIndex = Object.hasOwn(response.value ?? {}, 'suggestion_index');
    if (hasPermission && hasSuggestionIndex) {
      throw new Error('ambiguous permission selection');
    }
    if (response.value?.permission === null) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      };
    }
    const suggestionIndex = response.value?.suggestion_index;
    const selected = Number.isSafeInteger(suggestionIndex)
      ? request.permission.suggestions[suggestionIndex]
      : request.permission.suggestions.find((suggestion) => (
        isDeepStrictEqual(suggestion, response.value?.permission)
      ));
    if (!selected) throw new Error('response must select an exact upstream permission suggestion');

    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [structuredClone(selected)],
        },
      },
    };
  }
  if (request.kind !== 'question' || request.transport !== 'hook-response') {
    throw new Error('unsupported Claude response request');
  }
  if (response.action !== 'answer') throw new Error('Claude question requires an answer');

  const answers = response.value?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('question response must contain an answers object');
  }
  const expectedQuestions = request.questions.map(({ question }) => question);
  if (Object.keys(answers).length !== expectedQuestions.length) {
    throw new Error('answers must target every question exactly once');
  }
  for (const question of expectedQuestions) {
    requireNonEmptyString(answers[question], `answer for ${question}`);
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        questions: structuredClone(request.questions),
        answers: structuredClone(answers),
      },
    },
  };
}
