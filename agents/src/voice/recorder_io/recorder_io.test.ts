// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions } from '@livekit/rtc-node';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../log.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { Future, isWritableStreamClosedError } from '../../utils.js';
import type { AgentSession } from '../agent_session.js';
import { AudioInput, AudioOutput, type PlaybackFinishedEvent, TextOutput } from '../io.js';
import { ParticipantAudioOutput } from '../room_io/_output.js';
import { TranscriptionSynchronizer } from '../transcription/synchronizer.js';
import { RecorderIO } from './recorder_io.js';

class FakeAudioInput extends AudioInput {
  private chan: StreamChannel<AudioFrame> = createStreamChannel<AudioFrame>();

  constructor() {
    super();
    this.multiStream.addInputStream(this.chan.stream());
  }

  push(frame: AudioFrame): Promise<void> {
    return this.chan.write(frame);
  }
}

class FakeAudioOutput extends AudioOutput {
  constructor() {
    super(48000);
  }

  clearBuffer(): void {}
}

class WaitAwareAudioOutput extends FakeAudioOutput {
  readonly waitStarted = new Future<void>();
  private readonly continueWait = new Future<void>();

  async waitForPlayout() {
    const waitForCurrentSegment = super.waitForPlayout();
    this.waitStarted.resolve();
    await this.continueWait.await;
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    return waitForCurrentSegment;
  }

  releaseWait() {
    this.continueWait.resolve();
  }
}

class FinishDuringCaptureOutput extends AudioOutput {
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.captures++;
    if (this.captures === 1) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }

  clearBuffer(): void {}
}

class DroppingAudioOutput extends AudioOutput {
  constructor() {
    super(24000);
  }

  async captureFrame(_frame: AudioFrame): Promise<void> {}

  clearBuffer(): void {}
}

class PreviousFinishThenDropOutput extends AudioOutput {
  private captures = 0;
  onPreviousFinishForwarded?: () => void;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    this.captures++;
    if (this.captures === 1) {
      await super.captureFrame(frame);
      return;
    }

    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    this.onPreviousFinishForwarded?.();
  }

  clearBuffer(): void {}
}

class FinishDuringLaterFrameOutput extends AudioOutput {
  private captures = 0;
  onFinishForwarded?: () => void;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.captures++;
    if (this.captures === 2) {
      this.onPlaybackFinished({ playbackPosition: 0.04, interrupted: true });
      this.onFinishForwarded?.();
    }
  }

  clearBuffer(): void {}
}

class DropThenFinishOutput extends AudioOutput {
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    this.captures++;
    if (this.captures === 1) {
      return;
    }

    await super.captureFrame(frame);
    this.onPlaybackFinished({
      playbackPosition: 0,
      interrupted: true,
      synchronizedTranscript: 'accepted-second-segment',
    });
  }

  clearBuffer(): void {}
}

class BlockingSecondCaptureOutput extends AudioOutput {
  readonly secondCaptureStarted = new Future<void>();
  private readonly continueSecondCapture = new Future<void>();
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    this.captures++;
    if (this.captures === 2) {
      this.secondCaptureStarted.resolve();
      await this.continueSecondCapture.await;
    }
    await super.captureFrame(frame);
  }

  releaseSecondCapture(): void {
    this.continueSecondCapture.resolve();
  }

  finishSegment(): void {
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }

  clearBuffer(): void {}
}

class RejectingAudioOutput extends AudioOutput {
  constructor() {
    super(24000);
  }

  async captureFrame(_frame: AudioFrame): Promise<void> {
    throw new Error('capture rejected');
  }

  clearBuffer(): void {}
}

/**
 * Holds the first frame at a gate (like `ParticipantAudioOutput` does while paused) after
 * counting it, and lets the test report a playback finish while the frame is still parked.
 */
class ParkFirstFrameOutput extends AudioOutput {
  readonly frameParked = new Future<void>();
  private readonly gate = new Future<void>();
  private captures = 0;

