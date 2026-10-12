import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWork, buildWorkInput } from '../src/work.mjs';
import { WorkStore, taskIdFor } from '../src/work-store.mjs';

const threadId = 'aaaaaaaa-1111-2222-3333-444444444444';
const otherThreadId = 'bbbbbbbb-1111-2222-3333-444444444444';
const firstTurnId = 'cccccccc-1111-2222-3333-444444444444';
const secondTurnId = 'dddddddd-1111-2222-3333-444444444444';

const makeTurn = (id, extra = {}) => ({ turnId: id, status: 'inProgress', params: {}, items: [], error: null, ...extra });
function state(thread = threadId) {
  return { id: thread, hostId: 'local', originator: 'codex_work_desktop', cwd: '/project', requests: [], turns: [], threadRuntimeStatus: { type: 'idle' } };
}
class FakeIpc {
  constructor() { this.states = new Map([[threadId, state()], [otherThreadId, state(otherThreadId)]]); this.sends = []; this.compacts = []; this.interrupts = []; }
  async connect() { return this; }
  async close() {}
  async snapshot(thread) { return structuredClone(this.states.get(thread)); }
  async startTurn(thread, input, options) {
    this.sends.push({ thread, input, options });
    if (this.onStart) return this.onStart(thread, input, options);
    const current = this.states.get(thread);
    const id = this.sends.length === 1 ? firstTurnId : secondTurnId;
    current.turns.push(makeTurn(id, { params: { clientUserMessageId: options.clientUserMessageId } }));
    current.threadRuntimeStatus = { type: 'active', activeFlags: [] };
    return { turn: { id, status: 'inProgress' } };
  }
  async compact(thread, options) { this.compacts.push({ thread, options }); return this.onCompact?.(thread, options) ?? { ok: true }; }
  async interrupt(thread, options) {
    this.interrupts.push({ thread, options });
    if (this.onInterrupt) return this.onInterrupt(thread, options);
    const active = this.states.get(thread).turns.findLast(turn => turn.status === 'inProgress');
    if (active?.turnId !== options.expectedTurnId) throw new Error('expected active turn id mismatch');
    active.status = 'interrupted';
    this.states.get(thread).threadRuntimeStatus = { type: 'idle' };
    return { ok: true, interruptedTurnId: active.turnId };
  }
}
async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crc-work-test-'));
  const settings = {
    enabled: true, stateDirectory: path.join(directory, 'tasks'), codexHome: path.join(directory, 'codex'),
    socketPath: path.join(directory, 'ipc.sock'), requestTimeoutMs: 1000,
    allowedThreadIds: [threadId, otherThreadId], allowCodexThreads: false, ...overrides,
  };
  const client = new FakeIpc();
  const store = new WorkStore(settings.stateDirectory);
  const bridge = createWork({ work: settings }, { client, store });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, client, store, bridge };
}
function success(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  assert.ok(response.structuredContent);
  return response.structuredContent;
}
function failure(response, pattern) {
  assert.equal(response.isError, true);
  if (pattern) assert.match(response.content.map(item => item.text ?? '').join('\n'), pattern);
  return response.structuredContent;
}
const send = (bridge, request_id, prompt = 'Do the task.', thread_id = threadId) => bridge.call('work_send', { request_id, prompt, thread_id });

test('disabled bridge exposes no tools and rejects calls without connecting', async t => {
  const { bridge, client } = await setup(t, { enabled: false });
  assert.deepEqual(bridge.tools, []);
  failure(await bridge.call('work_info', {}), /disabled/);
  assert.equal(client.sends.length, 0);
});

test('intent is persisted before IPC, identical retry is a receipt, and changed input is rejected', async t => {
  const { bridge, client, store } = await setup(t);
  client.onStart = async (_thread, _input, options) => {
    const task = await store.get(taskIdFor('persist-001'));
    assert.equal(task.status, 'outcome_unknown');
    assert.equal(task.client_user_message_id, options.clientUserMessageId);
    assert.equal(task.operation, 'send');
    const current = client.states.get(threadId);
    current.turns.push(makeTurn(firstTurnId, { params: { clientUserMessageId: options.clientUserMessageId } }));
    current.threadRuntimeStatus = { type: 'active', activeFlags: [] };
    return { turn: { id: firstTurnId } };
  };
  const first = success(await send(bridge, 'persist-001'));
  assert.equal(first.status, 'running');
  assert.equal(first.turn_id, firstTurnId);
  const retry = success(await send(bridge, 'persist-001'));
  assert.equal(retry.task_id, first.task_id);
  assert.equal(client.sends.length, 1);
  failure(await send(bridge, 'persist-001', 'Different task.'), /different input/);
  assert.equal(client.sends.length, 1);
});

