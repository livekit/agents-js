// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import type * as r from '@rimelabs/sdk';
import { SerialQueue } from './streams.js';

export class HistoryUpdateError extends llm.RealtimeError {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
  }
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
              retryable: false,
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
  private revision = 0;
  private failure?: HistoryUpdateError;
  private edits = new SerialQueue();

  constructor(private readonly sdk: r.RealtimeSession) {}

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
      const evict = [...this.calls.keys()].find((key) => completed.has(key));
      if (!evict) throw new HistoryUpdateError('Too many pending Prism tool calls');
      this.calls.delete(evict);
    }
    const item = new llm.FunctionCall({
      id: payload.itemId,
      callId: payload.call.callId,
      name: payload.name,
      args: JSON.stringify(payload.arguments),
    });
    this.calls.set(item.callId, { ref: payload.call, item });
    this.chat.items.push(item);
    return clone(item) as llm.FunctionCall;
  }
  recordAssistant(id: string, text: string): void {
    this.upsert(new llm.ChatMessage({ id, role: 'assistant', content: text }));
  }
  private upsert(item: Item): void {
    const index = this.chat.indexById(item.id);
    if (index === undefined) this.chat.items.push(item);
    else this.chat.items[index] = item;
  }
  observe(payload: r.SessionEvent['payload'], turnStartedAt?: number): void {
    switch (payload.kind) {
      case 'response.started':
        this.revision++;
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
    }
  }
  sync(ctx: llm.ChatContext): Promise<{ ref: r.ToolCallRef; output: llm.FunctionCallOutput }[]> {
    // Copy at the public call boundary, before waiting for another update.
    const desired = items(ctx).map((item) => {
      wire(item, false);
      return clone(item);
    });
    return this.edits.run(async () => {
      if (this.failure) throw this.failure;
      try {
        return await this.apply(desired);
      } catch (error) {
        if (error instanceof HistoryUpdateError && error.partial) this.failure = error;
        throw error;
      }
    });
  }

  private async apply(
    desired: Item[],
  ): Promise<{ ref: r.ToolCallRef; output: llm.FunctionCallOutput }[]> {
    const revision = this.revision;
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
    const pending = new Set([...this.calls.keys()].filter((key) => !completed.has(key)));
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
      if (
        !results.has(id) &&
        !(pending.has(id) && this.calls.get(id)?.item.id === item.id && unchanged.has(item.id))
      )
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
    const rebuild = !appendOnly && !deleteOnly;
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
      } else if (callItems.get(item.callId)?.extra.__livekit_agents_tool_non_blocking) {
        throw new HistoryUpdateError('Prism does not support tool progress updates');
      }
    }
    const deletions = rebuild ? old : removed;
    if (deletions.length) {
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
    let committed = false;
    const submitted: { ref: r.ToolCallRef; output: llm.FunctionCallOutput }[] = [];
    const checkRevision = () => {
      if (rebuild && revision !== this.revision)
        throw new HistoryUpdateError('A reply started during history replacement');
    };
    try {
      const deletedCalls = new Set<string>();
      for (const item of deletions) {
        if (item.type !== 'message') {
          if (deletedCalls.has(item.callId)) continue;
          deletedCalls.add(item.callId);
        }
        checkRevision();
        if ([...this.active.values()].some((ids) => ids.has(this.ids.get(item.id)!))) {
          throw new HistoryUpdateError('A reply started using history scheduled for deletion');
        }
        await this.sdk.deleteItem(this.ids.get(item.id)!);
        committed = true;
        checkRevision();
      }
      for (const item of toCreate) {
        checkRevision();
        if (!rebuild && item.type === 'function_call_output' && this.calls.has(item.callId)) {
          const ref = this.calls.get(item.callId)!.ref;
          const output = wire(item) as Extract<r.HistoryItem, { type: 'function_call_output' }>;
          await this.sdk.submitToolResult(ref, output.output);
          submitted.push({ ref, output: item });
        } else {
          const ref = await this.sdk.createItem(wire(item));
          this.ids.set(item.id, ref.itemId);
        }
        committed = true;
        checkRevision();
      }
    } catch (error) {
      if (committed)
        throw new HistoryUpdateError(
          'Prism history update partially applied; restart required',
          true,
        );
      throw error;
    }
    const arrived = items(this.chat).filter(
      (item) => !oldById.has(item.id) && !newById.has(item.id),
    );
    const current = new Map(items(this.chat).map((item) => [item.id, item]));
    this.chat.items = desired
      .map((item) => (unchanged.has(item.id) ? current.get(item.id)! : clone(item)))
      .concat(arrived);
    for (const item of deletions) if (item.type === 'function_call') this.calls.delete(item.callId);
    for (const item of removed) this.ids.delete(item.id);
    return submitted;
  }
}
