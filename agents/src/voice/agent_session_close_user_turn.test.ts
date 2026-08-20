// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioInput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

const TRANSCRIPT = 'the mailbox is full and cannot accept new messages at this time';
const ENDPOINTING_DELAY_MS = 3_000;
const CLOSE_DEADLINE_MS = 1_500;

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

describe('AgentSession close final user turn', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('commits a trailing transcript without waiting for endpointing', async () => {
    const stt = new FakeSTT({
      fakeUserSpeeches: [{ startTime: 50, endTime: 200, transcript: TRANSCRIPT, sttDelay: 300 }],
    });
    const session = new AgentSession({
      stt,
      llm: new FakeLLM(),
      turnHandling: {
        turnDetection: 'stt',
        endpointing: { minDelay: ENDPOINTING_DELAY_MS, maxDelay: ENDPOINTING_DELAY_MS },
      },
    });
    const agent = new Agent({ instructions: 'You are a helpful assistant.' });
    const audioInput = new FakeAudioInput();
    session.input.audio = audioInput;
    await session.start({ agent });

    audioInput.push(100);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closeStartedAt = performance.now();
    await session.close();
    const closeDurationMs = performance.now() - closeStartedAt;

    expect(closeDurationMs).toBeLessThan(CLOSE_DEADLINE_MS);
    expect(
      agent.chatCtx.items
        .filter((item) => item.type === 'message' && item.role === 'user')
        .map((item) => item.textContent),
    ).toEqual([TRANSCRIPT]);
  });
});
