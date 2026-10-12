import net from 'node:net';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { conversationTurns } from './work-state.mjs';

// This is the desktop app's local, versioned follower protocol, not App Server's
// public JSON-RPC API. A successful mutation response confirms delivery only.
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DEFINITE_RPC_REJECTIONS = new Set(['no-client-found', 'no-handler-for-request', 'request-version-mismatch', 'client-cannot-handle-request']);
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const decoder = new TextDecoder('utf-8', { fatal: true });

export class WorkIpcError extends Error {
  constructor(code, message, { outcomeUnknown = false, delivery = outcomeUnknown ? 'outcome-unknown' : 'not-sent', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WorkIpcError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.delivery = delivery;
  }
}

function validTimeout(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 300000) throw new TypeError('timeoutMs must be an integer between 1 and 300000.');
  return result;
}

function validateThreadId(threadId) {
  if (typeof threadId !== 'string' || threadId.length < 1 || threadId.length > 200 || /[\x00-\x20]/.test(threadId)) throw new TypeError('A nonempty Work threadId is required.');
}

function validateInput(input) {
  if (!Array.isArray(input) || input.length === 0) throw new TypeError('Work input must be a nonempty array of user input items.');
}

function validateCollaborationMode(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['default', 'plan'].includes(value.mode) ||
      Object.keys(value).some(key => !['mode', 'settings'].includes(key))) throw new TypeError('Work collaborationMode must contain a default or plan mode and settings.');
  const settings = value.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.keys(settings).some(key => !['model', 'reasoning_effort', 'developer_instructions'].includes(key)) ||
      typeof settings.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(settings.model) ||
      !(settings.reasoning_effort === null || REASONING_EFFORTS.has(settings.reasoning_effort)) ||
      !(settings.developer_instructions === null || typeof settings.developer_instructions === 'string')) throw new TypeError('Work collaborationMode settings require a model ID, a supported reasoning effort or null, and developer instructions or null.');
  // Capture the selected settings before asynchronous owner discovery so a
  // caller cannot change the reviewed request while it is waiting to dispatch.
  return {
    mode: value.mode,
    settings: {
      model: settings.model,
      reasoning_effort: settings.reasoning_effort,
      developer_instructions: settings.developer_instructions,
    },
  };
}

function cancellation(signal, outcomeUnknown = false) {
  const error = new WorkIpcError('cancelled', 'Work IPC operation was cancelled.', { outcomeUnknown, cause: signal?.reason instanceof Error ? signal.reason : undefined });
  error.name = 'AbortError';
  return error;
}

function notSent(error) {
  if (error?.delivery === 'not-sent') return error;
  const wrapped = new WorkIpcError(error?.name === 'AbortError' ? 'cancelled' : error?.code ?? 'not-sent', error instanceof Error ? error.message : String(error), { cause: error instanceof Error ? error : undefined });
  if (error?.name === 'AbortError') wrapped.name = 'AbortError';
  return wrapped;
}

