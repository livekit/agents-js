// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import { shortuuid } from '../utils.js';
import { type ProviderFormat, toChatCtx } from './provider_format/index.js';
import type { ToolContext } from './tool_context.js';

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
      id = shortuuid('item'),
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
    const { callId, name, args, id = shortuuid('item'), createdAt = Date.now() } = params;
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
      id = shortuuid('item'),
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
}

export type ChatItem = ChatMessage | FunctionCall | FunctionCallOutput;

export class ChatContext {
  private _items: ChatItem[];

  constructor(items?: ChatItem[]) {
    this._items = items ? [...items] : [];
  }

  static empty(): ChatContext {
    return new ChatContext([]);
  }

  get items(): ChatItem[] {
    return this._items;
  }

  set items(items: ChatItem[]) {
    this._items = [...items];
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

    this._items = newItems;
    return this;
  }

  /**
   * Convert the chat context to a dictionary representation.
   * 
   * @param options - Options for filtering content
   * @param options.excludeImage - Whether to exclude image content from messages (default: true)
   * @param options.excludeAudio - Whether to exclude audio content from messages (default: true)
   * @param options.excludeTimestamp - Whether to exclude timestamp fields (default: true)
   * @param options.excludeFunctionCall - Whether to exclude function calls and outputs (default: false)
   * @returns Dictionary representation of the chat context
   */
  toDict(options: {
    excludeImage?: boolean;
    excludeAudio?: boolean;
    excludeTimestamp?: boolean;
    excludeFunctionCall?: boolean;
  } = {}): { items: Record<string, any>[] } { // eslint-disable-line @typescript-eslint/no-explicit-any
    const {
      excludeImage = true,
      excludeAudio = true,
      excludeTimestamp = true,
      excludeFunctionCall = false,
    } = options;

    const items: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

    for (const item of this._items) {
      if (excludeFunctionCall && ['function_call', 'function_call_output'].includes(item.type)) {
        continue;
      }

      let processedItem = item;

      if (item.type === 'message') {
        // Create a new ChatMessage with filtered content
        let filteredContent = item.content;
        
        // Filter content based on options
        if (excludeImage || excludeAudio) {
          filteredContent = item.content.filter((c) => {
            if (excludeImage && typeof c === 'object' && c.type === 'image_content') {
              return false;
            }
            if (excludeAudio && typeof c === 'object' && c.type === 'audio_content') {
              return false;
            }
            return true;
          });
        }
        
        processedItem = new ChatMessage({
          role: item.role,
          content: filteredContent,
          id: item.id,
          interrupted: item.interrupted,
          createdAt: item.createdAt,
        });
        
        // Copy the hash if it exists
        if (item.hash) {
          processedItem.hash = item.hash;
        }
      }

      // Convert to plain object and handle field exclusions
      const itemDict = this.itemToDict(processedItem);
      
      if (excludeTimestamp) {
        delete itemDict.createdAt;
      }

      items.push(itemDict);
    }

    return { items };
  }

  /**
   * Helper method to convert a chat item to a dictionary representation.
   */
  private itemToDict(item: ChatItem): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
      id: item.id,
      type: item.type,
      createdAt: item.createdAt,
    };

    if (item.type === 'message') {
      result.role = item.role;
      result.content = item.content.map((c) => {
        if (typeof c === 'string') {
          return c;
        }
        // For complex content objects, convert to plain object
        return { ...c };
      });
      result.interrupted = item.interrupted;
      if (item.hash) {
        result.hash = Array.from(item.hash); // Convert Uint8Array to regular array
      }
    } else if (item.type === 'function_call') {
      result.callId = item.callId;
      result.args = item.args;
      result.name = item.name;
    } else if (item.type === 'function_call_output') {
      result.name = item.name;
      result.callId = item.callId;
      result.output = item.output;
      result.isError = item.isError;
    }

    return result;
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
   * Indicates whether the context is read-only
   */
  get readonly(): boolean {
    return false;
  }
}