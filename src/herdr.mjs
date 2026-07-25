import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);
const PLUGIN_ID = 'cdragon.ask-inbox';
const TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_KEYS = 32;
const POPUP_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  constructor(operation, exitCode = null, errorCode = null) {
    super(`herdr ${operation} failed`);
    this.name = 'HerdrOperationError';
    this.operation = operation;
    this.exitCode = Number.isSafeInteger(exitCode) ? exitCode : null;
    this.errorCode = typeof errorCode === 'string' ? errorCode : null;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      operation: this.operation,
      exitCode: this.exitCode,
      errorCode: this.errorCode,
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

function popupModalResultFrom(value) {
  const result = value?.result;
  if (result?.type !== 'ok') {
    throw new HerdrOperationError('openPopup');
  }
  return { ok: true, modal: true };
}

function safeCliErrorCode(error) {
  if (typeof error?.stdout !== 'string' || error.stdout.length > 16_384) return null;
  try {
    const value = JSON.parse(error.stdout);
    const code = value?.error?.code;
    return code === 'ui_busy' ? code : null;
  } catch {
    return null;
  }
}

function boundedTimeout(timeoutMs) {
  if (timeoutMs === undefined) return TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number');
  }
  return Math.max(1, Math.min(TIMEOUT_MS, Math.ceil(timeoutMs)));
}

export function createHerdr({
  bin = 'herdr',
  env = process.env,
  execFile = execFileAsync,
} = {}) {
  requireString(bin, 'herdr binary');
  if (typeof execFile !== 'function') throw new TypeError('execFile must be a function');

  const run = async (operation, args, { timeoutMs, noTimeout = false } = {}) => {
    try {
      return await execFile(bin, args, {
        env,
        encoding: 'utf8',
        timeout: noTimeout ? 0 : boundedTimeout(timeoutMs),
        maxBuffer: MAX_BUFFER_BYTES,
        shell: false,
      });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new HerdrOperationError(operation, error?.code, safeCliErrorCode(error));
    }
  };

  return {
    async snapshot(options) {
      const { stdout } = await run('snapshot', ['api', 'snapshot'], options);
      try {
        return snapshotFrom(parseJsonObject(stdout, 'snapshot'));
      } catch (error) {
        if (error instanceof HerdrOperationError) throw error;
        throw new HerdrOperationError('snapshot');
      }
    },

    async readPane(paneId, options) {
      requireString(paneId, 'pane ID');
      const { stdout } = await run('readPane', [
        'pane', 'read', paneId,
        '--source', 'detection',
        '--format', 'text',
      ], options);
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

    async openPopup(token) {
      if (typeof token !== 'string' || !POPUP_TOKEN_PATTERN.test(token)) {
        throw new TypeError('popup token must be a UUID v4');
      }
      // `plugin pane open` returns as soon as the popup is spawned (spike P1),
      // so a normal bounded timeout is safe — the hook must never hang on it.
      const { stdout } = await run('openPopup', [
        'plugin', 'pane', 'open',
        '--plugin', PLUGIN_ID,
        '--entrypoint', 'question',
        '--placement', 'popup',
        '--focus',
        '--env', `ASK_INBOX_POPUP_TOKEN=${token}`,
      ]);
      return popupModalResultFrom(parseJsonObject(stdout, 'openPopup'));
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
