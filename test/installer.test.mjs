import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { hookStatus, installHooks, uninstallHooks } from '../src/installer.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    configDir: join(root, 'herdr-config'),
    claudePath: join(root, '.claude', 'settings.json'),
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function runCli(script, env) {
  const child = spawn(process.execPath, [new URL(`../bin/${script}`, import.meta.url).pathname], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('install preserves unrelated hooks and is idempotent', async (t) => {
  const options = await setup(t);
  const unrelated = {
    theme: 'dark',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/example-stop' }] }] },
  };
  await writeJson(options.claudePath, unrelated);

  await installHooks(options);
  const once = await readJson(options.claudePath);
  await installHooks(options);
  const twice = await readJson(options.claudePath);

  assert.deepEqual(twice, once);
  assert.deepEqual(twice.hooks.Stop, unrelated.hooks.Stop);
  assert.equal(twice.theme, 'dark');
});

test('ownership marker matching does not consume unrelated command substrings', async (t) => {
  const options = await setup(t);
  const unrelated = {
    matcher: 'OtherTool',
    hooks: [{ type: 'command', command: 'printf ASK_INBOX_HOOK_V10' }],
  };
  await writeJson(options.claudePath, { hooks: { PreToolUse: [unrelated] } });

  await installHooks(options);

  const installed = await readJson(options.claudePath);
  assert.deepEqual(installed.hooks.PreToolUse[0], unrelated);
  assert.equal(installed.hooks.PreToolUse.length, 2);
});

test('installed Claude group hooks only AskUserQuestion and never PermissionRequest', async (t) => {
  const options = await setup(t);
  await installHooks(options);
  const claude = await readJson(options.claudePath);

  assert.equal(claude.hooks.PreToolUse.length, 1);
  assert.equal(claude.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.equal(claude.hooks.PermissionRequest, undefined); // v2 scope: questions only
  const handler = claude.hooks.PreToolUse[0].hooks[0];
  assert.deepEqual({ type: handler.type, timeout: handler.timeout }, { type: 'command', timeout: 3600 });
  assert.match(handler.command, /^ASK_INBOX_HOOK_V1=1 /);
  assert.match(handler.command, /--agent claude(?: |$)/);
  assert.match(handler.command, / --queue-root /);
});

test('changed configuration is backed up exactly and installed files are user-only', async (t) => {
  const options = await setup(t);
  const claudeBytes = Buffer.from('{"custom":{"spacing":true},"hooks":{}}\n');
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o755 });
  await mkdir(options.configDir, { recursive: true, mode: 0o755 });
  await writeFile(options.claudePath, claudeBytes, { mode: 0o644 });

  const result = await installHooks(options);
  const claudeFiles = await readdir(dirname(options.claudePath));
  const claudeBackup = claudeFiles.find((name) => /^settings\.json\.\d{8}T\d{9}Z\.ask-inbox\.bak$/.test(name));

  assert.ok(claudeBackup);
  assert.deepEqual(await readFile(join(dirname(options.claudePath), claudeBackup)), claudeBytes);
  assert.equal((await stat(options.claudePath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.launcher.path)).mode & 0o777, 0o700);
  assert.equal((await stat(options.configDir)).mode & 0o777, 0o700);
});

test('status distinguishes missing, installed, duplicate, and changed artifacts', async (t) => {
  const options = await setup(t);
  const missing = await hookStatus(options);
  assert.equal(missing.claude.status, 'missing');
  assert.equal(missing.launcher.status, 'missing');

  await installHooks(options);
  const installed = await hookStatus(options);
  assert.equal(installed.claude.status, 'installed');
  assert.equal(installed.launcher.status, 'installed');

  const claude = await readJson(options.claudePath);
  claude.hooks.PreToolUse.push(structuredClone(claude.hooks.PreToolUse.at(-1)));
  await writeJson(options.claudePath, claude);
  await writeFile(installed.launcher.path, '#!/usr/bin/env node\n// locally changed\n', { mode: 0o700 });

  const drifted = await hookStatus(options);
  assert.equal(drifted.claude.status, 'duplicate');
  assert.equal(drifted.launcher.status, 'changed');
  assert.equal(drifted.trust_review_required, true);
});

test('uninstall removes only exact owned definitions and preserves local changes', async (t) => {
  const options = await setup(t);
  const stop = [{ hooks: [{ type: 'command', command: '/usr/bin/unrelated-stop' }] }];
  await writeJson(options.claudePath, { hooks: { Stop: stop } });
  const installed = await installHooks(options);
  const claude = await readJson(options.claudePath);
  claude.hooks.PreToolUse.at(-1).hooks[0].command += ' --locally-changed';
  await writeJson(options.claudePath, claude);
  await writeFile(installed.launcher.path, '#!/usr/bin/env node\n// user replacement\n', { mode: 0o700 });

  const result = await uninstallHooks(options);
  const remaining = await readJson(options.claudePath);

  assert.deepEqual(remaining.hooks.Stop, stop);
  assert.equal(remaining.hooks.PreToolUse.length, 1);
  assert.match(remaining.hooks.PreToolUse[0].hooks[0].command, /--locally-changed$/);
  assert.equal(await readFile(installed.launcher.path, 'utf8'), '#!/usr/bin/env node\n// user replacement\n');
  assert.equal(result.claude.removed, 0); // locally-changed no longer matches exactly
  assert.equal(result.claude.changed, 1);
  assert.equal(result.launcher.status, 'changed');
});

test('repair restores user-only modes without rewriting exact configuration bytes', async (t) => {
  const options = await setup(t);
  const installed = await installHooks(options);
  const claudeBytes = await readFile(options.claudePath);
  await chmod(options.claudePath, 0o644);
  await chmod(installed.launcher.path, 0o600);

  await installHooks(options);

  assert.deepEqual(await readFile(options.claudePath), claudeBytes);
  assert.equal((await stat(options.claudePath)).mode & 0o777, 0o600);
  assert.equal((await stat(installed.launcher.path)).mode & 0o777, 0o700);
});

test('install rejects a symlink settings path without replacing the link or target', async (t) => {
  const options = await setup(t);
  const target = join(options.root, 'real-claude-settings.json');
  const targetBytes = Buffer.from('{"target":"must remain exact"}\n');
  await writeFile(target, targetBytes, { mode: 0o600 });
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o700 });
  await symlink(target, options.claudePath);

  await assert.rejects(() => installHooks(options), /symbolic link/);

  assert.equal((await lstat(options.claudePath)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(target), targetBytes);
  await assert.rejects(() => readFile(join(options.configDir, 'hook-launcher.mjs')), { code: 'ENOENT' });
});

