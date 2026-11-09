// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Input deltas for LLM spans (`record: { inputDelta: true }`).
 *
 * **Purpose**
 *
 * Each LLM span records the input of the model. In a long session, the input of each turn
 * contains all of the previous turns. Thus, the spans become larger at each turn. When the session
 * records with `inputDelta`, a span records only the part of the input that changed. The model
 * always receives all of the input. This module changes only the telemetry.
 *
 * **Terms**
 *
 * - Record: the list of entries that a span records. On an `llm_node` span, the record is
 *   `lk.pii.chat_ctx`, with one entry for each chat item. On an `llm_request` span, the record is
 *   `gen_ai.input.messages`, with one entry for each GenAI message.
 * - Instructions: the instructions message of the agent. On an `llm_request` span, the
 *   instructions are in `gen_ai.system_instructions`, not in the record. All other system messages
 *   are entries of the record, at their position.
 * - Generation: one LLM inference of the agent. A turn with tool calls has more than one
 *   generation.
 * - Commit: a generation is committed when its speech is scheduled. A discarded preemptive
 *   generation is not committed.
 * - Parent: the span of the last committed generation that has the same span name.
 *
 * **Procedure**
 *
 * For each span, the tracker does these steps:
 *
 * 1. It calculates a key for each item of the record. The key is the item ID and a fingerprint of
 *    the content of the item (`chatItemFingerprint`).
 * 2. It compares the keys with the keys of the parent, in order. It finds the longest prefix that
 *    the two records share.
 * 3. The span records only the entries after this prefix.
 * 4. `lk.input.dropped_from_base` gives the number of parent entries after this prefix.
 * 5. On an `llm_request` span, the tracker compares the instructions with the instructions of the
 *    parent. If the text is the same, the span does not record `gen_ai.system_instructions`.
 * 6. If the span shares no entries and no instructions with the parent, the span records all of
 *    the input, without `lk.input.*` attributes.
 * 7. The tracker keeps the keys of the span. When the generation is committed, these keys replace
 *    the keys of the parent.
 *
 * **Rebuild**
 *
 * To make the full record of a span again:
 *
 * 1. Make the full record of the parent (`lk.input.base_span_id`). Use this procedure again if the
 *    parent also has a parent.
 * 2. Remove the last `lk.input.dropped_from_base` entries.
 * 3. Add the entries of this span.
 *
 * If an `llm_request` span with a parent has no `gen_ai.system_instructions`, use the
 * instructions of the parent.
 *
 * **Rules**
 *
 * - The comparison does not use the role of an item. A system message that stays at its position
 *   is part of the shared prefix. The framework adds the expressive guide again at the end of each
 *   reply. Thus, the old guide is in the dropped entries, and the new guide is in the recorded
 *   entries.
 * - An edited, removed or moved item stops the shared prefix at that item. The span records the
 *   entries from that item. It does not record all of the input.
 * - In `gen_ai.input.messages`, consecutive tool calls of an assistant turn are one message, also
 *   when a skipped item (for example, a config update) is between them. The prefix never stops
 *   inside such a message.
 * - On an `llm_node` span, the instructions are the first entry of `lk.pii.chat_ctx`. Thus, a
 *   change of the instructions causes a full record of `lk.pii.chat_ctx`.
 * - The fingerprint does not keep media data. Inline image data counts by a digest, a video frame
 *   by its identity, and audio by its frame count and transcript.
 * - A span that does not record its input (content capture is off) does not become a parent.
 * - Each `AgentActivity` has its own tracker. After a handoff, the first span records all of the
 *   input.
 *
 * **Example**
 *
 * In expressive mode, `G` is the expressive guide, and `I` is the instructions message.
 *
 * | Generation         | Input sent to the model    | Record of `llm_node` | Dropped |
 * | ------------------ | -------------------------- | -------------------- | ------- |
 * | Turn 1             | `[I, u1, G]`               | `[I, u1, G]` (full)  | none    |
 * | Turn 2             | `[I, u1, a1, u2, G]`       | `[a1, u2, G]`        | 1       |
 * | Turn 3, tool call  | `[I, …, u2, a2, u3, G]`    | `[a2, u3, G]`        | 1       |
 * | Turn 3, tool reply | `[I, …, u3, G, fc, fo]`    | `[fc, fo]`           | 0       |
 */
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

/** Where an LLM input is recorded, which decides what the record counts. */
export interface InputDeltaSite {
  name: 'llm_node' | 'llm_request';
  /**
   * The span records `lk.pii.chat_ctx` (every chat item, in order) rather than
   * `gen_ai.input.messages` and `gen_ai.system_instructions`.
   */
  chatCtx: boolean;
}

export const LLM_NODE: InputDeltaSite = { name: 'llm_node', chatCtx: true };
export const LLM_REQUEST: InputDeltaSite = { name: 'llm_request', chatCtx: false };

