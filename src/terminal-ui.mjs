import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import * as claude from './adapters/claude.mjs';
import * as codex from './adapters/codex.mjs';
import { normalizeRequest } from './schema.mjs';
import { handoff as handoffToAgent } from './router.mjs';

const FOOTER = 'Enter answer · g go to agent · Esc native handoff';
const MAX_TERMINAL_WIDTH = 240;
const MAX_TERMINAL_HEIGHT = 100;
const HANDOFF_OPTION = Object.freeze({
  type: 'handoff',
  label: 'Go to agent',
  description: 'Return control without making a decision.',
});

function cloneSet(value) {
  return value instanceof Set ? new Set(value) : new Set();
}

function suggestionDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// This is deliberately a digest of the structured operation, rather than of
// the rendered string.  A resize can change line wrapping without changing
// what is being approved, while any operation change must invalidate the
// confirmation produced by a previous layout.
export function permissionDetailDigest(request) {
  return createHash('sha256').update(JSON.stringify({
    tool_name: request.permission?.tool_name,
    tool_input: request.permission?.tool_input,
  })).digest('hex');
}

function permissionOptions(request) {
  const options = [{
    type: 'allow-once',
    label: 'Allow once',
    description: 'Allow only this request.',
  }];
  if (request.source.agent === 'claude' && Array.isArray(request.permission?.suggestions)) {
    for (const [index, suggestion] of request.permission.suggestions.entries()) {
      options.push({
        type: 'persistent',
        index,
        label: `Persist upstream suggestion ${index + 1}`,
        description: `Exact scope: ${JSON.stringify(suggestion)}`,
        scope_digest: suggestionDigest(suggestion),
      });
    }
  }
  options.push({
    type: 'deny',
    label: 'Deny',
    description: 'Reject this request.',
  }, HANDOFF_OPTION);
  return options;
}

function questionOptions(request, question) {
  const options = question.options.map((option, index) => ({
    type: 'answer-option',
    index,
    label: option.label,
    description: option.description,
  }));
  if (request.source.agent === 'claude') {
    options.push({
      type: 'custom',
      label: 'Custom answer…',
      description: 'Type a free-text answer.',
    });
  }
  return options;
}

