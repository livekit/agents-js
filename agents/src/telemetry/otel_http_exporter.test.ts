// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnDetector } from '../inference/eot/detector.js';
import { SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';

describe('SimpleOTLPHttpLogExporter attribute conversion', () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.LIVEKIT_API_KEY = 'APIsecretkey123';
    process.env.LIVEKIT_API_SECRET = 'topsecretvalue456';
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  /** Capture the JSON body sent to the OTLP endpoint by the most recent export. */
  function sentPayload(): string {
    const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    return String(init?.body);
  }

  async function exportAttributes(attributes: Record<string, unknown>): Promise<string> {
    const exporter = new SimpleOTLPHttpLogExporter({
      cloudHostname: 'cloud.example.com',
      resourceAttributes: {},
      scopeName: 'test',
    });
    await exporter.export([{ body: 'rec', timestampMs: 0, attributes }]);
    return sentPayload();
  }

  it('honors toJSON() so objects can redact fields at the wire boundary', async () => {
    const value = {
      safe: 'visible',
      toJSON: () => ({ safe: 'visible' }),
      secret: 'do-not-emit',
    };
    const payload = await exportAttributes({ value });
    expect(payload).toContain('visible');
    expect(payload).not.toContain('do-not-emit');
  });

  it('redacts live TurnDetector credentials embedded in session options', async () => {
    process.env.LIVEKIT_INFERENCE_URL = 'ws://gateway';
    delete process.env.LIVEKIT_INFERENCE_API_KEY;
    delete process.env.LIVEKIT_INFERENCE_API_SECRET;

    const turnDetection = new TurnDetector({ version: 'v1' });
    const payload = await exportAttributes({
      'session.options': { turnHandling: { turnDetection } },
    });

    expect(payload).not.toContain('APIsecretkey123');
    expect(payload).not.toContain('topsecretvalue456');
    expect(payload).toContain('turn-detector-v1');
    expect(payload).toContain('ws://gateway');
  });
});
