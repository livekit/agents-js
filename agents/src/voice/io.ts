// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import type { ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import type { SpeechEvent } from '../stt/stt.js';
import { Future } from '../utils.js';
import type { ModelSettings } from './agent.js';

export type STTNode = (
  audio: ReadableStream<AudioFrame>,
  modelSettings: ModelSettings,
) => Promise<ReadableStream<SpeechEvent | string> | null>;

export type LLMNode = (
  chatCtx: ChatContext,
  toolCtx: ToolContext,
  modelSettings: ModelSettings,
) => Promise<ReadableStream<ChatChunk | string> | null>;

export type TTSNode = (
  text: ReadableStream<string>,
  modelSettings: ModelSettings,
) => Promise<ReadableStream<AudioFrame> | null>;

/**
 * Symbol used to identify TimedString objects.
 */
export const TIMED_STRING_SYMBOL = Symbol.for('lk.TimedString');

/**
 * A string with optional start and end timestamps for word-level alignment.
 */
export interface TimedString {
  readonly [TIMED_STRING_SYMBOL]: true;
  text: string;
  startTime?: number; // seconds
  endTime?: number; // seconds
  confidence?: number;
  startTimeOffset?: number;
}

/**
 * Factory function to create a TimedString object.
 */
export function createTimedString(opts: {
  text: string;
  startTime?: number;
  endTime?: number;
  confidence?: number;
  startTimeOffset?: number;
}): TimedString {
  return {
    [TIMED_STRING_SYMBOL]: true,
    text: opts.text,
    startTime: opts.startTime,
    endTime: opts.endTime,
    confidence: opts.confidence,
    startTimeOffset: opts.startTimeOffset,
  };
}

/**
 * Type guard to check if a value is a TimedString.
 */
export function isTimedString(value: unknown): value is TimedString {
  return (
    typeof value === 'object' &&
    value !== null &&
    TIMED_STRING_SYMBOL in value &&
    (value as TimedString)[TIMED_STRING_SYMBOL] === true
  );
}

export interface AudioOutputCapabilities {
  /** Whether this output supports pause/resume functionality */
  pause: boolean;
}

export abstract class AudioInput {
  protected deferredStream: DeferredReadableStream<AudioFrame> =
    new DeferredReadableStream<AudioFrame>();

  get stream(): ReadableStream<AudioFrame> {
    return this.deferredStream.stream;
  }

  onAttached(): void {}

  onDetached(): void {}
}

export abstract class AudioOutput extends EventEmitter {
  static readonly EVENT_PLAYBACK_STARTED = 'playbackStarted';
  static readonly EVENT_PLAYBACK_FINISHED = 'playbackFinished';

  private playbackFinishedFuture: Future<void> = new Future();
  private _capturing: boolean = false;
  private playbackFinishedCount: number = 0;
  private playbackSegmentsCount: number = 0;
  private lastPlaybackEvent: PlaybackFinishedEvent = {
    playbackPosition: 0,
    interrupted: false,
  };
  protected logger = log();
  protected readonly capabilities: AudioOutputCapabilities;

  constructor(
    public sampleRate?: number,
    protected readonly nextInChain?: AudioOutput,
    capabilities: AudioOutputCapabilities = { pause: false },
  ) {
    super();
    this.capabilities = capabilities;

    if (this.nextInChain) {
      this.nextInChain.on(AudioOutput.EVENT_PLAYBACK_STARTED, (ev: PlaybackStartedEvent) =>
        this.onPlaybackStarted(ev.createdAt),
      );
      this.nextInChain.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (ev: PlaybackFinishedEvent) =>
        this.onPlaybackFinished(ev),
      );
    }
  }

  /**
   * Whether this output and all outputs in the chain support pause/resume.
   */
  get canPause(): boolean {
    return this.capabilities.pause && (this.nextInChain?.canPause ?? true);
  }

  /**
   * Capture an audio frame for playback, frames can be pushed faster than real-time
   */
  async captureFrame(_frame: AudioFrame): Promise<void> {
    if (!this._capturing) {
      this._capturing = true;
      this.playbackSegmentsCount++;
    }
  }

  /**
   * Wait for the past audio segments to finish playing out.
   *
   * @returns The event that was emitted when the audio finished playing out (only the last segment information)
   */
  async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    const target = this.playbackSegmentsCount;

    while (this.playbackFinishedCount < target) {
      await this.playbackFinishedFuture.await;
      this.playbackFinishedFuture = new Future();
    }

    return this.lastPlaybackEvent;
  }

  /**
   * Called when playback actually starts (first frame is sent to output).
   * Developers building audio sinks should call this when the first frame is captured.
   */
  onPlaybackStarted(createdAt: number): void {
    this.emit(AudioOutput.EVENT_PLAYBACK_STARTED, { createdAt } as PlaybackStartedEvent);
  }

  /**
   * Developers building audio sinks must call this method when a playback/segment is finished.
   * Segments are segmented by calls to flush() or clearBuffer()
   */
  onPlaybackFinished(options: PlaybackFinishedEvent) {
    if (this.playbackFinishedCount >= this.playbackSegmentsCount) {
      this.logger.warn('playback_finished called more times than playback segments were captured');
      return;
    }

    this.lastPlaybackEvent = options;
    this.playbackFinishedCount++;
    this.playbackFinishedFuture.resolve();
    this.emit(AudioOutput.EVENT_PLAYBACK_FINISHED, options);
  }

  flush(): void {
    this._capturing = false;
  }

  /**
   * Clear the buffer, stopping playback immediately
   */
  abstract clearBuffer(): void;

  onAttached(): void {
    if (this.nextInChain) {
      this.nextInChain.onAttached();
    }
  }

  onDetached(): void {
    if (this.nextInChain) {
      this.nextInChain.onDetached();
    }
  }

  /**
   * Pause the audio playback
   */
  pause(): void {
    if (this.nextInChain) {
      this.nextInChain.pause();
    }
  }

  /**
   * Resume the audio playback
   */
  resume(): void {
    if (this.nextInChain) {
      this.nextInChain.resume();
    }
  }
}

