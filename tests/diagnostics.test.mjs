import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnosticLogger } from '../src/diagnostics.mjs';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-diagnostics-'));
  const state = path.join(directory, 'state');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, state, log: path.join(state, 'diagnostics', `bridge-${process.pid}.jsonl`) };
}
function capture(callback) {
  let stderr = '';
  const original = process.stderr.write;
  process.stderr.write = chunk => { stderr += chunk.toString(); return true; };
  try { callback(); } finally { process.stderr.write = original; }
  return stderr;
}
const entry = extra => ({
  component: 'bridge', method: 'tools/call', event: 'finish',
  trace_id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'read_file', owner: 'commander',
  pid: process.pid, ts: '2026-10-12T10:00:00.000Z', elapsed_ms: 5, inflight: 0, attempt: 1,
  error_class: null, ok: true, ...extra,
});

test('diagnostics synchronously persist sanitized JSON with private directory and file modes', t => {
  const { state, log } = setup(t);
  const logger = createDiagnosticLogger({ stateDirectory: state });
  const expected = entry({ retry_delay_ms: 250 });
  const stderr = capture(() => { logger(expected); logger(entry({ event: 'start', ok: false })); });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0], expected);
  assert.equal(lines.length, 2);
  assert.equal(stderr, fs.readFileSync(log, 'utf8'));
  for (const directory of [state, path.dirname(log)]) {
    const stat = fs.lstatSync(directory);
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(stat.uid, process.getuid());
  }
  const stat = fs.lstatSync(log);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.uid, process.getuid());
});

test('unknown fields and nonscalar allowed fields cannot leak paths, contents or raw error messages', t => {
  const { state, log } = setup(t);
  const logger = createDiagnosticLogger({ stateDirectory: state });
  const stderr = capture(() => logger(entry({
    arguments: { path: '/private/synthetic-secret', content: 'synthetic-secret' },
    result: { content: 'synthetic-secret' }, error: { message: '/private/synthetic-secret' },
    caller_trace_id: 'synthetic-secret', extra: 'synthetic-secret',
    name: '/private/synthetic-secret', owner: { value: 'synthetic-secret' },
    trace_id: 'synthetic-secret', error_class: { message: 'synthetic-secret' },
  })));
  const content = fs.readFileSync(log, 'utf8');
  assert.doesNotMatch(content + stderr, /synthetic-secret|private|arguments|caller_trace_id/);
  const saved = JSON.parse(content);
  assert.equal(Object.hasOwn(saved, 'name'), false);
  assert.equal(Object.hasOwn(saved, 'owner'), false);
  assert.equal(Object.hasOwn(saved, 'trace_id'), false);
});

test('rotation retains one private previous log without deleting other PID logs', t => {
  const { state, log } = setup(t);
  const logger = createDiagnosticLogger({ stateDirectory: state });
  capture(() => logger(entry()));
  fs.writeFileSync(log, 'x'.repeat(5 * 1024 * 1024));
  fs.chmodSync(log, 0o644);
  const other = path.join(path.dirname(log), 'bridge-999999.jsonl');
  fs.writeFileSync(other, 'other process\n', { mode: 0o600 });
  capture(() => logger(entry({ event: 'start' })));
  assert.equal(fs.statSync(log + '.1').size, 5 * 1024 * 1024);
  assert.equal(fs.statSync(log + '.1').mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).event, 'start');
  fs.writeFileSync(log, 'y'.repeat(5 * 1024 * 1024));
  capture(() => logger(entry({ event: 'finish' })));
  assert.equal(fs.readFileSync(log + '.1', 'utf8')[0], 'y');
  assert.equal(fs.statSync(log + '.1').mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(other, 'utf8'), 'other process\n');
  assert.equal(fs.readdirSync(path.dirname(log)).filter(name => name.startsWith(`bridge-${process.pid}`)).length, 2);
});

test('symlink and nonowned paths are refused while diagnostic calls still return normally', t => {
  const { directory, state, log } = setup(t);
  const target = path.join(directory, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, state, 'dir');
  const logger = createDiagnosticLogger({ stateDirectory: state });
  const stderr = capture(() => { assert.doesNotThrow(() => logger(entry())); logger(entry()); });
  assert.equal(fs.readdirSync(target).length, 0);
  assert.equal(stderr.match(/Bridge diagnostics unavailable/g)?.length, 1);
  assert.doesNotMatch(stderr, new RegExp(directory));
  fs.unlinkSync(state);
  const valid = createDiagnosticLogger({ stateDirectory: state });
  capture(() => valid(entry()));
  fs.unlinkSync(log);
  const fileTarget = path.join(directory, 'unchanged.txt');
  fs.writeFileSync(fileTarget, 'unchanged');
  fs.symlinkSync(fileTarget, log);
  capture(() => assert.doesNotThrow(() => valid(entry())));
  assert.equal(fs.readFileSync(fileTarget, 'utf8'), 'unchanged');
  if (process.getuid() !== fs.lstatSync(os.tmpdir()).uid) {
    const rootOwned = createDiagnosticLogger({ stateDirectory: os.tmpdir() });
    const output = capture(() => assert.doesNotThrow(() => rootOwned(entry())));
    assert.match(output, /Bridge diagnostics unavailable/);
  }
});
