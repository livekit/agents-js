// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * RPC tracing (`telemetry.rpc`).
 *
 * The interceptor is exercised directly with fake `next` continuations, so these tests run
 * against any `@livekit/rtc-node` version. With an SDK that has `RpcInterceptor` support the
 * same interceptor is what `install` registers on the local participant; without it, `install`
 * is a no-op, which is also covered.
 */
import {
  type LocalParticipant,
  type RpcCallInfo,
  RpcError,
  type RpcInvocationData,
} from '@livekit/rtc-node';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, getJobContext, runWithJobContext } from '../job.js';
import {
  MAX_PAYLOAD_ATTR_LEN,
  TracingRpcInterceptor,
  install,
  interceptor as singleton,
} from './rpc.js';
import * as traceTypes from './trace_types.js';
import { setTracerProvider, tracer } from './traces.js';

function call(overrides: Partial<RpcCallInfo> = {}): RpcCallInfo {
  return {
    destinationIdentity: 'avatar-1',
    method: 'playback.start',
    payload: '{"id": 7}',
    responseTimeout: 5000,
    ...overrides,
  };
}

function invocation(overrides: Partial<RpcInvocationData> = {}): RpcInvocationData {
  return {
    requestId: 'req-42',
    callerIdentity: 'client-9',
    payload: '{"q": "x"}',
    responseTimeout: 10_000,
    method: 'agent.lookup',
    ...overrides,
  };
}

function fakeParticipant(addRpcInterceptor: (i: unknown) => void): LocalParticipant {
  return { identity: 'agent', addRpcInterceptor } as unknown as LocalParticipant;
}