  constructor() {
    super(48000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    this.captures++;
    // Count before parking so the finish reported during the park isn't surplus downstream.
    await super.captureFrame(frame);
    if (this.captures === 1) {
      this.frameParked.resolve();
      await this.gate.await;
    }
  }

  reportFinished(playbackPosition: number): void {
    this.onPlaybackFinished({ playbackPosition, interrupted: true });
  }

  releaseGate(): void {
    this.gate.resolve();
  }

  clearBuffer(): void {}
}

// `interrupted: false` can only come from a real downstream finish: a segment the recorder has to
// settle on its own is always synthesized as interrupted. The transcript marker makes the
// attribution unambiguous.
const RETRIED_SEGMENT_FINISH: PlaybackFinishedEvent = {
  playbackPosition: 0,
  interrupted: false,
  synchronizedTranscript: 'retried-segment',
};

class RejectFirstCaptureOutput extends AudioOutput {
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    this.captures++;
    if (this.captures === 1) {
      throw new Error('capture rejected');
    }
    await super.captureFrame(frame);
  }

  finishSegment(): void {
    this.onPlaybackFinished(RETRIED_SEGMENT_FINISH);
  }

  clearBuffer(): void {}
}

class CountThenRejectFirstCaptureOutput extends AudioOutput {
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.captures++;
    if (this.captures === 1) {
      throw new Error('capture rejected after counting');
    }
  }

  finishSegment(): void {
    this.onPlaybackFinished(RETRIED_SEGMENT_FINISH);
  }

  clearBuffer(): void {}
}

class CountThenRejectOutput extends AudioOutput {
  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    throw new Error('capture rejected after counting');
  }

  clearBuffer(): void {}
}

class AcceptThenCountRejectOutput extends AudioOutput {
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.captures++;
    if (this.captures === 2) {
      throw new Error('second capture rejected after counting');
    }
  }

  finishFirstSegment(): void {
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: false });
  }

  clearBuffer(): void {}
}

/**
 * A sink that counts every frame and reports its finish when the test says so — including
 * outside a flush boundary, which the {@link AudioOutput} contract permits.
 */
class AcceptThenFinishOutput extends AudioOutput {
  constructor() {
    super(24000);
  }

  reportFinished(event: PlaybackFinishedEvent): void {
    this.onPlaybackFinished(event);
  }

  clearBuffer(): void {}
}

/**
 * Parks the first frame at a gate and then *drops* it, the way `ParticipantAudioOutput` does
 * when `clearBuffer()` releases a frame that was waiting on the pause gate.
 */
class ParkThenDropOutput extends AudioOutput {
  readonly frameParked = new Future<void>();
  private readonly gate = new Future<void>();
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    this.captures++;
    if (this.captures === 1) {
      this.frameParked.resolve();
      await this.gate.await;
      return;
    }
    await super.captureFrame(frame);
  }

  /** Releases the parked frame without ever counting it, exactly like an interrupted pause gate. */
  dropParkedFrame(): void {
    this.gate.resolve();
  }

  clearBuffer(): void {}
}

/** Parks the first frame *before* counting it, the way `ParticipantAudioOutput`'s pause gate does. */
class ParkBeforeCountOutput extends AudioOutput {
  readonly frameParked = new Future<void>();
  private readonly gate = new Future<void>();
  private captures = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    this.captures++;
    if (this.captures === 1) {
      this.frameParked.resolve();
      await this.gate.await;
    }
    await super.captureFrame(frame);
  }

  releaseGate(): void {
    this.gate.resolve();
  }

  reportFinished(event: PlaybackFinishedEvent): void {
    this.onPlaybackFinished(event);
  }

  clearBuffer(): void {}
}

class FakeTextOutput extends TextOutput {
  async captureText(): Promise<void> {}

  flush(): void {}
}

/**
 * Report a stall as a value rather than letting the test time out, so a hang is distinguishable
 * from an assertion failure in the output.
 */
