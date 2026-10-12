const array = value => Array.isArray(value) ? value : [];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const terminal = status => ['completed', 'failed', 'interrupted'].includes(status);
const turnId = turn => nonempty(turn?.turnId) ? turn.turnId : null;

function millis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function mergeTurns(older, newer) {
  const items = array(older.items).slice();
  const byId = new Map(items.flatMap((item, index) => nonempty(item?.id) ? [[item.id, index]] : []));
  for (const item of array(newer.items)) {
    const index = nonempty(item?.id) ? byId.get(item.id) : undefined;
    if (index === undefined) {
      if (nonempty(item?.id)) byId.set(item.id, items.length);
      items.push(item);
    } else items[index] = { ...items[index], ...item };
  }
  // A stale live placeholder must not undo a completed canonical turn.
  const preserveTerminal = terminal(older.status) && newer.status === 'inProgress';
  return {
    ...older, ...newer,
    params: { ...older.params, ...newer.params },
    status: preserveTerminal ? older.status : newer.status ?? older.status,
    error: preserveTerminal ? older.error : newer.error ?? older.error ?? null,
    items,
    completedItemIds: { ...older.completedItemIds, ...newer.completedItemIds },
    turnStartedAtMs: older.turnStartedAtMs ?? newer.turnStartedAtMs,
    durationMs: newer.durationMs ?? older.durationMs,
  };
}

/** Flatten canonical history in display order and retain live, noncanonical turns. */
export function conversationTurns(state) {
  if (!object(state)) return [];
  const result = [];
  const byId = new Map();
  const add = turn => {
    if (!object(turn)) return;
    const id = turnId(turn);
    const index = id === null ? undefined : byId.get(id);
    if (index === undefined) {
      if (id !== null) byId.set(id, result.length);
      result.push(turn);
    } else result[index] = mergeTurns(result[index], turn);
  };
  if (state.turnHistory?.kind === 'canonical') {
    const history = state.turnHistory.history;
    for (const island of array(history?.islands)) {
      for (const entry of array(island?.entries)) {
        if (nonempty(entry?.value) && Object.hasOwn(history?.entitiesByKey ?? {}, entry.value)) {
          add(history.entitiesByKey[entry.value]);
        }
      }
    }
  }
  for (const turn of array(state.turns)) add(turn);
  return result;
}

/** Find a confirmed turn; text similarity and pending steering are not receipts. */
export function findCorrelatedTurn(state, { turn_id, client_user_message_id } = {}) {
  const turns = conversationTurns(state).filter(turn => turnId(turn) !== null);
  if (nonempty(turn_id)) {
    const direct = turns.find(turn => turn.turnId === turn_id);
    if (direct) return direct;
  }
  if (!nonempty(client_user_message_id)) return null;
  for (const turn of turns) {
    if (turn.params?.clientUserMessageId === client_user_message_id) return turn;
    for (const item of array(turn.items)) {
      if (item?.type === 'userMessage' && item.clientId === client_user_message_id) return turn;
      if (item?.type !== 'steeringUserMessage' || item.status !== 'accepted' ||
          item.clientUserMessageId !== client_user_message_id) continue;
      if (nonempty(item.targetTurnId)) {
        const target = turns.find(turn => turn.turnId === item.targetTurnId);
        if (target) return target;
        continue;
      }
      return turn;
    }
  }
  return null;
}

const toolTypes = new Set([
  'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
  'commandExecution', 'fileChange', 'imageGeneration', 'webSearch', 'sleep',
]);
const approvalMethods = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval',
]);
const userInputMethods = new Set([
  'item/tool/requestUserInput', 'item/tool/requestOptionPicker', 'mcpServer/elicitation/request',
]);

function summarizeError(error) {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return { message: error };
  if (!object(error)) return { message: 'Work turn failed.' };
  return Object.fromEntries(['message', 'code', 'codexErrorInfo', 'additionalDetails']
    .filter(key => Object.hasOwn(error, key)).map(key => [key, error[key]]));
}

