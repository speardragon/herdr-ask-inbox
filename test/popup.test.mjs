import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';

import { runPopup } from '../bin/popup.mjs';
import { openQueue } from '../src/queue.mjs';

const TOKEN = '11111111-1111-4111-8111-111111111111';

function requestFor(id, createdAt = 10) {
  return {
    schema_version: 1,
    request_id: id,
    created_at_ms: createdAt,
    source: {
      agent: 'claude',
      pane_id: 'workspace-a:pane-a',
      workspace_id: 'workspace-a',
      session_id: 'session-a',
      cwd: '/workspace/project',
    },
    kind: 'question',
    transport: 'hook-response',
    title: `Choose ${id}`,
    detail: {},
    questions: [{
      question: `Question ${id}?`,
      header: 'Choice',
      options: [
        { label: 'First', description: 'Choose first.' },
        { label: 'Second', description: 'Choose second.' },
      ],
      multiSelect: false,
    }],
    permission: null,
    status: 'waiting',
  };
}

async function temporaryQueue(t) {
  const root = await mkdtemp(join(tmpdir(), 'ask-inbox-popup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openQueue(root);
}

async function openingLease(queue, token = TOKEN) {
  await writeFile(join(queue.root, 'popup-modal.json'), `${JSON.stringify({
    schema_version: 1,
    token,
    state: 'opening',
    owner_pid: process.pid,
    heartbeat_ms: Date.now(),
  })}\n`, { mode: 0o600 });
}

function ttyReadable(chunks) {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  stream.isTTY = true;
  stream.rawCalls = [];
  stream.setRawMode = (value) => {
    stream.rawCalls.push(value);
    return stream;
  };
  return stream;
}

function ttyWritable() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  stream.isTTY = true;
  stream.columns = 82;
  stream.rows = 26;
  stream.text = () => Buffer.concat(chunks).toString('utf8');
  return stream;
}

function fakeProcess() {
  const emitter = new EventEmitter();
  emitter.exitCode = undefined;
  return emitter;
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('test condition was not reached');
}

const unusedHerdr = {
  focusAgent: async () => {},
};

test('non-interactive invocation reports a diagnostic and never opens or mutates the queue', async () => {
  let queueCalls = 0;
  const queue = {
    list: async () => { queueCalls += 1; },
    withPopupLock: async () => { queueCalls += 1; },
  };
  const stdin = Readable.from([]);
  stdin.isTTY = false;
  const stdout = ttyWritable();
  const stderr = ttyWritable();

  const code = await runPopup({
    env: { ASK_INBOX_POPUP_TOKEN: TOKEN },
    stdin,
    stdout,
    stderr,
    queue,
    herdr: unusedHerdr,
    processRef: fakeProcess(),
  });

  assert.notEqual(code, 0);
  assert.equal(queueCalls, 0);
  assert.equal(stdout.text(), '');
  assert.match(stderr.text(), /interactive terminal/i);
});

test('popup claims exact modal token, restores raw mode, answers, and exits on an empty queue', async (t) => {
  const queue = await temporaryQueue(t);
  const request = requestFor('request-a');
  await queue.enqueue(request);
  await openingLease(queue);
  const stdin = ttyReadable(['\r']);
  const stdout = ttyWritable();
  const stderr = ttyWritable();

  const code = await runPopup({
    env: { ASK_INBOX_POPUP_TOKEN: TOKEN },
    stdin,
    stdout,
    stderr,
    queue,
    herdr: unusedHerdr,
    processRef: fakeProcess(),
  });

  assert.equal(code, 0, stderr.text());
  assert.deepEqual(stdin.rawCalls, [true, false]);
  assert.equal(stdout.text().includes('Question request-a?'), true);
  assert.equal(stderr.text(), '');
  assert.deepEqual((await queue.takeResponse(request.request_id)).value, {
    answers: { 'Question request-a?': 'First' },
  });
  await assert.rejects(readFile(join(queue.root, 'popup-modal.json')), { code: 'ENOENT' });
});

test('native handoff exits immediately without rendering the next FIFO request', async (t) => {
  const queue = await temporaryQueue(t);
  const first = requestFor('request-a', 10);
  const second = requestFor('request-b', 20);
  await queue.enqueue(second);
  await queue.enqueue(first);
  await openingLease(queue);
  const seen = [];
  const deliver = async (request, selection) => {
    seen.push([request.request_id, selection]);
    await queue.cancel(request.request_id);
    await queue.takeResponse(request.request_id);
    return { status: 'handed-off' };
  };
  const stdout = ttyWritable();

  const fifoStderr = ttyWritable();
  const code = await runPopup({
    env: { ASK_INBOX_POPUP_TOKEN: TOKEN },
    stdin: ttyReadable(['g']),
    stdout,
    stderr: fifoStderr,
    queue,
    herdr: unusedHerdr,
    processRef: fakeProcess(),
    deliver,
  });

  assert.equal(code, 0, fifoStderr.text());
  assert.deepEqual(seen.map(([id]) => id), ['request-a']);
  assert.equal(seen[0][1].type, 'handoff');
  assert.equal(stdout.text().includes('Question request-a?'), true);
  assert.equal(stdout.text().includes('Question request-b?'), false);
  assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), ['request-b']);
  await assert.rejects(readFile(join(queue.root, 'popup-modal.json')), { code: 'ENOENT' });
});