async function settleOrStall<T>(
  promise: Promise<T>,
  timeoutMs = 200,
): Promise<T | 'did not settle'> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<'did not settle'>((resolve) => {
    timer = setTimeout(() => resolve('did not settle'), timeoutMs);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeFrame(durationMs: number, sampleRate = 48000, channels = 1): AudioFrame {
  const samplesPerChannel = Math.floor((durationMs / 1000) * sampleRate);
  return new AudioFrame(
    new Int16Array(samplesPerChannel * channels),
    sampleRate,
    channels,
    samplesPerChannel,
  );
}

function makeRecorder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-io-test-'));
  const outputPath = path.join(dir, 'audio.ogg');
  const recorder = new RecorderIO({ agentSession: {} as AgentSession });
  const input = new FakeAudioInput();
  const inWrapped = recorder.recordInput(input);
  const outWrapped = recorder.recordOutput(new FakeAudioOutput());
  return { recorder, input, inWrapped, outWrapped, outputPath };
}

describe('RecorderIO close', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
  });

  it('flushes the final agent speech when playbackFinished lands during close', async () => {
    const { recorder, outWrapped, outputPath } = makeRecorder();
    await recorder.start(outputPath);

    await outWrapped.captureFrame(makeFrame(1000));
    outWrapped.flush();

    // Let wall-clock catch up with the pushed duration so the playback
    // position clamp doesn't trim the segment.
    await new Promise((resolve) => setTimeout(resolve, 1050));

    // Mimic the force-interrupt teardown race: close() starts while the
    // playbackFinished event is still in flight.
    const closePromise = recorder.close();
    setTimeout(() => {
      outWrapped.onPlaybackFinished({ playbackPosition: 1.0, interrupted: true });
    }, 100);
    await closePromise;

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
  }, 15000);

  it('close() completes after the flush timeout when playbackFinished never arrives', async () => {
    const { recorder, outWrapped, outputPath } = makeRecorder();
    (recorder as unknown as { closePlayoutFlushTimeoutMs: number }).closePlayoutFlushTimeoutMs =
      150;
    await recorder.start(outputPath);

    await outWrapped.captureFrame(makeFrame(200));
    outWrapped.flush();

    const start = Date.now();
    await recorder.close();

    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    // Nothing reached the encoder, so no file was produced.
    expect(fs.existsSync(outputPath)).toBe(false);
  }, 15000);

  it('settles a dropped, never-flushed segment on close without stalling or warning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-io-test-'));
    const outputPath = path.join(dir, 'audio.ogg');
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    recorder.recordInput(new FakeAudioInput());
    const outWrapped = recorder.recordOutput(new DroppingAudioOutput());
    await recorder.start(outputPath);

    // An interrupt tore the turn down before the segment was flushed, and the sink dropped the
    // frame, so no real playbackFinished will ever arrive for it.
    await outWrapped.captureFrame(makeFrame(200, 24000));
    expect(outWrapped.hasPendingData).toBe(true);

    const warnSpy = vi.spyOn(
      (recorder as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
      'warn',
    );

    const start = Date.now();
    await recorder.close();
    const elapsed = Date.now() - start;

    expect(outWrapped.hasPendingData).toBe(false);
    expect(elapsed).toBeLessThan(1000);
    expect(
      warnSpy.mock.calls.some((args) =>
        args.some(
          (arg) =>
            typeof arg === 'string' && arg.includes('closed before the last playback finished'),
        ),
      ),
    ).toBe(false);
  }, 15000);

  it('flushes trailing input audio on close', async () => {
    const { recorder, input, inWrapped, outputPath } = makeRecorder();
    await recorder.start(outputPath);

    // Frames only accumulate while flowing through the intercepting stream,
    // so consume them like the session does.
    const reader = inWrapped.stream.getReader();
    for (let i = 0; i < 5; i++) {
      await input.push(makeFrame(100));
      await reader.read();
    }
    reader.releaseLock();

    // Close before the 2.5s forward tick: without the final input flush this
    // audio would be dropped.
    await recorder.close();

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
  }, 15000);
});

