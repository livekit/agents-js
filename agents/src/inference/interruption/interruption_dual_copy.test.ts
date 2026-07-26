// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for "every overlap is a backchannel" caused by two copies of
// `@livekit/rtc-node` in one process.
//
// When the application and `@livekit/agents` resolve different installs of the module, room audio
// is built by one `AudioFrame` constructor and type-checked against the other. Every
// `frame instanceof AudioFrame` goes false, so audio was written through `pushFrame` as if it were
// a control sentinel, then matched none of the sentinel branches in the transform and disappeared:
// no accept, no drop, no counter, no log. Adaptive interruption then had nothing to classify and
// fell back to a backchannel verdict on every overlap, forever, without an error.
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../../llm/chat_context.js';
import { initializeLogger, log } from '../../log.js';
import { AudioRecognition, type RecognitionHooks } from '../../voice/audio_recognition.js';
import { createEndpointing } from '../../voice/turn_config/endpointing.js';
import { MockWebSocket } from './_mock_ws.js';
import { AdaptiveInterruptionDetector } from './interruption_detector.js';

vi.mock('ws', async () => {
  const { MockWebSocket } = await import('./_mock_ws.js');
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

initializeLogger({ pretty: false, level: 'silent' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('condition not met within timeout');
    }
    await sleep(5);
  }
}

/**
 * An audio frame from a *different* copy of `@livekit/rtc-node`.
 *
 * The dual-copy hazard in miniature: identical field names, identical values, identical payload —
 * only the constructor differs, which is enough to make `instanceof AudioFrame` false while every
 * consumer that just reads the fields keeps working.
 */
class ForeignAudioFrame {
  constructor(
    readonly data: Int16Array,
    readonly sampleRate: number,
    readonly channels: number,
    readonly samplesPerChannel: number,
  ) {}

  get userdata(): Record<string, unknown> {
    return {};
  }
}

/** 10ms of non-silent mono PCM, as a room track would deliver it. */
function samplesFor(sampleRate: number): Int16Array {
  const samples = Math.floor(sampleRate / 100);
  const data = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  }
  return data;
}

function makeForeignFrame(sampleRate: number): AudioFrame {
  const data = samplesFor(sampleRate);
  // The cast is the point of the test: at the type level this is an AudioFrame, at runtime it was
  // built somewhere else — exactly what a duplicated dependency produces.
  return new ForeignAudioFrame(data, sampleRate, 1, data.length) as unknown as AudioFrame;
}

function createHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => true),
  } as unknown as RecognitionHooks;
}

/** Number of binary (audio) frames the transport pushed onto a socket. */
function audioSendCount(ws: MockWebSocket): number {
  return ws.sent.filter((s) => s instanceof Uint8Array).length;
}

/** Audio frames the transport pushed across every socket it has opened so far. */
function totalAudioSendCount(): number {
  return MockWebSocket.instances.reduce((total, ws) => total + audioSendCount(ws), 0);
}

/** `created_at` header the transport stamped on a binary frame. */
function createdAtOf(buf: Uint8Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getUint32(4, true) * 0x100000000 + view.getUint32(0, true);
}

interface Harness {
  recognition: AudioRecognition;
  detector: AdaptiveInterruptionDetector;
  events: { isInterruption: boolean; numRequests: number }[];
  close: () => Promise<void>;
}

/**
 * The pipeline as AudioRecognition wires it: room audio into the interruption stream channel, on
 * through the audio transformer and out to the WS transport. Frames come from `makeFrame`, so a
 * caller can supply them from a second copy of the module.
 */
