// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { SpeechStream } from '../stt/stt.js';
import { FakeRecognizeStream, FakeSTT } from '../stt/testing/fake_stt.js';
import type { APIConnectOptions } from '../types.js';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioInput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

const SPEECH_MS = 300;
const TRAILING_AUDIO_MS = 200;
const INTERIM_TRANSCRIPT = 'can you check';
const FINAL_TRANSCRIPT = 'can you check the connection';
const COMMIT_DEADLINE_MS = 3_000;

/**
 * Behaves like a streaming provider that only finalizes an utterance after it
 * has received trailing audio: an interim result arrives mid-speech and the
 * final result only once `SPEECH_MS + TRAILING_AUDIO_MS` of audio has been
 * pushed. If the input is detached right after the speech, the final never
 * arrives unless the recognizer flushes the stream with silence.
 */
class TrailingAudioStream extends FakeRecognizeStream {
  protected override async run(): Promise<void> {
    let receivedMs = 0;
    let interimSent = false;
    let finalSent = false;
    for await (const data of this.input) {
      if (data === SpeechStream.FLUSH_SENTINEL) continue;
      receivedMs += (data.samplesPerChannel / data.sampleRate) * 1000;
      if (!interimSent && receivedMs >= SPEECH_MS / 2) {
        interimSent = true;
        this.sendFakeTranscript(INTERIM_TRANSCRIPT, false);
      }
      if (!finalSent && receivedMs >= SPEECH_MS + TRAILING_AUDIO_MS) {
        finalSent = true;
        this.sendFakeTranscript(FINAL_TRANSCRIPT, true);
      }
    }
  }
}

class TrailingAudioSTT extends FakeSTT {
  override stream(options?: { connOptions?: APIConnectOptions }): FakeRecognizeStream {
    return new TrailingAudioStream(this, options?.connOptions);
  }
}

class FakeAudioInput extends AudioInput {
  readonly #controller: ReadableStreamDefaultController<AudioFrame>;

  constructor() {
    super();
    let controller!: ReadableStreamDefaultController<AudioFrame>;
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start(streamController) {
          controller = streamController;
        },
      }),
    );
    this.#controller = controller;
  }

  push(durationMs: number, sampleRate = 16_000): void {
    const samples = Math.floor((sampleRate * durationMs) / 1000);
    this.#controller.enqueue(new AudioFrame(new Int16Array(samples), sampleRate, 1, samples));
  }
}

const userMessages = (agent: Agent) =>
  agent.chatCtx.items
    .filter((item) => item.type === 'message' && item.role === 'user')
    .map((item) => item.textContent);

describe('AgentSession manual commit with detached audio', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('flushes the STT with silence so the committed turn holds the final transcript', async () => {
    const stt = new TrailingAudioSTT({ capabilities: { interimResults: true } });
    const session = new AgentSession({
      stt,
      llm: new FakeLLM(),
      vad: null,
      turnHandling: { turnDetection: 'manual' },
    });
    const agent = new Agent({ instructions: 'You are a helpful assistant.' });
    const audioInput = new FakeAudioInput();
    session.input.audio = audioInput;
    await session.start({ agent });

    try {
      audioInput.push(SPEECH_MS);
      await delay(150);

      // The documented push-to-talk release: stop the input, then commit.
      session.input.setAudioEnabled(false);
      session.commitUserTurn();

      const deadline = performance.now() + COMMIT_DEADLINE_MS;
      while (userMessages(agent).length === 0 && performance.now() < deadline) {
        await delay(20);
      }

      expect(userMessages(agent)).toEqual([FINAL_TRANSCRIPT]);
    } finally {
      await session.close();
    }
  });
});
