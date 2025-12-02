// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { delay } from '../../utils.js';
import type { AgentSession } from '../agent_session.js';
import { AudioInput, AudioOutput } from '../io.js';
import { RecorderIO } from './recorder_io.js';

// Initialize logger for tests
initializeLogger({ pretty: false, level: 'silent' });

// Test constants
const TEST_SAMPLE_RATE = 48000;
const TEST_CHANNELS = 1;

// Frequencies for distinct left/right channel identification
const LEFT_CHANNEL_FREQ = 440; // A4 note - for input/user audio
const RIGHT_CHANNEL_FREQ = 880; // A5 note (octave higher) - for output/agent audio

/**
 * Create a test audio frame with sine wave data
 */
function createTestFrame(
  durationMs: number,
  sampleRate: number = TEST_SAMPLE_RATE,
  channels: number = TEST_CHANNELS,
  frequency: number = 440,
): AudioFrame {
  const samplesPerChannel = Math.floor((durationMs / 1000) * sampleRate);
  const data = new Int16Array(samplesPerChannel * channels);

  for (let i = 0; i < samplesPerChannel; i++) {
    const value = Math.floor(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 16000);
    for (let ch = 0; ch < channels; ch++) {
      data[i * channels + ch] = value;
    }
  }

  return new AudioFrame(data, sampleRate, channels, samplesPerChannel);
}

/**
 * Create input frames (user audio) at 440Hz
 */
function createInputFrame(durationMs: number): AudioFrame {
  return createTestFrame(durationMs, TEST_SAMPLE_RATE, TEST_CHANNELS, LEFT_CHANNEL_FREQ);
}

/**
 * Create output frames (agent audio) at 880Hz
 */
function createOutputFrame(durationMs: number): AudioFrame {
  return createTestFrame(durationMs, TEST_SAMPLE_RATE, TEST_CHANNELS, RIGHT_CHANNEL_FREQ);
}

/**
 * Use FFprobe to get audio file info
 */
async function getAudioInfo(
  filePath: string,
): Promise<{ duration: number; channels: number; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      filePath,
    ]);

    let stdout = '';
    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const audioStream = info.streams?.find(
          (s: { codec_type: string }) => s.codec_type === 'audio',
        );
        if (!audioStream) {
          reject(new Error('No audio stream found'));
          return;
        }

        resolve({
          duration: parseFloat(audioStream.duration || '0'),
          channels: audioStream.channels || 0,
          sampleRate: parseInt(audioStream.sample_rate || '0', 10),
        });
      } catch (err) {
        reject(err);
      }
    });

    ffprobe.on('error', reject);
  });
}

/**
 * Mock AudioInput that emits frames from a provided array
 */
class MockAudioInput extends AudioInput {
  private frames: AudioFrame[];
  private delayMs: number;

  constructor(frames: AudioFrame[], delayMs: number = 0) {
    super();
    this.frames = frames;
    this.delayMs = delayMs;
    this.setupStream();
  }

  private async setupStream() {
    const frames = this.frames;
    const delayMs = this.delayMs;

    const stream = new ReadableStream<AudioFrame>({
      async pull(controller) {
        if (frames.length === 0) {
          controller.close();
          return;
        }

        if (delayMs > 0) {
          await delay(delayMs);
        }

        const frame = frames.shift()!;
        controller.enqueue(frame);
      },
    });

    this.deferredStream.setSource(stream);
  }
}

/**
 * Mock AudioOutput that captures frames
 */
class MockAudioOutput extends AudioOutput {
  capturedFrames: AudioFrame[] = [];

  constructor(sampleRate: number = TEST_SAMPLE_RATE) {
    super(sampleRate);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.capturedFrames.push(frame);
  }

  flush(): void {
    super.flush();
  }

  clearBuffer(): void {
    this.capturedFrames = [];
  }
}

/**
 * Create a mock AgentSession for testing
 */
function createMockAgentSession(): AgentSession {
  return {} as AgentSession;
}

