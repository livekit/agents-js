// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import type { EventMap, TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import type { LLMMetrics, RealtimeModelMetrics } from '../metrics/base.js';
import { Event } from '../utils.js';
import type { ChatContext, ChatItem, FunctionCall } from './chat_context.js';
import type { AudioGate } from './duplex_adapter.js';
import {
  type InputSpeechStartedEvent,
  type InputSpeechStoppedEvent,
  type InputTranscriptionCompleted,
  RealtimeError,
  type RealtimeModelError,
  type RealtimeSessionReconnectedEvent,
} from './realtime.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

/** One frame of the model's continuous output, including its silence. */
export interface DuplexAudioFrame {
  /** PCM audio to play or use to detect a silence boundary. */
  frame: AudioFrame;
  /** Position on the model's timeline, in milliseconds. */
  startMs?: number;
}

/** A fragment of the model's transcript of its own speech. */
export interface DuplexOutputTranscriptDelta {
  /** Text to append to the model's output transcript. */
  text: string;
  /** Start of the fragment on the model's timeline, in milliseconds. */
  startMs?: number;
  /** End of the fragment on the model's timeline, in milliseconds. */
  endMs?: number;
}

/** Capabilities that vary between duplex providers. */
export interface DuplexCapabilities {
  /** The provider emits transcripts of the user's audio. */
  userTranscription: boolean;
  /** The provider starts its next reply after receiving tool results. */
  autoToolReplyGeneration: boolean;
  /** The provider accepts appended chat items after startup. Defaults to false. */
  midSessionChatCtxUpdate?: boolean;
  /** The provider accepts instruction changes after startup. Defaults to false. */
  midSessionInstructionsUpdate?: boolean;
  /** The provider accepts tool changes after startup. Defaults to false. */
  midSessionToolsUpdate?: boolean;
}

/**
 * A speech model that listens and speaks at once and handles its own interruptions.
 *
 * Chat context updates append new items. Edits and removals change the framework's local
 * history; the provider retains the content it has already received.
 */
export abstract class DuplexModel {
  /** Declare the provider features available to the framework. */
  constructor(
    /** Provider features used to configure the realtime adapter. */
    readonly capabilities: DuplexCapabilities,
  ) {}

  /** Model identifier reported in metrics. */
  get model(): string {
    return 'unknown';
  }

  /** Provider identifier reported in metrics. */
  get provider(): string {
    return 'unknown';
  }

  /** Display label used in logs and metrics. */
  label(): string {
    return this.constructor.name;
  }

  /** Return a new gate for this model's output, or let the adapter infer one. */
  audioGate(): AudioGate | undefined {
    return undefined;
  }

  /** Create a session. The framework applies its startup configuration after this returns. */
  abstract session(): DuplexSession;

  /** Release resources shared by this model's sessions. */
  abstract close(): Promise<void>;
}

/** Events emitted by every duplex provider session. */
export type DuplexSessionCallbacks = {
  /** A fragment of the model's output transcript became available. */
  transcript_delta: (event: DuplexOutputTranscriptDelta) => void;
  /** The model requested a tool call. */
  function_call: (event: FunctionCall) => void;
  /** The provider detected the start of user speech. */
  input_speech_started: (event: InputSpeechStartedEvent) => void;
  /** The provider detected the end of user speech. */
  input_speech_stopped: (event: InputSpeechStoppedEvent) => void;
  /** A partial or final user transcript became available. */
  input_audio_transcription_completed: (event: InputTranscriptionCompleted) => void;
  /** The provider reconnected; output from its previous connection is abandoned. */
  session_reconnected: (event: RealtimeSessionReconnectedEvent) => void;
  /** The provider reported connection timing or model usage. */
  metrics_collected: (event: RealtimeModelMetrics | LLMMetrics) => void;
  /** The provider reported an error and whether the session can recover. */
  error: (event: RealtimeModelError) => void;
};

/**
 * A provider session with continuous audio output.
 *
 * `Events` adds provider-specific callbacks to {@link DuplexSessionCallbacks}.
 * Provider-specific APIs are accessible through `Agent.duplexSession`.
 */
export abstract class DuplexSession<
  Events extends EventMap = Record<never, never>,
> extends (EventEmitter as new <Events extends EventMap>() => TypedEmitter<
  Omit<Events, keyof DuplexSessionCallbacks>
> &
  TypedEmitter<DuplexSessionCallbacks>)<Events> {
  /** Closing has started; a released configuration wait must not start a new connection. */
  protected _closing = false;

  /** Wait for startup configuration, then check `_closing` before connecting. */
  protected readonly _configured: {
    readonly isSet: boolean;
    wait(): Promise<boolean>;
    set(): void;
  } = new Event();

  /** Create a provider session owned by the given model. */
  constructor(
    /** Model that created this session. */
    readonly duplexModel: DuplexModel,
  ) {
    super();
  }

  /** Provider features declared by the owning model. */
  get capabilities(): DuplexCapabilities {
    return this.duplexModel.capabilities;
  }

  /** Continuous output audio, including silence, delivered at playback pace. */
  abstract get audioStream(): ReadableStream<DuplexAudioFrame>;
  /** Tools currently available to the provider. */
  abstract get tools(): ToolContext;
  /** Feed an input audio frame to the provider. */
  abstract pushAudio(frame: AudioFrame): void;

  /** Feed an input video frame. Providers without video input can ignore it. */
  pushVideo(_frame: VideoFrame): void {}

  /** Mark the session closing, release configuration waits, and close provider resources. */
  async close(): Promise<void> {
    this._closing = true;
    this._configured.set();
    await this.closeConnection();
  }

  /** Close provider tasks, streams, and connections after the configuration wait is released. */
  protected abstract closeConnection(): Promise<void>;

  /** Apply instructions, or reject changes the provider cannot accept. */
  abstract _updateInstructions(instructions: string): Promise<void>;
  /** Append chat items to the provider's context. */
  abstract _appendItems(items: ChatItem[]): Promise<void>;
  /** Replace the tools available to the provider. */
  abstract _updateTools(tools: ToolContext): Promise<void>;
  /** Apply provider options used for subsequent replies. */
  abstract _updateOptions(options: { toolChoice?: ToolChoice | null }): void;

  /** Ask the model to speak; its next speech is the reply. Providers may override this. */
  _generateReply(
    _instructions?: string,
    _options?: { toolChoice?: ToolChoice; tools?: ToolContext },
  ): void {
    throw new RealtimeError(`${this.constructor.name} decides for itself when to speak`);
  }

  /** Apply the complete startup configuration before releasing a waiting provider connection. */
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

  /**
   * Report connection acquisition time in milliseconds, with zero token usage.
   * This connection event has no response to correlate, so its `requestId` is empty.
   */
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
