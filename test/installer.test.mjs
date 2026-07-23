import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { hookStatus, installHooks, uninstallHooks } from '../src/installer.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    configDir: join(root, 'herdr-config'),
    claudePath: join(root, '.claude', 'settings.json'),
    codexPath: join(root, '.codex', 'hooks.json'),
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
  const unrelatedClaudeConfig = {
    theme: 'dark',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/example-stop' }] }],
    },
  };
  await writeJson(options.claudePath, unrelatedClaudeConfig);

  await installHooks(options);
  const once = await readJson(options.claudePath);
  await installHooks(options);
  const twice = await readJson(options.claudePath);

  assert.deepEqual(twice, once);
  assert.deepEqual(twice.hooks.Stop, unrelatedClaudeConfig.hooks.Stop);
  assert.equal(twice.theme, 'dark');
});

test('ownership marker matching does not consume unrelated command substrings', async (t) => {
  const options = await setup(t);
  const unrelated = {
    matcher: 'OtherTool',
    hooks: [{ type: 'command', command: 'printf HERDR_QUESTION_HOOK_V10' }],
  };
  await writeJson(options.claudePath, { hooks: { PreToolUse: [unrelated] } });

  await installHooks(options);

  const installed = await readJson(options.claudePath);
  assert.deepEqual(installed.hooks.PreToolUse[0], unrelated);
  assert.equal(installed.hooks.PreToolUse.length, 2);
});

test('changed configuration is backed up exactly and installed files are user-only', async (t) => {
  const options = await setup(t);
  const claudeBytes = Buffer.from('{"custom":{"spacing":true},"hooks":{}}\n');
  const codexBytes = Buffer.from('{\n    "description": "keep me"\n}\n');
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o755 });
  await mkdir(dirname(options.codexPath), { recursive: true, mode: 0o755 });
  await mkdir(options.configDir, { recursive: true, mode: 0o755 });
  await writeFile(options.claudePath, claudeBytes, { mode: 0o644 });
  await writeFile(options.codexPath, codexBytes, { mode: 0o644 });

  const result = await installHooks(options);
  const claudeFiles = await readdir(dirname(options.claudePath));
  const codexFiles = await readdir(dirname(options.codexPath));
  const claudeBackup = claudeFiles.find((name) => /^settings\.json\.\d{8}T\d{9}Z\.herdr-question\.bak$/.test(name));
  const codexBackup = codexFiles.find((name) => /^hooks\.json\.\d{8}T\d{9}Z\.herdr-question\.bak$/.test(name));

  assert.ok(claudeBackup);
  assert.ok(codexBackup);
  assert.deepEqual(await readFile(join(dirname(options.claudePath), claudeBackup)), claudeBytes);
  assert.deepEqual(await readFile(join(dirname(options.codexPath), codexBackup)), codexBytes);
  assert.equal((await stat(options.claudePath)).mode & 0o777, 0o600);
  assert.equal((await stat(options.codexPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.launcher.path)).mode & 0o777, 0o700);
  assert.equal((await stat(options.configDir)).mode & 0o777, 0o700);
});

test('failed transaction restores every previously changed file byte-for-byte', async (t) => {
  const options = await setup(t);
  const original = Buffer.from('{\n  "hooks": {},\n  "untouched": "exact whitespace"\n}\n');
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o700 });
  await writeFile(options.claudePath, original, { mode: 0o640 });
  options.codexPath = options.claudePath;

  await assert.rejects(() => installHooks(options), /changed during hook transaction/);

  assert.deepEqual(await readFile(options.claudePath), original);
  assert.equal((await stat(options.claudePath)).mode & 0o777, 0o640);
});

