import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

const PLUGIN_ID = 'ray.herdr-question';
const OWNED_MARKER = 'HERDR_QUESTION_HOOK_V1';
const execFileAsync = promisify(execFileCallback);

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function hookCommand(configDir) {
  return `${OWNED_MARKER}=1 ${quoteShell(join(configDir, 'hook-launcher.mjs'))} --agent claude --queue-root ${quoteShell(configDir)}`;
}

// v2 scope: intercept Claude AskUserQuestion only. PermissionRequest is
// deliberately NOT hooked — leaving permission approvals to the native UI keeps
// the blast radius to a single tool and avoids mis-routing approvals.
function ownedDefinitions(configDir) {
  const command = hookCommand(configDir);
  return {
    PreToolUse: {
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command, timeout: 3600 }],
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsMarker(group) {
  return Array.isArray(group?.hooks)
    && group.hooks.some((hook) => typeof hook?.command === 'string'
      && /(?:^|[^A-Z0-9_])HERDR_QUESTION_HOOK_V1(?=$|[^A-Z0-9_])/.test(hook.command));
}

function mergeConfig(config, definitions) {
  if (!isObject(config)) throw new Error('hook configuration must be a JSON object');
  const merged = structuredClone(config);
  if (merged.hooks === undefined) merged.hooks = {};
  if (!isObject(merged.hooks)) throw new Error('hooks must be a JSON object');
  for (const [event, definition] of Object.entries(definitions)) {
    const groups = merged.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    merged.hooks[event] = [...groups.filter((group) => !containsMarker(group)), definition];
  }
  return merged;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

async function atomicWrite(path, bytes, mode, { expectedSnapshot, onCommitted } = {}) {
  await ensureParent(path);
  const temporaryPath = join(dirname(path), `.${path.split('/').at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  let committedSnapshot;
  try {
    const handle = await open(temporaryPath, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      committedSnapshot = {
        bytes: Buffer.from(bytes),
        mode: Number(metadata.mode & 0o777n),
        dev: metadata.dev.toString(),
        ino: metadata.ino.toString(),
        exists: true,
      };
    } finally {
      await handle.close();
    }
    if (expectedSnapshot) await assertSnapshotUnchanged(path, expectedSnapshot);
    await rename(temporaryPath, path);
    await onCommitted?.();
    return committedSnapshot;
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function compactTimestamp(date) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '');
}

async function backupOriginal(path, bytes) {
  let instant = Date.now();
  while (true) {
    const backupPath = `${path}.${compactTimestamp(new Date(instant))}.herdr-question.bak`;
    try {
      const handle = await open(backupPath, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return backupPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      instant += 1;
    }
  }
}

function unsafePathError(path, detail = 'is a symbolic link') {
  const error = new Error(`${path} ${detail}; refusing to modify agent settings`);
  error.code = 'HERDR_QUESTION_UNSAFE_PATH';
  return error;
}

function conflictError(path) {
  const error = new Error(`${path} changed during hook transaction; refusing to overwrite external settings`);
  error.code = 'HERDR_QUESTION_CONFLICT';
  return error;
}

async function snapshotFile(path) {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { bytes: null, mode: null, exists: false };
    throw error;
  }
  if (pathMetadata.isSymbolicLink()) throw unsafePathError(path);
  if (!pathMetadata.isFile()) throw unsafePathError(path, 'is not a regular file');
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') throw unsafePathError(path);
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) throw unsafePathError(path, 'is not a regular file');
    const bytes = await handle.readFile();
    const current = await lstat(path, { bigint: true });
    if (current.isSymbolicLink()) throw unsafePathError(path);
    if (current.dev !== metadata.dev || current.ino !== metadata.ino) {
      const error = new Error(`${path} changed while agent settings were being read`);
      error.code = 'HERDR_QUESTION_CONFLICT';
      throw error;
    }
    return {
      bytes,
      mode: Number(metadata.mode & 0o777n),
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      exists: true,
    };
  } finally {
    await handle.close();
  }
}

function snapshotsMatch(actual, expected, { includeMode = false } = {}) {
  if (actual.exists !== expected.exists) return false;
  if (!actual.exists) return true;
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.bytes.equals(expected.bytes)
    && (!includeMode || actual.mode === expected.mode);
}

async function assertSnapshotUnchanged(path, expected, options) {
  let current;
  try {
    current = await snapshotFile(path);
  } catch (error) {
    if (error?.code === 'HERDR_QUESTION_UNSAFE_PATH' || error?.code === 'HERDR_QUESTION_CONFLICT') {
      throw conflictError(path);
    }
    throw error;
  }
  if (!snapshotsMatch(current, expected, options)) throw conflictError(path);
  return current;
}

async function safeChmod(path, mode, expected, { onCommitted } = {}) {
  await assertSnapshotUnchanged(path, expected, { includeMode: true });
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') throw conflictError(path);
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (metadata.dev.toString() !== expected.dev || metadata.ino.toString() !== expected.ino) {
      throw conflictError(path);
    }
    await handle.chmod(mode);
    await onCommitted?.();
  } finally {
    await handle.close();
  }
  return {
    ...expected,
    bytes: Buffer.from(expected.bytes),
    mode,
  };
}

async function restoreMutation(mutation) {
  let current;
  try {
    current = await snapshotFile(mutation.path);
  } catch (error) {
    if (error?.code === 'HERDR_QUESTION_UNSAFE_PATH' || error?.code === 'HERDR_QUESTION_CONFLICT') {
      return false;
    }
    throw error;
  }
  const stillOwned = mutation.expectedAfter
    ? snapshotsMatch(current, mutation.expectedAfter, { includeMode: true })
    : mutation.expectedExists === false
      ? !current.exists
      : current.exists && Buffer.isBuffer(mutation.expectedBytes)
        && current.bytes.equals(mutation.expectedBytes);
  if (!stillOwned) return false;
  if (mutation.snapshot.exists) {
    await atomicWrite(mutation.path, mutation.snapshot.bytes, mutation.snapshot.mode, {
      expectedSnapshot: current,
    });
    return true;
  }
  await assertSnapshotUnchanged(mutation.path, current, { includeMode: true });
  await unlink(mutation.path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return true;
}

async function verifyConfig(path, definitions) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  for (const [event, definition] of Object.entries(definitions)) {
    const exactCount = Array.isArray(parsed?.hooks?.[event])
      ? parsed.hooks[event].filter((group) => isDeepStrictEqual(group, definition)).length
      : 0;
    if (exactCount !== 1) throw new Error(`${path}: owned ${event} hook was not installed exactly once`);
  }
}

function launcherSource() {
  return `#!/usr/bin/env node
// ${OWNED_MARKER}
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const herdr = process.env.HERDR_BIN_PATH || 'herdr';
const listed = spawnSync(herdr, ['plugin', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});
if (listed.error) throw listed.error;
if (listed.status !== 0) process.exit(listed.status ?? 1);
const decoded = JSON.parse(listed.stdout);
const plugins = Array.isArray(decoded) ? decoded : (decoded.plugins ?? decoded.result?.plugins);
const plugin = plugins?.find((item) => item?.plugin_id === '${PLUGIN_ID}');
const root = plugin?.plugin_root;
if (typeof root !== 'string' || root.length === 0) {
  process.stderr.write('${PLUGIN_ID} is not installed or linked\\n');
  process.exit(1);
}
// Fail open when disabled: a disabled plugin cannot open its popup (spike P3),
// so the hook must not block — exit 0 and let the native picker take over.
if (plugin.enabled === false) process.exit(0);
const child = spawnSync(process.execPath, [join(root, 'bin', 'hook.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
`;
}

function resolveOptions(options = {}) {
  if (typeof options.configDir !== 'string' || options.configDir.length === 0) {
    throw new Error('configDir is required');
  }
  if (typeof options.claudePath !== 'string' || options.claudePath.length === 0) {
    throw new Error('claudePath is required');
  }
  if (options.onBackup !== undefined && typeof options.onBackup !== 'function') {
    throw new Error('onBackup must be a function');
  }
  if (options.onArtifactCommitted !== undefined && typeof options.onArtifactCommitted !== 'function') {
    throw new Error('onArtifactCommitted must be a function');
  }
  return options;
}

export async function resolveCliOptions({ env = process.env, execFile = execFileAsync } = {}) {
  let configDir = env.HERDR_QUESTION_CONFIG_DIR || env.HERDR_PLUGIN_CONFIG_DIR;
  if (!configDir) {
    const result = await execFile(env.HERDR_BIN_PATH || 'herdr', ['plugin', 'config-dir', PLUGIN_ID], {
      timeout: 5_000,
      maxBuffer: 1_048_576,
      encoding: 'utf8',
    });
    configDir = result.stdout.trim();
  }
  if (!configDir) throw new Error('herdr plugin config directory could not be resolved');
  const userHome = env.HOME || homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(userHome, '.claude');
  return {
    configDir,
    claudePath: join(claudeHome, 'settings.json'),
  };
}

function classifyConfigValue(value, definitions) {
  if (!isObject(value) || !isObject(value.hooks)) {
    return { status: 'missing', events: Object.fromEntries(Object.keys(definitions).map((event) => [event, 'missing'])) };
  }
  const events = {};
  for (const [event, definition] of Object.entries(definitions)) {
    const groups = Array.isArray(value.hooks[event]) ? value.hooks[event] : [];
    const candidates = groups.filter(containsMarker);
    const exactCount = candidates.filter((group) => isDeepStrictEqual(group, definition)).length;
    if (candidates.length > 1) events[event] = 'duplicate';
    else if (candidates.length === 0) events[event] = 'missing';
    else if (exactCount === 1) events[event] = 'installed';
    else events[event] = 'changed';
  }
  const knownEvents = new Set(Object.keys(definitions));
  const misplaced = Object.entries(value.hooks).some(([event, groups]) => (
    !knownEvents.has(event) && Array.isArray(groups) && groups.some(containsMarker)
  ));
  const statuses = Object.values(events);
  const status = statuses.includes('duplicate')
    ? 'duplicate'
    : statuses.includes('changed') || misplaced
      ? 'changed'
      : statuses.includes('missing')
        ? 'missing'
        : 'installed';
  return { status, events };
}

async function configStatus(path, definitions) {
  try {
    const snapshot = await snapshotFile(path);
    if (!snapshot.exists) {
      return {
        path,
        status: 'missing',
        events: Object.fromEntries(Object.keys(definitions).map((event) => [event, 'missing'])),
      };
    }
    const value = JSON.parse(snapshot.bytes.toString('utf8'));
    return { path, ...classifyConfigValue(value, definitions) };
  } catch (error) {
    return {
      path,
      status: 'changed',
      events: {},
      error: error?.code === 'HERDR_QUESTION_UNSAFE_PATH'
        ? 'configuration path is unsafe'
        : 'configuration is not valid JSON',
    };
  }
}

export async function hookStatus(rawOptions) {
  const options = resolveOptions(rawOptions);
  const launcherPath = join(options.configDir, 'hook-launcher.mjs');
  const [claude, launcherSnapshot] = await Promise.all([
    configStatus(options.claudePath, ownedDefinitions(options.configDir)),
    snapshotFile(launcherPath),
  ]);
  let launcherStatus = 'missing';
  if (launcherSnapshot.exists) {
    const exactBytes = launcherSnapshot.bytes.equals(Buffer.from(launcherSource()));
    launcherStatus = exactBytes && launcherSnapshot.mode === 0o700 ? 'installed' : 'changed';
  }
  return {
    claude,
    launcher: { path: launcherPath, status: launcherStatus },
    trust_review_required: true,
  };
}

function prepareUninstall(value, definitions) {
  const next = structuredClone(value);
  let removed = 0;
  let changed = 0;
  if (!isObject(next?.hooks)) return { next, removed, changed };
  const knownEvents = new Set(Object.keys(definitions));
  for (const [event, definition] of Object.entries(definitions)) {
    if (!Array.isArray(next.hooks[event])) continue;
    const retained = [];
    for (const group of next.hooks[event]) {
      if (isDeepStrictEqual(group, definition)) {
        removed += 1;
      } else {
        if (containsMarker(group)) changed += 1;
        retained.push(group);
      }
    }
    next.hooks[event] = retained;
  }
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!knownEvents.has(event) && Array.isArray(groups)) {
      changed += groups.filter(containsMarker).length;
    }
  }
  return { next, removed, changed };
}

export async function uninstallHooks(rawOptions) {
  const options = resolveOptions(rawOptions);
  const launcherPath = join(options.configDir, 'hook-launcher.mjs');
  const definitionsByAgent = {
    claude: ownedDefinitions(options.configDir),
  };
  const prepared = [];
  for (const [name, path] of [['claude', options.claudePath]]) {
    const snapshot = await snapshotFile(path);
    if (!snapshot.exists) {
      prepared.push({ name, path, snapshot, removed: 0, changed: 0, nextBytes: null });
      continue;
    }
    let value;
    try {
      value = JSON.parse(snapshot.bytes.toString('utf8'));
    } catch {
      prepared.push({ name, path, snapshot, removed: 0, changed: 1, nextBytes: null });
      continue;
    }
    const removal = prepareUninstall(value, definitionsByAgent[name]);
    prepared.push({
      name,
      path,
      snapshot,
      ...removal,
      nextBytes: removal.removed > 0 ? jsonBytes(removal.next) : null,
    });
  }
  const launcherSnapshot = await snapshotFile(launcherPath);
  const exactLauncher = launcherSnapshot.exists
    && launcherSnapshot.mode === 0o700
    && launcherSnapshot.bytes.equals(Buffer.from(launcherSource()));
  const mutated = [];
  try {
    const results = [];
    for (const artifact of prepared) {
      let backupPath = null;
      if (artifact.nextBytes) {
        await assertSnapshotUnchanged(artifact.path, artifact.snapshot, { includeMode: true });
        backupPath = await backupOriginal(artifact.path, artifact.snapshot.bytes);
        await options.onBackup?.({ name: artifact.name, path: artifact.path, backupPath });
        const mutation = {
          path: artifact.path,
          snapshot: artifact.snapshot,
          expectedBytes: artifact.nextBytes,
          expectedAfter: null,
        };
        mutated.push(mutation);
        mutation.expectedAfter = await atomicWrite(artifact.path, artifact.nextBytes, 0o600, {
          expectedSnapshot: artifact.snapshot,
          onCommitted: () => options.onArtifactCommitted?.({
            name: artifact.name,
            operation: 'replace',
            path: artifact.path,
          }),
        });
        JSON.parse(await readFile(artifact.path, 'utf8'));
      }
      results.push({
        path: artifact.path,
        removed: artifact.removed,
        changed: artifact.changed,
        backupPath,
      });
    }
    let launcherStatus = launcherSnapshot.exists ? 'changed' : 'missing';
    if (exactLauncher) {
      await assertSnapshotUnchanged(launcherPath, launcherSnapshot, { includeMode: true });
      mutated.push({
        path: launcherPath,
        snapshot: launcherSnapshot,
        expectedExists: false,
        expectedAfter: null,
      });
      await unlink(launcherPath);
      launcherStatus = 'removed';
    }
    for (const artifact of mutated) {
      if (artifact.expectedExists === false) {
        const current = await snapshotFile(artifact.path);
        if (current.exists) throw conflictError(artifact.path);
      } else if (artifact.expectedAfter) {
        await assertSnapshotUnchanged(artifact.path, artifact.expectedAfter, { includeMode: true });
      }
    }
    return {
      claude: results[0],
      launcher: { path: launcherPath, status: launcherStatus },
      trust_review_required: true,
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of mutated.reverse()) {
      try {
        await restoreMutation(artifact);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'hook uninstall failed and rollback was incomplete');
    }
    throw error;
  }
}

export async function installHooks(rawOptions) {
  const options = resolveOptions(rawOptions);
  const launcherPath = join(options.configDir, 'hook-launcher.mjs');
  const artifacts = [
    { name: 'claude', path: options.claudePath, definitions: ownedDefinitions(options.configDir) },
  ];
  const launcher = Buffer.from(launcherSource());
  const prepared = [];
  for (const artifact of artifacts) {
    const snapshot = await snapshotFile(artifact.path);
    const value = snapshot.exists ? JSON.parse(snapshot.bytes.toString('utf8')) : {};
    const next = jsonBytes(mergeConfig(value, artifact.definitions));
    prepared.push({ ...artifact, snapshot, next, changed: !snapshot.bytes?.equals(next) });
  }
  const launcherSnapshot = await snapshotFile(launcherPath);
  const launcherChanged = !launcherSnapshot.bytes?.equals(launcher);
  let configDirectoryMode = null;
  try {
    const metadata = await stat(options.configDir);
    if (!metadata.isDirectory()) throw new Error('configDir must be a directory');
    configDirectoryMode = metadata.mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const mutated = [];
  const results = [];
  try {
    await mkdir(options.configDir, { recursive: true, mode: 0o700 });
    await chmod(options.configDir, 0o700);
    for (const artifact of prepared) {
      let backupPath = null;
      if (artifact.changed) {
        await ensureParent(artifact.path);
        await assertSnapshotUnchanged(artifact.path, artifact.snapshot, { includeMode: true });
        if (artifact.snapshot.bytes) {
          backupPath = await backupOriginal(artifact.path, artifact.snapshot.bytes);
          await options.onBackup?.({ name: artifact.name, path: artifact.path, backupPath });
        }
        const mutation = {
          path: artifact.path,
          snapshot: artifact.snapshot,
          expectedBytes: artifact.next,
          expectedAfter: null,
        };
        mutated.push(mutation);
        mutation.expectedAfter = await atomicWrite(artifact.path, artifact.next, 0o600, {
          expectedSnapshot: artifact.snapshot,
          onCommitted: () => options.onArtifactCommitted?.({
            name: artifact.name,
            operation: 'replace',
            path: artifact.path,
          }),
        });
      } else if (artifact.snapshot.mode !== 0o600) {
        const mutation = {
          path: artifact.path,
          snapshot: artifact.snapshot,
          expectedBytes: artifact.snapshot.bytes,
          expectedAfter: null,
        };
        mutated.push(mutation);
        mutation.expectedAfter = await safeChmod(artifact.path, 0o600, artifact.snapshot, {
          onCommitted: () => options.onArtifactCommitted?.({
            name: artifact.name,
            operation: 'chmod',
            path: artifact.path,
          }),
        });
      }
      await verifyConfig(artifact.path, artifact.definitions);
      results.push({ name: artifact.name, path: artifact.path, changed: artifact.changed, backupPath });
    }
    if (launcherChanged) {
      const mutation = {
        path: launcherPath,
        snapshot: launcherSnapshot,
        expectedBytes: launcher,
        expectedAfter: null,
      };
      mutated.push(mutation);
      mutation.expectedAfter = await atomicWrite(launcherPath, launcher, 0o700, {
        expectedSnapshot: launcherSnapshot,
        onCommitted: () => options.onArtifactCommitted?.({
          name: 'launcher',
          operation: 'replace',
          path: launcherPath,
        }),
      });
    } else if (launcherSnapshot.mode !== 0o700) {
      const mutation = {
        path: launcherPath,
        snapshot: launcherSnapshot,
        expectedBytes: launcherSnapshot.bytes,
        expectedAfter: null,
      };
      mutated.push(mutation);
      mutation.expectedAfter = await safeChmod(launcherPath, 0o700, launcherSnapshot, {
        onCommitted: () => options.onArtifactCommitted?.({
          name: 'launcher',
          operation: 'chmod',
          path: launcherPath,
        }),
      });
    }
    for (const artifact of prepared) {
      await verifyConfig(artifact.path, artifact.definitions);
    }
    if (!(await readFile(launcherPath)).equals(launcher)) throw new Error('launcher readback mismatch');
    return {
      claude: results[0],
      launcher: { path: launcherPath, changed: launcherChanged },
      trust_review_required: true,
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of mutated.reverse()) {
      try {
        await restoreMutation(artifact);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (configDirectoryMode !== null) {
      try {
        const current = await lstat(options.configDir);
        if (current.isDirectory() && (current.mode & 0o777) === 0o700) {
          await chmod(options.configDir, configDirectoryMode);
        }
      } catch (rollbackError) {
        if (rollbackError?.code !== 'ENOENT') rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'hook installation failed and rollback was incomplete');
    }
    throw error;
  }
}
