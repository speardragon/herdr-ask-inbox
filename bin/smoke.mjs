#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { openQueue } from '../src/queue.mjs';
import { createHerdr } from '../src/herdr.mjs';
import { handleAgentStatusChanged } from '../src/router.mjs';

const execFileAsync = promisify(execFileCallback);
const PLUGIN_ID = 'ray.herdr-question';
const MAX_IDENTIFIER_LENGTH = 1_024;

function validIdentifier(value, flag) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || value.includes('\0')
  ) {
    throw new Error(`${flag} must be a non-empty identifier without NUL bytes`);
  }
  return value;
}

export function parseArgs(args) {
  const result = { confirmLocal: false, paneId: null, sessionId: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--confirm-local') {
      result.confirmLocal = true;
    } else if (argument === '--pane-id' || argument === '--session-id') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--pane-id') result.paneId = validIdentifier(value, argument);
      else result.sessionId = validIdentifier(value, argument);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if ((result.paneId === null) !== (result.sessionId === null)) {
    throw new Error('--pane-id and --session-id must be provided together');
  }
  if (result.confirmLocal && result.paneId === null) {
    throw new Error('--confirm-local requires both --pane-id and --session-id');
  }
  return result;
}

export function defaultPlan() {
  return {
    mutates: false,
    opensPopup: false,
    sendsKeys: false,
    checks: [
      'resolve the plugin queue directory only after explicit confirmation',
      'require a deliberately blocked Claude pane and its exact agent session',
      'enqueue one synthetic request and open its popup only after explicit confirmation',
      'never send agent keys or alter hook configuration',
    ],
    manualValidation: 'With a designated blocked test pane, trigger its blocked event, inspect the popup, then press g (or Esc) to hand off and focus the source pane. Do not answer a real agent request during this check.',
  };
}

export async function resolveQueueRoot({ env = process.env, execFile = execFileAsync } = {}) {
  const configured = env.HERDR_QUESTION_CONFIG_DIR || env.HERDR_PLUGIN_CONFIG_DIR;
  if (configured) {
    if (!isAbsolute(configured) || configured.includes('\0')) throw new Error('plugin config directory is invalid');
    return configured;
  }
  const { stdout } = await execFile(env.HERDR_BIN_PATH || 'herdr', ['plugin', 'config-dir', PLUGIN_ID], {
    env,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1_048_576,
    shell: false,
  });
  const root = stdout.trim();
  if (!isAbsolute(root) || root.includes('\0')) throw new Error('plugin config directory could not be resolved');
  return root;
}

export function syntheticRequest({ paneId, sessionId, now = Date.now(), id = randomUUID() } = {}) {
  return {
    schema_version: 1,
    request_id: `smoke-${id}`,
    created_at_ms: now,
    source: {
      agent: 'claude',
      pane_id: paneId,
      workspace_id: 'smoke',
      session_id: sessionId,
      cwd: null,
    },
    kind: 'question',
    transport: 'hook-response',
    title: 'Herdr Question smoke request',
    detail: { synthetic: true },
    questions: [{
      header: 'Smoke check',
      question: 'Synthetic request: verify popup handoff only.',
      options: [{ label: 'Do not select', description: 'Use g or Esc to hand off instead.' }],
      multiSelect: false,
    }],
    permission: null,
    status: 'waiting',
  };
}

function sessionIdOf(agent) {
  if (typeof agent?.agent_session === 'string') return agent.agent_session;
  return typeof agent?.agent_session?.value === 'string' ? agent.agent_session.value : null;
}

export function blockedClaudeSource(snapshot, { paneId, sessionId }) {
  if (!snapshot || !Array.isArray(snapshot.panes) || !Array.isArray(snapshot.agents)) {
    throw new Error('herdr snapshot is invalid');
  }
  const pane = snapshot.panes.find((value) => value?.pane_id === paneId);
  const agent = snapshot.agents.find((value) => (
    value?.pane_id === paneId
    && value?.agent === 'claude'
    && value?.agent_status === 'blocked'
    && sessionIdOf(value) === sessionId
  ));
  const workspaceId = agent?.workspace_id ?? pane?.workspace_id;
  if (!pane || !agent || typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new Error('specified pane is not an exact blocked Claude session');
  }
  return { paneId, sessionId, workspaceId };
}

function writePlan(stdout, plan) {
  stdout.write('Herdr Question smoke plan (no mutation):\n');
  for (const check of plan.checks) stdout.write(`- ${check}\n`);
  stdout.write(`Manual validation: ${plan.manualValidation}\n`);
}

export async function runSmoke({
  args = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  execFile = execFileAsync,
  openQueueAt = openQueue,
  createHerdrApi = ({ env: apiEnv, execFile: apiExecFile }) => createHerdr({
    bin: apiEnv.HERDR_BIN_PATH || 'herdr', env: apiEnv, execFile: apiExecFile,
  }),
  handleStatusChanged = handleAgentStatusChanged,
  installSignalHandlers = true,
} = {}) {
  const options = parseArgs(args);
  const plan = defaultPlan();
  if (!options.confirmLocal) {
    writePlan(stdout, plan);
    return { status: 'planned', plan };
  }

  let queue;
  let request;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned || !queue || !request) return;
    cleaned = true;
    await queue.cancel(request.request_id).catch(() => {});
    await queue.takeResponse(request.request_id).catch(() => {});
  };
  const onSignal = () => {
    cleanup().finally(() => { process.exitCode = 130; });
  };
  if (installSignalHandlers) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  try {
    const root = await resolveQueueRoot({ env, execFile });
    queue = await openQueueAt(root);
    const herdr = createHerdrApi({ env, execFile });
    const source = blockedClaudeSource(await herdr.snapshot(), options);
    request = syntheticRequest({ paneId: source.paneId, sessionId: source.sessionId });
    request.source.workspace_id = source.workspaceId;
    await queue.enqueue(request);
    stdout.write(`Queue directory: ${root}\n`);
    stdout.write('Synthetic request is queued for the explicitly designated blocked Claude pane.\n');
    stdout.write('The popup will open now. Press g or Esc only; no agent keys will be sent.\n');
    const routed = await handleStatusChanged(
      { agent_status: 'blocked', pane_id: source.paneId },
      { queue, herdr },
    );
    if (routed?.status !== 'opened') {
      throw new Error('synthetic popup did not open for the designated source pane');
    }
    const after = await herdr.snapshot();
    if (after?.focused_pane_id !== source.paneId) {
      throw new Error('native handoff did not focus the designated source pane');
    }
    stdout.write('Smoke handoff passed: the source pane was focused and synthetic state is being removed.\n');
    return { status: 'passed', queueRoot: root };
  } catch (error) {
    await cleanup();
    stderr.write(`herdr-question smoke check failed: ${error?.message ?? 'unknown error'}\n`);
    return { status: 'error', error };
  } finally {
    await cleanup();
    if (installSignalHandlers) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
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
  const result = await runSmoke();
  if (result.status === 'error') process.exitCode = 1;
}
