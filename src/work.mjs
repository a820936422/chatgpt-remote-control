import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { WorkIpcClient } from './work-ipc.mjs';
import { WorkStore, fingerprint, taskIdFor, terminalStatus, listLocalChats, listLocalSkills } from './work-store.mjs';
import { conversationTurns, summarizeTurn, completedCompactions, findCorrelatedTurn } from './work-state.mjs';

const uuidPattern = '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$';
const threadProperty = { type: 'string', pattern: uuidPattern, description: 'Exact existing local Work thread UUID from work_list_chats.' };
const requestProperty = { type: 'string', minLength: 8, maxLength: 128, description: 'Unique retry key. Reuse the same value with identical input after timeout; never retry with a new key automatically.' };
const taskProperty = { type: 'string', pattern: '^work_[a-f0-9]{64}$' };
const selectionProperty = { type: 'array', maxItems: 16, items: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 160 }, path: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['name', 'path'], additionalProperties: false } };
const definition = (name, description, properties, required = [], readOnly = true) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } });

export const workToolDefinitions = [
  definition('work_info', 'Check the local desktop Work bridge. Uses an experimental same-user desktop IPC adapter, not app-server proxy. Requires the desktop app running; cannot create chats or control cloud Work.', {}),
  definition('work_list_chats', 'List metadata of existing local Work chats. Open the selected chat in the desktop app before sending so its owner is available. No conversation contents are returned.', { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }),
  definition('work_list_skills', 'Find local skill names and absolute SKILL.md paths for work_send. A listed skill still needs to be usable in the selected Work chat.', { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }),
  definition('work_send', 'Start a task or send a follow-up to an idle existing local Work chat. Explicit skill and plugin selections are sent as structured inputs. Inherits the chat model, workspace and permissions. Returns a persistent task_id; use work_wait then work_result. Busy chats are rejected. Preserve request_id on retries; outcome_unknown is never automatically resent.', { thread_id: threadProperty, request_id: requestProperty, prompt: { type: 'string', minLength: 1, maxLength: 100000 }, skills: selectionProperty, plugins: selectionProperty }, ['thread_id', 'request_id', 'prompt'], false),
  definition('work_status', 'Read the status and pending approval/input summaries for a task_id. Acknowledged dispatch is not completion. Reconciles uncertain delivery by its recorded turn identity without resending.', { task_id: taskProperty }, ['task_id']),
  definition('work_result', 'Read the final answer, tool-call summaries and changed-file paths for a completed task. Returns its current status while unfinished. Does not return full reasoning or raw conversation history.', { task_id: taskProperty, max_chars: { type: 'integer', minimum: 100, maximum: 50000, default: 20000 } }, ['task_id']),
  definition('work_wait', 'Wait up to 45 seconds for completion, failure, interruption, approval or user input. Call again with the same task_id if timed out. Does not launch or resend work.', { task_id: taskProperty, timeout_ms: { type: 'integer', minimum: 0, maximum: 45000, default: 30000 } }, ['task_id']),
  definition('work_interrupt', 'Stop the active turn belonging to a task_id. Uses its exact turn ID and refuses to interrupt a different turn. Does not answer approvals or discard conversation history.', { task_id: taskProperty }, ['task_id'], false),
  definition('work_compact', 'Trigger real context compaction in an idle existing local Work chat. Returns a task_id; completion requires a new completed manual contextCompaction item. Sending /compact as text is not equivalent. Preserve request_id on retries.', { thread_id: threadProperty, request_id: requestProperty }, ['thread_id', 'request_id'], false),
];

function validateArgs(name, args) {
  const schema = workToolDefinitions.find(tool => tool.name === name)?.inputSchema;
  if (!schema) throw new Error('Unknown Work tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  for (const key of Object.keys(args)) if (!(key in schema.properties)) throw new Error('Unknown argument: ' + key);
  for (const key of schema.required) if (args[key] === undefined) throw new Error('Missing argument: ' + key);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity) || (rule.pattern && !new RegExp(rule.pattern).test(value)) || value.includes('\0'))) throw new Error('Invalid ' + key + '.');
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new Error('Invalid ' + key + '.');
    if (rule.type === 'array' && (!Array.isArray(value) || value.length > rule.maxItems)) throw new Error('Invalid ' + key + '.');
  }
}

export async function buildWorkInput(prompt, skills = [], plugins = []) {
  const input = [{ type: 'text', text: prompt, text_elements: [] }];
  for (const selection of [...skills, ...plugins]) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['name', 'path'].includes(key)) || typeof selection.name !== 'string' || !selection.name.trim() || selection.name.length > 160 || typeof selection.path !== 'string' || !selection.path || selection.path.length > 4096 || /[\x00-\x1f]/.test(selection.name + selection.path)) throw new Error('Selections require a valid name and path.');
  }
  for (const selection of skills) {
    if (!path.isAbsolute(selection.path) || path.basename(selection.path) !== 'SKILL.md') throw new Error('Skill path must be an absolute SKILL.md path from work_list_skills.');
    const stat = await lstat(selection.path);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Skill file is unavailable or too large.');
    input.push({ type: 'skill', ...selection });
  }
  for (const selection of plugins) {
    if (!/^(?:plugin:\/\/[A-Za-z0-9_.:-]+@[A-Za-z0-9_.:-]+|app:\/\/[A-Za-z0-9_.:-]+)$/.test(selection.path)) throw new Error('Plugin path must be an exact plugin:// or app:// reference.');
    input.push({ type: 'mention', ...selection });
  }
  return input;
}

