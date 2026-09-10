// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { TTS } from '../tts/tts.js';
import { USERDATA_TIMED_TRANSCRIPT } from '../types.js';
import { Future } from '../utils.js';
import { Agent, type ModelSettings } from './agent.js';
import { AgentSession } from './agent_session.js';
import {
  AudioOutput,
  TextOutput,
  type TimedString,
  createTimedString,
  isTimedString,
} from './io.js';
import { SpeechHandle } from './speech_handle.js';

function frame(durationMs = 20, sampleRate = 24000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

class AlignedTestTTS extends TTS {
  label = 'aligned-test-tts';

  constructor(alignedTranscript = true) {
    super(24000, 1, { streaming: true, alignedTranscript });
  }

  synthesize(): never {
    throw new Error('not used');
  }

  stream(): never {
    throw new Error('not used');
  }
}

class AlignedAgent extends Agent {
  ttsCalls = 0;

  constructor(
    private readonly alignedTranscript: TimedString[],
    useTtsAlignedTranscript = true,
    supportsAlignedTranscript = true,
  ) {
    super({
      instructions: 'test',
      tts: new AlignedTestTTS(supportsAlignedTranscript),
      useTtsAlignedTranscript,
    });
  }

  async ttsNode(text: ReadableStream<string>): Promise<ReadableStream<AudioFrame>> {
    this.ttsCalls += 1;
    for await (const _chunk of text) {
      // Consume the scripted text just like a streaming TTS provider.
    }

    const audio = frame();
    audio.userdata[USERDATA_TIMED_TRANSCRIPT] = this.alignedTranscript;
    return new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(audio);
        controller.close();
      },
    });
  }
}

class ImmediateAudioOutput extends AudioOutput {
  private started = false;

  constructor() {
    super(24000);
  }

  async captureFrame(audio: AudioFrame): Promise<void> {
    await super.captureFrame(audio);
    if (!this.started) {
      this.started = true;
      this.onPlaybackStarted(Date.now());
    }
  }

  flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  clearBuffer(): void {
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }
}

class CleanupTrackingAudioOutput extends AudioOutput {
  readonly frameCaptured = new Future<void>();
  clearBufferCalls = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(audio: AudioFrame): Promise<void> {
    await super.captureFrame(audio);
    if (!this.frameCaptured.done) {
      this.frameCaptured.resolve();
    }
  }

  flush(): void {
    super.flush();
  }

  clearBuffer(): void {
    this.clearBufferCalls += 1;
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }
}

class ThrowingTranscriptionAgent extends AlignedAgent {
  constructor(private readonly audioOutput: CleanupTrackingAudioOutput) {
    super([createTimedString({ text: 'Aligned', startTime: 0, endTime: 0.2 })]);
  }

  async transcriptionNode(): Promise<never> {
    await this.audioOutput.frameCaptured.await;
    throw new Error('simulated transcription hook failure');
  }
}

interface TtsTaskInvoker {
  ttsTask(
    speechHandle: SpeechHandle,
    text: string | ReadableStream<string>,
    addToChatCtx: boolean,
    modelSettings: ModelSettings,
    replyAbortController: AbortController,
    audio?: ReadableStream<AudioFrame> | null,
  ): Promise<void>;
}

class CollectingTextOutput extends TextOutput {
  readonly chunks: Array<string | TimedString> = [];

  async captureText(text: string | TimedString): Promise<void> {
    this.chunks.push(text);
  }

  flush(): void {}
}

function audioStream(): ReadableStream<AudioFrame> {
  return new ReadableStream<AudioFrame>({
    start(controller) {
      controller.enqueue(frame());
      controller.close();
    },
  });
}

