// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The `eou_wait` span: one per user turn, from the last speech anchor to the turn decision.
 *
 * `eou_detection` (the turn-detector inference) nests under it; the wait itself was previously
 * invisible, so a 2.5 s endpointing delay showed up as an empty gap between `eou_detection` and
 * `agent_turn`. Also covers the `on_user_turn_completed` span and the queue-wait attribute on
 * `agent_turn` through a full fake session.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext, type ChatMessage } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import { REDACTED_EXCEPTION_MESSAGE } from '../telemetry/redaction.js';
import { Future, delay } from '../utils.js';
import { VAD, type VADEvent, VADEventType, VADStream } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import {
  AudioRecognition,
  type RecognitionHooks,
  type _TurnDetector,
} from './audio_recognition.js';
import { AudioInput, AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

const startMs = (span: ReadableSpan) => hrTimeToMilliseconds(span.startTime);
const endMs = (span: ReadableSpan) => hrTimeToMilliseconds(span.endTime);

function spansNamed(exporter: InMemorySpanExporter, name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

function only(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const found = spansNamed(exporter, name);
  expect(found, `expected exactly one ${name} span, got ${found.length}`).toHaveLength(1);
  return found[0]!;
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

/** A VAD whose events the test emits by hand; the real base classes keep `instanceof` intact. */
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

  /** Report that the user started speaking `speechDuration` ms ago. */
  startOfSpeech(speechDuration: number): void {
    this.streams.at(-1)!.emitEvent(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration }));
  }

  endOfSpeech(): void {
    this.streams.at(-1)!.emitEvent(vadEvent(VADEventType.END_OF_SPEECH));
  }
}

