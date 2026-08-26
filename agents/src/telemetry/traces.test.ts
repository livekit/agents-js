// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionReport } from '../voice/report.js';
import { setTracerProvider, tracer, uploadSessionReport } from './traces.js';

const telemetryMocks = vi.hoisted(() => ({
  exportLogs: vi.fn(async () => {}),
  submit: vi.fn(),
}));

vi.mock('form-data', () => ({
  default: class MockFormData {
    append(): void {}

    submit(...args: unknown[]): unknown {
      return telemetryMocks.submit(...args);
    }
  },
}));

vi.mock('./otel_http_exporter.js', () => ({
  SimpleOTLPHttpLogExporter: class MockLogExporter {
    export(...args: unknown[]): Promise<void> {
      return telemetryMocks.exportLogs(...args);
    }
  },
}));

/** Helper: extract parentSpanId across OTel SDK v1/v2 */
function parentSpanId(span: unknown): string | undefined {
  return (
    (span as { parentSpanId?: string }).parentSpanId ??
    (span as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId
  );
}

describe('DynamicTracer', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    setTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    otelContext.disable();
    trace.disable();
  });

  it('inherits the active OTel context as parent when no explicit context is passed', async () => {
    const outerTracer = provider.getTracer('test');

    await outerTracer.startActiveSpan('outer', async (outer) => {
      const child = tracer.startSpan({ name: 'child' });
      child.end();
      outer.end();
    });

    const spans = exporter.getFinishedSpans();
    const outerSpan = spans.find((s) => s.name === 'outer');
    const childSpan = spans.find((s) => s.name === 'child');

    expect(outerSpan).toBeDefined();
    expect(childSpan).toBeDefined();
    expect(parentSpanId(childSpan)).toBe(outerSpan!.spanContext().spanId);
  });
});

describe('register() set-once semantics', () => {
  let userExporter: InMemorySpanExporter;
  let userProvider: NodeTracerProvider;
  let cloudExporter: InMemorySpanExporter;
  let cloudProvider: NodeTracerProvider;

  beforeEach(() => {
    // Step 1: User registers their own provider (simulates NodeSDK.start())
    userExporter = new InMemorySpanExporter();
    userProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(userExporter)],
    });
    userProvider.register();

    // Step 2: LiveKit cloud calls register() + setTracerProvider() (simulates setupCloudTracer)
    cloudExporter = new InMemorySpanExporter();
    cloudProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(cloudExporter)],
    });
    cloudProvider.register(); // should be a no-op since user already registered
    setTracerProvider(cloudProvider); // sets LiveKit's internal DynamicTracer
  });

  afterEach(async () => {
    await userProvider.shutdown();
    await cloudProvider.shutdown();
    otelContext.disable();
    trace.disable();
  });

  it('second register() does not replace the global context manager', () => {
    // Create a span via the global provider and verify context propagation still works
    const globalTracer = trace.getTracer('test-global');
    let contextWorks = false;

    globalTracer.startActiveSpan('test', (span) => {
      const active = trace.getSpan(otelContext.active());
      contextWorks = active === span;
      span.end();
    });

    expect(contextWorks).toBe(true);
  });

  it('spans from global tracer land in user exporter, not cloud exporter', () => {
    const globalTracer = trace.getTracer('test-global');
    globalTracer.startActiveSpan('global-span', (span) => {
      span.end();
    });

    expect(userExporter.getFinishedSpans().map((s) => s.name)).toContain('global-span');
    expect(cloudExporter.getFinishedSpans().map((s) => s.name)).not.toContain('global-span');
  });

  it('LiveKit DynamicTracer spans land in cloud exporter', () => {
    const lkSpan = tracer.startSpan({ name: 'agent_session' });
    lkSpan.end();

    expect(cloudExporter.getFinishedSpans().map((s) => s.name)).toContain('agent_session');
  });

  it('LiveKit span inherits user parent context across providers', () => {
    const userTracer = userProvider.getTracer('user-app');

    userTracer.startActiveSpan('user-parent', (parent) => {
      // LiveKit creates a child span via its DynamicTracer
      const lkSpan = tracer.startSpan({ name: 'agent_session' });
      lkSpan.end();
      parent.end();
    });

    const userSpans = userExporter.getFinishedSpans();
    const cloudSpans = cloudExporter.getFinishedSpans();

    const userParent = userSpans.find((s) => s.name === 'user-parent')!;
    const lkSession = cloudSpans.find((s) => s.name === 'agent_session')!;

    expect(userParent).toBeDefined();
    expect(lkSession).toBeDefined();

    // Same trace ID — they're part of the same distributed trace
    expect(lkSession.spanContext().traceId).toBe(userParent.spanContext().traceId);

    // LK span is a child of the user's parent span
    expect(parentSpanId(lkSession)).toBe(userParent.spanContext().spanId);
  });
});

type SubmitCallback = (error: Error | null, response?: MockResponse) => void;

class MockRequest extends EventEmitter {
  callback?: SubmitCallback;

  destroy(error?: Error): this {
    if (error) queueMicrotask(() => this.callback?.(error));
    return this;
  }
}

class MockResponse extends EventEmitter {
  statusCode: number;
  statusMessage: string;

  constructor(statusCode = 200, statusMessage = 'OK') {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
  }

