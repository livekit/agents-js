// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage additions on existing spans: interruption detail on `agent_turn`, the `update_agent`
 * handoff span, and fallback-adapter attribution on the request span.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { context as otelContext, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APIConnectionError } from '../_exceptions.js';
import { ChatContext } from '../llm/chat_context.js';
import { FallbackAdapter } from '../llm/fallback_adapter.js';
import { LLM, LLMStream } from '../llm/llm.js';
import type { ToolChoice, ToolContextLike } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import { assertTraceWellFormed } from '../telemetry/testing/trace_schema.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { delay } from '../utils.js';
import { VAD, type VADEvent, VADEventType, VADStream } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioInput, AudioOutput } from './io.js';
import { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

function spansNamed(exporter: InMemorySpanExporter, name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

function only(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const found = spansNamed(exporter, name);
  expect(found, `expected exactly one ${name} span, got ${found.length}`).toHaveLength(1);
  return found[0]!;
}

function childrenOf(exporter: InMemorySpanExporter, name: string, parent: ReadableSpan) {
  return spansNamed(exporter, name).filter(
    (span) => span.parentSpanContext?.spanId === parent.spanContext().spanId,
  );
}

function vadEvent(type: VADEventType, speechDuration = 0): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration,
    silenceDuration: 0,
    frames: [],
    probability: 1,
    inferenceDuration: 0,
    speaking: type !== VADEventType.END_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: speechDuration,
  };
}

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

  startOfSpeech(): void {
    this.streams.at(-1)!.emitEvent(vadEvent(VADEventType.START_OF_SPEECH));
  }

  /** The VAD has seen `speechDuration` ms of speech: what the barge-in check reads. */
  inferenceDone(speechDuration: number): void {
    this.streams.at(-1)!.emitEvent(vadEvent(VADEventType.INFERENCE_DONE, speechDuration));
  }

  endOfSpeech(): void {
    this.streams.at(-1)!.emitEvent(vadEvent(VADEventType.END_OF_SPEECH));
  }
}

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

/**
 * Plays frames as they arrive and reports how far it got: the position of an interrupted segment
 * is the wall-clock time since its first frame, as a real output would report.
 */
class PacedOutput extends AudioOutput {
  #segmentStartedAt?: number;
  #captured = 0;

  constructor() {
    super(24_000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    const segmentCount = this.capturedPlayoutSegments;
    await super.captureFrame(frame);
    this.#captured += frame.samplesPerChannel / frame.sampleRate;
    if (this.capturedPlayoutSegments > segmentCount) {
      this.#segmentStartedAt = Date.now();
      this.#captured = frame.samplesPerChannel / frame.sampleRate;
      this.onPlaybackStarted(Date.now());
    }
  }

  override flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: this.#captured, interrupted: false });
    }
  }

  override clearBuffer(): void {
    if (this.pendingPlayoutSegments > 0) {
      const played =
        this.#segmentStartedAt !== undefined ? (Date.now() - this.#segmentStartedAt) / 1000 : 0;
      this.onPlaybackFinished({ playbackPosition: played, interrupted: true });
    }
  }
}

/** An agent whose TTS streams `frames` 20 ms frames, one every `paceMs`: a long playout. */
class PacedAgent extends Agent {
  constructor(
    private readonly frames: number,
    private readonly paceMs: number,
  ) {
    super({ instructions: 'test' });
  }

  override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    const { frames, paceMs } = this;
    return new ReadableStream<AudioFrame>({
      async start(controller) {
        for (let i = 0; i < frames; i++) {
          controller.enqueue(new AudioFrame(new Int16Array(480), 24_000, 1, 480));
          await delay(paceMs);
        }
        controller.close();
      },
    });
  }
}

class FirstAgent extends PacedAgent {
  constructor() {
    super(1, 0);
  }
}

class SecondAgent extends PacedAgent {
  constructor() {
    super(1, 0);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

describe.sequential('coverage spans', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    setTracerProvider(provider);
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
  });

  // -- interruption detail --

