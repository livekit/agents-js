// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
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

class QueuedAudioSource {
  queuedDuration = 0;
  playedDuration = 0;
  clearCount = 0;
  captured: CaptureFrameArg[] = [];

  async captureFrame(frame: CaptureFrameArg): Promise<void> {
    this.captured.push(frame);
    this.queuedDuration += (frame.samplesPerChannel / frame.sampleRate) * 1000;
  }

  async waitForPlayout(): Promise<void> {
    await nextTick();
    this.playedDuration += this.queuedDuration / 1000;
    this.queuedDuration = 0;
  }

  clearQueue(): void {
    this.clearCount++;
    this.queuedDuration = 0;
  }
}

class BlockingAudioSource extends QueuedAudioSource {
  captureStarted = new Future<void>();
  captureAllowed = new Future<void>();
  playoutStarted = new Future<void>();
  playoutAllowed = new Future<void>();

  override async captureFrame(frame: CaptureFrameArg): Promise<void> {
    await super.captureFrame(frame);
    this.captureStarted.resolve();
    await this.captureAllowed.await;
  }

  override async waitForPlayout(): Promise<void> {
    this.playoutStarted.resolve();
    await this.playoutAllowed.await;
    await super.waitForPlayout();
  }
}

type TestParticipantAudioOutput = ParticipantAudioOutput & {
  startedFuture: Future<void>;
  playbackEnabledFuture: Future<void>;
  interruptedFuture: Future<void>;
  forwardingIdleFuture: Future<void>;
  firstFrameEmitted: boolean;
  pushedDuration: number;
  sourcePushedDuration: number;
  sourceDiscardedDuration: number;
  interruptionGeneration: number;
  forwardingCount: number;
  _capturing: boolean;
  playbackSegmentsCount: number;
  playbackFinishedCount: number;
  playbackFinishedFuture: Future<void>;
  onPlaybackStarted: (createdAt: number) => void;
  logger: {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  audioSource: QueuedAudioSource;
};

function makeTestOutput(audioSource: QueuedAudioSource = new QueuedAudioSource()) {
  const output = Object.create(ParticipantAudioOutput.prototype) as TestParticipantAudioOutput;
  output.startedFuture = new Future<void>();
  output.startedFuture.resolve();
  output.playbackEnabledFuture = new Future<void>();
  output.playbackEnabledFuture.resolve();
  output.interruptedFuture = new Future<void>();
  output.forwardingIdleFuture = new Future<void>();
  output.forwardingIdleFuture.resolve();
  output.firstFrameEmitted = false;
  output.pushedDuration = 0;
  output.sourcePushedDuration = 0;
  output.sourceDiscardedDuration = 0;
  output.interruptionGeneration = 0;
  output.forwardingCount = 0;
  output._capturing = false;
  output.playbackSegmentsCount = 0;
  output.playbackFinishedCount = 0;
  output.playbackFinishedFuture = new Future<void>();
  output.onPlaybackStarted = vi.fn();
  output.logger = { error: vi.fn(), warn: vi.fn() };
  output.audioSource = audioSource;
  return output;
}

function audioFrame(durationMs: number, value = 0): AudioFrame {
  const samplesPerChannel = (durationMs / 1000) * 48000;
  return new AudioFrame(new Int16Array(samplesPerChannel).fill(value), 48000, 1, samplesPerChannel);
}

describe('ParticipantAudioOutput waitForPlayoutTask', () => {
  it('resets tracked duration after non-interrupted playout', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      sourcePushedDuration: number;
      sourceDiscardedDuration: number;
      interruptedFuture: Future<void>;
      forwardingIdleFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      waitForPlayoutTask: () => Promise<void>;
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.sourcePushedDuration = 1.0;
    output.sourceDiscardedDuration = 0;
    output.interruptedFuture = new Future<void>();
    output.forwardingIdleFuture = new Future<void>();
    output.forwardingIdleFuture.resolve();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 0,
      clearQueue: vi.fn(),
    };

    const task = output.waitForPlayoutTask();

    resolvePlayout();
    await task;

    expect(output.pushedDuration).toBe(0);
    expect(onPlaybackFinished).toHaveBeenCalledWith({
      playbackPosition: 1.0,
      interrupted: false,
    });
  });

  it('subtracts queued source audio when interrupted', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      sourcePushedDuration: number;
      sourceDiscardedDuration: number;
      interruptedFuture: Future<void>;
      forwardingIdleFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      waitForPlayoutTask: () => Promise<void>;
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.sourcePushedDuration = 1.0;
    output.sourceDiscardedDuration = 0;
    output.interruptedFuture = new Future<void>();
    output.forwardingIdleFuture = new Future<void>();
    output.forwardingIdleFuture.resolve();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 500,
      clearQueue: vi.fn(() => {
        output.audioSource.queuedDuration = 0;
      }),
    };

    const task = output.waitForPlayoutTask();

    output.interruptedFuture.resolve();
    resolvePlayout();
    await task;

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
      sourcePushedDuration: number;
      sourceDiscardedDuration: number;
      flushTask?: { done: boolean };
      interruptedFuture: Future<void>;
      forwardingIdleFuture: Future<void>;
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
    output.sourcePushedDuration = 1.0;
    output.sourceDiscardedDuration = 0;
    output.interruptedFuture = new Future<void>();
    output.forwardingIdleFuture = new Future<void>();
    output.forwardingIdleFuture.resolve();
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
    sourcePushedDuration: number;
    sourceDiscardedDuration: number;
    interruptionGeneration: number;
    forwardingCount: number;
    forwardingIdleFuture: Future<void>;
    _capturing: boolean;
    playbackSegmentsCount: number;
    playbackFinishedCount: number;
    playbackFinishedFuture: Future<void>;
    onPlaybackStarted: (createdAt: number) => void;
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
    output.sourcePushedDuration = 0;
    output.sourceDiscardedDuration = 0;
    output.interruptionGeneration = 0;
    output.forwardingCount = 0;
    output.forwardingIdleFuture = new Future<void>();
    output.forwardingIdleFuture.resolve();
    output._capturing = false;
    output.playbackSegmentsCount = 0;
    output.playbackFinishedCount = 0;
    output.playbackFinishedFuture = new Future<void>();
    output.onPlaybackStarted = vi.fn();
    output.audioSource = {
      clearQueue: vi.fn(),
      captureFrame: vi.fn(async () => {}),
      waitForPlayout: vi.fn(async () => {}),
      queuedDuration: 0,
    };
    return output;
  };

  const frame = () => ({ samplesPerChannel: 480, sampleRate: 24000 }) as unknown as CaptureFrameArg;

  it('finishes the segment when a frame is interrupted while paused', async () => {
    const output = makeOutput({ paused: true });

    const capture = output.captureFrame(frame());
    output.clearBuffer();
    await capture;

    expect(output.playbackSegmentsCount).toBe(1);
    expect(output.audioSource.captureFrame).not.toHaveBeenCalled();
    expect(await output.waitForPlayout()).toEqual({ playbackPosition: 0, interrupted: true });
  });

  it('drops a frame interrupted while waiting for subscription', async () => {
    const output = makeOutput({ paused: false });
    output.startedFuture = new Future<void>();

    const capture = output.captureFrame(frame());
    output.clearBuffer();
    output.startedFuture.resolve();
    await capture;

    expect(output.playbackSegmentsCount).toBe(0);
    expect(output.audioSource.captureFrame).not.toHaveBeenCalled();
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

  it('keeps a capture gated when playback pauses again during resume', async () => {
    const output = makeOutput({ paused: true });

    const capture = output.captureFrame(frame());
    await nextTick();

    output.resume();
    output.pause();
    await nextTick();

    expect(output.audioSource.captureFrame).not.toHaveBeenCalled();

    output.resume();
    await capture;

    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(1);
  });
});

