// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
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
    interruptCount: number;
    segmentInterruptCount: number;
    segmentOpen: boolean;
    gatedFrames: Set<Future<void>>;
    playbackSegmentsCount: number;
    playbackFinishedCount: number;
    playbackFinishedFuture: Future<void>;
    onPlaybackStarted: (createdAt: number) => void;
    logger: { error: () => void };
    audioSource: {
      clearQueue: () => void;
      captureFrame: (frame: CaptureFrameArg) => Promise<void>;
      waitForPlayout: () => Promise<void>;
      queuedDuration: number;
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
    output.interruptCount = 0;
    output.segmentInterruptCount = 0;
    output.segmentOpen = false;
    output.gatedFrames = new Set();
    output.playbackSegmentsCount = 0;
    output.playbackFinishedCount = 0;
    output.playbackFinishedFuture = new Future<void>();
    output.onPlaybackStarted = vi.fn();
    output.logger = { error: vi.fn() };
    output.audioSource = {
      clearQueue: vi.fn(),
      captureFrame: vi.fn(async () => {}),
      // Playout never drains on its own, so a flush task stays pending like a real
      // segment still on the wire.
      waitForPlayout: () => new Promise<void>(() => {}),
      queuedDuration: 0,
    };
    return output;
  };

  const frame = () => ({ samplesPerChannel: 480, sampleRate: 24000 }) as unknown as CaptureFrameArg;

  const settledWithin = async (promise: Promise<unknown>, ms: number) =>
    Promise.race([
      promise.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
    ]);

  it('does not strand the segment counter when a frame is interrupted while paused', async () => {
    const output = makeOutput({ paused: true });

    const capture = output.captureFrame(frame());
    output.clearBuffer();
    await capture;

    expect(output.playbackSegmentsCount).toBe(0);
    expect(output.audioSource.captureFrame).not.toHaveBeenCalled();

    const result = await Promise.race([
      output.waitForPlayout().then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(result).toBe('resolved');
  });

  it('does not drop a new segment at the pause gate after the previous one was interrupted', async () => {
    const output = makeOutput({ paused: false });

    // Segment 1 plays, is flushed and then interrupted — the state a barge-in leaves behind.
    await output.captureFrame(frame());
    output.flush();
    output.clearBuffer();
    await nextTick();

    // Segment 2 is a fresh reply that gets paused mid-flight by a new overlap. Its frames
    // belong to a speech the earlier interruption knows nothing about, so they must wait
    // for the resume rather than be discarded.
    output.pause();
    const capture = output.captureFrame(frame());
    expect(await settledWithin(capture, 50)).toBe('pending');

    output.resume();
    await capture;

    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(2);
    expect(output.playbackSegmentsCount).toBe(2);
  });

  it('releases a parked frame when a concurrent flush has replaced the interruption signal', async () => {
    const output = makeOutput({ paused: false });

    await output.captureFrame(frame());
    output.pause();
    const capture = output.captureFrame(frame());
    await nextTick();

    // An overlapping segment's flush swaps interruptedFuture out from under the parked
    // frame; the interruption that follows must still reach it.
    output.flush();
    output.clearBuffer();

    expect(await settledWithin(capture, 500)).toBe('settled');
    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(1);
  });

  it('registers a segment on the normal non-paused path', async () => {
    const output = makeOutput({ paused: false });

    await output.captureFrame(frame());

    expect(output.playbackSegmentsCount).toBe(1);
    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(1);
    expect(output.pushedDuration).toBeGreaterThan(0);
  });
});

describe('ParticipantAudioOutput publishTrack', () => {
  it('publishes with the configured trackPublishOptions', async () => {
    const trackPublishOptions = new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
      dtx: false,
      red: false,
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      options: { trackPublishOptions: TrackPublishOptions };
      audioSource: unknown;
      startedFuture: Future<void>;
      room: unknown;
      publishTrack: (signal: AbortSignal) => Promise<void>;
    };

    const fakeTrack = {} as LocalAudioTrack;
    const createAudioTrack = vi
      .spyOn(LocalAudioTrack, 'createAudioTrack')
      .mockReturnValue(fakeTrack);
    const publishTrack = vi.fn(async () => ({ waitForSubscription: async () => {} }));

    output.options = { trackPublishOptions };
    output.audioSource = {};
    output.startedFuture = new Future<void>();
    output.room = { localParticipant: { publishTrack } };

    try {
      await output.publishTrack(new AbortController().signal);
    } finally {
      createAudioTrack.mockRestore();
    }

    expect(publishTrack).toHaveBeenCalledWith(fakeTrack, trackPublishOptions);
    expect(output.startedFuture.done).toBe(true);
  });
});
