// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { type _AudioOut, hasOwnPlaybackEvidence, performAudioForwarding } from './generation.js';
import { AudioOutput } from './io.js';

function frame(durationMs = 20, sampleRate = 24000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

// Counts segments but never emits PLAYBACK_STARTED on its own — stands in for a
// remote (avatar) output whose started notification arrives out of band, so tests
// can emit events at chosen moments via `onPlaybackStarted`.
class SilentOutput extends AudioOutput {
  constructor() {
    super(24000);
  }
  flush(): void {
    super.flush();
  }
  clearBuffer(): void {}
}

// Emits PLAYBACK_STARTED synchronously inside the first captureFrame, like
// ParticipantAudioOutput.
class EmittingOutput extends AudioOutput {
  private started = false;
  constructor() {
    super(24000);
  }
  async captureFrame(f: AudioFrame): Promise<void> {
    await super.captureFrame(f);
    if (!this.started) {
      this.started = true;
      this.onPlaybackStarted(Date.now());
    }
  }
  flush(): void {
    super.flush();
  }
  clearBuffer(): void {}
}

// Mimics RecorderAudioOutput's ordering: forwards to the leaf (which emits
// PLAYBACK_STARTED synchronously inside its first capture) BEFORE counting its
// own segment, so the forwarded event fires while this output's counter still
// reads the pre-capture snapshot.
class ForwardFirstWrapper extends AudioOutput {
  constructor(private leaf: EmittingOutput) {
    super(24000, leaf);
  }
  async captureFrame(f: AudioFrame): Promise<void> {
    await this.leaf.captureFrame(f);
    await super.captureFrame(f);
  }
  flush(): void {
    super.flush();
    this.leaf.flush();
  }
  clearBuffer(): void {
    this.leaf.clearBuffer();
  }
}

function forwardFrames(
  audioOutput: AudioOutput,
  frames: AudioFrame[],
): { done: Promise<void>; out: _AudioOut; controller: AbortController } {
  const stream = new ReadableStream<AudioFrame>({
    start(streamController) {
      for (const f of frames) streamController.enqueue(f);
      streamController.close();
    },
  });
  const controller = new AbortController();
  const [task, out] = performAudioForwarding(stream, audioOutput, controller);
  return { done: task.result, out, controller };
}

function settle(out: _AudioOut): void {
  if (!out.firstFrameFut.done) {
    out.firstFrameFut.reject(new Error('test done'));
  }
  out.firstFrameFut.await.catch(() => {});
}

describe('playback-started segment attribution', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('resolves firstFrameFut from the segment’s own synchronous emission', async () => {
    const audioOutput = new EmittingOutput();
    const { done, out } = forwardFrames(audioOutput, [frame()]);
    await done;

    expect(out.firstFrameFut.done).toBe(true);
    expect(out.ownSegmentIndex).toBe(1);
  });

  it('resolves firstFrameFut when a wrapper forwards the leaf event before counting (recorder ordering)', async () => {
    const audioOutput = new ForwardFirstWrapper(new EmittingOutput());
    const { done, out } = forwardFrames(audioOutput, [frame()]);
    await done;

    expect(out.firstFrameFut.done).toBe(true);
    expect(out.ownSegmentIndex).toBe(1);
  });

  it('ignores a stale event arriving before the segment captured anything', async () => {
    const audioOutput = new SilentOutput();
    let streamController!: ReadableStreamDefaultController<AudioFrame>;
    const stream = new ReadableStream<AudioFrame>({
      start(c) {
        streamController = c;
      },
    });
    const controller = new AbortController();
    const [task, out] = performAudioForwarding(stream, audioOutput, controller);

    // e.g. a stale lk.playback_started RPC from a previous, interrupted segment
    audioOutput.onPlaybackStarted(Date.now());
    expect(out.firstFrameFut.done).toBe(false);

    // aborting doesn't interrupt the in-flight read; close the stream to end it
    controller.abort();
    streamController.close();
    await task.result;
    expect(out.firstFrameFut.done).toBe(false);
    settle(out);
  });

  it('ignores an event once a foreign segment moved the output past this one', async () => {
    const audioOutput = new SilentOutput();
    const { done, out } = forwardFrames(audioOutput, [frame()]);
    await done;

    expect(out.ownSegmentIndex).toBe(1);
    expect(out.firstFrameFut.done).toBe(false);

    // the next speech opens a segment on the shared output...
    await audioOutput.captureFrame(frame());
    expect(audioOutput.capturedPlayoutSegments).toBe(2);

    // ...and playback starts: the event belongs to it, not to us
    audioOutput.onPlaybackStarted(Date.now());
    expect(out.firstFrameFut.done).toBe(false);

    settle(out);
  });
});

describe('hasOwnPlaybackEvidence', () => {
  const playbackEv = { playbackPosition: 0.5, interrupted: true };

  function audioOut(partial: Partial<_AudioOut>): _AudioOut {
    return {
      audio: [],
      firstFrameFut: new Future<number>(),
      _hasCapturedOwnFrame: false,
      capturedSegmentsBefore: 0,
      ...partial,
    };
  }

  it('rejects a stale playback position when no own frame was ever counted', () => {
    // A straggler frame from the previous interrupted speech bumped the shared
    // counter after this segment snapshotted; a counter delta would have counted
    // that as evidence, ownSegmentIndex must not.
    const out = audioOut({ _hasCapturedOwnFrame: true });
    expect(hasOwnPlaybackEvidence(out, playbackEv)).toBe(false);

    settleFut(out);
  });

  it('accepts a playback position once an own frame was counted', () => {
    const out = audioOut({ _hasCapturedOwnFrame: true, ownSegmentIndex: 1 });
    expect(hasOwnPlaybackEvidence(out, playbackEv)).toBe(true);
    expect(hasOwnPlaybackEvidence(out, { playbackPosition: 0, interrupted: true })).toBe(false);

    settleFut(out);
  });

  it('accepts a resolved firstFrameFut regardless of position', () => {
    const out = audioOut({ _hasCapturedOwnFrame: true, ownSegmentIndex: 1 });
    out.firstFrameFut.resolve(Date.now());
    expect(hasOwnPlaybackEvidence(out, { playbackPosition: 0, interrupted: true })).toBe(true);
  });

  it('returns false for a missing audio output', () => {
    expect(hasOwnPlaybackEvidence(undefined, playbackEv)).toBe(false);
    expect(hasOwnPlaybackEvidence(null, playbackEv)).toBe(false);
  });

  function settleFut(out: _AudioOut): void {
    out.firstFrameFut.reject(new Error('test done'));
    out.firstFrameFut.await.catch(() => {});
  }
});
