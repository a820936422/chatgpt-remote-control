#!/usr/bin/env node
// This opt-in integration check sends tasks only to the explicitly selected local Work chat.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (['--compact', '--interrupt'].includes(arg)) options[arg.slice(2)] = true;
  else if (['--thread-id', '--config', '--out', '--plugin-name', '--plugin-path', '--skill-name', '--skill-path', '--model', '--reasoning-effort'].includes(arg)) {
    const value = process.argv[++i]; if (!value || value.startsWith('--')) throw new Error('Missing value: ' + arg);
    options[arg.slice(2)] = value;
  } else throw new Error('Unknown option: ' + arg);
}
assert.match(options['thread-id'] ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, 'Select a dedicated local Work test chat with --thread-id.');
for (const kind of ['plugin', 'skill']) assert.equal(Boolean(options[kind + '-name']), Boolean(options[kind + '-path']), kind + ' name and path must be supplied together.');
const started = Date.now();
const report = { started_at: new Date().toISOString(), thread_id: options['thread-id'], checks: [] };
const client = new Client({ name: 'work-bridge-verification', version: '0.2.2' });
const env = { ...process.env }; delete env.CONTROL_PLANE_API_KEY;
if (options.config) env.CRC_CONFIG = path.resolve(options.config);
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/bridge.mjs', import.meta.url))], env, stderr: 'pipe' });
const progress = stage => {
  const memory = os.totalmem() - os.freemem();
  assert.ok(memory / os.totalmem() < 0.95, 'Memory usage exceeded 95%.');
  console.log(`${stage}; elapsed=${((Date.now() - started) / 1000).toFixed(1)}s RSS=${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MiB`);
};
const passed = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); progress('PASS ' + name); };
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 65000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  assert.ok(!response.isError, name + ': ' + JSON.stringify(value));
  return value;
}
async function complete(task, timeoutMs = 180000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await call('work_wait', { task_id: task.task_id, timeout_ms: Math.min(30000, end - Date.now()) });
    progress('Work ' + state.status);
    if (['completed', 'failed', 'interrupted'].includes(state.status)) return call('work_result', { task_id: task.task_id });
    assert.ok(!['outcome_unknown', 'awaiting_approval', 'awaiting_user_input'].includes(state.status), 'Work needs attention: ' + state.status);
  }
  throw new Error('Work test deadline exceeded; do not resend with a new request key.');
}

