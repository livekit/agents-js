// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import type { CallableFunctionResult, FunctionCallInfo } from './function_context.js';

export enum ChatRole {
  SYSTEM,
  USER,
  ASSISTANT,
  TOOL,
}

export interface ChatImage {
  image: string | VideoFrame;
  inferenceWidth?: number;
  inferenceHeight?: number;
  /**
   * @internal
   * Used by LLM implementations to store a processed version of the image for later use.
   */
  cache: { [id: string | number | symbol]: any };
}

export interface ChatAudio {
  frame: AudioFrame | AudioFrame[];
}

export type ChatContent = string | ChatImage | ChatAudio;

const defaultCreateChatMessage = {
  text: '',
  images: [],
  role: ChatRole.SYSTEM,
};

export class ChatMessage {
  readonly role: ChatRole;
  readonly id?: string;
  readonly name?: string;
  readonly content?: ChatContent | ChatContent[];
  readonly toolCalls?: FunctionCallInfo[];
  readonly toolCallId?: string;
  readonly toolException?: Error;

  /** @internal */
  constructor({
    role,
    id,
    name,
    content,
    toolCalls,
    toolCallId,
    toolException,
  }: {
    role: ChatRole;
    id?: string;
    name?: string;
    content?: ChatContent | ChatContent[];
    toolCalls?: FunctionCallInfo[];
    toolCallId?: string;
    toolException?: Error;
  }) {
    this.role = role;
    this.id = id;
    this.name = name;
    this.content = content;
    this.toolCalls = toolCalls;
    this.toolCallId = toolCallId;
    this.toolException = toolException;
  }

  static createToolFromFunctionResult(func: CallableFunctionResult): ChatMessage {
    if (!func.result && !func.error) {
      throw new TypeError('CallableFunctionResult must include result or error');
    }

    return new ChatMessage({
      role: ChatRole.TOOL,
      name: func.name,
      content: func.result || `Error: ${func.error}`,
      toolCallId: func.toolCallId,
      toolException: func.error,
    });
  }

  static createToolCalls(toolCalls: FunctionCallInfo[], text = '') {
    return new ChatMessage({
      role: ChatRole.ASSISTANT,
      toolCalls,
      content: text,
    });
  }

  static create(
    options: Partial<{
      text?: string;
      images: ChatImage[];
      role: ChatRole;
    }>,
  ): ChatMessage {
    const { text, images, role } = { ...defaultCreateChatMessage, ...options };

    if (!images.length) {
      return new ChatMessage({
        role,
        content: text,
      });
    } else {
      return new ChatMessage({
        role,
        content: [...(text ? [text] : []), ...images],
      });
    }
  }

  /** Returns a structured clone of this message. */
  copy(): ChatMessage {
    return new ChatMessage({
      role: this.role,
      id: this.id,
      name: this.name,
      content: this.content,
      toolCalls: this.toolCalls,
      toolCallId: this.toolCallId,
      toolException: this.toolException,
    });
  }
}

export class ChatContext {
  messages: ChatMessage[] = [];
  metadata: { [id: string]: any } = {};

  append(msg: { text?: string; images?: ChatImage[]; role: ChatRole }): ChatContext {
    this.messages.push(ChatMessage.create(msg));
    return this;
  }

  /** Returns a structured clone of this context. */
  copy(): ChatContext {
    const ctx = new ChatContext();
    ctx.messages.push(...this.messages.map((msg) => msg.copy()));
    ctx.metadata = structuredClone(this.metadata);
    return ctx;
  }
}
