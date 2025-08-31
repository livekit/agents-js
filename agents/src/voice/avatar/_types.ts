// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';

/**
 * Marker class to indicate the end of an audio segment
 */
export class AudioSegmentEnd {}

/**
 * Callback types for AudioReceiver events
 */
export type AudioReceiverCallbacks = {
  clear_buffer: () => void;
};

/**
 * Abstract base class for receiving audio data
 */
export abstract class AudioReceiver extends (EventEmitter as new () => TypedEmitter<AudioReceiverCallbacks>) {
  constructor() {
    super();
  }

  /**
   * Start the audio receiver
   */
  async start(): Promise<void> {
    // Default implementation - can be overridden
  }

  /**
   * Notify the sender that playback has finished
   * @param playbackPosition - The position where playback finished
   * @param interrupted - Whether playback was interrupted
   */
  abstract notifyPlaybackFinished(
    playbackPosition: number,
    interrupted: boolean,
  ): void | Promise<void>;

  /**
   * Continuously stream out audio frames or AudioSegmentEnd when the stream ends
   */
  abstract [Symbol.asyncIterator](): AsyncIterator<AudioFrame | AudioSegmentEnd>;

  /**
   * Close the audio receiver
   */
  async aclose(): Promise<void> {
    // Default implementation - can be overridden
  }
}

/**
 * Abstract base class for generating video content
 */
export abstract class VideoGenerator {
  /**
   * Push an audio frame to the video generator
   * @param frame - Audio frame or segment end marker
   */
  abstract pushAudio(frame: AudioFrame | AudioSegmentEnd): Promise<void>;

  /**
   * Clear the audio buffer, stopping audio playback immediately
   */
  abstract clearBuffer(): void | Promise<void>;

  /**
   * Continuously stream out video and audio frames, or AudioSegmentEnd when the audio segment ends
   */
  abstract [Symbol.asyncIterator](): AsyncIterator<VideoFrame | AudioFrame | AudioSegmentEnd>;
} 