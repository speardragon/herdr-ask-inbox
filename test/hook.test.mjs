import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { createHerdrLifecycle, runHook } from '../bin/hook.mjs';
import { openQueue } from '../src/queue.mjs';

const env = {
  HERDR_PANE_ID: 'w1:p1',
  HERDR_WORKSPACE_ID: 'w1',
  CLAUDE_CODE_VERSION: '2.1.0',
  CODEX_VERSION: '0.101.0',
};

async function fixture(relativePath) {
  return JSON.parse(await readFile(new URL(`../fixtures/${relativePath}`, import.meta.url), 'utf8'));
}

async function temporaryQueue(t) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openQueue(root);
}

async function fakeHerdr(t, root, logPath) {
  const path = join(root, 'fake-herdr.mjs');
  const logStatement = logPath
    ? `await import('node:fs/promises').then(({ appendFile }) => appendFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n'));\n`
    : '';
  await writeFile(path, `#!/usr/bin/env node\n${logStatement}process.exit(0);\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  t.after(() => rm(path, { force: true }));
  return path;
}

function capture(stream) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { value += chunk; });
  return () => value;
}

async function terminateChild(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => { timer = setTimeout(resolve, 1_000, false); }),
  ]).finally(() => clearTimeout(timer));
  if (stopped || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise((resolve) => { timer = setTimeout(resolve, 1_000); }),
  ]).finally(() => clearTimeout(timer));
}

test('Codex question transport arms the queue and returns without blocking or reporting', async (t) => {
  const queue = await temporaryQueue(t);
  let blockedReports = 0;

  const result = await runHook({
    agent: 'codex',
    payload: await fixture('codex/request-user-input.json'),
    env,
    queue,
    reportBlocked: async () => { blockedReports += 1; },
    releaseBlocked: async () => { blockedReports += 100; },
    openPopup: async () => { blockedReports += 1_000; },
  });

  assert.equal(result.status, 'armed');
  assert.equal(result.output, null);
  assert.equal(blockedReports, 0);
  assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), [result.request.request_id]);
});

test('direct hook transport reports blocked, waits, and returns exact adapter JSON', async (t) => {
  const queue = await temporaryQueue(t);
  const payload = await fixture('claude/ask-user-question.json');
  const reports = [];
  const pending = runHook({
    agent: 'claude',
    payload,
    env,
    queue,
    reportBlocked: async () => { reports.push('report'); },
    releaseBlocked: async () => { reports.push('release'); },
    openPopup: async () => { reports.push('open'); },
    timeoutMs: 1_000,
  });

  let [request] = await queue.list();
  for (let attempt = 0; !request && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    [request] = await queue.list();
  }
  assert.ok(request);
  await queue.respond({
    schema_version: 1,
    request_id: request.request_id,
    action: 'answer',
    value: { answers: { 'Which framework?': 'React' } },
    created_at_ms: request.created_at_ms + 1,
  });

  const result = await pending;
  assert.deepEqual(reports, ['report', 'release']);
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.output, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        questions: payload.tool_input.questions,
        answers: { 'Which framework?': 'React' },
      },
    },
  });
});

test('direct hook timeout and handoff return no decision output', async (t) => {
  const payload = await fixture('claude/permission-request.json');
  const timeoutQueue = await temporaryQueue(t);
  const timedOut = await runHook({
    agent: 'claude',
    payload,
    env,
    queue: timeoutQueue,
    reportBlocked: async () => {},
    releaseBlocked: async () => {},
    openPopup: async () => {},
    timeoutMs: 25,
  });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.output, null);
  assert.deepEqual(await timeoutQueue.list(), []);
  assert.equal(await timeoutQueue.takeResponse(timedOut.request.request_id), null);

  const handoffQueue = await temporaryQueue(t);
  const pending = runHook({
    agent: 'claude',
    payload,
    env,
    queue: handoffQueue,
    reportBlocked: async () => {},
    releaseBlocked: async () => {},
    openPopup: async () => {},
    timeoutMs: 500,
  });
  let [request] = await handoffQueue.list();
  for (let attempt = 0; !request && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    [request] = await handoffQueue.list();
  }
  await handoffQueue.respond({
    schema_version: 1,
    request_id: request.request_id,
    action: 'handoff',
    value: null,
    created_at_ms: request.created_at_ms + 1,
  });
  const handedOff = await pending;
  assert.equal(handedOff.status, 'handoff');
  assert.equal(handedOff.output, null);
});

test('hook CLI writes only the exact blocking decision JSON to stdout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-hook-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = await openQueue(root);
  const payload = await fixture('claude/ask-user-question.json');
  const herdrBin = await fakeHerdr(t, root);
  const child = spawn(process.execPath, [
    new URL('../bin/hook.mjs', import.meta.url).pathname,
    '--agent', 'claude',
    '--queue-root', root,
    '--timeout-ms', '1000',
  ], {
    env: { ...process.env, ...env, HERDR_BIN_PATH: herdrBin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(() => terminateChild(child, exited));
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  child.stdin.end(JSON.stringify(payload));

  let [request] = await queue.list();
  for (let attempt = 0; !request && attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    [request] = await queue.list();
  }
  assert.ok(request);
  await queue.respond({
    schema_version: 1,
    request_id: request.request_id,
    action: 'answer',
    value: { answers: { 'Which framework?': 'Vue' } },
    created_at_ms: request.created_at_ms + 1,
  });

  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(stderr(), '');
  assert.equal(stdout(), JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        questions: payload.tool_input.questions,
        answers: { 'Which framework?': 'Vue' },
      },
    },
  }));
});

test('hook CLI timeout exits zero with completely empty output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-hook-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = await fixture('codex/permission-request.json');
  const herdrBin = await fakeHerdr(t, root);
  const child = spawn(process.execPath, [
    new URL('../bin/hook.mjs', import.meta.url).pathname,
    '--agent', 'codex',
    '--queue-root', root,
    '--timeout-ms', '25',
  ], {
    env: {
      ...process.env,
      ...env,
      HERDR_BIN_PATH: herdrBin,
      PRIVATE_EXAMPLE_TOKEN: 'must-not-appear',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(() => terminateChild(child, exited));
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  child.stdin.end(JSON.stringify(payload));

  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(stdout(), '');
  assert.equal(stderr(), '');
  const queue = await openQueue(root);
  assert.deepEqual(await queue.list(), []);
});

test('blocked reporting failure cancels the queued request and returns no decision', async (t) => {
  const queue = await temporaryQueue(t);
  const lifecycle = [];
  const result = await runHook({
    agent: 'claude',
    payload: await fixture('claude/permission-request.json'),
    env,
    queue,
    reportBlocked: async () => { lifecycle.push('report'); throw new Error('report unavailable'); },
    openPopup: async () => { lifecycle.push('open'); throw new Error('popup unavailable'); },
    releaseBlocked: async () => { lifecycle.push('release'); },
    timeoutMs: 50,
  });

  assert.equal(result.status, 'report_failed');
  assert.equal(result.output, null);
  assert.deepEqual(lifecycle, ['report', 'open', 'release']);
  assert.deepEqual(await queue.list(), []);
  assert.equal(await queue.takeResponse(result.request.request_id), null);
});

test('herdr blocked lifecycle uses argv arrays and plugin-owned release identity', async () => {
  const calls = [];
  const lifecycle = createHerdrLifecycle({
    bin: '/fake/herdr',
    execFile: async (bin, args) => { calls.push({ bin, args }); return { stdout: '' }; },
  });
  const request = {
    source: { pane_id: 'w1:p1', agent: 'claude', session_id: 'session-1' },
  };

  await lifecycle.reportBlocked(request);
  await lifecycle.openPopup(request);
  await lifecycle.releaseBlocked(request);

  assert.deepEqual(calls, [
    {
      bin: '/fake/herdr',
      args: [
        'pane', 'report-agent', 'w1:p1',
        '--source', 'ray.herdr-question',
        '--agent', 'claude',
        '--state', 'blocked',
        '--agent-session-id', 'session-1',
      ],
    },
    {
      bin: '/fake/herdr',
      args: ['plugin', 'pane', 'open', '--plugin', 'ray.herdr-question', '--entrypoint', 'question', '--focus'],
    },
    {
      bin: '/fake/herdr',
      args: [
        'pane', 'release-agent', 'w1:p1',
        '--source', 'ray.herdr-question',
        '--agent', 'claude',
      ],
    },
  ]);
});

test('signal interruption cancels and consumes private queued state before release', async (t) => {
  const queue = await temporaryQueue(t);
  const controller = new AbortController();
  const lifecycle = [];
  const pending = runHook({
    agent: 'claude',
    payload: await fixture('claude/permission-request.json'),
    env,
    queue,
    reportBlocked: async () => { lifecycle.push('report'); },
    openPopup: async () => { lifecycle.push('open'); },
    releaseBlocked: async () => { lifecycle.push('release'); },
    signal: controller.signal,
    timeoutMs: 1_000,
  });
  for (let attempt = 0; (await queue.list()).length === 0 && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  const result = await pending;

  assert.equal(result.status, 'interrupted');
  assert.equal(result.output, null);
  assert.deepEqual(lifecycle, ['report', 'release']);
  assert.deepEqual(await queue.list(), []);
  assert.equal(await queue.takeResponse(result.request.request_id), null);
});

test('duplicate stable hook invocation does not create a second blocked waiter', async (t) => {
  const queue = await temporaryQueue(t);
  const payload = await fixture('claude/ask-user-question.json');
  const reports = [];
  const options = {
    agent: 'claude', payload, env, queue, timeoutMs: 1_000,
    reportBlocked: async () => { reports.push('report'); },
    openPopup: async () => {},
    releaseBlocked: async () => { reports.push('release'); },
  };
  const first = runHook(options);
  for (let attempt = 0; (await queue.list()).length === 0 && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const duplicate = await runHook(options);
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(reports, ['report']);
  const [request] = await queue.list();
  await queue.respond({
    schema_version: 1,
    request_id: request.request_id,
    action: 'handoff',
    value: null,
    created_at_ms: request.created_at_ms + 1,
  });
  assert.equal((await first).status, 'handoff');
});

test('identical Codex permissions in one turn remain distinct end-to-end occurrences', async (t) => {
  const queue = await temporaryQueue(t);
  const payload = await fixture('codex/permission-request.json');
  const lifecycle = {
    reportBlocked: async () => {},
    openPopup: async () => {},
    releaseBlocked: async () => {},
  };
  const first = runHook({
    agent: 'codex', payload, env, queue, ...lifecycle, timeoutMs: 1_000,
  });
  const second = runHook({
    agent: 'codex', payload, env, queue, ...lifecycle, timeoutMs: 1_000,
  });

  let requests = await queue.list();
  for (let attempt = 0; requests.length < 2 && attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    requests = await queue.list();
  }
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].request_id, requests[1].request_id);
  for (const request of requests) {
    await queue.respond({
      schema_version: 1,
      request_id: request.request_id,
      action: 'handoff',
      value: null,
      created_at_ms: request.created_at_ms + 1,
    });
  }
  assert.deepEqual((await Promise.all([first, second])).map(({ status }) => status), [
    'handoff', 'handoff',
  ]);
});

test('stable launcher symlink executes hook CLI and arms Codex question', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-hook-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = join(root, 'hook-launcher.mjs');
  await symlink(new URL('../bin/hook.mjs', import.meta.url), launcher);
  const child = spawn(process.execPath, [launcher, '--agent', 'codex', '--queue-root', root], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(() => terminateChild(child, exited));
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  child.stdin.end(JSON.stringify(await fixture('codex/request-user-input.json')));
  assert.deepEqual(await exited, [0, null]);
  assert.equal(stdout(), '');
  assert.equal(stderr(), '');
  assert.equal((await (await openQueue(root)).list()).length, 1);
});

test('oversized and deeply nested stdin fail closed without queued state or secrets', async (t) => {
  for (const [name, input] of [
    ['oversized', JSON.stringify({ private: 'x'.repeat(1_048_576) })],
    ['nested', `${'{"x":'.repeat(80)}null${'}'.repeat(80)}`],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `herdr-question-hook-${name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = spawn(process.execPath, [
      new URL('../bin/hook.mjs', import.meta.url).pathname,
      '--agent', 'claude', '--queue-root', root,
    ], {
      env: { ...process.env, ...env, PRIVATE_EXAMPLE_TOKEN: 'must-not-appear' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    t.after(() => terminateChild(child, exited));
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    child.stdin.end(input);
    assert.deepEqual(await exited, [0, null]);
    assert.equal(stdout(), '');
    assert.equal(stderr(), '');
    assert.deepEqual(await (await openQueue(root)).list(), []);
  }
});

test('CLI SIGTERM exits zero after consuming private state and releasing blocked authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-question-hook-signal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lifecycleLog = join(root, 'lifecycle.jsonl');
  const herdrBin = await fakeHerdr(t, root, lifecycleLog);
  const queue = await openQueue(root);
  const child = spawn(process.execPath, [
    new URL('../bin/hook.mjs', import.meta.url).pathname,
    '--agent', 'claude', '--queue-root', root, '--timeout-ms', '5000',
  ], {
    env: { ...process.env, ...env, HERDR_BIN_PATH: herdrBin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(() => terminateChild(child, exited));
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  child.stdin.end(JSON.stringify(await fixture('claude/permission-request.json')));

  let reportSeen = false;
  for (let attempt = 0; !reportSeen && attempt < 80; attempt += 1) {
    const contents = await readFile(lifecycleLog, 'utf8').catch(() => '');
    reportSeen = contents.includes('report-agent');
    if (!reportSeen) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reportSeen, true);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  assert.equal(stdout(), '');
  assert.equal(stderr(), '');
  assert.deepEqual(await queue.list(), []);
  const calls = (await readFile(lifecycleLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args.includes('release-agent')), true);
});

test('response encoding error releases lifecycle and leaves no private queue state', async (t) => {
  const queue = await temporaryQueue(t);
  const lifecycle = [];
  const pending = runHook({
    agent: 'claude',
    payload: await fixture('claude/ask-user-question.json'),
    env,
    queue,
    reportBlocked: async () => { lifecycle.push('report'); },
    openPopup: async () => {},
    releaseBlocked: async () => { lifecycle.push('release'); },
    timeoutMs: 1_000,
  });
  let [request] = await queue.list();
  for (let attempt = 0; !request && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    [request] = await queue.list();
  }
  await queue.respond({
    schema_version: 1,
    request_id: request.request_id,
    action: 'answer',
    value: { answers: {} },
    created_at_ms: request.created_at_ms + 1,
  });
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.deepEqual(lifecycle, ['report', 'release']);
  assert.deepEqual(await queue.list(), []);
  assert.equal(await queue.takeResponse(request.request_id), null);
});