test('status reports and uninstall rejects a symlink without following it', async (t) => {
  const options = await setup(t);
  const target = join(options.root, 'real-claude-settings.json');
  const targetBytes = Buffer.from('{"hooks":{"Stop":[]},"trust":"untouched"}\n');
  await writeFile(target, targetBytes, { mode: 0o600 });
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o700 });
  await symlink(target, options.claudePath);

  const status = await hookStatus(options);
  assert.equal(status.claude.status, 'changed');
  assert.equal(status.claude.error, 'configuration path is unsafe');
  await assert.rejects(() => uninstallHooks(options), /symbolic link/);

  assert.equal((await lstat(options.claudePath)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(target), targetBytes);
});

test('invalid JSON is preserved byte-for-byte and prevents partial installation', async (t) => {
  const options = await setup(t);
  const invalid = Buffer.from('{"hooks": [ this is not JSON ]}\n');
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o700 });
  await writeFile(options.claudePath, invalid, { mode: 0o600 });

  await assert.rejects(() => installHooks(options), /JSON/);

  assert.deepEqual(await readFile(options.claudePath), invalid);
  await assert.rejects(() => readFile(join(options.configDir, 'hook-launcher.mjs')), { code: 'ENOENT' });
});

test('a post-commit conflict on the launcher rolls the settings file back byte-for-byte', async (t) => {
  const options = await setup(t);
  const original = Buffer.from('{\n  "hooks": {},\n  "keep": "exact"\n}\n');
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o700 });
  await writeFile(options.claudePath, original, { mode: 0o600 });

  await assert.rejects(() => installHooks({
    ...options,
    onArtifactCommitted: async ({ name, operation }) => {
      // After the settings file is written but before the launcher is, plant a
      // file where the launcher's "missing" snapshot expects nothing → conflict.
      if (name !== 'claude' || operation !== 'replace') return;
      const launcherPath = join(options.configDir, 'hook-launcher.mjs');
      await mkdir(dirname(launcherPath), { recursive: true, mode: 0o700 });
      await writeFile(launcherPath, 'external', { mode: 0o700 });
    },
  }), /changed during hook transaction/);

  // settings restored to original bytes; the plugin rolled back its own write
  assert.deepEqual(await readFile(options.claudePath), original);
});

