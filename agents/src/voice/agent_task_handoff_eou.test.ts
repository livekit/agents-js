// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for the end-of-turn stall after AgentTask handoffs
// (1.4.4 -> 1.4.5 regression; reported in production as multi-minute agent
// silences, minimal repro contributed by the affected customer).
//
// Mechanism: across a task handoff the STT pipeline is reused, so provider
// transcript timestamps (`SpeechData.endTime`) stay cumulative from the stream
// start. If the input anchor is re-stamped at handoff time and VAD misses the
// user's speech, `lastSpeakingTime` falls into the future by the stream's age at
// handoff, and the end-of-turn timer waits out the difference.
//
// Guarded fixes: `inputStartedAt` lives on the reused STT pipeline and
// `lastSpeakingTime` is clamped to wall clock. Without both,
// the three steps below stall by ~2s/~3s/~8s instead of committing within the
// endpointing window.
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { asLanguageCode } from '../language.js';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import type { FakeRecognizeStream } from '../stt/testing/fake_stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { VAD, VADStream } from '../vad.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioInput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

// Mock `ws` so adaptive interruption connects to an in-memory socket instead of
// the real LiveKit inference gateway. It opens cleanly and never returns any
// inference events (so no interruption is ever detected), but the audio
// forwarding loop still runs. This keeps the test hermetic and avoids the noisy
// unhandled rejections a dead network address would produce.
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class AutoOpenWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = AutoOpenWebSocket.CONNECTING;
    constructor(_url: string, _opts?: unknown) {
      super();
      // Open on the next tick, after connectWebSocket has attached its listeners.
      setTimeout(() => {
        this.readyState = AutoOpenWebSocket.OPEN;
        this.emit('open');
      }, 0);
    }
    send(_data: unknown, cb?: (err?: Error) => void) {
      cb?.();
    }
    ping() {}
    close() {
      this.readyState = AutoOpenWebSocket.CLOSED;
      this.emit('close', 1000, Buffer.alloc(0));
    }
    terminate() {
      this.readyState = AutoOpenWebSocket.CLOSED;
      this.emit('close', 1006, Buffer.alloc(0));
    }
  }
  return { default: AutoOpenWebSocket, WebSocket: AutoOpenWebSocket };
});

const STEP_GAP_MS = 2_000; // silence between turns; grows the stream-age offset
const ENDPOINTING_MS = 500; // expected healthy commit delay
const STEP_INPUTS = ['step one done', 'step two done', 'step three done'] as const;

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

/**
 * A VAD that consumes audio but never detects speech (a missed quiet
 * utterance), forcing `lastSpeakingTime` to fall back to STT timestamps.
 * Subclasses the real VAD/VADStream so `instanceof` checks in AgentActivity hold
 * and the audio tee stays drained (otherwise backpressure would stall the
 * pipeline). It never writes to the output, so `lastSpeakingTime` is never set
 * from VAD — which is exactly the precondition for the buggy STT fallback.
 */
class DeafVADStream extends VADStream {
  constructor(vad: VAD) {
    super(vad);
    void this.#drain();
  }

  // Drain the (tee'd) input so the shared audio pipeline doesn't block, but
  // never emit a VAD event.
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
}

class DeafVAD extends VAD {
  label = 'deaf-vad';

  constructor() {
    super({ updateInterval: 1 });
  }

