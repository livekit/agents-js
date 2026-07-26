// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end (transport-mocked) test of the adaptive-interruption pipeline as it is wired by
// AudioRecognition: room audio -> interruption stream channel -> audio transformer -> WS transport.
//
// Regression coverage for "every overlap is classified as backchannel": the classifier can only
// return `isInterruption: true` from the inference-response path, which requires audio to actually
// reach the transport while the overlap is open.
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../../llm/chat_context.js';
import { initializeLogger } from '../../log.js';
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

/** 10ms of non-silent mono PCM, as a room track would deliver it. */
function makeFrame(sampleRate: number): AudioFrame {
  const samples = Math.floor(sampleRate / 100);
  const data = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  }
  return new AudioFrame(data, sampleRate, 1, samples);
}

/** Number of binary (audio) frames the transport pushed onto the socket. */
function audioSendCount(ws: MockWebSocket): number {
  return ws.sent.filter((s) => s instanceof Uint8Array).length;
}

/** `created_at` header the transport stamped on a binary frame. */
function createdAtOf(buf: Uint8Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getUint32(4, true) * 0x100000000 + view.getUint32(0, true);
}

interface Harness {
  recognition: AudioRecognition;
  detector: AdaptiveInterruptionDetector;
  hooks: RecognitionHooks;
  ws: MockWebSocket;
  events: OverlapEvent[];
  /** Requests the mock gateway has answered so far. */
  requestCount: () => number;
  /** Answer the next request with a bargein verdict instead of a plain inference_done. */
  bargeinOnNextRequest: () => void;
  close: () => Promise<void>;
}

/** Audio frames the transport pushed across every socket it has opened so far. */
function totalAudioSendCount(): number {
  return MockWebSocket.instances.reduce((total, ws) => total + audioSendCount(ws), 0);
}

interface OverlapEvent {
  isInterruption: boolean;
  numRequests: number;
  probability: number;
}

async function createHarness({
  sampleRate = 48000,
}: { sampleRate?: number } = {}): Promise<Harness> {
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

  const events: OverlapEvent[] = [];
  detector.on('overlapping_speech', (ev) => events.push(ev));
  // A simulated transport failure is emitted as a recoverable detector error; without a listener
  // the EventEmitter would rethrow it as an unhandled 'error'.
  detector.on('error', () => {});

  // Continuous room audio, pumped in the background for the whole test, exactly as a subscribed
  // track behaves — the interruption stream must pick it up on its own.
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

  // Stand-in for the gateway: answer every audio frame promptly, as the real service does. Without
  // this the transport's own 0.7s inference timeout tears the stream down. Sockets opened later
  // (an options reconnect, or the replacement stream built by a failover retry) are adopted too,
  // so the gateway keeps behaving normally across a reconnect.
  const answered = new Map<MockWebSocket, number>([[ws, 0]]);
  let bargeinPending = false;
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
          const createdAt = createdAtOf(binary[seen]!);
          seen++;
          if (bargeinPending) {
            bargeinPending = false;
            socket.simulateMessage({
              type: 'bargein_detected',
              created_at: createdAt,
              probabilities: [0.91, 0.93, 0.95],
              prediction_duration: 0.02,
            });
          } else {
            socket.simulateMessage({
              type: 'inference_done',
              created_at: createdAt,
              probabilities: [0.01, 0.02],
              prediction_duration: 0.02,
              is_bargein: false,
            });
          }
        }
        answered.set(socket, seen);
      }
      await sleep(5);
    }
  })();

  return {
    recognition,
    detector,
    hooks,
    ws,
    events,
    requestCount: () => [...answered.values()].reduce((a, b) => a + b, 0),
    bargeinOnNextRequest: () => {
      bargeinPending = true;
    },
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

describe('adaptive interruption pipeline', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends inference requests for user audio that overlaps agent speech', async () => {
    const h = await createHarness();

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(600);

    expect(audioSendCount(h.ws)).toBeGreaterThan(0);

    await h.close();
  });

  it('classifies a server bargein verdict as an interruption', async () => {
    const h = await createHarness();

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    h.bargeinOnNextRequest();
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(600);

    expect(audioSendCount(h.ws)).toBeGreaterThan(0);
    await waitFor(() => h.events.length > 0);

    expect(h.events[0]!.isInterruption).toBe(true);
    await waitFor(() => vi.mocked(h.hooks.onInterruption).mock.calls.length > 0);

    await h.close();
  });

  it('keeps making requests across repeated short overlaps in one agent turn', async () => {
    const h = await createHarness();

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(300);

    const perOverlapRequests: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = audioSendCount(h.ws);
      await h.recognition.onStartOfOverlapSpeech(200, Date.now());
      await sleep(1200); // the user's overlaps were 1-2s each
      await h.recognition.onEndOfOverlapSpeech(Date.now());
      await sleep(50);
      perOverlapRequests.push(audioSendCount(h.ws) - before);
    }

    expect(h.events).toHaveLength(3);
    expect(perOverlapRequests.every((n) => n > 0)).toBe(true);
    expect(h.events.map((e) => e.numRequests).every((n) => n > 0)).toBe(true);

    await h.close();
  });
});

