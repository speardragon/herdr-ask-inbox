#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createHerdr } from '../src/herdr.mjs';
import { openQueue } from '../src/queue.mjs';
import { handleAgentStatusChanged } from '../src/router.mjs';

const execFileAsync = promisify(execFileCallback);
const MAX_CONTEXT_BYTES = 65_536;
const MAX_ID_LENGTH = 1_024;
const PLUGIN_ID = 'ray.herdr-question';

export function parseEventContext(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw) > MAX_CONTEXT_BYTES) {
    return null;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (
    value.type !== undefined
    && !['pane.agent_status_changed', 'pane_agent_status_changed'].includes(value.type)
  ) {
    return null;
  }
  if (
    typeof value.agent_status !== 'string'
    || value.agent_status.length === 0
    || value.agent_status.length > 64
    || typeof value.pane_id !== 'string'
    || value.pane_id.length === 0
    || value.pane_id.length > MAX_ID_LENGTH
    || value.pane_id.includes('\0')
  ) {
    return null;
  }
  return {
    agent_status: value.agent_status,
    pane_id: value.pane_id,
  };
}

async function resolveQueueRoot(env, execFile) {
  const configured = env.HERDR_QUESTION_CONFIG_DIR || env.HERDR_PLUGIN_CONFIG_DIR;
  if (configured) {
    if (!isAbsolute(configured) || configured.includes('\0')) {
      throw new Error('plugin config directory is invalid');
    }
    return configured;
  }
  const result = await execFile(env.HERDR_BIN_PATH || 'herdr', [
    'plugin', 'config-dir', PLUGIN_ID,
  ], {
    env,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1_048_576,
    shell: false,
  });
  const path = result.stdout.trim();
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('plugin config directory could not be resolved');
  }
  return path;
}

export async function runEvent({
  env = process.env,
  queue,
  herdr,
  execFile = execFileAsync,
} = {}) {
  const rawEvent = env.HERDR_PLUGIN_EVENT_JSON;
  const context = parseEventContext(
    rawEvent === undefined ? env.HERDR_PLUGIN_CONTEXT_JSON : rawEvent,
  );
  if (!context) return { status: 'invalid-context' };
  const api = herdr ?? createHerdr({
    bin: env.HERDR_BIN_PATH || 'herdr',
    env,
    execFile,
  });
  const liveQueue = queue ?? await openQueue(await resolveQueueRoot(env, execFile));
  return handleAgentStatusChanged(context, { queue: liveQueue, herdr: api });
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
  try {
    await runEvent();
  } catch {
    // Event routing fails open. Agent hooks/native UI retain authority.
  }
}
