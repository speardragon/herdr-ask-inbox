import * as claude from './adapters/claude.mjs';
import { normalizeRequest } from './schema.mjs';

// v2 popup UI: Claude AskUserQuestion only. Answers deliver losslessly through the
// hook response; "go to agent" hands the request back to the native picker.

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

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function questionOptions(question) {
  const options = question.options.map((option, index) => ({
    type: 'answer-option',
    index,
    label: option.label,
    description: option.description,
  }));
  options.push({
    type: 'custom',
    label: 'Custom answer…',
    description: 'Type a free-text answer.',
  });
  return options;
}

function optionsFor(state) {
  if (state.unsupported) return state.options;
  return state.questionOptions[state.questionIndex] ?? [];
}

function supportedRequest(request) {
  if (request.source.agent !== 'claude') return false;
  if (request.kind !== 'question' || request.transport !== 'hook-response') return false;
  if (!Array.isArray(request.questions) || request.questions.length === 0) return false;
  return request.questions.every((question) => (
    nonEmptyString(question?.question)
    && nonEmptyString(question?.header)
    && Array.isArray(question?.options)
    && question.options.length > 0
    && question.options.every((option) => (
      nonEmptyString(option?.label) && nonEmptyString(option?.description)
    ))
    && typeof question.multiSelect === 'boolean'
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
    return { ...common, unsupported: true, options: [{ ...HANDOFF_OPTION }] };
  }
  return {
    ...common,
    questions: structuredClone(request.questions),
    questionOptions: request.questions.map((question) => questionOptions(question)),
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
      selection: { type: 'handoff', ...(reason ? { reason } : {}) },
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
  return {
    ...state,
    answers,
    effect: { type: 'deliver', selection: { type: 'answer', value: { answers } } },
  };
}

function confirm(state) {
  const options = optionsFor(state);
  const option = options[state.cursor];
  if (!option) return { ...state, effect: null };
  if (option.type === 'handoff') return handoffEffect(state);
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
    return confirm(targeted);
  }
  if (key === 'enter') return confirm(state);
  return { ...state, effect: null };
}

function visibleCodePoint(value) {
  const code = value.codePointAt(0);
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(value)) {
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
  const detailLines = [];
  if (!viewModel.unsupported) {
    const question = viewModel.questions[viewModel.questionIndex];
    append(detailLines, `${question?.header ?? 'Question'}: ${question?.question ?? ''}`, width);
  } else {
    append(detailLines, 'Unsupported request contract; use Go to agent.', width);
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
  const currentDescriptionLines = currentOption ? wrap(currentOption.description, width) : [];
  const descriptionBudget = Math.min(currentDescriptionLines.length, Math.min(4, contentBudget));
  const visibleDescription = currentDescriptionLines.slice(0, descriptionBudget);
  const detailBudget = Math.max(0, contentBudget - visibleDescription.length);
  const visibleDetail = truncatedSection(detailLines, detailBudget, width);
  const lines = [
    ...keptHeaders,
    ...visibleDetail,
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
      lines,
    },
  };
}

export function render(viewModel, size = {}) {
  return layoutViewModel(viewModel, size).layout.lines.join('\n');
}

async function focusBestEffort(herdr, paneId) {
  try {
    await herdr.focusAgent(paneId);
    return true;
  } catch {
    return false;
  }
}

async function handoffToNative(request, { queue, herdr, now }) {
  try {
    await queue.respond({
      schema_version: 1,
      request_id: request.request_id,
      action: 'handoff',
      value: null,
      created_at_ms: now(),
    });
  } catch {
    // The hook may already have failed open and consumed the request; focusing
    // the source pane still returns the user to the native picker.
  }
  const focused = await focusBestEffort(herdr, request.source.pane_id);
  return { status: 'handed-off', focused };
}

export async function deliverSelection(requestValue, selection, deps) {
  const request = normalizeRequest(requestValue);
  if (!selection || typeof selection !== 'object') throw new TypeError('selection is required');
  const queue = deps?.queue;
  const herdr = deps?.herdr;
  const now = typeof deps?.now === 'function' ? deps.now : Date.now;
  if (!queue || typeof queue.respond !== 'function') throw new TypeError('delivery queue is required');
  if (!herdr || typeof herdr.focusAgent !== 'function') throw new TypeError('herdr API is required');

  if (selection.type === 'handoff') {
    return handoffToNative(request, { queue, herdr, now });
  }
  if (selection.type !== 'answer') return handoffToNative(request, { queue, herdr, now });

  const response = {
    schema_version: 1,
    request_id: request.request_id,
    action: 'answer',
    value: selection.value,
    created_at_ms: now(),
  };
  // Validate the answer is deliverable before publishing; on any mismatch fall
  // back to the native picker rather than delivering something malformed.
  try {
    claude.encodeResponse(request, response);
  } catch {
    return handoffToNative(request, { queue, herdr, now });
  }
  await queue.respond(response);
  return { status: 'answered' };
}
