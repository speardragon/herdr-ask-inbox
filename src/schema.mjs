import { createHash } from 'node:crypto';

const REQUEST_STATUSES = new Set(['waiting', 'armed']);
const DIAGNOSTIC_OUTCOMES = new Set(['answer', 'deny', 'handoff', 'cancelled', 'timeout', 'error']);

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
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
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
    schema_version: request?.schema_version,
    request_id: request?.request_id,
    created_at_ms: request?.created_at_ms,
    agent: request?.source?.agent,
    pane_id: request?.source?.pane_id,
    workspace_id: request?.source?.workspace_id,
    kind: request?.kind,
    transport: request?.transport,
    status: request?.status,
    outcome: DIAGNOSTIC_OUTCOMES.has(request?.outcome) ? request.outcome : undefined,
  };
}
