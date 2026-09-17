// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The trace-shape checker itself: the rules catch the mistakes they exist for, both span
 * sources agree, and a full fake session passes clean.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatContext } from '../../llm/chat_context.js';
import { FallbackAdapter } from '../../llm/fallback_adapter.js';
import { initializeLogger } from '../../log.js';
import { FakeSTT } from '../../stt/testing/fake_stt.js';
import { Agent } from '../../voice/agent.js';
import { AgentSession } from '../../voice/agent_session.js';
import { AudioOutput } from '../../voice/io.js';
import { FakeLLM } from '../../voice/testing/fake_llm.js';
import { setTracerProvider, tracer } from '../index.js';
import {
  ANY,
  type EventRecord,
  MAY_OUTLIVE_PARENT,
  ROOT,
  SPAN_PARENTS,
  type SpanRecord,
  assertTraceWellFormed,
  checkTrace,
  fromOtlpJson,
  fromReadableSpans,
} from './trace_schema.js';

initializeLogger({ pretty: false, level: 'silent' });

function span(
  name: string,
  spanId: string,
  parent: string | undefined,
  start: number,
  end: number,
  attributes: Record<string, unknown> = {},
  events: (string | EventRecord)[] = [],
): SpanRecord {
  return {
    name,
    spanId,
    parentId: parent,
    traceId: 't1',
    startMs: start * 1000,
    endMs: end * 1000,
    attributes: { ...attributes },
    events: events.map((e) => (typeof e === 'string' ? { name: e, attributes: {} } : e)),
  };
}

function soundTrace(): SpanRecord[] {
  return [
    span('job_entrypoint', 'j', undefined, 0.0, 30.0),
    span('agent_session', 's', 'j', 1.0, 28.0),
    span('user_turn', 'u', 's', 5.0, 7.0),
    span('eou_wait', 'w', 'u', 6.5, 7.0, { 'lk.eou.outcome': 'committed' }),
    span('eou_detection', 'd', 'w', 6.8, 6.9),
    span('on_user_turn_completed', 'h', 'u', 6.95, 7.0),
    span(
      'agent_turn',
      'a',
      's',
      7.0,
      12.0,
      { 'lk.speech_id': 'speech_1', 'lk.generation_count': 2 },
      ['generation', 'generation'],
    ),
    span('llm_node', 'l', 'a', 7.0, 8.0),
    span('llm_request', 'r', 'l', 7.0, 8.0),
    span('function_tool', 'f', 'a', 8.0, 8.1),
    span('job_shutdown', 'x', 'j', 28.0, 30.0),
  ];
}

const TURN = 6; // index of the agent_turn in soundTrace()