function optionsFor(state) {
  if (state.unsupported) return state.options;
  if (state.kind === 'permission') return state.options;
  return state.questionOptions[state.questionIndex] ?? [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function supportedRequest(request) {
  if (!['claude', 'codex'].includes(request.source.agent)) return false;
  if (request.kind === 'permission') {
    return request.transport === 'hook-response'
      && nonEmptyString(request.permission?.tool_name)
      && request.permission?.tool_input !== null
      && typeof request.permission?.tool_input === 'object'
      && (
        request.source.agent !== 'claude'
        || Array.isArray(request.permission?.suggestions)
      );
  }
  if (
    request.kind !== 'question'
    || !Array.isArray(request.questions)
    || request.questions.length === 0
    || (request.source.agent === 'claude' && request.transport !== 'hook-response')
    || (request.source.agent === 'codex' && request.transport !== 'terminal-keys')
  ) {
    return false;
  }
  if (request.source.agent === 'codex') {
    const question = request.questions[0];
    const signature = request.detail?.screen_signature;
    if (
      request.questions.length !== 1
      || request.detail?.agent_version !== '0.101.0'
      || request.detail?.screen_profile !== 'codex-request-user-input-v1'
      || signature?.question_id !== question?.id
      || signature?.question !== question?.question
      || !isDeepStrictEqual(signature?.options, question?.options)
    ) {
      return false;
    }
  }
  return request.questions.every((question) => (
    nonEmptyString(question?.question)
    && nonEmptyString(question?.header)
    && Array.isArray(question?.options)
    && question.options.length > 0
    && question.options.every((option) => (
      nonEmptyString(option?.label) && nonEmptyString(option?.description)
    ))
    && (request.source.agent !== 'claude' || typeof question.multiSelect === 'boolean')
    && (request.source.agent !== 'codex' || nonEmptyString(question.id))
  ));
}

export function createViewModel(requestValue, queuePosition = {}) {
  const request = normalizeRequest(requestValue);
  const queueIndex = Number.isSafeInteger(queuePosition?.index) && queuePosition.index > 0
    ? queuePosition.index
    : 1;
  const queueTotal = Number.isSafeInteger(queuePosition?.total) && queuePosition.total >= queueIndex
    ? queuePosition.total
    : queueIndex;
  const common = {
    request,
    request_id: request.request_id,
    kind: request.kind,
    transport: request.transport,
    source: structuredClone(request.source),
    title: request.title,
    queuePosition: { index: queueIndex, total: queueTotal },
    cursor: 0,
    selected: new Set(),
    effect: null,
    answers: {},
    editing: false,
    customText: '',
    layout: null,
  };
  if (!supportedRequest(request)) {
    return {
      ...common,
      unsupported: true,
      options: [{ ...HANDOFF_OPTION }],
    };
  }
  if (request.kind === 'permission') {
    return {
      ...common,
      options: permissionOptions(request),
      permission: structuredClone(request.permission),
    };
  }
  return {
    ...common,
    questions: structuredClone(request.questions ?? []),
    questionOptions: (request.questions ?? []).map((question) => questionOptions(request, question)),
    questionIndex: 0,
  };
}

function moved(state, delta) {
  const options = optionsFor(state);
  if (options.length === 0) return { ...state, effect: null };
  const cursor = (state.cursor + delta + options.length) % options.length;
  return { ...state, cursor, effect: null, layout: null };
}

function handoffEffect(state, reason) {
  return {
    ...state,
    effect: {
      type: 'handoff',
      selection: {
        type: 'handoff',
        ...(reason ? { reason } : {}),
      },
    },
  };
}

function answerQuestion(state, answer) {
  const question = state.questions[state.questionIndex];
  const answers = { ...state.answers, [question.question]: answer };
  if (state.questionIndex + 1 < state.questions.length) {
    return {
      ...state,
      answers,
      questionIndex: state.questionIndex + 1,
      cursor: 0,
      selected: new Set(),
      editing: false,
      customText: '',
      effect: null,
      layout: null,
    };
  }
  const value = state.transport === 'terminal-keys'
    ? answer
    : { answers };
  return {
    ...state,
    answers,
    effect: {
      type: 'deliver',
      selection: { type: 'answer', value },
    },
  };
}

function confirm(state) {
  const options = optionsFor(state);
  const option = options[state.cursor];
  if (!option) return { ...state, effect: null };
  if (option.type === 'handoff') return handoffEffect(state);
  if (state.kind === 'permission') {
    if (option.type === 'allow-once' || option.type === 'persistent') {
      if (option.type === 'persistent' && state.layout?.persistent_scope_fully_visible !== true) {
        return handoffEffect(state, 'persistent scope was not fully visible');
      }
      const permissionDetailVisible = state.layout?.request_id === state.request_id
        && state.layout?.cursor === state.cursor
        && state.layout?.visible_option_indices?.includes(state.cursor)
        && state.layout?.permission_detail_fully_visible === true
        && state.layout?.permission_detail_digest === permissionDetailDigest(state.request);
      if (!permissionDetailVisible) {
        return handoffEffect(state, 'permission detail was not fully visible');
      }
    }
    return {
      ...state,
      effect: {
        type: 'deliver',
        selection: option.type === 'persistent'
          ? {
            type: 'persistent',
            index: option.index,
            scope_digest: option.scope_digest,
            permission_detail_digest: permissionDetailDigest(state.request),
          }
          : {
            type: option.type,
            permission_detail_digest: permissionDetailDigest(state.request),
          },
      },
    };
  }
  const question = state.questions[state.questionIndex];
  if (state.editing) {
    if (state.customText.length === 0) return { ...state, effect: null };
    return answerQuestion(state, state.customText);
  }
  if (option.type === 'custom') {
    return { ...state, editing: true, customText: '', effect: null };
  }
  if (question.multiSelect) {
    const selected = [...state.selected].sort((left, right) => left - right);
    if (selected.length === 0) return { ...state, effect: null };
    return answerQuestion(state, selected.map((index) => question.options[index].label).join(', '));
  }
  return answerQuestion(state, option.label);
}

function removeLastGrapheme(value) {
  if (typeof Intl.Segmenter === 'function') {
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
    if (segments.length === 0) return '';
    return value.slice(0, segments.at(-1).index);
  }
  return [...value].slice(0, -1).join('');
}

export function reduceKey(state, key) {
  if (!state || typeof state !== 'object') throw new TypeError('view state is required');
  if (key === 'g' || key === 'escape') return handoffEffect(state);
  if (state.editing) {
    if (key === 'enter') return confirm(state);
    if (key === 'backspace') {
      return { ...state, customText: removeLastGrapheme(state.customText), effect: null };
    }
    if (typeof key === 'string' && key.length > 0 && key !== 'space' && !key.includes('\0')) {
      return { ...state, customText: `${state.customText}${key}`, effect: null };
    }
    if (key === 'space') return { ...state, customText: `${state.customText} `, effect: null };
    return { ...state, effect: null };
  }
  if (key === 'up' || key === 'k') return moved(state, -1);
  if (key === 'down' || key === 'j') return moved(state, 1);
  if (key === 'space') {
    const question = state.kind === 'question' ? state.questions[state.questionIndex] : null;
    const option = optionsFor(state)[state.cursor];
    if (!question?.multiSelect || option?.type !== 'answer-option') {
      return { ...state, selected: cloneSet(state.selected), effect: null };
    }
    const selected = cloneSet(state.selected);
    if (selected.has(option.index)) selected.delete(option.index);
    else selected.add(option.index);
    return { ...state, selected, effect: null };
  }
  if (/^[1-9]$/u.test(key)) {
    const cursor = Number(key) - 1;
    if (cursor >= optionsFor(state).length) return { ...state, effect: null };
    const hasCurrentLayout = state.layout?.request_id === state.request_id
      && state.layout?.cursor === state.cursor
      && Array.isArray(state.layout?.visible_option_indices);
    if (hasCurrentLayout && !state.layout.visible_option_indices.includes(cursor)) {
      return { ...state, effect: null };
    }
    const targeted = { ...state, cursor, effect: null, layout: null };
    const question = state.kind === 'question' ? state.questions?.[state.questionIndex] : null;
    if (question?.multiSelect) {
      const option = optionsFor(targeted)[cursor];
      if (option?.type !== 'answer-option') return targeted;
      const selected = cloneSet(state.selected);
      if (selected.has(option.index)) selected.delete(option.index);
      else selected.add(option.index);
      return { ...targeted, selected };
    }
    const option = optionsFor(targeted)[cursor];
    if (option?.type === 'persistent') return targeted;
    return confirm(targeted);
  }
  if (key === 'enter') return confirm(state);
  return { ...state, effect: null };
}

function visibleCodePoint(value) {
  const code = value.codePointAt(0);
  if (
    code <= 0x1f
    || (code >= 0x7f && code <= 0x9f)
    || /\p{Cf}/u.test(value)
  ) {
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  }
  return value;
}

function sanitized(value) {
  return [...String(value ?? '')].map(visibleCodePoint).join('');
}

function cellWidth(character) {
  if (/\p{Mark}/u.test(character)) return 0;
  const code = character.codePointAt(0);
  return code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1;
}

function wrap(value, width) {
  const text = sanitized(value).replace(/\r?\n/gu, ' ');
  if (width <= 0) return [];
  if (text.length === 0) return [''];
  const lines = [];
  let line = '';
  let used = 0;
  for (const character of text) {
    const characterWidth = Math.max(0, cellWidth(character));
    if (used > 0 && used + characterWidth > width) {
      lines.push(line);
      line = '';
      used = 0;
    }
    if (characterWidth > width) continue;
    line += character;
    used += characterWidth;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

function append(lines, value, width, prefix = '') {
  lines.push(...wrap(`${prefix}${value}`, width));
}

function clipLine(value, width) {
  const lines = wrap(value, width);
  if (lines.length <= 1) return lines[0] ?? '';
  const marker = width >= 3 ? '…' : '.';
  const first = lines[0] ?? '';
  const markerWidth = cellWidth(marker);
  let clipped = '';
  let used = 0;
  for (const character of first) {
    const characterWidth = cellWidth(character);
    if (used + characterWidth + markerWidth > width) break;
    clipped += character;
    used += characterWidth;
  }
  return `${clipped}${marker}`;
}

function truncatedSection(lines, budget, width) {
  if (budget <= 0) return [];
  if (lines.length <= budget) return lines;
  const marker = clipLine('… omitted …', width);
  if (budget === 1) return [marker];
  return [...lines.slice(0, budget - 1), marker];
}

function boundedSize(size) {
  const width = Math.max(1, Math.min(
    MAX_TERMINAL_WIDTH,
    Number.isFinite(size?.columns) ? Math.floor(size.columns) : 82,
  ));
  const height = Math.max(1, Math.min(
    MAX_TERMINAL_HEIGHT,
    Number.isFinite(size?.rows) ? Math.floor(size.rows) : 26,
  ));
  return { width, height };
}

function optionLine(viewModel, option, index, width) {
  const selected = viewModel.selected?.has(option.index) ? '[x]' : '[ ]';
  const marker = index === viewModel.cursor ? '›' : ' ';
  const choice = viewModel.kind === 'question'
    && viewModel.questions?.[viewModel.questionIndex]?.multiSelect
    && option.type === 'answer-option'
    ? `${marker} ${selected} ${index + 1}. `
    : `${marker} ${index + 1}. `;
  return clipLine(`${choice}${option.label}`, width);
}

function choiceViewport(viewModel, budget, width) {
  const options = optionsFor(viewModel);
  if (options.length === 0 || budget <= 0) {
    return { rows: [], visibleOptionIndices: [] };
  }
  const cursor = Math.max(0, Math.min(options.length - 1, viewModel.cursor));
  let start = cursor;
  let end = cursor;
  const rowCount = (nextStart, nextEnd) => (
    nextEnd - nextStart + 1
    + (nextStart > 0 ? 1 : 0)
    + (nextEnd < options.length - 1 ? 1 : 0)
  );
  while (true) {
    const leftDistance = cursor - start;
    const rightDistance = end - cursor;
    const candidates = leftDistance <= rightDistance
      ? [[start - 1, end], [start, end + 1]]
      : [[start, end + 1], [start - 1, end]];
    const next = candidates.find(([nextStart, nextEnd]) => (
      nextStart >= 0
      && nextEnd < options.length
      && rowCount(nextStart, nextEnd) <= budget
    ));
    if (!next) break;
    [start, end] = next;
  }

  const rows = [];
  if (start > 0 && rows.length < budget) rows.push(clipLine('↑ more choices', width));
  const visibleOptionIndices = [];
  for (let index = start; index <= end && rows.length < budget; index += 1) {
    rows.push(optionLine(viewModel, options[index], index, width));
    visibleOptionIndices.push(index);
  }
  if (end < options.length - 1 && rows.length < budget) {
    rows.push(clipLine('↓ more choices', width));
  }
  return { rows, visibleOptionIndices };
}

export function layoutViewModel(viewModel, size = {}) {
  const { width, height } = boundedSize(size);
  const headerLines = [
    clipLine(`Herdr Question · ${viewModel.queuePosition.index}/${viewModel.queuePosition.total}`, width),
    clipLine(`Agent ${viewModel.source.agent} · Workspace ${viewModel.source.workspace_id}`, width),
    clipLine(`Pane ${viewModel.source.pane_id} · cwd ${viewModel.source.cwd ?? '(unknown)'}`, width),
    clipLine(`Type ${viewModel.kind} · ${viewModel.title ?? ''}`, width),
  ];
  const toolDetailLines = [];
  if (viewModel.kind === 'permission') {
    append(toolDetailLines, `Tool: ${viewModel.permission?.tool_name ?? '(unknown)'}`, width);
    append(toolDetailLines, `Input: ${JSON.stringify(viewModel.permission?.tool_input ?? null)}`, width);
  } else if (!viewModel.unsupported) {
    const question = viewModel.questions[viewModel.questionIndex];
    append(toolDetailLines, `${question?.header ?? 'Question'}: ${question?.question ?? ''}`, width);
  } else {
    append(toolDetailLines, 'Unsupported request contract; use Go to agent.', width);
  }

  const footerLines = wrap(FOOTER, width);
  const maximumChoiceBudget = Math.max(1, Math.min(
    7,
    height - footerLines.length - Math.min(4, headerLines.length),
  ));
  const viewport = choiceViewport(viewModel, maximumChoiceBudget, width);
  if (viewModel.editing && viewport.rows.length < maximumChoiceBudget) {
    viewport.rows.push(clipLine(`Custom: ${viewModel.customText}`, width));
  }
  const remaining = Math.max(0, height - footerLines.length - viewport.rows.length);
  const keptHeaders = headerLines.slice(0, Math.min(headerLines.length, remaining));
  const contentBudget = Math.max(0, remaining - keptHeaders.length);
  const currentOption = optionsFor(viewModel)[viewModel.cursor];
  const currentDescriptionLines = currentOption
    ? wrap(currentOption.description, width)
    : [];
  const persistent = currentOption?.type === 'persistent';
  const persistentScopeFullyVisible = persistent
    && currentDescriptionLines.length > 0
    && currentDescriptionLines.length <= contentBudget;
  const descriptionBudget = persistent
    ? Math.min(currentDescriptionLines.length, contentBudget)
    : Math.min(currentDescriptionLines.length, Math.min(4, contentBudget));
  const visibleDescription = persistent && !persistentScopeFullyVisible
    ? truncatedSection(currentDescriptionLines, descriptionBudget, width)
    : currentDescriptionLines.slice(0, descriptionBudget);
  const toolBudget = Math.max(0, contentBudget - visibleDescription.length);
  const visibleToolDetails = truncatedSection(toolDetailLines, toolBudget, width);
  const permissionDetailFullyVisible = viewModel.kind === 'permission'
    && toolDetailLines.length > 0
    && toolDetailLines.length <= toolBudget;
  const lines = [
    ...keptHeaders,
    ...visibleToolDetails,
    ...visibleDescription,
    ...viewport.rows,
    ...footerLines,
  ].slice(0, height);
  return {
    ...viewModel,
    layout: {
      request_id: viewModel.request_id,
      cursor: viewModel.cursor,
      width,
      height,
      visible_option_indices: viewport.visibleOptionIndices,
      persistent_scope_fully_visible: persistentScopeFullyVisible,
      permission_detail_fully_visible: permissionDetailFullyVisible,
      permission_detail_digest: viewModel.kind === 'permission'
        ? permissionDetailDigest(viewModel.request)
        : null,
      lines,
    },
  };
}

export function render(viewModel, size = {}) {
  return layoutViewModel(viewModel, size).layout.lines.join('\n');
}

function responseFor(request, selection, now) {
  if (selection.type === 'deny') {
    return {
      schema_version: 1,
      request_id: request.request_id,
      action: 'deny',
      value: selection.message ? { message: selection.message } : {},
      created_at_ms: now,
    };
  }
  if (selection.type === 'allow-once') {
    return {
      schema_version: 1,
      request_id: request.request_id,
      action: 'answer',
      value: { permission: null },
      created_at_ms: now,
    };
  }
  if (selection.type === 'persistent') {
    const suggestion = request.permission?.suggestions?.[selection.index];
    if (
      request.source.agent !== 'claude'
      || suggestion === undefined
      || selection.scope_digest !== suggestionDigest(suggestion)
    ) {
      return null;
    }
    return {
      schema_version: 1,
      request_id: request.request_id,
      action: 'answer',
      value: { permission: structuredClone(suggestion) },
      created_at_ms: now,
    };
  }
  if (selection.type === 'answer') {
    return {
      schema_version: 1,
      request_id: request.request_id,
      action: 'answer',
      value: selection.value,
      created_at_ms: now,
    };
  }
  throw new Error('unsupported popup selection');
}

function sessionIdOf(agent) {
  const session = agent?.agent_session;
  if (typeof session === 'string') return session;
  return typeof session?.value === 'string' ? session.value : null;
}

async function notifyHandoff(herdr, request, reason) {
  try {
    await herdr.notify(
      'Herdr Question needs the native UI',
      `Request ${request.request_id} was not changed (${reason}).`,
    );
  } catch {
    // Notification is advisory. Handoff and source focus remain authoritative.
  }
}

export async function deliverSelection(requestValue, selection, deps) {
  const request = normalizeRequest(requestValue);
  if (!selection || typeof selection !== 'object') throw new TypeError('selection is required');
  const queue = deps?.queue;
  const herdr = deps?.herdr;
  const now = typeof deps?.now === 'function' ? deps.now : Date.now;
  const doHandoff = deps?.handoff ?? handoffToAgent;
  if (!queue || typeof queue.respond !== 'function') throw new TypeError('delivery queue is required');
  if (!herdr || typeof herdr.focusAgent !== 'function') throw new TypeError('herdr API is required');

  const nativeHandoff = async (reason = 'native handoff') => {
    const result = await doHandoff(request, { queue, herdr });
    if (reason !== 'native handoff') await notifyHandoff(herdr, request, reason);
    return { status: 'handed-off', reason, ...result };
  };

  if (selection.type === 'handoff') {
    return nativeHandoff(
      typeof selection.reason === 'string' && selection.reason.length > 0
        ? selection.reason
        : 'native handoff',
    );
  }
  if (
    request.kind === 'permission'
    && ['allow-once', 'persistent'].includes(selection.type)
    && selection.permission_detail_digest !== permissionDetailDigest(request)
  ) {
    return nativeHandoff('permission detail was not fully visible');
  }
  if (request.transport === 'terminal-keys') {
    if (selection.type !== 'answer') return nativeHandoff('unsupported terminal selection');
    let snapshot;
    let screen;
    try {
      snapshot = await herdr.snapshot();
      const live = snapshot.agents.find((agent) => (
        agent?.pane_id === request.source.pane_id
        && agent?.workspace_id === request.source.workspace_id
        && agent?.agent === request.source.agent
        && sessionIdOf(agent) === request.source.session_id
        && agent?.agent_status === 'blocked'
      ));
      if (!live) return nativeHandoff('source pane or session changed');
      screen = await herdr.readPane(request.source.pane_id);
    } catch {
      return nativeHandoff('source validation failed');
    }
    const plan = codex.planQuestionKeys(request, selection.value, screen);
    if (!plan.ok || plan.keys.length === 0) return nativeHandoff(plan.reason ?? 'screen mismatch');
    try {
      await herdr.sendAgentKeys(request.source.pane_id, plan.keys);
    } catch {
      return nativeHandoff('key delivery failed');
    }
    await queue.cancel(request.request_id);
    await queue.takeResponse(request.request_id);
    return { status: 'answered', keys: [...plan.keys] };
  }

  const response = responseFor(request, selection, now());
  if (!response) return nativeHandoff('persistent choice requires native support');
  if (request.source.agent === 'claude') claude.encodeResponse(request, response);
  else if (request.source.agent === 'codex') {
    const encoded = codex.encodeResponse(request, response);
    if (encoded === null) return nativeHandoff('persistent choice requires native support');
  } else {
    return nativeHandoff('unsupported agent');
  }
  await queue.respond(response);
  return { status: response.action === 'deny' ? 'denied' : 'answered' };
}
