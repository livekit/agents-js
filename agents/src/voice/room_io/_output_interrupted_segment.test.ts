// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { ParticipantAudioOutput } from './_output.js';

const SAMPLE_RATE = 24000;
const FRAME_MS = 20;

/** `marker` identifies which reply produced the frame once it reaches the wire. */
function frame(marker: number): AudioFrame {
  const samples = (SAMPLE_RATE * FRAME_MS) / 1000;
  const data = new Int16Array(samples);
  data[0] = marker;
  return new AudioFrame(data, SAMPLE_RATE, 1, samples);
}

/** The real output; only track publishing is skipped (no LiveKit server in a unit test). */
class TestOutput extends ParticipantAudioOutput {
  constructor() {
    super({} as Room, {
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      trackPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
      queueSizeMs: 100_000,
    });
    (this as unknown as { startedFuture: { resolve: () => void } }).startedFuture.resolve();
  }

  override async start(): Promise<void> {}
}

/** Records the marker of every frame that reaches the wire. */
function wireMarkers(out: ParticipantAudioOutput): number[] {
  const source = (
    out as unknown as { audioSource: { captureFrame: (f: AudioFrame) => Promise<void> } }
  ).audioSource;
  const original = source.captureFrame.bind(source);
  const markers: number[] = [];
  source.captureFrame = async (f: AudioFrame) => {
    markers.push(f.data[0]!);
    return original(f);
  };
  return markers;
}

describe('a committed barge-in with TTS audio still in flight', () => {
  /**
   * Real TTS delivers several seconds of audio ahead of realtime, so at the moment of a barge-in
   * the interrupted reply's `forwardAudio` loop is still holding a backlog of already-synthesized
   * frames. It stays alive for the whole of the reply task's
   * `cancelAndWait(forwardTasks, REPLY_TASK_CANCEL_TIMEOUT)`, and only flushes in its `finally`
   * after that — well after `cancelSpeechPause` has un-gated the sink for the next reply.
   *
   * `captureFrame` only consults `interruptCount` while the pause gate is closed, so every one of
   * those backlog frames takes the open-gate path and reaches the wire while the next reply's
   * transcript is already streaming. That is the audio/transcript desync.
   */
  it('does not put the interrupted reply’s backlog on the wire', async () => {
    const out = new TestOutput();
    const markers = wireMarkers(out);

    // Reply A is playing.
    await out.captureFrame(frame(1));

    // The user barges in: VAD pauses the sink, then the commit clears and un-gates it.
    out.pause();
    out.clearBuffer();
    out.resume();

    // Reply A's forwarding loop has not noticed the abort yet and drains its backlog.
    await out.captureFrame(frame(1));
    await out.captureFrame(frame(1));

    expect(markers.filter((m) => m === 1)).toHaveLength(1);

    await out.close();
  });

  /** Control: once reply A's forwarding loop unwinds and flushes, reply B must be audible. */
  it('plays the next reply after the interrupted one flushes', async () => {
    const out = new TestOutput();
    const markers = wireMarkers(out);

    await out.captureFrame(frame(1));

    out.pause();
    out.clearBuffer();
    out.resume();

    await out.captureFrame(frame(1));

    // `forwardAudio` flushes in a `finally`, closing the interrupted segment.
    out.flush();

    await out.captureFrame(frame(2));
    await out.captureFrame(frame(2));

    expect(markers.filter((m) => m === 2)).toHaveLength(2);

    await out.close();
  });
});