test('status distinguishes missing, installed, duplicate, and changed artifacts', async (t) => {
  const options = await setup(t);
  const missing = await hookStatus(options);
  assert.equal(missing.claude.status, 'missing');
  assert.equal(missing.codex.status, 'missing');
  assert.equal(missing.launcher.status, 'missing');

  await installHooks(options);
  const installed = await hookStatus(options);
  assert.equal(installed.claude.status, 'installed');
  assert.equal(installed.codex.status, 'installed');
  assert.equal(installed.launcher.status, 'installed');

  const claude = await readJson(options.claudePath);
  claude.hooks.PreToolUse.push(structuredClone(claude.hooks.PreToolUse.at(-1)));
  await writeJson(options.claudePath, claude);
  const codex = await readJson(options.codexPath);
  codex.hooks.PermissionRequest.at(-1).hooks[0].command += ' --locally-changed';
  await writeJson(options.codexPath, codex);
  await writeFile(installed.launcher.path, '#!/usr/bin/env node\n// locally changed\n', { mode: 0o700 });

  const drifted = await hookStatus(options);
  assert.equal(drifted.claude.status, 'duplicate');
  assert.equal(drifted.codex.status, 'changed');
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
  const remainingClaude = await readJson(options.claudePath);
  const remainingCodex = await readJson(options.codexPath);

  assert.deepEqual(remainingClaude.hooks.Stop, stop);
  assert.equal(remainingClaude.hooks.PreToolUse.length, 1);
  assert.match(remainingClaude.hooks.PreToolUse[0].hooks[0].command, /--locally-changed$/);
  assert.deepEqual(remainingClaude.hooks.PermissionRequest, []);
  assert.deepEqual(remainingCodex.hooks.PreToolUse, []);
  assert.deepEqual(remainingCodex.hooks.PermissionRequest, []);
  assert.equal(await readFile(installed.launcher.path, 'utf8'), '#!/usr/bin/env node\n// user replacement\n');
  assert.equal(result.claude.removed, 1);
  assert.equal(result.claude.changed, 1);
  assert.equal(result.codex.removed, 2);
  assert.equal(result.launcher.status, 'changed');
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
      plugins: [{ plugin_id: 'ray.herdr-question', plugin_root: pluginRoot }],
    },
  };
  await writeFile(herdrPath, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(JSON.stringify(listing))});