async function createHarness(makeFrame: (sampleRate: number) => AudioFrame): Promise<Harness> {
  const sampleRate = 48000;
  const detector = new AdaptiveInterruptionDetector({
    baseUrl: 'http://localhost:9999',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
  });
  const hooks = createHooks();
  const recognition = new AudioRecognition({
    recognitionHooks: hooks,
    interruptionDetection: detector,
    endpointing: createEndpointing({ mode: 'dynamic', minDelay: 500, maxDelay: 3000, alpha: 0.9 }),
  });
  // The pipeline wiring keys off `interruptionDetection`; the enabled flag additionally requires a
  // VAD, which this test substitutes for by driving the overlap callbacks directly.
  (recognition as unknown as { isInterruptionEnabled: boolean }).isInterruptionEnabled = true;

  const events: { isInterruption: boolean; numRequests: number }[] = [];
  detector.on('overlapping_speech', (ev) => events.push(ev));
  detector.on('error', () => {});

  let pumping = true;
  let pushFrame!: (frame: AudioFrame) => void;
  const audioStream = new ReadableStream<AudioFrame>({
    start(controller) {
      pushFrame = (frame) => controller.enqueue(frame);
    },
  });
  recognition.setInputAudioStream(audioStream);
  const pump = (async () => {
    while (pumping) {
      pushFrame(makeFrame(sampleRate));
      await sleep(10);
    }
  })();

  const ac = new AbortController();
  const task = (
    recognition as unknown as {
      createInterruptionTask: (
        d: AdaptiveInterruptionDetector,
        signal: AbortSignal,
      ) => Promise<void>;
    }
  ).createInterruptionTask(detector, ac.signal);

  await waitFor(() => MockWebSocket.instances.length > 0);
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  ws.simulateOpen();
  await waitFor(() => ws.sent.length > 0); // session.create
  ws.simulateMessage({ type: 'session.created', default_threshold: 0.5 });
  await sleep(20);

  // Stand-in for the gateway: answer every audio frame promptly, as the real service does.
  // Without this the transport's own inference timeout tears the stream down.
  const answered = new Map<MockWebSocket, number>([[ws, 0]]);
  const responder = (async () => {
    while (pumping) {
      for (const socket of MockWebSocket.instances) {
        if (!answered.has(socket)) {
          answered.set(socket, 0);
          socket.simulateOpen();
          await sleep(1);
          socket.simulateMessage({ type: 'session.created', default_threshold: 0.5 });
        }
        const binary = socket.sent.filter((s): s is Uint8Array => s instanceof Uint8Array);
        let seen = answered.get(socket)!;
        while (seen < binary.length) {
          socket.simulateMessage({
            type: 'inference_done',
            created_at: createdAtOf(binary[seen]!),
            probabilities: [0.01, 0.02],
            prediction_duration: 0.02,
            is_bargein: false,
          });
          seen++;
        }
        answered.set(socket, seen);
      }
      await sleep(5);
    }
  })();

  return {
    recognition,
    detector,
    events,
    close: async () => {
      pumping = false;
      await pump;
      await responder;
      ac.abort();
      await task.catch(() => {});
      await recognition.close().catch(() => {});
    },
  };
}

/** Every message the logger was asked to emit at `error`, flattened to searchable text. */
function errorMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => call.map((arg) => JSON.stringify(arg) ?? '').join(' '));
}

describe('adaptive interruption with two copies of @livekit/rtc-node', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    vi.restoreAllMocks();
  });

  it('builds a frame that is shaped like an AudioFrame but fails instanceof', () => {
    const frame = makeForeignFrame(48000);
    expect(frame instanceof AudioFrame).toBe(false);
    expect(frame.sampleRate).toBe(48000);
    expect(frame.samplesPerChannel).toBe(480);
  });

  it('keeps user audio flowing and says why, instead of discarding every frame', async () => {
    const errorSpy = vi.spyOn(log(), 'error').mockImplementation(() => undefined as never);
    const h = await createHarness(makeForeignFrame);

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(600);

    // The bug: not one frame ever reached the gateway, so the overlap could only ever be
    // answered with the default backchannel verdict.
    expect(totalAudioSendCount()).toBeGreaterThan(0);

    await h.recognition.onEndOfOverlapSpeech(Date.now());
    await waitFor(() => h.events.length > 0);
    expect(h.events[h.events.length - 1]!.numRequests).toBeGreaterThan(0);

    // And the operator is told exactly what is wrong rather than left to infer it from a
    // classifier that only ever says "backchannel".
    const messages = errorMessages(errorSpy);
    expect(messages.some((m) => m.includes('@livekit/rtc-node is loaded twice'))).toBe(true);

    await h.close();
  }, 30_000);

  it('reports a chunk it cannot classify instead of dropping it in silence', async () => {
    const detector = new AdaptiveInterruptionDetector({
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
    });
    detector.on('error', () => {});
    const stream = detector.createStream();
    const errorSpy = vi.spyOn(log(), 'error').mockImplementation(() => undefined as never);

    // Neither audio nor any sentinel the transform knows. Before, this fell off the end of the
    // dispatch chain and vanished.
    await stream.pushFrame({ type: 'not-a-real-sentinel' } as never);
    await stream.pushFrame({ nothing: 'like a chunk' } as never);
    await sleep(50);

    const messages = errorMessages(errorSpy);
    expect(messages.some((m) => m.includes('neither an audio frame nor a known'))).toBe(true);

    // Rate limited: the first is reported at once, the rest only fold into the running count.
    const reports = messages.filter((m) => m.includes('neither an audio frame nor a known'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('discardedChunks');

    await stream.close();
  }, 30_000);
});
