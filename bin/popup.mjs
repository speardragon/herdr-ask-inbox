#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createHerdr } from '../src/herdr.mjs';
import { openQueue } from '../src/queue.mjs';
import { claimForPopup, clearLease, renewLease } from '../src/lease.mjs';
import {
  createViewModel,
  deliverSelection,
  layoutViewModel,
  reduceKey,
  render,
} from '../src/terminal-ui.mjs';

const execFileAsync = promisify(execFileCallback);
const PLUGIN_ID = 'ray.ask-inbox';
const POPUP_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CONFIG_PATH_BYTES = 16_384;
const HEARTBEAT_MS = 1_000;
const CLEAR_SCREEN = '\u001b[2J\u001b[H';

function diagnostic(stderr, message) {
  try {
    stderr.write(`ask-inbox: ${message}\n`);
  } catch {
    // Diagnostics must never keep the modal lease or raw terminal active.
  }
}

function screenSize(stdout, color = false) {
  return {
    columns: Number.isFinite(stdout.columns) ? stdout.columns : 82,
    rows: Number.isFinite(stdout.rows) ? stdout.rows : 26,
    color,
  };
}

function decodeKeys(value) {
  const text = String(value);
  const keys = [];
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    if (rest.startsWith('\u001b[A')) {
      keys.push('up');
      index += 3;
    } else if (rest.startsWith('\u001b[B')) {
      keys.push('down');
      index += 3;
    } else if (rest.startsWith('\u001b')) {
      keys.push('escape');
      index += 1;
    } else if (rest.startsWith('\r') || rest.startsWith('\n')) {
      keys.push('enter');
      index += 1;
    } else if (rest.startsWith('\u0003')) {
      keys.push('interrupt');
      index += 1;
    } else if (rest.startsWith('\u007f') || rest.startsWith('\b')) {
      keys.push('backspace');
      index += 1;
    } else if (rest.startsWith(' ')) {
      keys.push('space');
      index += 1;
    } else {
      const character = String.fromCodePoint(text.codePointAt(index));
      if (
        !/[\p{Cc}\p{Cf}]/u.test(character)
        || character === '\u200c'
        || character === '\u200d'
      ) {
        keys.push(character);
      }
      index += character.length;
    }
  }
  return keys;
}