test('unknown delivery survives restart, blocks new work, and recovers from a correlated user receipt', async t => {
  const { bridge, client, store, settings } = await setup(t);
  client.onStart = async () => { throw Object.assign(new Error('Response was lost.'), { delivery: 'outcome-unknown' }); };
  const unknown = failure(await send(bridge, 'unknown-001'));
  assert.equal(unknown.status, 'outcome_unknown');
  const restarted = createWork({ work: settings }, { client, store: new WorkStore(settings.stateDirectory) });
  t.after(() => restarted.close());
  const retry = failure(await send(restarted, 'unknown-001'));
  assert.equal(retry.task_id, unknown.task_id);
  failure(await send(restarted, 'unknown-002'), /unfinished|uncertain/);
  assert.equal(client.sends.length, 1);
  const record = await store.get(unknown.task_id);
  client.states.get(threadId).turns.push(makeTurn(firstTurnId, {
    status: 'completed',
    items: [
      { type: 'userMessage', clientId: record.client_user_message_id },
      { type: 'agentMessage', text: 'Recovered.', phase: 'final_answer' },
    ],
  }));
  const done = success(await restarted.call('work_result', { task_id: unknown.task_id }));
  assert.equal(done.status, 'completed');
  assert.equal(done.final_text, 'Recovered.');
  assert.equal(done.turn_id, firstTurnId);
  assert.equal(client.sends.length, 1);
});

test('busy runtime and pending input reject new tasks before a mutation is sent', async t => {
  const { bridge, client } = await setup(t);
  client.states.get(threadId).threadRuntimeStatus = { type: 'active', activeFlags: [] };
  failure(await send(bridge, 'busy-run-001'), /busy/);
  client.states.get(threadId).threadRuntimeStatus = { type: 'idle' };
  client.states.get(threadId).requests = [{ method: 'item/tool/requestUserInput', params: { turnId: firstTurnId } }];
  failure(await send(bridge, 'busy-input-001'), /busy/);
  assert.equal(client.sends.length, 0);
});

test('resolved elicitation requests do not permanently make an idle chat busy', async t => {
  const { bridge, client } = await setup(t);
  client.states.get(threadId).requests = [{ id: 'old-question', method: 'mcpServer/elicitation/request', completed: true, params: { turnId: 'old' } }];
  const sent = success(await send(bridge, 'resolved-001'));
  assert.equal(sent.status, 'running');
  assert.equal(client.sends.length, 1);
  const status = success(await bridge.call('work_status', { task_id: sent.task_id }));
  assert.deepEqual(status.pending_requests, []);
});

test('compaction acknowledgement and old, pending or automatic items do not prove manual completion', async t => {
  const { bridge, client } = await setup(t);
  const current = client.states.get(threadId);
  current.turns.push(makeTurn('old-compact', { status: 'completed', items: [{ type: 'contextCompaction', id: 'old-item', completed: true, source: 'manual' }] }));
  const compact = success(await bridge.call('work_compact', { thread_id: threadId, request_id: 'compact-001' }));
  assert.equal(compact.status, 'running');
  assert.equal(client.compacts.length, 1);
  success(await bridge.call('work_compact', { thread_id: threadId, request_id: 'compact-001' }));
  assert.equal(client.compacts.length, 1);
  current.turns.push(makeTurn('new-compact', { status: 'inProgress', items: [
    { type: 'contextCompaction', id: 'pending-manual-context-compaction', completed: false, source: 'manual' },
    { type: 'contextCompaction', id: 'automatic-item', completed: true, source: 'automatic' },
  ] }));
  const waiting = success(await bridge.call('work_wait', { task_id: compact.task_id, timeout_ms: 0 }));
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.timed_out, true);
  current.turns.at(-1).status = 'completed';
  current.turns.at(-1).items.push({ type: 'contextCompaction', id: 'manual-item', completed: true, source: 'manual' });
  const done = success(await bridge.call('work_result', { task_id: compact.task_id }));
  assert.equal(done.status, 'completed');
  assert.equal(done.compaction.id, 'manual-item');
  assert.equal(done.turn_id, 'new-compact');
  assert.equal(client.compacts.length, 1);
});

