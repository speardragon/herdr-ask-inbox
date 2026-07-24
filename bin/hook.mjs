#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as claude from '../src/adapters/claude.mjs';
import { createHerdr } from '../src/herdr.mjs';
import { openQueue } from '../src/queue.mjs';
import { ensurePopup, waitForOutcome } from '../src/opener.mjs';

const MAX_STDIN_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

// v2: the hook opens the popup itself and treats popup liveness as the only gate.
// It never depends on a herdr blocked-status event (which never fires while screen
// detection sees the agent as "working" — the v1 deadlock). If no popup is alive,
// the hook returns no decision and Claude falls back to its native picker.
export async function runHook({
  payload,
  env,
  queue,
  herdr,
  signal,
  now = Date.now,
  isAlive,
  deadlineMs,
}) {
  if (!queue || typeof queue.enqueue !== 'function') throw new Error('hook queue is required');
  if (!herdr || typeof herdr.openPopup !== 'function') throw new Error('herdr API is required');

  const request = claude.normalizeHook(payload, env);
  const enqueued = await queue.enqueue(request);
  if (!enqueued || enqueued.detail?.invocation_nonce !== request.detail?.invocation_nonce) {
    // Another hook process already owns this exact invocation; let it drive.
    return { status: 'duplicate', request, output: null };
  }

  const options = { now, isAlive };
  try {
    // Best-effort sidebar marker. Never gates: report failure must not block.
    await herdr.reportBlocked?.(request).catch(() => {});
    await ensurePopup(queue, herdr, options);
    const outcome = await waitForOutcome(queue, request, {
      ...options,
      signal,
      deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : now() + DEFAULT_TIMEOUT_MS,
    });
    if (outcome.status === 'answer') {
      const output = claude.encodeResponse(request, outcome.response);
      return { status: output === null ? 'handoff' : 'answered', request, output };
    }
    return { status: outcome.status, request, output: null };
  } catch {
    await queue.cancel(request.request_id).catch(() => {});
    await queue.takeResponse(request.request_id).catch(() => {});
    return { status: 'error', request, output: null };
  } finally {
    await herdr.releaseBlocked?.(request).catch(() => {});
  }
}

function parseArguments(argv, env) {
  const options = {
    agent: undefined,
    queueRoot: env.HERDR_QUESTION_QUEUE_DIR,
    timeoutMs: env.HERDR_QUESTION_HOOK_TIMEOUT_MS === undefined
      ? DEFAULT_TIMEOUT_MS
      : Number(env.HERDR_QUESTION_HOOK_TIMEOUT_MS),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--agent') options.agent = argv[++index];
    else if (value === '--queue-root') options.queueRoot = argv[++index];
    else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else throw new Error('unsupported hook argument');
  }
  if (options.agent !== 'claude') throw new Error('unsupported hook agent');
  if (typeof options.queueRoot !== 'string' || options.queueRoot.length === 0) {
    throw new Error('hook queue root is required');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error('hook timeout must be a non-negative number');
  }
  return options;
}

async function readStandardInput(stream) {
  const chunks = [];
  let byteLength = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteLength += chunk.length;
    if (byteLength > MAX_STDIN_BYTES) throw new Error('hook input exceeds byte limit');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('hook input must be one JSON object');
  }
  const stack = [{ value: payload, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > MAX_JSON_DEPTH) throw new Error('hook input nesting exceeds limit');
    if (current.value === null || typeof current.value !== 'object') continue;
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && !Array.isArray(current.value)) {
      throw new Error('hook input must be plain JSON');
    }
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return payload;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2), process.env);
    const payload = await readStandardInput(process.stdin);
    const queue = await openQueue(options.queueRoot);
    const herdr = createHerdr({ bin: process.env.HERDR_BIN_PATH || 'herdr', env: process.env });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    const result = await runHook({
      payload,
      env: process.env,
      queue,
      herdr,
      signal: controller.signal,
      deadlineMs: Date.now() + options.timeoutMs,
    }).finally(() => {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    });
    if (result.output !== null) process.stdout.write(JSON.stringify(result.output));
  } catch {
    // Fail open to the agent's native UI. Stdout is reserved for hook protocol JSON.
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  await main();
}
