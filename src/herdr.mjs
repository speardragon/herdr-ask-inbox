import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);
const PLUGIN_ID = 'ray.herdr-question';
const TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_KEYS = 32;
const NAMED_KEYS = new Set([
  'up',
  'down',
  'left',
  'right',
  'enter',
  'esc',
  'space',
  'tab',
  'backtab',
]);

export class HerdrOperationError extends Error {
  constructor(operation, exitCode = null) {
    super(`herdr ${operation} failed`);
    this.name = 'HerdrOperationError';
    this.operation = operation;
    this.exitCode = Number.isSafeInteger(exitCode) ? exitCode : null;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      operation: this.operation,
      exitCode: this.exitCode,
    };
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function parseJsonObject(stdout, operation) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new HerdrOperationError(operation);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HerdrOperationError(operation);
  }
  return value;
}

function snapshotFrom(value) {
  const snapshot = value?.result?.snapshot;
  if (
    value?.result?.type !== 'session_snapshot'
    || !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || typeof snapshot.focused_workspace_id !== 'string'
    || !Array.isArray(snapshot.panes)
    || !Array.isArray(snapshot.agents)
  ) {
    throw new HerdrOperationError('snapshot');
  }
  return snapshot;
}

function popupPaneIdFrom(value) {
  const result = value?.result;
  const paneId = result?.plugin_pane?.pane?.pane_id;
  if (
    result?.type !== 'plugin_pane_opened'
    || result?.plugin_pane?.plugin_id !== PLUGIN_ID
    || result?.plugin_pane?.entrypoint !== 'question'
    || typeof paneId !== 'string'
    || paneId.length === 0
    || paneId.includes('\0')
  ) {
    throw new HerdrOperationError('openPopup');
  }
  return paneId;
}

export function createHerdr({
  bin = 'herdr',
  env = process.env,
  execFile = execFileAsync,
} = {}) {
  requireString(bin, 'herdr binary');
  if (typeof execFile !== 'function') throw new TypeError('execFile must be a function');

  const run = async (operation, args) => {
    try {
      return await execFile(bin, args, {
        env,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        shell: false,
      });
    } catch (error) {
      throw new HerdrOperationError(operation, error?.code);
    }
  };

  return {
    async snapshot() {
      const { stdout } = await run('snapshot', ['api', 'snapshot']);
      try {
        return snapshotFrom(parseJsonObject(stdout, 'snapshot'));
      } catch (error) {
        if (error instanceof HerdrOperationError) throw error;
        throw new HerdrOperationError('snapshot');
      }
    },

    async readPane(paneId) {
      requireString(paneId, 'pane ID');
      const { stdout } = await run('readPane', [
        'pane', 'read', paneId,
        '--source', 'detection',
        '--format', 'text',
      ]);
      if (typeof stdout !== 'string') throw new HerdrOperationError('readPane');
      return stdout;
    },

    async sendAgentKeys(paneId, keys) {
      requireString(paneId, 'pane ID');
      if (
        !Array.isArray(keys)
        || keys.length === 0
        || keys.length > MAX_KEYS
        || keys.some((key) => !NAMED_KEYS.has(key))
      ) {
        throw new TypeError('keys must be a bounded array of canonical named keys');
      }
      await run('sendAgentKeys', ['pane', 'send-keys', paneId, ...keys]);
    },

    async focusAgent(paneId) {
      requireString(paneId, 'pane ID');
      await run('focusAgent', ['agent', 'focus', paneId]);
    },

    async openPopup(workspaceId) {
      requireString(workspaceId, 'workspace ID');
      const { stdout } = await run('openPopup', [
        'plugin', 'pane', 'open',
        '--plugin', PLUGIN_ID,
        '--entrypoint', 'question',
        '--placement', 'overlay',
        '--workspace', workspaceId,
        '--focus',
      ]);
      return popupPaneIdFrom(parseJsonObject(stdout, 'openPopup'));
    },

    async focusPopup(paneId) {
      requireString(paneId, 'popup pane ID');
      await run('focusPopup', ['plugin', 'pane', 'focus', paneId]);
    },

    async notify(title, body) {
      requireString(title, 'notification title');
      requireString(body, 'notification body');
      await run('notify', [
        'notification', 'show', title,
        '--body', body,
        '--sound', 'request',
      ]);
    },

    async reportBlocked(request) {
      const paneId = requireString(request?.source?.pane_id, 'source pane ID');
      const agent = requireString(request?.source?.agent, 'source agent');
      const sessionId = requireString(request?.source?.session_id, 'source session ID');
      await run('reportBlocked', [
        'pane', 'report-agent', paneId,
        '--source', PLUGIN_ID,
        '--agent', agent,
        '--state', 'blocked',
        '--agent-session-id', sessionId,
      ]);
    },

    async releaseBlocked(request) {
      const paneId = requireString(request?.source?.pane_id, 'source pane ID');
      const agent = requireString(request?.source?.agent, 'source agent');
      await run('releaseBlocked', [
        'pane', 'release-agent', paneId,
        '--source', PLUGIN_ID,
        '--agent', agent,
      ]);
    },
  };
}