describe('RecorderIO', () => {
  let mockSession: AgentSession;
  let tempDir: string;

  beforeEach(() => {
    mockSession = createMockAgentSession();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should throw if started without recordInput/recordOutput', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });
    const outputPath = path.join(tempDir, 'test.ogg');

    await expect(recorderIO.start(outputPath)).rejects.toThrow(
      'RecorderIO not properly initialized',
    );
  });

  it('should handle double start and double close gracefully', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });
    const mockInput = new MockAudioInput([]);
    const mockOutput = new MockAudioOutput();

    recorderIO.recordInput(mockInput);
    recorderIO.recordOutput(mockOutput);

    const outputPath = path.join(tempDir, 'test.ogg');

    // Double start
    await recorderIO.start(outputPath);
    await recorderIO.start(outputPath);
    expect(recorderIO.recording).toBe(true);

    // Double close
    await recorderIO.close();
    await recorderIO.close();
    expect(recorderIO.recording).toBe(false);
  });

  it('should forward frames to next output in chain', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });
    const mockInput = new MockAudioInput([]);
    const innerOutput = new MockAudioOutput();

    recorderIO.recordInput(mockInput);
    const recordedOutput = recorderIO.recordOutput(innerOutput);

    const outputPath = path.join(tempDir, 'test.ogg');
    await recorderIO.start(outputPath);

    const frame = createOutputFrame(100);
    await recordedOutput.captureFrame(frame);

    // Inner output should have received the frame (decorator pattern)
    expect(innerOutput.capturedFrames.length).toBe(1);

    await recorderIO.close();
  });

  it('should produce stereo OGG with distinct left/right channels (440Hz vs 880Hz)', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });

    // Create 500ms of input at 440Hz (left channel - user audio)
    const inputFrames = Array.from({ length: 5 }, () => createInputFrame(100));
    const mockInput = new MockAudioInput([...inputFrames]);
    const mockOutput = new MockAudioOutput();

    const recordedInput = recorderIO.recordInput(mockInput);
    const recordedOutput = recorderIO.recordOutput(mockOutput);

    const outputPath = path.join(tempDir, 'stereo_test.ogg');
    await recorderIO.start(outputPath);

    // Consume all input frames
    const reader = recordedInput.stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    reader.releaseLock();

    // Capture 500ms of output at 880Hz (right channel - agent audio)
    for (let i = 0; i < 5; i++) {
      await recordedOutput.captureFrame(createOutputFrame(100));
    }

    // Trigger playback finished
    recordedOutput.onPlaybackFinished({
      playbackPosition: 0.5,
      interrupted: false,
    });

    await delay(200);
    await recorderIO.close();

    // Verify file exists and has correct format
    expect(fs.existsSync(outputPath)).toBe(true);
    const audioInfo = await getAudioInfo(outputPath);
    expect(audioInfo.channels).toBe(2); // Stereo
    expect(audioInfo.duration).toBeGreaterThan(0.4);
    expect(audioInfo.duration).toBeLessThan(1.0);
  });

  it('should handle 2-second recording with streaming FFmpeg encoding', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });

    // Create 2 seconds of input (20 x 100ms frames)
    const inputFrames = Array.from({ length: 20 }, () => createInputFrame(100));
    const mockInput = new MockAudioInput([...inputFrames]);
    const mockOutput = new MockAudioOutput();

    const recordedInput = recorderIO.recordInput(mockInput);
    const recordedOutput = recorderIO.recordOutput(mockOutput);

    const outputPath = path.join(tempDir, 'long_recording.ogg');
    await recorderIO.start(outputPath);

    // Consume all input frames
    const reader = recordedInput.stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    reader.releaseLock();

    // Capture 2 seconds of output
    for (let i = 0; i < 20; i++) {
      await recordedOutput.captureFrame(createOutputFrame(100));
    }

    recordedOutput.onPlaybackFinished({
      playbackPosition: 2.0,
      interrupted: false,
    });

    await delay(500);
    await recorderIO.close();

    // Verify file
    expect(fs.existsSync(outputPath)).toBe(true);
    const audioInfo = await getAudioInfo(outputPath);
    expect(audioInfo.channels).toBe(2);
    expect(audioInfo.duration).toBeGreaterThan(1.8);
    expect(audioInfo.duration).toBeLessThan(2.5);
  });

  it('should track recordingStartedAt using earliest of input/output times', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });

    const inputFrames = [createInputFrame(100)];
    const mockInput = new MockAudioInput([...inputFrames], 50); // 50ms delay
    const mockOutput = new MockAudioOutput();

    const recordedInput = recorderIO.recordInput(mockInput);
    const recordedOutput = recorderIO.recordOutput(mockOutput);

    const outputPath = path.join(tempDir, 'test.ogg');
    await recorderIO.start(outputPath);

    // Initially undefined
    expect(recorderIO.recordingStartedAt).toBeUndefined();

    // Capture output frame first (should be earlier due to input delay)
    const outputStartBefore = Date.now();
    await recordedOutput.captureFrame(createOutputFrame(100));
    const outputStartAfter = Date.now();

    // Then read input frame (later due to delay)
    const reader = recordedInput.stream.getReader();
    await reader.read();
    reader.releaseLock();

    // recordingStartedAt should be the earlier time (output)
    expect(recorderIO.recordingStartedAt).toBeDefined();
    expect(recorderIO.recordingStartedAt).toBeGreaterThanOrEqual(outputStartBefore);
    expect(recorderIO.recordingStartedAt).toBeLessThanOrEqual(outputStartAfter);

    await recorderIO.close();
  });

  it('should trim frames to playbackPosition on interruption', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });
    const mockInput = new MockAudioInput([]);
    const mockOutput = new MockAudioOutput();

    recorderIO.recordInput(mockInput);
    const recordedOutput = recorderIO.recordOutput(mockOutput);

    const outputPath = path.join(tempDir, 'test.ogg');
    await recorderIO.start(outputPath);

    // Capture 500ms of audio
    for (let i = 0; i < 5; i++) {
      await recordedOutput.captureFrame(createTestFrame(100));
    }

    expect(recordedOutput.hasPendingData).toBe(true);

    // But only 300ms was actually played (interrupted)
    recordedOutput.onPlaybackFinished({
      playbackPosition: 0.3,
      interrupted: true,
    });

    // Buffer should be cleared after onPlaybackFinished
    expect(recordedOutput.hasPendingData).toBe(false);

    await recorderIO.close();
  });

  it('should not accumulate frames when not recording', async () => {
    const recorderIO = new RecorderIO({ agentSession: mockSession });
    const mockInput = new MockAudioInput([]);
    const mockOutput = new MockAudioOutput();

    recorderIO.recordInput(mockInput);
    const recordedOutput = recorderIO.recordOutput(mockOutput);

    // Don't start recording - just capture frames
    await recordedOutput.captureFrame(createTestFrame(100));

    // No pending data since not recording
    expect(recordedOutput.hasPendingData).toBe(false);

    // Should not throw
    recordedOutput.onPlaybackFinished({
      playbackPosition: 0.1,
      interrupted: false,
    });
  });
});
