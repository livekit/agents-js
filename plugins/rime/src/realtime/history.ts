// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import type * as r from '@rimelabs/sdk';
import { SerialQueue } from './streams.js';

/** A confirmed refusal or an uncertain provider write. This stops rejected typed-input replies. */
export class PrismHistoryUpdateError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  needsReconciliation = true;
  constructor(
    message: string,
    readonly status: 'rejected' | 'partial' | 'uncertain' = 'rejected',
    readonly confirmedChatCtx: llm.ChatContext | null = null,
  ) {
    super(message);
    this.name = 'PrismHistoryUpdateError';
    this.code = 'history_update_' + status;
    this.recoverable = status !== 'uncertain';
  }
}
export { PrismHistoryUpdateError as HistoryUpdateError };
const HistoryUpdateError = PrismHistoryUpdateError;
interface SyncResult {
  submitted: { ref: r.ToolCallRef; output: llm.FunctionCallOutput }[];
  failure?: PrismHistoryUpdateError;
  committed: boolean;
  created: Set<string>;
  historyRead: boolean;
}

type Item = llm.ChatMessage | llm.FunctionCall | llm.FunctionCallOutput;

function items(ctx: llm.ChatContext): Item[] {
  return ctx.copy({ excludeHandoff: true, excludeConfigUpdate: true }).items as Item[];
}

function clone(item: Item): Item {
  switch (item.type) {
    case 'message':
      return new llm.ChatMessage(structuredClone(item));
    case 'function_call':
      return new llm.FunctionCall(structuredClone(item));
    case 'function_call_output':
      return new llm.FunctionCallOutput(structuredClone(item));
  }
}

function wire(item: Item, validateText = true): r.HistoryItem {
  let result: r.HistoryItem;
  switch (item.type) {
    case 'message': {
      if (
        (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') ||
        item.content.some((part) => typeof part !== 'string')
      ) {
        throw new HistoryUpdateError('Prism history requires user, assistant, or system text');
      }
      const text = item.textContent ?? '';
      if (validateText && [...text].length > 4000)
        throw new HistoryUpdateError('Prism history text exceeds 4000 characters');
      result = { type: 'message', role: item.role, text };
      break;
    }
    case 'function_call':
      if (!item.callId || !item.name)
        throw new HistoryUpdateError('Tool calls require a call ID and name');
      result = { type: item.type, callId: item.callId, name: item.name, arguments: item.args };
      break;
    case 'function_call_output':
      if (!item.callId) throw new HistoryUpdateError('Tool results require a call ID');
      result = {
        type: item.type,
        callId: item.callId,
        output: item.isError
          ? JSON.stringify({
              status: 'failed',
              reason: 'tool_error',
              message: item.output,
              result: null,
            })
          : item.output,
      };
      break;
    default:
      throw new HistoryUpdateError('Unsupported Prism history item');
  }
  if (
    Object.values(result).some(
      (value) => typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value),
    )
  ) {
    throw new HistoryUpdateError('Prism history fields must be valid UTF-8 strings');
  }
  return result;
}

/** Owns acknowledged identities and live tool references; observations never wait on edits. */
export class PrismHistory {
  private chat = llm.ChatContext.empty();
  private ids = new Map<string, string>();
  private calls = new Map<string, { ref: r.ToolCallRef; item: llm.FunctionCall }>();
  private active = new Map<string, Set<string>>();
  private responseRevision = 0;
  revision = 0;
  private failure?: PrismHistoryUpdateError;
  private variants = new Map<string, Set<string>>();
  private played = new Map<string, string>();
  private holds = new Map<string, r.ResponseHold>();
  private edits = new SerialQueue();

  constructor(
    private readonly sdk: r.RealtimeSession,
    private readonly isEventRefusal: (error: unknown) => boolean,
  ) {}

