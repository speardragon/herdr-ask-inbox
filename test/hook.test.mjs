import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { runHook } from '../bin/hook.mjs';
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
    reportBlocked: async (request) => { reports.push(request.request_id); },
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
  assert.deepEqual(reports, [request.request_id]);
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
    timeoutMs: 25,
  });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.output, null);
  assert.deepEqual(await timeoutQueue.list(), []);

  const handoffQueue = await temporaryQueue(t);
  const pending = runHook({
    agent: 'claude',
    payload,
    env,
    queue: handoffQueue,
    reportBlocked: async () => {},
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
  const child = spawn(process.execPath, [
    new URL('../bin/hook.mjs', import.meta.url).pathname,
    '--agent', 'claude',
    '--queue-root', root,
    '--timeout-ms', '1000',
  ], {
    env: { ...process.env, ...env },
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
  const child = spawn(process.execPath, [
    new URL('../bin/hook.mjs', import.meta.url).pathname,
    '--agent', 'codex',
    '--queue-root', root,
    '--timeout-ms', '25',
  ], {
    env: { ...process.env, ...env, PRIVATE_EXAMPLE_TOKEN: 'must-not-appear' },
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
  const result = await runHook({
    agent: 'claude',
    payload: await fixture('claude/permission-request.json'),
    env,
    queue,
    reportBlocked: async () => { throw new Error('report unavailable'); },
    timeoutMs: 50,
  });

  assert.equal(result.status, 'report_failed');
  assert.equal(result.output, null);
  assert.deepEqual(await queue.list(), []);
});
