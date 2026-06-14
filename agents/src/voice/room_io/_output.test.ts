// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { Future, type Task } from '../../utils.js';
import { ParticipantAudioOutput, ParticipantTranscriptionOutput } from './_output.js';

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

describe('ParticipantTranscriptionOutput non-delta final flush', () => {
  it('snapshots latestText at flush time so a next-segment capture cannot overwrite it', async () => {
    type FlushTaskImpl = (writer: unknown, text: string, signal: AbortSignal) => Promise<void>;
    type FlushTarget = ParticipantTranscriptionOutput & {
      writer: unknown;
      flushTask: Task<void> | null;
      latestText: string;
      flushTaskImpl: FlushTaskImpl;
      handleFlush: () => void;
    };

    const output = Object.create(ParticipantTranscriptionOutput.prototype) as FlushTarget;
    output.writer = null;
    output.flushTask = null;
    output.latestText = 'segment-A';

    const flushedTexts: string[] = [];
    output.flushTaskImpl = vi.fn(async (_writer, text) => {
      flushedTexts.push(text);
    });

    output.handleFlush();
    // Simulate the next segment's first interim landing before the flush task
    // gets to write — must not corrupt segment A's final text.
    output.latestText = 'segment-B-interim';

    await output.flushTask!.result;

    expect(flushedTexts).toEqual(['segment-A']);
  });

  it('preserves latestText through resetState() on a fresh-segment capture (final-only burst)', async () => {
    type CaptureTarget = ParticipantTranscriptionOutput & {
      participantIdentity: string | null;
      capturing: boolean;
      latestText: string;
      currentId: string;
      flushTask: Task<void> | null;
      writer: unknown;
      jsonFormat: boolean;
      room: { isConnected: boolean };
      logger: { error: () => void };
      handleCaptureText: (text: string) => Promise<void>;
      captureText: (text: string) => Promise<void>;
    };

    const output = Object.create(ParticipantTranscriptionOutput.prototype) as CaptureTarget;
    output.participantIdentity = 'user-1';
    output.capturing = false;
    output.latestText = '';
    output.currentId = 'SG_initial';
    output.flushTask = null;
    output.writer = null;
    output.jsonFormat = false;
    output.room = { isConnected: false };
    output.logger = { error: vi.fn() };

    // First (and only) event for this segment is already a final.
    await output.captureText('hello world');

    expect(output.capturing).toBe(true);
    expect(output.latestText).toBe('hello world');
  });
});