// ---------------------------------------------------------------------------
// Overlap state must survive events that are not a new agent turn (regression)
// ---------------------------------------------------------------------------

/**
 * `overlapSpeechStarted` is the gate that lets user audio reach the gateway at all, and the only
 * thing that ever raises it is an `overlap-speech-started` sentinel, which in turn only comes from
 * a VAD start-of-speech. VAD does not re-announce speech that is already under way, so once the
 * flag is cleared mid-overlap nothing can re-arm it: every remaining frame of the interruption is
 * dropped, no inference request is made, and the agent talks straight through the user.
 *
 * Two things clear the flag without the user's turn having ended.
 */
describe('adaptive interruption overlap state retention', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
  });

  /**
   * A transient socket failure fails the stream over. JS rebuilds `InterruptionStreamBase` from
   * scratch on retry — all of its state lives in a `setupTransform()` closure — whereas Python
   * keeps `_agent_speech_started` / `_overlap_started` on `self` and only reconnects the socket.
   * Replaying `agent-speech-started` alone restores half the state: the agent is known to be
   * speaking again, but the in-flight overlap is gone.
   */
  it('keeps sending user audio after the transport fails over mid-overlap', async () => {
    const h = await createHarness();

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(400);

    expect(totalAudioSendCount()).toBeGreaterThan(0);
    const socketsBefore = MockWebSocket.instances.length;

    // Transient socket failure while the user is mid-interrupt.
    h.ws.emit('error', new Error('connection reset'));

    // The failover sleeps intervalForRetry(0) (2s + jitter) before rebuilding the stream.
    await waitFor(() => MockWebSocket.instances.length > socketsBefore, 8000);
    await sleep(200);

    // The user is still talking; from here on every frame must reach the new socket.
    const sendsAfterFailover = totalAudioSendCount();
    await sleep(800);

    expect(totalAudioSendCount() - sendsAfterFailover).toBeGreaterThan(0);

    await h.recognition.onEndOfOverlapSpeech(Date.now());
    await waitFor(() => h.events.length > 0);
    expect(h.events[h.events.length - 1]!.numRequests).toBeGreaterThan(0);

    await h.close();
  }, 30_000);

  /**
   * One user-perceived agent turn can contain several speech segments — a tool call sandwiched
   * between two replies, or a queued `say()`. `AgentActivity.onPipelineReplyDone` only reports
   * `onEndOfAgentSpeech` once the speech queue has drained, so the second segment raises
   * `agent-speech-started` again with no `agent-speech-ended` in between. Treating that as a new
   * turn resets the overlap the user is in the middle of.
   */
  it('keeps sending user audio when a second speech segment starts mid-overlap', async () => {
    const h = await createHarness();

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(400);

    const before = totalAudioSendCount();
    expect(before).toBeGreaterThan(0);

    // Second segment of the same turn: no `onEndOfAgentSpeech` precedes it.
    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(600);

    expect(totalAudioSendCount() - before).toBeGreaterThan(0);

    await h.recognition.onEndOfOverlapSpeech(Date.now());
    await waitFor(() => h.events.length > 0);
    expect(h.events[h.events.length - 1]!.numRequests).toBeGreaterThan(0);

    await h.close();
  }, 30_000);

  /**
   * The bargein verdict must still surface after a mid-overlap segment change — restoring the gate
   * is only useful if the recovered audio can still produce `isInterruption: true`.
   */
  it('still reports a bargein after a second speech segment starts mid-overlap', async () => {
    const h = await createHarness();

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(400);

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    h.bargeinOnNextRequest();
    await waitFor(() => h.events.length > 0, 5000);

    expect(h.events[0]!.isInterruption).toBe(true);
    expect(h.events[0]!.numRequests).toBeGreaterThan(0);
    await waitFor(() => vi.mocked(h.hooks.onInterruption).mock.calls.length > 0);

    await h.close();
  }, 30_000);

  /** A genuine new turn must still wipe the overlap, the cache and the counters. */
  it('resets overlap state on a new agent turn', async () => {
    const h = await createHarness();

    await h.recognition.onStartOfAgentSpeech(Date.now());
    await sleep(200);
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(400);
    expect(totalAudioSendCount()).toBeGreaterThan(0);

    // The agent turn ends, then a new one begins. The user is no longer overlapping anything,
    // so their audio must not be forwarded until a fresh overlap is announced.
    await h.recognition.onEndOfAgentSpeech(Date.now());
    await sleep(20);
    await h.recognition.onStartOfAgentSpeech(Date.now());

    const afterNewTurn = totalAudioSendCount();
    await sleep(600);
    expect(totalAudioSendCount()).toBe(afterNewTurn);

    // ...and the new turn's first overlap starts from a clean counter.
    await h.recognition.onStartOfOverlapSpeech(200, Date.now());
    await sleep(400);
    await h.recognition.onEndOfOverlapSpeech(Date.now());
    await waitFor(() => h.events.length > 0);

    const last = h.events[h.events.length - 1]!;
    expect(last.numRequests).toBeGreaterThan(0);
    expect(totalAudioSendCount()).toBeGreaterThan(afterNewTurn);

    await h.close();
  }, 30_000);
});