export interface PlaybackFinishedEvent {
  /** How much of the audio was played back, in seconds */
  playbackPosition: number;
  /** True if playback was interrupted (clearBuffer() was called) */
  interrupted: boolean;
  /**
   * Transcript synced with playback; may be partial if the audio was interrupted.
   * When undefined, the transcript is not synchronized with the playback.
   */
  synchronizedTranscript?: string;
}

export interface PlaybackStartedEvent {
  /** The timestamp (Date.now()) when the playback started */
  createdAt: number;
}

export abstract class TextOutput {
  constructor(protected readonly nextInChain?: TextOutput) {}

  abstract captureText(text: string | TimedString): Promise<void>;

  /**
   * Mark the current text segment as complete (e.g LLM generation is complete)
   */
  abstract flush(): void;

  onAttached(): void {
    if (this.nextInChain) {
      this.nextInChain.onAttached();
    }
  }

  onDetached(): void {
    if (this.nextInChain) {
      this.nextInChain.onDetached();
    }
  }
}

export class AgentInput {
  private _audioStream: AudioInput | null = null;
  // enabled by default
  private _audioEnabled: boolean = true;

  constructor(private readonly audioChanged: () => void) {}

  setAudioEnabled(enable: boolean): void {
    if (enable === this._audioEnabled) {
      return;
    }

    this._audioEnabled = enable;

    if (!this._audioStream) {
      return;
    }

    if (enable) {
      this._audioStream.onAttached();
    } else {
      this._audioStream.onDetached();
    }
  }

  get audioEnabled(): boolean {
    return this._audioEnabled;
  }

  get audio(): AudioInput | null {
    return this._audioStream;
  }

  set audio(stream: AudioInput | null) {
    this._audioStream = stream;
    this.audioChanged();
  }
}

export class AgentOutput {
  private _audioSink: AudioOutput | null = null;
  private _transcriptionSink: TextOutput | null = null;
  private _audioEnabled: boolean = true;
  private _transcriptionEnabled: boolean = true;

  constructor(
    private readonly audioChanged: () => void,
    private readonly transcriptionChanged: () => void,
  ) {}

  setAudioEnabled(enabled: boolean): void {
    if (enabled === this._audioEnabled) {
      return;
    }

    this._audioEnabled = enabled;

    if (!this._audioSink) {
      return;
    }

    if (enabled) {
      this._audioSink.onAttached();
    } else {
      this._audioSink.onDetached();
    }
  }

  setTranscriptionEnabled(enabled: boolean): void {
    if (enabled === this._transcriptionEnabled) {
      return;
    }

    this._transcriptionEnabled = enabled;

    if (!this._transcriptionSink) {
      return;
    }

    if (enabled) {
      this._transcriptionSink.onAttached();
    } else {
      this._transcriptionSink.onDetached();
    }
  }

  get audioEnabled(): boolean {
    return this._audioEnabled;
  }

  get transcriptionEnabled(): boolean {
    return this._transcriptionEnabled;
  }

  get audio(): AudioOutput | null {
    return this._audioSink;
  }

  set audio(sink: AudioOutput | null) {
    if (sink === this._audioSink) {
      return;
    }

    if (this._audioSink) {
      this._audioSink.onDetached();
    }

    this._audioSink = sink;
    this.audioChanged();

    if (this._audioSink) {
      this._audioSink.onAttached();
    }
  }

  get transcription(): TextOutput | null {
    return this._transcriptionSink;
  }

  set transcription(sink: TextOutput | null) {
    if (sink === this._transcriptionSink) {
      return;
    }

    if (this._transcriptionSink) {
      this._transcriptionSink.onDetached();
    }

    this._transcriptionSink = sink;
    this.transcriptionChanged();

    if (this._transcriptionSink) {
      this._transcriptionSink.onAttached();
    }
  }
}