async function resolveQueueRoot(env, execFile) {
  const configured = env.ASK_INBOX_CONFIG_DIR || env.HERDR_PLUGIN_CONFIG_DIR;
  if (configured) {
    if (
      typeof configured !== 'string'
      || !isAbsolute(configured)
      || configured.includes('\0')
      || Buffer.byteLength(configured) > MAX_CONFIG_PATH_BYTES
    ) {
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
  if (
    !isAbsolute(path)
    || path.includes('\0')
    || Buffer.byteLength(path) > MAX_CONFIG_PATH_BYTES
  ) {
    throw new Error('plugin config directory could not be resolved');
  }
  return path;
}

export async function runPopup({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process,
  queue,
  herdr,
  execFile = execFileAsync,
  deliver = deliverSelection,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY || typeof stdin.setRawMode !== 'function') {
    diagnostic(stderr, 'an interactive terminal is required; the pending request was not changed');
    return 2;
  }
  const token = env.ASK_INBOX_POPUP_TOKEN;
  if (typeof token !== 'string' || !POPUP_TOKEN_PATTERN.test(token)) {
    diagnostic(stderr, 'the popup modal token is missing or invalid');
    return 2;
  }
  const useColor = !env.NO_COLOR && env.TERM !== 'dumb';

  let liveQueue;
  let claimed = false;
  let heartbeat = null;
  let raw = false;
  let stopped = false;
  let exitCode = 0;
  let currentView = null;
  let currentRequest = null;
  let iterator;
  let stopResolve;
  const stopPromise = new Promise((resolve) => {
    stopResolve = resolve;
  });
  const inputDecoder = new StringDecoder('utf8');

  const restoreRaw = () => {
    if (!raw) return;
    raw = false;
    try {
      stdin.setRawMode(false);
    } catch {
      // The terminal may already be detached; lease cleanup still proceeds.
    }
  };
  const requestStop = (code) => {
    if (stopped) return;
    stopped = true;
    exitCode = code;
    restoreRaw();
    stopResolve({ type: 'stop' });
    try {
      stdin.destroy();
    } catch {
      // The pending iterator will otherwise finish naturally.
    }
  };
  const onSigint = () => requestStop(130);
  const onSigterm = () => requestStop(143);
  const onSighup = () => requestStop(129);
  const onSigquit = () => requestStop(131);
  const onRuntimeFailure = () => requestStop(1);
  const draw = () => {
    if (!currentView || stopped) return true;
    try {
      currentView = layoutViewModel(currentView, screenSize(stdout, useColor));
      stdout.write(
        `${CLEAR_SCREEN}${render(currentView, screenSize(stdout, useColor))}`,
        (error) => {
          if (error) onRuntimeFailure();
        },
      );
      return true;
    } catch {
      onRuntimeFailure();
      return false;
    }
  };
  const onResize = () => draw();

  try {
    liveQueue = queue ?? await openQueue(await resolveQueueRoot(env, execFile));
    claimed = await claimForPopup(liveQueue, token);
    if (!claimed) {
      diagnostic(stderr, 'popup modal ownership could not be claimed');
      return 3;
    }
    // Keep the lease heartbeat fresh so waiting hooks know a popup is alive.
    // If this popup is dismissed/killed, the heartbeat stops and hooks fail open.
    heartbeat = setInterval(() => {
      renewLease(liveQueue, token, Date.now()).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const api = herdr ?? createHerdr({
      bin: env.HERDR_BIN_PATH || 'herdr',
      env,
      execFile,
    });
    if (typeof deliver !== 'function') throw new TypeError('popup delivery function is required');

    processRef.once('SIGINT', onSigint);
    processRef.once('SIGTERM', onSigterm);
    processRef.once('SIGHUP', onSighup);
    processRef.once('SIGQUIT', onSigquit);
    processRef.once('uncaughtException', onRuntimeFailure);
    processRef.once('unhandledRejection', onRuntimeFailure);
    processRef.on('SIGWINCH', onResize);
    stdout.on?.('resize', onResize);
    stdin.on?.('error', onRuntimeFailure);
    stdout.on?.('error', onRuntimeFailure);
    stderr.on?.('error', onRuntimeFailure);
    stdin.setRawMode(true);
    raw = true;
    iterator = stdin[Symbol.asyncIterator]();

    while (!stopped) {
      const requests = await liveQueue.list();
      if (requests.length === 0) return 0;
      currentRequest = requests[0];
      currentView = createViewModel(currentRequest, {
        index: 1,
        total: requests.length,
      });
      draw();

      let completed = false;
      while (!stopped && !completed) {
        const nextInput = iterator.next().then(
          (input) => ({ type: 'input', input }),
          () => ({ type: 'input-error' }),
        );
        const event = await Promise.race([nextInput, stopPromise]);
        if (event.type === 'stop') break;
        if (event.type === 'input-error') {
          requestStop(1);
          break;
        }
        const { input } = event;
        if (input.done) {
          diagnostic(stderr, 'terminal input ended before the pending request was handled');
          return 1;
        }
        const bytes = Buffer.isBuffer(input.value)
          ? input.value
          : Buffer.from(String(input.value));
        for (const key of decodeKeys(inputDecoder.write(bytes))) {
          if (key === 'interrupt') {
            requestStop(130);
            break;
          }
          currentView = layoutViewModel(currentView, screenSize(stdout, useColor));
          currentView = reduceKey(currentView, key);
          draw();
          if (currentView.effect) {
            const result = await deliver(currentRequest, currentView.effect.selection, {
              queue: liveQueue,
              herdr: api,
            });
            if (result?.status === 'handed-off') return 0;
            completed = true;
            break;
          }
        }
      }
    }
    return exitCode || 1;
  } catch {
    requestStop(exitCode || 1);
    diagnostic(stderr, 'the popup failed safely; no diagnostic request content was logged');
    return exitCode || 1;
  } finally {
    stopped = true;
    restoreRaw();
    processRef.removeListener?.('SIGINT', onSigint);
    processRef.removeListener?.('SIGTERM', onSigterm);
    processRef.removeListener?.('SIGHUP', onSighup);
    processRef.removeListener?.('SIGQUIT', onSigquit);
    processRef.removeListener?.('uncaughtException', onRuntimeFailure);
    processRef.removeListener?.('unhandledRejection', onRuntimeFailure);
    processRef.removeListener?.('SIGWINCH', onResize);
    stdout.removeListener?.('resize', onResize);
    stdin.removeListener?.('error', onRuntimeFailure);
    stdout.removeListener?.('error', onRuntimeFailure);
    stderr.removeListener?.('error', onRuntimeFailure);
    await iterator?.return?.().catch(() => {});
    if (heartbeat) clearInterval(heartbeat);
    if (claimed) {
      await clearLease(liveQueue, token).catch(() => {
        diagnostic(stderr, 'popup modal cleanup failed');
      });
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
  process.exitCode = await runPopup();
}
