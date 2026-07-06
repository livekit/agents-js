// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import { createImmutableArray, shortuuid } from '../utils.js';
import type { LLM } from './llm.js';
import { type ProviderFormat, toChatCtx } from './provider_format/index.js';
import type { JSONObject, JSONValue, ToolContext } from './tool_context.js';

export type ChatRole = 'developer' | 'system' | 'user' | 'assistant';
export interface ImageContent {
  id: string;

  type: 'image_content';

  /**
   * Either a string URL or a VideoFrame object.
   */
  image: string | VideoFrame;

  inferenceDetail: 'auto' | 'high' | 'low';

  inferenceWidth?: number;

  inferenceHeight?: number;

  mimeType?: string;

  _cache: Record<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface AudioContent {
  type: 'audio_content';

  frame: AudioFrame[];

  transcript?: string;
}

type InstructionsOptions = {
  /** The audio/voice variant of the instructions. */
  audio: string;
  /** The text variant of the instructions; falls back to `audio` when omitted. */
  text?: string;
  /** The currently rendered string value, used by `value`/`toString()`. */
  represent?: string;
};

const INSTRUCTIONS_SYMBOL = Symbol.for('livekit.agents.Instructions');

export function isInstructions(value: unknown): value is Instructions {
  return (
    typeof value === 'object' &&
    value !== null &&
    INSTRUCTIONS_SYMBOL in value &&
    (value as Record<symbol, boolean>)[INSTRUCTIONS_SYMBOL] === true
  );
}

/**
 * Instructions that adapt based on the user's input modality (audio vs. text).
 *
 * The `value` property is the rendered string providers see. By default it
 * equals the `audio` variant; after {@link asModality} it equals the chosen
 * variant. Both the `audio` variant and the raw `text` variant are preserved
 * so {@link asModality} can be called again for a different modality (e.g.,
 * when the same `ChatContext` is reused across tool-call turns).
 */
export class Instructions {
  readonly type = 'instructions' as const;

  private readonly _audioVariant: string;

  /** Raw text variant; falls back to {@link audio} when omitted. */
  private readonly _textVariant?: string;

  /** The currently rendered string (what providers should treat as content). */
  readonly value: string;

  /** @internal Symbol marker for type identification */
  readonly [INSTRUCTIONS_SYMBOL] = true;

  constructor(options: InstructionsOptions) {
    this._audioVariant = options.audio;
    this._textVariant = options.text;
    this.value = options.represent ?? options.audio;
  }

  static tpl(
    strings: TemplateStringsArray,
    ...values: Array<Instructions | string | number | boolean | null | undefined>
  ): Instructions {
    const render = (mode: 'audio' | 'text' | 'value') => {
      let result = strings[0]!;
      for (let i = 0; i < values.length; i++) {
        const value = values[i]!;
        if (isInstructions(value)) {
          result += mode === 'audio' ? value.audio : mode === 'text' ? value.text : value.value;
        } else {
          result += String(value);
        }
        result += strings[i + 1]!;
      }
      return result;
    };

    const hasTextVariant = values.some(
      (value) => isInstructions(value) && value._textVariant !== undefined,
    );

    return new Instructions({
      audio: render('audio'),
      text: hasTextVariant ? render('text') : undefined,
      represent: render('value'),
    });
  }

  /** The audio (voice) variant of the instructions. */
  get audio(): string {
    return this._audioVariant;
  }

  /** The text variant of the instructions. Falls back to {@link audio}. */
  get text(): string {
    return this._textVariant ?? this.audio;
  }

  /**
   * Return a copy whose {@link value} is the variant matching `modality`.
   * Both `audio` and `text` variants are preserved on the result, so this can
   * be called again for a different modality (e.g. across tool-call turns).
   */
  asModality(modality: 'audio' | 'text'): Instructions {
    return new Instructions({
      audio: this.audio,
      text: this._textVariant,
      represent: modality === 'audio' ? this.audio : this.text,
    });
  }

  /** Concatenate, propagating both variants and the current rendered value. */
  concat(other: string | Instructions): Instructions {
    if (isInstructions(other)) {
      const hasText = this._textVariant !== undefined || other._textVariant !== undefined;
      return new Instructions({
        audio: this.audio + other.audio,
        text: hasText ? this.text + other.text : undefined,
        represent: this.value + other.value,
      });
    }
    return new Instructions({
      audio: this.audio + other,
      text: this._textVariant !== undefined ? this._textVariant + other : undefined,
      represent: this.value + other,
    });
  }