test('a new failed manual compaction reports failure and does not permanently lock the chat', async t => {
  const { bridge, client } = await setup(t);
  const compact = success(await bridge.call('work_compact', { thread_id: threadId, request_id: 'compact-fail-001' }));
  client.states.get(threadId).turns.push(makeTurn(firstTurnId, {
    status: 'failed', turnStartedAtMs: Date.now(), error: { message: 'Compaction failed.' },
    items: [{ type: 'contextCompaction', id: 'failed-item', completed: false, source: 'manual', startedAtMs: Date.now() }],
  }));
  const status = success(await bridge.call('work_status', { task_id: compact.task_id }));
  assert.equal(status.status, 'failed');
  assert.match(status.error.message, /Compaction failed/);
  const next = success(await send(bridge, 'after-compact-fail-001'));
  assert.equal(next.status, 'running');
});

test('wait yields on approval and result includes concise final output after completion', async t => {
  const { bridge, client } = await setup(t);
  const sent = success(await send(bridge, 'final-001'));
  const current = client.states.get(threadId);
  const active = current.turns.at(-1);
  current.threadRuntimeStatus = { type: 'active', activeFlags: ['waitingOnApproval'] };
  current.requests = [{ id: 'approval', method: 'item/commandExecution/requestApproval', params: { turnId: firstTurnId, command: 'private command' } }];
  const waiting = success(await bridge.call('work_wait', { task_id: sent.task_id, timeout_ms: 45000 }));
  assert.equal(waiting.status, 'awaiting_approval');
  assert.equal(waiting.awaiting_approval, true);
  assert.equal(waiting.timed_out, false);
  assert.deepEqual(waiting.pending_requests, [{ id: 'approval', method: 'item/commandExecution/requestApproval' }]);
  active.status = 'completed';
  active.items = [
    { type: 'reasoning', text: 'private reasoning' },
    { type: 'agentMessage', text: 'Commentary.', phase: 'commentary' },
    { type: 'mcpToolCall', tool: 'example.fetch', status: 'completed', arguments: { private: true }, result: 'private output' },
    { type: 'fileChange', status: 'completed', changes: [{ path: '/project/edited.txt', diff: 'private patch' }] },
    { type: 'agentMessage', text: 'x'.repeat(125), phase: 'final_answer' },
  ];
  current.threadRuntimeStatus = { type: 'idle' }; current.requests = [];
  const done = success(await bridge.call('work_result', { task_id: sent.task_id, max_chars: 100 }));
  assert.equal(done.status, 'completed'); assert.equal(done.final_text, 'x'.repeat(100)); assert.equal(done.truncated, true);
  assert.deepEqual(done.tool_calls, [{ type: 'mcpToolCall', name: 'example.fetch', status: 'completed' }, { type: 'fileChange', name: 'fileChange', status: 'completed' }]);
  assert.deepEqual(done.changed_files, ['/project/edited.txt']);
  assert.doesNotMatch(JSON.stringify(done), /private|Commentary/);
  const finishedWait = success(await bridge.call('work_wait', { task_id: sent.task_id, timeout_ms: 0 }));
  assert.equal(finishedWait.timed_out, false);
});

test('interrupt identifies exactly the task turn and completion cannot stop a subsequent turn', async t => {
  const { bridge, client } = await setup(t);
  const sent = success(await send(bridge, 'interrupt-001'));
  const stopped = success(await bridge.call('work_interrupt', { task_id: sent.task_id }));
  assert.equal(stopped.interrupt_requested, true);
  assert.equal(client.interrupts[0].options.expectedTurnId, firstTurnId);
  const finished = success(await bridge.call('work_status', { task_id: sent.task_id }));
  assert.equal(finished.status, 'interrupted');
  client.states.get(threadId).turns.push(makeTurn(secondTurnId));
  client.states.get(threadId).threadRuntimeStatus = { type: 'active', activeFlags: [] };
  const again = success(await bridge.call('work_interrupt', { task_id: sent.task_id }));
  assert.equal(again.status, 'interrupted');
  assert.equal(client.interrupts.length, 1);
});