describe('trace schema rules', () => {
  it('is self-consistent', () => {
    // every parent named in the rules is itself a known span (or ROOT / ANY)
    for (const [name, allowed] of SPAN_PARENTS) {
      for (const parent of allowed) {
        expect(
          parent === ROOT || parent === ANY || SPAN_PARENTS.has(parent),
          `${name}: unknown parent ${String(parent)}`,
        ).toBe(true);
      }
    }
    for (const key of MAY_OUTLIVE_PARENT.keys()) {
      const [child, parent] = key.split(' -> ') as [string, string];
      expect(SPAN_PARENTS.has(child), key).toBe(true);
      expect(parent === ANY || SPAN_PARENTS.has(parent), key).toBe(true);
    }
  });

  it('accepts a sound trace', () => {
    expect(checkTrace(soundTrace())).toEqual([]);
  });

  it('reports a wrong parent', () => {
    // the keyterm-detection style mistake: an llm_request straight under agent_turn
    let spans = soundTrace();
    spans.push(span('llm_request', 'k', 'a', 7.1, 7.9));
    const [violation, ...rest] = checkTrace(spans);
    expect(rest).toEqual([]);
    expect(violation).toMatch(/^llm_request: parent is agent_turn/);

    // eou_detection outside its wait
    spans = soundTrace();
    spans.push(span('eou_detection', 'd2', 'u', 6.0, 6.1));
    expect(checkTrace(spans).some((v) => v.startsWith('eou_detection: parent is user_turn'))).toBe(
      true,
    );
  });

  it('reports an unknown span and a missing parent', () => {
    let spans = [...soundTrace(), span('mystery', 'm', 's', 2.0, 3.0)];
    expect(checkTrace(spans).some((v) => v.includes('mystery: unknown span'))).toBe(true);

    spans = [...soundTrace(), span('user_speaking', 'p', 'gone', 2.0, 3.0)];
    expect(checkTrace(spans).some((v) => v.includes('parent gone is not in the trace'))).toBe(true);
    // a partial export (a view keyed to one span drops the ancestors): the orphan's edge is
    // simply not checked
    expect(checkTrace(spans, { allowMissingParents: true })).toEqual([]);
  });

  it('checks bounds except where deliberately allowed', () => {
    let spans = soundTrace();
    spans.push(span('tts_node', 't', 'a', 11.0, 12.5)); // ends after agent_turn
    expect(
      checkTrace(spans).some((v) =>
        v.startsWith('tts_node: ends 500.0 ms after its parent agent_turn'),
      ),
    ).toBe(true);

    spans = soundTrace();
    spans.push(span('user_speaking', 'sp', 'u', 4.0, 6.0)); // starts before user_turn
    expect(
      checkTrace(spans).some((v) => v.startsWith('user_speaking: starts 1000.0 ms before')),
    ).toBe(true);

    // session.start() returning before the participant is linked is a known shape
    spans = soundTrace();
    spans.push(span('session_start', 'ss', 's', 1.0, 2.0));
    spans.push(span('wait_for_participant', 'wp', 'ss', 2.0, 4.0));
    expect(checkTrace(spans)).toEqual([]);
    // and a stall's end is one tick late by construction, whatever it is under
    spans.push(span('event_loop_blocked', 'b', 'f', 8.05, 8.15));
    expect(checkTrace(spans)).toEqual([]);
  });

  it('checks the per-turn invariants', () => {
    let spans = soundTrace();
    spans.push(
      span(
        'agent_turn',
        'a2',
        's',
        13.0,
        14.0,
        { 'lk.speech_id': 'speech_1', 'lk.generation_count': 1 },
        ['generation'],
      ),
    );
    expect(checkTrace(spans).some((v) => v.includes('speech speech_1 has 2 turns'))).toBe(true);

    spans = soundTrace();
    spans[TURN]!.attributes['lk.generation_count'] = 3;
    expect(
      checkTrace(spans).some((v) => v.includes('lk.generation_count=3 but 2 of its own')),
    ).toBe(true);

    // a turn without its identity or its count is malformed, not exempt
    spans = soundTrace();
    delete spans[TURN]!.attributes['lk.speech_id'];
    expect(checkTrace(spans)).toContain('agent_turn: no lk.speech_id');
    spans = soundTrace();
    delete spans[TURN]!.attributes['lk.generation_count'];
    expect(checkTrace(spans).some((v) => v.includes('lk.generation_count=undefined'))).toBe(true);
    spans = soundTrace();
    spans[TURN]!.attributes['lk.generation_count'] = 'two';
    expect(checkTrace(spans).some((v) => v.includes('lk.generation_count="two"'))).toBe(true);

    // a discarded preemptive attempt's generation sits on the span but is not the speech's own
    spans = soundTrace();
    spans[TURN]!.events = [
      { name: 'generation', attributes: { 'lk.generation_id': 'speech_0_1' } },
      { name: 'preemptive_generation_discarded', attributes: { 'lk.speech_id': 'speech_0' } },
      { name: 'generation', attributes: { 'lk.generation_id': 'speech_1_1' } },
      { name: 'generation', attributes: { 'lk.generation_id': 'speech_1_2' } },
    ];
    expect(checkTrace(spans)).toEqual([]);

    spans = soundTrace();
    delete spans[3]!.attributes['lk.eou.outcome'];
    expect(checkTrace(spans)).toContain('eou_wait: no lk.eou.outcome');

    spans = soundTrace();
    spans[1]!.traceId = 't2';
    expect(checkTrace(spans).some((v) => v.includes('2 traces'))).toBe(true);
  });
});

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

