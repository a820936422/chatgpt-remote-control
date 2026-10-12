import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWriteReceipts, decorateWriteTool } from '../src/write-receipts.mjs';

const success = { content: [{ type: 'text', text: 'Write completed: /private/target synthetic-private-content' }] };
const args = key => ({ name: 'write_file', arguments: { path: '/private/target', content: 'synthetic-private-content', mode: 'append', ...(key ? { request_id: key } : {}) } });
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crc-write-receipts-'));
  const config = { reliability: { stateDirectory: directory } };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, config, receipts: createWriteReceipts(config) };
}
const receipt = result => result._meta?.write_receipt ?? result.structuredContent?.write_receipt;

test('write_file receipt key is optional and upstream schema collisions are rejected', () => {
  const source = { name: 'write_file', description: 'Write.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  const decorated = decorateWriteTool(source);
  assert.ok(decorated.inputSchema.properties.request_id);
  assert.deepEqual(decorated.inputSchema.required, ['path']);
  assert.equal(source.inputSchema.properties.request_id, undefined);
  assert.throws(() => decorateWriteTool(decorated), /collision/);
});

test('cross-instance duplicate append uses one durable write without retaining arguments or replies', async t => {
  const { directory, config, receipts } = await setup(t);
  const another = createWriteReceipts(config);
  let writes = 0;
  const invoke = async params => { assert.equal(params.arguments.request_id, undefined); writes++; return success; };
  const results = await Promise.all([receipts.call(args('append-key-001'), invoke), another.call(args('append-key-001'), invoke)]);
  assert.equal(writes, 1);
  assert.deepEqual(results.map(x => receipt(x).duplicate).sort(), [false, true]);
  assert.ok(results.every(x => receipt(x).status === 'completed'));
  const restarted = createWriteReceipts(config);
  assert.equal(receipt(await restarted.call(args('append-key-001'), invoke)).duplicate, true);
  assert.equal(writes, 1);
  const folders = await readdir(path.join(directory, 'writes'));
  const folder = path.join(directory, 'writes', folders[0]);
  const filename = (await readdir(folder)).find(x => x.endsWith('.json'));
  const text = await readFile(path.join(folder, filename), 'utf8');
  assert.ok(!text.includes('/private/target'));
  assert.ok(!text.includes('synthetic-private-content'));
});

test('changed keyed input is rejected and equivalent argument key order keeps its receipt', async t => {
  const { receipts } = await setup(t);
  let writes = 0; const invoke = async () => { writes++; return success; };
  await receipts.call(args('stable-key-001'), invoke);
  await assert.rejects(receipts.call({ ...args('stable-key-001'), arguments: { ...args('stable-key-001').arguments, content: 'changed' } }, invoke), /different input/);
  const reordered = { name: 'write_file', arguments: { request_id: 'stable-key-001', mode: 'append', content: 'synthetic-private-content', path: '/private/target' } };
  assert.equal(receipt(await receipts.call(reordered, invoke)).duplicate, true);
  assert.equal(writes, 1);
});

test('lost mutation reply survives restart and never replays a possibly completed append', async t => {
  const { config, receipts } = await setup(t);
  let writes = 0;
  const invoke = async () => { writes++; throw Object.assign(new Error('Transport lost after append.'), { code: 'ECONNRESET' }); };
  const result = await receipts.call(args('unknown-key-001'), invoke);
  assert.equal(result.isError, true);
  assert.equal(receipt(result).status, 'outcome_unknown');
  const restarted = createWriteReceipts(config);
  const retried = await restarted.call(args('unknown-key-001'), invoke);
  assert.equal(receipt(retried).duplicate, true);
  assert.equal(writes, 1);
});

test('failed writes keep a receipt and legacy unkeyed calls remain single direct invocations', async t => {
  const { receipts } = await setup(t);
  let writes = 0;
  const fail = async () => { writes++; return { isError: true, content: [{ type: 'text', text: 'synthetic-private-content' }] }; };
  const failed = await receipts.call(args('failed-key-001'), fail);
  assert.equal(receipt(failed).status, 'failed');
  await receipts.call(args('failed-key-001'), fail); assert.equal(writes, 1);
  const legacy = await receipts.call(args(), fail);
  assert.equal(legacy.isError, true); assert.equal(receipt(legacy), undefined); assert.equal(writes, 2);
});

test('invalid keys and preflight cancellation do not call the writer', async t => {
  const { receipts } = await setup(t);
  let calls = 0; const invoke = async () => { calls++; return success; };
  for (const key of ['short', 'bad\nkeyhere', null]) {
    const input = args('placeholder-01'); input.arguments.request_id = key;
    await assert.rejects(receipts.call(input, invoke), /Invalid/);
  }
  const controller = new AbortController();controller.abort();
  await assert.rejects(receipts.call(args('aborted-key-01'), invoke, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});
