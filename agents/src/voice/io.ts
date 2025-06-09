// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import type { SpeechEvent } from '../stt/stt.js';

export type NodeOptions = {
  signal?: AbortSignal;
};

export type STTNode = (
  audio: ReadableStream<AudioFrame>,
  modelSettings: any, // TODO(AJS-59): add type
  nodeOptions?: NodeOptions,
) => Promise<ReadableStream<SpeechEvent | string> | null>;

export type LLMNode = (
  chatCtx: ChatContext,
  modelSettings: any, // TODO(AJS-59): add type
  nodeOptions?: NodeOptions,
) => Promise<ReadableStream<ChatChunk | string> | null>;

export type TTSNode = (
  text: ReadableStream<string>,
  modelSettings: any, // TODO(AJS-59): add type
  nodeOptions?: NodeOptions,
) => Promise<ReadableStream<AudioFrame> | null>;
