import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WorkIpcClient, applyWorkPatches } from '../src/work-ipc.mjs';

const THREAD = 'test-work-thread';
const OWNER = 'test-owner';
const CLIENT = 'test-assigned-client';
const input = [{ type: 'text', text: 'Perform the synthetic task.' }];

function fixture() {
  return {
    id: THREAD,
    cwd: '/tmp/synthetic-work',
    latestModel: 'synthetic-model',
    threadRuntimeStatus: { type: 'active' },
    turns: [],
    turnHistory: {
      kind: 'canonical',
      history: {
        generation: 1,
        isComplete: true,
        islands: [{ id: 'synthetic-island', entries: [{ key: 'turn:turn-1', value: 'turn:turn-1' }] }],
        entitiesByKey: {
          'turn:turn-1': { turnId: 'turn-1', status: 'inProgress', params: { threadId: THREAD, clientUserMessageId: 'synthetic-user-message', input }, items: [{ type: 'agentMessage', id: 'agent-1', text: 'Synthetic progress.' }] },
        },
      },
    },
  };
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function mockDesktop(t, handler = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'work-ipc-test-'));
  const socketPath = path.join(directory, 'ipc.sock');
  const sockets = new Set();
  const messages = [];
  const send = (socket, message) => socket.write(frame(message));
  const reply = (socket, request, result, owner = OWNER) => send(socket, { type: 'response', requestId: request.requestId, resultType: 'success', method: request.method, handledByClientId: owner, result });
  const state = (socket, change, extra = {}) => send(socket, { type: 'broadcast', sourceClientId: OWNER, method: 'thread-stream-state-changed', version: 11, targetClientIds: [CLIENT], params: { hostId: 'local', conversationId: THREAD, change }, ...extra });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        messages.push(message);
        if (handler({ socket, message, send, reply, state }) === true) continue;
        if (message.type === 'request' && message.method === 'initialize') reply(socket, message, { clientId: CLIENT }, CLIENT);
        else if (message.type === 'request' && message.method === 'thread-owner-discovery') reply(socket, message, { supportsUntrustedAppInput: true });
        else if (message.type === 'broadcast' && message.method === 'thread-stream-following-changed' && message.params.following) state(socket, { type: 'snapshot', revision: 1, conversationState: fixture() });
        else if (message.type === 'request') reply(socket, message, { ok: true });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const client = new WorkIpcClient({ socketPath, requestTimeoutMs: 500 });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { client, server, socketPath, messages, send, reply, state, sockets };
}

test('Work connection identifies itself honestly and uses assigned client ID and UUID requests', async t => {
  const { client, messages } = await mockDesktop(t);
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(await client.discover(THREAD), OWNER);
  const initialize = messages.find(message => message.method === 'initialize');
  assert.deepEqual(initialize.params, { clientType: 'chatgpt-remote-control' });
  assert.equal(initialize.version, 0);
  assert.equal(initialize.sourceClientId, 'initializing-client');
  const discovery = messages.find(message => message.method === 'thread-owner-discovery');
  assert.equal(discovery.version, 1);
  assert.equal(discovery.sourceClientId, CLIENT);
  assert.deepEqual(discovery.params, { hostId: 'local', conversationId: THREAD });
  assert.match(discovery.requestId, /^[0-9a-f-]{36}$/);
});

test('snapshot follows only the requested owner and applies canonical Immer patches in sequence', async t => {
  const mock = await mockDesktop(t);
  const before = await mock.client.snapshot(THREAD);
  assert.deepEqual(before, fixture());
  const subscription = mock.messages.find(message => message.method === 'thread-stream-following-changed');
  assert.deepEqual(subscription.targetClientIds, [OWNER]);
  assert.equal(subscription.version, 1);
  const socket = [...mock.sockets][0];
  mock.state(socket, { type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-1', 'status'], value: 'completed' },
    { op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:turn-1', 'items', 0, 'text'], value: 'Synthetic final result.' },
    { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } },
  ] });
  const after = await mock.client.stateFor(THREAD);
  assert.equal(after.turnHistory.history.entitiesByKey['turn:turn-1'].status, 'completed');
  assert.equal(after.turnHistory.history.entitiesByKey['turn:turn-1'].items[0].text, 'Synthetic final result.');
  assert.equal(before.turnHistory.history.entitiesByKey['turn:turn-1'].status, 'inProgress');
  after.id = 'changed-by-caller';
  assert.equal((await mock.client.snapshot(THREAD)).id, THREAD);
});