// Desktop state patches use Immer's array-of-segments paths, not JSON Pointer.
// Reject unsupported paths rather than producing a misleading partial result.
export function applyWorkPatches(original, patches) {
  if (!Array.isArray(patches)) throw new WorkIpcError('invalid-patches', 'Work stream patches must be an array.');
  let result = structuredClone(original);
  for (const patch of patches) {
    if (!patch || !['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path)) throw new WorkIpcError('invalid-patches', 'Unsupported Work state patch.');
    for (const segment of patch.path) {
      if (!(typeof segment === 'string' || Number.isInteger(segment) && segment >= 0) || FORBIDDEN_KEYS.has(segment)) throw new WorkIpcError('invalid-patches', 'Unsafe or unsupported Work state patch path.');
    }
    if (patch.path.length === 0) {
      if (patch.op === 'remove' || !Object.hasOwn(patch, 'value')) throw new WorkIpcError('invalid-patches', 'Invalid root Work state patch.');
      result = structuredClone(patch.value);
      continue;
    }
    let parent = result;
    for (const segment of patch.path.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, segment)) throw new WorkIpcError('invalid-patches', 'Work state patch parent does not exist.');
      parent = parent[segment];
    }
    if (parent === null || typeof parent !== 'object') throw new WorkIpcError('invalid-patches', 'Work state patch parent is not a container.');
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.length || patch.op !== 'add' && key === parent.length) throw new WorkIpcError('invalid-patches', 'Invalid Work state array index.');
      if (patch.op === 'remove') parent.splice(key, 1);
      else {
        if (!Object.hasOwn(patch, 'value')) throw new WorkIpcError('invalid-patches', 'Work state patch is missing its value.');
        if (patch.op === 'add') parent.splice(key, 0, structuredClone(patch.value));
        else parent[key] = structuredClone(patch.value);
      }
    } else {
      if (typeof key !== 'string' || patch.op !== 'add' && !Object.hasOwn(parent, key)) throw new WorkIpcError('invalid-patches', 'Invalid Work state object key.');
      if (patch.op === 'remove') delete parent[key];
      else {
        if (!Object.hasOwn(patch, 'value')) throw new WorkIpcError('invalid-patches', 'Work state patch is missing its value.');
        parent[key] = structuredClone(patch.value);
      }
    }
  }
  return result;
}

export class WorkIpcClient {
  constructor({ socketPath, requestTimeoutMs = 10000 } = {}) {
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0')) throw new TypeError('Work IPC socketPath must be an absolute Unix socket path.');
    if (process.platform === 'win32' || typeof process.getuid !== 'function') throw new WorkIpcError('unsupported-platform', 'Work IPC currently requires a same-user Unix socket.');
    this.socketPath = socketPath;
    this.requestTimeoutMs = validTimeout(requestTimeoutMs, 10000);
    this.clientId = 'initializing-client';
    this.pending = new Map();
    this.owners = new Map();
    this.states = new Map();
    this.followed = new Set();
    this.threadErrors = new Map();
    this.stateWaiters = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = null;
    this.connecting = null;
    this.initialized = false;
    this.disposed = false;
  }