  toString(): string {
    return this.value;
  }

  toJSON(): { type: 'instructions'; audio: string; text?: string } {
    const result: { type: 'instructions'; audio: string; text?: string } = {
      type: 'instructions',
      audio: this.audio,
    };
    if (this._textVariant !== undefined) {
      result.text = this._textVariant;
    }
    return result;
  }
}

export function renderInstructions(
  instructions: string | Instructions,
  modality?: 'audio' | 'text',
): string {
  if (typeof instructions === 'string') return instructions;
  return modality === undefined ? instructions.value : instructions.asModality(modality).value;
}

/**
 * Compare two instruction values by content. Plain strings compare by value;
 * {@link Instructions} compare by their audio + text variants so that two
 * distinct instances with the same content are treated as equal.
 */
export function instructionsEqual(
  a: string | Instructions | undefined,
  b: string | Instructions | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const aIsInstr = isInstructions(a);
  const bIsInstr = isInstructions(b);
  if (aIsInstr && bIsInstr) {
    return a.audio === b.audio && a.text === b.text;
  }
  if (!aIsInstr && !bIsInstr) {
    return a === b;
  }
  return false;
}

/**
 * Concatenate any mix of plain strings and {@link Instructions}, propagating
 * both audio/text variants. If no argument is an {@link Instructions} the
 * result is a plain string; otherwise the result is an {@link Instructions}
 * preserving both variants from every contributing operand.
 */
export function concatInstructions(...parts: Array<string | Instructions>): string | Instructions {
  if (parts.length === 0) return '';
  const hasInstructions = parts.some((p) => isInstructions(p));
  if (!hasInstructions) return parts.join('');

  let acc = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    const next = parts[i]!;
    if (isInstructions(acc)) {
      acc = acc.concat(next);
    } else if (isInstructions(next)) {
      // string + Instructions (radd-style): prepend `acc` to both variants.
      acc = new Instructions({ audio: acc }).concat(next);
    } else {
      acc = acc + next;
    }
  }
  return acc;
}

export type ChatContent = ImageContent | AudioContent | Instructions | string;

export function createImageContent(params: {
  image: string | VideoFrame;
  id?: string;
  inferenceDetail?: 'auto' | 'high' | 'low';
  inferenceWidth?: number;
  inferenceHeight?: number;
  mimeType?: string;
}): ImageContent {
  const {
    image,
    id = shortuuid('img_'),
    inferenceDetail = 'auto',
    inferenceWidth,
    inferenceHeight,
    mimeType,
  } = params;

  return {
    id,
    type: 'image_content',
    image,
    inferenceDetail,
    inferenceWidth,
    inferenceHeight,
    mimeType,
    _cache: {},
  };
}

export function createAudioContent(params: {
  frame: AudioFrame[];
  transcript?: string;
}): AudioContent {
  const { frame, transcript } = params;

  return {
    type: 'audio_content',
    frame,
    transcript,
  };
}

export interface MetricsReport {
  startedSpeakingAt?: number;
  stoppedSpeakingAt?: number;
  transcriptionDelay?: number;
  endOfTurnDelay?: number;
  onUserTurnCompletedDelay?: number;
  llmNodeTtft?: number;
  ttsNodeTtfb?: number;
  /**
   * Delay (in seconds) between forwarding the first audio frame and the `AudioOutput`
   * reporting playback started. Near-zero for the default room output (self-reported
   * when the frame is pushed to the track, so it doesn't account for network delivery
   * to the client); meaningful when a remote avatar worker is in the chain and reports
   * playback via the `lk.playback_started` RPC.
   *
   * Assistant `ChatMessage` only.
   */
  playbackLatency?: number;
  e2eLatency?: number;
}

export class ChatMessage {
  readonly id: string;

  readonly type = 'message' as const;

  readonly role: ChatRole;

  content: ChatContent[];

  interrupted: boolean;

  transcriptConfidence?: number;

  extra: Record<string, unknown>;

  metrics: MetricsReport;

  hash?: Uint8Array;

  createdAt: number;