test('frame decoder handles split headers, split payloads and coalesced frames', async t => {
  const mock = await mockDesktop(t, ({ socket, message, state }) => {
    if (message.method !== 'thread-stream-following-changed' || !message.params.following) return;
    const snapshot = frame({ type: 'broadcast', sourceClientId: OWNER, method: 'thread-stream-state-changed', version: 11, params: { hostId: 'local', conversationId: THREAD, change: { type: 'snapshot', revision: 1, conversationState: fixture() } } });
    socket.write(snapshot.subarray(0, 2));
    socket.write(snapshot.subarray(2, 27));
    socket.write(Buffer.concat([snapshot.subarray(27), frame({ type: 'broadcast', method: 'unrelated-event', params: {} })]));
    return true;
  });
  assert.equal((await mock.client.snapshot(THREAD)).id, THREAD);
});

test('RPC mutation versions and parameters match desktop follower protocol', async t => {
  const mock = await mockDesktop(t, ({ socket, message, reply }) => {
    if (message.method === 'thread-follower-start-turn' || message.method === 'thread-follower-steer-turn') {
      reply(socket, message, { result: { turn: { id: 'turn-2', status: 'inProgress' } } });
      return true;
    }
  });
  const requestId = randomUUID();
  const started = await mock.client.startTurn(THREAD, input, { requestId, clientUserMessageId: 'new-user-message' });
  assert.equal(started.turn.id, 'turn-2');
  assert.equal(started.turn.status, 'inProgress');
  const start = mock.messages.find(message => message.method === 'thread-follower-start-turn');
  assert.equal(start.version, 2);
  assert.equal(start.requestId, requestId);
  assert.equal(start.targetClientId, OWNER);
  assert.deepEqual(start.params.turnStart, { request: { threadId: THREAD, clientUserMessageId: 'new-user-message', input }, context: { inheritThreadSettings: true } });
  await mock.client.steerTurn(THREAD, input, { expectedTurnId: 'turn-1' });
  const steer = mock.messages.find(message => message.method === 'thread-follower-steer-turn');
  assert.equal(steer.version, 1);
  assert.ok(steer.params.restoreMessage.id);
  assert.deepEqual(steer.params.restoreMessage.context.workspaceRoots, ['/tmp/synthetic-work']);
  assert.equal(steer.params.expectedTurnId, undefined);
  await mock.client.interrupt(THREAD, { expectedTurnId: 'turn-1' });
  await mock.client.interrupt(THREAD);
  const interrupts = mock.messages.filter(message => message.method === 'thread-follower-interrupt-turn');
  assert.equal(interrupts[0].version, 4);
  assert.deepEqual(interrupts[0].params, { conversationId: THREAD, mode: 'user-stop', expectedTurnId: 'turn-1' });
  assert.equal(interrupts[1].version, 3);
  const compacted = await mock.client.compact(THREAD);
  assert.deepEqual(compacted, { ok: true });
  const compact = mock.messages.find(message => message.method === 'thread-follower-compact-thread');
  assert.equal(compact.version, 1);
  assert.deepEqual(compact.params, { conversationId: THREAD });
});

test('steer refuses a stale expected turn without sending the mutation', async t => {
  const { client, messages } = await mockDesktop(t);
  await assert.rejects(client.steerTurn(THREAD, input, { expectedTurnId: 'old-turn' }), { code: 'turn-mismatch' });
  assert.equal(messages.some(message => message.method === 'thread-follower-steer-turn'), false);
});

