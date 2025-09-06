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

  constructor(
    public sampleRate?: number,
    protected readonly nextInChain?: AudioOutput,
  ) {
    super();
    if (this.nextInChain) {
      this.nextInChain.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (ev: PlaybackFinishedEvent) =>
        this.onPlaybackFinished(ev),
      );
    }
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
}

export interface PlaybackFinishedEvent {
  // How much of the audio was played back
  playbackPosition: number;
  // Interrupted is True if playback was interrupted (clearBuffer() was called)
  interrupted: boolean;
  // Transcript synced with playback; may be partial if the audio was interrupted
  // When null, the transcript is not synchronized with the playback
  synchronizedTranscript?: string;
}

export abstract class TextOutput {
  constructor(protected readonly nextInChain?: TextOutput) {}

  /**
   * Capture a text segment (Used by the output of LLM nodes)
   */
  abstract captureText(text: string): Promise<void>;

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