describe('RecorderAudioOutput', () => {
  it('drops pauses before the segment', async () => {
    vi.useFakeTimers();
    try {
      const writes: AudioFrame[][] = [];
      const recorder = new RecorderIO({ agentSession: {} as AgentSession });
      const recorderState = recorder as unknown as {
        started: boolean;
        writeCb: (buf: AudioFrame[]) => void;
      };
      recorderState.started = true;
      recorderState.writeCb = (buf) => writes.push(buf);
      const output = recorder.recordOutput(new FakeAudioOutput());

      vi.setSystemTime(10_000);
      output.pause();
      vi.setSystemTime(10_500);
      output.resume();
      vi.setSystemTime(11_000);
      const frame = makeFrame(20);
      await output.captureFrame(frame);
      output.flush();
      vi.setSystemTime(11_020);
      output.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });

      expect(writes).toHaveLength(1);
      expect(writes[0]!.reduce((sum, item) => sum + item.samplesPerChannel, 0)).toBe(960);
      recorderState.started = false;
      await recorder.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clips a pause that overlaps the segment', async () => {
    vi.useFakeTimers();
    try {
      const writes: AudioFrame[][] = [];
      const recorder = new RecorderIO({ agentSession: {} as AgentSession });
      const recorderState = recorder as unknown as {
        started: boolean;
        writeCb: (buf: AudioFrame[]) => void;
      };
      recorderState.started = true;
      recorderState.writeCb = (buf) => writes.push(buf);
      const output = recorder.recordOutput(new FakeAudioOutput());

      vi.setSystemTime(10_000);
      output.pause();
      vi.setSystemTime(10_500);
      const frame = makeFrame(20);
      await output.captureFrame(frame);
      vi.setSystemTime(10_700);
      output.resume();
      output.flush();
      vi.setSystemTime(10_720);
      output.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });

      expect(writes).toHaveLength(1);
      expect(writes[0]!.reduce((sum, item) => sum + item.samplesPerChannel, 0)).toBe(10560);
      recorderState.started = false;
      await recorder.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps trailing silence for a midsegment pause', async () => {
    vi.useFakeTimers();
    try {
      const writes: AudioFrame[][] = [];
      const recorder = new RecorderIO({ agentSession: {} as AgentSession });
      const recorderState = recorder as unknown as {
        started: boolean;
        writeCb: (buf: AudioFrame[]) => void;
      };
      recorderState.started = true;
      recorderState.writeCb = (buf) => writes.push(buf);
      const output = recorder.recordOutput(new FakeAudioOutput());

      vi.setSystemTime(10_000);
      await output.captureFrame(makeFrame(100));
      vi.setSystemTime(10_050);
      output.pause();
      output.flush();
      vi.setSystemTime(10_200);
      output.onPlaybackFinished({ playbackPosition: 0.05, interrupted: true });

      expect(writes).toHaveLength(1);
      expect(writes[0]!.reduce((sum, item) => sum + item.samplesPerChannel, 0)).toBe(9600);
      recorderState.started = false;
      await recorder.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not lose a playback finish emitted during first-frame capture', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(new FinishDuringCaptureOutput());

    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const result = await Promise.race([
      output.waitForPlayout().then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).toBe('resolved');
    await recorder.close();
  });

  it('keeps an early-finished segment active until its remaining frames are flushed', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(new FinishDuringCaptureOutput());

    await output.captureFrame(makeFrame(20, 24000));
    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const result = await Promise.race([
      output.waitForPlayout().then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).toBe('resolved');
    await recorder.close();
  });

  it('settles a segment the wrapped output finished before we flushed', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new AcceptThenFinishOutput();
    const output = recorder.recordOutput(downstream);

    await output.captureFrame(makeFrame(20, 24000));
    // The `AudioOutput` contract lets a sink report a finish whenever its playout ends; it does
    // not have to wait for a flush. Requiring one here stranded the caller forever.
    downstream.reportFinished({ playbackPosition: 0, interrupted: true });

    expect(await settleOrStall(output.waitForPlayout())).toEqual({
      playbackPosition: 0,
      interrupted: true,
    });
    await recorder.close();
  });

  it('opens a fresh segment for a capture that follows a settle with no flush', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new AcceptThenFinishOutput();
    const output = recorder.recordOutput(downstream);

    await output.captureFrame(makeFrame(20, 24000));
    downstream.reportFinished({ playbackPosition: 0, interrupted: true });
    await settleOrStall(output.waitForPlayout());

    // Settling outside a flush boundary leaves the base class's capture latch set. Unless it is
    // released, this capture neither counts a new base segment nor finds one of ours, and
    // rejects with `recorder capture has no active segment`.
    await expect(output.captureFrame(makeFrame(20, 24000))).resolves.toBeUndefined();

    output.flush();
    expect(await settleOrStall(output.waitForPlayout())).not.toBe('did not settle');
    await recorder.close();
  });

  it('waits for a frame the wrapped output has parked instead of reporting a fabricated finish', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new ParkBeforeCountOutput();
    const output = recorder.recordOutput(downstream);

    const capture = output.captureFrame(makeFrame(20, 24000));
    await downstream.frameParked.await;

    // Deliberate divergence from the pre-refactor behavior, which returned immediately with a
    // fabricated `{ playbackPosition: 0, interrupted: false }` because the segment had not been
    // registered yet. The audio has demonstrably not finished playing, so claiming it completed
    // is wrong; registering the segment before forwarding is also what makes the finish that
    // arrives during the park attributable at all.
    const wait = output.waitForPlayout();
    expect(await settleOrStall(wait)).toBe('did not settle');

    downstream.releaseGate();
    await capture;
    downstream.reportFinished({ playbackPosition: 0.02, interrupted: false });

    expect(await settleOrStall(wait)).toEqual({ playbackPosition: 0.02, interrupted: false });
    await recorder.close();
  });

  it('settles a dropped segment for a caller that waits without flushing', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(new DroppingAudioOutput());

    // No flush. Synthesizing a finish normally requires one, because the flush is what proves
    // the segment can no longer grow — but once the wrapped output reports its own playout
    // complete, a segment it never accepted can never be finished by anyone, so the wait would
    // otherwise never end.
    await output.captureFrame(makeFrame(20, 24000));

    expect(await settleOrStall(output.waitForPlayout())).toEqual({
      playbackPosition: 0,
      interrupted: true,
    });
    await recorder.close();
  });

  it('settles a segment the wrapped output drops after the wait has already started', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new ParkThenDropOutput();
    const output = recorder.recordOutput(downstream);

    const capture = output.captureFrame(makeFrame(20, 24000));
    await downstream.frameParked.await;

    // The wait starts while the frame is still in flight, so nothing can be settled yet; the
    // drop only becomes visible once the capture returns.
    const wait = output.waitForPlayout();
    expect(await settleOrStall(wait)).toBe('did not settle');

    downstream.dropParkedFrame();
    await capture;

    expect(await settleOrStall(wait)).toEqual({ playbackPosition: 0, interrupted: true });
    await recorder.close();
  });

  it('settles a recorder segment when the wrapped output drops its first frame', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(new DroppingAudioOutput());

    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const result = await Promise.race([
      output.waitForPlayout(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).toEqual({ playbackPosition: 0, interrupted: true });
    await recorder.close();
  });

  it('preserves an older finish while reconciling a dropped overlapping segment', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new PreviousFinishThenDropOutput();
    const output = recorder.recordOutput(downstream);
    const finishes: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event: PlaybackFinishedEvent) => {
      finishes.push(event);
    });
    downstream.onPreviousFinishForwarded = () => {
      expect(finishes).toHaveLength(1);
    };

    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const event = await output.waitForPlayout();

    expect(finishes).toHaveLength(2);
    expect(event).toEqual({ playbackPosition: 0, interrupted: true });
    await recorder.close();
  });

  it('defers a current-segment finish until a later frame capture is recorded', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new FinishDuringLaterFrameOutput();
    const output = recorder.recordOutput(downstream);
    const finishes: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event: PlaybackFinishedEvent) => {
      finishes.push(event);
    });
    downstream.onFinishForwarded = () => {
      expect(finishes).toHaveLength(0);
    };

    await output.captureFrame(makeFrame(20, 24000));
    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const event = await output.waitForPlayout();

    expect(finishes).toHaveLength(1);
    expect(event.interrupted).toBe(true);
    await recorder.close();
  });

  it('settles a dropped older segment before applying a real finish to the next segment', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(new DropThenFinishOutput());
    const finishes: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event: PlaybackFinishedEvent) => {
      finishes.push(event);
    });

    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const result = await Promise.race([
      output.waitForPlayout(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).not.toBe('timeout');
    expect(finishes).toEqual([
      { playbackPosition: 0, interrupted: true },
      {
        playbackPosition: 0,
        interrupted: true,
        synchronizedTranscript: 'accepted-second-segment',
      },
    ]);
    await recorder.close();
  });

  it('does not reconcile a segment while its downstream capture is still in flight', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new BlockingSecondCaptureOutput();
    const output = recorder.recordOutput(downstream);
    const finishes: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event: PlaybackFinishedEvent) => {
      finishes.push(event);
    });

    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const waitForFirstSegment = output.waitForPlayout();
    const captureSecondSegment = output.captureFrame(makeFrame(20, 24000));
    await downstream.secondCaptureStarted.await;

    downstream.finishSegment();
    await waitForFirstSegment;
    expect(finishes).toHaveLength(1);

    downstream.releaseSecondCapture();
    await captureSecondSegment;
    output.flush();
    downstream.finishSegment();
    await output.waitForPlayout();

    expect(finishes).toHaveLength(2);
    await recorder.close();
  });

  it('keeps later segment audio when an older overlapping segment finishes', async () => {
    const writes: AudioFrame[][] = [];
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const recorderState = recorder as unknown as {
      started: boolean;
      writeCb: (buf: AudioFrame[]) => void;
    };
    recorderState.started = true;
    recorderState.writeCb = (buf) => writes.push(buf);
    const downstream = new FakeAudioOutput();
    const output = recorder.recordOutput(downstream);

    await output.captureFrame(makeFrame(1));
    output.flush();
    await output.captureFrame(makeFrame(1));
    output.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));

    downstream.onPlaybackFinished({ playbackPosition: 0.001, interrupted: false });
    downstream.onPlaybackFinished({ playbackPosition: 0.001, interrupted: false });

    expect(writes).toHaveLength(2);
    recorderState.started = false;
    await recorder.close();
  });

  it('keeps the audio a finish reports as played while the first frame was parked', async () => {
    const writes: AudioFrame[][] = [];
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const recorderState = recorder as unknown as {
      started: boolean;
      writeCb: (buf: AudioFrame[]) => void;
    };
    recorderState.started = true;
    recorderState.writeCb = (buf) => writes.push(buf);
    const downstream = new ParkFirstFrameOutput();
    const output = recorder.recordOutput(downstream);

    const capture = output.captureFrame(makeFrame(100));
    await downstream.frameParked.await;
    // Wall-clock advances well past the position the sink is about to report.
    await new Promise((resolve) => setTimeout(resolve, 150));
    downstream.reportFinished(0.05);
    downstream.releaseGate();
    await capture;
    output.flush();

    const capturedSamples = writes
      .flat()
      .reduce((total, frame) => total + frame.samplesPerChannel, 0);
    expect(capturedSamples).toBe(0.05 * 48000);
    recorderState.started = false;
    await recorder.close();
  });

  it('accepts a retried capture after a rejection without an explicit flush', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new RejectFirstCaptureOutput();
    const output = recorder.recordOutput(downstream);

    await expect(output.captureFrame(makeFrame(20, 24000))).rejects.toThrow('capture rejected');

    // A caller that catches the rejection and retries must not be permanently poisoned.
    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const waitForRetriedSegment = output.waitForPlayout();
    downstream.finishSegment();
    const event = await Promise.race([
      waitForRetriedSegment,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(event).toEqual(RETRIED_SEGMENT_FINISH);
    await recorder.close();
  });

  it('accepts a retried capture after a rejection the sink had already counted', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new CountThenRejectFirstCaptureOutput();
    const output = recorder.recordOutput(downstream);
    const finishes: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event: PlaybackFinishedEvent) => {
      finishes.push(event);
    });

    await expect(output.captureFrame(makeFrame(20, 24000))).rejects.toThrow(
      'capture rejected after counting',
    );

    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const waitForRetriedSegment = output.waitForPlayout();
    downstream.finishSegment();
    const event = await Promise.race([
      waitForRetriedSegment,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(event).toEqual(RETRIED_SEGMENT_FINISH);
    expect(finishes).toEqual([{ playbackPosition: 0, interrupted: true }, RETRIED_SEGMENT_FINISH]);
    await recorder.close();
  });

  it('settles recorder state when downstream capture rejects', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(new RejectingAudioOutput());

    await expect(output.captureFrame(makeFrame(20, 24000))).rejects.toThrow('capture rejected');
    const event = await output.waitForPlayout();

    expect(event).toEqual({ playbackPosition: 0, interrupted: true });
    await recorder.close();
  });

  it('settles both outputs when downstream capture rejects after counting', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(new CountThenRejectOutput());

    await expect(output.captureFrame(makeFrame(20, 24000))).rejects.toThrow(
      'capture rejected after counting',
    );
    const result = await Promise.race([
      output.waitForPlayout(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).toEqual({ playbackPosition: 0, interrupted: true });
    await recorder.close();
  });

  it('settles a counted failed segment only after its older segment finishes', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new AcceptThenCountRejectOutput();
    const output = recorder.recordOutput(downstream);
    const finishes: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event: PlaybackFinishedEvent) => {
      finishes.push(event);
    });

    await output.captureFrame(makeFrame(20, 24000));
    output.flush();
    const waitForFirstSegment = output.waitForPlayout();
    await expect(output.captureFrame(makeFrame(20, 24000))).rejects.toThrow(
      'second capture rejected after counting',
    );
    downstream.finishFirstSegment();
    const firstEvent = await waitForFirstSegment;
    await output.waitForPlayout();

    expect(firstEvent).toEqual({ playbackPosition: 0, interrupted: false });
    expect(finishes).toEqual([
      { playbackPosition: 0, interrupted: false },
      { playbackPosition: 0, interrupted: true },
    ]);
    await recorder.close();
  });

  it('snapshots its segment before delegating the playout wait', async () => {
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const downstream = new WaitAwareAudioOutput();
    const output = recorder.recordOutput(downstream);

    await output.captureFrame(makeFrame(20));
    const waitForFirstSegment = output.waitForPlayout();
    await downstream.waitStarted.await;

    output.flush();
    await output.captureFrame(makeFrame(20));
    downstream.releaseWait();

    const event = await waitForFirstSegment;

    expect(event).toEqual({ playbackPosition: 0, interrupted: true });
    downstream.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    await recorder.close();
  });
});