test('RPC error is exposed and a mutation timeout is marked uncertain without retry', async t => {
  const { client, messages } = await mockDesktop(t, ({ socket, message, send }) => {
    if (message.method === 'thread-follower-compact-thread') {
      send(socket, { type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-handler-for-request' });
      return true;
    }
    if (message.method === 'thread-follower-start-turn') return true;
  });
  await assert.rejects(client.compact(THREAD), { code: 'rpc-error', outcomeUnknown: false });
  client.requestTimeoutMs = 20;
  await assert.rejects(client.startTurn(THREAD, input), { code: 'request-timeout', outcomeUnknown: true });
  assert.equal(messages.filter(message => message.method === 'thread-follower-start-turn').length, 1);
  assert.equal(client.pending.size, 0);
});

test('owner handler errors are uncertain because failure may occur after mutation acceptance', async t => {
  const { client } = await mockDesktop(t, ({ socket, message, send }) => {
    if (message.method === 'thread-follower-start-turn') {
      send(socket, { type: 'response', requestId: message.requestId, resultType: 'error', error: 'synthetic post-accept failure' });
      return true;
    }
  });
  await assert.rejects(client.startTurn(THREAD, input), { code: 'rpc-error', delivery: 'outcome-unknown', outcomeUnknown: true });
});

test('cancellation cleans up a sent mutation and flags delivery as uncertain', async t => {
  const controller = new AbortController();
  const { client } = await mockDesktop(t, ({ message }) => {
    if (message.method === 'thread-follower-start-turn') { controller.abort(); return true; }
  });
  await assert.rejects(client.startTurn(THREAD, input, { signal: controller.signal }), { name: 'AbortError', outcomeUnknown: true });
  assert.equal(client.pending.size, 0);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(client.startTurn(THREAD, input, { signal: alreadyAborted.signal }), { name: 'AbortError' });
});

test('compact and interrupt preflight cancellation is not sent and never opens a connection', async t => {
  const { client, messages } = await mockDesktop(t);
  const controller = new AbortController();
  controller.abort();
  for (const method of ['compact', 'interrupt']) {
    await assert.rejects(client[method](THREAD, { signal: controller.signal }), { name: 'AbortError', delivery: 'not-sent', outcomeUnknown: false });
  }
  assert.equal(client.initialized, false);
  assert.equal(messages.length, 0);
});

test('compact and interrupt owner discovery failures prove the mutation was not sent', async t => {
  const { client, messages } = await mockDesktop(t, ({ socket, message, send }) => {
    if (message.method === 'thread-owner-discovery') {
      send(socket, { type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' });
      return true;
    }
  });
  for (const method of ['compact', 'interrupt']) {
    await assert.rejects(client[method](THREAD), { code: 'rpc-error', delivery: 'not-sent', outcomeUnknown: false });
  }
  assert.equal(messages.some(message => message.method?.startsWith('thread-follower-')), false);
});

test('snapshot timeout and cancellation release waiters without claiming completion', async t => {
  const { client } = await mockDesktop(t, ({ message }) => message.method === 'thread-stream-following-changed');
  await assert.rejects(client.snapshot(THREAD, { timeoutMs: 20 }), { code: 'snapshot-timeout' });
  assert.equal(client.stateWaiters.size, 0);
  const controller = new AbortController();
  const snapshot = client.snapshot(THREAD, { signal: controller.signal });
  const cancelled = assert.rejects(snapshot, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  assert.equal(client.stateWaiters.size, 0);
});

test('stream revision gaps invalidate cached state and refresh a snapshot', async t => {
  const mock = await mockDesktop(t);
  await mock.client.snapshot(THREAD);
  const socket = [...mock.sockets][0];
  mock.state(socket, { type: 'patches', baseRevision: 7, revision: 8, patches: [] });
  await mock.client.discover(THREAD);
  assert.equal(mock.client.states.has(THREAD), false);
  assert.equal(mock.client.threadErrors.get(THREAD).code, 'stream-revision-mismatch');
  assert.equal((await mock.client.snapshot(THREAD)).id, THREAD);
  assert.equal(mock.client.threadErrors.has(THREAD), false);
});

test('owner changes stop dispatch and the next explicit discovery can establish the new owner', async t => {
  let owner = OWNER;
  const mock = await mockDesktop(t, ({ socket, message, reply }) => {
    if (message.method === 'thread-owner-discovery') { reply(socket, message, {}, owner); return true; }
  });
  await mock.client.discover(THREAD);
  owner = 'different-owner';
  await assert.rejects(mock.client.startTurn(THREAD, input), { code: 'owner-changed', outcomeUnknown: false });
  assert.equal(mock.messages.some(message => message.method === 'thread-follower-start-turn'), false);
  assert.equal(await mock.client.discover(THREAD), owner);
});

test('foreign targeted state is ignored and incompatible stream versions fail visibly', async t => {
  const mock = await mockDesktop(t, ({ socket, message, state }) => {
    if (message.method !== 'thread-stream-following-changed' || !message.params.following) return;
    state(socket, { type: 'snapshot', revision: 1, conversationState: fixture() }, { targetClientIds: ['somebody-else'] });
    state(socket, { type: 'snapshot', revision: 1, conversationState: fixture() }, { version: 12 });
    return true;
  });
  await assert.rejects(mock.client.snapshot(THREAD), { code: 'stream-version-mismatch' });
});

test('oversized frames and malformed JSON close the connection and reject pending requests', async t => {
  for (const payload of [Buffer.from([1, 0, 0, 3]), Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('{')])]) {
    await t.test(payload.length === 4 ? 'frame size' : 'JSON', async sub => {
      const { client } = await mockDesktop(sub, ({ socket, message }) => {
        if (message.method === 'thread-owner-discovery') { socket.write(payload); return true; }
      });
      await assert.rejects(client.discover(THREAD), { code: 'invalid-frame' });
      assert.equal(client.pending.size, 0);
      assert.equal(client.socket, null);
    });
  }
});

test('disconnect rejects outstanding mutations as uncertain and clears subscribed snapshots', async t => {
  const mock = await mockDesktop(t, ({ socket, message }) => {
    if (message.method === 'thread-follower-start-turn') { socket.destroy(); return true; }
  });
  await mock.client.snapshot(THREAD);
  await assert.rejects(mock.client.startTurn(THREAD, input), { code: 'connection-closed', outcomeUnknown: true });
  assert.equal(mock.client.pending.size, 0);
  assert.equal(mock.client.states.size, 0);
  assert.equal(mock.client.followed.size, 0);
});

test('close unsubscribes and cannot reconnect', async t => {
  const mock = await mockDesktop(t);
  await mock.client.snapshot(THREAD);
  await mock.client.close();
  await assert.rejects(mock.client.connect(), { code: 'closed' });
  assert.equal(mock.client.pending.size, 0);
  assert.equal(mock.client.socket, null);
});

test('only private same-user Unix socket endpoints are accepted', async t => {
  const mock = await mockDesktop(t);
  await chmod(mock.socketPath, 0o666);
  await assert.rejects(mock.client.connect(), { code: 'unsafe-socket' });
  const regular = path.join(path.dirname(mock.socketPath), 'ordinary-file');
  await writeFile(regular, 'synthetic', { mode: 0o600 });
  const invalid = new WorkIpcClient({ socketPath: regular });
  await assert.rejects(invalid.connect(), { code: 'unsafe-socket' });
  await invalid.close();
});

test('Immer patch application handles array insertion, deletion and rejects prototype paths', () => {
  const original = { list: [{ id: 1 }, { id: 2 }], optional: true };
  const changed = applyWorkPatches(original, [
    { op: 'add', path: ['list', 1], value: { id: 3 } },
    { op: 'remove', path: ['list', 0] },
    { op: 'replace', path: ['list', 1, 'id'], value: 4 },
    { op: 'remove', path: ['optional'] },
  ]);
  assert.deepEqual(changed, { list: [{ id: 3 }, { id: 4 }] });
  assert.deepEqual(original, { list: [{ id: 1 }, { id: 2 }], optional: true });
  for (const patch of [
    { op: 'replace', path: '/list/0/id', value: 2 },
    { op: 'add', path: ['__proto__', 'polluted'], value: true },
    { op: 'add', path: ['constructor', 'polluted'], value: true },
    { op: 'replace', path: ['missing', 'id'], value: true },
    { op: 'remove', path: ['list', 8] },
  ]) assert.throws(() => applyWorkPatches(original, [patch]), { code: 'invalid-patches' });
  assert.equal({}.polluted, undefined);
});
