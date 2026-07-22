import { createHash } from 'node:crypto';

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
  if (!value || value.schema_version !== 1) {
    throw new Error('schema_version must be 1');
  }
  if (!['question', 'permission'].includes(value.kind)) {
    throw new Error('invalid kind');
  }
  if (!['hook-response', 'terminal-keys'].includes(value?.transport)) {
    throw new Error('invalid transport');
  }
  if (!value.request_id || !value.source?.pane_id || !value.source?.agent) {
    throw new Error('missing request identity');
  }

  return structuredClone(value);
}

export function requestId(parts) {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex');
}

export function validateResponse(value, expectedId) {
  if (!value || value.request_id !== expectedId) {
    throw new Error('response request_id mismatch');
  }
  if (value.schema_version !== 1) {
    throw new Error('response schema_version must be 1');
  }
  if (!['answer', 'deny', 'handoff'].includes(value.action)) {
    throw new Error('invalid response action');
  }

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
    outcome: request?.outcome,
  };
}
