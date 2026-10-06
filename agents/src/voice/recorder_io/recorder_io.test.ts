// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions } from '@livekit/rtc-node';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveFfmpegPath } from '../../ffmpeg.js';
import { initializeLogger } from '../../log.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { Future, isWritableStreamClosedError } from '../../utils.js';
import type { AgentSession } from '../agent_session.js';
import { AudioInput, AudioOutput, type PlaybackFinishedEvent, TextOutput } from '../io.js';
import { ParticipantAudioOutput } from '../room_io/_output.js';
import { TranscriptionSynchronizer } from '../transcription/synchronizer.js';
import { INPUT_STALL_TIMEOUT_MS, RecorderIO, Track, WRITE_INTERVAL_MS } from './recorder_io.js';

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

const RECORDING_RATE = 48000;

function makeFrame(durationMs: number, sampleRate = RECORDING_RATE, channels = 1): AudioFrame {
  const samplesPerChannel = Math.floor((durationMs / 1000) * sampleRate);
  return new AudioFrame(
    new Int16Array(samplesPerChannel * channels),
    sampleRate,
    channels,
    samplesPerChannel,
  );
}

function frameDurationMs(frame: AudioFrame): number {
  return (frame.samplesPerChannel / frame.sampleRate) * 1000;
}

/** A 1kHz tone loud enough to survive the opus encoder. */
function makeToneFrame(durationMs: number, sampleRate = RECORDING_RATE): AudioFrame {
  const samplesPerChannel = Math.floor((durationMs / 1000) * sampleRate);
  const data = new Int16Array(samplesPerChannel);
  for (let i = 0; i < samplesPerChannel; i++) {
    data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate));
  }
  return new AudioFrame(data, sampleRate, 1, samplesPerChannel);
}

interface PlacedAudio {
  channel: 0 | 1;
  startedAt: number;
  frame: AudioFrame;
}

/**
 * A recorder whose queue is replaced by a list, so a test can see exactly which audio the output
 * handed over and when it says it played.
 */
function makePlacingOutput<T extends AudioOutput>(downstream: T) {
  const placed: PlacedAudio[] = [];
  const recorder = new RecorderIO({ agentSession: {} as AgentSession });
  const state = recorder as unknown as {
    started: boolean;
    enqueue: (item: { kind: string } & Partial<PlacedAudio>) => void;
  };
  state.started = true;
  state.enqueue = (item) => {
    if (item.kind === 'captured') {
      placed.push(item as PlacedAudio);
    }
  };
  const output = recorder.recordOutput(downstream);
  return { recorder, output, downstream, placed, state };
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
    // The unreported agent segment is dropped, but the window itself is still recorded as silence.
    expect(fs.existsSync(outputPath)).toBe(true);
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
    // only Date is faked, so the frames arrive on a clock that matches their own duration
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const { recorder, input, inWrapped, outputPath } = makeRecorder();
      await recorder.start(outputPath);

      // Frames only reach the recorder while flowing through the intercepting stream,
      // so consume them like the session does.
      const reader = inWrapped.stream.getReader();
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(Date.now() + 100);
        await input.push(makeFrame(100));
        await reader.read();
      }
      reader.releaseLock();

      // Close before the 2.5s write tick: without the final flush this audio would be dropped.
      await recorder.close();

      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);
});

