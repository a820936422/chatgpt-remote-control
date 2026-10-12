import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTurns, findCorrelatedTurn, summarizeTurn, completedCompactions } from '../src/work-state.mjs';

const turn = (id, extra = {}) => ({ turnId: id, status: 'completed', params: {}, items: [], ...extra });
const canonical = entries => ({
  turns: [],
  turnHistory: {
    kind: 'canonical',
    history: {
      entitiesByKey: Object.fromEntries(entries.map(([key, value]) => [key, value])),
      islands: entries.map(([key]) => ({ entries: [{ value: key }] })),
    },
  },
});

test('canonical islands preserve order, merge live turns, and ignore unreachable entities', () => {
  const first = turn('one', { items: [{ id: 'final', type: 'agentMessage', text: 'old', phase: 'final_answer' }] });
  const state = canonical([['key-one', first], ['key-two', turn('two')]]);
  state.turnHistory.history.entitiesByKey.orphan = turn('orphan');
  state.turns = [turn('one', { status: 'inProgress', items: [{ id: 'final', type: 'agentMessage', text: 'updated' }] }), turn('three')];
  const turns = conversationTurns(state);
  assert.deepEqual(turns.map(value => value.turnId), ['one', 'two', 'three']);
  assert.equal(turns[0].status, 'completed');
  assert.equal(turns[0].items[0].text, 'updated');
  assert.equal(turns[0].items[0].phase, 'final_answer');
  assert.equal(first.items[0].text, 'old', 'input state is not mutated');
  assert.deepEqual(conversationTurns(null), []);
});

test('task results include final answers and concise tool/file evidence without reasoning or bodies', () => {
  const result = summarizeTurn(turn('task', {
    turnStartedAtMs: '1000', durationMs: 25,
    completedItemIds: { search: true },
    items: [
      { type: 'reasoning', text: 'private reasoning', summary: ['private'] },
      { type: 'agentMessage', text: 'commentary', phase: 'commentary' },
      { type: 'agentMessage', text: 'legacy' },
      { type: 'agentMessage', text: 'finished', phase: 'final_answer' },
      { type: 'mcpToolCall', tool: 'plugin.read', status: 'completed', arguments: { secret: true }, result: 'private result' },
      { type: 'webSearch', id: 'search', query: 'private query' },
      { type: 'fileChange', status: 'completed', changes: [{ path: '/project/a', kind: { type: 'update', movePath: '/project/b' }, diff: 'private diff' }, { path: '/project/a' }] },
    ],
  }));
  assert.equal(result.final_text, 'finished');
  assert.deepEqual(result.tool_calls, [
    { type: 'mcpToolCall', name: 'plugin.read', status: 'completed' },
    { type: 'webSearch', name: 'webSearch', status: 'completed' },
    { type: 'fileChange', name: 'fileChange', status: 'completed' },
  ]);
  assert.deepEqual(result.changed_files, ['/project/a', '/project/b']);
  assert.equal(result.started_at_ms, 1000);
  assert.equal(result.duration_ms, 25);
  assert.equal(result.error, null);
  assert.doesNotMatch(JSON.stringify(result), /private|commentary|legacy/);
  assert.equal(summarizeTurn(turn('legacy', { items: [{ type: 'agentMessage', text: 'old format' }] })).final_text, 'old format');
  assert.equal(summarizeTurn(turn('commentary', { items: [{ type: 'agentMessage', text: 'working', phase: 'commentary' }] })).final_text, '');
});

test('waiting state uses runtime flags and pending requests for the active task only', () => {
  const active = turn('current', { status: 'inProgress' });
  assert.equal(summarizeTurn(active).status, 'running');
  assert.equal(summarizeTurn(active, { type: 'active', activeFlags: ['waitingOnApproval'] }).awaiting_approval, true);
  const requests = [
    { method: 'item/tool/requestUserInput', params: { turnId: 'current' } },
    { method: 'item/fileChange/requestApproval', params: { turnId: 'previous' } },
    { method: 'item/permissions/requestApproval', completed: true, params: { turnId: 'current' } },
  ];
  const summary = summarizeTurn(active, null, requests);
  assert.equal(summary.awaiting_user_input, true);
  assert.equal(summary.awaiting_approval, false);
  const previous = summarizeTurn(turn('previous'), { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] }, requests);
  assert.equal(previous.awaiting_approval, false);
  assert.equal(previous.awaiting_user_input, false);
  assert.equal(summarizeTurn(turn('error', { status: 'failed', error: { message: 'failed', details: 'unneeded' } })).error.message, 'failed');
  assert.equal(summarizeTurn(turn('interrupted', { status: 'interrupted' })).status, 'interrupted');
});

test('correlation uses exact IDs and accepted receipts, never prompt similarity or pending steering', () => {
  const state = canonical([
    ['one', turn('one', { params: { clientUserMessageId: 'parameter-id' } })],
    ['two', turn('two', { items: [{ type: 'userMessage', clientId: 'receipt-id' }] })],
    ['three', turn('three', { items: [
      { type: 'steeringUserMessage', clientUserMessageId: 'pending-id', status: 'pending' },
      { type: 'steeringUserMessage', clientUserMessageId: 'accepted-id', status: 'accepted', targetTurnId: 'two' },
    ] })],
  ]);
  state.turns.push(turn(null, { status: 'inProgress', params: { clientUserMessageId: 'placeholder-id' } }));
  assert.equal(findCorrelatedTurn(state, { turn_id: 'one' }).turnId, 'one');
  assert.equal(findCorrelatedTurn(state, { client_user_message_id: 'parameter-id' }).turnId, 'one');
  assert.equal(findCorrelatedTurn(state, { client_user_message_id: 'receipt-id' }).turnId, 'two');
  assert.equal(findCorrelatedTurn(state, { client_user_message_id: 'accepted-id' }).turnId, 'two');
  assert.equal(findCorrelatedTurn(state, { client_user_message_id: 'pending-id' }), null);
  assert.equal(findCorrelatedTurn(state, { client_user_message_id: 'placeholder-id' }), null);
  assert.equal(findCorrelatedTurn(state, {}), null);
});

test('compaction requires a real completed item and deduplicates canonical/live copies', () => {
  const complete = turn('compact', {
    turnStartedAtMs: 100, durationMs: 50,
    items: [
      { type: 'contextCompaction', id: 'done', completed: true, source: 'manual' },
      { type: 'contextCompaction', id: 'pending-manual-context-compaction', completed: true },
      { type: 'contextCompaction', id: 'not-done', completed: false },
    ],
  });
  const state = canonical([['compact', complete]]);
  state.turns = [complete, turn('automatic', { items: [{ type: 'contextCompaction', id: 'auto', completed: true, source: 'automatic', startedAtMs: 200, completedAtMs: 250 }] })];
  assert.deepEqual(completedCompactions(state), [
    { id: 'done', turn_id: 'compact', completed: true, source: 'manual', started_at_ms: 100, completed_at_ms: 150 },
    { id: 'auto', turn_id: 'automatic', completed: true, source: 'automatic', started_at_ms: 200, completed_at_ms: 250 },
  ]);
  assert.deepEqual(completedCompactions({ turns: [turn('accepted-only', { status: 'inProgress' })] }), []);
});
