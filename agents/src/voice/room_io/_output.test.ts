// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { Future } from '../../utils.js';
import { ParticipantAudioOutput } from './_output.js';

type CaptureFrameArg = Parameters<ParticipantAudioOutput['captureFrame']>[0];

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ParticipantAudioOutput waitForPlayoutTask', () => {
  it('resets tracked duration after non-interrupted playout', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      interruptedFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      waitForPlayoutTask: (abortController: AbortController) => Promise<void>;
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 0,
      clearQueue: vi.fn(),
    };

    const task = output.waitForPlayoutTask(new AbortController());

    resolvePlayout();
    await task;

    expect(output.pushedDuration).toBe(0);
    expect(onPlaybackFinished).toHaveBeenCalledWith({
      playbackPosition: 1.0,
      interrupted: false,
    });
  });

  it('resets duration to queue state when interrupted flush clears overlap', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      interruptedFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      waitForPlayoutTask: (abortController: AbortController) => Promise<void>;
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 500,
      clearQueue: vi.fn(() => {
        output.audioSource.queuedDuration = 0;
      }),
    };

    const task = output.waitForPlayoutTask(new AbortController());

    // Overlap from the next segment arrives before interruption.
    output.pushedDuration += 0.5;
    output.interruptedFuture.resolve();
    resolvePlayout();
    await task;

    // interrupted path clears queued overlap, so duration should not retain stale overlap time.
    expect(output.pushedDuration).toBe(0);
    expect(onPlaybackFinished).toHaveBeenCalledWith({
      playbackPosition: 0.5,
      interrupted: true,
    });
  });

  it('does not finish one segment twice when flush is called again before playout drains', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      flushTask?: { done: boolean };
      flushPushedDuration?: number;
      interruptedFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      logger: {
        error: () => void;
      };
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.logger = {
      error: vi.fn(),
    };
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 0,
      clearQueue: vi.fn(),
    };

    output.flush();
    await nextTick();

    output.flush();
    await nextTick();

    resolvePlayout();
    await nextTick();

    expect(onPlaybackFinished).toHaveBeenCalledTimes(1);
    expect(onPlaybackFinished).toHaveBeenCalledWith({
      playbackPosition: 1.0,
      interrupted: false,
    });
    expect(output.logger.error).not.toHaveBeenCalled();
  });
});

