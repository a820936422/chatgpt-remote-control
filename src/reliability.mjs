import { randomUUID } from 'node:crypto';

// A readOnlyHint is not enough: these exact tools have reviewed read semantics.
const SAFE_READ_TOOLS = new Set([
  'read_file', 'get_file_info', 'list_directory', 'get_config', 'desktop_info',
  'work_info', 'work_list_chats', 'work_list_skills', 'work_status', 'work_result',
]);
const DISCONNECTED_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTCONN', 'ENETDOWN', 'ENETUNREACH',
  'EHOSTUNREACH', 'EAI_AGAIN', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE',
  'CONNECTION_ERROR', 'CONNECTION_CLOSED', 'OWNER_DISCONNECTED', 'STREAM_RESET',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'REQUEST_TIMEOUT', 'CONNECTION_TIMEOUT', 'SNAPSHOT_TIMEOUT', 'DEADLINE_EXCEEDED']);
const UNAVAILABLE_CODES = new Set(['UNAVAILABLE', 'TEMPORARY', 'TEMPORARY_UNAVAILABLE', 'SERVICE_UNAVAILABLE']);
const INVALID_CODES = new Set(['INVALID_ARGUMENT', 'INVALID_PARAMS', 'INVALID_REQUEST', 'INVALID_ARGUMENTS']);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'PERMISSION_DENIED', 'UNAUTHORIZED', 'FORBIDDEN']);

export function isSafeReadTool(name, args = {}) {
  return SAFE_READ_TOOLS.has(name) &&
    (name !== 'read_file' || args?.isUrl === undefined || args.isUrl === false);
}

const normalizedCode = value => typeof value === 'string' ? value.toUpperCase().replaceAll('-', '_') : value;
const statusCode = value => typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;

function classifyCode(value) {
  const code = normalizedCode(value);
  const status = statusCode(code);
  if (PERMISSION_CODES.has(code) || status === 401 || status === 403) return { retryable: false, errorClass: 'permission-denied' };
  if (INVALID_CODES.has(code) || status === 400 || code === -32600 || code === -32602) return { retryable: false, errorClass: 'invalid-request' };
  if (code === 'ENOENT' || status === 404) return { retryable: false, errorClass: 'not-found' };
  if (code === 'CANCELLED' || code === 'CANCELED' || code === 'ABORT_ERR' || code === 'ECANCELED') return { retryable: false, errorClass: 'cancelled' };
  if (status === 429 || code === 'RESOURCE_EXHAUSTED' || code === 'RATE_LIMITED') return { retryable: true, errorClass: 'rate-limited' };
  if (typeof status === 'number' && status >= 500 && status <= 599 || UNAVAILABLE_CODES.has(code)) return { retryable: true, errorClass: 'service-unavailable' };
  if (DISCONNECTED_CODES.has(code)) return { retryable: true, errorClass: 'transport-disconnected' };
  if (TIMEOUT_CODES.has(code) || code === -32001) return { retryable: true, errorClass: 'transport-timeout' };
  return null;
}

/** Classify metadata, never copy error messages into logs. Unknown errors stop. */
export function classifyReadFailure(failure, { toolResult = false } = {}) {
  if (!toolResult && failure?.name === 'AbortError') return { retryable: false, errorClass: 'cancelled' };
  const sources = toolResult
    ? [failure?.structuredContent, failure?.structuredContent?.error]
    : [failure, failure?.cause];
  const decisions = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const value of [source.error_code, source.code, source.status, source.statusCode, source.response?.status]) {
      const decision = classifyCode(value);
      if (decision) decisions.push(decision);
    }
  }
  // A permission/argument/cancellation error cannot be upgraded by a nested cause.
  const refusal = decisions.find(decision => !decision.retryable);
  if (refusal) return refusal;
  if (decisions.length) return decisions[0];
  if (!toolResult && typeof failure?.message === 'string') {
    // SDK transports sometimes lack a machine code. Match an explicit prefix,
    // not arbitrary occurrences in filenames or remote page content.
    if (/^(?:Error:\s*)?(?:(?:UNAVAILABLE|SERVICE_UNAVAILABLE)(?::|$)|(?:temporarily unavailable|service unavailable)(?:\b|:))/i.test(failure.message)) return { retryable: true, errorClass: 'service-unavailable' };
    if (/^(?:Error:\s*)?(?:MCP transport (?:is )?(?:closed|disconnected)|connection (?:closed|reset|refused)|not connected)(?:\b|:)/i.test(failure.message)) return { retryable: true, errorClass: 'transport-disconnected' };
    if (failure.code === -32000 && /^MCP error -32000:\s*Connection closed\.?$/i.test(failure.message)) return { retryable: true, errorClass: 'transport-disconnected' };
  }
  return { retryable: false, errorClass: toolResult ? 'tool-error' : 'operation-error' };
}

