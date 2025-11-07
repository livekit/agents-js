// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import type { ReadableStream } from 'node:stream/web';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { Task } from '../utils.js';
import type { ChatContext, FunctionCall } from './chat_context.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

export type InputSpeechStartedEvent = object;

export interface InputSpeechStoppedEvent {
  userTranscriptionEnabled: boolean;
}

export interface MessageGeneration {
  messageId: string;
  textStream: ReadableStream<string>;
  audioStream: ReadableStream<AudioFrame>;
  modalities?: Promise<('text' | 'audio')[]>;
}

export interface GenerationCreatedEvent {
  messageStream: ReadableStream<MessageGeneration>;
  functionStream: ReadableStream<FunctionCall>;
  userInitiated: boolean;
}

export interface RealtimeModelError {
  type: 'realtime_model_error';
  timestamp: number;
  label: string;
  error: Error;
  recoverable: boolean;
}

export interface RealtimeCapabilities {
  messageTruncation: boolean;
  turnDetection: boolean;
  userTranscription: boolean;
  autoToolReplyGeneration: boolean;
  audioOutput: boolean;
}

export interface InputTranscriptionCompleted {
  itemId: string;
  transcript: string;
  isFinal: boolean;
}

export interface RealtimeSessionReconnectedEvent {}

export abstract class RealtimeModel {
  private _capabilities: RealtimeCapabilities;

  constructor(capabilities: RealtimeCapabilities) {
    this._capabilities = capabilities;
  }

  get capabilities() {
    return this._capabilities;
  }

  abstract session(): RealtimeSession;

  abstract close(): Promise<void>;
}

export abstract class RealtimeSession extends EventEmitter {
  protected _realtimeModel: RealtimeModel;
  private deferredInputStream = new DeferredReadableStream<AudioFrame>();
  private _mainTask: Task<void>;

  constructor(realtimeModel: RealtimeModel) {
    super();
    this._realtimeModel = realtimeModel;
    this._mainTask = Task.from((controller) => this._mainTaskImpl(controller.signal));
  }

  get realtimeModel() {
    return this._realtimeModel;
  }

  abstract get chatCtx(): ChatContext;

  abstract get tools(): ToolContext;

  abstract updateInstructions(instructions: string): Promise<void>;

  /**
   * @throws RealtimeError on Timeout
   */
  abstract updateChatCtx(chatCtx: ChatContext): Promise<void>;

  abstract updateTools(tools: ToolContext): Promise<void>;

  abstract updateOptions(options: { toolChoice?: ToolChoice | null }): void;

  abstract pushAudio(frame: AudioFrame): void;

  /**
   * @throws RealtimeError on Timeout
   */
  abstract generateReply(instructions?: string): Promise<GenerationCreatedEvent>;

  /**
   * Commit the input audio buffer to the server
   */
  abstract commitAudio(): Promise<void>;

  /**
   * Clear the input audio buffer to the server
   */
  abstract clearAudio(): Promise<void>;

  /**
   * Cancel the current generation (do nothing if no generation is in progress)
   */
  abstract interrupt(): Promise<void>;

  /**
   * Truncate the message at the given audio end time
   */
  abstract truncate(options: {
    messageId: string;
    audioEndMs: number;
    modalities?: ('text' | 'audio')[];
    audioTranscript?: string;
  }): Promise<void>;

  async close(): Promise<void> {
    this._mainTask.cancel();
  }

  /**
   * Notifies the model that user activity has started
   */
  startUserActivity(): void {
    return;
  }

  private async _mainTaskImpl(signal: AbortSignal): Promise<void> {
    const reader = this.deferredInputStream.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) {
        break;
      }
      this.pushAudio(value);
    }
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>): void {
    this.deferredInputStream.setSource(audioStream);
  }
}
