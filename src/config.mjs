import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);
const PLUGIN_ID = 'ray.herdr-question';
const MAX_CONFIG_PATH_BYTES = 16_384;

function validated(path) {
  if (
    typeof path !== 'string'
    || !isAbsolute(path)
    || path.includes('\0')
    || Buffer.byteLength(path) > MAX_CONFIG_PATH_BYTES
  ) {
    throw new Error('plugin config directory is invalid');
  }
  return path;
}

// The queue lives in the plugin's per-user config directory. Prefer the env herdr
// injects; otherwise ask herdr for the resolved path.
export async function resolveQueueRoot(env = process.env, execFile = execFileAsync) {
  const configured = env.HERDR_QUESTION_CONFIG_DIR || env.HERDR_PLUGIN_CONFIG_DIR || env.HERDR_QUESTION_QUEUE_DIR;
  if (configured) return validated(configured);
  const result = await execFile(env.HERDR_BIN_PATH || 'herdr', ['plugin', 'config-dir', PLUGIN_ID], {
    env,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1_048_576,
    shell: false,
  });
  return validated(result.stdout.trim());
}