describe('RecorderAudioOutput in front of a real ParticipantAudioOutput', () => {
  function makeParticipantAudioOutput(): ParticipantAudioOutput {
    const out = new ParticipantAudioOutput({} as Room, {
      sampleRate: 24000,
      numChannels: 1,
      trackPublishOptions: new TrackPublishOptions(),
    });
    // `publishTrack` normally resolves this; there is no room to publish to here.
    (out as unknown as { startedFuture: Future<void> }).startedFuture.resolve();
    return out;
  }

  /**
   * The follow-on turn played its 100 ms frame to completion. `finishSegment` clamps the
   * reported position against wall-clock elapsed time, which can land a hair under the pushed
   * duration, so compare with a tolerance rather than exactly.
   */
  function expectFollowOnTurnPlayed(result: PlaybackFinishedEvent | 'did not settle'): void {
    expect(result).not.toBe('did not settle');
    const event = result as PlaybackFinishedEvent;
    expect(event.interrupted).toBe(false);
    expect(event.playbackPosition).toBeCloseTo(0.1, 2);
  }

  it('runs a follow-on turn after a turn interrupted while the output was paused', async () => {
    // The customer's report: an interrupt lands while a frame sits at the pause gate, and the
    // session never speaks again because the interrupted turn's `waitForPlayout` never settles.
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(makeParticipantAudioOutput());

    await output.captureFrame(makeFrame(100, 24000));
    output.flush();

    output.pause();
    const interruptedTurn = output.captureFrame(makeFrame(100, 24000));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // `clearBuffer` both completes the in-flight playout task with an interrupted finish and
    // releases the parked frame without the sink ever counting it.
    output.clearBuffer();
    await interruptedTurn;
    output.flush();

    expect(await settleOrStall(output.waitForPlayout(), 2000)).not.toBe('did not settle');

    output.resume();
    await output.captureFrame(makeFrame(100, 24000));
    output.flush();

    expectFollowOnTurnPlayed(await settleOrStall(output.waitForPlayout(), 3000));
    await recorder.close();
  });

  it('runs a follow-on turn when the interrupted turn never flushed', async () => {
    // Same interrupt, but the turn is torn down without a flush ever reaching us. Every
    // in-tree caller happens to flush first (`forwardAudio` does it in a `finally`), but the
    // wait must not depend on that: the sink dropped the frame, so no finish is coming and
    // there is nothing left to wait for.
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(makeParticipantAudioOutput());

    await output.captureFrame(makeFrame(100, 24000));
    output.flush();

    output.pause();
    const interruptedTurn = output.captureFrame(makeFrame(100, 24000));
    await new Promise((resolve) => setTimeout(resolve, 20));

    output.clearBuffer();
    await interruptedTurn;

    expect(await settleOrStall(output.waitForPlayout(), 2000)).not.toBe('did not settle');

    output.resume();
    await output.captureFrame(makeFrame(100, 24000));
    output.flush();

    expectFollowOnTurnPlayed(await settleOrStall(output.waitForPlayout(), 3000));
    await recorder.close();
  });
});

