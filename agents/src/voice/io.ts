// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import type { ToolContext } from '../llm/tool_context.js';
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
export abstract class AudioOutput {
  private playbackFinishedFuture: Future<void> = new Future();
  private capturing: boolean = false;
  private playbackFinishedCount: number = 0;
  private playbackSegmentsCount: number = 0;
  private lastPlaybackEvent: PlaybackFinishedEvent = {
    playbackPosition: 0,
    interrupted: false,
  };

  constructor(protected readonly sampleRate?: number) {}

  /**
   * Capture an audio frame for playback, frames can be pushed faster than real-time
   */
  async captureFrame(_frame: AudioFrame): Promise<void> {
    if (!this.capturing) {
      this.capturing = true;
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
  onPlaybackFinished(event: PlaybackFinishedEvent) {
    this.lastPlaybackEvent = event;
    this.playbackFinishedCount++;
    this.playbackFinishedFuture.resolve();
  }

  flush(): void {
    this.capturing = false;
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