describe('ParticipantAudioOutput captureFrame segment accounting', () => {
  type TestOutput = ParticipantAudioOutput & {
    startedFuture: Future<void>;
    playbackEnabledFuture: Future<void>;
    interruptedFuture: Future<void>;
    firstFrameEmitted: boolean;
    pushedDuration: number;
    _capturing: boolean;
    playbackSegmentsCount: number;
    playbackFinishedCount: number;
    playbackFinishedFuture: Future<void>;
    onPlaybackStarted: (createdAt: number) => void;
    options: { queueSizeMs?: number };
    recentFrames: unknown[];
    recentFramesMs: number;
    replayFrames: unknown[];
    audioSource: {
      clearQueue: () => void;
      captureFrame: (frame: CaptureFrameArg) => Promise<void>;
    };
  };

  const makeOutput = (opts: { paused: boolean }): TestOutput => {
    const output = Object.create(ParticipantAudioOutput.prototype) as TestOutput;
    output.startedFuture = new Future<void>();
    output.startedFuture.resolve();
    output.playbackEnabledFuture = new Future<void>();
    if (!opts.paused) output.playbackEnabledFuture.resolve();
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = false;
    output.pushedDuration = 0;
    output._capturing = false;
    output.playbackSegmentsCount = 0;
    output.playbackFinishedCount = 0;
    output.playbackFinishedFuture = new Future<void>();
    output.onPlaybackStarted = vi.fn();
    // Object.create bypasses the constructor's field initializers; mirror them.
    output.options = { queueSizeMs: 1000 };
    output.recentFrames = [];
    output.recentFramesMs = 0;
    output.replayFrames = [];
    output.audioSource = { clearQueue: vi.fn(), captureFrame: vi.fn(async () => {}) };
    return output;
  };

  const frame = () => ({ samplesPerChannel: 480, sampleRate: 24000 }) as unknown as CaptureFrameArg;

  it('does not strand the segment counter when a frame is interrupted while paused', async () => {
    const output = makeOutput({ paused: true });

    const capture = output.captureFrame(frame());
    output.interruptedFuture.resolve();
    await capture;

    expect(output.playbackSegmentsCount).toBe(0);
    expect(output.audioSource.captureFrame).not.toHaveBeenCalled();

    const result = await Promise.race([
      output.waitForPlayout().then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(result).toBe('resolved');
  });

  it('registers a segment on the normal non-paused path', async () => {
    const output = makeOutput({ paused: false });

    await output.captureFrame(frame());

    expect(output.playbackSegmentsCount).toBe(1);
    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(1);
    expect(output.pushedDuration).toBeGreaterThan(0);
  });
});

/**
 * Regression tests for the false-interruption audio loss fix.
 *
 * Before the fix, pause() called clearQueue() which permanently dropped every
 * frame already pushed to the native AudioSource queue (up to queueSizeMs). On a
 * false interruption (pause then resume) the agent never replayed them, so up to
 * ~1s of audio (rtc-node default queue) vanished from both the call and the
 * recording. The output now keeps a rolling window of recently pushed frames,
 * captures the unplayed tail on pause(), and replays it on the next captureFrame
 * after resume() — while discarding it on a real interruption (clearBuffer()).
 */
describe('ParticipantAudioOutput false-interruption replay', () => {
  const FRAME_MS = 20;
  const SR = 48000;
  const SPF = (SR * FRAME_MS) / 1000;

  type ReplayOutput = ParticipantAudioOutput & {
    startedFuture: Future<void>;
    playbackEnabledFuture: Future<void>;
    interruptedFuture: Future<void>;
    firstFrameEmitted: boolean;
    pushedDuration: number;
    _capturing: boolean;
    playbackSegmentsCount: number;
    playbackFinishedCount: number;
    playbackFinishedFuture: Future<void>;
    onPlaybackStarted: (createdAt: number) => void;
    options: { queueSizeMs?: number };
    recentFrames: unknown[];
    recentFramesMs: number;
    replayFrames: unknown[];
    audioSource: {
      clearQueue: () => void;
      captureFrame: (frame: CaptureFrameArg) => Promise<void>;
      queuedDuration: number;
    };
  };

  // Tag each frame by id in data[0] so captured ids reveal exact ordering, lost
  // frames (missing id), and replayed frames (duplicate id).
  const frameOf = (id: number): CaptureFrameArg => {
    const data = new Int16Array(SPF);
    data[0] = id;
    return { samplesPerChannel: SPF, sampleRate: SR, data } as unknown as CaptureFrameArg;
  };

  const makeOutput = (queueSizeMs: number, captured: number[]): ReplayOutput => {
    const output = Object.create(ParticipantAudioOutput.prototype) as ReplayOutput;
    output.startedFuture = new Future<void>();
    output.startedFuture.resolve();
    output.playbackEnabledFuture = new Future<void>();
    output.playbackEnabledFuture.resolve();
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = false;
    output.pushedDuration = 0;
    output._capturing = false;
    output.playbackSegmentsCount = 0;
    output.playbackFinishedCount = 0;
    output.playbackFinishedFuture = new Future<void>();
    output.onPlaybackStarted = vi.fn();
    // Object.create bypasses the constructor's field initializers; mirror them.
    output.options = { queueSizeMs };
    output.recentFrames = [];
    output.recentFramesMs = 0;
    output.replayFrames = [];
    output.audioSource = {
      clearQueue: vi.fn(),
      queuedDuration: 0,
      captureFrame: vi.fn(async (frame: CaptureFrameArg) => {
        captured.push((frame as unknown as { data: Int16Array }).data[0]!);
      }),
    };
    return output;
  };

  it('replays the unplayed tail on resume (false interruption) — zero loss', async () => {
    const captured: number[] = [];
    const output = makeOutput(100, captured);

    for (let i = 0; i < 10; i++) {
      await output.captureFrame(frameOf(i));
    }

    // 100ms == 5 frames still queued (unplayed) when the false interruption hits.
    output.audioSource.queuedDuration = 100;
    output.pause();
    output.resume();

    await output.captureFrame(frameOf(10));

    // initial 0..9, then the unplayed tail 5..9 replayed, then 10 — nothing lost.
    expect(captured).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 5, 6, 7, 8, 9, 10]);
  });

  it('discards the unplayed tail on clearBuffer (real interruption) — no replay', async () => {
    const captured: number[] = [];
    const output = makeOutput(100, captured);

    for (let i = 0; i < 10; i++) {
      await output.captureFrame(frameOf(i));
    }

    output.audioSource.queuedDuration = 100;
    output.pause();
    output.clearBuffer(); // real interruption: the user cut the agent off
    output.resume();

    await output.captureFrame(frameOf(10));

    expect(captured).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('does not replay when nothing was queued at pause', async () => {
    const captured: number[] = [];
    const output = makeOutput(100, captured);

    for (let i = 0; i < 10; i++) {
      await output.captureFrame(frameOf(i));
    }

    output.audioSource.queuedDuration = 0;
    output.pause();
    output.resume();

    await output.captureFrame(frameOf(10));

    expect(captured).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // A false interruption at the very end of an utterance has no following
  // captureFrame() in the same segment to consume the replay tail. The segment
  // completes non-interrupted (pause's clearQueue lets waitForPlayout resolve),
  // so the tail must be dropped at segment end — otherwise it leaks into the
  // start of the next utterance.
  it('drops the unplayed tail at segment end (end-of-utterance false interruption)', async () => {
    const captured: number[] = [];
    const output = makeOutput(100, captured) as ReplayOutput & {
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      waitForPlayoutTask: (abortController: AbortController) => Promise<void>;
      audioSource: ReplayOutput['audioSource'] & { waitForPlayout: () => Promise<void> };
    };
    output.onPlaybackFinished = vi.fn();
    let resolvePlayout!: () => void;
    const playout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });
    output.audioSource.waitForPlayout = () => playout;

    for (let i = 0; i < 10; i++) {
      await output.captureFrame(frameOf(i));
    }

    // False interruption right at the end: the tail (5..9) is captured for replay.
    output.audioSource.queuedDuration = 100;
    output.pause();
    expect(output.replayFrames.length).toBe(5);

    // Segment completes normally: clearQueue (from pause) let waitForPlayout
    // resolve and no clearBuffer fired, so interrupted === false.
    const task = output.waitForPlayoutTask(new AbortController());
    resolvePlayout();
    await task;
    expect(output.replayFrames.length).toBe(0);

    // Next utterance must not be prefixed with the stale tail.
    output.resume();
    await output.captureFrame(frameOf(10));
    expect(captured).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
