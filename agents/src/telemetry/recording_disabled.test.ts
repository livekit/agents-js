// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import FormData from 'form-data';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger, log } from '../log.js';
import type { SessionReport } from '../voice/report.js';
import { SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';
import { PinoCloudExporter } from './pino_otel_transport.js';
import { setTracerProvider, tracer, uploadSessionReport } from './traces.js';
import { UploadGateTraceExporter, fetchWithUploadGate, uploadGate } from './upload_gate.js';

const DISABLED_MSG = 'project data recording is disabled by owner';

function statusProto(message: string): Buffer {
  return Buffer.concat([Buffer.from([0x08, 0x07, 0x12, message.length]), Buffer.from(message)]);
}

function makeReport(recordingOptions: SessionReport['options']['recordingOptions']): SessionReport {
  return {
    jobId: 'job1',
    roomId: 'room1',
    room: 'room-name',
    options: { recordingOptions },
    events: [],
    chatHistory: ChatContext.empty(),
    enableRecording: true,
    startedAt: 1_700_000_000_000,
    timestamp: 1_700_000_001_000,
  };
}

function mockFormSubmit(statusCode: number, body: Buffer = Buffer.alloc(0)) {
  return vi.spyOn(FormData.prototype, 'submit').mockImplementation(function submit(_opts, cb) {
    const res = new PassThrough() as PassThrough & {
      statusCode: number;
      statusMessage: string;
      resume: () => PassThrough;
    };
    res.statusCode = statusCode;
    res.statusMessage = statusCode < 400 ? 'OK' : 'Unauthorized';
    res.resume = () => {
      return res;
    };
    setImmediate(() => {
      if (body.length > 0) res.emit('data', body);
      res.emit('end');
    });
    cb?.(null, res as never);
    return {} as never;
  });
}

async function createTraceHarness(
  responseForRequest: (
    requestCount: number,
  ) => { status: number; body: string } | Promise<{ status: number; body: string }>,
) {
  let requestCount = 0;
  const server = http.createServer(async (_request, response) => {
    requestCount += 1;
    const { status, body } = await responseForRequest(requestCount);
    response.statusCode = status;
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('missing server address');

  const url = `http://127.0.0.1:${address.port}/observability/traces/otlp/v0`;
  const exporter = new UploadGateTraceExporter({ url, headers: {} });
  const resultPromises: Promise<ExportResult>[] = [];
  const processor: SpanProcessor = {
    onStart: () => undefined,
    onEnd: (span: ReadableSpan) => {
      resultPromises.push(
        new Promise<ExportResult>((resolve) => {
          exporter.export([span], resolve);
        }),
      );
    },
    forceFlush: async () => {
      await Promise.all(resultPromises);
      await exporter.forceFlush();
    },
    shutdown: async () => {
      await exporter.shutdown();
    },
  };
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  setTracerProvider(provider);

  return {
    exportSpan: async (name: string) => {
      const span = tracer.startSpan({ name });
      span.end();
      const result = resultPromises.at(-1);
      if (!result) throw new Error('trace processor did not export the span');
      return result;
    },
    requestCount: () => requestCount,
    close: async () => {
      await provider.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('recording disabled upload gate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    initializeLogger({ pretty: false, level: 'silent' });
    uploadGate.reset();
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
  });

  afterEach(() => {
    uploadGate.reset();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it.each([
    [401, statusProto(DISABLED_MSG), true],
    [401, Buffer.from(DISABLED_MSG), true],
    [403, statusProto(DISABLED_MSG), false],
    [200, statusProto(DISABLED_MSG), false],
    [500, statusProto(DISABLED_MSG), false],
    [401, statusProto('missing project id'), false],
    [401, statusProto('operation requires observability write grant'), false],
    [401, Buffer.alloc(0), false],
  ])('detects only the LiveKit Cloud recording-disabled response', (statusCode, body, expected) => {
    expect(uploadGate.isDisabledResponse(statusCode, body)).toBe(expected);
  });

  it('returns a synthetic ok response once uploads are disabled', async () => {
    vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    uploadGate.disable();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await fetchWithUploadGate('https://example.com');

    expect(response.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warns through the configured logger once per session', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    uploadGate.disable();
    uploadGate.disable();

    expect(uploadGate.disabled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).not.toHaveBeenCalled();

    uploadGate.reset();
    uploadGate.disable();

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns once when disabled concurrently', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    await Promise.all(
      Array.from({ length: 32 }, () => Promise.resolve().then(() => uploadGate.disable())),
    );

    expect(uploadGate.disabled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('log exporter latches and then short-circuits uploads', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(statusProto(DISABLED_MSG), { status: 401 }));
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const exporter = new SimpleOTLPHttpLogExporter({
      cloudHostname: 'example.livekit.cloud',
      resourceAttributes: {},
      scopeName: 'test',
    });

    await exporter.export([{ body: 'rec', timestampMs: 0, attributes: {} }]);
    await exporter.export([{ body: 'rec', timestampMs: 1, attributes: {} }]);

    expect(uploadGate.disabled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('log exporter passes through success and unrelated errors', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('invalid token', { status: 401 }));
    const exporter = new SimpleOTLPHttpLogExporter({
      cloudHostname: 'example.livekit.cloud',
      resourceAttributes: {},
      scopeName: 'test',
    });

    await exporter.export([{ body: 'rec', timestampMs: 0, attributes: {} }]);
    await expect(
      exporter.export([{ body: 'rec', timestampMs: 1, attributes: {} }]),
    ).rejects.toThrow('OTLP log export failed: 401');

    expect(uploadGate.disabled).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('pino exporter latches and then short-circuits uploads', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(statusProto(DISABLED_MSG), { status: 401 }));
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const exporter = new PinoCloudExporter({
      cloudHostname: 'example.livekit.cloud',
      roomId: 'room1',
      jobId: 'job1',
    });

    exporter.emit({ level: 30, time: 0, msg: 'first' });
    await exporter.flush();
    exporter.emit({ level: 30, time: 1, msg: 'second' });
    await exporter.flush();

    expect(uploadGate.disabled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('recording upload latches disabled responses without throwing', async () => {
    vi.spyOn(SimpleOTLPHttpLogExporter.prototype, 'export').mockResolvedValue(undefined);
    const submitSpy = mockFormSubmit(401, statusProto(DISABLED_MSG));
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const report = makeReport({
      audio: false,
      traces: false,
      logs: false,
      transcript: true,
      redaction: false,
    });

    await uploadSessionReport({
      agentName: 'agent',
      cloudHostname: 'example.livekit.cloud',
      report,
    });
    await uploadSessionReport({
      agentName: 'agent',
      cloudHostname: 'example.livekit.cloud',
      report,
    });

    expect(uploadGate.disabled).toBe(true);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips recording upload after the log upload disables the gate', async () => {
    vi.spyOn(SimpleOTLPHttpLogExporter.prototype, 'export').mockImplementation(async () => {
      uploadGate.disable();
    });
    const submitSpy = mockFormSubmit(200);

    await uploadSessionReport({
      agentName: 'agent',
      cloudHostname: 'example.livekit.cloud',
      report: makeReport({
        audio: false,
        traces: false,
        logs: false,
        transcript: true,
        redaction: false,
      }),
    });

    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('does not let an old in-flight disabled response latch a new gate generation', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    let markFirstRequestStarted!: () => void;
    let releaseFirstResponse!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const firstResponseReleased = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const harness = await createTraceHarness(async (requestCount) => {
      if (requestCount === 1) {
        markFirstRequestStarted();
        await firstResponseReleased;
        return { status: 401, body: DISABLED_MSG };
      }
      return { status: 200, body: 'ok' };
    });

    try {
      const oldExport = harness.exportSpan('old-generation');
      await firstRequestStarted;

      uploadGate.reset();
      releaseFirstResponse();

      const oldResult = await oldExport;
      expect(oldResult.code).toBe(ExportResultCode.SUCCESS);
      expect(uploadGate.disabled).toBe(false);
      expect(warn).not.toHaveBeenCalled();

      const currentResult = await harness.exportSpan('current-generation');
      expect(currentResult.code).toBe(ExportResultCode.SUCCESS);
      expect(harness.requestCount()).toBe(2);
    } finally {
      releaseFirstResponse();
      await harness.close();
    }
  });

  it('short-circuits trace exports without patching process HTTP functions', async () => {
    vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const originalRequest = http.request;
    const harness = await createTraceHarness(() => ({
      status: 401,
      body: DISABLED_MSG,
    }));

    try {
      const first = await harness.exportSpan('first');
      const second = await harness.exportSpan('second');

      expect(http.request).toBe(originalRequest);
      expect(first.code).toBe(ExportResultCode.SUCCESS);
      expect(second.code).toBe(ExportResultCode.SUCCESS);
      expect(harness.requestCount()).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('does not suppress unrelated trace export 401 responses', async () => {
    const harness = await createTraceHarness((requestCount) =>
      requestCount === 1 ? { status: 401, body: 'invalid token' } : { status: 200, body: 'ok' },
    );

    try {
      const first = await harness.exportSpan('first');
      const second = await harness.exportSpan('second');

      expect(first.code).toBe(ExportResultCode.FAILED);
      expect(second.code).toBe(ExportResultCode.SUCCESS);
      expect(uploadGate.disabled).toBe(false);
      expect(harness.requestCount()).toBe(2);
    } finally {
      await harness.close();
    }
  });
});
