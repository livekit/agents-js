// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { AudioOutput } from '../io.js';

/**
 * Sentinel value pushed onto the {@link QueueAudioOutput} stream when a segment of agent
 * speech has finished (i.e. `flush()` was called). Consumers should treat it as an
 * end-of-segment marker and emit the corresponding "speech ended" signal on their
 * downstream protocol (websocket, RPC, etc.).
 *
 * Ref: python livekit-agents/livekit/agents/voice/avatar/_types.py (AudioSegmentEnd)
 */
export class AudioSegmentEnd {}

/**
 * One value emitted by {@link QueueAudioOutput.stream}: either an {@link AudioFrame}
 * or an {@link AudioSegmentEnd} sentinel marking the end of a speech segment.
 */
export type QueueAudioOutputItem = AudioFrame | AudioSegmentEnd;

/**
 * Payload emitted with the {@link QueueAudioOutput} `'clear_buffer'` event.
 *
 * `wasCapturing` is set synchronously inside {@link QueueAudioOutput.clearBuffer}
 * based on whether {@link QueueAudioOutput.captureFrame} had been called for the
 * current segment. Consumers should use this — not their own asynchronous
 * "is the avatar speaking?" flag — to decide whether to call
 * {@link QueueAudioOutput.notifyPlaybackFinished}, otherwise an interrupt that
 * lands in the window between `captureFrame` and the consumer's reader can leak
 * `playbackSegmentsCount > playbackFinishedCount` and deadlock
 * {@link AudioOutput.waitForPlayout}.
 */
export interface QueueAudioOutputClearEvent {
  wasCapturing: boolean;
}

/**
 * AudioOutput implementation that buffers agent speech frames into a stream/queue so
 * they can be consumed by an external transport (e.g. a custom websocket protocol used
 * by an avatar plugin). Frames captured via {@link captureFrame} flow through the
 * underlying stream as-is; on {@link flush} an {@link AudioSegmentEnd} sentinel is
 * appended; on {@link clearBuffer} a `'clear_buffer'` event is emitted with a
 * {@link QueueAudioOutputClearEvent} payload so the consumer can drop any in-flight
 * bytes and notify upstream of an interruption.
 *
 * Mirrors Python's `livekit.agents.voice.avatar.QueueAudioOutput`.
 *
 * Ref: python livekit-agents/livekit/agents/voice/avatar/_queue_io.py
 */
export class QueueAudioOutput extends AudioOutput {
  private readonly channel: StreamChannel<QueueAudioOutputItem> =
    createStreamChannel<QueueAudioOutputItem>();
  private startedSegment = false;

  constructor(sampleRate?: number) {
    super(sampleRate, undefined, { pause: false });
  }

  /**
   * Returns the underlying readable stream of audio frames + end-of-segment sentinels.
   *
   * Each call returns the same shared stream; do not split between concurrent readers.
   */
  stream(): ReturnType<StreamChannel<QueueAudioOutputItem>['stream']> {
    return this.channel.stream();
  }

  /** True once {@link aclose} has been called. */
  get closed(): boolean {
    return this.channel.closed;
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.startedSegment = true;
    if (!this.channel.closed) {
      await this.channel.write(frame);
    }
  }

  override flush(): void {
    super.flush();
    if (this.startedSegment && !this.channel.closed) {
      // Best-effort write — the consumer drains on its own loop.
      void this.channel.write(new AudioSegmentEnd()).catch(() => {
        // channel closed concurrently; safe to drop the sentinel.
      });
      this.startedSegment = false;
    }
  }

  override clearBuffer(): void {
    // Capture the in-flight state synchronously so consumers can race-free decide
    // whether to fire `notifyPlaybackFinished` (and avoid leaking the base class's
    // `playbackSegmentsCount > playbackFinishedCount` bookkeeping).
    const wasCapturing = this.startedSegment;
    this.startedSegment = false;
    // Always close an in-flight segment with an AudioSegmentEnd sentinel.
    // The producer (e.g. the AgentSession forward-audio task) typically calls
    // `flush()` *after* `clearBuffer()` once the segment is aborted, but at
    // that point `startedSegment` is already `false` and `flush()` is a no-op
    // for the sentinel write. Without writing it here, a downstream consumer
    // that uses the sentinel as a "drop stale frames" reset signal would
    // never see a boundary for the interrupted segment and would silently
    // drop the entire next segment's audio.
    if (wasCapturing && !this.channel.closed) {
      void this.channel.write(new AudioSegmentEnd()).catch(() => {
        // channel closed concurrently; safe to drop the sentinel.
      });
    }
    this.emit('clear_buffer', { wasCapturing } satisfies QueueAudioOutputClearEvent);
  }

  /** Close the underlying stream so consumers see a graceful end-of-stream. */
  async aclose(): Promise<void> {
    if (!this.channel.closed) {
      await this.channel.close();
    }
  }

  /**
   * Convenience wrapper around {@link AudioOutput.onPlaybackStarted} so a remote
   * transport can announce "first byte played" without needing access to the
   * protected method.
   */
  notifyPlaybackStarted(createdAt: number = Date.now()): void {
    this.onPlaybackStarted(createdAt);
  }

  /**
   * Convenience wrapper around {@link AudioOutput.onPlaybackFinished} so a remote
   * transport can announce segment completion (or interruption) without needing
   * access to the protected method.
   */
  notifyPlaybackFinished(playbackPosition: number, interrupted: boolean): void {
    this.onPlaybackFinished({ playbackPosition, interrupted });
  }
}