  it('records the barge-in source and the playout position', async () => {
    const vad = new ScriptedVAD();
    const stt = new FakeSTT({
      capabilities: { streaming: true, interimResults: true },
      fakeUserSpeeches: [
        { startTime: 0, endTime: 200, transcript: 'Tell me a story.', sttDelay: 100 },
        // the barge-in: its transcript lands well after the VAD cut the reply short
        { startTime: 1_500, endTime: 1_700, transcript: 'Stop!', sttDelay: 100 },
      ],
    });
    const llm = new FakeLLM([
      { input: 'Tell me a story.', content: 'Here is a long story for you ... the end.' },
      { input: 'Stop!', content: 'Ok.' },
    ]);
    const session = new AgentSession({
      vad,
      stt,
      llm,
      aecWarmupDuration: 0,
      turnHandling: {
        turnDetection: 'vad',
        endpointing: { minDelay: 100, maxDelay: 100 },
        // no pause-and-resume: a barge-in interrupts the reply outright
        interruption: { resumeFalseInterruption: false, minDuration: 500 },
      },
    });
    const audioInput = new ScriptedAudioInput();
    session.input.audio = audioInput;
    session.output.audio = new PacedOutput();
    // 60 frames at 20 ms every 25 ms: ~1.5 s of playout for the story
    await session.start({ agent: new PacedAgent(60, 25) });
    try {
      audioInput.push(20);
      await delay(20);
      vad.startOfSpeech();
      await delay(200);
      vad.endOfSpeech();
      await waitFor(() => session.agentState === 'speaking', 10_000, 'the story to start playing');
      await delay(300);
      // the user talks over the story: VAD start, then enough speech for the barge-in check
      vad.startOfSpeech();
      vad.inferenceDone(600);
      await delay(200);
      vad.endOfSpeech();
      await waitFor(
        () =>
          spansNamed(exporter, 'agent_turn').filter(
            (span) => traceTypes.ATTR_E2E_LATENCY in span.attributes,
          ).length >= 2,
        10_000,
        'the reply to the barge-in to play',
      );
    } finally {
      await session.close();
    }

    const turns = spansNamed(exporter, 'agent_turn');
    const interrupted = turns.filter(
      (span) => span.attributes[traceTypes.ATTR_SPEECH_INTERRUPTED] === true,
    );
    expect(interrupted).toHaveLength(1);
    const turn = interrupted[0]!;
    expect(turn.attributes[traceTypes.ATTR_INTERRUPTION_SOURCE]).toBe('audio_activity');
    const position = turn.attributes[traceTypes.ATTR_PLAYOUT_POSITION];
    expect(position).toBeTypeOf('number');
    // ~0.3 s of the ~1.5 s story had played when the user cut in
    expect(position as number).toBeGreaterThan(0.1);
    expect(position as number).toBeLessThan(1.5);

    // the reply to "Stop!" was not interrupted and names no source
    for (const other of turns) {
      if (other === turn) continue;
      expect(other.attributes[traceTypes.ATTR_INTERRUPTION_SOURCE]).toBeUndefined();
    }
    // the whole tree, not just the edges this test names (telemetry/testing/trace_schema)
    assertTraceWellFormed(exporter.getFinishedSpans());
  });

  it('the first interruption cause stands', () => {
    const handle = SpeechHandle.create();
    handle.interrupt(false, 'audio_activity');
    handle.interrupt(false, 'user_turn'); // already interrupted: the first cause stands
    expect(handle._interruptSource).toBe('audio_activity');
    expect(SpeechHandle.create().interrupt()._interruptSource).toBe('programmatic');
  });

  // -- agent handoff --