test('wrong modal token refuses ownership without changing pending requests', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor('request-a'));
  await openingLease(queue);
  const stdin = ttyReadable(['\r']);
  const stderr = ttyWritable();

  const code = await runPopup({
    env: { ASK_INBOX_POPUP_TOKEN: '22222222-2222-4222-8222-222222222222' },
    stdin,
    stdout: ttyWritable(),
    stderr,
    queue,
    herdr: unusedHerdr,
    processRef: fakeProcess(),
  });

  assert.notEqual(code, 0);
  assert.deepEqual(stdin.rawCalls, []);
  assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), ['request-a']);
  assert.match(stderr.text(), /modal/i);
  assert.equal((await readFile(join(queue.root, 'popup-modal.json'), 'utf8')).includes(TOKEN), true);
});

test('SIGINT, SIGTERM, SIGHUP, SIGQUIT, and failures restore raw mode and clear the owned lease', async (t) => {
  for (const variant of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'failure']) {
    const queue = await temporaryQueue(t);
    const request = requestFor(`request-${variant}`);
    await queue.enqueue(request);
    await openingLease(queue);
    const stdin = variant === 'failure' ? ttyReadable(['\r']) : new PassThrough();
    stdin.isTTY = true;
    stdin.rawCalls = [];
    stdin.setRawMode = (value) => { stdin.rawCalls.push(value); return stdin; };
    const processRef = fakeProcess();
    const deliver = variant === 'failure'
      ? async () => { throw new Error('secret payload must not be logged'); }
      : async () => {};
    const promise = runPopup({
      env: { ASK_INBOX_POPUP_TOKEN: TOKEN },
      stdin,
      stdout: ttyWritable(),
      stderr: ttyWritable(),
      queue,
      herdr: unusedHerdr,
      processRef,
      deliver,
    });
    if (variant !== 'failure') {
      await waitUntil(() => stdin.rawCalls.includes(true));
      processRef.emit(variant);
    }
    const code = await promise;
    assert.notEqual(code, 0);
    assert.deepEqual(stdin.rawCalls, [true, false]);
    await assert.rejects(readFile(join(queue.root, 'popup-modal.json')), { code: 'ENOENT' });
    assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), [request.request_id]);
    for (const event of [
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      'SIGQUIT',
      'SIGWINCH',
      'uncaughtException',
      'unhandledRejection',
    ]) {
      assert.equal(processRef.listenerCount(event), 0, `leaked ${event} listener`);
    }
  }
});

