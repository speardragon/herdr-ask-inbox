import { createHash } from 'node:crypto';

const REQUEST_STATUSES = new Set(['waiting', 'armed']);
const DIAGNOSTIC_OUTCOMES = new Set(['answer', 'deny', 'handoff', 'cancelled', 'timeout', 'error']);
const AGENTS = new Set(['claude', 'codex']);
const KINDS = new Set(['question', 'permission']);
const TRANSPORTS = new Set(['hook-response', 'terminal-keys']);

function safeString(value, allowed) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return !allowed || allowed.has(value) ? value : undefined;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function requireTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertPlainJson(value, path = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite numbers`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`${path} must be JSON-serializable plain data`);
  if (ancestors.has(value)) throw new Error(`${path} must not contain cycles`);

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !expectedKeys.has(key))) {
      throw new Error(`${path} array must not contain exotic properties`);
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${path}.${index} must be an enumerable array element`);
      }
      assertPlainJson(descriptor.value, `${path}.${index}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain objects and arrays`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) {
    throw new Error(`${path} must not contain symbol keys`);
  }

  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${path}.${key} must be an enumerable data property`);
    }
    assertPlainJson(descriptor.value, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

export function normalizeRequest(value) {
  assertPlainJson(value, 'request');
  if (!value || value.schema_version !== 1) {
    throw new Error('schema_version must be 1');
  }
  if (!['question', 'permission'].includes(value.kind)) {
    throw new Error('invalid kind');
  }
  if (!['hook-response', 'terminal-keys'].includes(value?.transport)) {
    throw new Error('invalid transport');
  }
  requireString(value.request_id, 'request_id');
  requireTimestamp(value.created_at_ms, 'created_at_ms');
  try {
    requireString(value.source?.agent, 'source.agent');
    requireString(value.source?.pane_id, 'source.pane_id');
    requireString(value.source?.workspace_id, 'source.workspace_id');
    requireString(value.source?.session_id, 'source.session_id');
  } catch (error) {
    throw new Error(`invalid request identity: ${error.message}`);
  }
  if (!REQUEST_STATUSES.has(value.status)) throw new Error('invalid request status');

  return structuredClone(value);
}

export function requestId(parts) {
  assertPlainJson(parts, 'request ID parts');
  return createHash('sha256').update(canonicalJson(parts)).digest('hex');
}

export function validateResponse(value, expectedId) {
  assertPlainJson(value, 'response');
  requireString(expectedId, 'expected request_id');
  if (!value || value.request_id !== expectedId) {
    throw new Error('response request_id mismatch');
  }
  if (value.schema_version !== 1) {
    throw new Error('response schema_version must be 1');
  }
  if (!['answer', 'deny', 'handoff'].includes(value.action)) {
    throw new Error('invalid response action');
  }
  requireTimestamp(value.created_at_ms, 'created_at_ms');

  return structuredClone(value);
}

export function safeDiagnostic(request) {
  return {
    schema_version: request?.schema_version === 1 ? 1 : undefined,
    request_id: safeString(request?.request_id),
    created_at_ms: Number.isSafeInteger(request?.created_at_ms) && request.created_at_ms >= 0
      ? request.created_at_ms
      : undefined,
    agent: safeString(request?.source?.agent, AGENTS),
    pane_id: safeString(request?.source?.pane_id),
    workspace_id: safeString(request?.source?.workspace_id),
    kind: safeString(request?.kind, KINDS),
    transport: safeString(request?.transport, TRANSPORTS),
    status: safeString(request?.status, REQUEST_STATUSES),
    outcome: safeString(request?.outcome, DIAGNOSTIC_OUTCOMES),
  };
}