try {
  const connecting = client.connect(transport, { timeout: 30000 });
  transport.stderr?.on('data', () => {});
  await connecting;
  const tools = (await client.listTools()).tools;
  assert.equal(tools.filter(tool => tool.name.startsWith('work_')).length, 9);
  passed('MCP discovery', { total_tools: tools.length, work_tools: 9 });
  const info = await call('work_info'); assert.equal(info.available, true);
  passed('same-user desktop IPC', { available: info.available, transport: info.transport });
  const chats = await call('work_list_chats', { limit: 100 });
  assert.ok(chats.chats.some(chat => chat.thread_id === options['thread-id']));
  passed('local Work discovery', { found_selected_chat: true });
  const skills = await call('work_list_skills', { limit: 500 });
  assert.ok(skills.skills.length > 0);
  passed('skill discovery', { skills: skills.skills.length });
  const marker = 'WORK_MCP_OK_' + randomUUID();
  const input = { thread_id: options['thread-id'], request_id: randomUUID(), prompt: '这是用户授权的专用 Work MCP 验收。不要修改文件、执行命令或调用插件。只回复：' + marker };
  if (options.model) input.model = options.model;
  if (options['reasoning-effort']) input.reasoning_effort = options['reasoning-effort'];
  const sent = await call('work_send', input);
  const duplicate = await call('work_send', input);
  assert.equal(duplicate.task_id, sent.task_id); assert.equal(duplicate.turn_id, sent.turn_id);
  const result = await complete(sent);
  assert.equal(result.status, 'completed'); assert.ok(result.final_text.includes(marker));
  passed('dispatch, idempotent retry, wait and result', { status: result.status, same_turn_on_retry: true });
  if (input.model || input.reasoning_effort) {
    if (input.model) assert.equal(result.effective_model, input.model);
    if (input.reasoning_effort) assert.equal(result.effective_reasoning_effort, input.reasoning_effort);
    passed('actual model and reasoning effort override', { requested_model: result.requested_model, requested_reasoning_effort: result.requested_reasoning_effort, effective_model: result.effective_model, effective_reasoning_effort: result.effective_reasoning_effort, turn_id: result.turn_id });
  }
  const nextMarker = 'WORK_FOLLOWUP_OK_' + randomUUID();
  const followup = await call('work_send', { thread_id: options['thread-id'], request_id: randomUUID(), prompt: '继续同一个测试聊天。不要调用工具，只回复：' + nextMarker });
  const next = await complete(followup); assert.ok(next.final_text.includes(nextMarker));
  if (input.model) assert.equal(next.effective_model, input.model);
  if (input.reasoning_effort) assert.equal(next.effective_reasoning_effort, input.reasoning_effort);
  passed('follow-up to the same chat', { status: next.status, effective_model: next.effective_model, effective_reasoning_effort: next.effective_reasoning_effort });
  if (options['plugin-name'] || options['skill-name']) {
    const selection = { thread_id: options['thread-id'], request_id: randomUUID(),
      prompt: '这是指定能力的只读验收。请实际使用附加的技能（若有），按技能流程核实官方 Codex app-server 压缩文档；实际调用附加的 desktop 插件 get_config（若有）一次。不要编辑文件、创建任务或发送消息。最终简洁报告实际使用的技能与工具以及结果，附上 WORK_SELECTION_OK。不可用则明确报告失败。' };
    if (options['plugin-name']) selection.plugins = [{ name: options['plugin-name'], path: options['plugin-path'] }];
    if (options['skill-name']) selection.skills = [{ name: options['skill-name'], path: options['skill-path'] }];
    const selected = await complete(await call('work_send', selection));
    assert.equal(selected.status, 'completed'); assert.ok(selected.final_text.includes('WORK_SELECTION_OK'));
    if (options['plugin-name']) assert.ok(selected.tool_calls.some(tool => /get_config/.test(tool.name)), 'Expected an actual plugin tool call.');
    if (options['skill-name']) assert.ok(selected.tool_calls.some(tool => ['commandExecution', 'webSearch'].includes(tool.type)), 'Expected actual skill workflow evidence.');
    passed('structured plugin and skill selection', { status: selected.status, tool_calls: selected.tool_calls });
  }
  if (options.interrupt) {
    const active = await call('work_send', { thread_id: options['thread-id'], request_id: randomUUID(), prompt: '这是停止接口测试，请通过可用的等待工具等待90秒后再回复 WORK_INTERRUPT_TOO_LATE；不要编辑文件或执行命令。' });
    const stop = await call('work_interrupt', { task_id: active.task_id }); assert.equal(stop.interrupt_requested, true);
    const stopped = await complete(active, 60000); assert.equal(stopped.status, 'interrupted');
    passed('exact-turn interruption', { status: stopped.status });
  }
  if (options.compact) {
    const compacted = await complete(await call('work_compact', { thread_id: options['thread-id'], request_id: randomUUID() }));
    assert.equal(compacted.status, 'completed'); assert.equal(compacted.compaction?.completed, true); assert.equal(compacted.compaction?.source, 'manual');
    passed('real completed context compaction', { status: compacted.status, completed_item: 'contextCompaction' });
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; console.error(error.message); process.exitCode = 1;
} finally {
  await client.close();
  report.finished_at = new Date().toISOString(); report.elapsed_seconds = (Date.now() - started) / 1000;
  if (options.out) { const filename = path.resolve(options.out); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  progress('Verification finished');
}
