// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import type { ReadableStream } from 'node:stream/web';
import { log } from '../log.js';
import { MultiInputStream } from '../stream/multi_input_stream.js';
import { Task } from '../utils.js';
import type { TimedString } from '../voice/io.js';
import type { ChatContext, FunctionCall } from './chat_context.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

export type InputSpeechStartedEvent = object;

export interface InputSpeechStoppedEvent {
  userTranscriptionEnabled: boolean;
}

export interface MessageGeneration {
  messageId: string;
  /**
   * Text stream that may contain plain strings or TimedString objects with timestamps.
   */
  textStream: ReadableStream<string | TimedString>;
  audioStream: ReadableStream<AudioFrame>;
  modalities?: Promise<('text' | 'audio')[]>;
}

export interface GenerationCreatedEvent {
  messageStream: ReadableStream<MessageGeneration>;
  functionStream: ReadableStream<FunctionCall>;
  userInitiated: boolean;
  /** Response ID for correlating metrics with spans */
  responseId?: string;
}

export interface RealtimeModelError {
  type: 'realtime_model_error';
  timestamp: number;
  label: string;
  error: Error;
  recoverable: boolean;
}

export interface RealtimeCapabilities {
  /** Whether generated assistant messages can be truncated after interruption. */
  messageTruncation: boolean;
  /** Whether the model emits server-side speech start and stop events for turn taking. */
  turnDetection: boolean;
  /** Whether the model emits user audio transcription events. */
  userTranscription: boolean;
  /** Whether the model automatically generates a reply after receiving tool results. */
  autoToolReplyGeneration: boolean;
  /** Whether the model can produce audio output directly. */
  audioOutput: boolean;
  /** Whether function call items already in the chat context can be resumed. */
  manualFunctionCalls: boolean;
  /** Whether the chat context can be updated mid-session. */
  midSessionChatCtxUpdate?: boolean;
  /** Whether the instructions can be updated mid-session. */
  midSessionInstructionsUpdate?: boolean;
  /** Whether the tools can be updated mid-session. */
  midSessionToolsUpdate?: boolean;
  /** Whether the tool and tool choice can be specified per response. */
  perResponseToolChoice?: boolean;
  /**
   * Whether the model synchronizes generated transcript timing natively.
   * @deprecated Native transcript synchronization is no longer used by built-in models.
   */
  nativeTranscriptSync?: boolean;
}

export class RealtimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RealtimeError';
    Error.captureStackTrace(this, RealtimeError);
  }
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

  /** The model name/identifier used by this realtime model */
  abstract get model(): string;

  get provider(): string {
    return 'unknown';
  }

  label(): string {
    return 'RealtimeModel';
  }

  abstract session(): RealtimeSession;

  abstract close(): Promise<void>;
}

export abstract class RealtimeSession extends EventEmitter {
  protected _realtimeModel: RealtimeModel;
  protected logger = log();
  private inputAudioStream = new MultiInputStream<AudioFrame>();
  private inputAudioStreamId?: string;
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
  abstract generateReply(
    instructions?: string,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationCreatedEvent>;

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

  async _updateSession(
    instructions?: string,
    chatCtx?: ChatContext,
    tools?: ToolContext,
  ): Promise<void> {
    if (instructions !== undefined) {
      try {
        await this.updateInstructions(instructions);
      } catch (error) {
        this.logger.error(error, 'failed to update the instructions');
      }
    }
    if (chatCtx !== undefined) {
      try {
        await this.updateChatCtx(chatCtx);
      } catch (error) {
        this.logger.error(error, 'failed to update the chat context');
      }
    }
    if (tools !== undefined) {
      try {
        await this.updateTools(tools);
      } catch (error) {
        this.logger.error(error, 'failed to update the tools');
      }
    }
  }

  async close(): Promise<void> {
    this._mainTask.cancel();
    await this.inputAudioStream.close();
  }

  /**
   * Notifies the model that user activity has started
   */
  startUserActivity(): void {
    return;
  }

  private async _mainTaskImpl(signal: AbortSignal): Promise<void> {
    const reader = this.inputAudioStream.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) {
        break;
      }
      this.pushAudio(value);
    }
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>): void {
    if (this.inputAudioStreamId !== undefined) {
      void this.inputAudioStream.removeInputStream(this.inputAudioStreamId);
    }
    this.inputAudioStreamId = this.inputAudioStream.addInputStream(audioStream);
  }
}