describe('RecorderAudioOutput behind a TranscriptionSynchronizer', () => {
  it('settles when the synchronizer emits a drift finish from waitForPlayout', async () => {
    // `syncTranscription` is on by default, so this is the default output chain:
    // recorder -> synchronizer -> sink. When the sink drops a frame the synchronizer counted,
    // `SyncedAudioOutput.waitForPlayout` reconciles the drift by emitting a synthetic finish —
    // with no flush anywhere. That makes the "finished before we flushed" case reachable
    // without a custom sink.
    const sink = new DroppingAudioOutput();
    const synchronizer = new TranscriptionSynchronizer(sink, new FakeTextOutput());
    const recorder = new RecorderIO({ agentSession: {} as AgentSession });
    const output = recorder.recordOutput(synchronizer.audioOutput);

    await output.captureFrame(makeFrame(20, 24000));

    expect(await settleOrStall(output.waitForPlayout(), 500)).not.toBe('did not settle');
    await recorder.close();
  });
});

describe('RecorderIO writable stream error detection', () => {
  it('detects ERR_INVALID_STATE stream closure errors', () => {
    const err = new TypeError('Invalid state: WritableStream is closed');
    Object.assign(err, { code: 'ERR_INVALID_STATE' });

    expect(isWritableStreamClosedError(err)).toBe(true);
  });

  it('detects writable stream closed errors by message', () => {
    const err = new TypeError('Invalid state: WritableStream is closed');

    expect(isWritableStreamClosedError(err)).toBe(true);
  });

  it('does not treat unrelated errors as stream closure', () => {
    const err = new Error('network timeout');

    expect(isWritableStreamClosedError(err)).toBe(false);
  });
});