  constructor(params: {
    role: ChatRole;
    content: ChatContent[] | string;
    id?: string;
    interrupted?: boolean;
    createdAt?: number;
    transcriptConfidence?: number;
    metrics?: MetricsReport;
    extra?: Record<string, unknown>;
  }) {
    const {
      role,
      content,
      id = shortuuid('item_'),
      interrupted = false,
      createdAt = Date.now(),
      transcriptConfidence,
      metrics = {},
      extra = {},
    } = params;
    this.id = id;
    this.role = role;
    this.content = Array.isArray(content) ? content : [content];
    this.interrupted = interrupted;
    this.createdAt = createdAt;
    this.transcriptConfidence = transcriptConfidence;
    this.metrics = metrics;
    this.extra = extra;
  }

  static create(params: {
    role: ChatRole;
    content: ChatContent[] | string;
    id?: string;
    interrupted?: boolean;
    createdAt?: number;
    transcriptConfidence?: number;
    metrics?: MetricsReport;
    extra?: Record<string, unknown>;
  }) {
    return new ChatMessage(params);
  }

  /**
   * Returns a single string with all text parts of the message joined by new
   * lines. If no string content is present, returns `null`.
   */
  get textContent(): string | undefined {
    const parts = this.content
      .filter((c): c is string | Instructions => typeof c === 'string' || isInstructions(c))
      .map((c) => (typeof c === 'string' ? c : c.value));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  toJSONContent(): JSONValue[] {
    return this.content.map((c) => {
      if (typeof c === 'string') {
        return c as JSONValue;
      } else if (isInstructions(c)) {
        return c.toJSON() as JSONValue;
      } else if (c.type === 'image_content') {
        return {
          id: c.id,
          type: c.type,
          image: c.image,
          inferenceDetail: c.inferenceDetail,
          inferenceWidth: c.inferenceWidth,
          inferenceHeight: c.inferenceHeight,
          mimeType: c.mimeType,
        } as JSONObject;
      } else {
        return {
          type: c.type,
          transcript: c.transcript,
        } as JSONObject;
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toJSON(excludeTimestamp: boolean = false): JSONValue {
    const result: JSONValue = {
      id: this.id,
      type: this.type,
      role: this.role,
      content: this.toJSONContent(),
      interrupted: this.interrupted,
    };

    if (!excludeTimestamp) {
      result.createdAt = this.createdAt;
    }

    if (this.transcriptConfidence !== undefined) {
      result.transcriptConfidence = this.transcriptConfidence;
    }
    if (Object.keys(this.metrics).length > 0) {
      result.metrics = { ...this.metrics };
    }
    if (Object.keys(this.extra).length > 0) {
      result.extra = this.extra as JSONValue;
    }

    return result;
  }
}

export class FunctionCall {
  readonly id: string;

  readonly type = 'function_call' as const;

  callId: string;

  args: string;

  name: string;

  createdAt: number;

  extra: Record<string, unknown>;
  /**
   * Optional grouping identifier for parallel tool calls.
   */
  groupId?: string;

  /**
   * Opaque signature for Gemini thinking mode.
   * When using Gemini 3+ models with thinking enabled, this signature must be
   * preserved and returned with function responses to maintain thought context.
   */
  thoughtSignature?: string;

  constructor(params: {
    callId: string;
    name: string;
    args: string;
    id?: string;
    createdAt?: number;
    extra?: Record<string, unknown>;
    groupId?: string;
    thoughtSignature?: string;
  }) {
    const {
      callId,
      name,
      args,
      id = shortuuid('item_'),
      createdAt = Date.now(),
      extra = {},
      groupId,
      thoughtSignature,
    } = params;
    this.id = id;
    this.callId = callId;
    this.args = args;
    this.name = name;
    this.createdAt = createdAt;
    this.extra = { ...extra };
    this.groupId = groupId;
    this.thoughtSignature =
      thoughtSignature ??
      (typeof this.extra.google === 'object' && this.extra.google !== null
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.extra.google as any).thoughtSignature ||
          (this.extra.google as any).thought_signature
        : undefined);
  }

  static create(params: {
    callId: string;
    name: string;
    args: string;
    id?: string;
    createdAt?: number;
    extra?: Record<string, unknown>;
    groupId?: string;
    thoughtSignature?: string;
  }) {
    return new FunctionCall(params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toJSON(excludeTimestamp: boolean = false): JSONValue {
    const result: JSONValue = {
      id: this.id,
      type: this.type,
      callId: this.callId,
      name: this.name,
      args: this.args,
    };

    if (Object.keys(this.extra).length > 0) {
      result.extra = this.extra as JSONValue;
    }

    if (this.groupId) {
      result.groupId = this.groupId;
    }

    if (this.thoughtSignature) {
      result.thoughtSignature = this.thoughtSignature;
    }

    if (!excludeTimestamp) {
      result.createdAt = this.createdAt;
    }

    return result;
  }
}

export class FunctionCallOutput {
  readonly id: string;

  readonly type = 'function_call_output' as const;

  name = '';

  callId: string;

  output: string;

  isError: boolean;

  createdAt: number;

  constructor(params: {
    callId: string;
    output: string;
    isError: boolean;
    id?: string;
    createdAt?: number;
    name?: string;
  }) {
    const {
      callId,
      output,
      isError,
      id = shortuuid('item_'),
      createdAt = Date.now(),
      name = '',
    } = params;
    this.id = id;
    this.callId = callId;
    this.output = output;
    this.isError = isError;
    this.name = name;
    this.createdAt = createdAt;
  }

  static create(params: {
    callId: string;
    output: string;
    isError: boolean;
    id?: string;
    createdAt?: number;
    name?: string;
  }) {
    return new FunctionCallOutput(params);
  }

  toJSON(excludeTimestamp: boolean = false): JSONValue {
    const result: JSONValue = {
      id: this.id,
      type: this.type,
      name: this.name,
      callId: this.callId,
      output: this.output,
      isError: this.isError,
    };

    if (!excludeTimestamp) {
      result.createdAt = this.createdAt;
    }

    return result;
  }
}

export class AgentHandoffItem {
  readonly id: string;

  readonly type = 'agent_handoff' as const;

  oldAgentId: string | undefined;

  newAgentId: string;

  createdAt: number;

  constructor(params: {
    oldAgentId?: string;
    newAgentId: string;
    id?: string;
    createdAt?: number;
  }) {
    const { oldAgentId, newAgentId, id = shortuuid('item_'), createdAt = Date.now() } = params;
    this.id = id;
    this.oldAgentId = oldAgentId;
    this.newAgentId = newAgentId;
    this.createdAt = createdAt;
  }

  static create(params: {
    oldAgentId?: string;
    newAgentId: string;
    id?: string;
    createdAt?: number;
  }) {
    return new AgentHandoffItem(params);
  }

  toJSON(excludeTimestamp: boolean = false): JSONValue {
    const result: JSONValue = {
      id: this.id,
      type: this.type,
      newAgentId: this.newAgentId,
    };

    if (this.oldAgentId !== undefined) {
      result.oldAgentId = this.oldAgentId;
    }

    if (!excludeTimestamp) {
      result.createdAt = this.createdAt;
    }

    return result;
  }
}

export class AgentConfigUpdate {
  readonly id: string;

  readonly type = 'agent_config_update' as const;

  instructions?: string | Instructions;

  toolsAdded?: string[];

  toolsRemoved?: string[];

  createdAt: number;

  constructor(
    params: {
      id?: string;
      instructions?: string | Instructions;
      toolsAdded?: string[];
      toolsRemoved?: string[];
      createdAt?: number;
    } = {},
  ) {
    const {
      id = shortuuid('item_'),
      instructions,
      toolsAdded,
      toolsRemoved,
      createdAt = Date.now(),
    } = params;
    this.id = id;
    this.instructions = instructions;
    this.toolsAdded = toolsAdded;
    this.toolsRemoved = toolsRemoved;
    this.createdAt = createdAt;
  }

  static create(params: {
    id?: string;
    instructions?: string | Instructions;
    toolsAdded?: string[];
    toolsRemoved?: string[];
    createdAt?: number;
  }) {
    return new AgentConfigUpdate(params);
  }

  toJSON(excludeTimestamp: boolean = false): JSONValue {
    const result: JSONValue = {
      id: this.id,
      type: this.type,
    };

    if (this.instructions !== undefined) {
      result.instructions = isInstructions(this.instructions)
        ? (this.instructions.toJSON() as JSONValue)
        : this.instructions;
    }
    if (this.toolsAdded !== undefined) {
      result.toolsAdded = this.toolsAdded;
    }
    if (this.toolsRemoved !== undefined) {
      result.toolsRemoved = this.toolsRemoved;
    }
    if (!excludeTimestamp) {
      result.createdAt = this.createdAt;
    }

    return result;
  }
}

export type ChatItem =
  | ChatMessage
  | FunctionCall
  | FunctionCallOutput
  | AgentHandoffItem
  | AgentConfigUpdate;

export class ChatContext {
  protected _items: ChatItem[];

  constructor(items?: ChatItem[]) {
    this._items = items ? items : [];
  }

  static empty(): ChatContext {
    return new ChatContext([]);
  }

  get items(): ChatItem[] {
    return this._items;
  }

  set items(items: ChatItem[]) {
    this._items = items;
  }

  /**
   * Add a new message to the context and return it.
   */
  addMessage(params: {
    role: ChatRole;
    content: ChatContent[] | string;
    id?: string;
    interrupted?: boolean;
    createdAt?: number;
    transcriptConfidence?: number;
    metrics?: MetricsReport;
    extra?: Record<string, unknown>;
  }): ChatMessage {
    const msg = new ChatMessage(params);
    if (params.createdAt !== undefined) {
      const idx = this.findInsertionIndex(params.createdAt);
      this._items.splice(idx, 0, msg);
    } else {
      this._items.push(msg);
    }
    return msg;
  }

  /**
   * Insert a single item or multiple items based on their `createdAt` field so
   * that the array keeps its chronological order.
   */
  insert(item: ChatItem | ChatItem[]): void {
    const arr = Array.isArray(item) ? item : [item];
    for (const it of arr) {
      const idx = this.findInsertionIndex(it.createdAt);
      this._items.splice(idx, 0, it);
    }
  }

  /**
   * Remove the first item from the chat context by item or item ID.
   *
   * Throws if the item or ID is not found.
   */
  remove(item: ChatItem | string): void {
    const itemId = typeof item === 'string' ? item : item.id;
    const idx = this.indexById(itemId);
    if (idx === undefined) {
      throw new Error(`Item not found: ${typeof item === 'string' ? item : item.id}`);
    }
    this._items.splice(idx, 1);
  }

  getById(itemId: string): ChatItem | undefined {
    return this._items.find((i) => i.id === itemId);
  }

  indexById(itemId: string): number | undefined {
    const idx = this._items.findIndex((i) => i.id === itemId);
    return idx !== -1 ? idx : undefined;
  }

  copy(
    options: {
      excludeFunctionCall?: boolean;
      excludeInstructions?: boolean;
      excludeEmptyMessage?: boolean;
      excludeHandoff?: boolean;
      excludeConfigUpdate?: boolean;
      toolCtx?: ToolContext<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    } = {},
  ): ChatContext {
    const {
      excludeFunctionCall = false,
      excludeInstructions = false,
      excludeEmptyMessage = false,
      excludeHandoff = false,
      excludeConfigUpdate = false,
      toolCtx,
    } = options;
    const items: ChatItem[] = [];

    const isToolCallOrOutput = (item: ChatItem): item is FunctionCall | FunctionCallOutput =>
      ['function_call', 'function_call_output'].includes(item.type);
    const isChatMessage = (item: ChatItem): item is ChatMessage => item.type === 'message';

    for (const item of this._items) {
      if (excludeFunctionCall && isToolCallOrOutput(item)) {
        continue;
      }

      if (
        excludeInstructions &&
        isChatMessage(item) &&
        ['system', 'developer'].includes(item.role)
      ) {
        continue;
      }

      if (excludeEmptyMessage && isChatMessage(item) && item.content.length === 0) {
        continue;
      }

      if (excludeHandoff && item.type === 'agent_handoff') {
        continue;
      }

      if (excludeConfigUpdate && item.type === 'agent_config_update') {
        continue;
      }

      if (toolCtx !== undefined && isToolCallOrOutput(item) && !toolCtx.hasTool(item.name)) {
        continue;
      }

      items.push(item);
    }

    return new ChatContext(items);
  }

  merge(
    other: ChatContext,
    options: {
      excludeFunctionCall?: boolean;
      excludeInstructions?: boolean;
      excludeConfigUpdate?: boolean;
    } = {},
  ): ChatContext {
    const {
      excludeFunctionCall = false,
      excludeInstructions = false,
      excludeConfigUpdate = false,
    } = options;
    const existingIds = new Set(this._items.map((item) => item.id));

    for (const item of other.items) {
      if (excludeFunctionCall && ['function_call', 'function_call_output'].includes(item.type)) {
        continue;
      }

      if (
        excludeInstructions &&
        item.type === 'message' &&
        (item.role === 'system' || item.role === 'developer')
      ) {
        continue;
      }

      if (excludeConfigUpdate && item.type === 'agent_config_update') {
        continue;
      }

      if (existingIds.has(item.id)) {
        continue;
      }

      const idx = this.findInsertionIndex(item.createdAt);
      this._items.splice(idx, 0, item);
      existingIds.add(item.id);
    }

    return this;
  }

  truncate(maxItems: number): ChatContext {
    if (maxItems <= 0) return this;

    const instructions = this._items.find((i) => i.type === 'message' && i.role === 'system') as
      | ChatMessage
      | undefined;

    let newItems = this._items.slice(-maxItems);

    // Ensure the first item is not a function-call artefact.
    while (
      newItems.length > 0 &&
      ['function_call', 'function_call_output'].includes(newItems[0]!.type)
    ) {
      newItems.shift();
    }

    if (instructions) {
      // At this point `instructions` is defined, so it is safe to pass to `includes`.
      if (!newItems.includes(instructions)) {
        newItems = [instructions, ...newItems];
      }
    }

    // replace the items in place to keep the reference
    this._items.splice(0, this._items.length, ...newItems);
    return this;
  }

  toJSON(
    options: {
      excludeImage?: boolean;
      excludeAudio?: boolean;
      excludeTimestamp?: boolean;
      excludeFunctionCall?: boolean;
      excludeConfigUpdate?: boolean;
    } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): JSONObject {
    const {
      excludeImage = true,
      excludeAudio = true,
      excludeTimestamp = true,
      excludeFunctionCall = false,
      excludeConfigUpdate = false,
    } = options;

    const items: ChatItem[] = [];

    for (const item of this._items) {
      let processedItem = item;

      if (excludeFunctionCall && ['function_call', 'function_call_output'].includes(item.type)) {
        continue;
      }

      if (excludeConfigUpdate && item.type === 'agent_config_update') {
        continue;
      }

      if (item.type === 'message') {
        processedItem = ChatMessage.create({
          role: item.role,
          content: item.content,
          id: item.id,
          interrupted: item.interrupted,
          createdAt: item.createdAt,
          transcriptConfidence: item.transcriptConfidence,
          metrics: item.metrics,
          extra: item.extra,
        });

        // Filter content based on options
        if (excludeImage) {
          processedItem.content = processedItem.content.filter((c) => {
            return !(typeof c === 'object' && c.type === 'image_content');
          });
        }

        if (excludeAudio) {
          processedItem.content = processedItem.content.filter((c) => {
            return !(typeof c === 'object' && c.type === 'audio_content');
          });
        }
      }

      items.push(processedItem);
    }

    return {
      items: items.map((item) => item.toJSON(excludeTimestamp)),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async toProviderFormat(format: ProviderFormat, injectDummyUserMessage: boolean = true) {
    return await toChatCtx(format, this, injectDummyUserMessage);
  }

  /**
   * Internal helper used by `truncate` & `addMessage` to find the correct
   * insertion index for a timestamp so the list remains sorted.
   */
  private findInsertionIndex(createdAt: number): number {
    for (let i = this._items.length - 1; i >= 0; i -= 1) {
      const item = this._items[i];
      if (item!.createdAt <= createdAt) {
        return i + 1;
      }
    }
    return 0;
  }

  /**
   * Return true if `other` has the same sequence of items with matching
   * essential fields (IDs, types, and payload) as this context.
   *
   * Comparison rules:
   * - Messages: compares the full `content` list, `role` and `interrupted`.
   * - Function calls: compares `name`, `callId`, and `args`.
   * - Function call outputs: compares `name`, `callId`, `output`, and `isError`.
   *
   * Does not consider timestamps or other metadata.
   */
  isEquivalent(other: ChatContext): boolean {
    if (this === other) {
      return true;
    }

    if (this.items.length !== other.items.length) {
      return false;
    }

    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i]!;
      const b = other.items[i]!;

      if (a.id !== b.id || a.type !== b.type) {
        return false;
      }

      if (a.type === 'message' && b.type === 'message') {
        if (
          a.role !== b.role ||
          a.interrupted !== b.interrupted ||
          !this.compareContent(a.content, b.content)
        ) {
          return false;
        }
      } else if (a.type === 'function_call' && b.type === 'function_call') {
        if (
          a.name !== b.name ||
          a.callId !== b.callId ||
          a.args !== b.args ||
          a.thoughtSignature !== b.thoughtSignature ||
          a.groupId !== b.groupId ||
          JSON.stringify(a.extra) !== JSON.stringify(b.extra)
        ) {
          return false;
        }
      } else if (a.type === 'function_call_output' && b.type === 'function_call_output') {
        if (
          a.name !== b.name ||
          a.callId !== b.callId ||
          a.output !== b.output ||
          a.isError !== b.isError
        ) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Compare two content arrays for equality.
   */
  private compareContent(a: ChatContent[], b: ChatContent[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      const contentA = a[i]!;
      const contentB = b[i]!;

      if (typeof contentA === 'string' && typeof contentB === 'string') {
        if (contentA !== contentB) {
          return false;
        }
        continue;
      }

      if (typeof contentA !== typeof contentB) {
        return false;
      }

      if (isInstructions(contentA) && isInstructions(contentB)) {
        if (
          contentA.audio !== contentB.audio ||
          contentA.text !== contentB.text ||
          contentA.value !== contentB.value
        ) {
          return false;
        }
        continue;
      }

      if (isInstructions(contentA) || isInstructions(contentB)) {
        return false;
      }

      if (typeof contentA === 'object' && typeof contentB === 'object') {
        if (contentA.type === 'image_content' && contentB.type === 'image_content') {
          if (
            contentA.id !== contentB.id ||
            contentA.image !== contentB.image ||
            contentA.inferenceDetail !== contentB.inferenceDetail ||
            contentA.inferenceWidth !== contentB.inferenceWidth ||
            contentA.inferenceHeight !== contentB.inferenceHeight ||
            contentA.mimeType !== contentB.mimeType
          ) {
            return false;
          }
        } else if (contentA.type === 'audio_content' && contentB.type === 'audio_content') {
          if (contentA.frame.length !== contentB.frame.length) {
            return false;
          }
          if (contentA.transcript !== contentB.transcript) {
            return false;
          }
        } else {
          return false;
        }
      }
    }

    return true;
  }

  async _summarize(llm: LLM, options: { keepLastTurns?: number } = {}): Promise<ChatContext> {
    const { keepLastTurns = 2 } = options;

    // Split the history into a head/tail over the full item stream so recent
    // tool calls/outputs stay attached to the turns they belong to.
    const msgBudget = keepLastTurns * 2;
    let splitIdx = this._items.length;

    if (msgBudget > 0) {
      let msgCount = 0;
      let foundSplit = false;
      for (let i = this._items.length - 1; i >= 0; i -= 1) {
        const item = this._items[i]!;
        if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
          msgCount += 1;
          if (msgCount >= msgBudget) {
            splitIdx = i;
            foundSplit = true;
            break;
          }
        }
      }

      if (!foundSplit) {
        return this;
      }
    }

    if (splitIdx === 0) {
      return this;
    }

    const headItems = this._items.slice(0, splitIdx);
    const tailItems = this._items.slice(splitIdx);

    const toSummarize: Array<ChatMessage | FunctionCall | FunctionCallOutput> = [];
    for (const item of headItems) {
      if (item.type === 'message') {
        if (item.role !== 'user' && item.role !== 'assistant') continue;
        if (item.extra?.is_summary === true) continue;

        const text = (item.textContent ?? '').trim();
        if (text) {
          toSummarize.push(item);
        }
      } else if (item.type === 'function_call' || item.type === 'function_call_output') {
        toSummarize.push(item);
      }
    }

    if (toSummarize.length === 0) {
      return this;
    }

    const sourceText = toSummarize
      .map((item) => {
        if (item.type === 'message') {
          return toXml(item.role, (item.textContent ?? '').trim());
        }

        return functionCallItemToMessage(item).textContent ?? '';
      })
      .join('\n')
      .trim();

    if (!sourceText) {
      return this;
    }

    // TODO: refactor this into LLMStream.collect API.
    const promptCtx = new ChatContext();
    promptCtx.addMessage({
      role: 'system',
      content: [
        'Compress older conversation history into a short, faithful summary.',
        '',
        'The conversation is formatted as XML. Here is how to read it:',
        '- <user>...</user>  - something the user said.',
        '- <assistant>...</assistant>  - something the assistant said.',
        '- <function_call name="..." call_id="...">...</function_call>  - the assistant invoked an action.',
        '- <function_call_output name="..." call_id="...">...</function_call_output>  - the result of that action. May contain <error>...</error> if it failed.',
        '',
        'Guidelines:',
        '- Distill the information learned from function call outputs into the summary. Do not mention that a tool or function was called; just preserve the knowledge gained.',
        '- Focus on user goals, constraints, decisions, key facts, preferences, entities, and any pending or unresolved tasks.',
        '- Omit greetings, filler, and chit-chat.',
        '- Be concise.',
      ].join('\n'),
    });
    promptCtx.addMessage({
      role: 'user',
      content: `Conversation to summarize:\n\n${sourceText}`,
    });

    const chunks: string[] = [];
    for await (const chunk of llm.chat({ chatCtx: promptCtx })) {
      if (chunk.delta?.content) {
        chunks.push(chunk.delta.content);
      }
    }

    const summary = chunks.join('').trim();
    if (!summary) {
      return this;
    }

    const preserved: ChatItem[] = [];
    for (const it of headItems) {
      if (it.type === 'message' && (it.role === 'user' || it.role === 'assistant')) {
        continue;
      }

      if (it.type === 'function_call' || it.type === 'function_call_output') {
        continue;
      }

      preserved.push(it);
    }

    this._items = preserved;

    const createdAtHint =
      tailItems.length > 0
        ? tailItems[0]!.createdAt - 1e-6
        : headItems[headItems.length - 1]!.createdAt + 1e-6;

    this.addMessage({
      role: 'assistant',
      content: toXml('chat_history_summary', summary),
      createdAt: createdAtHint,
      extra: { is_summary: true },
    });

    this._items.push(...tailItems);

    return this;
  }

  /**
   * Indicates whether the context is read-only
   */
  get readonly(): boolean {
    return false;
  }
}

function toAttrsStr(attrs?: Record<string, unknown>): string | undefined {
  if (!attrs) {
    return undefined;
  }

  return Object.entries(attrs)
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(' ');
}

function toXml(tagName: string, content?: string, attrs?: Record<string, unknown>): string {
  const attrsStr = toAttrsStr(attrs);
  if (content) {
    return [attrsStr ? `<${tagName} ${attrsStr}>` : `<${tagName}>`, content, `</${tagName}>`].join(
      '\n',
    );
  }

  return attrsStr ? `<${tagName} ${attrsStr} />` : `<${tagName} />`;
}

function functionCallItemToMessage(item: FunctionCall | FunctionCallOutput): ChatMessage {
  if (item.type === 'function_call') {
    return new ChatMessage({
      role: 'user',
      content: [
        toXml('function_call', item.args, {
          name: item.name,
          call_id: item.callId,
        }),
      ],
      createdAt: item.createdAt,
      extra: { is_function_call: true },
    });
  }

  return new ChatMessage({
    role: 'assistant',
    content: [
      toXml('function_call_output', item.isError ? toXml('error', item.output) : item.output, {
        name: item.name,
        call_id: item.callId,
      }),
    ],
    createdAt: item.createdAt,
    extra: { is_function_call_output: true },
  });
}

export class ReadonlyChatContext extends ChatContext {
  static readonly errorMsg =
    'Please use .copy() and agent.update_chat_ctx() to modify the chat context.';

  constructor(items: ChatItem[]) {
    super(createImmutableArray(items, ReadonlyChatContext.errorMsg));
  }

  get items(): ChatItem[] {
    return this._items;
  }

  set items(items: ChatItem[]) {
    throw new Error(
      `Cannot set items on a read-only chat context. ${ReadonlyChatContext.errorMsg}`,
    );
  }

  get readonly(): boolean {
    return true;
  }
}
