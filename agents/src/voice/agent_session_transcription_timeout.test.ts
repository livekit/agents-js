// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Session-level coverage for the public `user_transcription_timeout` event.
//
// The unit tests in `audio_recognition_transcription_timeout.test.ts` all stop
// at the `RecognitionHooks` boundary, so none of them reach
// `AgentActivity.onTranscriptionTimeout` -> `createUserTranscriptionTimeoutEvent`
// -> `AgentSession.emit`. Python asserts on the real event object in every
// `tests/test_transcription_timeout.py` scenario; this is the JS counterpart to
// `test_interim_only_still_fires`, carrying the payload and `created_at`
// assertions from `test_fires_when_vad_speech_not_transcribed`.
//
// Python uses seconds; JS uses milliseconds.
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { VAD, type VADEvent, VADEventType, VADStream } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type UserTranscriptionTimeoutEvent } from './events.js';
import { AudioInput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

const TIMEOUT_MS = 1_000;
const SPEECH_DURATION_MS = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

function silenceFrame(durationMs: number, sampleRate = 16_000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

function vadEvent(
  type: VADEventType.START_OF_SPEECH | VADEventType.END_OF_SPEECH,
  options: Partial<VADEvent> = {},
): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration: 0,
    silenceDuration: 0,
    frames: [],
    probability: 1,
    inferenceDuration: 0,
    speaking: type === VADEventType.START_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
    ...options,
  };
}

/**
 * A VAD whose events the test emits by hand. It subclasses the real
 * VAD/VADStream so `instanceof` checks in AgentActivity hold and the tee'd audio
 * branch stays drained (otherwise backpressure stalls the shared pipeline).
 */
class ScriptedVADStream extends VADStream {
  constructor(vad: VAD) {
    super(vad);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (!this.closed) {
        const { done } = await this.inputReader.read();
        if (done) break;
      }
    } catch {
      /* stream detached/closed */
    }
  }

  emitEvent(ev: VADEvent): void {
    this.sendVADEvent(ev);
  }
}

class ScriptedVAD extends VAD {
  label = 'scripted-vad';
  readonly streams: ScriptedVADStream[] = [];

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): ScriptedVADStream {
    const stream = new ScriptedVADStream(this);
    this.streams.push(stream);
    return stream;
  }
}

/** Audio input that lets the test push frames into the session, like a SIP line. */
class ScriptedAudioInput extends AudioInput {
  #controller!: ReadableStreamDefaultController<AudioFrame>;

  constructor() {
    super();
    const source = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    this.multiStream.addInputStream(source);
  }

  push(frame: AudioFrame): void {
    this.#controller.enqueue(frame);
  }
}

describe('AgentSession user transcription timeout event', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('emits user_transcription_timeout to a session listener when only an interim transcript arrives', async () => {
    const vad = new ScriptedVAD();
    // Interim-only scripted speech: the provider emits an interim result and
    // never a final one, so the turn stays untranscribed and never commits.
    const stt = new FakeSTT({
      capabilities: { streaming: true, interimResults: true },
      fakeUserSpeeches: [
        {
          startTime: 0,
          endTime: 200,
          transcript: 'hello how are you',
          sttDelay: 200,
          final: false,
        },
      ],
    });

    const session = new AgentSession({
      stt,
      vad,
      llm: new FakeLLM(),
      transcriptionTimeout: TIMEOUT_MS,
      turnHandling: { turnDetection: 'vad', interruption: { mode: 'vad' } },
    });

    const events: UserTranscriptionTimeoutEvent[] = [];
    session.on(AgentSessionEventTypes.UserTranscriptionTimeout, (ev) => events.push(ev));

    const audioInput = new ScriptedAudioInput();
    session.input.audio = audioInput;
    await session.start({ agent: new Agent({ instructions: 'You are a helpful assistant.' }) });

    const pump = setInterval(() => audioInput.push(silenceFrame(50)), 50);
    let beforeStartOfSpeech = 0;
    let afterEndOfSpeech = 0;
    try {
      await waitFor(() => vad.streams.length > 0, 5_000, 'the VAD stream to open');
      const stream = vad.streams[0]!;

      beforeStartOfSpeech = Date.now();
      stream.emitEvent(vadEvent(VADEventType.START_OF_SPEECH));
      await sleep(SPEECH_DURATION_MS);
      stream.emitEvent(
        vadEvent(VADEventType.END_OF_SPEECH, { speechDuration: SPEECH_DURATION_MS }),
      );
      afterEndOfSpeech = Date.now();

      await waitFor(() => events.length > 0, 10_000, 'the transcription timeout event');
    } finally {
      clearInterval(pump);
      await session.close().catch(() => {});
    }

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('user_transcription_timeout');
    // Accumulated from the VAD END_OF_SPEECH, in milliseconds.
    expect(event.speechDuration).toBe(SPEECH_DURATION_MS);
    // Epoch milliseconds pinned to when VAD first detected speech. A seconds
    // scale would land ~1.7e9 short of this window.
    expect(event.vadSpeechStartedAt).toBeGreaterThanOrEqual(beforeStartOfSpeech);
    expect(event.vadSpeechStartedAt).toBeLessThanOrEqual(afterEndOfSpeech);
    // Python pins `created_at - t_origin` to `2.5 + TIMEOUT`; without virtual
    // time we can only bound it, but the lower bound still proves the event was
    // stamped no earlier than a full timeout after the turn started.
    expect(Number.isFinite(event.createdAt)).toBe(true);
    expect(event.createdAt).toBeGreaterThanOrEqual(event.vadSpeechStartedAt + TIMEOUT_MS);
    expect(event.createdAt).toBeLessThanOrEqual(Date.now());
  }, 30_000);
});