  async connect() {
    if (this.disposed) throw new WorkIpcError('closed', 'Work IPC client is closed.');
    if (this.initialized) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectLocal().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connectLocal() {
    const stat = await lstat(this.socketPath);
    if (this.disposed) throw new WorkIpcError('closed', 'Work IPC client is closed.');
    if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new WorkIpcError('unsafe-socket', 'Work IPC socket must be owned by the current user and inaccessible to other users.');
    const socket = net.createConnection({ path: this.socketPath });
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      try { this.receive(chunk); } catch (error) { this.disconnect(error); }
    });
    socket.on('error', error => this.disconnect(new WorkIpcError('connection-error', 'Work IPC connection failed.', { cause: error })));
    socket.on('close', () => {
      if (this.socket === socket) this.disconnect(new WorkIpcError('connection-closed', 'Work IPC connection closed.'));
    });
    try {
      await new Promise((resolve, reject) => {
        let timer;
        const clean = () => { clearTimeout(timer); socket.off('connect', onConnect); socket.off('error', onError); socket.off('close', onClose); };
        const onConnect = () => { clean(); resolve(); };
        const onError = error => { clean(); reject(error); };
        const onClose = () => { clean(); reject(new WorkIpcError('connection-closed', 'Work IPC connection closed before initialization.')); };
        timer = setTimeout(() => { clean(); reject(new WorkIpcError('connection-timeout', 'Work IPC connection timed out.')); }, this.requestTimeoutMs);
        socket.once('connect', onConnect);
        socket.once('error', onError);
        socket.once('close', onClose);
      });
      const current = await lstat(this.socketPath);
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw new WorkIpcError('unsafe-socket', 'Work IPC socket changed while connecting.');
      const response = await this.request('initialize', { clientType: 'chatgpt-remote-control' }, { version: 0 });
      if (typeof response.result?.clientId !== 'string' || !response.result.clientId) throw new WorkIpcError('invalid-initialize', 'Desktop IPC did not assign a client ID.');
      this.clientId = response.result.clientId;
      this.initialized = true;
      return this;
    } catch (error) {
      this.disconnect(error);
      throw error;
    }
  }

  send(message) {
    if (!this.socket?.writable) throw new WorkIpcError('connection-closed', 'Work IPC is not connected.');
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_FRAME_BYTES) throw new WorkIpcError('frame-too-large', 'Work IPC frame exceeds 32 MiB.');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new WorkIpcError('invalid-frame', 'Desktop IPC sent an invalid frame size.');
      if (this.buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(decoder.decode(this.buffer.subarray(4, length + 4))); }
      catch (cause) { throw new WorkIpcError('invalid-frame', 'Desktop IPC sent invalid JSON.', { cause }); }
      this.buffer = this.buffer.subarray(length + 4);
      if (!this.buffer.length) this.buffer = Buffer.alloc(0);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new WorkIpcError('invalid-frame', 'Desktop IPC sent an invalid message.');
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      if (message.resultType === 'error') {
        // Handler exceptions may occur after the owner has accepted a turn.
        // Only router/compatibility refusals prove a mutation never started.
        const outcomeUnknown = pending.mutating && !DEFINITE_RPC_REJECTIONS.has(message.error);
        pending.reject(new WorkIpcError('rpc-error', `Desktop IPC ${pending.method} failed: ${String(message.error ?? 'unknown-error')}`, { outcomeUnknown, delivery: outcomeUnknown ? 'outcome-unknown' : 'rejected' }));
      }
      else if (message.resultType !== 'success' || message.method !== pending.method) pending.reject(new WorkIpcError('invalid-response', 'Desktop IPC response does not match the request.', { outcomeUnknown: pending.mutating }));
      else if (pending.targetClientId && message.handledByClientId !== pending.targetClientId) pending.reject(new WorkIpcError('owner-changed', 'A different desktop client handled the Work request.', { outcomeUnknown: pending.mutating }));
      else pending.resolve(message);
      return;
    }
    // This bridge is a follower; it never claims ownership of user conversations.
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === 'request') {
      this.send({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-handler-for-request' });
      return;
    }
    if (message.type !== 'broadcast' || message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return;
    const params = message.params ?? {};
    if (message.method === 'client-status-changed' && params.status === 'disconnected') {
      for (const [threadId, owner] of this.owners) if (owner === params.clientId) this.invalidate(threadId, new WorkIpcError('owner-disconnected', 'Work thread owner disconnected.'));
      return;
    }
    if (message.method === 'ipc-connection-reset') {
      for (const threadId of this.owners.keys()) this.invalidate(threadId, new WorkIpcError('stream-reset', 'Desktop IPC stream was reset.'));
      return;
    }
    if (message.method !== 'thread-stream-state-changed' || params.hostId !== 'local' || !this.followed.has(params.conversationId)) return;
    const threadId = params.conversationId;
    try {
      if (message.version !== 11) throw new WorkIpcError('stream-version-mismatch', 'Desktop Work stream version changed; review compatibility before retrying.');
      if (this.owners.get(threadId) !== message.sourceClientId) throw new WorkIpcError('owner-changed', 'Work thread stream owner changed.');
      const change = params.change;
      if (!change || !Number.isSafeInteger(change.revision) || change.revision < 0) throw new WorkIpcError('invalid-stream', 'Desktop Work stream has an invalid revision.');
      let state;
      if (change.type === 'snapshot') {
        state = change.conversationState;
        if (!state || typeof state !== 'object' || Array.isArray(state) || state.id !== threadId) throw new WorkIpcError('invalid-stream', 'Desktop Work snapshot does not match the requested thread.');
        const previous = this.states.get(threadId);
        if (previous && change.revision < previous.revision) throw new WorkIpcError('stream-revision-mismatch', 'Desktop Work snapshot revision moved backwards.');
        state = structuredClone(state);
      } else if (change.type === 'patches') {
        const previous = this.states.get(threadId);
        if (!previous || previous.revision !== change.baseRevision || change.revision <= change.baseRevision) throw new WorkIpcError('stream-revision-mismatch', 'Desktop Work stream missed a revision; obtain a fresh snapshot.');
        state = applyWorkPatches(previous.state, change.patches);
        if (state?.id !== threadId) throw new WorkIpcError('invalid-stream', 'Desktop Work patches changed the thread identity.');
      } else throw new WorkIpcError('invalid-stream', 'Desktop Work stream change type is unsupported.');
      this.states.set(threadId, { revision: change.revision, state });
      this.threadErrors.delete(threadId);
      for (const waiter of [...this.stateWaiters.get(threadId) ?? []]) waiter.resolve(structuredClone(state));
    } catch (error) { this.invalidate(threadId, error); }
  }

  request(method, params, { version = 1, targetClientId, timeoutMs, signal, requestId = randomUUID(), mutating = false } = {}) {
    if (signal?.aborted) return Promise.reject(cancellation(signal));
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return Promise.reject(new TypeError('Work IPC requestId must be a UUID.'));
    const timeout = validTimeout(timeoutMs, this.requestTimeoutMs);
    if (this.pending.has(requestId)) return Promise.reject(new WorkIpcError('duplicate-request', 'Work IPC requestId is already pending.'));
    return new Promise((resolve, reject) => {
      let timer, sent = false;
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.pending.delete(requestId); };
      const done = fn => value => { clean(); fn(value); };
      const onAbort = () => done(reject)(cancellation(signal, mutating && sent));
      const pending = { method, targetClientId, mutating, resolve: done(resolve), reject: done(reject) };
      this.pending.set(requestId, pending);
      timer = setTimeout(() => pending.reject(new WorkIpcError('request-timeout', `Desktop IPC ${method} timed out.`, { outcomeUnknown: mutating && sent })), timeout);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, timeoutMs: timeout, ...targetClientId ? { targetClientId } : {} });
        sent = true;
      } catch (error) { pending.reject(error); }
    });
  }

  async discover(threadId, { signal } = {}) {
    validateThreadId(threadId);
    signal?.throwIfAborted();
    await this.connect();
    const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, { signal });
    const owner = response.handledByClientId;
    if (typeof owner !== 'string' || !owner) throw new WorkIpcError('no-owner', 'No desktop owner was found for this local Work thread.');
    const previous = this.owners.get(threadId);
    if (previous && previous !== owner) {
      this.owners.delete(threadId);
      this.followed.delete(threadId);
      this.invalidate(threadId, new WorkIpcError('owner-changed', 'Work thread owner changed; retry discovery before sending another task.'));
      throw this.threadErrors.get(threadId);
    }
    this.owners.set(threadId, owner);
    return owner;
  }

  following(threadId, owner, following) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId, version: 1, targetClientIds: [owner], params: { hostId: 'local', conversationId: threadId, following } });
  }

  async snapshot(threadId, { timeoutMs, signal } = {}) {
    const timeout = validTimeout(timeoutMs, this.requestTimeoutMs);
    const owner = await this.discover(threadId, { signal });
    signal?.throwIfAborted();
    const cached = this.states.get(threadId);
    if (cached && !this.threadErrors.has(threadId)) return structuredClone(cached.state);
    return new Promise((resolve, reject) => {
      let timer;
      const waiters = this.stateWaiters.get(threadId) ?? new Set();
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        waiters.delete(waiter);
        if (!waiters.size) this.stateWaiters.delete(threadId);
      };
      const waiter = { resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); } };
      const onAbort = () => waiter.reject(cancellation(signal));
      waiters.add(waiter);
      this.stateWaiters.set(threadId, waiters);
      timer = setTimeout(() => waiter.reject(new WorkIpcError('snapshot-timeout', 'Timed out waiting for a Work thread snapshot.')), timeout);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.followed.add(threadId);
      try { this.following(threadId, owner, true); } catch (error) { waiter.reject(error); }
    });
  }

  stateFor(threadId, options) { return this.snapshot(threadId, options); }

  async startTurn(threadId, input, options = {}) {
    let owner, requestId, clientUserMessageId, signal, collaborationMode;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Work startTurn options must be an object.');
      ({ requestId, clientUserMessageId = randomUUID(), signal } = options);
      validateInput(input);
      collaborationMode = validateCollaborationMode(options.collaborationMode);
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))) throw new TypeError('Work IPC requestId must be a UUID.');
      if (typeof clientUserMessageId !== 'string' || !clientUserMessageId || clientUserMessageId.length > 200 || /[\x00-\x20]/.test(clientUserMessageId)) throw new TypeError('Work clientUserMessageId must be a nonempty message ID.');
      owner = await this.discover(threadId, { signal });
    } catch (error) { throw notSent(error); }
    const request = { threadId, clientUserMessageId, input, ...collaborationMode === undefined ? {} : { collaborationMode } };
    const response = await this.request('thread-follower-start-turn', { conversationId: threadId, turnStart: { request, context: { inheritThreadSettings: true } } }, { version: 2, targetClientId: owner, requestId, signal, mutating: true });
    if (response.result?.result === undefined) throw new WorkIpcError('invalid-response', 'Desktop IPC did not return a turn-start result.', { outcomeUnknown: true });
    return response.result?.result;
  }

  async steerTurn(threadId, input, { expectedTurnId, signal } = {}) {
    validateInput(input);
    if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw new TypeError('steerTurn requires expectedTurnId.');
    const state = await this.snapshot(threadId, { signal });
    const active = conversationTurns(state).findLast(turn => turn.status === 'inProgress');
    if (active?.turnId !== expectedTurnId) throw new WorkIpcError('turn-mismatch', 'The expected Work turn is no longer active.');
    const id = randomUUID();
    const restoreMessage = { id, cwd: state.cwd, context: { workspaceRoots: state.cwd ? [state.cwd] : [], collaborationMode: state.latestCollaborationMode ?? null } };
    const owner = await this.discover(threadId, { signal });
    // Follower v1 performs a local check only; the desktop owner may retarget a
    // steering request if the active turn changes before it processes the RPC.
    const response = await this.request('thread-follower-steer-turn', { conversationId: threadId, input, clientUserMessageId: id, restoreMessage, attachments: [] }, { targetClientId: owner, signal, mutating: true });
    return response.result?.result;
  }

  async interrupt(threadId, { expectedTurnId, signal } = {}) {
    let owner;
    try { owner = await this.discover(threadId, { signal }); }
    catch (error) { throw notSent(error); }
    const response = await this.request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', ...expectedTurnId ? { expectedTurnId } : {} }, { version: expectedTurnId ? 4 : 3, targetClientId: owner, signal, mutating: true });
    return response.result;
  }

  async compact(threadId, { signal } = {}) {
    let owner;
    try { owner = await this.discover(threadId, { signal }); }
    catch (error) { throw notSent(error); }
    const response = await this.request('thread-follower-compact-thread', { conversationId: threadId }, { targetClientId: owner, signal, mutating: true });
    return response.result;
  }

  invalidate(threadId, error) {
    this.states.delete(threadId);
    this.threadErrors.set(threadId, error);
    for (const waiter of [...this.stateWaiters.get(threadId) ?? []]) waiter.reject(error);
  }

  disconnect(error) {
    const socket = this.socket;
    this.socket = null;
    this.initialized = false;
    this.clientId = 'initializing-client';
    this.buffer = Buffer.alloc(0);
    for (const pending of [...this.pending.values()]) pending.reject(new WorkIpcError(error.code ?? 'connection-closed', error.message, { cause: error, outcomeUnknown: pending.mutating }));
    for (const threadId of this.owners.keys()) this.invalidate(threadId, error);
    this.owners.clear();
    this.followed.clear();
    socket?.destroy();
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    for (const threadId of this.followed) {
      try { this.following(threadId, this.owners.get(threadId), false); } catch {}
    }
    this.disconnect(new WorkIpcError('closed', 'Work IPC client is closed.'));
  }
}
