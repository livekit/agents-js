// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableOtelLogging, initializeLogger, log } from './log.js';
import { PinoCloudExporter, initPinoCloudExporter } from './telemetry/pino_otel_transport.js';

const OTEL_ENABLED_KEY = Symbol.for('@livekit/agents:otelEnabled');

function resetOtelLoggingState() {
  delete (globalThis as Record<symbol, unknown>)[OTEL_ENABLED_KEY];
  initializeLogger({ pretty: false, level: 'silent' });
}

describe('OTEL logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOtelLoggingState();
  });

  it('exports logs from logger instances captured before OTEL is enabled', async () => {
    initializeLogger({ pretty: false, level: 'info' });
    const staleLogger = log().child({ capturedBeforeOtel: true });
    const emitSpy = vi.spyOn(PinoCloudExporter.prototype, 'emit').mockImplementation(() => {});

    initPinoCloudExporter({
      cloudHostname: 'example.livekit.cloud',
      roomId: 'RM_test',
      jobId: 'AJ_test',
    });
    enableOtelLogging();

    staleLogger.info('log from stale logger');
    log().info('log from fresh logger');

    await vi.waitFor(() => {
      const messages = emitSpy.mock.calls.map(([logObj]) => logObj.msg);
      expect(messages).toContain('log from stale logger');
      expect(messages).toContain('log from fresh logger');
    });
  });
});