class SilentAgent extends Agent {
  constructor() {
    super({ instructions: 'You are a helpful assistant.' });
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

describe.sequential('trace schema on real spans', () => {
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

  it('reads OTLP/JSON and readable spans the same way', async () => {
    let rootSpanId = '';
    await tracer.startActiveSpan(
      async (root) => {
        rootSpanId = root.spanContext().spanId;
        await tracer.startActiveSpan(
          async (turn) => {
            turn.addEvent('generation', { 'lk.generation_id': 'x_1' });
          },
          { name: 'user_turn', attributes: { 'lk.speech_id': 'x' } },
        );
      },
      { name: 'agent_session' },
    );
    const readable = fromReadableSpans(exporter.getFinishedSpans());

    const attrs = (values: Record<string, unknown>) =>
      Object.entries(values).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      }));
    const document = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: readable.map((s) => ({
                name: s.name,
                spanId: s.spanId,
                parentSpanId: s.parentId ?? '',
                traceId: s.traceId,
                startTimeUnixNano: String(BigInt(Math.round(s.startMs * 1e6))),
                endTimeUnixNano: String(BigInt(Math.round(s.endMs * 1e6))),
                attributes: attrs(s.attributes),
                events: s.events.map((e) => ({ name: e.name, attributes: attrs(e.attributes) })),
              })),
            },
          ],
        },
      ],
    };
    const converted = fromOtlpJson(document);
    expect(converted.map((s) => [s.name, s.parentId, s.events])).toEqual(
      readable.map((s) => [s.name, s.parentId, s.events]),
    );
    const turn = converted.find((s) => s.name === 'user_turn');
    expect(turn?.parentId).toBe(rootSpanId);
    // nanosecond round trip keeps the millisecond timestamps
    for (const [a, b] of converted.map((s, i) => [s, readable[i]!] as const)) {
      expect(Math.abs(a.startMs - b.startMs)).toBeLessThan(1e-3);
      expect(Math.abs(a.endMs - b.endMs)).toBeLessThan(1e-3);
    }
    expect(checkTrace(converted)).toEqual([]);
    expect(checkTrace(readable)).toEqual([]);
  });

  it('finds a full fake session well-formed', async () => {
    const llm = new FakeLLM([{ input: 'Hello there', content: 'Hi!' }]);
    const session = new AgentSession({ llm, stt: new FakeSTT() });
    session.output.audio = new ImmediateOutput();
    await session.start({ agent: new SilentAgent() });
    try {
      const speech = session.generateReply({ userInput: 'Hello there' });
      await speech.waitForPlayout();
    } finally {
      await session.close();
    }
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain('agent_turn');
    assertTraceWellFormed(exporter.getFinishedSpans());
  });

  it('allows the fallback adapter request shapes', async () => {
    // the adapter's request span stands in for the provider's; each attempt opens the wrapped
    // stream inside its llm_request_run, so the provider's request span nests under the attempt
    const adapter = new FallbackAdapter({
      llms: [new FakeLLM([{ input: 'hi', content: 'hello' }])],
      attemptTimeout: 1,
    });
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'hi' });
    await tracer.startActiveSpan(
      async () =>
        tracer.startActiveSpan(
          async (turn) => {
            turn.addEvent('generation', { 'lk.generation_id': 'sp_1' });
            await tracer.startActiveSpan(
              async () => {
                const stream = adapter.chat({ chatCtx });
                for await (const _chunk of stream) {
                  // drain
                }
              },
              { name: 'llm_node' },
            );
          },
          {
            name: 'agent_turn',
            attributes: { 'lk.speech_id': 'sp', 'lk.generation_count': 1 },
          },
        ),
      { name: 'agent_session' },
    );
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names.filter((n) => n === 'llm_request').length).toBeGreaterThanOrEqual(2);
    assertTraceWellFormed(exporter.getFinishedSpans());
  });
});