test('stable launcher resolves the active plugin with argv-safe herdr JSON lookup', async (t) => {
  const options = await setup(t);
  const pluginRoot = join(options.root, 'plugin root; no shell');
  const hookPath = join(pluginRoot, 'bin', 'hook.mjs');
  const herdrPath = join(options.root, 'fake herdr.mjs');
  const argvLog = join(options.root, 'herdr-argv.json');
  await mkdir(dirname(hookPath), { recursive: true, mode: 0o700 });
  await writeFile(hookPath, `#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));
`, { mode: 0o700 });
  const listing = {
    id: 'cli:plugin',
    result: {
      type: 'plugin_list',
      plugins: [{ plugin_id: 'cdragon.ask-inbox', plugin_root: pluginRoot, enabled: true }],
    },
  };
  await writeFile(herdrPath, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(JSON.stringify(listing))});
`, { mode: 0o700 });
  await installHooks(options);

  const child = spawn(process.execPath, [join(options.configDir, 'hook-launcher.mjs'),
    '--agent', 'claude', '--queue-root', 'queue with spaces'], {
    env: { ...process.env, HERDR_BIN_PATH: herdrPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end('{"private":"payload"}');
  const [code] = await once(child, 'exit');

  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(await readFile(argvLog, 'utf8')), ['plugin', 'list', '--json']);
  assert.deepEqual(JSON.parse(stdout), {
    argv: ['--agent', 'claude', '--queue-root', 'queue with spaces'],
    input: '{"private":"payload"}',
  });
});

test('launcher fails open (exit 0, hook not run) when the plugin is disabled', async (t) => {
  const options = await setup(t);
  const pluginRoot = join(options.root, 'plugin-root');
  const hookPath = join(pluginRoot, 'bin', 'hook.mjs');
  const marker = join(options.root, 'hook-ran.marker');
  const herdrPath = join(options.root, 'fake-herdr.mjs');
  await mkdir(dirname(hookPath), { recursive: true, mode: 0o700 });
  await writeFile(hookPath, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(marker)}, 'ran');
`, { mode: 0o700 });
  const listing = {
    result: { type: 'plugin_list', plugins: [{ plugin_id: 'cdragon.ask-inbox', plugin_root: pluginRoot, enabled: false }] },
  };
  await writeFile(herdrPath, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(listing))});
`, { mode: 0o700 });
  await installHooks(options);

  const child = spawn(process.execPath, [join(options.configDir, 'hook-launcher.mjs'), '--agent', 'claude'], {
    env: { ...process.env, HERDR_BIN_PATH: herdrPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('{}');
  const [code] = await once(child, 'exit');

  assert.equal(code, 0); // fail open
  await assert.rejects(() => readFile(marker), { code: 'ENOENT' }); // hook never ran
});

test('operator CLIs install, report, and uninstall using the Claude config home', async (t) => {
  const options = await setup(t);
  const claudeHome = join(options.root, 'claude-home');
  const env = {
    HOME: join(options.root, 'unused-home'),
    CLAUDE_CONFIG_DIR: claudeHome,
    ASK_INBOX_CONFIG_DIR: options.configDir,
  };

  const installed = await runCli('install-hooks.mjs', env);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).trust_review_required, true);
  assert.equal((await hookStatus({
    ...options,
    claudePath: join(claudeHome, 'settings.json'),
  })).claude.status, 'installed');

  const status = await runCli('status.mjs', env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).launcher.status, 'installed');

  const uninstalled = await runCli('uninstall-hooks.mjs', env);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.equal(JSON.parse(uninstalled.stdout).launcher.status, 'removed');
});
