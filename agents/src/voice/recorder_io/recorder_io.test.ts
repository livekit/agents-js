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
import { AudioInput, AudioOutput } from '../io.js';
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
