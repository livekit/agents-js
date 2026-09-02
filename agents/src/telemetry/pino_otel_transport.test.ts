// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
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
      cloudHostname: 'example.livekit.cloud',
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exporter = new PinoCloudExporter({
      cloudHostname: 'example.livekit.cloud',
      roomId: 'room1',
      jobId: 'job1',
    });

    exporter.emit({ level: 30, time: 0, msg: 'record' });
    await exporter.flush();

    expect(consoleError).toHaveBeenCalledWith(
      '[PinoCloudExporter] Failed to flush logs:',
      expect.objectContaining({ message: 'Log export failed: status 500' }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret customer response');
  });
});
