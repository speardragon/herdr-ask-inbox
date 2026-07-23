import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
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

function hookCommand(configDir, agent) {
  return `${OWNED_MARKER}=1 ${quoteShell(join(configDir, 'hook-launcher.mjs'))} --agent ${agent} --queue-root ${quoteShell(configDir)}`;
}

function ownedDefinitions(configDir, agent) {
  const command = hookCommand(configDir, agent);
  const questionMatcher = agent === 'claude' ? 'AskUserQuestion' : '^request_user_input$';
  return {
    PreToolUse: {
      matcher: questionMatcher,
      hooks: [{ type: 'command', command, timeout: 3600 }],
    },
    PermissionRequest: {
      matcher: '*',
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

async function atomicWrite(path, bytes, mode) {
  await ensureParent(path);
  const temporaryPath = join(dirname(path), `.${path.split('/').at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await chmod(path, mode);
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

async function readConfig(path) {
  try {
    const bytes = await readFile(path);
    return { bytes, value: JSON.parse(bytes.toString('utf8')), exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { bytes: null, value: {}, exists: false };
    throw error;
  }
}

async function snapshotFile(path) {
  try {
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
    return { bytes, mode: metadata.mode & 0o777, exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { bytes: null, mode: null, exists: false };
    throw error;
  }
}

async function restoreFile(path, snapshot) {
  if (snapshot.exists) {
    await atomicWrite(path, snapshot.bytes, snapshot.mode);
    return;
  }
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
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
  if (typeof options.codexPath !== 'string' || options.codexPath.length === 0) {
    throw new Error('codexPath is required');
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
  const codexHome = env.CODEX_HOME || join(userHome, '.codex');
  return {
    configDir,
    claudePath: join(claudeHome, 'settings.json'),
    codexPath: join(codexHome, 'hooks.json'),
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
    const value = JSON.parse(await readFile(path, 'utf8'));
    return { path, ...classifyConfigValue(value, definitions) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path,
        status: 'missing',
        events: Object.fromEntries(Object.keys(definitions).map((event) => [event, 'missing'])),
      };
    }
    return { path, status: 'changed', events: {}, error: 'configuration is not valid JSON' };
  }
}

export async function hookStatus(rawOptions) {
  const options = resolveOptions(rawOptions);
  const launcherPath = join(options.configDir, 'hook-launcher.mjs');
  const [claude, codex, launcherSnapshot] = await Promise.all([
    configStatus(options.claudePath, ownedDefinitions(options.configDir, 'claude')),
    configStatus(options.codexPath, ownedDefinitions(options.configDir, 'codex')),
    snapshotFile(launcherPath),
  ]);
  let launcherStatus = 'missing';
  if (launcherSnapshot.exists) {
    const exactBytes = launcherSnapshot.bytes.equals(Buffer.from(launcherSource()));
    launcherStatus = exactBytes && launcherSnapshot.mode === 0o700 ? 'installed' : 'changed';
  }
  return {
    claude,
    codex,
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
    claude: ownedDefinitions(options.configDir, 'claude'),
    codex: ownedDefinitions(options.configDir, 'codex'),
  };
  const prepared = [];
  for (const [name, path] of [['claude', options.claudePath], ['codex', options.codexPath]]) {
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
        backupPath = await backupOriginal(artifact.path, artifact.snapshot.bytes);
        mutated.push({ path: artifact.path, snapshot: artifact.snapshot });
        await atomicWrite(artifact.path, artifact.nextBytes, 0o600);
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
      mutated.push({ path: launcherPath, snapshot: launcherSnapshot });
      await unlink(launcherPath);
      launcherStatus = 'removed';
    }
    return {
      claude: results[0],
      codex: results[1],
      launcher: { path: launcherPath, status: launcherStatus },
      trust_review_required: true,
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of mutated.reverse()) {
      try {
        await restoreFile(artifact.path, artifact.snapshot);
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
    { name: 'claude', path: options.claudePath, definitions: ownedDefinitions(options.configDir, 'claude') },
    { name: 'codex', path: options.codexPath, definitions: ownedDefinitions(options.configDir, 'codex') },
  ];
  const launcher = Buffer.from(launcherSource());
  const prepared = [];
  for (const artifact of artifacts) {
    const original = await readConfig(artifact.path);
    const snapshot = await snapshotFile(artifact.path);
    const next = jsonBytes(mergeConfig(original.value, artifact.definitions));
    prepared.push({ ...artifact, original, snapshot, next, changed: !original.bytes?.equals(next) });
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
        if (artifact.original.bytes) backupPath = await backupOriginal(artifact.path, artifact.original.bytes);
        mutated.push({ path: artifact.path, snapshot: artifact.snapshot });
        await atomicWrite(artifact.path, artifact.next, 0o600);
      } else if (artifact.snapshot.mode !== 0o600) {
        mutated.push({ path: artifact.path, snapshot: artifact.snapshot });
        await chmod(artifact.path, 0o600);
      }
      await verifyConfig(artifact.path, artifact.definitions);
      results.push({ name: artifact.name, path: artifact.path, changed: artifact.changed, backupPath });
    }
    if (launcherChanged) {
      mutated.push({ path: launcherPath, snapshot: launcherSnapshot });
      await atomicWrite(launcherPath, launcher, 0o700);
    } else if (((await stat(launcherPath)).mode & 0o777) !== 0o700) {
      mutated.push({ path: launcherPath, snapshot: launcherSnapshot });
      await chmod(launcherPath, 0o700);
    }
    for (const artifact of prepared) {
      await verifyConfig(artifact.path, artifact.definitions);
    }
    if (!(await readFile(launcherPath)).equals(launcher)) throw new Error('launcher readback mismatch');
    return {
      claude: results[0],
      codex: results[1],
      launcher: { path: launcherPath, changed: launcherChanged },
      trust_review_required: true,
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const artifact of mutated.reverse()) {
      try {
        await restoreFile(artifact.path, artifact.snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (configDirectoryMode !== null) {
      try {
        await chmod(options.configDir, configDirectoryMode);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'hook installation failed and rollback was incomplete');
    }
    throw error;
  }
}
