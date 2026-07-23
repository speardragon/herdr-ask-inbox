#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import * as claude from '../src/adapters/claude.mjs';
import * as codex from '../src/adapters/codex.mjs';
import { openQueue } from '../src/queue.mjs';

const ADAPTERS = { claude, codex };
const execFileAsync = promisify(execFileCallback);
const LIFECYCLE_SOURCE = 'ray.herdr-question';
const MAX_STDIN_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;

export function createHerdrLifecycle({ bin = 'herdr', execFile = execFileAsync } = {}) {
  const run = (args) => execFile(bin, args, { timeout: 5_000, maxBuffer: 1_048_576 });
  return {
    reportBlocked(request) {
      return run([
        'pane', 'report-agent', request.source.pane_id,
        '--source', LIFECYCLE_SOURCE,
        '--agent', request.source.agent,
        '--state', 'blocked',
        '--agent-session-id', request.source.session_id,
      ]);
    },
    releaseBlocked(request) {
      return run([
        'pane', 'release-agent', request.source.pane_id,
        '--source', LIFECYCLE_SOURCE,
        '--agent', request.source.agent,
      ]);
    },
    openPopup() {
      return run([
        'plugin', 'pane', 'open',
        '--plugin', LIFECYCLE_SOURCE,
        '--entrypoint', 'question',
        '--focus',
      ]);
    },
  };
}

const delay = (milliseconds, signal) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(finish, milliseconds);
  function finish() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    resolve();
  }
  signal?.addEventListener('abort', finish, { once: true });
});

async function waitForResponse(queue, requestId, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) return { interrupted: true, response: null };
    const response = await queue.takeResponse(requestId);
    if (response) return { interrupted: false, response };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { interrupted: false, response: null };
    await delay(Math.min(25, remaining), signal);
  }
}

async function cancelAndConsume(queue, requestId) {
  await queue.cancel(requestId).catch(() => false);
  await queue.takeResponse(requestId).catch(() => null);
}

export async function runHook({
  agent,
  payload,
  env,
  queue,
  reportBlocked,
  releaseBlocked,
  openPopup,
  signal,
  timeoutMs = 3_600_000,
}) {
  const adapter = ADAPTERS[agent];
  if (!adapter) throw new Error('unsupported hook agent');
  if (!queue || typeof queue.enqueue !== 'function') throw new Error('hook queue is required');
  if (typeof reportBlocked !== 'function') throw new Error('reportBlocked is required');
  if (typeof releaseBlocked !== 'function') throw new Error('releaseBlocked is required');
  if (typeof openPopup !== 'function') throw new Error('openPopup is required');

  const request = adapter.normalizeHook(payload, env);
  const enqueued = await queue.enqueue(request);
  if (!enqueued || enqueued.detail?.invocation_nonce !== request.detail?.invocation_nonce) {
    return { status: 'duplicate', request, response: null, output: null };
  }
  if (request.transport === 'terminal-keys') {
    return { status: 'armed', request, response: null, output: null };
  }

  let lifecycleAttempted = false;
  try {
    lifecycleAttempted = true;
    try {
      await reportBlocked(request);
    } catch {
      try {
        await openPopup(request);
      } catch {
        await cancelAndConsume(queue, request.request_id);
        return { status: 'report_failed', request, response: null, output: null };
      }
    }

    const waited = await waitForResponse(queue, request.request_id, { timeoutMs, signal });
    if (waited.interrupted) {
      await cancelAndConsume(queue, request.request_id);
      return { status: 'interrupted', request, response: null, output: null };
    }
    if (!waited.response) {
      await cancelAndConsume(queue, request.request_id);
      return { status: 'timeout', request, response: null, output: null };
    }
    if (waited.response.action === 'handoff') {
      return { status: 'handoff', request, response: waited.response, output: null };
    }
    const output = adapter.encodeResponse(request, waited.response);
    return {
      status: output === null ? 'handoff' : 'answered',
      request,
      response: waited.response,
      output,
    };
  } catch {
    await cancelAndConsume(queue, request.request_id);
    return { status: 'error', request, response: null, output: null };
  } finally {
    if (lifecycleAttempted) await releaseBlocked(request).catch(() => {});
  }
}

function parseArguments(argv, env) {
  const options = {
    queueRoot: env.HERDR_QUESTION_QUEUE_DIR,
    timeoutMs: env.HERDR_QUESTION_HOOK_TIMEOUT_MS === undefined
      ? 3_600_000
      : Number(env.HERDR_QUESTION_HOOK_TIMEOUT_MS),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--agent') options.agent = argv[++index];
    else if (value === '--queue-root') options.queueRoot = argv[++index];
    else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else throw new Error('unsupported hook argument');
  }
  if (!ADAPTERS[options.agent]) throw new Error('unsupported hook agent');
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
    const lifecycle = createHerdrLifecycle({ bin: process.env.HERDR_BIN_PATH || 'herdr' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    const result = await runHook({
      agent: options.agent,
      payload,
      env: process.env,
      queue,
      ...lifecycle,
      signal: controller.signal,
      timeoutMs: options.timeoutMs,
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
