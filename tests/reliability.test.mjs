import test from 'node:test';
import assert from 'node:assert/strict';
import { createReliability, classifyReadFailure, isSafeReadTool, abortableDelay } from '../src/reliability.mjs';

function fixture(settings = {}) {
  const logs = [], delays = [];
  let clock = 1000;
  const reliability = createReliability(settings, {
    logger: entry => logs.push(entry), now: () => clock, uuid: () => 'generated-test-trace',
    sleep: async ms => { delays.push(ms); clock += ms; },
  });
  return { reliability, logs, delays };
}
const request = (name, args = {}) => ({ name, owner: name.startsWith('work_') ? 'work' : 'commander', args });

test('an explicitly safe local read recovers from transient errors with bounded backoff', async () => {
  const { reliability, logs, delays } = fixture();
  let calls = 0;
  const result = await reliability.call(request('read_file', { path: '/private/file' }), async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('private path and tool arguments'), { code: 'UNAVAILABLE' });
    return { content: [{ type: 'text', text: 'private contents' }] };
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.equal(result.content[0].text, 'private contents');
  assert.deepEqual(logs.map(log => log.event), ['start', 'attempt', 'retry', 'attempt', 'retry', 'attempt', 'finish']);
  assert.equal(logs.at(-1).ok, true);
  assert.equal(logs.at(-1).inflight, 0);
  assert.equal(logs.at(-1).elapsed_ms, 750);
  assert.doesNotMatch(JSON.stringify(logs), /private|contents|arguments/);
});

test('safe reads retry explicit structured MCP errors but keep opaque errors and local refusals', async () => {
  const { reliability } = fixture();
  let attempts = 0;
  const result = await reliability.call(request('get_file_info'), async () => {
    attempts += 1;
    return attempts === 1 ? { isError: true, structuredContent: { error_code: 503 }, content: [{ type: 'text', text: 'private diagnostics' }] } : { content: [] };
  });
  assert.equal(attempts, 2);
  assert.equal(result.isError, undefined);
  for (const failure of [
    { isError: true, content: [{ type: 'text', text: 'UNAVAILABLE appears in a local filename' }] },
    { isError: true, structuredContent: { error_code: 'ENOENT' } },
    { isError: true, structuredContent: { error_code: 'EACCES' } },
    { isError: true, structuredContent: { error_code: -32602 } },
  ]) {
    let calls = 0;
    const unchanged = await reliability.call(request('read_file'), async () => { calls += 1; return failure; });
    assert.equal(calls, 1);
    assert.equal(unchanged, failure);
  }
  assert.equal(classifyReadFailure({ code: 'EACCES', cause: { code: 'UNAVAILABLE' } }).retryable, false);
  assert.equal(classifyReadFailure({ code: -32000, message: 'MCP error -32000: Connection closed' }).retryable, true);
  assert.equal(classifyReadFailure({ code: -32000, message: 'MCP error -32000: private tool failed' }).retryable, false);
});

test('writes, dispatch, compaction, browser, wait and URL reads are never replayed', async () => {
  const { reliability, logs } = fixture();
  for (const [name, args] of [
    ['write_file', { request_id: 'stable-write-key', append: true }],
    ['work_send', { request_id: 'stable-task-key' }], ['work_compact', {}],
    ['work_interrupt', {}], ['browser_snapshot', {}], ['work_wait', {}],
    ['read_file', { isUrl: true }], ['get_recent_tool_calls', {}],
  ]) {
    let calls = 0;
    const error = Object.assign(new Error('private mutation arguments'), { code: 'UNAVAILABLE' });
    await assert.rejects(reliability.call(request(name, args), async () => { calls += 1; throw error; }), candidate => candidate === error);
    assert.equal(calls, 1, name + ' must never be replayed');
  }
  assert.equal(logs.filter(log => log.event === 'retry').length, 0);
  assert.doesNotMatch(JSON.stringify(logs), /stable-write-key|stable-task-key|private mutation/);
  assert.equal(isSafeReadTool('read_file', { isUrl: 'true' }), false);
});

test('cancellation during backoff prevents another attempt and cleans up its delay', async () => {
  const controller = new AbortController();
  const logs = [];
  const reliability = createReliability({}, { logger: entry => logs.push(entry), sleep: async (ms, signal) => {
    controller.abort(new DOMException('private cancel reason', 'AbortError'));
    return abortableDelay(ms, signal);
  } });
  let calls = 0;
  await assert.rejects(reliability.call({ ...request('get_config'), signal: controller.signal }, async () => {
    calls += 1; throw Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' });
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(logs.at(-1).error_class, 'cancelled');
  assert.doesNotMatch(JSON.stringify(logs), /private cancel/);
  await assert.rejects(abortableDelay(1, controller.signal), { name: 'AbortError' });
});

test('the retry limit returns the original failure and metadata logging cannot alter a receipt', async () => {
  const { reliability, delays } = fixture({ readRetryAttempts: 2, readRetryBaseMs: 100, readRetryMaxMs: 100 });
  const failure = Object.assign(new Error('private failure'), { statusCode: 429 });
  let calls = 0;
  await assert.rejects(reliability.call(request('list_directory'), async () => { calls += 1; throw failure; }), error => error === failure);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]);
  const receipt = { content: [{ type: 'text', text: 'Written.' }] };
  const brokenLogger = createReliability({}, { logger: () => { throw new Error('Log unavailable.'); } });
  assert.equal(await brokenLogger.call(request('write_file'), async () => receipt), receipt);
});

test('a pending Work wait does not queue or block an independent read', async () => {
  const { reliability, logs } = fixture();
  let finishWait;
  const waiting = reliability.call(request('work_wait'), () => new Promise(resolve => { finishWait = resolve; }));
  const read = await reliability.call(request('read_file'), async () => ({ content: [] }));
  assert.deepEqual(read, { content: [] });
  const readFinish = logs.find(log => log.event === 'finish' && log.name === 'read_file');
  assert.equal(readFinish.inflight, 1);
  finishWait({ structuredContent: { status: 'running', timed_out: true } });
  await waiting;
  assert.equal(logs.at(-1).inflight, 0);
});

test('read retries respect server cooldowns and stop rather than retrying before a long Retry-After', async () => {
  const { reliability, delays } = fixture();
  let calls = 0;
  const result = await reliability.call(request('read_file'), async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('Rate limit'), { statusCode: 429, response: { headers: { 'retry-after': '1' } } });
    return { content: [] };
  });
  assert.equal(calls, 2); assert.deepEqual(result, { content: [] }); assert.deepEqual(delays, [1000]);
  calls = 0;
  const failure = { isError: true, content: [], structuredContent: { error_code: 429, retry_after_ms: 30000 } };
  assert.equal(await reliability.call(request('read_file'), async () => { calls++; return failure; }), failure);
  assert.equal(calls, 1);
});