/** @internal */
export interface InputBaseline {
  /** id and content fingerprint of each item the span records, in order */
  keys: Array<[string, string]>;
  /** per item, how it lands in gen_ai.input.messages */
  layout: Array<'new' | 'merged' | 'skipped'>;
  instructions: string;
  spanContext: SpanContext;
}

/**
 * How much of an LLM input a span records; the model always receives all of it.
 *
 * With `base` set, the record continues the one on that span, its parent: remove the parent's
 * last `droppedFromBase` entries, then append this span's (`chatCtx` on `llm_node`,
 * `conversation` on `llm_request`). Empty `instructions` then mean the parent's apply.
 */
export class InputDelta {
  constructor(
    readonly chatCtx: ChatContext,
    readonly instructions: ChatItem[],
    readonly conversation: ChatItem[],
    readonly base?: SpanContext,
    readonly droppedFromBase?: number,
  ) {}

  static full(chatCtx: ChatContext): InputDelta {
    const [instructions, conversation] = splitInstructions(chatCtx.items);
    return new InputDelta(chatCtx, instructions, conversation);
  }

  systemInstructions(): MessagePart[] {
    return instructionParts(this.instructions);
  }

  inputMessages(): ChatMessagePayload[] {
    return conversationMessages(this.conversation);
  }
}

/**
 * Per-agent memory of the LLM input recorded for the last committed generation, which the next
 * generation's spans continue (see `compute`).
 */
export class InputDeltaTracker {
  /** @internal */
  readonly _baselines = new Map<InputDeltaSite, InputBaseline>();

  begin(): InputDeltaScope {
    return new InputDeltaScope(this);
  }
}

/**
 * One generation's view of an `InputDeltaTracker`: the inputs its spans recorded, which
 * become the tracker's baseline once the generation is committed.
 *
 * A generation that is never committed (a discarded preemptive generation, an aborted reply) is
 * compared against the baseline but never replaces it.
 */
export class InputDeltaScope {
  #pending = new Map<InputDeltaSite, InputBaseline>();
  #committed = false;

  constructor(private readonly tracker: InputDeltaTracker) {}

  commit(): void {
    this.#committed = true;
    for (const [site, baseline] of this.#pending) this.tracker._baselines.set(site, baseline);
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
    const parent = this.tracker._baselines.get(site);

    if (span.isRecording()) {
      // the content recorded on the span: a preemptive generation's message may still change
      // before it is committed, and the next span must then record that edit
      this.#pending.set(site, current);
      if (this.#committed) this.tracker._baselines.set(site, current);
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

function sharedPrefix(current: InputBaseline, parent: InputBaseline, genAIMessages: boolean) {
  let n = 0;
  while (
    n < current.keys.length &&
    n < parent.keys.length &&
    current.keys[n]![0] === parent.keys[n]![0] &&
    current.keys[n]![1] === parent.keys[n]![1]
  ) {
    n++;
  }
  if (genAIMessages) {
    // never cut inside a message, on either side
    while (n > 0 && (insideMessage(current.layout, n) || insideMessage(parent.layout, n))) n--;
  }
  return n;
}

/**
 * Whether a cut before item `n` splits a message: the next item that lands in a message is a tool
 * call merged into the one before the cut (also across skipped items, such as a config update).
 */
function insideMessage(layout: InputBaseline['layout'], n: number): boolean {
  while (n < layout.length && layout[n] === 'skipped') n++;
  return n < layout.length && layout[n] === 'merged';
}

const scopeStorage = new AsyncLocalStorage<InputDeltaScope>();

/** Run `fn` with `scope` as the generation that the spans it creates record against. */
export function runWithScope<T>(scope: InputDeltaScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

export function active(): boolean {
  return scopeStorage.getStore() !== undefined;
}

/**
 * Decide how much of `chatCtx` the span records (see the module documentation). The model always
 * receives all of it; this only affects telemetry. Without `inputDelta`, return all of `chatCtx`.
 */
export function compute(site: InputDeltaSite, chatCtx: ChatContext, span: Span): InputDelta {
  return scopeStorage.getStore()?.delta(site, chatCtx, span) ?? InputDelta.full(chatCtx);
}

/** Point a span whose record continues another span's at that parent. */
export function setAttributes(span: Span, delta: InputDelta): void {
  if (!delta.base || !span.isRecording()) return;
  span.setAttributes({
    [traceTypes.ATTR_INPUT_DELTA]: true,
    [traceTypes.ATTR_INPUT_BASE_SPAN_ID]: delta.base.spanId,
    [traceTypes.ATTR_INPUT_DROPPED_FROM_BASE]: delta.droppedFromBase ?? 0,
  });
  span.addLink({ context: delta.base });
}
