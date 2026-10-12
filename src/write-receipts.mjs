import path from 'node:path';
import { WorkStore, taskIdFor, fingerprint } from './work-store.mjs';

const receiptProperty = {
  type: 'string', minLength: 8, maxLength: 128,
  description: 'Unique write receipt key. Preserve it with identical arguments when checking/retrying a lost reply. An acknowledged duplicate returns its receipt without rewriting or appending again. Unknown delivery is never replayed.',
};

export function decorateWriteTool(tool) {
  if (tool.name !== 'write_file') return tool;
  if (tool.inputSchema?.properties?.request_id) throw new Error('Upstream write_file request_id collision.');
  return { ...tool, description: tool.description + '\nUse request_id for durable duplicate protection. Never automatically repeat unkeyed writes after a timeout; read the target first. Receipt keys do not automatically recover an uncertain write.',
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema?.properties, request_id: receiptProperty } } };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function receipt(record, duplicate) {
  return { receipt_id: record.task_id.replace(/^work_/, 'write_'), request_id: record.request_id, status: record.status, duplicate };
}
function response(record, duplicate, acknowledged = record.result) {
  const value = receipt(record, duplicate);
  if (record.status === 'outcome_unknown') return {
    isError: true, content: [{ type: 'text', text: 'The write outcome is unknown. This key will not be replayed. Read the target to verify its state before deciding any further write.' }, { type: 'text', text: JSON.stringify({ write_receipt: value }) }],
    structuredContent: { write_receipt: value },
  };
  return { ...acknowledged, content: [...(acknowledged.content ?? []), { type: 'text', text: JSON.stringify({ write_receipt: value }) }], _meta: { ...acknowledged._meta, write_receipt: value } };
}

/** Persist intent before a keyed file mutation; transport failures never replay it. */
export function createWriteReceipts(config, options = {}) {
  const directory = config.reliability.stateDirectory;
  return {
    async call(params, invoke, signal) {
      const args = params.arguments ?? {};
      if (!Object.hasOwn(args, 'request_id')) return invoke(params, signal);
      const { request_id, ...forwardedArgs } = args;
      if (typeof request_id !== 'string' || request_id.length < 8 || request_id.length > 128 || /[\x00-\x20\x7f]/.test(request_id)) throw new Error('Invalid write request_id.');
      signal?.throwIfAborted();
      const taskId = taskIdFor(request_id);
      // Separate per-key locks allow unrelated writes to proceed independently.
      const store = options.storeFor?.(taskId) ?? new WorkStore(path.join(directory, 'writes', taskId));
      const signature = fingerprint(canonical({ name: 'write_file', arguments: forwardedArgs }));
      return store.withMutationLease(async () => {
        let record = await store.get(taskId);
        signal?.throwIfAborted();
        if (record) {
          if (record.signature !== signature) throw new Error('write request_id was already used with different input.');
          return response(record, true);
        }
        record = { task_id: taskId, request_id, signature, operation: 'write_file', status: 'outcome_unknown', created_at: new Date().toISOString() };
        // Only digests and receipts are retained; no arguments or file contents.
        await store.save(record);
        signal?.throwIfAborted();
        let result;
        try { result = await invoke({ ...params, arguments: forwardedArgs }, signal); }
        catch { return response(record, false); }
        if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return response(record, false);
        record.status = result.isError ? 'failed' : 'completed';
        // The original reply is returned once, but never retained. Upstream
        // errors can reflect arguments, so durable receipts use fixed text.
        record.result = { ...(result.isError ? { isError: true } : {}), content: [{ type: 'text', text: result.isError ? 'The previous write returned a tool error. It has not been replayed. Verify the target before deciding any further write.' : 'The original write was acknowledged. This duplicate returns its receipt without repeating the write.' }] };
        record.completed_at = new Date().toISOString();
        await store.save(record);
        return response(record, false, result);
      }, { signal });
    },
  };
}
