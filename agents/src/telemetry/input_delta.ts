// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span, SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ChatContext, type ChatItem, chatItemFingerprint } from '../llm/chat_context.js';
import {
  type ChatMessagePayload,
  type MessagePart,
  conversationMessages,
  instructionParts,
  messageLayout,
  splitInstructions,
} from './gen_ai.js';
import * as traceTypes from './trace_types.js';

/** Where an LLM input is recorded, which determines what its record counts. */
export interface InputDeltaSite {
  name: 'llm_node' | 'llm_request';
  chatCtx: boolean;
}

export const LLM_NODE: InputDeltaSite = { name: 'llm_node', chatCtx: true };
export const LLM_REQUEST: InputDeltaSite = { name: 'llm_request', chatCtx: false };

type Placement = 'new' | 'merged' | 'skipped';

interface InputBaseline {
  keys: Array<[string, string]>;
  layout: Placement[];
  instructions: string;
  spanContext: SpanContext;
}

/** The portion of an LLM input a span records. The model still receives the full input. */
export class InputDelta {
  constructor(
    public readonly chatCtx: ChatContext,
    public readonly instructions: ChatItem[],
    public readonly conversation: ChatItem[],
    public readonly base?: SpanContext,
    public readonly droppedFromBase?: number,
  ) {}

  static full(chatCtx: ChatContext): InputDelta {
    const items = Array.isArray(chatCtx?.items) ? chatCtx.items : [];
    const [instructions, conversation] = splitInstructions(items);
    return new InputDelta(chatCtx, instructions, conversation);
  }

  systemInstructions(): MessagePart[] {
    return instructionParts(this.instructions);
  }

  inputMessages(): ChatMessagePayload[] {
    return conversationMessages(this.conversation);
  }
}

/** Per-activity baselines from the last committed generation. */
export class InputDeltaTracker {
  constructor() {
    trackerBaselines.set(this, new Map());
  }

  begin(): InputDeltaScope {
    return new InputDeltaScope(this);
  }
}

const trackerBaselines = new WeakMap<InputDeltaTracker, Map<InputDeltaSite, InputBaseline>>();

/** One generation's pending input records, promoted only when that generation commits. */
export class InputDeltaScope {
  private readonly pending = new Map<InputDeltaSite, InputBaseline>();
  #committed = false;

  constructor(private readonly tracker: InputDeltaTracker) {}

  commit(): void {
    this.#committed = true;
    const baselines = trackerBaselines.get(this.tracker)!;
    for (const [site, baseline] of this.pending) baselines.set(site, baseline);
  }

  delta(site: InputDeltaSite, chatCtx: ChatContext, span: Span): InputDelta {
    const full = InputDelta.full(chatCtx);
    const records = site.chatCtx ? [...chatCtx.items] : full.conversation;
    const current: InputBaseline = {
      keys: records.map((item) => [item.id, chatItemFingerprint(item)]),
      layout: messageLayout(records),
      instructions: JSON.stringify(full.systemInstructions()),
      spanContext: span.spanContext(),
    };
    const baselines = trackerBaselines.get(this.tracker)!;
    const parent = baselines.get(site);

    if (span.isRecording()) {
      this.pending.set(site, current);
      if (this.#committed) baselines.set(site, current);
    }

    if (!parent) return full;
    const shared = sharedPrefix(current, parent, !site.chatCtx);
    if (site.chatCtx) {
      if (shared === 0) return full;
      return new InputDelta(
        new ChatContext(records.slice(shared)),
        full.instructions,
        full.conversation,
        parent.spanContext,
        parent.keys.length - shared,
      );
    }

    const sameInstructions = current.instructions === parent.instructions;
    if (shared === 0 && !sameInstructions) return full;
    return new InputDelta(
      chatCtx,
      sameInstructions ? [] : full.instructions,
      records.slice(shared),
      parent.spanContext,
      parent.layout.slice(shared).filter((placement) => placement === 'new').length,
    );
  }
}

function sharedPrefix(
  current: InputBaseline,
  parent: InputBaseline,
  genAIMessages: boolean,
): number {
  let count = 0;
  while (
    count < current.keys.length &&
    count < parent.keys.length &&
    current.keys[count]![0] === parent.keys[count]![0] &&
    current.keys[count]![1] === parent.keys[count]![1]
  ) {
    count++;
  }
  if (genAIMessages) {
    while (
      count > 0 &&
      (insideMessage(current.layout, count) || insideMessage(parent.layout, count))
    ) {
      count--;
    }
  }
  return count;
}

function insideMessage(layout: Placement[], index: number): boolean {
  while (index < layout.length && layout[index] === 'skipped') index++;
  return index < layout.length && layout[index] === 'merged';
}

const scopeStorage = new AsyncLocalStorage<InputDeltaScope>();

/** Run generation construction with the scope inherited by its asynchronous inference tasks. */
export function runWithScope<T>(scope: InputDeltaScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

export function active(): boolean {
  return scopeStorage.getStore() !== undefined;
}

/** Compute the span's record without changing the model input. */
export function compute(site: InputDeltaSite, chatCtx: ChatContext, span: Span): InputDelta {
  return scopeStorage.getStore()?.delta(site, chatCtx, span) ?? InputDelta.full(chatCtx);
}

/** Point a delta span at the committed parent whose record it continues. */
export function setAttributes(span: Span, delta: InputDelta): void {
  if (!delta.base || !span.isRecording()) return;
  span.setAttributes({
    [traceTypes.ATTR_INPUT_DELTA]: true,
    [traceTypes.ATTR_INPUT_BASE_SPAN_ID]: delta.base.spanId,
    [traceTypes.ATTR_INPUT_DROPPED_FROM_BASE]: delta.droppedFromBase ?? 0,
  });
  span.addLink({ context: delta.base });
}
