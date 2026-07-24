// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import FormData from 'form-data';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import type { SessionReport } from '../voice/report.js';
import { SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';
import { uploadSessionReport } from './traces.js';
import { fetchWithUploadGate, uploadGate } from './upload_gate.js';

const DISABLED_MSG = 'project data recording is disabled by owner';

function statusProto(message: string): Buffer {
  return Buffer.concat([Buffer.from([0x08, 0x07, 0x12, message.length]), Buffer.from(message)]);
}

function makeReport(recordingOptions: SessionReport['recordingOptions']): SessionReport {
  return {
    jobId: 'job1',
    roomId: 'room1',
    room: 'room-name',
    options: {},
    events: [],
    chatHistory: ChatContext.empty(),
    enableRecording: true,
    recordingOptions,
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

describe('recording disabled upload gate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    uploadGate.disable();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await fetchWithUploadGate('https://example.com');

    expect(response.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warns once per session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    uploadGate.disable();
    uploadGate.disable();

    expect(uploadGate.disabled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    uploadGate.reset();
    uploadGate.disable();

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns once when disabled concurrently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

  it('recording upload latches disabled responses without throwing', async () => {
    vi.spyOn(SimpleOTLPHttpLogExporter.prototype, 'export').mockResolvedValue(undefined);
    const submitSpy = mockFormSubmit(401, statusProto(DISABLED_MSG));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

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
});
