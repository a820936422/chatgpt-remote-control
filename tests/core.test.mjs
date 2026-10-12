import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, childEnvironment } from '../src/config.mjs';
import { validateCapture, createDesktop } from '../src/desktop.mjs';
import { allTools, indexTools, serializeCalls } from '../src/upstream.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('relative paths are resolved against configuration, not service cwd', () => {
  const config = normalizeConfig({ label: 'test', workspace: '../files', browser: { configFile: 'browser.json' } }, '/tmp/config/config.json');
  assert.equal(config.workspace, '/tmp/files');
  assert.equal(config.browser.configFile, '/tmp/config/browser.json');
  assert.throws(() => normalizeConfig({ browser: { enabled: 'false' } }, '/tmp/config.json'));
  assert.throws(() => normalizeConfig({ label: 'line\nbreak' }, '/tmp/config.json'));
});

test('Tunnel key is removed from MCP children without mutating parent env', () => {
  const original = { CONTROL_PLANE_API_KEY: 'synthetic-not-a-key', DISPLAY: ':9', PATH: '/usr/bin' };
  const clean = childEnvironment(original);
  assert.equal(clean.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(original.CONTROL_PLANE_API_KEY, 'synthetic-not-a-key');
  assert.equal(clean.DISPLAY, ':9');
});

test('reliability settings bound retries and keep their journal relative to configuration', () => {
  const settings = normalizeConfig({ reliability: { stateDirectory: 'receipts' } }, '/tmp/config/settings.json').reliability;
  assert.equal(settings.stateDirectory, '/tmp/config/receipts');
  assert.equal(settings.readRetryAttempts, 3);
  assert.throws(() => normalizeConfig({ reliability: { readRetryAttempts: 4 } }, '/tmp/config.json'));
  assert.throws(() => normalizeConfig({ reliability: { readRetryBaseMs: 500, readRetryMaxMs: 100 } }, '/tmp/config.json'));
});

test('desktop subprocesses do not inherit the Tunnel key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-control-env-test-'));
  const original = { key: process.env.CONTROL_PLANE_API_KEY, display: process.env.DISPLAY };
  try {
    const probe = path.join(root, 'monitor-probe');
    await writeFile(probe, '#!/bin/sh\n[ "${CONTROL_PLANE_API_KEY+x}" != x ] || exit 44\nprintf \'%s\\n\' \'{"outputs":[]}\'\n', { mode: 0o700 });
    process.env.CONTROL_PLANE_API_KEY = 'synthetic-not-a-key';
    process.env.DISPLAY = ':9';
    const desktop = createDesktop(normalizeConfig({ desktop: { kscreenDoctorPath: probe } }, path.join(root, 'config.json')));
    const result = await desktop.call('desktop_info', {});
    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(result.content[0].text).monitors, []);
  } finally {
    for (const [name, value] of [['CONTROL_PLANE_API_KEY', original.key], ['DISPLAY', original.display]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('capture rejects invalid arguments before calling desktop programs', async () => {
  for (const args of [null, [], { max_width: 0 }, { max_width: 1.2 }, { max_width: 3841 }, { scope: 'remote' }, { include_cursor: 'yes' }, { filename: '/tmp/ignored' }]) assert.throws(() => validateCapture(args));
  assert.deepEqual(validateCapture({}), { scope: 'desktop', maxWidth: 1920, includeCursor: true });
  const desktop = createDesktop(normalizeConfig({ desktop: { enabled: false } }, '/tmp/config.json'));
  assert.equal(desktop.tools.length, 0);
  assert.equal((await desktop.call('desktop_screenshot', {})).isError, true);
});

test('all upstream pages are collected and repeated cursors rejected', async () => {
  const pages = [{ tools: [{ name: 'a' }], nextCursor: 'next' }, { tools: [{ name: 'b' }] }];
  const received = [];
  const tools = await allTools({ listTools: async args => { received.push(args); return pages.shift(); } });
  assert.deepEqual(tools.map(tool => tool.name), ['a', 'b']);
  assert.deepEqual(received, [{}, { cursor: 'next' }]);
  await assert.rejects(allTools({ listTools: async () => ({ tools: [], nextCursor: 'loop' }) }), /repeated/);
});

test('tool collisions cannot silently override file or desktop operations', () => {
  assert.throws(() => indexTools([{ owner: 'a', tools: [{ name: 'same' }] }, { owner: 'b', tools: [{ name: 'same' }] }]), /Duplicate/);
  const { routes } = indexTools([{ owner: 'browser', tools: [{ name: 'browser_click' }] }]);
  assert.equal(routes.get('browser_click'), 'browser');
});

test('browser calls serialize, skip cancelled queued actions, and recover after failure', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const invoke = serializeCalls(async ({ id }) => {
    calls.push(id);
    if (id === 1) { await gate; throw new Error('expected synthetic failure'); }
    return id;
  });
  const first = invoke({ id: 1 });
  const failed = assert.rejects(first, /synthetic/);
  const controller = new AbortController();
  const cancelled = invoke({ id: 2 }, { signal: controller.signal });
  const skipped = assert.rejects(cancelled, { name: 'AbortError' });
  const third = invoke({ id: 3 });
  await Promise.resolve();
  assert.deepEqual(calls, [1]);
  controller.abort();
  release();
  await failed;
  await skipped;
  assert.equal(await third, 3);
  assert.deepEqual(calls, [1, 3]);
});
