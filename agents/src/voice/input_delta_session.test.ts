// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { context as otelContext, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../ipc/inference_executor.js';
import {
  JobContext,
  type JobProcess,
  type RunningJobInfo,
  runWithJobContextAsync,
} from '../job.js';
import { initializeLogger } from '../log.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import { Agent } from './agent.js';
import { AgentSession, type RecordingOptions } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

function jobContext(): JobContext {
  const room = {
    name: 'room',
    on: () => room,
    off: () => room,
    isConnected: false,
    remoteParticipants: new Map(),
  };
  return new JobContext(
    {} as JobProcess,
    {
      acceptArguments: { name: 'agent', identity: 'agent', metadata: '' },
      job: { id: 'job-id', room: { name: 'room' } },
      url: 'wss://example.livekit.cloud',
      token: 'token',
      workerId: 'worker-id',
    } as RunningJobInfo,
    room as unknown as Room,
    () => {},
    () => {},
    {} as InferenceExecutor,
  );
}

function inputRoles(span: ReadableSpan): string[] {
  const messages = JSON.parse(
    String(span.attributes[traceTypes.ATTR_GEN_AI_INPUT_MESSAGES]),
  ) as Array<{ role: string }>;
  return messages.map((message) => message.role);
}

describe.sequential('AgentSession input delta recording', () => {
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

  async function runTwoTurns(record: RecordingOptions): Promise<ReadableSpan[]> {
    const llm = new FakeLLM([
      { input: 'Hello', content: 'Hi there' },
      { input: 'Weather?', content: 'Sunny' },
    ]);
    const session = new AgentSession({ llm, turnHandling: { turnDetection: 'manual' } });
    session.output.setAudioEnabled(false);
    session.output.setTranscriptionEnabled(false);

    const ctx = jobContext();
    vi.spyOn(ctx, 'initRecording').mockResolvedValue();
    await runWithJobContextAsync(ctx, () =>
      session.start({
        agent: new Agent({ instructions: 'You are a helpful assistant.' }),
        record,
      }),
    );
    try {
      await session.generateReply({ userInput: 'Hello' }).waitForPlayout();
      await session.generateReply({ userInput: 'Weather?' }).waitForPlayout();
    } finally {
      await session.close();
    }

    return exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'llm_request')
      .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
  }

  it('records the second scheduled turn as a delta of the first', async () => {
    const spans = await runTwoTurns({ traces: true, inputDelta: true });
    const [first, second] = spans;

    expect(spans).toHaveLength(2);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.attributes[traceTypes.ATTR_INPUT_DELTA]).toBeUndefined();
    expect(first!.attributes[traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeDefined();
    expect(inputRoles(first!)).toEqual(['user']);

    expect(second!.attributes).toMatchObject({
      [traceTypes.ATTR_INPUT_DELTA]: true,
      [traceTypes.ATTR_INPUT_BASE_SPAN_ID]: first!.spanContext().spanId,
      [traceTypes.ATTR_INPUT_DROPPED_FROM_BASE]: 0,
    });
    expect(second!.attributes[traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeUndefined();
    expect(inputRoles(second!)).toEqual(['assistant', 'user']);
    expect(second!.links.map((link) => link.context.spanId)).toEqual([first!.spanContext().spanId]);
  });

  it.each([
    ['false', { traces: true, inputDelta: false }],
    ['omitted', { traces: true }],
  ] satisfies Array<[string, RecordingOptions]>)(
    'records full input when inputDelta is %s',
    async (_name, record) => {
      const spans = await runTwoTurns(record);

      expect(spans).toHaveLength(2);
      for (const span of spans) {
        expect(Object.keys(span.attributes).some((key) => key.startsWith('lk.input.'))).toBe(false);
        expect(span.attributes[traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeDefined();
      }
      expect(inputRoles(spans[1]!)).toEqual(['user', 'assistant', 'user']);
    },
  );
});