test('resize redraws the current request without consuming it', async (t) => {
  const queue = await temporaryQueue(t);
  await queue.enqueue(requestFor('request-a'));
  await openingLease(queue);
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.rawCalls = [];
  stdin.setRawMode = (value) => { stdin.rawCalls.push(value); return stdin; };
  const stdout = ttyWritable();
  const processRef = fakeProcess();
  const promise = runPopup({
    env: { ASK_INBOX_POPUP_TOKEN: TOKEN },
    stdin,
    stdout,
    stderr: ttyWritable(),
    queue,
    herdr: unusedHerdr,
    processRef,
    deliver: async () => {},
  });
  await waitUntil(() => stdin.rawCalls.includes(true) && stdout.text().includes('\u001b[2J'));
  const before = stdout.text().split('\u001b[2J').length;
  stdout.columns = 40;
  processRef.emit('SIGWINCH');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stdout.text().split('\u001b[2J').length > before, true);
  processRef.emit('SIGINT');
  assert.notEqual(await promise, 0);
  assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), ['request-a']);
});

test('resize write errors, stream errors, and uncaught exceptions stop through awaited cleanup', async (t) => {
  for (const variant of ['resize-write', 'stdin-error', 'uncaughtException']) {
    const queue = await temporaryQueue(t);
    const request = requestFor(`request-${variant}`);
    await queue.enqueue(request);
    await openingLease(queue);
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.rawCalls = [];
    stdin.setRawMode = (value) => { stdin.rawCalls.push(value); return stdin; };
    const stdout = ttyWritable();
    const originalWrite = stdout.write.bind(stdout);
    stdout.failWrites = false;
    stdout.write = (...args) => {
      if (stdout.failWrites) throw new Error('event-driven write failed');
      return originalWrite(...args);
    };
    const processRef = fakeProcess();
    const promise = runPopup({
      env: { ASK_INBOX_POPUP_TOKEN: TOKEN },
      stdin,
      stdout,
      stderr: ttyWritable(),
      queue,
      herdr: unusedHerdr,
      processRef,
      deliver: async () => {},
    });
    await waitUntil(() => stdin.rawCalls.includes(true) && stdout.text().includes('\u001b[2J'));
    if (variant === 'resize-write') {
      stdout.failWrites = true;
      processRef.emit('SIGWINCH');
    } else if (variant === 'stdin-error') {
      stdin.emit('error', new Error('stream failed'));
    } else {
      processRef.emit('uncaughtException', new Error('standalone failure'));
    }
    assert.notEqual(await promise, 0);
    assert.deepEqual(stdin.rawCalls, [true, false]);
    await assert.rejects(readFile(join(queue.root, 'popup-modal.json')), { code: 'ENOENT' });
    assert.deepEqual((await queue.list()).map(({ request_id }) => request_id), [request.request_id]);
    assert.equal(processRef.eventNames().length, 0);
  }
});

test('split UTF-8 input retains a family ZWJ grapheme and backspace removes it whole', async (t) => {
  const queue = await temporaryQueue(t);
  const request = requestFor('request-unicode');
  await queue.enqueue(request);
  await openingLease(queue);
  const family = Buffer.from('👨‍👩‍👧‍👦');
  const korean = Buffer.from('한글');
  const chunks = [
    Buffer.from('\u001b[B\u001b[B\r'),
    korean.subarray(0, 1),
    korean.subarray(1, 3),
    family.subarray(0, 5),
    family.subarray(5, 11),
    family.subarray(11),
    Buffer.from('\u007f'),
    korean.subarray(3, 4),
    korean.subarray(4),
    Buffer.from('\r'),
  ];
  const stdin = ttyReadable(chunks);
  const stderr = ttyWritable();

  const code = await runPopup({
    env: { ASK_INBOX_POPUP_TOKEN: TOKEN },
    stdin,
    stdout: ttyWritable(),
    stderr,
    queue,
    herdr: unusedHerdr,
    processRef: fakeProcess(),
  });

  assert.equal(code, 0, stderr.text());
  assert.deepEqual((await queue.takeResponse(request.request_id)).value, {
    answers: { 'Question request-unicode?': '한글' },
  });
});
