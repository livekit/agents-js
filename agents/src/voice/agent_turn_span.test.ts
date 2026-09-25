// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * One `agent_turn` span per speech handle.
 *
 * A reply that calls a tool runs two generations (LLM steps) in two tasks; they used to be two
 * `agent_turn` spans linked only by `lk.parent_generation_id`. The speech handle now owns a
 * single span for its whole life: each generation is an event on it, tool and inference spans
 * nest under it, and it ends with the speech.
 */
import { AudioFrame } from '@livekit/rtc-node';
import {
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  SpanStatusCode,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '../llm/chat_context.js';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import * as otelMetrics from '../telemetry/otel_metrics.js';
import { Agent } from './agent.js';
import { continueDiscardedTurn, continueToolReplyTurn, withAgentTurn } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput } from './io.js';
import { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

function spansNamed(exporter: InMemorySpanExporter, name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

function childrenOf(exporter: InMemorySpanExporter, parent: ReadableSpan, name: string) {
  return spansNamed(exporter, name).filter(
    (span) => span.parentSpanContext?.spanId === parent.spanContext().spanId,
  );
}

function ms(time: [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6;
}

/** Reports playout as soon as frames arrive, so a reply "plays" instantly. */
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

class WeatherAgent extends Agent {
  constructor() {
    super({
      instructions: 'You are a helpful assistant.',
      tools: {
        get_weather: tool({
          description: 'Look up the weather',
          execute: async () => 'sunny in Tokyo',
        }),
      },
    });
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

describe.sequential('agent_turn span', () => {
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
    vi.restoreAllMocks();
    setTracerProvider(originalProvider);
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
  });

  async function runReply(llm: FakeLLM, agent: Agent, userInput: string): Promise<void> {
    const session = new AgentSession({ llm, stt: new FakeSTT() });
    session.output.audio = new ImmediateOutput();
    await session.start({ agent });
    try {
      const speech = session.generateReply({ userInput });
      await speech.waitForPlayout();
    } finally {
      await session.close();
    }
  }

  it('a tool call is one agent turn', async () => {
    const llm = new FakeLLM([
      {
        input: "What's the weather in Tokyo?",
        content: '',
        toolCalls: [{ name: 'get_weather', args: { location: 'Tokyo' } }],
      },
      { input: '"sunny in Tokyo"', content: 'It is sunny in Tokyo.' },
    ]);
    await runReply(llm, new WeatherAgent(), "What's the weather in Tokyo?");

    const [root] = spansNamed(exporter, 'agent_session');
    const turns = spansNamed(exporter, 'agent_turn');
    expect(
      turns.map((turn) => turn.attributes[traceTypes.ATTR_SPEECH_ID]),
      'one agent_turn per speech',
    ).toHaveLength(1);
    const [turn] = turns;
    expect(turn!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);

    const attrs = turn!.attributes;
    const speechId = attrs[traceTypes.ATTR_SPEECH_ID] as string;
    expect(attrs[traceTypes.ATTR_GENERATION_COUNT]).toBe(2);
    expect(attrs[traceTypes.ATTR_AGENT_TURN_ID]).toBe(`${speechId}_2`);
    const generations = turn!.events.filter((event) => event.name === 'generation');
    expect(generations.map((event) => event.attributes?.[traceTypes.ATTR_AGENT_TURN_ID])).toEqual([
      `${speechId}_1`,
      `${speechId}_2`,
    ]);
    expect(generations[0]!.attributes?.[traceTypes.ATTR_AGENT_PARENT_TURN_ID]).toBeUndefined();
    expect(generations[1]!.attributes?.[traceTypes.ATTR_AGENT_PARENT_TURN_ID]).toBe(
      `${speechId}_1`,
    );

    // both generations' inference, the tool between them, and the speech all nest under it
    expect(childrenOf(exporter, turn!, 'llm_node')).toHaveLength(2);
    const [toolSpan] = childrenOf(exporter, turn!, 'function_tool');
    const [tts] = childrenOf(exporter, turn!, 'tts_node');
    const [speaking] = childrenOf(exporter, turn!, 'agent_speaking');
    expect(toolSpan).toBeDefined();
    expect(tts).toBeDefined();
    expect(speaking).toBeDefined();
    expect(ms(toolSpan!.startTime)).toBeLessThan(ms(tts!.startTime));
    // and the turn covers everything, ending with the speech rather than with the first step
    // (2 ms of slack: the SDK anchors each span's clock at creation)
    for (const child of [toolSpan!, tts!, speaking!]) {
      expect(ms(turn!.startTime)).toBeLessThanOrEqual(ms(child.startTime) + 2);
      expect(ms(child.endTime)).toBeLessThanOrEqual(ms(turn!.endTime) + 2);
    }
  });

  it('a plain reply is one generation', async () => {
    const llm = new FakeLLM([{ input: 'Hello', content: 'Hi there' }]);
    await runReply(llm, new WeatherAgent(), 'Hello');

    const [turn] = spansNamed(exporter, 'agent_turn');
    expect(spansNamed(exporter, 'agent_turn')).toHaveLength(1);
    const attrs = turn!.attributes;
    expect(attrs[traceTypes.ATTR_GENERATION_COUNT]).toBe(1);
    expect(attrs[traceTypes.ATTR_AGENT_TURN_ID]).toBe(`${attrs[traceTypes.ATTR_SPEECH_ID]}_1`);
    expect(turn!.events.filter((event) => event.name === 'generation')).toHaveLength(1);
    expect(attrs[traceTypes.ATTR_AGENT_PARENT_TURN_ID]).toBeUndefined();
  });

  it('a discarded preemptive generation hands its turn to the successor', async () => {
    // a preemptive attempt discarded for the real reply (or a newer attempt) must not leave a
    // second agent_turn behind: the successor continues the span, the discarded speech ends
    // without touching it
    const root = tracer.startSpan({ name: 'agent_session' });
    const rootCtx = trace.setSpan(ROOT_CONTEXT, root);
    const attempt = SpeechHandle.create({ allowInterruptions: true });
    await withAgentTurn(attempt, { rootContext: rootCtx, agentLabel: 'a' }, async () => {
      // the attempt's first generation ran here
    });

    const reply = SpeechHandle.create({ allowInterruptions: true });
    continueDiscardedTurn(attempt, reply);
    attempt._markDone(); // the cancelled attempt finishes: the span must survive it
    expect(spansNamed(exporter, 'agent_turn')).toEqual([]);

    await withAgentTurn(reply, { rootContext: rootCtx, agentLabel: 'a' }, async () => {});
    reply._markDone();
    root.end();

    const [turn] = spansNamed(exporter, 'agent_turn');
    expect(spansNamed(exporter, 'agent_turn')).toHaveLength(1);
    const attrs = turn!.attributes;
    expect(attrs[traceTypes.ATTR_SPEECH_ID]).toBe(reply.id);
    // the discarded attempt's generation and the reply's: the count is of the turn, not the handle
    expect(attrs[traceTypes.ATTR_GENERATION_COUNT]).toBe(2);
    expect(turn!.events.map((event) => event.name)).toEqual([
      'generation',
      'preemptive_generation_discarded',
      'generation',
    ]);
    const discarded = turn!.events.find(
      (event) => event.name === 'preemptive_generation_discarded',
    );
    expect(discarded?.attributes?.[traceTypes.ATTR_SPEECH_ID]).toBe(attempt.id);

    // nothing to hand over: a plain successor is untouched
    continueDiscardedTurn(undefined, reply);
    continueDiscardedTurn(reply, reply);
  });

  it('hands the turn over before the successor task opens its own', async () => {
    // Task runs its body synchronously, and the reply task opens agent_turn in its first
    // statements: a handoff performed after generateReply() returned came too late, leaving the
    // successor's own span unended and its llm_node / tts_node dangling from it. The handoff now
    // happens inside generateReply, before the task starts.
    const llm = new FakeLLM([{ input: 'Hello', content: 'Hi there' }]);
    const session = new AgentSession({ llm, stt: new FakeSTT() });
    session.output.audio = new ImmediateOutput();
    const agent = new WeatherAgent();
    await session.start({ agent });
    try {
      const activity = agent._agentActivity!;
      const attempt = SpeechHandle.create({ allowInterruptions: true });
      await withAgentTurn(
        attempt,
        { rootContext: session.rootSpanContext, agentLabel: agent.id },
        async () => {},
      );
      const reply = activity.generateReply({
        userMessage: ChatMessage.create({ role: 'user', content: 'Hello' }),
        inputDetails: { modality: 'audio' },
        continueTurnFrom: attempt,
      });
      attempt._markDone();
      await reply.waitForPlayout();
    } finally {
      await session.close();
    }

    const turns = spansNamed(exporter, 'agent_turn');
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn!.attributes[traceTypes.ATTR_GENERATION_COUNT]).toBe(2);
    expect(turn!.events.map((event) => event.name)).toEqual([
      'generation',
      'preemptive_generation_discarded',
      'generation',
    ]);
    // the successor's work nests under the adopted turn
    expect(childrenOf(exporter, turn!, 'llm_node')).toHaveLength(1);
    expect(childrenOf(exporter, turn!, 'tts_node')).toHaveLength(1);
    expect(childrenOf(exporter, turn!, 'agent_speaking')).toHaveLength(1);
    // and nothing dangles from a span that never ended
    const exported = new Set(exporter.getFinishedSpans().map((span) => span.spanContext().spanId));
    const dangling = exporter
      .getFinishedSpans()
      .filter((span) => span.parentSpanContext && !exported.has(span.parentSpanContext.spanId));
    expect(dangling.map((span) => span.name)).toEqual([]);
  });

  it('keeps counting generations across repeated handoffs', async () => {
    // attempt A is replaced by attempt B, which is replaced by the reply: three generations on
    // one turn, and the count says so however many hands the turn went through
    const root = tracer.startSpan({ name: 'agent_session' });
    const rootCtx = trace.setSpan(ROOT_CONTEXT, root);
    const opts = { rootContext: rootCtx, agentLabel: 'a' };
    const a = SpeechHandle.create({ allowInterruptions: true });
    await withAgentTurn(a, opts, async () => {});
    const b = SpeechHandle.create({ allowInterruptions: true });
    continueDiscardedTurn(a, b);
    a._markDone();
    await withAgentTurn(b, opts, async () => {});
    const reply = SpeechHandle.create({ allowInterruptions: true });
    continueDiscardedTurn(b, reply);
    b._markDone();
    await withAgentTurn(reply, opts, async () => {});
    reply._markDone();
    root.end();

    const [turn] = spansNamed(exporter, 'agent_turn');
    expect(spansNamed(exporter, 'agent_turn')).toHaveLength(1);
    expect(turn!.attributes[traceTypes.ATTR_GENERATION_COUNT]).toBe(3);
    expect(turn!.events.filter((event) => event.name === 'generation')).toHaveLength(3);
    // each speech still numbers its own generations, as python does
    expect(turn!.attributes[traceTypes.ATTR_AGENT_TURN_ID]).toBe(`${reply.id}_1`);
  });

  it('a realtime tool reply continues the tool call turn as its next generation', async () => {
    // the framework runs the reply on a new handle; python runs it on the same one as step 2.
    // Either way the trace is one turn: the reply's generation numbered after the tool call's
    // and parented to it, under the tool call's speech id
    const root = tracer.startSpan({ name: 'agent_session' });
    const rootCtx = trace.setSpan(ROOT_CONTEXT, root);
    const opts = { rootContext: rootCtx, agentLabel: 'a' };
    const speech = SpeechHandle.create({ allowInterruptions: true });
    let reply: SpeechHandle | undefined;
    await withAgentTurn(speech, opts, async () => {
      // the tool calls ran; the framework creates the reply inside the tool call's turn
      speech._numSteps += 1; // as the realtime path does before scheduling the reply
      reply = SpeechHandle.create({ allowInterruptions: true, parent: speech });
      continueToolReplyTurn(speech, reply);
    });
    speech._markDone(); // the tool call's own handle ends: the span must survive it
    expect(spansNamed(exporter, 'agent_turn')).toEqual([]);
    await withAgentTurn(reply!, opts, async () => {});
    reply!._markDone();
    root.end();

    const turns = spansNamed(exporter, 'agent_turn');
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    const attrs = turn!.attributes;
    expect(attrs[traceTypes.ATTR_SPEECH_ID]).toBe(speech.id);
    // what the reply's own step stamps on the turn: the tool call's id, not the new handle's
    expect(reply!._turnSpeechId).toBe(speech.id);
    expect(speech._turnSpeechId).toBe(speech.id);
    expect(attrs[traceTypes.ATTR_GENERATION_COUNT]).toBe(2);
    expect(attrs[traceTypes.ATTR_AGENT_TURN_ID]).toBe(`${speech.id}_2`);
    const generations = turn!.events.filter((event) => event.name === 'generation');
    expect(generations.map((event) => event.attributes?.[traceTypes.ATTR_AGENT_TURN_ID])).toEqual([
      `${speech.id}_1`,
      `${speech.id}_2`,
    ]);
    expect(generations[1]!.attributes?.[traceTypes.ATTR_AGENT_PARENT_TURN_ID]).toBe(
      `${speech.id}_1`,
    );
    expect(turn!.events.some((event) => event.name === 'preemptive_generation_discarded')).toBe(
      false,
    );
    // no handoff to make: the same handle
    continueToolReplyTurn(reply!, reply!);
  });

  it.each([
    ['an Error', new Error('provider unavailable')],
    ['a string', 'provider unavailable'],
  ])('a task failure fails the turn and surfaces on the handle (%s)', async (_kind, failure) => {
    // an LLM node that throws rejects the speech task; the turn ends with the error and the
    // handle reports it, instead of an unremarkable success. A thrown value that is not an
    // Error is a failure all the same
    class BrokenAgent extends WeatherAgent {
      override async llmNode(): Promise<never> {
        throw failure;
      }
    }
    const llm = new FakeLLM([{ input: 'Hello', content: 'Hi there' }]);
    const session = new AgentSession({ llm, stt: new FakeSTT() });
    session.output.audio = new ImmediateOutput();
    await session.start({ agent: new BrokenAgent() });
    let speech: SpeechHandle | undefined;
    try {
      speech = session.generateReply({ userInput: 'Hello' });
      await speech.waitForPlayout();
    } finally {
      await session.close();
    }

    expect(speech!.exception()).toBe(failure);
    const [turn] = spansNamed(exporter, 'agent_turn');
    expect(turn!.status.code).toBe(SpanStatusCode.ERROR);
    expect(
      turn!.events.find((event) => event.name === 'exception')?.attributes?.['exception.message'],
    ).toBe('provider unavailable');
  });

  it('a failure that is not an Error still fails the turn', async () => {
    const handle = SpeechHandle.create({ allowInterruptions: true });
    await withAgentTurn(handle, { rootContext: undefined, agentLabel: 'a' }, async () => {});
    handle._markDone('llm down');

    const [turn] = spansNamed(exporter, 'agent_turn');
    expect(turn!.status.code).toBe(SpanStatusCode.ERROR);
    expect(
      turn!.events.find((event) => event.name === 'exception')?.attributes?.['exception.message'],
    ).toBe('llm down');
  });

  it('an LLM failure stored on the handle fails the turn', async () => {
    // the pipeline stores the failure on the handle when it marks it done; the turn must end as
    // failed whichever step it was on
    const handle = SpeechHandle.create({ allowInterruptions: true });
    await withAgentTurn(handle, { rootContext: undefined, agentLabel: 'a' }, async () => {});
    handle._markDone(new Error('llm down'));

    const [turn] = spansNamed(exporter, 'agent_turn');
    expect(turn!.status.code).toBe(SpanStatusCode.ERROR);
    expect(turn!.events.filter((event) => event.name === 'exception')).toHaveLength(1);
  });

  it('records the turn duration metric even when the span is sampled out', () => {
    const record = vi.spyOn(otelMetrics, 'recordInvokeAgentDuration').mockImplementation(() => {});
    const handle = SpeechHandle.create({ allowInterruptions: true });
    handle._agentTurnSpan = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    handle._agentTurnStartedAt = performance.now() - 1_000;
    handle._agentTurnAgentName = 'a';
    handle._markDone();
    expect(record).toHaveBeenCalledTimes(1);
    const [duration, agentName] = record.mock.calls[0]!;
    expect(agentName).toBe('a');
    expect(duration).toBeGreaterThanOrEqual(1);
    expect(duration).toBeLessThan(5);
  });

  it('hands a sampled-out turn to the successor too', () => {
    // the successor adopts a non-recording turn as well, so the duration metric keeps the
    // discarded attempt's start time
    const attempt = SpeechHandle.create({ allowInterruptions: true });
    attempt._agentTurnSpan = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    attempt._agentTurnStartedAt = 1;
    attempt._agentTurnAgentName = 'a';

    const reply = SpeechHandle.create({ allowInterruptions: true });
    continueDiscardedTurn(attempt, reply);
    expect(attempt._agentTurnSpan).toBeUndefined();
    expect(reply._agentTurnSpan).toBeDefined();
    expect(reply._agentTurnStartedAt).toBe(1);
    expect(reply._agentTurnAgentName).toBe('a');
  });
});
