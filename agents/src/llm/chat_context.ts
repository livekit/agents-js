// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';

export enum ChatRole {
  SYSTEM,
  USER,
  ASSISTANT,
  TOOL,
}

export interface ChatImage {
  image: string | AudioFrame;
  inferenceWidth?: number;
  inferenceHeight?: number;
  /** Used by LLM implementations to store a processed version of the image for later use. */
  cache: { [id: string | number | symbol]: any };
}

export interface ChatAudio {
  frame: AudioFrame | AudioFrame[];
}

export type ChatContent = string | ChatImage | ChatAudio;

export class ChatMessage {
  readonly role: ChatRole;
  readonly id?: string;
  readonly name?: string;
  readonly content?: ChatContent | ChatContent[];
  readonly toolCallId?: string;
  readonly toolException?: Error;

  /** @internal */
  constructor({
    role,
    id,
    name,
    content,
    toolCallId,
    toolException,
  }: {
    role: ChatRole;
    id?: string;
    name?: string;
    content?: ChatContent | ChatContent[];
    toolCallId?: string;
    toolException?: Error;
  }) {
    this.role = role;
    this.id = id;
    this.name = name;
    this.content = content;
    this.toolCallId = toolCallId;
    this.toolException = toolException;
  }

  // TODO(nbsp): tool call functions.
  // the system defined in function_context.ts is fundamentally different (and much, much simpler)
  // than the one in Python Agents.
  // pair with theo to figure out what to do here (and later in MultimodalAgent/RealtimeModel)

  static create({
    text = '',
    images = [],
    role = ChatRole.SYSTEM,
  }: {
    text?: string;
    images: ChatImage[];
    role: ChatRole;
  }): ChatMessage {
    if (!images.length) {
      return new ChatMessage({
        role: ChatRole.ASSISTANT,
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
    return structuredClone(this);
  }
}

export class ChatContext {
  messages: ChatMessage[] = [];
  metadata: { [id: string]: any } = {};

  append(msg: { text?: string; images: ChatImage[]; role: ChatRole }): ChatContext {
    this.messages.push(ChatMessage.create(msg));
    return this;
  }

  /** Returns a structured clone of this context. */
  copy(): ChatContext {
    return structuredClone(this);
  }
}