/** Execution metadata only: requests are not evidence of effective settings. */
export function effectiveTurnSettings(turn) {
  const value = setting => typeof setting === 'string' && setting.trim() ? setting : null;
  const reroute = array(turn?.items).findLast(item => item?.type === 'modelRerouted' && value(item.toModel) !== null);
  const settings = turn?.params?.collaborationMode?.settings;
  return {
    effective_model: value(reroute?.toModel) ?? value(settings?.model) ?? value(turn?.params?.model),
    effective_reasoning_effort: value(settings?.reasoning_effort) ?? value(turn?.params?.effort) ?? value(turn?.params?.reasoningEffort),
    ...(reroute ? { model_reroute: {
      from_model: value(reroute.fromModel), to_model: value(reroute.toModel), reason: value(reroute.reason),
    } } : {}),
  };
}

/** Return task-relevant output, without reasoning, arguments or tool response bodies. */
export function summarizeTurn(turn, runtime = null, requests = []) {
  const items = array(turn?.items);
  const messages = items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string');
  const finals = messages.filter(item => item.phase === 'final_answer');
  const legacy = messages.filter(item => item.phase === null || item.phase === undefined);
  const finalText = (finals.length ? finals : legacy).map(item => item.text).join('\n\n');
  const active = turn?.status === 'inProgress' || (!turn && runtime?.type === 'active');
  const flags = active ? array(runtime?.activeFlags) : [];
  const pending = active ? array(requests).filter(request => object(request) && request.completed !== true &&
    request.completedAtMs == null && (!nonempty(request.params?.turnId) || request.params.turnId === turnId(turn))) : [];
  const changedFiles = new Set();
  for (const item of items) {
    if (item?.type !== 'fileChange' || !(item.status === 'completed' || item.status == null && turn?.completedItemIds?.[item.id] === true)) continue;
    for (const change of array(item.changes)) {
      if (nonempty(change?.path)) changedFiles.add(change.path);
      if (nonempty(change?.kind?.movePath)) changedFiles.add(change.kind.movePath);
    }
  }
  return {
    turn_id: turnId(turn),
    status: turn?.status === 'inProgress' ? 'running' : turn?.status ?? (active ? 'running' : 'unknown'),
    final_text: finalText,
    tool_calls: items.filter(item => toolTypes.has(item?.type)).map(item => ({
      type: item.type,
      name: nonempty(item.tool) ? item.tool : item.type,
      status: item.status ?? (turn?.completedItemIds?.[item.id] === true ? 'completed' : null),
    })),
    changed_files: [...changedFiles],
    error: summarizeError(turn?.error),
    started_at_ms: millis(turn?.turnStartedAtMs),
    duration_ms: millis(turn?.durationMs),
    awaiting_approval: flags.includes('waitingOnApproval') || pending.some(request => approvalMethods.has(request.method)),
    awaiting_user_input: flags.includes('waitingOnUserInput') || pending.some(request => userInputMethods.has(request.method)) ||
      (active && items.some(item => item?.type === 'userInputResponse' && item.completed === false)),
  };
}

/** Completed compactions only. Callers compare IDs against a pre-request baseline. */
export function completedCompactions(state) {
  const result = [];
  const ids = new Set();
  for (const turn of conversationTurns(state)) {
    for (const item of array(turn.items)) {
      if (item?.type !== 'contextCompaction' || item.completed !== true || !nonempty(item.id) ||
          item.id === 'pending-manual-context-compaction' || ids.has(item.id)) continue;
      ids.add(item.id);
      const turnStarted = millis(turn.turnStartedAtMs);
      const started = millis(item.startedAtMs) ?? turnStarted;
      const duration = millis(turn.durationMs);
      const finished = millis(item.completedAtMs) ??
        (turn.status === 'completed' && turnStarted !== null && duration !== null ? turnStarted + duration : null);
      result.push({
        id: item.id, turn_id: turnId(turn), completed: true,
        source: typeof item.source === 'string' ? item.source : null,
        started_at_ms: started, completed_at_ms: finished,
      });
    }
  }
  return result;
}