describe('AgentActivity session.say aligned transcript', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('forwards TTS-aligned text instead of the raw scripted text', async () => {
    const alignedTranscript = [
      createTimedString({ text: 'Aligned ', startTime: 0, endTime: 0.2 }),
      createTimedString({ text: 'speech', startTime: 0.2, endTime: 0.4 }),
    ];
    const session = new AgentSession();
    const transcriptionOutput = new CollectingTextOutput();
    session.output.audio = new ImmediateAudioOutput();
    session.output.transcription = transcriptionOutput;

    await session.start({ agent: new AlignedAgent(alignedTranscript) });
    try {
      await session.say('Raw scripted greeting.').waitForPlayout();

      expect(transcriptionOutput.chunks).toHaveLength(2);
      expect(transcriptionOutput.chunks.every(isTimedString)).toBe(true);
      expect(
        transcriptionOutput.chunks.map((chunk) => (isTimedString(chunk) ? chunk.text : chunk)),
      ).toEqual(['Aligned ', 'speech']);
    } finally {
      await session.close();
    }
  });

  it('forwards the raw scripted text when TTS-aligned transcripts are disabled', async () => {
    const alignedTranscript = [
      createTimedString({ text: 'Aligned ', startTime: 0, endTime: 0.2 }),
      createTimedString({ text: 'speech', startTime: 0.2, endTime: 0.4 }),
    ];
    const session = new AgentSession();
    const transcriptionOutput = new CollectingTextOutput();
    session.output.audio = new ImmediateAudioOutput();
    session.output.transcription = transcriptionOutput;

    await session.start({ agent: new AlignedAgent(alignedTranscript, false) });
    try {
      await session.say('Raw scripted greeting.').waitForPlayout();

      expect(transcriptionOutput.chunks).toEqual(['Raw scripted greeting.']);
    } finally {
      await session.close();
    }
  });

  it('forwards the raw scripted text when the TTS does not support alignment', async () => {
    const session = new AgentSession();
    const transcriptionOutput = new CollectingTextOutput();
    session.output.audio = new ImmediateAudioOutput();
    session.output.transcription = transcriptionOutput;
    const agent = new AlignedAgent([], true, false);

    await session.start({ agent });
    try {
      await session.say('Raw scripted greeting.').waitForPlayout();

      expect(agent.ttsCalls).toBe(1);
      expect(transcriptionOutput.chunks).toEqual(['Raw scripted greeting.']);
    } finally {
      await session.close();
    }
  });

  it('forwards the raw scripted text when the caller provides audio', async () => {
    const session = new AgentSession();
    const transcriptionOutput = new CollectingTextOutput();
    session.output.audio = new ImmediateAudioOutput();
    session.output.transcription = transcriptionOutput;
    const agent = new AlignedAgent([]);

    await session.start({ agent });
    try {
      await session.say('Raw scripted greeting.', { audio: audioStream() }).waitForPlayout();

      expect(agent.ttsCalls).toBe(0);
      expect(transcriptionOutput.chunks).toEqual(['Raw scripted greeting.']);
    } finally {
      await session.close();
    }
  });

  it('forwards the raw scripted text when audio output is disabled', async () => {
    const session = new AgentSession();
    const transcriptionOutput = new CollectingTextOutput();
    session.output.transcription = transcriptionOutput;
    const agent = new AlignedAgent([]);

    await session.start({ agent });
    try {
      await session.say('Raw scripted greeting.').waitForPlayout();

      expect(agent.ttsCalls).toBe(0);
      expect(transcriptionOutput.chunks).toEqual(['Raw scripted greeting.']);
    } finally {
      await session.close();
    }
  });

  it('cleans up audio forwarding when a custom transcription node throws', async () => {
    const session = new AgentSession();
    const audioOutput = new CleanupTrackingAudioOutput();
    session.output.audio = audioOutput;

    await session.start({ agent: new ThrowingTranscriptionAgent(audioOutput) });
    const replyAbortController = new AbortController();
    try {
      const speechHandle = SpeechHandle.create();
      speechHandle._authorizeGeneration();
      const activity = session._activity as unknown as TtsTaskInvoker;

      await expect(
        activity.ttsTask(speechHandle, 'Raw scripted greeting.', false, {}, replyAbortController),
      ).rejects.toThrow('simulated transcription hook failure');
      await vi.waitFor(() => expect(audioOutput.capturedPlayoutSegments).toBe(1));

      expect(replyAbortController.signal.aborted).toBe(true);
      expect(audioOutput.clearBufferCalls).toBe(1);
      expect(audioOutput.pendingPlayoutSegments).toBe(0);
      expect(audioOutput.listenerCount(AudioOutput.EVENT_PLAYBACK_STARTED)).toBe(0);
    } finally {
      replyAbortController.abort();
      audioOutput.removeAllListeners();
      await session.close();
    }
  });
});
