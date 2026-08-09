// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE_TRANSCRIPTION_FINAL } from '../../constants.js';
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

  it('emits playbackStarted once across pause and resume', async () => {
    const output = makeOutput({ paused: false });
    const audioFrame = frame();

    output.resume();
    for (let i = 0; i < 3; i++) {
      await output.captureFrame(audioFrame);
    }
    expect(output.onPlaybackStarted).toHaveBeenCalledTimes(1);

    output.pause();
    output.resume();
    for (let i = 0; i < 3; i++) {
      await output.captureFrame(audioFrame);
    }

    expect(output.onPlaybackStarted).toHaveBeenCalledTimes(1);
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

describe('ParticipantTranscriptionOutput non-delta final streams', () => {
  type Stream = { attributes: Record<string, string>; chunks: string[] };
  type Deferred = { promise: Promise<void>; resolve: () => void };

  const deferred = (): Deferred => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  };

  const makeOutput = ({ holdFinalWriter = false }: { holdFinalWriter?: boolean } = {}) => {
    const streams: Stream[] = [];
    const finalWriterEntered = deferred();
    const releaseFinalWriter = deferred();
    const logger = { error: vi.fn() };
    const output = Object.create(
      ParticipantTranscriptionOutput.prototype,
    ) as ParticipantTranscriptionOutput & {
      writer: unknown;
      flushTask: Task<void> | null;
      jsonFormat: boolean;
      isDeltaStream: boolean;
      latestText: string;
      capturing: boolean;
      currentId: string;
      participantIdentity: string | null;
      trackId?: string;
      logger: { error: () => void };
      room: unknown;
      handleFlush: () => void;
    };

    output.writer = null;
    output.flushTask = null;
    output.jsonFormat = false;
    output.isDeltaStream = false;
    output.latestText = '';
    output.capturing = false;
    output.currentId = 'SG_a';
    output.participantIdentity = 'user-a';
    output.trackId = 'TR_a';
    output.logger = logger;
    output.room = {
      isConnected: true,
      localParticipant: {
        streamText: async ({ attributes }: { attributes: Record<string, string> }) => {
          const stream: Stream = { attributes: { ...attributes }, chunks: [] };
          streams.push(stream);

          if (holdFinalWriter && attributes[ATTRIBUTE_TRANSCRIPTION_FINAL] === 'true') {
            finalWriterEntered.resolve();
            await releaseFinalWriter.promise;
          }

          return {
            write: async (text: string) => {
              stream.chunks.push(text);
            },
            close: async () => {},
          };
        },
      },
    };

    return { output, streams, logger, finalWriterEntered, releaseFinalWriter };
  };

  const finals = (streams: Stream[]) =>
    streams.filter((stream) => stream.attributes[ATTRIBUTE_TRANSCRIPTION_FINAL] === 'true');

  it('publishes the latest capture from one active segment', async () => {
    const { output, streams, logger } = makeOutput();

    await output.captureText('interim');
    await output.captureText('complete sentence');
    output.flush();
    await output.flushTask!.result;

    expect(finals(streams)).toHaveLength(1);
    expect(finals(streams)[0]!.chunks).toEqual(['complete sentence']);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('publishes the captured text when a segment starts with a final (no prior interims)', async () => {
    const { output, streams, logger } = makeOutput();

    await output.captureText('hello world');
    output.flush();
    await output.flushTask!.result;

    expect(finals(streams)).toHaveLength(1);
    expect(finals(streams)[0]!.chunks).toEqual(['hello world']);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps segment A when it finishes before segment B starts', async () => {
    const { output, streams, logger } = makeOutput();

    await output.captureText('segment A interim');
    await output.captureText('segment A');
    output.flush();
    await output.flushTask!.result;
    await output.captureText('B');

    expect(finals(streams)).toHaveLength(1);
    expect(finals(streams)[0]!.chunks).toEqual(['segment A']);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps segment A when segment B captures while A finalization is blocked', async () => {
    const { output, streams, logger, finalWriterEntered, releaseFinalWriter } = makeOutput({
      holdFinalWriter: true,
    });

    await output.captureText('segment A interim');
    await output.captureText('segment A full sentence');
    output.flush();
    await finalWriterEntered.promise;

    // captureText updates latestText before waiting for the pending flush. The barriers ensure
    // that update happens while segment A's final writer is blocked, without relying on timing.
    const nextCapture = output.captureText('segment B fragment');
    releaseFinalWriter.resolve();
    await nextCapture;
    await output.flushTask!.result;

    expect(finals(streams)).toHaveLength(1);
    expect(finals(streams)[0]!.chunks).toEqual(['segment A full sentence']);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