describe.sequential('eou_wait span', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    // register() installs the async context manager the activity relies on to find the
    // agent_turn span from a speech handle's captured context
    provider.register();
    setTracerProvider(provider);
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
  });

  describe('audio recognition', () => {
    /** A text turn detector whose verdict the test controls. */
    function detector(prediction: Promise<number>): _TurnDetector {
      return {
        model: 'test-turn-detector',
        provider: 'test-provider',
        supportsLanguage: async () => true,
        unlikelyThreshold: async () => 0.5,
        predictEndOfTurn: () => prediction,
      };
    }

    /**
     * Enough of `AudioRecognition` to drive the bounce task with real spans: VAD-only turn
     * detection, a committing end-of-turn hook by default, and a transcript already in hand.
     */
    async function makeRecognition(opts: {
      minDelay: number;
      commit?: boolean;
      turnDetector?: _TurnDetector;
    }) {
      const vad = new ScriptedVAD();
      const hooks: RecognitionHooks = {
        onInterruption: vi.fn(),
        onBackchannelConfirmed: vi.fn(),
        onStartOfSpeech: vi.fn(),
        onVADInferenceDone: vi.fn(),
        onEndOfSpeech: vi.fn(),
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onTranscriptionTimeout: vi.fn(),
        onPreemptiveGeneration: vi.fn(),
        onEotPrediction: vi.fn(),
        onAgentBackchannelOpportunity: vi.fn(),
        onUserTurnExceeded: vi.fn(),
        retrieveChatCtx: () => ChatContext.empty(),
        onEndOfTurn: vi.fn(async () => opts.commit ?? true),
      };
      const ar = new AudioRecognition({
        recognitionHooks: hooks,
        vad,
        turnDetector: opts.turnDetector,
        turnDetectionMode: 'vad',
        minEndpointingDelay: opts.minDelay,
        maxEndpointingDelay: Math.max(opts.minDelay, 1000),
      });
      ar['audioTranscript'] = 'hello there';
      await ar.start();
      await delay(5); // let the VAD task attach to the scripted stream
      return { ar, vad, hooks };
    }

    function runEou(ar: AudioRecognition, trigger: 'vad' | 'stt') {
      ar['runEOUDetection'](ChatContext.empty(), trigger);
    }

    async function awaitBounce(ar: AudioRecognition) {
      await ar.endOfTurnTask?.result.catch(() => undefined);
    }

    async function cancelBounce(ar: AudioRecognition) {
      ar.endOfTurnTask?.cancel();
      await awaitBounce(ar);
    }

    it('covers the last speech to the commit, back-dated and under user_turn', async () => {
      const { ar } = await makeRecognition({ minDelay: 50 });
      try {
        // the user stopped talking 0.3 s ago: the wait is back-dated there and commits at once
        const lastSpeaking = Date.now() - 300;
        ar['lastSpeakingTime'] = lastSpeaking;
        runEou(ar, 'vad');
        await awaitBounce(ar);

        const wait = only(exporter, 'eou_wait');
        const userTurn = only(exporter, 'user_turn');
        expect(wait.parentSpanContext?.spanId).toBe(userTurn.spanContext().spanId);
        expect(startMs(wait)).toBe(lastSpeaking);
        // no VAD opened this turn: created here, it starts at the last speaking time too, so
        // the back-dated wait never starts before its parent
        expect(startMs(userTurn)).toBeLessThanOrEqual(startMs(wait));
        expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('committed');
        expect(wait.attributes[traceTypes.ATTR_EOU_SOURCE]).toBe('vad');
        expect(wait.attributes[traceTypes.ATTR_EOU_DELAY]).toBe(0.05);
        expect(wait.attributes[traceTypes.ATTR_EOU_REARM_COUNT]).toBe(0);
        const waitDuration = wait.attributes[traceTypes.ATTR_EOU_WAIT_DURATION] as number;
        expect(waitDuration).toBeGreaterThanOrEqual(0.3);
        expect(waitDuration).toBeLessThan(0.6);
        // the attribute is derived from the span's own bounds: identical, not close
        expect((endMs(wait) - startMs(wait)) / 1000).toBe(waitDuration);
        // the wait closes before the turn does
        expect(endMs(wait)).toBeLessThanOrEqual(endMs(userTurn));
        expect(ar['eouWaitSpan']).toBeUndefined();
      } finally {
        await ar.close();
      }
    });

    it('re-arms the same span on a later trigger', async () => {
      // the wait is long relative to the re-trigger so a slow CI runner cannot let it commit first
      const { ar } = await makeRecognition({ minDelay: 1000 });
      try {
        ar['lastSpeakingTime'] = Date.now();
        runEou(ar, 'vad');
        await delay(50);
        // a late STT final re-triggers end of turn; the bounce task restarts, the span must not
        runEou(ar, 'stt');
        await awaitBounce(ar);

        const wait = only(exporter, 'eou_wait');
        expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('committed');
        expect(wait.attributes[traceTypes.ATTR_EOU_REARM_COUNT]).toBe(1);
        expect(wait.attributes[traceTypes.ATTR_EOU_SOURCE]).toBe('stt');
        const rearmed = wait.events.filter((e) => e.name === 'rearmed');
        expect(rearmed).toHaveLength(1);
        expect(rearmed[0]!.attributes?.[traceTypes.ATTR_EOU_SOURCE]).toBe('stt');
      } finally {
        await ar.close();
      }
    });

    it('ends at the resumed speech start and leaves user_turn open', async () => {
      const { ar, vad } = await makeRecognition({ minDelay: 1000 });
      try {
        ar['lastSpeakingTime'] = Date.now();
        runEou(ar, 'vad');
        await delay(50);

        const before = Date.now();
        vad.startOfSpeech(500); // started 0.5 s ago, before the wait opened
        await delay(20);
        const after = Date.now();
        await cancelBounce(ar);

        const wait = only(exporter, 'eou_wait');
        expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('user_resumed');
        // ended where the resumed speech started, per VAD, clamped to the wait's own start
        expect(startMs(wait)).toBeLessThanOrEqual(endMs(wait));
        expect(endMs(wait)).toBeLessThanOrEqual(Math.max(after - 500, startMs(wait)));
        expect(before).toBeGreaterThan(0);
        // the user turn itself stays open: they are still talking
        expect(spansNamed(exporter, 'user_turn')).toEqual([]);
        expect(ar['userTurnSpan']?.isRecording()).toBe(true);
        ar['_endUserTurnSpan']();
        // the turn counts the waits the user cut short
        const userTurn = only(exporter, 'user_turn');
        expect(userTurn.attributes[traceTypes.ATTR_EOU_RESUME_COUNT]).toBe(1);
      } finally {
        await ar.close();
      }
    });

    it('drops an open wait on teardown', async () => {
      const { ar } = await makeRecognition({ minDelay: 1000 });
      try {
        ar['lastSpeakingTime'] = Date.now();
        runEou(ar, 'vad');
        await delay(20);

        ar['_endUserTurnSpan']();
        await cancelBounce(ar);

        const wait = only(exporter, 'eou_wait');
        expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('dropped');
        const userTurn = only(exporter, 'user_turn');
        expect(endMs(wait)).toBeLessThanOrEqual(endMs(userTurn));
      } finally {
        await ar.close();
      }
    });

    it('keeps waiting when the turn is not committed', async () => {
      // e.g. below the interruption min words
      const { ar } = await makeRecognition({ minDelay: 10, commit: false });
      try {
        ar['lastSpeakingTime'] = Date.now();
        runEou(ar, 'vad');
        await awaitBounce(ar);

        // the decision is deferred: the span records the rejection and stays open
        expect(spansNamed(exporter, 'eou_wait')).toEqual([]);
        expect(ar['eouWaitSpan']?.isRecording()).toBe(true);
        ar['_endUserTurnSpan']();
        const wait = only(exporter, 'eou_wait');
        expect(wait.attributes[traceTypes.ATTR_EOU_NOT_COMMITTED_COUNT]).toBe(1);
        expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('dropped');
        expect(wait.events).toEqual([]);
      } finally {
        await ar.close();
      }
    });

    it('nests eou_detection under the wait', async () => {
      const { ar } = await makeRecognition({
        minDelay: 10,
        turnDetector: detector(Promise.resolve(0.9)),
      });
      try {
        ar['lastSpeakingTime'] = Date.now();
        runEou(ar, 'vad');
        await awaitBounce(ar);

        const detection = only(exporter, 'eou_detection');
        const wait = only(exporter, 'eou_wait');
        expect(detection.parentSpanContext?.spanId).toBe(wait.spanContext().spanId);
        expect(detection.attributes[traceTypes.ATTR_EOU_PROBABILITY]).toBe(0.9);
        // the delay decided by the prediction is stamped on the wait too
        expect(wait.attributes[traceTypes.ATTR_EOU_DELAY]).toBe(0.01);
      } finally {
        await ar.close();
      }
    });

    it('keeps a running eou_detection inside the wait when the user resumes', async () => {
      // VAD reports a resumed speech start after the fact; if the detector was still running
      // the wait cannot end back there, or eou_detection would outlive its parent
      const pending = new Future<number>();
      const { ar, vad } = await makeRecognition({
        minDelay: 1000,
        turnDetector: detector(pending.await),
      });
      try {
        ar['lastSpeakingTime'] = Date.now();
        runEou(ar, 'vad');
        await delay(50);
        expect(ar['eouDetectionSpan']?.isRecording()).toBe(true);

        vad.startOfSpeech(500); // started 0.5 s ago, before the detection began
        await delay(20);
        pending.resolve(0.9); // the inference answers after it was superseded
        await awaitBounce(ar);

        const wait = only(exporter, 'eou_wait');
        const detection = only(exporter, 'eou_detection');
        expect(detection.parentSpanContext?.spanId).toBe(wait.spanContext().spanId);
        expect(startMs(wait)).toBeLessThanOrEqual(startMs(detection));
        expect(endMs(detection)).toBeLessThanOrEqual(endMs(wait));
        expect(detection.events.map((e) => e.name)).toEqual(['superseded']);
        expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('user_resumed');
        // the delay in force is stamped when the wait opens, so a wait ended by resumed speech
        // before the detector answered still carries it
        expect(wait.attributes[traceTypes.ATTR_EOU_DELAY]).toBe(1);
        expect(wait.attributes[traceTypes.ATTR_EOU_WAIT_DURATION]).toBeCloseTo(
          (endMs(wait) - startMs(wait)) / 1000,
          6,
        );
        // the real resume time survives as an event inside the bar
        const resumed = wait.events.filter((e) => e.name === 'user_resumed');
        expect(resumed).toHaveLength(1);
        const resumedAt = hrTimeToMilliseconds(resumed[0]!.time);
        expect(resumedAt).toBeGreaterThanOrEqual(startMs(wait));
        expect(resumedAt).toBeLessThanOrEqual(endMs(wait));
        ar['_endUserTurnSpan']();
      } finally {
        await ar.close();
      }
    });

    it('drops an open wait when turn detection switches to manual', async () => {
      const { ar } = await makeRecognition({ minDelay: 1000 });
      try {
        ar['lastSpeakingTime'] = Date.now();
        runEou(ar, 'vad');
        await delay(20);
        expect(ar['eouWaitSpan']).toBeDefined();

        ar.updateOptions({ turnDetection: 'manual' });
        await delay(0); // let the cancelled bounce task unwind

        const wait = only(exporter, 'eou_wait');
        expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('dropped');
        expect(ar['eouWaitSpan']).toBeUndefined();
        expect(ar.endOfTurnTask).toBeUndefined();
        // the user turn is still open for whatever the manual mode does with the next speech
        expect(ar['userTurnSpan']?.isRecording()).toBe(true);
        ar['_endUserTurnSpan']();
      } finally {
        await ar.close();
      }
    });
  });

  describe('full session', () => {
    const TRANSCRIPT = 'Hello, how are you?';

    class ScriptedAudioInput extends AudioInput {
      #controller!: ReadableStreamDefaultController<AudioFrame>;

      constructor() {
        super();
        this.multiStream.addInputStream(
          new ReadableStream<AudioFrame>({
            start: (controller) => {
              this.#controller = controller;
            },
          }),
        );
      }

      push(durationMs: number, sampleRate = 16_000): void {
        const samples = Math.floor((sampleRate * durationMs) / 1000);
        this.#controller.enqueue(new AudioFrame(new Int16Array(samples), sampleRate, 1, samples));
      }
    }

    /** Plays every frame instantly, so the reply's e2e latency and playout complete. */
    class ImmediateOutput extends AudioOutput {
      constructor() {
        super(24_000);
      }

      override async captureFrame(frame: AudioFrame): Promise<void> {
        const segmentCount = this.capturedPlayoutSegments;
        await super.captureFrame(frame);
        if (this.capturedPlayoutSegments > segmentCount) {
          this.onPlaybackStarted(Date.now());
        }
      }

      override flush(): void {
        super.flush();
        if (this.pendingPlayoutSegments > 0) {
          this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
        }
      }

      override clearBuffer(): void {
        if (this.pendingPlayoutSegments > 0) {
          this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
        }
      }
    }

    class HookAgent extends Agent {
      constructor(private readonly hook: (message: ChatMessage) => Promise<void>) {
        super({ instructions: 'test' });
      }

      override async onUserTurnCompleted(_: ChatContext, message: ChatMessage): Promise<void> {
        await this.hook(message);
      }

      override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
        return new ReadableStream<AudioFrame>({
          start(controller) {
            controller.enqueue(new AudioFrame(new Int16Array(480), 24_000, 1, 480));
            controller.close();
          },
        });
      }
    }

    async function waitFor(predicate: () => boolean, timeoutMs: number, what: string) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await delay(10);
      }
    }

    /**
     * One user turn end to end: VAD brackets the speech, the fake STT delivers the final a bit
     * later, the hook runs, and the fake LLM's reply plays out. Returns once the reply's turn
     * carries its end-to-end latency, then closes the session.
     */
    async function runOneTurn(agent: HookAgent, configure?: (session: AgentSession) => void) {
      const vad = new ScriptedVAD();
      const stt = new FakeSTT({
        capabilities: { streaming: true, interimResults: true },
        fakeUserSpeeches: [{ startTime: 0, endTime: 200, transcript: TRANSCRIPT, sttDelay: 100 }],
      });
      const llm = new FakeLLM([{ input: TRANSCRIPT, content: "I'm doing well, thank you!" }]);
      const session = new AgentSession({
        vad,
        stt,
        llm,
        turnHandling: {
          turnDetection: 'vad',
          endpointing: { minDelay: 100, maxDelay: 100 },
        },
      });
      const audioInput = new ScriptedAudioInput();
      session.input.audio = audioInput;
      session.output.audio = new ImmediateOutput();
      configure?.(session);
      await session.start({ agent });
      try {
        audioInput.push(20); // anchors the fake STT clock and feeds the VAD stream
        await delay(20);
        vad.startOfSpeech(0);
        await delay(200);
        vad.endOfSpeech();
        await waitFor(
          () =>
            spansNamed(exporter, 'agent_turn').some(
              (span) => traceTypes.ATTR_E2E_LATENCY in span.attributes,
            ),
          10_000,
          'the reply to play',
        );
      } finally {
        await session.close();
      }
      return session;
    }

    it('traces the wait, the hook, the queue wait and the per-turn stages', async () => {
      const agent = new HookAgent(async () => {
        await delay(50);
      });
      await runOneTurn(agent);

      const wait = only(exporter, 'eou_wait');
      const userTurn = only(exporter, 'user_turn');
      expect(wait.parentSpanContext?.spanId).toBe(userTurn.spanContext().spanId);
      expect(wait.attributes[traceTypes.ATTR_EOU_OUTCOME]).toBe('committed');

      const hook = only(exporter, 'on_user_turn_completed');
      expect(endMs(hook) - startMs(hook)).toBeGreaterThanOrEqual(45);
      expect(hook.attributes[traceTypes.ATTR_AGENT_LABEL]).toBe(agent.id);
      // the hook is part of the turn: it nests under user_turn, which ends after it (a
      // preemptive generation may already have started its agent_turn by then; that is fine)
      expect(hook.parentSpanContext?.spanId).toBe(userTurn.spanContext().spanId);
      expect(endMs(userTurn)).toBeGreaterThanOrEqual(endMs(hook));

      // the reply's agent_turn records how long it sat in the speech queue
      const queued = spansNamed(exporter, 'agent_turn').filter(
        (span) => traceTypes.ATTR_SPEECH_QUEUE_WAIT in span.attributes,
      );
      expect(queued.length, 'no agent_turn carries the queue wait').toBeGreaterThan(0);
      for (const turn of queued) {
        const queueWait = turn.attributes[traceTypes.ATTR_SPEECH_QUEUE_WAIT] as number;
        expect(queueWait).toBeGreaterThanOrEqual(0);
        expect(queueWait).toBeLessThan(5);
      }

      // the reply that answered the turn carries the user-side stages next to lk.e2e_latency,
      // so the per-turn breakdown reads off one span
      const replies = spansNamed(exporter, 'agent_turn').filter(
        (span) => traceTypes.ATTR_E2E_LATENCY in span.attributes,
      );
      expect(replies).toHaveLength(1);
      const attrs = replies[0]!.attributes;
      for (const key of [
        traceTypes.ATTR_END_OF_TURN_DELAY,
        traceTypes.ATTR_TRANSCRIPTION_DELAY,
        traceTypes.ATTR_ON_USER_TURN_COMPLETED_DELAY,
      ]) {
        expect(attrs[key], key).toBeTypeOf('number');
      }
      expect(attrs[traceTypes.ATTR_ON_USER_TURN_COMPLETED_DELAY]).toBeGreaterThanOrEqual(0.045);
    });

    it('honours session-only redaction for a hook exception', async () => {
      // redaction on the session alone (no job flag) must still keep the hook's exception
      // message, which can quote the transcript, out of the trace
      const agent = new HookAgent(async (message) => {
        throw new Error(`lookup failed for ${message.textContent}`);
      });
      const session = await runOneTurn(agent, (session) => {
        session.sessionOptions.recordingOptions = {
          audio: false,
          traces: false,
          logs: false,
          transcript: false,
          redaction: true,
        };
      });
      expect(session._redactionEnabled).toBe(true);

      const hook = only(exporter, 'on_user_turn_completed');
      expect(hook.status.code).toBe(SpanStatusCode.ERROR);
      expect(hook.attributes[traceTypes.ATTR_EXCEPTION_TYPE]).toBe('Error');
      expect(hook.attributes[traceTypes.ATTR_EXCEPTION_MESSAGE]).toBe(REDACTED_EXCEPTION_MESSAGE);
      const rendered =
        JSON.stringify(hook.attributes) +
        JSON.stringify(hook.events.map((e) => [e.name, e.attributes ?? {}]));
      expect(rendered).not.toContain('Hello');
      expect(rendered).not.toContain('lookup failed');
    });
  });
});
