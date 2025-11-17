// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import { createImmutableArray, shortuuid } from '../utils.js';
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

export type ChatContent = ImageContent | AudioContent | string;

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

export class ChatMessage {
  readonly id: string;

  readonly type = 'message' as const;

  readonly role: ChatRole;

  content: ChatContent[];

  interrupted: boolean;

  hash?: Uint8Array;

  createdAt: number;

  constructor(params: {
    role: ChatRole;
    content: ChatContent[] | string;
    id?: string;
    interrupted?: boolean;
    createdAt?: number;
  }) {
    const {
      role,
      content,
      id = shortuuid('item_'),
      interrupted = false,
      createdAt = Date.now(),
    } = params;
    this.id = id;
    this.role = role;
    this.content = Array.isArray(content) ? content : [content];
    this.interrupted = interrupted;
    this.createdAt = createdAt;
  }

  static create(params: {
    role: ChatRole;
    content: ChatContent[] | string;
    id?: string;
    interrupted?: boolean;
    createdAt?: number;
  }) {
    return new ChatMessage(params);
  }

  /**
   * Returns a single string with all text parts of the message joined by new
   * lines. If no string content is present, returns `null`.
   */
  get textContent(): string | undefined {
    const parts = this.content.filter((c): c is string => typeof c === 'string');
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  toJSONContent(): JSONValue[] {
    return this.content.map((c) => {
      if (typeof c === 'string') {
        return c as JSONValue;
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

  constructor(params: {
    callId: string;
    name: string;
    args: string;
    id?: string;
    createdAt?: number;
  }) {
    const { callId, name, args, id = shortuuid('item_'), createdAt = Date.now() } = params;
    this.id = id;
    this.callId = callId;
    this.args = args;
    this.name = name;
    this.createdAt = createdAt;
  }

  static create(params: {
    callId: string;
    name: string;
    args: string;
    id?: string;
    createdAt?: number;
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

export type ChatItem = ChatMessage | FunctionCall | FunctionCallOutput | AgentHandoffItem;

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
      toolCtx?: ToolContext<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    } = {},
  ): ChatContext {
    const {
      excludeFunctionCall = false,
      excludeInstructions = false,
      excludeEmptyMessage = false,
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

      if (toolCtx !== undefined && isToolCallOrOutput(item) && toolCtx[item.name] === undefined) {
        continue;
      }

      items.push(item);
    }

    return new ChatContext(items);
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
    } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): JSONObject {
    const {
      excludeImage = true,
      excludeAudio = true,
      excludeTimestamp = true,
      excludeFunctionCall = false,
    } = options;

    const items: ChatItem[] = [];

    for (const item of this._items) {
      let processedItem = item;

      if (excludeFunctionCall && ['function_call', 'function_call_output'].includes(item.type)) {
        continue;
      }

      if (item.type === 'message') {
        processedItem = ChatMessage.create({
          role: item.role,
          content: item.content,
          id: item.id,
          interrupted: item.interrupted,
          createdAt: item.createdAt,
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
        if (a.name !== b.name || a.callId !== b.callId || a.args !== b.args) {
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

  /**
   * Indicates whether the context is read-only
   */
  get readonly(): boolean {
    return false;
  }
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