  get chatCtx(): llm.ChatContext {
    return new llm.ChatContext(items(this.chat).map(clone));
  }
  getHistory(): Promise<readonly r.HistoryItem[]> {
    return this.edits.run(() => this.sdk.getHistory());
  }
  async waitForUpdates(): Promise<void> {
    await this.edits.idle();
    if (this.failure) throw this.failure;
  }
  projection(local: llm.ChatContext): llm.ChatContext {
    const ctx = this.chatCtx;
    for (const item of ctx.items)
      if (item.type === 'message' && this.played.has(item.id))
        item.content = [this.played.get(item.id)!];
    ctx.items.push(
      ...local.items.filter((i) => i.type === 'agent_handoff' || i.type === 'agent_config_update'),
    );
    return ctx;
  }
  releaseResponse(responseId: string): void {
    this.holds.get(responseId)?.release();
    this.holds.delete(responseId);
  }
  close(): void {
    for (const id of this.holds.keys()) this.releaseResponse(id);
  }
  lastCall(response: r.ResponseRef): r.ToolCallRef | undefined {
    return [...this.calls.values()]
      .reverse()
      .find((call) => call.ref.responseId === response.responseId)?.ref;
  }
  hasPendingCalls(response: r.ResponseRef): boolean {
    const completed = new Set(
      this.chat.items
        .filter((item) => item.type === 'function_call_output')
        .map((item) => item.callId),
    );
    return [...this.calls.values()].some(
      ({ ref }) => ref.responseId === response.responseId && !completed.has(ref.callId),
    );
  }
  recordToolCall(payload: r.ToolCall): llm.FunctionCall {
    if (this.calls.has(payload.call.callId))
      throw new HistoryUpdateError('Duplicate Prism tool call');
    if (this.calls.size >= 1024) {
      const completed = new Set(
        this.chat.items
          .filter((item) => item.type === 'function_call_output')
          .map((item) => item.callId),
      );
      const evict = [...this.calls.keys()].find(
        (key) => completed.has(key) && !this.holds.has(this.calls.get(key)!.ref.responseId),
      );
      if (!evict) throw new HistoryUpdateError('Too many pending Prism tool calls');
      this.calls.delete(evict);
    }
    const item = new llm.FunctionCall({
      id: payload.itemId,
      callId: payload.call.callId,
      name: payload.name,
      args: JSON.stringify(payload.arguments),
    });
    if (!this.holds.has(payload.call.responseId))
      this.holds.set(payload.call.responseId, this.sdk.holdResponse(payload.call));
    this.calls.set(item.callId, { ref: payload.call, item });
    this.chat.items.push(item);
    this.revision++;
    return clone(item) as llm.FunctionCall;
  }
  recordAssistant(id: string, text: string, played = false): void {
    this.revision++;
    const variants = this.variants.get(id) ?? new Set<string>();
    variants.add(text);
    this.variants.set(id, variants);
    if (played) {
      this.played.set(id, text);
      return;
    }
    this.upsert(new llm.ChatMessage({ id, role: 'assistant', content: text }));
  }
  private upsert(item: Item): void {
    this.revision++;
    const index = this.chat.indexById(item.id);
    if (index === undefined) this.chat.items.push(item);
    else this.chat.items[index] = item;
  }
  observe(payload: r.SessionEvent['payload'], turnStartedAt?: number): void {
    switch (payload.kind) {
      case 'response.started':
        this.responseRevision++;
        this.active.set(
          payload.response.responseId,
          new Set([...payload.inputItemIds, ...(payload.inputItemId ? [payload.inputItemId] : [])]),
        );
        break;
      case 'input.committed':
      case 'transcript.final':
        this.ids.set(payload.itemId, payload.itemId);
        if (payload.kind === 'transcript.final' || !this.chat.getById(payload.itemId)) {
          this.upsert(
            new llm.ChatMessage({
              id: payload.itemId,
              role: 'user',
              content: payload.kind === 'transcript.final' ? payload.text : '',
              createdAt: turnStartedAt,
            }),
          );
        }
        break;
      case 'message.started':
        this.ids.set(payload.output.itemId, payload.output.itemId);
        this.active.get(payload.output.response.responseId)?.add(payload.output.itemId);
        break;
      case 'tool.call':
        this.ids.set(payload.itemId, payload.itemId);
        this.active.get(payload.call.responseId)?.add(payload.itemId);
        break;
      case 'response.ended':
        this.active.delete(payload.response.responseId);
        break;
      case 'item.truncated':
        if (payload.keptText === null || payload.contentIndex !== 0) break;
        // Late acknowledgments must not restore deleted items or change their replacements.
        for (const [localId, serverId] of this.ids) {
          if (serverId !== payload.itemId) continue;
          const item = this.chat.getById(localId);
          if (item?.type === 'message' && item.role === 'assistant') {
            const variants = this.variants.get(localId) ?? new Set<string>();
            variants.add(item.textContent ?? '');
            variants.add(payload.keptText);
            this.variants.set(localId, variants);
            item.content = [payload.keptText];
            this.revision++;
          }
          break;
        }
        break;
    }
  }
  /** Normalize only unchanged progress results within acknowledged, generated history. */
  private progressTarget(target: Item[]): Item[] {
    const requested = new Map(target.map((item) => [item.id, item]));
    if (requested.size !== target.length) return target;
    const old = new Map(items(this.chat).map((item) => [item.id, item]));
    const positions = new Map(target.map((item, index) => [item.id, index]));
    const equal = (a: Item, b: Item) =>
      JSON.stringify(wire(a, false)) === JSON.stringify(wire(b, false));
    const calls = new Map(
      target.flatMap((item) =>
        item.type === 'function_call' &&
        item.extra.__livekit_agents_tool_non_blocking &&
        old.has(item.id) &&
        equal(item, old.get(item.id)!)
          ? [[item.callId, item] as const]
          : [],
      ),
    );
    const eligible = new Set([...calls.values()].map((item) => item.id));
    const results = new Set<string>();
    for (const item of target) {
      const previous = old.get(item.id);
      if (!previous) continue;
      if (item.type === 'function_call_output') {
        const call = calls.get(item.callId);
        if (call && positions.get(call.id)! < positions.get(item.id)! && equal(item, previous)) {
          eligible.add(item.id);
          results.add(item.id);
        }
      } else if (
        item.type === 'message' &&
        previous.type === 'message' &&
        item.role === 'assistant' &&
        previous.role === 'assistant' &&
        item.content.every((part) => typeof part === 'string') &&
        this.variants.get(item.id)?.has(item.textContent ?? '')
      )
        eligible.add(item.id);
    }
    const blocks = new Map<string, number>();
    const acknowledged = new Map(this.chat.items.map((item, index) => [item.id, index]));
    let block = 0;
    for (const item of this.chat.items) {
      if (eligible.has(item.id)) blocks.set(item.id, block);
      else block++;
    }
    const normalized = [...target];
    for (let start = 0; start < normalized.length; ) {
      const group = blocks.get(normalized[start]!.id);
      let end = start + 1;
      if (group !== undefined) {
        while (end < normalized.length && blocks.get(normalized[end]!.id) === group) end++;
        const current = normalized.slice(start, end);
        const ordered = [...current].sort(
          (a, b) => acknowledged.get(a.id)! - acknowledged.get(b.id)!,
        );
        const fixed = (values: Item[]) =>
          values.filter((item) => !results.has(item.id)).map((item) => item.id);
        if (JSON.stringify(fixed(current)) === JSON.stringify(fixed(ordered)))
          normalized.splice(start, end - start, ...ordered);
      }
      start = end;
    }
    return this.includeLateProgressMessages(normalized);
  }
  /** A stale progress-only append must not delete output observed after its capture. */
  private includeLateProgressMessages(target: Item[]): Item[] {
    const old = new Set(this.chat.items.map((item) => item.id));
    const added = target.filter((item) => !old.has(item.id));
    if (
      !added.length ||
      added.length % 2 ||
      target.slice(-added.length).some((item, index) => item !== added[index])
    )
      return target;
    for (let index = 0; index < added.length; index += 2) {
      const call = added[index]!,
        output = added[index + 1]!;
      if (
        call.type !== 'function_call' ||
        !call.extra.__livekit_agents_tool_non_blocking ||
        output.type !== 'function_call_output' ||
        call.callId !== output.callId
      )
        return target;
    }
    const requested = new Map(target.map((item) => [item.id, item]));
    const missing = this.chat.items.filter((item) => !requested.has(item.id));
    const capturedAt = Math.max(...added.map((item) => item.createdAt));
    if (
      !missing.length ||
      missing.some(
        (item) =>
          item.type !== 'message' ||
          item.role !== 'assistant' ||
          !this.variants.has(item.id) ||
          item.createdAt <= capturedAt,
      )
    )
      return target;
    const retained = this.chat.items.filter((item) => requested.has(item.id));
    if (target.slice(0, -added.length).some((item, index) => item.id !== retained[index]?.id))
      return target;
    return [...items(this.chat).map((item) => requested.get(item.id) ?? item), ...added];
  }
  private sharedTarget(target: Item[]): Item[] {
    const old = new Map(items(this.chat).map((item, index) => [item.id, { item, index }]));
    const additions: Item[] = [],
      seen = new Set<string>();
    let last = -1;
    for (const item of target) {
      if (seen.has(item.id)) throw new HistoryUpdateError('Prism history item IDs must be unique');
      seen.add(item.id);
      const previous = old.get(item.id);
      if (!previous) {
        additions.push(item);
        continue;
      }
      if (additions.length || previous.index < last)
        throw new HistoryUpdateError(
          'Shared history requires append order; use strict context mode',
        );
      last = previous.index;
      if (JSON.stringify(wire(previous.item, false)) === JSON.stringify(wire(item, false)))
        continue;
      if (
        item.type === 'message' &&
        previous.item.type === 'message' &&
        item.role === previous.item.role &&
        item.content.every((p) => typeof p === 'string') &&
        this.variants.get(item.id)?.has(item.textContent ?? '')
      )
        continue;
      throw new HistoryUpdateError(
        'Shared history conflicts with confirmed content; use strict context mode',
      );
    }
    return [...items(this.chat), ...additions];
  }
  sync(ctx: llm.ChatContext, shared = false): Promise<SyncResult> {
    const target = items(ctx).map(clone);
    return this.edits.run(async () => {
      const result: SyncResult = {
        submitted: [],
        committed: false,
        created: new Set(),
        historyRead: false,
      };
      const baseline = new Set(this.chat.items.map((i) => i.id));
      let failure: unknown;
      try {
        if (this.failure) throw this.failure;
        const progress = this.progressTarget(target);
        await this.apply(shared ? this.sharedTarget(progress) : progress, result);
      } catch (error) {
        failure = error;
      }
      let known =
        !failure ||
        (failure instanceof HistoryUpdateError && failure.recoverable) ||
        this.isEventRefusal(failure);
      const arrived = this.chat.items.some((i) => !baseline.has(i.id) && !result.created.has(i.id));
      if (known && result.created.size && arrived) {
        try {
          await this.repairOrder(baseline, result);
        } catch {
          known = false;
          failure = new HistoryUpdateError('Prism history order is uncertain', 'uncertain');
        }
      }
      if (failure) {
        const status = known ? (result.committed ? 'partial' : 'rejected') : 'uncertain';
        result.failure = new HistoryUpdateError(
          failure instanceof HistoryUpdateError
            ? failure.message
            : 'Prism history update ' + status,
          status,
          known ? this.projection(llm.ChatContext.empty()) : null,
        );
        if (!known) this.failure = result.failure;
      }
      return result;
    });
  }
  private async repairOrder(baseline: Set<string>, result: SyncResult): Promise<void> {
    if (result.historyRead)
      throw new HistoryUpdateError('History order cannot be confirmed', 'uncertain');
    result.historyRead = true;
    const snapshot = await this.sdk.getHistory();
    for (const item of this.chat.items) {
      if (item.type === 'function_call_output' && !this.ids.has(item.id)) {
        const found = snapshot.find(
          (i) => i.type === 'function_call_output' && i.callId === item.callId,
        );
        if (found?.id) this.ids.set(item.id, found.id);
      }
    }
    const local = new Map(this.chat.items.map((i) => [this.ids.get(i.id), i]));
    const ordered = snapshot.flatMap((i) => (i.id && local.has(i.id) ? [local.get(i.id)!] : []));
    const covered = new Set(ordered.map((i) => i.id));
    if (this.chat.items.some((i) => !baseline.has(i.id) && !covered.has(i.id)))
      throw new HistoryUpdateError('Concurrent history order cannot be confirmed', 'uncertain');
    let index = 0;
    this.chat.items = this.chat.items.map((i) => (covered.has(i.id) ? ordered[index++]! : i));
    this.revision++;
  }
  private async apply(desired: Item[], result: SyncResult): Promise<void> {
    const revision = this.responseRevision;
    const old = items(this.chat);
    const oldById = new Map(old.map((item) => [item.id, item]));
    const newById = new Map(desired.map((item) => [item.id, item]));
    const unchanged = new Set(
      desired
        .filter(
          (item) =>
            oldById.has(item.id) &&
            JSON.stringify(wire(oldById.get(item.id)!, false)) ===
              JSON.stringify(wire(item, false)),
        )
        .map((item) => item.id),
    );
    const completed = new Set(
      old.filter((item) => item.type === 'function_call_output').map((item) => item.callId),
    );
    const pending = new Set(
      old
        .filter((item) => item.type === 'function_call' && !completed.has(item.callId))
        .map((item) => (item as llm.FunctionCall).callId),
    );
    if (desired.length !== newById.size)
      throw new HistoryUpdateError('Prism history item IDs must be unique');
    const callItems = new Map<string, llm.FunctionCall>();
    const results = new Set<string>();
    for (const item of desired) {
      wire(item, !unchanged.has(item.id));
      if (item.type === 'function_call') {
        if (callItems.has(item.callId))
          throw new HistoryUpdateError('Prism call IDs must be unique');
        callItems.set(item.callId, item);
      }
      if (item.type === 'function_call_output') {
        if (!callItems.has(item.callId) || results.has(item.callId))
          throw new HistoryUpdateError('A tool result must follow its call exactly once');
        results.add(item.callId);
      }
    }
    for (const [id, item] of callItems) {
      if (!results.has(id) && !(pending.has(id) && oldById.has(item.id) && unchanged.has(item.id)))
        throw new HistoryUpdateError('Imported tool calls require completed results');
    }
    const removed = old.filter((item) => !newById.has(item.id));
    const added = desired.filter((item) => !oldById.has(item.id));
    const appendOnly =
      !removed.length &&
      unchanged.size === old.length &&
      old.every((item, index) => desired[index]?.id === item.id);
    const retained = old.filter((item) => newById.has(item.id));
    const desiredRetained = desired.filter((item) => oldById.has(item.id));
    const deleteOnly =
      !added.length &&
      unchanged.size === desired.length &&
      retained.every((item, index) => desiredRetained[index]?.id === item.id);
    const insertResults =
      !removed.length &&
      unchanged.size === old.length &&
      retained.every((item, index) => desiredRetained[index]?.id === item.id) &&
      added.every(
        (i) =>
          i.type === 'function_call_output' && pending.has(i.callId) && !this.calls.has(i.callId),
      );
    const rebuild = !appendOnly && !insertResults && !deleteOnly;
    if (rebuild && (this.active.size || pending.size))
      throw new HistoryUpdateError('Finish active replies and tools before replacing history');
    const protectedIds = new Set([...this.active.values()].flatMap((ids) => [...ids]));
    for (const item of removed) {
      if (
        (item.type === 'function_call' && pending.has(item.callId)) ||
        protectedIds.has(this.ids.get(item.id) ?? item.id)
      )
        throw new HistoryUpdateError('Cannot remove active response history');
    }
    const toCreate = rebuild ? desired : added;
    for (const item of toCreate) {
      wire(item);
      if (item.type !== 'function_call_output') continue;
      if (rebuild || !this.calls.has(item.callId)) {
        const previous = desired[desired.indexOf(item) - 1];
        if (previous?.type !== 'function_call' || previous.callId !== item.callId)
          throw new HistoryUpdateError('Imported tool results must immediately follow their calls');
      }
    }
    const deletions = rebuild ? old : removed;
    if (deletions.some((item) => !this.ids.has(item.id))) {
      result.historyRead = true;
      const snapshot = await this.sdk.getHistory();
      for (const item of deletions) {
        if (!this.ids.has(item.id) && item.type === 'function_call_output') {
          const found = snapshot.find(
            (value) => value.type === 'function_call_output' && value.callId === item.callId,
          );
          if (found?.id) this.ids.set(item.id, found.id);
        }
        if (!this.ids.has(item.id))
          throw new HistoryUpdateError('Prism has not published this history item ID');
      }
    }
    const checkRevision = () => {
      if (rebuild && revision !== this.responseRevision)
        throw new HistoryUpdateError('A reply started during history replacement');
    };
    for (const item of deletions) {
      if (!this.chat.getById(item.id)) continue;
      checkRevision();
      if ([...this.active.values()].some((ids) => ids.has(this.ids.get(item.id)!)))
        throw new HistoryUpdateError('A reply started using history scheduled for deletion');
      await this.sdk.deleteItem(this.ids.get(item.id)!);
      result.committed = true;
      const retiring = this.chat.items.filter(
        (i) =>
          i.id === item.id ||
          (item.type !== 'message' &&
            (i.type === 'function_call' || i.type === 'function_call_output') &&
            i.callId === item.callId),
      );
      const retiredIds = new Set(retiring.map((i) => i.id));
      this.chat.items = this.chat.items.filter((i) => !retiredIds.has(i.id));
      for (const retired of retiring) {
        this.ids.delete(retired.id);
        this.variants.delete(retired.id);
        this.played.delete(retired.id);
        if (retired.type === 'function_call') this.calls.delete(retired.callId);
      }
      this.revision++;
      checkRevision();
    }
    for (const item of toCreate) {
      checkRevision();
      if (!rebuild && item.type === 'function_call_output' && this.calls.has(item.callId)) {
        const ref = this.calls.get(item.callId)!.ref;
        const output = wire(item) as Extract<r.HistoryItem, { type: 'function_call_output' }>;
        await this.sdk.submitToolResult(ref, output.output);
        result.submitted.push({ ref, output: clone(item) as llm.FunctionCallOutput });
      } else {
        const ref = await this.sdk.createItem(wire(item));
        this.ids.set(item.id, ref.itemId);
      }
      result.committed = true;
      result.created.add(item.id);
      this.revision++;
      this.chat.items.splice(
        Math.min(desired.indexOf(item), this.chat.items.length),
        0,
        clone(item),
      );
      checkRevision();
    }
  }
}
