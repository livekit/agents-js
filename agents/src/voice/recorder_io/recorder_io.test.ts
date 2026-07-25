// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { Future, isWritableStreamClosedError } from '../../utils.js';
import type { AgentSession } from '../agent_session.js';
import { AudioInput, AudioOutput, type PlaybackFinishedEvent } from '../io.js';
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