test('result reports applied file changes without labelling declined or unfinished edits as changed', async t => {
  const { bridge, client } = await setup(t);
  const sent = success(await send(bridge, 'applied-files-001'));
  const current = client.states.get(threadId);
  current.turns.at(-1).status = 'completed';
  current.turns.at(-1).items = [
    { type: 'fileChange', status: 'completed', changes: [{ path: '/project/applied.txt' }] },
    { type: 'fileChange', status: 'declined', changes: [{ path: '/project/declined.txt' }] },
    { type: 'fileChange', status: 'failed', changes: [{ path: '/project/failed.txt' }] },
    { type: 'fileChange', status: 'inProgress', changes: [{ path: '/project/proposed.txt' }] },
  ];
  current.threadRuntimeStatus = { type: 'idle' };
  const result = success(await bridge.call('work_result', { task_id: sent.task_id }));
  assert.deepEqual(result.changed_files, ['/project/applied.txt']);
});

test('only allowed local Work origins receive mutations', async t => {
  const { bridge, client } = await setup(t, { allowedThreadIds: [threadId] });
  failure(await send(bridge, 'origin-001', 'Task.', otherThreadId), /allowedThreadIds/);
  client.states.get(threadId).originator = 'codex_cli_rs';
  failure(await send(bridge, 'origin-002'), /not a local Work chat/);
  client.states.get(threadId).originator = 'codex_work_desktop'; client.states.get(threadId).hostId = 'durable';
  failure(await send(bridge, 'origin-003'), /Only local/);
  assert.equal(client.sends.length, 0);
});

test('skill and plugin selections are sent as structured input, with malformed selections rejected', async t => {
  const { directory } = await setup(t);
  const skill = path.join(directory, 'my-skill', 'SKILL.md');
  await mkdir(path.dirname(skill)); await writeFile(skill, '---\nname: my-skill\n---\nInstructions.');
  const input = await buildWorkInput('Use these.', [{ name: 'my-skill', path: skill }], [{ name: 'example', path: 'plugin://example@marketplace' }]);
  assert.deepEqual(input, [
    { type: 'text', text: 'Use these.', text_elements: [] },
    { type: 'skill', name: 'my-skill', path: skill },
    { type: 'mention', name: 'example', path: 'plugin://example@marketplace' },
  ]);
  await assert.rejects(() => buildWorkInput('Task.', [{ name: 'bad', path: 'relative/SKILL.md' }]), /absolute/);
  await assert.rejects(() => buildWorkInput('Task.', [], [{ name: 'bad', path: 'https://example.com' }]), /exact plugin/);
});

test('two bridge instances cannot dispatch twice using the same request key', async t => {
  const { bridge, client, settings } = await setup(t);
  const second = createWork({ work: settings }, { client, store: new WorkStore(settings.stateDirectory) });
  t.after(() => second.close());
  // Keep the desktop snapshot idle so the store lease, rather than a lucky busy check, provides exclusion.
  client.onStart = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { turn: { id: firstTurnId } }; };
  const replies = await Promise.all([send(bridge, 'concurrent-001'), send(second, 'concurrent-001')]);
  assert.equal(client.sends.length, 1);
  const receipts = replies.map(success);
  assert.equal(receipts[0].task_id, receipts[1].task_id);
});

test('global request keys cannot concurrently dispatch different inputs to different chats', async t => {
  const { bridge, client, settings } = await setup(t);
  const second = createWork({ work: settings }, { client, store: new WorkStore(settings.stateDirectory) });
  t.after(() => second.close());
  client.onStart = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { turn: { id: firstTurnId } }; };
  const replies = await Promise.all([
    send(bridge, 'global-key-001', 'Task.', threadId),
    send(second, 'global-key-001', 'Task.', otherThreadId),
  ]);
  assert.equal(client.sends.length, 1);
  assert.equal(replies.filter(reply => !reply.isError).length, 1);
  failure(replies.find(reply => reply.isError), /different input/);
});