describe.sequential('rpc tracing', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;
  let interceptor: TracingRpcInterceptor;

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    // the context manager, so a span made active in the test is the parent of the RPC span
    provider.register();
    setTracerProvider(provider);
    interceptor = new TracingRpcInterceptor();
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    await provider.shutdown();
    otelContext.disable();
    trace.disable();
    vi.restoreAllMocks();
  });

  function spans(name: string) {
    return exporter.getFinishedSpans().filter((span) => span.name === name);
  }

  it('nests the outgoing call span under the caller', async () => {
    let parentSpanId = '';
    const result = await tracer.startActiveSpan(
      async (parent) => {
        parentSpanId = parent.spanContext().spanId;
        return interceptor.interceptOutgoing(call(), async () => 'ok!');
      },
      { name: 'function_tool' },
    );

    expect(result).toBe('ok!');
    const [span] = spans('rpc_call');
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(span!.attributes).toMatchObject({
      [traceTypes.ATTR_RPC_METHOD]: 'playback.start',
      [traceTypes.ATTR_RPC_DESTINATION_IDENTITY]: 'avatar-1',
      [traceTypes.ATTR_RPC_PAYLOAD]: '{"id": 7}',
      [traceTypes.ATTR_RPC_PAYLOAD_SIZE]: 9,
      [traceTypes.ATTR_RPC_RESPONSE]: 'ok!',
      [traceTypes.ATTR_RPC_RESPONSE_SIZE]: 3,
      [traceTypes.ATTR_RPC_RESPONSE_TIMEOUT]: 5, // seconds on the span, ms in the SDK
    });
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records the code and error status of a failed outgoing call', async () => {
    const error = RpcError.builtIn('RECIPIENT_NOT_FOUND');
    await expect(
      interceptor.interceptOutgoing(call(), async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    const [span] = spans('rpc_call');
    expect(span!.attributes[traceTypes.ATTR_RPC_ERROR_CODE]).toBe(
      RpcError.ErrorCode.RECIPIENT_NOT_FOUND,
    );
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.events.some((event) => event.name === 'exception')).toBe(true);
  });

  it('truncates the payload and keeps its size', async () => {
    const payload = 'x'.repeat(MAX_PAYLOAD_ATTR_LEN + 500);
    await interceptor.interceptOutgoing(
      call({ payload, responseTimeout: undefined }),
      async () => '',
    );

    const [span] = spans('rpc_call');
    const attrs = span!.attributes;
    expect((attrs[traceTypes.ATTR_RPC_PAYLOAD] as string).length).toBe(MAX_PAYLOAD_ATTR_LEN);
    expect(attrs[traceTypes.ATTR_RPC_PAYLOAD_SIZE]).toBe(payload.length);
    expect(attrs).not.toHaveProperty(traceTypes.ATTR_RPC_RESPONSE_TIMEOUT);
    expect(attrs[traceTypes.ATTR_RPC_RESPONSE_SIZE]).toBe(0);
    expect(attrs).not.toHaveProperty(traceTypes.ATTR_RPC_RESPONSE); // empty: not recorded
  });

  it('truncates the response like the request', async () => {
    const response = 'y'.repeat(MAX_PAYLOAD_ATTR_LEN + 10);
    await interceptor.interceptIncoming(invocation(), async () => response);

    const [span] = spans('rpc_handler');
    expect((span!.attributes[traceTypes.ATTR_RPC_RESPONSE] as string).length).toBe(
      MAX_PAYLOAD_ATTR_LEN,
    );
    expect(span!.attributes[traceTypes.ATTR_RPC_RESPONSE_SIZE]).toBe(response.length);
  });

  it('measures payload sizes in bytes, not characters', async () => {
    await interceptor.interceptOutgoing(call({ payload: 'héllo' }), async () => '');
    const [span] = spans('rpc_call');
    expect(span!.attributes[traceTypes.ATTR_RPC_PAYLOAD_SIZE]).toBe(6);
  });

  it('traces an incoming invocation as a server span', async () => {
    const result = await interceptor.interceptIncoming(invocation(), async () => 'found');

    expect(result).toBe('found');
    const [span] = spans('rpc_handler');
    expect(span!.kind).toBe(SpanKind.SERVER);
    expect(span!.attributes).toMatchObject({
      [traceTypes.ATTR_RPC_METHOD]: 'agent.lookup',
      [traceTypes.ATTR_RPC_REQUEST_ID]: 'req-42',
      [traceTypes.ATTR_RPC_CALLER_IDENTITY]: 'client-9',
      [traceTypes.ATTR_RPC_RESPONSE_TIMEOUT]: 10,
      [traceTypes.ATTR_RPC_RESPONSE]: 'found',
      [traceTypes.ATTR_RPC_RESPONSE_SIZE]: 5,
    });
  });

  it('parents the handler span to the primary session root, not the dispatching task', async () => {
    const sessionRoot = tracer.startSpan({ name: 'agent_session' });
    const job = {
      _primaryAgentSession: { rootSpanContext: trace.setSpan(ROOT_CONTEXT, sessionRoot) },
      job: { id: 'AJ_test' },
    } as unknown as JobContext;

    await tracer.startActiveSpan(
      () =>
        runWithJobContext(job, () => interceptor.interceptIncoming(invocation(), async () => '')),
      { name: 'sdk_dispatch_task' },
    );
    sessionRoot.end();

    const [span] = spans('rpc_handler');
    expect(span!.parentSpanContext?.spanId).toBe(sessionRoot.spanContext().spanId);
  });

  it('parents the handler span to the job root when no session is running', async () => {
    const jobRoot = tracer.startSpan({ name: 'job_entrypoint' });
    const job = {
      _jobSpanContext: trace.setSpan(ROOT_CONTEXT, jobRoot),
      job: { id: 'AJ_test' },
    } as unknown as JobContext;

    await tracer.startActiveSpan(
      () =>
        runWithJobContext(job, () => interceptor.interceptIncoming(invocation(), async () => '')),
      { name: 'sdk_dispatch_task' },
    );
    jobRoot.end();

    const [span] = spans('rpc_handler');
    expect(span!.parentSpanContext?.spanId).toBe(jobRoot.spanContext().spanId);
  });

  it('records the error code of a handler that throws an RpcError', async () => {
    const error = RpcError.builtIn('APPLICATION_ERROR');
    await expect(
      interceptor.interceptIncoming(invocation(), async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    const [span] = spans('rpc_handler');
    expect(span!.attributes[traceTypes.ATTR_RPC_ERROR_CODE]).toBe(
      RpcError.ErrorCode.APPLICATION_ERROR,
    );
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records a handler exception', async () => {
    const boom = new Error('bad request body');
    await expect(
      interceptor.interceptIncoming(invocation(), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const [span] = spans('rpc_handler');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes).not.toHaveProperty(traceTypes.ATTR_RPC_ERROR_CODE);
  });

  it('restores the installed job for invocations dispatched outside its context', async () => {
    // the SDK's FFI event path carries no AsyncLocalStorage: without the job captured at
    // install, neither the session root nor the job root would resolve and the handler span
    // would be a root of its own
    const sessionRoot = tracer.startSpan({ name: 'agent_session' });
    const job = {
      _primaryAgentSession: { rootSpanContext: trace.setSpan(ROOT_CONTEXT, sessionRoot) },
      job: { id: 'AJ_test' },
    } as unknown as JobContext;
    install(fakeParticipant(vi.fn()), job);

    let seenJob: JobContext | undefined;
    await interceptor.interceptIncoming(invocation(), async () => {
      seenJob = getJobContext(false);
      return '';
    });
    sessionRoot.end();

    const [span] = spans('rpc_handler');
    expect(span!.parentSpanContext?.spanId).toBe(sessionRoot.spanContext().spanId);
    expect(seenJob).toBe(job); // the handler itself runs inside the job too
  });

  it('installs the one interceptor once per participant', () => {
    const addRpcInterceptor = vi.fn();
    const participant = fakeParticipant(addRpcInterceptor);
    install(participant);
    install(participant);
    // the same singleton each time: the SDK keeps one registration per instance
    expect(addRpcInterceptor).toHaveBeenCalledTimes(2);
    expect(addRpcInterceptor.mock.calls[0]![0]).toBe(singleton);
    expect(addRpcInterceptor.mock.calls[1]![0]).toBe(singleton);

    // no participant yet (the room is not connected): nothing to install on
    expect(() => install(undefined)).not.toThrow();
  });
});
