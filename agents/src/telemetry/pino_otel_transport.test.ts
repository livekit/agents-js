// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinoCloudExporter } from './pino_otel_transport.js';
import { uploadGate } from './upload_gate.js';

describe('PinoCloudExporter flush', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
    uploadGate.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    uploadGate.reset();
  });

  it('waits for an in-flight flush and drains logs queued behind it', async () => {
    let resolveFirstRequest!: (response: Response) => void;
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const exporter = new PinoCloudExporter({
      observabilityUrl: 'https://example.livekit.cloud',
      roomId: 'room1',
      jobId: 'job1',
    });

    exporter.emit({ level: 30, time: 0, msg: 'first' });
    const firstFlush = exporter.flush();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    exporter.emit({ level: 30, time: 1, msg: 'second' });
    let finalFlushSettled = false;
    const finalFlush = exporter.flush().then(() => {
      finalFlushSettled = true;
    });
    await Promise.resolve();

    expect(finalFlushSettled).toBe(false);

    resolveFirstRequest(new Response('{}', { status: 200 }));
    await Promise.all([firstFlush, finalFlush]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain('first');
    expect(String(fetchSpy.mock.calls[1]?.[1]?.body)).toContain('second');
  });

  it('does not print response bodies when a flush fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('secret customer response', { status: 500 }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exporter = new PinoCloudExporter({
      observabilityUrl: 'https://example.livekit.cloud',
      roomId: 'room1',
      jobId: 'job1',
    });

    exporter.emit({ level: 30, time: 0, msg: 'record' });
    await exporter.flush();

    const record = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(record.msg).toBe('[PinoCloudExporter] Failed to flush logs');
    expect(record.error.message).toBe('Log export failed: status 500');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('secret customer response');
  });
});

describe('exception log redaction', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    uploadGate.reset();
  });

  it.each([true, false])(
    'keeps exception details out of messages (redaction=%s)',
    async (redacted) => {
      process.env.LIVEKIT_API_KEY = 'devkey';
      process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
      const secret = 'provider rejected canary@example.com';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));
      const exporter = new PinoCloudExporter({
        observabilityUrl: 'https://example.livekit.cloud',
        roomId: 'room1',
        jobId: 'job1',
        metadata: { 'lk.redaction.enabled': redacted },
      });
      const logger = pino(
        { serializers: { error: pino.stdSerializers.err } },
        {
          write: (line) => exporter.emit(JSON.parse(line)),
        },
      );
      for (const error of [new Error(secret), secret, { message: secret }, { detail: secret }]) {
        logger.error({ error }, 'provider failed');
      }
      await exporter.flush();
      const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      const records = body.resourceLogs[0].scopeLogs[0].logRecords;
      expect(records).toHaveLength(4);
      for (const record of records) {
        expect(record.body.stringValue).toBe('provider failed');
        expect(JSON.stringify(record).includes(secret)).toBe(!redacted);
        if (redacted) expect(JSON.stringify(record)).toContain('exception details redacted');
      }
    },
  );
});
