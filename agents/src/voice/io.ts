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
import type { SpeechEvent } from '../stt/stt.js';
import { Future } from '../utils.js';

export type STTNode = (
  audio: ReadableStream<AudioFrame>,
  modelSettings: any, // TODO(AJS-59): add type
) => Promise<ReadableStream<SpeechEvent | string> | null>;

export type LLMNode = (
  chatCtx: ChatContext,
  toolCtx: ToolContext,
  modelSettings: any, // TODO(AJS-59): add type
) => Promise<ReadableStream<ChatChunk | string> | null>;

export type TTSNode = (
  text: ReadableStream<string>,
  modelSettings: any, // TODO(AJS-59): add type
) => Promise<ReadableStream<AudioFrame> | null>;
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
    readonly sampleRate?: number,
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
    this.logger.debug(`waitForPlayout started for sub-class ${this.constructor.name}`, {
      target,
      playbackFinishedCount: this.playbackFinishedCount,
    });

    while (this.playbackFinishedCount < target) {
      await this.playbackFinishedFuture.await;
      this.playbackFinishedFuture = new Future();
    }

    this.logger.debug(`waitForPlayout finished for sub-class ${this.constructor.name}`, {
      target,
      playbackFinishedCount: this.playbackFinishedCount,
    });
    return this.lastPlaybackEvent;
  }

  /**
   * Developers building audio sinks must call this method when a playback/segment is finished.
   * Segments are segmented by calls to flush() or clearBuffer()
   */
  onPlaybackFinished(options: PlaybackFinishedEvent) {
    this.logger.debug({ options }, 'onPlaybackFinished in subclass ' + this.constructor.name);
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
  /**
   * Capture a text segment (Used by the output of LLM nodes)
   */
  abstract captureText(text: string): Promise<void>;

  /**
   * Mark the current text segment as complete (e.g LLM generation is complete)
   */
  abstract flush(): void;
}
