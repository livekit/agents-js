// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTE_TRANSCRIPTION_EXPRESSION,
  ATTRIBUTE_TRANSCRIPTION_FINAL,
} from '../../constants.js';
import { TranscriptMarkupStripper } from '../../tts/provider_format.js';
import { Future } from '../../utils.js';
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

describe('ParticipantTranscriptionOutput markup stripping', () => {
  const makeOutput = (expressive = true, isDeltaStream = true) => {
    const writes: string[] = [];
    const writers: Array<{ attributes: Record<string, string>; closed: boolean }> = [];

    const output = Object.create(
      ParticipantTranscriptionOutput.prototype,
    ) as ParticipantTranscriptionOutput & Record<string, any>;

    output.expressiveEnabled = () => expressive;
    output.participantIdentity = 'agent';
    output.isDeltaStream = isDeltaStream;
    output.jsonFormat = false;
    output.writer = null;
    output.flushTask = null;
    output.capturing = false;
    output.latestText = '';
    output.currentId = 'SG_test';
    output.logger = { error: vi.fn(), warn: vi.fn() };
    output.stripper = new TranscriptMarkupStripper();
    output.segmentTags = [];
    output.room = { isConnected: true };
    output.createTextWriter = async (
      attributes?: Record<string, string>,
      extra?: Record<string, string>,
    ) => {
      const writer = { attributes: { ...attributes, ...extra }, closed: false };
      writers.push(writer);
      return {
        write: async (text: string) => {
          writes.push(text);
        },
        close: async () => {
          writer.closed = true;
        },
      };
    };

    return { output, writes, writers };
  };

  it('publishes text held back by the stripper when the segment flushes', async () => {
    // regression: a segment whose every chunk was held (a tag-shaped "<" that never
    // closes) reached flush with no writer, and the whole transcript was dropped.
    const { output, writes } = makeOutput();

    await output.captureText('a <b');
    expect(writes, 'the chunk is held, not published').toEqual([]);

    output.flush();
    await output.flushTask.result;

    expect(writes).toEqual(['a <b']);
  });

  it('marks the flush-created writer final', async () => {
    const { output, writers } = makeOutput();

    await output.captureText('a <b');
    output.flush();
    await output.flushTask.result;

    expect(writers).toHaveLength(1);
    expect(writers[0]!.attributes[ATTRIBUTE_TRANSCRIPTION_FINAL]).toBe('true');
    expect(writers[0]!.closed).toBe(true);
  });

  it('strips markup from published text and carries the expression attribute', async () => {
    const { output, writes, writers } = makeOutput();

    await output.captureText('<expr type="expression" label="happy"/> Hello there');
    output.flush();
    await output.flushTask.result;

    // no leading space: the marker opened the segment, so the space it left is trimmed
    expect(writes.join('')).toBe('Hello there');
    expect(writers[0]!.attributes[ATTRIBUTE_TRANSCRIPTION_EXPRESSION]).toBe(
      '{"expression":"happy","mood":"happy"}',
    );
  });

  describe('a marker opening the segment', () => {
    // the dedup drops the whitespace *before* a removed tag; at position 0 there is none,
    // so the space that followed the marker survived and every turn opened with it
    const TURN = '<expr type="expression" label="warm"/> Hey, good to hear from you!';

    it('does not leave a leading space on the delta path', async () => {
      const { output, writes } = makeOutput(true, true);

      // chunked the way an LLM streams, so the marker and the text can split apart
      for (const c of TURN.match(/.{1,14}/gs) ?? []) await output.captureText(c);
      output.flush();
      await output.flushTask.result;

      expect(writes.join('')).toBe('Hey, good to hear from you!');
    });

    it('does not leave a leading space on the non-delta path', async () => {
      const { output, writes } = makeOutput(true, false);

      await output.captureText(TURN);
      output.flush();
      await output.flushTask?.result;

      expect(writes[writes.length - 1]).toBe('Hey, good to hear from you!');
    });

    it('leaves leading whitespace alone when expressive is off', async () => {
      // nothing was stripped, so the text is the agent's own and is published verbatim
      const { output, writes } = makeOutput(false, true);

      await output.captureText('  spaced out');
      output.flush();
      await output.flushTask.result;

      expect(writes.join('')).toBe('  spaced out');
    });

    it('only trims the head, not later chunk boundaries', async () => {
      const { output, writes } = makeOutput(true, true);

      await output.captureText('<expr type="expression" label="warm"/> Hey there.');
      await output.captureText(' And also this.');
      output.flush();
      await output.flushTask.result;

      expect(writes.join('')).toBe('Hey there. And also this.');
    });
  });

  describe('with expressive off', () => {
    it('publishes tag-shaped text verbatim', async () => {
      // the strip works off the union of every provider's tag names, so a session that
      // never enabled expressive must not have `<break time="1s"/>` removed, and must
      // carry no expression attribute
      const { output, writes, writers } = makeOutput(false);

      await output.captureText('Hold on <break time="1s"/> nearly there.');
      output.flush();
      await output.flushTask.result;

      expect(writes.join('')).toBe('Hold on <break time="1s"/> nearly there.');
      expect(writers[0]!.attributes[ATTRIBUTE_TRANSCRIPTION_EXPRESSION]).toBeUndefined();
    });

    it('does not hold back a tag-shaped chunk', async () => {
      const { output, writes } = makeOutput(false);

      await output.captureText('3 <');
      expect(writes, 'nothing is buffered without expressive').toEqual(['3 <']);

      output.flush();
      await output.flushTask.result;
      expect(writes.join('')).toBe('3 <');
    });
  });
});
