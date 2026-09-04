// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { resolveObservabilityUrl } from './observability_endpoint.js';
import { SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';

describe('observability endpoint compatibility', () => {
  beforeEach(() => {
    initializeLogger({ pretty: false, level: 'silent' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers observabilityUrl and keeps its scheme and port', () => {
    expect(resolveObservabilityUrl({ observabilityUrl: 'http://collector.internal:4318' })).toBe(
      'http://collector.internal:4318',
    );
  });

  it('resolves the deprecated cloudHostname to the https URL it used to imply', () => {
    expect(resolveObservabilityUrl({ cloudHostname: 'cloud.livekit.io' })).toBe(
      'https://cloud.livekit.io',
    );
  });

  it('throws when neither spelling is provided', () => {
    expect(() => resolveObservabilityUrl({} as never)).toThrow('observabilityUrl is required');
  });

  it('still builds a working endpoint for a caller passing cloudHostname', async () => {
    process.env.LIVEKIT_API_KEY = 'APIsecretkey123';
    process.env.LIVEKIT_API_SECRET = 'topsecretvalue456';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const exporter = new SimpleOTLPHttpLogExporter({
      cloudHostname: 'cloud.example.com',
      resourceAttributes: {},
      scopeName: 'test',
    });
    await exporter.export([{ body: 'rec', timestampMs: 0, attributes: {} }]);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://cloud.example.com/observability/logs/otlp/v0',
    );
  });
});
