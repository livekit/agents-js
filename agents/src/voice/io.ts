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
import { MultiInputStream } from '../stream/multi_input_stream.js';
import type { SpeechEvent } from '../stt/stt.js';
import type { FlushSentinel } from '../types.js';
import { Future } from '../utils.js';
import type { ModelSettings } from './agent.js';

export type STTNode = (
  audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
  modelSettings: ModelSettings,
) => Promise<ReadableStream<SpeechEvent | string> | null>;

export type LLMNode = (
  chatCtx: ChatContext,
  toolCtx: ToolContext,
  modelSettings: ModelSettings,
) => Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null>;

export type TTSNode = (
  text: ReadableStream<string> | AsyncIterable<string>,
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
  speakerId?: string | null;
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
  speakerId?: string | null;
}): TimedString {
  return {
    [TIMED_STRING_SYMBOL]: true,
    text: opts.text,
    startTime: opts.startTime,
    endTime: opts.endTime,
    confidence: opts.confidence,
    startTimeOffset: opts.startTimeOffset,
    speakerId: opts.speakerId ?? null,
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
  protected multiStream: MultiInputStream<AudioFrame> = new MultiInputStream<AudioFrame>();

  get stream(): ReadableStream<AudioFrame> {
    return this.multiStream.stream;
  }

  async close(): Promise<void> {
    await this.multiStream.close();
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
  protected _nextInChain?: AudioOutput;

  constructor(
    public sampleRate?: number,
    nextInChain?: AudioOutput,
    capabilities: AudioOutputCapabilities = { pause: false },
  ) {
    super();
    this.capabilities = capabilities;

    if (
      nextInChain !== undefined &&
      nextInChain.nextInChain === undefined &&
      !(nextInChain instanceof AudioSinkProxy)
    ) {
      nextInChain = new AudioSinkProxy(nextInChain);
    }

    this._nextInChain = nextInChain;

    if (this.nextInChain) {
      this.nextInChain.on(AudioOutput.EVENT_PLAYBACK_STARTED, this.forwardNextPlaybackStarted);
      this.nextInChain.on(AudioOutput.EVENT_PLAYBACK_FINISHED, this.forwardNextPlaybackFinished);
    }
  }

  get nextInChain(): AudioOutput | undefined {
    return this._nextInChain;
  }

  protected forwardNextPlaybackStarted = (ev: PlaybackStartedEvent) => {
    this.onPlaybackStarted(ev.createdAt);
  };

  protected forwardNextPlaybackFinished = (ev: PlaybackFinishedEvent) => {
    this.onPlaybackFinished(ev);
  };

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
   * Playback segments captured but not yet finished. Used by chained outputs to detect and
   * reconcile a segment-count drift against the next output in the chain.
   * @internal
   */
  get pendingPlayoutSegments(): number {
    return this.playbackSegmentsCount - this.playbackFinishedCount;
  }

  /**
   * Monotonic count of playback segments ever captured. Lets chained outputs detect — free of
   * races with concurrent finishes — whether this output accepted a segment they forwarded.
   * @internal
   */
  get capturedPlayoutSegments(): number {
    return this.playbackSegmentsCount;
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

class AudioSinkProxy extends AudioOutput {
  private attached: boolean = false;
  private capturing: boolean = false;
  private pushedDuration: number = 0;

  constructor(nextInChain: AudioOutput) {
    super(undefined, undefined, { pause: true });
    this.setNextInChain(nextInChain);
  }

  override get nextInChain(): AudioOutput {
    if (this._nextInChain === undefined) {
      throw new Error('AudioSinkProxy has no downstream sink');
    }
    return this._nextInChain;
  }

  override get canPause(): boolean {
    return this.nextInChain.canPause;
  }

  override onAttached(): void {
    this.attached = true;
    super.onAttached();
  }

  override onDetached(): void {
    this.attached = false;
    super.onDetached();
  }

  setNextInChain(sink: AudioOutput): void {
    if (sink === this._nextInChain) return;

    const oldSink = this._nextInChain;
    if (oldSink !== undefined) {
      oldSink.off(AudioOutput.EVENT_PLAYBACK_STARTED, this.forwardNextPlaybackStarted);
      oldSink.off(AudioOutput.EVENT_PLAYBACK_FINISHED, this.forwardNextPlaybackFinished);
      if (this.pendingPlayoutSegments > 0) {
        oldSink.clearBuffer();
      }
      if (this.attached) {
        oldSink.onDetached();
      }
    }

    this._nextInChain = sink;
    this.sampleRate = sink.sampleRate;
    sink.on(AudioOutput.EVENT_PLAYBACK_STARTED, this.forwardNextPlaybackStarted);
    sink.on(AudioOutput.EVENT_PLAYBACK_FINISHED, this.forwardNextPlaybackFinished);
    if (this.attached) {
      sink.onAttached();
    }

    if (oldSink !== undefined && this.pendingPlayoutSegments > 0 && !this.capturing) {
      this.onPlaybackFinished({ playbackPosition: this.pushedDuration, interrupted: true });
    }
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (!this.capturing) {
      this.capturing = true;
      this.pushedDuration = 0;
    }

    await super.captureFrame(frame);
    await this.nextInChain.captureFrame(frame);
    this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
  }

  override flush(): void {
    super.flush();
    this.nextInChain.flush();
    this.capturing = false;
  }

  override clearBuffer(): void {
    this.nextInChain.clearBuffer();
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

  replaceAudioTail(sink: AudioOutput): void {
    let current = this._audioSink;
    while (current !== null && current !== undefined) {
      if (current instanceof AudioSinkProxy) {
        current.setNextInChain(sink);
        return;
      }
      current = current.nextInChain ?? null;
    }
    this.audio = sink;
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