function statusView(task) {
  return { task_id: task.task_id, request_id: task.request_id, thread_id: task.thread_id, turn_id: task.turn_id ?? null,
    operation: task.operation, status: task.status, revision: task.revision, created_at: task.created_at,
    updated_at: task.updated_at, awaiting_approval: task.summary?.awaiting_approval ?? false,
    awaiting_user_input: task.summary?.awaiting_user_input ?? false, pending_requests: task.pending_requests ?? [],
    ...(task.error ? { error: task.error } : {}) };
}
const pendingRequests = state => (state.requests ?? []).filter(request => request.completed !== true && request.completedAtMs == null);
const compactionItems = state => conversationTurns(state).flatMap(turn => (turn.items ?? []).filter(item => item.type === 'contextCompaction' && item.id !== 'pending-manual-context-compaction').map(item => ({ turn, item })));

export function createWork(config, options = {}) {
  const settings = config.work;
  let client;
  const store = options.store ?? new WorkStore(settings.stateDirectory);
  const locks = new Map();
  const getClient = () => client ??= options.client ?? new WorkIpcClient({ socketPath: settings.socketPath, requestTimeoutMs: settings.requestTimeoutMs });
  async function serialized(threadId, callback) {
    const previous = locks.get(threadId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(callback);
    const tail = result.catch(() => {});
    locks.set(threadId, tail);
    try { return await result; } finally { if (locks.get(threadId) === tail) locks.delete(threadId); }
  }
  function allowed(threadId) {
    if (!new RegExp(uuidPattern).test(threadId)) throw new Error('Invalid thread_id.');
    if (settings.allowedThreadIds.length && !settings.allowedThreadIds.includes(threadId)) throw new Error('Thread is not in work.allowedThreadIds.');
  }
  async function snapshot(threadId, signal) {
    allowed(threadId);
    const state = await getClient().snapshot(threadId, { signal });
    if (state.hostId && state.hostId !== 'local') throw new Error('Only local Work chats are supported.');
    if (!settings.allowCodexThreads && state.originator !== 'codex_work_desktop' && state.serviceName !== 'codex_work_desktop') throw new Error('Selected thread is not a local Work chat.');
    return state;
  }
  async function changed(task, values) {
    const before = fingerprint({ ...task, updated_at: null, revision: null });
    Object.assign(task, values);
    if (before !== fingerprint({ ...task, updated_at: null, revision: null })) {
      task.updated_at = new Date().toISOString(); task.revision = (task.revision ?? 0) + 1; await store.save(task);
    }
    return task;
  }
  async function refresh(task, signal, state) {
    allowed(task.thread_id);
    if (terminalStatus(task.status)) return task;
    state ??= await snapshot(task.thread_id, signal);
    const pending = pendingRequests(state).slice(0, 20).map(request => ({ id: request.id, method: request.method }));
    if (task.operation === 'compact') {
      const item = completedCompactions(state).find(item => item.source === 'manual' && !task.previous_compaction_ids.includes(item.id));
      if (item) return changed(task, { status: 'completed', turn_id: item.turn_id, summary: { compaction: item }, error: null, pending_requests: [] });
      const failed = compactionItems(state).find(({ turn, item }) => item.source === 'manual' && !task.previous_compaction_ids.includes(item.id) && ['failed', 'interrupted'].includes(turn.status));
      if (failed) return changed(task, { status: failed.turn.status, turn_id: failed.turn.turnId ?? failed.turn.id, error: failed.turn.error ?? null, pending_requests: [] });
      return changed(task, { pending_requests: pending });
    }
    const turn = findCorrelatedTurn(state, { turn_id: task.turn_id, client_user_message_id: task.client_user_message_id });
    if (!turn) return changed(task, { pending_requests: pending });
    const summary = summarizeTurn(turn, state.threadRuntimeStatus, state.requests);
    const status = summary.awaiting_approval ? 'awaiting_approval' : summary.awaiting_user_input ? 'awaiting_user_input' : summary.status;
    return changed(task, { turn_id: summary.turn_id, status, summary, pending_requests: pending, error: summary.error ?? null });
  }
  async function getTask(taskId, signal) {
    const task = await store.get(taskId);
    if (!task) throw new Error('Unknown task_id.');
    return serialized(task.thread_id, () => store.withMutationLease(async () => refresh(await store.get(taskId), signal)));
  }
  async function start(args, operation, signal) {
    allowed(args.thread_id);
    const signature = fingerprint({ operation, thread_id: args.thread_id, prompt: args.prompt ?? null, skills: args.skills ?? [], plugins: args.plugins ?? [] });
    const taskId = taskIdFor(args.request_id);
    return serialized(args.thread_id, () => store.withMutationLease(async () => {
      let task = await store.get(taskId);
      if (task) {
        if (task.signature !== signature) throw new Error('request_id was already used with different input.');
        return refresh(task, signal);
      }
      const input = operation === 'send' ? await buildWorkInput(args.prompt, args.skills, args.plugins) : null;
      const state = await snapshot(args.thread_id, signal);
      for (let pending of (await store.list()).filter(task => task.thread_id === args.thread_id && !terminalStatus(task.status))) {
        pending = await refresh(pending, signal, state);
        if (!terminalStatus(pending.status)) throw new Error('This thread already has an unfinished or uncertain bridge task: ' + pending.task_id + '. Query it before dispatching again.');
      }
      if (state.threadRuntimeStatus?.type === 'active' || conversationTurns(state).some(turn => turn.status === 'inProgress') || pendingRequests(state).length) throw new Error('Work chat is busy or waiting for input. Use work_wait or work_interrupt before sending a new task.');
      const now = new Date().toISOString();
      task = { task_id: taskId, request_id: args.request_id, signature, operation, thread_id: args.thread_id,
        client_user_message_id: randomUUID(), created_at: now, updated_at: now, revision: 1, status: 'outcome_unknown',
        previous_compaction_ids: compactionItems(state).map(({ item }) => item.id), summary: null };
      // Persist the intent before writing any mutation to IPC. A crash can never silently resend it.
      await store.save(task);
      try {
        const response = operation === 'send'
          ? await getClient().startTurn(args.thread_id, input, { clientUserMessageId: task.client_user_message_id, signal })
          : await getClient().compact(args.thread_id, { signal });
        const turn = response?.turn;
        await changed(task, { status: 'running', turn_id: turn?.id ?? null, error: null });
      } catch (error) {
        await changed(task, { status: ['not-sent', 'rejected'].includes(error.delivery) ? 'not_sent' : 'outcome_unknown', error: { message: error.message, delivery: error.delivery ?? 'outcome-unknown' } });
      }
      return task;
    }));
  }
  async function invoke(name, args, signal) {
    if (!settings.enabled) throw new Error('Work bridge is disabled in local configuration.');
    validateArgs(name, args);
    signal?.throwIfAborted();
    if (name === 'work_info') {
      let available = true, error = null;
      try { await getClient().connect(); } catch (failure) { available = false; error = failure.message; }
      return { enabled: true, available, transport: 'desktop-internal-ipc', experimental: true, socket_path: settings.socketPath,
        local_only: true, can_create_chats: false, allow_codex_threads: settings.allowCodexThreads, allowed_thread_ids: settings.allowedThreadIds,
        ...(error ? { error } : {}) };
    }
    if (name === 'work_list_chats') return { chats: await listLocalChats(settings, args.limit ?? 20), local_only: true };
    if (name === 'work_list_skills') return { skills: await listLocalSkills(settings.codexHome, args.limit ?? 100) };
    if (name === 'work_send' || name === 'work_compact') return statusView(await start(args, name === 'work_send' ? 'send' : 'compact', signal));
    if (name === 'work_interrupt') {
      const initial = await store.get(args.task_id);
      if (!initial) throw new Error('Unknown task_id.');
      return serialized(initial.thread_id, () => store.withMutationLease(async () => {
        const task = await store.get(args.task_id);
        await refresh(task, signal);
        if (terminalStatus(task.status)) return statusView(task);
        if (task.operation !== 'send' || !task.turn_id) throw new Error('No confirmed task turn to interrupt.');
        await getClient().interrupt(task.thread_id, { expectedTurnId: task.turn_id, signal });
        return { ...statusView(task), interrupt_requested: true };
      }));
    }
    if (name === 'work_wait') {
      const end = Date.now() + (args.timeout_ms ?? 30000);
      let task;
      do {
        task = await getTask(args.task_id, signal);
        if (terminalStatus(task.status) || ['awaiting_approval', 'awaiting_user_input', 'outcome_unknown'].includes(task.status)) return { ...statusView(task), timed_out: false };
        if (Date.now() >= end) break;
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Cancelled')); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.min(1000, end - Date.now()));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      } while (Date.now() <= end);
      return { ...statusView(task), timed_out: true };
    }
    const task = await getTask(args.task_id, signal);
    if (name === 'work_status') return statusView(task);
    const limit = args.max_chars ?? 20000;
    const summary = task.summary ?? {};
    const text = summary.final_text ?? '';
    return { ...statusView(task), final_text: text.slice(0, limit), truncated: text.length > limit,
      tool_calls: (summary.tool_calls ?? []).slice(0, 100), changed_files: (summary.changed_files ?? []).slice(0, 100),
      ...(summary.compaction ? { compaction: summary.compaction } : {}) };
  }
  async function call(name, args = {}, signal) {
    try {
      const result = await invoke(name, args, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
        ...(['outcome_unknown', 'not_sent'].includes(result.status) ? { isError: true } : {}) };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  }
  return { tools: settings.enabled ? workToolDefinitions : [], call, close: async () => { await client?.close(); } };
}