describe('RecorderAudioOutput', () => {
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
    const { recorder, output, downstream, placed, state } = makePlacingOutput(
      new FakeAudioOutput(),
    );

    await output.captureFrame(makeFrame(1));
    output.flush();
    await output.captureFrame(makeFrame(1));
    output.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));

    downstream.onPlaybackFinished({ playbackPosition: 0.001, interrupted: false });
    downstream.onPlaybackFinished({ playbackPosition: 0.001, interrupted: false });

    expect(placed).toHaveLength(2);
    state.started = false;
    await recorder.close();
  });

  it('keeps the audio a finish reports as played while the first frame was parked', async () => {
    const { recorder, output, downstream, placed, state } = makePlacingOutput(
      new ParkFirstFrameOutput(),
    );

    const capture = output.captureFrame(makeFrame(100));
    await downstream.frameParked.await;
    // Wall-clock advances well past the position the sink is about to report.
    await new Promise((resolve) => setTimeout(resolve, 150));
    downstream.reportFinished(0.05);
    downstream.releaseGate();
    await capture;
    output.flush();

    const capturedSamples = placed.reduce((total, item) => total + item.frame.samplesPerChannel, 0);
    expect(capturedSamples).toBe(0.05 * RECORDING_RATE);
    state.started = false;
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

describe('RecorderAudioOutput placement', () => {
  it('places each report at the time the sink says it played', async () => {
    // A gap between two reports is a gap in the recording, not silence moved to the front.
    const { recorder, output, placed, state } = makePlacingOutput(new FakeAudioOutput());
    await output.captureFrame(makeFrame(1000));
    output.flush();

    output.onPlaybackProgressed({ startedAt: 100_000, offset: 0, duration: 400 });
    output.onPlaybackProgressed({ startedAt: 101_000, offset: 400, duration: 600 });
    output.onPlaybackFinished({ playbackPosition: 1.0, interrupted: false });

    expect(placed.map((item) => item.startedAt)).toEqual([100_000, 101_000]);
    expect(placed.map((item) => frameDurationMs(item.frame))).toEqual([400, 600]);
    state.started = false;
    await recorder.close();
  });

  it('skips the audio a report says never played', async () => {
    // Audio dropped from the sink's queue is a hole in the middle, not a shortened end.
    const { recorder, output, placed, state } = makePlacingOutput(new FakeAudioOutput());
    await output.captureFrame(makeFrame(1000));
    output.flush();

    // 0.2s of the segment was discarded on pause, so the next run resumes past it
    output.onPlaybackProgressed({ startedAt: 100_000, offset: 0, duration: 300 });
    output.onPlaybackProgressed({ startedAt: 100_800, offset: 500, duration: 500 });
    output.onPlaybackFinished({ playbackPosition: 0.8, interrupted: false });

    expect(placed.map((item) => item.startedAt)).toEqual([100_000, 100_800]);
    expect(placed.map((item) => frameDurationMs(item.frame))).toEqual([300, 500]);
    state.started = false;
    await recorder.close();
  });

  it('anchors a sink that reports nothing at playbackStarted', async () => {
    // The fallback is the shape a remote sink sends: one report for the whole segment.
    vi.useFakeTimers();
    try {
      const { recorder, output, placed, state } = makePlacingOutput(new FakeAudioOutput());
      await output.captureFrame(makeFrame(1000));
      output.flush();

      output.onPlaybackStarted(100_000);
      vi.setSystemTime(105_000); // noticed long after the audio really stopped
      output.onPlaybackFinished({ playbackPosition: 1.0, interrupted: false });

      expect(placed).toHaveLength(1);
      // not 105_000 - 1000, which is where the old recorder put it
      expect(placed[0]!.startedAt).toBe(100_000);
      expect(frameDurationMs(placed[0]!.frame)).toBe(1000);
      state.started = false;
      await recorder.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dates a sink with no start of its own from the segment end', async () => {
    // Last resort for a remote sink that never reports a start.
    vi.useFakeTimers();
    try {
      const { recorder, output, placed, state } = makePlacingOutput(new FakeAudioOutput());
      await output.captureFrame(makeFrame(1000));
      output.flush();

      vi.setSystemTime(105_000);
      output.onPlaybackFinished({ playbackPosition: 1.0, interrupted: false });

      expect(placed).toHaveLength(1);
      expect(placed[0]!.startedAt).toBe(104_000);
      state.started = false;
      await recorder.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('truncates an interrupted segment in the fallback', async () => {
    const { recorder, output, placed, state } = makePlacingOutput(new FakeAudioOutput());
    await output.captureFrame(makeFrame(1000));
    output.flush();

    output.onPlaybackStarted(100_000);
    output.onPlaybackFinished({ playbackPosition: 0.4, interrupted: true });

    expect(placed).toHaveLength(1);
    expect(frameDurationMs(placed[0]!.frame)).toBe(400);
    state.started = false;
    await recorder.close();
  });

  it('holds the timeline while a segment is in flight', async () => {
    // The writer cannot settle a window whose agent audio has not been reported yet.
    const { recorder, output, state } = makePlacingOutput(new FakeAudioOutput());
    expect(output.pendingSince).toBeUndefined();

    await output.captureFrame(makeFrame(1000));
    expect(output.pendingSince).toBeDefined();

    output.onPlaybackProgressed({ startedAt: 100_000, offset: 0, duration: 1000 });
    output.onPlaybackFinished({ playbackPosition: 1.0, interrupted: false });
    expect(output.pendingSince).toBeUndefined();
    state.started = false;
    await recorder.close();
  });
});

describe('Track', () => {
  /** A frame whose every sample is loud, so placement shows up as non-zero samples. */
  function loudFrame(samples: number, sampleRate = 1000, channels = 1): AudioFrame {
    return new AudioFrame(
      new Int16Array(samples * channels).fill(1000),
      sampleRate,
      channels,
      samples,
    );
  }

  const placedStarts = (track: Track) =>
    (track as unknown as { placed: Array<{ start: number }> }).placed.map((run) => run.start);

  it('lands placed audio at its own timestamp', () => {
    const track = new Track(1000, 0);
    track.push(2000, loudFrame(100));

    const block = track.take(0, 3000);
    expect(block.slice(0, 2000).every((sample) => sample === 0)).toBe(true);
    expect(block.slice(2000, 2100).every((sample) => sample > 0)).toBe(true);
    expect(block.slice(2100).every((sample) => sample === 0)).toBe(true);
  });

  it('keeps a gap between two runs a gap', () => {
    const track = new Track(1000, 0);
    track.push(0, loudFrame(100));
    track.push(500, loudFrame(100));

    const block = track.take(0, 1000);
    expect(block.slice(0, 100).every((sample) => sample > 0)).toBe(true);
    expect(block.slice(100, 500).every((sample) => sample === 0)).toBe(true);
    expect(block.slice(500, 600).every((sample) => sample > 0)).toBe(true);
  });

  it('drops and counts audio that arrives after its window was written', () => {
    const track = new Track(1000, 0);
    track.take(0, 2000); // the first two seconds have already gone to the encoder
    track.push(500, loudFrame(100));

    expect(track.take(2000, 3000).every((sample) => sample === 0)).toBe(true);
    expect(track.droppedSamples).toBe(100);
  });

  it('re-anchors a run when its clock drifts', () => {
    const track = new Track(1000, 0);
    track.push(0, loudFrame(100));
    track.push(100, loudFrame(100)); // contiguous, extends the run
    track.push(5000, loudFrame(100)); // beyond tolerance, anchors on its own timestamp

    expect(placedStarts(track)).toEqual([0, 100, 5000]);
  });

  it('resamples a source below the recording rate in place', () => {
    const track = new Track(48000, 0);
    track.push(1000, loudFrame(2400, 24000)); // 100ms at 24kHz
    track.push(9000, loudFrame(2400, 24000)); // a new run, so the first one is complete

    const block = track.take(0, 48000 * 2);
    expect(block.slice(0, 48000).every((sample) => sample === 0)).toBe(true);
    // 100ms of audio, twice as many samples at the recording rate; the samples the resampler
    // still held when the run ended are part of it
    const nonZero = block.slice(48000).filter((sample) => sample !== 0).length;
    expect(nonZero).toBeGreaterThan(4750);
    expect(nonZero).toBeLessThan(4850);
  });

  it('mixes a stereo source down', () => {
    const track = new Track(1000, 0);
    track.push(0, loudFrame(100, 1000, 2));

    const block = track.take(0, 200);
    // samples, not interleaved values
    expect(block.filter((sample) => sample !== 0).length).toBe(100);
    expect(block[0]).toBeCloseTo(1000 / 32768, 4);
  });
});

describe('RecorderIO end to end', () => {
  /** Decode the recording back to two float channels at its own sample rate. */
  function decodeStereo(filePath: string): [Float32Array, Float32Array] {
    const raw = execFileSync(
      resolveFfmpegPath() ?? 'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        filePath,
        '-f',
        's16le',
        '-ac',
        '2',
        '-ar',
        String(RECORDING_RATE),
        '-',
      ],
      { maxBuffer: 1 << 28 },
    );
    // copied into a fresh buffer: the pipe's Buffer is not guaranteed to be 2-byte aligned
    const pcm = new Int16Array(new Uint8Array(raw).buffer);
    const left = new Float32Array(pcm.length / 2);
    const right = new Float32Array(pcm.length / 2);
    for (let i = 0; i < left.length; i++) {
      left[i] = pcm[i * 2]! / 32768;
      right[i] = pcm[i * 2 + 1]! / 32768;
    }
    return [left, right];
  }

  /** Peak amplitude over `[fromMs, toMs)` of one decoded channel. */
  function peak(channel: Float32Array, fromMs: number, toMs: number): number {
    const from = Math.round((fromMs / 1000) * RECORDING_RATE);
    const to = Math.min(Math.round((toMs / 1000) * RECORDING_RATE), channel.length);
    let loudest = 0;
    for (let i = from; i < to; i++) {
      loudest = Math.max(loudest, Math.abs(channel[i]!));
    }
    return loudest;
  }

  it('records each channel where it happened', async () => {
    // The agent speaks 0.5s, goes quiet for 0.5s, speaks 0.5s. The microphone delivers for the
    // first second, then stops. Neither hole may be filled by moving the audio around it.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-io-test-'));
      const outputPath = path.join(dir, 'session.ogg');
      const recorder = new RecorderIO({ agentSession: {} as AgentSession });
      const source = new FakeAudioInput();
      const audioIn = recorder.recordInput(source);
      const audioOut = recorder.recordOutput(new FakeAudioOutput());
      await recorder.start(outputPath);
      const t0 = Date.now();

      // a microphone that delivers for one second, then goes quiet
      const reader = audioIn.stream.getReader();
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(Date.now() + 100);
        await source.push(makeToneFrame(100));
        await reader.read();
      }
      reader.releaseLock();

      // the agent speaks, stalls, then speaks again
      await audioOut.captureFrame(makeToneFrame(1000));
      audioOut.flush();
      audioOut.onPlaybackStarted(t0 + 1500);
      audioOut.onPlaybackProgressed({ startedAt: t0 + 1500, offset: 0, duration: 500 });
      audioOut.onPlaybackProgressed({ startedAt: t0 + 2500, offset: 500, duration: 500 });
      vi.setSystemTime(t0 + 3000);
      audioOut.onPlaybackFinished({ playbackPosition: 1.0, interrupted: false });

      await recorder.close();

      const [userChannel, agentChannel] = decodeStereo(outputPath);
      expect(userChannel.length / RECORDING_RATE).toBeCloseTo(3.0, 1);

      // the microphone's first second is there, and its silence is silence
      expect(peak(userChannel, 50, 950)).toBeGreaterThan(0.05);
      expect(peak(userChannel, 1050, 3000)).toBeLessThan(0.01);

      // the agent's two utterances sit either side of the stall, not packed together
      expect(peak(agentChannel, 0, 1450)).toBeLessThan(0.01);
      expect(peak(agentChannel, 1550, 1950)).toBeGreaterThan(0.05);
      expect(peak(agentChannel, 2050, 2450)).toBeLessThan(0.01);
      expect(peak(agentChannel, 2550, 2950)).toBeGreaterThan(0.05);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});

describe('RecorderAudioOutput event forwarding', () => {
  /** The device at the end of the chain: the only output that knows where its audio went. */
  class LeafAudioOutput extends AudioOutput {
    constructor() {
      super(RECORDING_RATE);
    }

    clearBuffer(): void {}
  }

  /** A wrapper that forwards audio, the way the transcription synchronizer sits in the chain. */
  class PassthroughAudioOutput extends AudioOutput {
    constructor(nextInChain: AudioOutput) {
      super(nextInChain.sampleRate, nextInChain);
    }

    override async captureFrame(frame: AudioFrame): Promise<void> {
      await super.captureFrame(frame);
      await this.nextInChain!.captureFrame(frame);
    }

    clearBuffer(): void {}
  }

  it('carries a report from two levels down up to the recorder', async () => {
    // Nothing else covers the listener the base class registers on `nextInChain`. Without it
    // every recorder silently falls back to the segment endpoints, and the rest of the suite
    // still passes because it calls `onPlaybackProgressed` directly.
    const leaf = new LeafAudioOutput();
    const { recorder, output, placed, state } = makePlacingOutput(new PassthroughAudioOutput(leaf));

    await output.captureFrame(makeFrame(1000));
    output.flush();

    leaf.onPlaybackProgressed({ startedAt: 100_000, offset: 0, duration: 400 });
    leaf.onPlaybackFinished({ playbackPosition: 0.4, interrupted: false });

    expect(placed).toHaveLength(1);
    // the sink's own timestamp, not the `Date.now()` the endpoint fallback would have used
    expect(placed[0]!.startedAt).toBe(100_000);
    expect(frameDurationMs(placed[0]!.frame)).toBeCloseTo(400);
    state.started = false;
    await recorder.close();
  });
});

describe('RecorderIO write task', () => {
  it('waits on the agent but not on a quiet source', async () => {
    // A segment in flight holds the timeline; a microphone that went quiet does not.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const flushed: number[] = [];
      const recorder = new RecorderIO({ agentSession: {} as AgentSession });
      recorder.recordInput(new FakeAudioInput());
      const audioOut = recorder.recordOutput(new FakeAudioOutput());
      const state = recorder as unknown as {
        started: boolean;
        t0: number;
        inputSettled: number;
        enqueue: (item: { kind: string; until?: number }) => void;
        write: (signal: AbortSignal) => Promise<void>;
      };
      state.started = true;
      state.t0 = state.inputSettled = Date.now();
      state.enqueue = (item) => {
        if (item.kind === 'flush') flushed.push(item.until!);
      };

      const controller = new AbortController();
      const writing = state.write(controller.signal);

      // the source has delivered nothing, so the writer waits out the stall timeout and no more
      await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS);
      expect(flushed.at(-1)).toBe(Date.now() - INPUT_STALL_TIMEOUT_MS);

      // a segment opens, and it has not said where its audio went
      await audioOut.captureFrame(makeFrame(200));
      const segmentBegan = audioOut.pendingSince;
      await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS);
      expect(flushed.at(-1)).toBe(segmentBegan);

      controller.abort();
      await writing;
      state.started = false;
    } finally {
      vi.useRealTimers();
    }
  });
});