`, { mode: 0o700 });
  await installHooks(options);

  const child = spawn(process.execPath, [join(options.configDir, 'hook-launcher.mjs'),
    '--agent', 'codex', '--queue-root', 'queue with spaces'], {
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
    argv: ['--agent', 'codex', '--queue-root', 'queue with spaces'],
    input: '{"private":"payload"}',
  });
});

test('repair restores user-only modes without rewriting exact configuration bytes', async (t) => {
  const options = await setup(t);
  const installed = await installHooks(options);
  const claudeBytes = await readFile(options.claudePath);
  const codexBytes = await readFile(options.codexPath);
  await chmod(options.claudePath, 0o644);
  await chmod(options.codexPath, 0o644);
  await chmod(installed.launcher.path, 0o600);

  await installHooks(options);

  assert.deepEqual(await readFile(options.claudePath), claudeBytes);
  assert.deepEqual(await readFile(options.codexPath), codexBytes);
  assert.equal((await stat(options.claudePath)).mode & 0o777, 0o600);
  assert.equal((await stat(options.codexPath)).mode & 0o777, 0o600);
  assert.equal((await stat(installed.launcher.path)).mode & 0o777, 0o700);
});

test('operator CLIs use agent config homes and never mutate Codex hook trust state', async (t) => {
  const options = await setup(t);
  const claudeHome = join(options.root, 'claude-home');
  const codexHome = join(options.root, 'codex-home');
  const trustPath = join(codexHome, 'hook-trust.json');
  const trustBytes = Buffer.from('{"approved":["existing-hash"]}\n');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(trustPath, trustBytes, { mode: 0o600 });
  const env = {
    HOME: join(options.root, 'unused-home'),
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    HERDR_QUESTION_CONFIG_DIR: options.configDir,
  };

  const installed = await runCli('install-hooks.mjs', env);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).trust_review_required, true);
  assert.equal((await hookStatus({
    ...options,
    claudePath: join(claudeHome, 'settings.json'),
    codexPath: join(codexHome, 'hooks.json'),
  })).codex.status, 'installed');

  const status = await runCli('status.mjs', env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).launcher.status, 'installed');
  const uninstalled = await runCli('uninstall-hooks.mjs', env);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.equal(JSON.parse(uninstalled.stdout).launcher.status, 'removed');
  assert.deepEqual(await readFile(trustPath), trustBytes);
});

test('installed Claude and Codex groups match the hook bridge contract', async (t) => {
  const options = await setup(t);
  await installHooks(options);
  const claude = await readJson(options.claudePath);
  const codex = await readJson(options.codexPath);

  assert.equal(claude.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.equal(claude.hooks.PermissionRequest[0].matcher, '*');
  assert.equal(codex.hooks.PreToolUse[0].matcher, '^request_user_input$');
  assert.equal(codex.hooks.PermissionRequest[0].matcher, '*');
  for (const [agent, config] of [['claude', claude], ['codex', codex]]) {
    for (const event of ['PreToolUse', 'PermissionRequest']) {
      const handler = config.hooks[event][0].hooks[0];
      assert.deepEqual({ type: handler.type, timeout: handler.timeout }, {
        type: 'command', timeout: 3600,
      });
      assert.match(handler.command, /^HERDR_QUESTION_HOOK_V1=1 /);
      assert.match(handler.command, new RegExp(`--agent ${agent}(?: |$)`));
      assert.match(handler.command, / --queue-root /);
    }
  }
});

test('invalid JSON is preserved byte-for-byte and prevents partial installation', async (t) => {
  const options = await setup(t);
  const invalid = Buffer.from('{"hooks": [ this is not JSON ]}\n');
  await mkdir(dirname(options.codexPath), { recursive: true, mode: 0o700 });
  await writeFile(options.codexPath, invalid, { mode: 0o600 });

  await assert.rejects(() => installHooks(options), /JSON/);

  assert.deepEqual(await readFile(options.codexPath), invalid);
  await assert.rejects(() => readFile(options.claudePath), { code: 'ENOENT' });
  await assert.rejects(() => readFile(join(options.configDir, 'hook-launcher.mjs')), { code: 'ENOENT' });
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
  await assert.rejects(() => readFile(options.codexPath), { code: 'ENOENT' });
});

test('status reports and uninstall rejects a symlink without following it', async (t) => {
  const options = await setup(t);
  const target = join(options.root, 'real-codex-hooks.json');
  const targetBytes = Buffer.from('{"hooks":{"Stop":[]},"trust":"untouched"}\n');
  await writeFile(target, targetBytes, { mode: 0o600 });
  await mkdir(dirname(options.codexPath), { recursive: true, mode: 0o700 });
  await symlink(target, options.codexPath);

  const status = await hookStatus(options);
  assert.equal(status.codex.status, 'changed');
  assert.equal(status.codex.error, 'configuration path is unsafe');
  await assert.rejects(() => uninstallHooks(options), /symbolic link/);

  assert.equal((await lstat(options.codexPath)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(target), targetBytes);
});

test('install detects a post-backup settings edit and rolls back only its own writes', async (t) => {
  const options = await setup(t);
  const claudeBytes = Buffer.from('{\n  "hooks": {},\n  "claude_original": true\n}\n');
  const codexBytes = Buffer.from('{\n  "hooks": {},\n  "codex_original": true\n}\n');
  await mkdir(dirname(options.claudePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(options.codexPath), { recursive: true, mode: 0o700 });
  await writeFile(options.claudePath, claudeBytes, { mode: 0o600 });
  await writeFile(options.codexPath, codexBytes, { mode: 0o600 });
  let injected = false;

  await assert.rejects(() => installHooks({
    ...options,
    onBackup: async ({ name, path }) => {
      if (name !== 'codex' || injected) return;
      injected = true;
      const external = JSON.parse(await readFile(path, 'utf8'));
      external.external_new_key = 'must survive';
      await writeFile(path, `${JSON.stringify(external, null, 2)}\n`, { mode: 0o600 });
    },
  }), /changed during hook transaction/);

  assert.equal(injected, true);
  assert.deepEqual(await readFile(options.claudePath), claudeBytes);
  assert.equal((await readJson(options.codexPath)).external_new_key, 'must survive');
  await assert.rejects(() => readFile(join(options.configDir, 'hook-launcher.mjs')), { code: 'ENOENT' });
});

test('uninstall detects a post-backup edit and keeps installed hooks plus external data', async (t) => {
  const options = await setup(t);
  await installHooks(options);
  const installedClaude = await readFile(options.claudePath);
  let injected = false;

  await assert.rejects(() => uninstallHooks({
    ...options,
    onBackup: async ({ name, path }) => {
      if (name !== 'codex' || injected) return;
      injected = true;
      const external = JSON.parse(await readFile(path, 'utf8'));
      external.external_new_key = 'must survive uninstall';
      await writeFile(path, `${JSON.stringify(external, null, 2)}\n`, { mode: 0o600 });
    },
  }), /changed during hook transaction/);

  assert.equal(injected, true);
  assert.deepEqual(await readFile(options.claudePath), installedClaude);
  assert.equal((await readJson(options.codexPath)).external_new_key, 'must survive uninstall');
  assert.equal((await hookStatus(options)).launcher.status, 'installed');
});

test('rollback never overwrites an external edit to an artifact already written by the plugin', async (t) => {
  const options = await setup(t);
  await writeJson(options.claudePath, { hooks: {}, original: 'claude' });
  await writeJson(options.codexPath, { hooks: {}, original: 'codex' });

  await assert.rejects(() => installHooks({
    ...options,
    onBackup: async ({ name, path }) => {
      if (name !== 'codex') return;
      const codexExternal = JSON.parse(await readFile(path, 'utf8'));
      codexExternal.external_codex = true;
      await writeFile(path, `${JSON.stringify(codexExternal, null, 2)}\n`, { mode: 0o600 });
      const claudeExternal = await readJson(options.claudePath);
      claudeExternal.external_claude = true;
      await writeJson(options.claudePath, claudeExternal);
    },
  }), /changed during hook transaction/);

  assert.equal((await readJson(options.claudePath)).external_claude, true);
  assert.equal((await readJson(options.codexPath)).external_codex, true);
});