describe('ParticipantAudioOutput discarded audio accounting', () => {
  it('does not report discarded audio as played', async () => {
    const source = new QueuedAudioSource();
    const output = makeTestOutput(source);

    await output.captureFrame(audioFrame(500));
    output.pause();
    const heldCapture = output.captureFrame(audioFrame(20));
    output.flush();
    await nextTick();

    expect(source.clearCount).toBe(1);
    output.clearBuffer();
    await heldCapture;
    const finished = await output.waitForPlayout();

    expect(finished.interrupted).toBe(true);
    expect(finished.playbackPosition).toBe(0);
  });

  it('excludes discarded audio after resume', async () => {
    const source = new QueuedAudioSource();
    const output = makeTestOutput(source);

    await output.captureFrame(audioFrame(500));
    output.pause();
    const heldCapture = output.captureFrame(audioFrame(200));
    output.flush();
    await nextTick();

    expect(source.clearCount).toBe(1);
    output.resume();
    await heldCapture;
    const finished = await output.waitForPlayout();

    expect(finished.interrupted).toBe(false);
    expect(finished.playbackPosition).toBeCloseTo(source.playedDuration);
  });

  it('finishes playout when paused after forwarding drains', async () => {
    const source = new QueuedAudioSource();
    const output = makeTestOutput(source);
    const frame = audioFrame(20);

    await output.captureFrame(frame);
    output.flush();
    output.pause();
    const finished = await output.waitForPlayout();

    expect(finished.interrupted).toBe(false);
    expect(finished.playbackPosition).toBeCloseTo(frame.samplesPerChannel / frame.sampleRate);
  });

  it('drops a paused frame from an interrupted segment', async () => {
    const source = new QueuedAudioSource();
    const output = makeTestOutput(source);
    const oldFrame = audioFrame(20, 1);
    const newFrame = audioFrame(40, 2);

    output.pause();
    const heldCapture = output.captureFrame(oldFrame);
    output.flush();
    await nextTick();

    output.clearBuffer();
    await heldCapture;
    const interrupted = await output.waitForPlayout();

    output.resume();
    await output.captureFrame(newFrame);
    output.flush();
    const finished = await output.waitForPlayout();

    expect(interrupted.interrupted).toBe(true);
    expect(interrupted.playbackPosition).toBe(0);
    expect(finished.interrupted).toBe(false);
    expect(finished.playbackPosition).toBeCloseTo(newFrame.samplesPerChannel / newFrame.sampleRate);
    expect(source.captured).toEqual([newFrame]);
  });

  it('waits for active submission and source playout', async () => {
    const source = new BlockingAudioSource();
    const output = makeTestOutput(source);
    const frame = audioFrame(20);
    const capture = output.captureFrame(frame);
    await source.captureStarted.await;

    output.flush();
    const playout = output.waitForPlayout();
    await nextTick();

    let settled = false;
    void playout.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    expect(source.playoutStarted.done).toBe(false);

    source.captureAllowed.resolve();
    await capture;
    await source.playoutStarted.await;
    expect(settled).toBe(false);

    source.playoutAllowed.resolve();
    const finished = await playout;

    expect(finished.interrupted).toBe(false);
    expect(finished.playbackPosition).toBeCloseTo(frame.samplesPerChannel / frame.sampleRate);
  });

  it('waits for previous segment playout before capturing the next segment', async () => {
    const source = new BlockingAudioSource();
    source.captureAllowed.resolve();
    const output = makeTestOutput(source);
    const firstFrame = audioFrame(20, 1);
    const secondFrame = audioFrame(40, 2);

    await output.captureFrame(firstFrame);
    output.flush();
    await source.playoutStarted.await;

    let secondCaptureSettled = false;
    const secondCapture = output.captureFrame(secondFrame).then(() => {
      secondCaptureSettled = true;
    });
    await nextTick();

    expect(secondCaptureSettled).toBe(false);
    expect(source.captured).toEqual([firstFrame]);

    source.playoutAllowed.resolve();
    const firstFinished = await output.waitForPlayout();
    await secondCapture;

    expect(firstFinished).toEqual({
      interrupted: false,
      playbackPosition: firstFrame.samplesPerChannel / firstFrame.sampleRate,
    });
    expect(source.captured).toEqual([firstFrame, secondFrame]);

    output.flush();
    const secondFinished = await output.waitForPlayout();
    expect(secondFinished).toEqual({
      interrupted: false,
      playbackPosition: secondFrame.samplesPerChannel / secondFrame.sampleRate,
    });
  });

  it('drops a next-segment capture interrupted while waiting for prior playout', async () => {
    const source = new BlockingAudioSource();
    source.captureAllowed.resolve();
    const output = makeTestOutput(source);
    const firstFrame = audioFrame(20, 1);

    await output.captureFrame(firstFrame);
    output.flush();
    await source.playoutStarted.await;

    const nextCapture = output.captureFrame(audioFrame(40, 2));
    await nextTick();
    output.clearBuffer();

    expect(await output.waitForPlayout()).toEqual({
      interrupted: true,
      playbackPosition: 0,
    });
    await nextCapture;
    expect(source.captured).toEqual([firstFrame]);

    source.playoutAllowed.resolve();
  });

  it('finishes once when producer flush follows clearBuffer', async () => {
    const source = new QueuedAudioSource();
    const output = makeTestOutput(source);
    const onPlaybackFinished = vi.spyOn(output, 'onPlaybackFinished');

    await output.captureFrame(audioFrame(20, 1));
    output.clearBuffer();
    output.flush();

    expect(await output.waitForPlayout()).toEqual({
      interrupted: true,
      playbackPosition: 0,
    });
    expect(onPlaybackFinished).toHaveBeenCalledTimes(1);

    const nextFrame = audioFrame(40, 2);
    await output.captureFrame(nextFrame);
    output.flush();

    expect(await output.waitForPlayout()).toEqual({
      interrupted: false,
      playbackPosition: nextFrame.samplesPerChannel / nextFrame.sampleRate,
    });
    expect(onPlaybackFinished).toHaveBeenCalledTimes(2);
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
