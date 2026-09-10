// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import type { RealtimeModelMetrics } from '../metrics/base.js';
import { Event } from '../utils.js';
import type { ChatContext, ChatItem } from './chat_context.js';
import type { AudioGate } from './duplex_adapter.js';
import { RealtimeError } from './realtime.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

/** One frame of the model's continuous output, including its silence. */
export interface DuplexAudioFrame {
  frame: AudioFrame;
  /** Position on the model's timeline, in milliseconds. */
  startMs?: number;
}

/** A fragment of the model's transcript of its own speech. */
export interface DuplexOutputTranscriptDelta {
  text: string;
  /** Start of the fragment on the model's timeline, in milliseconds. */
  startMs?: number;
  /** End of the fragment on the model's timeline, in milliseconds. */
  endMs?: number;
}

/** Capabilities that vary between duplex providers. */
export interface DuplexCapabilities {
  userTranscription: boolean;
  autoToolReplyGeneration: boolean;
  midSessionChatCtxUpdate?: boolean;
  midSessionInstructionsUpdate?: boolean;
  midSessionToolsUpdate?: boolean;
}

/** A speech model that listens and speaks at once and handles its own interruptions. */
export abstract class DuplexModel {
  constructor(readonly capabilities: DuplexCapabilities) {}

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'unknown';
  }

  label(): string {
    return this.constructor.name;
  }

  /** Return a new gate for this model's output, or let the adapter infer one. */
  audioGate(): AudioGate | undefined {
    return undefined;
  }

  abstract session(): DuplexSession;

  abstract close(): Promise<void>;
}

/**
 * A provider session with continuous audio output.
 *
 * Emits `transcript_delta`, `function_call`, `input_speech_started`, `input_speech_stopped`,
 * `input_audio_transcription_completed`, `session_reconnected`, `metrics_collected`, and `error`.
 * Provider-specific APIs are accessible through `Agent.duplexSession`.
 */
export abstract class DuplexSession extends EventEmitter {
  /** Wait for complete startup configuration before connecting an immutable model. */
  protected readonly _configured: {
    readonly isSet: boolean;
    wait(): Promise<boolean>;
    set(): void;
  } = new Event();

  constructor(readonly duplexModel: DuplexModel) {
    super();
  }

  get capabilities(): DuplexCapabilities {
    return this.duplexModel.capabilities;
  }

  abstract get audioStream(): ReadableStream<DuplexAudioFrame>;
  abstract get tools(): ToolContext;
  abstract pushAudio(frame: AudioFrame): void;

  pushVideo(_frame: VideoFrame): void {}

  /** Release `_configured` before waiting for a connection task during close. */
  abstract close(): Promise<void>;

  abstract _updateInstructions(instructions: string): Promise<void>;
  abstract _appendItems(items: ChatItem[]): Promise<void>;
  abstract _updateTools(tools: ToolContext): Promise<void>;
  abstract _updateOptions(options: { toolChoice?: ToolChoice | null }): void;

  /** Ask the model to speak; its next speech is the reply. Providers may override this. */
  _generateReply(
    _instructions?: string,
    _options?: { toolChoice?: ToolChoice; tools?: ToolContext },
  ): void {
    throw new RealtimeError(`${this.constructor.name} decides for itself when to speak`);
  }

  async _updateSession(
    instructions?: string,
    chatCtx?: ChatContext,
    tools?: ToolContext,
  ): Promise<void> {
    if (instructions !== undefined) await this._updateInstructions(instructions);
    if (chatCtx !== undefined) await this._appendItems(chatCtx.items);
    if (tools !== undefined) await this._updateTools(tools);
    this._configured.set();
  }

  /** Report connection acquisition time in milliseconds, with zero token usage. */
  protected _reportConnectionAcquired(acquireTimeMs: number): void {
    const metrics: RealtimeModelMetrics = {
      type: 'realtime_model_metrics',
      label: this.duplexModel.label(),
      requestId: '',
      timestamp: Date.now(),
      durationMs: 0,
      ttftMs: -1,
      cancelled: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokensPerSecond: 0,
      acquireTimeMs,
      connectionReused: false,
      inputTokenDetails: { audioTokens: 0, textTokens: 0, imageTokens: 0, cachedTokens: 0 },
      outputTokenDetails: { audioTokens: 0, textTokens: 0, imageTokens: 0 },
      metadata: { modelName: this.duplexModel.model, modelProvider: this.duplexModel.provider },
    };
    this.emit('metrics_collected', metrics);
  }
}
