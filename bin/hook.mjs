#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import * as claude from '../src/adapters/claude.mjs';
import * as codex from '../src/adapters/codex.mjs';
import { openQueue } from '../src/queue.mjs';

const ADAPTERS = { claude, codex };

export async function runHook({
  agent,
  payload,
  env,
  queue,
  reportBlocked,
  timeoutMs = 3_600_000,
}) {
  const adapter = ADAPTERS[agent];
  if (!adapter) throw new Error('unsupported hook agent');
  if (!queue || typeof queue.enqueue !== 'function') throw new Error('hook queue is required');
  if (typeof reportBlocked !== 'function') throw new Error('reportBlocked is required');

  const request = adapter.normalizeHook(payload, env);
  await queue.enqueue(request);
  if (request.transport === 'terminal-keys') {
    return { status: 'armed', request, response: null, output: null };
  }

  try {
    await reportBlocked(request);
  } catch {
    await queue.cancel(request.request_id);
    return { status: 'report_failed', request, response: null, output: null };
  }
  const response = await queue.waitForResponse(request.request_id, { timeoutMs });
  if (!response) {
    await queue.cancel(request.request_id);
    return { status: 'timeout', request, response: null, output: null };
  }
  if (response.action === 'handoff') return { status: 'handoff', request, response, output: null };
  return {
    status: 'answered',
    request,
    response,
    output: adapter.encodeResponse(request, response),
  };
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
  let contents = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) contents += chunk;
  const payload = JSON.parse(contents);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('hook input must be one JSON object');
  }
  return payload;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2), process.env);
    const payload = await readStandardInput(process.stdin);
    const queue = await openQueue(options.queueRoot);
    const result = await runHook({
      agent: options.agent,
      payload,
      env: process.env,
      queue,
      reportBlocked: async () => {},
      timeoutMs: options.timeoutMs,
    });
    if (result.output !== null) process.stdout.write(JSON.stringify(result.output));
  } catch {
    // Fail open to the agent's native UI. Stdout is reserved for hook protocol JSON.
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
