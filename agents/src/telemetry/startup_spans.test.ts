// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Startup telemetry around the job: the `room_connect` and `wait_for_participant` spans on
 * `JobContext`, and the two guarantees the startup spans rest on: a detached span is never
 * current, and session work nests under `session_start` only while the session is starting.
 */
import { Job, Room as ProtoRoom } from '@livekit/protocol';
import { ParticipantKind, type RemoteParticipant, type Room } from '@livekit/rtc-node';
import { ROOT_CONTEXT, SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../ipc/inference_executor.js';
import { AutoSubscribe, JobContext, JobProcess, type RunningJobInfo } from '../job.js';
import { initializeLogger } from '../log.js';
import { setTracerProvider, traceTypes, tracer } from './index.js';
import { sessionSpan } from './session_context.js';

initializeLogger({ pretty: false, level: 'silent' });

function info(): RunningJobInfo {
  return {
    acceptArguments: { name: 'agent', identity: 'agent-1', metadata: '{}' },
    job: new Job({
      id: 'AJ_1',
      dispatchId: 'AD_1',
      agentName: 'demo',
      room: new ProtoRoom({ name: 'room-1', sid: 'RM_1' }),
    }),
    url: 'wss://example.livekit.cloud',
    token: 'tok',
    workerId: 'W_1',
  };
}

function mockRoom(overrides: Record<string, unknown> = {}): Room {
  return {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(async () => undefined),
    isConnected: false,
    remoteParticipants: new Map(),
    localParticipant: { sid: 'PA_agent', identity: 'agent-1' },
    ...overrides,
  } as unknown as Room;
}

function jobContext(room: Room): JobContext {
  return new JobContext(
    new JobProcess(),
    info(),
    room,
    () => undefined,
    () => undefined,
    { doInference: vi.fn() } as unknown as InferenceExecutor,
  );
}

const spans = (exporter: InMemorySpanExporter, name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((span) => span.name === name);

describe('startup spans', () => {
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

  describe('room_connect', () => {
    it('lands under the job span with the room and participant attributes', async () => {
      const room = mockRoom();
      const ctx = jobContext(room);

      // the entrypoint usually connects before session.start(): the span lands under the
      // job's own span right away, no session needed
      const entrypoint = await tracer.startActiveSpan(
        async (span) => {
          await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
          return span;
        },
        { name: 'job_entrypoint' },
      );
      expect(room.connect).toHaveBeenCalledOnce();

      const [span] = spans(exporter, 'room_connect');
      expect(span!.parentSpanContext?.spanId).toBe(entrypoint.spanContext().spanId);
      const attrs = span!.attributes;
      expect(attrs[traceTypes.ATTR_ROOM_NAME]).toBe('room-1');
      expect(attrs[traceTypes.ATTR_ROOM_SID]).toBe('RM_1');
      expect(attrs[traceTypes.ATTR_ROOM_AUTO_SUBSCRIBE]).toBe('audio_only');
      expect(attrs[traceTypes.ATTR_ROOM_E2EE]).toBe(false);
      expect(attrs[traceTypes.ATTR_PARTICIPANT_ID]).toBe('PA_agent');
      expect(attrs[traceTypes.ATTR_PARTICIPANT_IDENTITY]).toBe('agent-1');
      expect(attrs[traceTypes.ATTR_ROOM_REMOTE_PARTICIPANT_COUNT]).toBe(0);
    });

    it('records a failed connect as an error span', async () => {
      const room = mockRoom({
        connect: vi.fn(async () => {
          throw new Error('token expired');
        }),
      });
      const ctx = jobContext(room);

      await expect(ctx.connect()).rejects.toThrow('token expired');

      const [span] = spans(exporter, 'room_connect');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.events.some((event) => event.name === 'exception')).toBe(true);
    });
  });

  it('spans the participant wait with the filter and the participant found', async () => {
    const participant = {
      sid: 'PA_user',
      identity: 'user-1',
      kind: ParticipantKind.STANDARD,
      info: { kind: ParticipantKind.STANDARD },
    } as unknown as RemoteParticipant;
    const room = mockRoom({
      isConnected: true,
      remoteParticipants: new Map([['user-1', participant]]),
    });
    const ctx = jobContext(room);

    await expect(ctx.waitForParticipant('user-1')).resolves.toBe(participant);

    const [span] = spans(exporter, 'wait_for_participant');
    expect(span!.attributes[traceTypes.ATTR_ROOM_IO_PARTICIPANT_FILTER]).toBe(true);
    expect(span!.attributes[traceTypes.ATTR_PARTICIPANT_ID]).toBe('PA_user');
    expect(span!.attributes[traceTypes.ATTR_PARTICIPANT_IDENTITY]).toBe('user-1');
    expect(span!.attributes[traceTypes.ATTR_PARTICIPANT_KIND]).toBe('STANDARD');
  });

  describe('startup spans are never current', () => {
    const currentSpanName = () =>
      new Promise<string>((resolve) =>
        setImmediate(() => resolve((trace.getActiveSpan() as { name?: string })?.name ?? '<none>')),
      );

    it('detached spans take their parent without becoming current', async () => {
      await tracer.startActiveSpan(
        async (root) => {
          const parent = tracer.startSpan({ name: 'session_start' });
          await tracer.detachedSpan(
            async () => {
              // a task spawned here inherits the ambient context, not the detached span
              expect(trace.getActiveSpan()).toBe(root);
              expect(await currentSpanName()).toBe('agent_session');
            },
            { name: 'publish_audio_output', context: trace.setSpan(ROOT_CONTEXT, parent) },
          );
          parent.end();
          const [published] = spans(exporter, 'publish_audio_output');
          expect(published!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
          expect(published!.ended).toBe(true);
        },
        { name: 'agent_session' },
      );
    });

    it('detached spans record the exception and rethrow', async () => {
      await expect(
        tracer.detachedSpan(
          async () => {
            throw new Error('no one came');
          },
          { name: 'wait_for_participant' },
        ),
      ).rejects.toThrow('no one came');
      const [span] = spans(exporter, 'wait_for_participant');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('session work nests under session_start while starting, else the ambient span', async () => {
      // the room's event tasks are created inside room.connect(); whatever is current there
      // becomes the parent of every span those tasks emit for the rest of the session
      await tracer.startActiveSpan(
        async (root) => {
          const start = tracer.startSpan({ name: 'session_start' });
          const starting = {
            _primaryAgentSession: {
              rootSpanContext: trace.setSpan(ROOT_CONTEXT, root),
              sessionStartContext: trace.setSpan(ROOT_CONTEXT, start),
            },
          } as unknown as JobContext;
          await sessionSpan(
            'room_connect',
            async () => {
              expect(trace.getActiveSpan()).toBe(root);
              expect(await currentSpanName()).toBe('agent_session');
            },
            { jobCtx: starting },
          );
          start.end();

          // after startup the same call parents to the ambient span
          const started = {
            _primaryAgentSession: { rootSpanContext: trace.setSpan(ROOT_CONTEXT, root) },
          } as unknown as JobContext;
          await sessionSpan('room_connect', async () => undefined, { jobCtx: started });

          const connects = spans(exporter, 'room_connect');
          expect(connects).toHaveLength(2);
          expect(connects[0]!.parentSpanContext?.spanId).toBe(start.spanContext().spanId);
          expect(connects[1]!.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
        },
        { name: 'agent_session' },
      );
    });
  });
});