  stream(): VADStream {
    return new DeafVADStream(this);
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

/** `SpeechStream.queue` is protected; we inject scripted FINAL_TRANSCRIPTs with a
 * provider-cumulative `endTime` (which `sendFakeTranscript` hard-codes to 0). */
type QueueAccess = { queue: { put(ev: SpeechEvent): void } };

describe('AgentTask handoff end-of-turn timing', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('commits end-of-turn promptly after each task handoff when VAD misses the user speech', async () => {
    // Adaptive interruption needs LiveKit credentials to construct (else the
    // detector is silently disabled and the regression path is not exercised).
    // The `ws` mock above means the URL is never actually dialed.
    const savedEnv = {
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
      LIVEKIT_INFERENCE_URL: process.env.LIVEKIT_INFERENCE_URL,
    };
    process.env.LIVEKIT_API_KEY = 'test-api-key';
    process.env.LIVEKIT_API_SECRET = 'test-api-secret';
    process.env.LIVEKIT_INFERENCE_URL = 'ws://127.0.0.1:1';

    // Streaming STT with aligned transcripts. We inject transcript events with
    // provider-cumulative timestamps directly.
    const stt = new FakeSTT({
      label: 'scripted-stt',
      capabilities: { streaming: true, interimResults: true, alignedTranscript: 'word' },
    });

    const sttStreams: Array<{ stream: FakeRecognizeStream; openedAt: number }> = [];
    void (async () => {
      for await (const stream of stt.streamCh) {
        sttStreams.push({ stream, openedAt: Date.now() });
      }
    })();

    const injectFinalTranscript = (text: string) => {
      const opened = sttStreams[0]!;
      const endS = (Date.now() - opened.openedAt) / 1000; // cumulative provider timestamp
      (opened.stream as unknown as QueueAccess).queue.put({
        type: SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text,
            language: asLanguageCode('en'),
            startTime: Math.max(0, endS - 0.8),
            endTime: endS,
            confidence: 0.95,
          },
        ],
      });
    };

    // Each user input maps to the current task's completion tool call.
    const fakeLlm = new FakeLLM(
      STEP_INPUTS.map((input) => ({ input, toolCalls: [{ name: 'completeStep', args: {} }] })),
    );

    // ---- Parent agent chaining three AgentTasks (mirrors the production shape) ----
    const toolExecutedAt: Record<number, number> = {};

    const makeStepTask = (step: number): AgentTask<{ step: number }> => {
      const task: AgentTask<{ step: number }> = new AgentTask<{ step: number }>({
        instructions: `You are handling step ${step}. Wait for the caller to finish it.`,
        tools: [
          tool({
            name: 'completeStep',
            description: `Record that step ${step} is complete.`,
            execute: async () => {
              toolExecutedAt[step] = Date.now();
              task.complete({ step });
            },
          }),
        ],
      });
      return task;
    };

    let allTasksDone = false;
    const parent = new (class extends Agent {
      async onEnter(): Promise<void> {
        for (const step of [1, 2, 3]) {
          await makeStepTask(step).run(); // task handoff: STT pipeline is reused
        }
        allTasksDone = true;
      }
    })({ instructions: 'Supervisor: delegate the caller through three steps.' });

    const session = new AgentSession({
      stt,
      vad: new DeafVAD(),
      llm: fakeLlm,
      turnHandling: {
        interruption: { mode: 'adaptive' },
        endpointing: { minDelay: ENDPOINTING_MS, maxDelay: 3_000 },
      },
    });

    const audioInput = new ScriptedAudioInput();
    session.input.audio = audioInput;

    await session.start({ agent: parent });

    // Continuous caller audio, like an open SIP line.
    const pump = setInterval(() => audioInput.push(silenceFrame(50)), 50);

    const delays: number[] = [];
    try {
      await waitFor(() => sttStreams.length >= 1, 5_000, 'STT stream to open');

      for (const [i, input] of STEP_INPUTS.entries()) {
        const step = i + 1;
        await sleep(STEP_GAP_MS);
        const injectedAt = Date.now();
        injectFinalTranscript(input);
        await waitFor(() => toolExecutedAt[step] !== undefined, 30_000, `step ${step} tool call`);
        delays.push(toolExecutedAt[step]! - injectedAt);
      }

      await waitFor(() => allTasksDone, 5_000, 'parent onEnter to finish');
    } finally {
      clearInterval(pump);
      await session.close().catch(() => {});
      for (const key of Object.keys(savedEnv) as Array<keyof typeof savedEnv>) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }

    // The STT pipeline should be reused (a single stream) across all handoffs;
    // that reuse is what makes `endTime` cumulative across activities.
    expect(sttStreams.length).toBe(1);

    // every step must commit within the endpointing window — no step may
    // stall by the stream age at its handoff
    const [step1, step2, step3] = delays;
    expect(step1!).toBeLessThan(STEP_GAP_MS / 2);
    expect(step2!).toBeLessThan(STEP_GAP_MS / 2);
    expect(step3!).toBeLessThan(STEP_GAP_MS / 2);
  }, 60_000);
});
