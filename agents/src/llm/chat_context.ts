// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import { v4 as uuidv4 } from 'uuid';

function shortuuid(prefix: string): string {
  return `${prefix}_${uuidv4().slice(0, 12)}`;
}

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

  constructor({
    role,
    content,
    id = shortuuid('item'),
    interrupted = false,
    createdAt = Date.now(),
  }: {
    role: ChatRole;
    content: ChatContent[] | string;
    id?: string;
    interrupted?: boolean;
    createdAt?: number;
  }) {
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

  constructor({
    callId,
    name,
    args,
    id = shortuuid('item'),
    createdAt = Date.now(),
  }: {
    callId: string;
    name: string;
    args: string;
    id?: string;
    createdAt?: number;
  }) {
    this.id = id;
    this.callId = callId;
    this.args = args;
    this.name = name;
    this.createdAt = createdAt;
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

  constructor({
    callId,
    output,
    isError,
    id = shortuuid('item'),
    createdAt = Date.now(),
    name = '',
  }: {
    callId: string;
    output: string;
    isError: boolean;
    id?: string;
    createdAt?: number;
    name?: string;
  }) {
    this.id = id;
    this.callId = callId;
    this.output = output;
    this.isError = isError;
    this.name = name;
    this.createdAt = createdAt;
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

  get items(): ReadonlyArray<ChatItem> {
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
      // TODO: tools filter implementation
      tools?: unknown;
    } = {},
  ): ChatContext {
    // TODO(brian): implement copy
    return this;
  }

  truncate(maxItems: number): ChatContext {
    if (maxItems <= 0) return this;

    const instructions = this._items.find(
      (i) => i.type === 'message' && (i as ChatMessage).role === 'system',
    ) as ChatMessage | undefined;

    let newItems = this._items.slice(-maxItems);

    // Ensure the first item is not a function-call artefact.
    while (newItems.length > 0) {
      const first = newItems[0]!;
      if (first.type === 'function_call' || first.type === 'function_call_output') {
        newItems.shift();
      } else {
        break;
      }
    }

    let nonFunctionItemIdx = 0;
    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i]!;
      if (item.type !== 'function_call' && item.type !== 'function_call_output') {
        nonFunctionItemIdx = i;
        break;
      }
    }

    // Trim chat ctx start on any function_call or function_call_output
    newItems = newItems.slice(nonFunctionItemIdx);

    if (instructions) {
      // At this point `instructions` is defined, so it is safe to pass to `includes`.
      if (!newItems.includes(instructions)) {
        newItems = [instructions, ...newItems];
      }
    }

    this._items = newItems;
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toProviderFormat(format: string, _options: any = {}): [unknown[], unknown] {
    // TODO(brian): Implement provider-specific conversions (openai, google, aws, anthropic)
    throw new Error(`Unsupported provider format: ${format}`);
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

export function message(params: {
  role: ChatRole;
  content: ChatContent[] | string;
  id?: string;
  interrupted?: boolean;
  createdAt?: number;
}) {
  return new ChatMessage(params);
}

export function toolCall(params: {
  callId: string;
  name: string;
  args: string;
  id?: string;
  createdAt?: number;
}) {
  return new FunctionCall(params);
}

export function toolCallOutput(params: {
  callId: string;
  output: string;
  isError: boolean;
  id?: string;
  createdAt?: number;
}) {
  return new FunctionCallOutput(params);
}