  it('groups the handoff under an update_agent span', async () => {
    const TRANSCRIPT = 'Hello';
    const vad = new ScriptedVAD();
    const stt = new FakeSTT({
      capabilities: { streaming: true, interimResults: true },
      fakeUserSpeeches: [{ startTime: 0, endTime: 200, transcript: TRANSCRIPT, sttDelay: 100 }],
    });
    const llm = new FakeLLM([{ input: TRANSCRIPT, content: 'Hi there' }]);
    const session = new AgentSession({
      vad,
      stt,
      llm,
      turnHandling: { turnDetection: 'vad', endpointing: { minDelay: 100, maxDelay: 100 } },
    });
    const audioInput = new ScriptedAudioInput();
    session.input.audio = audioInput;
    session.output.audio = new PacedOutput();
    const first = new FirstAgent();
    const second = new SecondAgent();
    await session.start({ agent: first });
    try {
      audioInput.push(20);
      await delay(20);
      vad.startOfSpeech();
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

      session.updateAgent(second);
      await waitFor(
        () =>
          spansNamed(exporter, 'start_agent_activity').some(
            (span) => span.attributes[traceTypes.ATTR_AGENT_LABEL] === second.id,
          ),
        10_000,
        'the second agent to start',
      );
    } finally {
      await session.close();
    }

    const root = only(exporter, 'agent_session');
    const handoff = only(exporter, 'update_agent');
    expect(handoff.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(handoff.attributes[traceTypes.ATTR_PREVIOUS_AGENT_LABEL]).toBe(first.id);
    expect(handoff.attributes[traceTypes.ATTR_AGENT_LABEL]).toBe(second.id);

    // the old agent's drain (with on_exit inside it), then the new agent's start, under the handoff
    const [drain] = childrenOf(exporter, 'drain_agent_activity', handoff);
    expect(drain).toBeDefined();
    expect(childrenOf(exporter, 'on_exit', drain!)).toHaveLength(1);
    const [start] = childrenOf(exporter, 'start_agent_activity', handoff);
    expect(start?.attributes[traceTypes.ATTR_AGENT_LABEL]).toBe(second.id);

    // the initial start is not a handoff: it lives under session_start, not update_agent
    const sessionStart = only(exporter, 'session_start');
    expect(childrenOf(exporter, 'start_agent_activity', sessionStart)).toHaveLength(1);
    // the whole tree, not just the edges this test names (telemetry/testing/trace_schema)
    assertTraceWellFormed(exporter.getFinishedSpans());
  });

  // -- fallback adapter attribution --

  class FailingLLMStream extends LLMStream {
    protected async run(): Promise<void> {
      throw new APIConnectionError({ message: 'primary down' });
    }
  }

  class FailingLLM extends LLM {
    label(): string {
      return 'broken-llm';
    }

    override get model(): string {
      return 'broken-model';
    }

    override get provider(): string {
      return 'broken';
    }

    chat(opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions?: APIConnectOptions;
      parallelToolCalls?: boolean;
      toolChoice?: ToolChoice;
      extraKwargs?: Record<string, unknown>;
    }): LLMStream {
      return new FailingLLMStream(this, {
        chatCtx: opts.chatCtx,
        toolCtx: opts.toolCtx,
        connOptions: opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      });
    }
  }

  class ServingLLM extends FakeLLM {
    override get model(): string {
      return 'serving-model';
    }

    override get provider(): string {
      return 'openai';
    }
  }

  it('records the serving provider of an LLM fallback on the request and caller spans', async () => {
    const primary = new FailingLLM();
    const secondary = new ServingLLM([{ input: 'hi', content: 'hello' }]);
    const adapter = new FallbackAdapter({ llms: [primary, secondary], attemptTimeout: 1 });
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'hi' });
    let text = '';
    // the span the request is made under (llm_node in the pipeline, open until the stream is
    // consumed) is told who served
    await tracer.startActiveSpan(
      async () => {
        const stream = adapter.chat({ chatCtx });
        for await (const chunk of stream) {
          text += chunk.delta?.content ?? '';
        }
      },
      { name: 'caller' },
    );
    expect(text).toBe('hello');

    // the adapter's request span nests the attempt span that ran the fallback loop
    const runs = spansNamed(exporter, 'llm_request_run').filter(
      (span) => traceTypes.ATTR_FALLBACK_LABEL in span.attributes,
    );
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.attributes[traceTypes.ATTR_FALLBACK_LABEL]).toBe(secondary.label());
    expect(run.attributes[traceTypes.ATTR_FALLBACK_INDEX]).toBe(1);
    // the run names the one that served; the request span kept the one expected to (the primary,
    // still available when the request started) and gained the response side
    expect(run.attributes[traceTypes.ATTR_GEN_AI_REQUEST_MODEL]).toBe(secondary.model);
    const request = spansNamed(exporter, 'llm_request').find(
      (span) => span.spanContext().spanId === run.parentSpanContext?.spanId,
    );
    expect(request).toBeDefined();
    expect(request!.attributes[traceTypes.ATTR_GEN_AI_REQUEST_MODEL]).toBe(primary.model);
    expect(request!.attributes[traceTypes.ATTR_GEN_AI_RESPONSE_MODEL]).toBe(secondary.model);
    expect(request!.attributes[traceTypes.ATTR_GEN_AI_PROVIDER_NAME]).toBe('openai');
    // the caller's span gets the same response side, per request
    const caller = only(exporter, 'caller');
    expect(caller.attributes[traceTypes.ATTR_GEN_AI_RESPONSE_MODEL]).toBe(secondary.model);
    // and the adapter itself now reports who serves next
    expect(adapter.model).toBe(secondary.model);
    expect(adapter.provider).toBe(secondary.provider);
  });
});