  destroy(error?: Error): this {
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

function mockReport(): SessionReport {
  return {
    roomId: 'room-id',
    jobId: 'job-id',
    room: 'room-name',
    timestamp: 1,
    startedAt: 1,
    options: {},
    chatHistory: {
      items: [],
      toJSON: () => ({ items: [] }),
    },
  } as unknown as SessionReport;
}

function submission(
  callback: SubmitCallback,
  action: (request: MockRequest, callback: SubmitCallback) => void,
): MockRequest {
  const request = new MockRequest();
  request.callback = callback;
  queueMicrotask(() => action(request, callback));
  return request;
}

function respond(callback: SubmitCallback, statusCode = 200, body = Buffer.alloc(0)): void {
  const response = new MockResponse(statusCode, statusCode < 400 ? 'OK' : 'Service Unavailable');
  callback(null, response);
  queueMicrotask(() => {
    if (body.length > 0) response.emit('data', body);
    response.emit('end');
  });
}

function retryInfoBody(): Buffer {
  const typeUrl = Buffer.from('type.googleapis.com/google.rpc.RetryInfo');
  const retryInfo = Buffer.from([0x0a, 0x00]);
  const any = Buffer.concat([
    Buffer.from([0x0a, typeUrl.length]),
    typeUrl,
    Buffer.from([0x12, retryInfo.length]),
    retryInfo,
  ]);
  return Buffer.concat([Buffer.from([0x1a, any.length]), any]);
}

function networkError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function upload(): Promise<void> {
  await uploadSessionReport({
    agentName: 'test-agent',
    cloudHostname: 'cloud.example.com',
    report: mockReport(),
  });
}

describe('uploadSessionReport retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('LIVEKIT_API_KEY', 'api-key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'api-secret');
    telemetryMocks.submit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('uses upload-scoped extended total and connection timeouts', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    telemetryMocks.submit.mockImplementation((_options: unknown, callback: SubmitCallback) =>
      submission(callback, (request, cb) => {
        const socket = Object.assign(new EventEmitter(), {
          connecting: true,
          secureConnecting: true,
        });
        request.emit('socket', socket);
        socket.emit('secureConnect');
        respond(cb);
      }),
    );

    await upload();

    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 30_000)).toBe(true);
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 900_000)).toBe(true);
  });

  it.each([
    ['connection timeout', 'ETIMEDOUT'],
    ['connection failure', 'ECONNREFUSED'],
  ])('retries %s', async (_name, code) => {
    telemetryMocks.submit
      .mockImplementationOnce((_options: unknown, callback: SubmitCallback) =>
        submission(callback, (_request, cb) => cb(networkError(code))),
      )
      .mockImplementationOnce((_options: unknown, callback: SubmitCallback) =>
        submission(callback, (_request, cb) => respond(cb)),
      );

    const uploading = upload();
    await vi.runAllTimersAsync();
    await uploading;

    expect(telemetryMocks.submit).toHaveBeenCalledTimes(2);
  });

  it('retries a response with RetryInfo', async () => {
    telemetryMocks.submit
      .mockImplementationOnce((_options: unknown, callback: SubmitCallback) =>
        submission(callback, (_request, cb) => respond(cb, 503, retryInfoBody())),
      )
      .mockImplementationOnce((_options: unknown, callback: SubmitCallback) =>
        submission(callback, (_request, cb) => respond(cb)),
      );

    const uploading = upload();
    await vi.runAllTimersAsync();
    await uploading;

    expect(telemetryMocks.submit).toHaveBeenCalledTimes(2);
  });

  it('does not retry a response without RetryInfo', async () => {
    telemetryMocks.submit.mockImplementation((_options: unknown, callback: SubmitCallback) =>
      submission(callback, (_request, cb) => respond(cb, 503)),
    );

    await expect(upload()).rejects.toThrow('503 Service Unavailable');
    expect(telemetryMocks.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['total timeout', 'post-send disconnect', 'TLS failure'])(
    'does not retry %s',
    async (failure) => {
      telemetryMocks.submit.mockImplementation((_options: unknown, callback: SubmitCallback) =>
        submission(callback, (request, cb) => {
          if (failure === 'total timeout') {
            const socket = Object.assign(new EventEmitter(), {
              connecting: false,
              secureConnecting: false,
            });
            request.emit('socket', socket);
            return;
          }
          if (failure === 'post-send disconnect') {
            const socket = Object.assign(new EventEmitter(), {
              connecting: false,
              secureConnecting: false,
            });
            request.emit('socket', socket);
            cb(networkError('ECONNRESET', 'response lost'));
            return;
          }
          cb(networkError('CERT_HAS_EXPIRED', 'TLS failed'));
        }),
      );

      const uploading = upload();
      const rejection = expect(uploading).rejects.toThrow();
      if (failure === 'total timeout') await vi.advanceTimersByTimeAsync(900_000);

      await rejection;
      expect(telemetryMocks.submit).toHaveBeenCalledTimes(1);
    },
  );

  it('stops after connection retries are exhausted', async () => {
    telemetryMocks.submit.mockImplementation((_options: unknown, callback: SubmitCallback) =>
      submission(callback, (_request, cb) => cb(networkError('ETIMEDOUT', 'connection timed out'))),
    );

    const uploading = upload();
    const rejection = expect(uploading).rejects.toThrow('connection timed out');
    await vi.runAllTimersAsync();
    await rejection;

    expect(telemetryMocks.submit).toHaveBeenCalledTimes(4);
  });
});