function abortError(signal) {
  return signal?.reason ?? new DOMException('Operation cancelled.', 'AbortError');
}

export function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError(signal)); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function retryAfterMs(failure, now) {
  const hinted = failure?.structuredContent?.retry_after_ms ?? failure?.retry_after_ms;
  if (typeof hinted === 'number' && Number.isFinite(hinted) && hinted >= 0) return hinted;
  const headers = failure?.response?.headers;
  let value;
  try { value = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After']; } catch { return null; }
  if (typeof value !== 'string') return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}

export function createReliability(settings = {}, dependencies = {}) {
  const attempts = settings.readRetryAttempts ?? 3;
  const baseMs = settings.readRetryBaseMs ?? 250;
  const maxMs = settings.readRetryMaxMs ?? 2000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3 ||
      !Number.isInteger(baseMs) || baseMs < 0 || !Number.isInteger(maxMs) || maxMs < baseMs) throw new Error('Invalid read retry settings.');
  const logger = dependencies.logger ?? (entry => console.error(JSON.stringify(entry)));
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? abortableDelay;
  const uuid = dependencies.uuid ?? randomUUID;
  let inflight = 0;
  const delayFor = (failure, attempt) => {
    const hint = retryAfterMs(failure, now);
    // A long server cooldown stops this tool call instead of hammering sooner
    // than requested or holding a remote request open for the whole cooldown.
    if (hint !== null && hint > maxMs) return null;
    return Math.max(hint ?? 0, Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
  };

  async function call({ name, owner, args = {}, signal }, invoke) {
    const traceId = uuid();
    const started = now();
    const safeRead = isSafeReadTool(name, args);
    const limit = safeRead ? attempts : 1;
    let attempt = 0, ok = false, errorClass = null;
    const writeLog = (event, metadata = {}) => {
      const current = now();
      try {
        // Only server-known routing metadata and generated trace IDs are logged.
        logger({ component: 'bridge', method: 'tools/call', event,
          trace_id: traceId, name, owner, pid: process.pid,
          ts: new Date(current).toISOString(), elapsed_ms: Math.max(0, current - started),
          inflight, attempt, ...metadata });
      } catch { /* Diagnostics cannot change tool execution or its receipt. */ }
    };
    inflight += 1;
    writeLog('start');
    try {
      while (attempt < limit) {
        if (signal?.aborted) throw abortError(signal);
        attempt += 1;
        writeLog('attempt');
        let result, decision;
        try {
          result = await invoke(attempt);
          if (result?.isError !== true) { ok = true; return result; }
          decision = classifyReadFailure(result, { toolResult: true });
        } catch (error) {
          decision = classifyReadFailure(error);
          if (signal?.aborted || !safeRead || !decision.retryable || attempt >= limit) throw error;
          errorClass = decision.errorClass;
          const delay = delayFor(error, attempt);
          if (delay === null) throw error;
          writeLog('retry', { error_class: decision.errorClass, retry_delay_ms: delay });
          await sleep(delay, signal);
          continue;
        }
        errorClass = decision.errorClass;
        if (signal?.aborted) throw abortError(signal);
        if (!safeRead || !decision.retryable || attempt >= limit) return result;
        const delay = delayFor(result, attempt);
        if (delay === null) return result;
        writeLog('retry', { error_class: decision.errorClass, retry_delay_ms: delay });
        await sleep(delay, signal);
      }
      throw new Error('Read retry limit reached.');
    } catch (error) {
      errorClass = signal?.aborted ? 'cancelled' : classifyReadFailure(error).errorClass;
      throw error;
    } finally {
      inflight -= 1;
      writeLog('finish', { ok, error_class: ok ? null : errorClass });
    }
  }
  return { call };
}
