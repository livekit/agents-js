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

  it('exports sensitive content as a redactable attribute instead of log body text', async () => {
    initializeLogger({ pretty: false, level: 'info' });
    const emitSpy = vi.spyOn(PinoCloudExporter.prototype, 'emit').mockImplementation(() => {});

    initPinoCloudExporter({
      cloudHostname: 'example.livekit.cloud',
      roomId: 'RM_test',
      jobId: 'AJ_test',
    });
    enableOtelLogging();

    log().info({ 'lk.pii.user_input': 'secret transcript' }, 'received user input');

    await vi.waitFor(() => {
      const record = emitSpy.mock.calls
        .map(([logObj]) => logObj)
        .find((logObj) => {
          return logObj.msg === 'received user input';
        });
      expect(record).toMatchObject({
        msg: 'received user input',
        'lk.pii.user_input': 'secret transcript',
      });
      expect(record?.msg).not.toContain('secret transcript');
    });
  });

  it('keeps operational errors, reasons, and framework URLs in non-PII fields', async () => {
    initializeLogger({ pretty: false, level: 'info' });
    const emitSpy = vi.spyOn(PinoCloudExporter.prototype, 'emit').mockImplementation(() => {});

    initPinoCloudExporter({
      cloudHostname: 'example.livekit.cloud',
      roomId: 'RM_test',
      jobId: 'AJ_test',
    });
    enableOtelLogging();

    log().error({ error: new Error('connection failed') }, 'provider failed');
    log().warn({ reason: 'remote close' }, 'provider disconnected');
    log().info({ baseUrl: 'wss://example.livekit.cloud' }, 'connecting to framework');

    await vi.waitFor(() => {
      const records = emitSpy.mock.calls.map(([logObj]) => logObj);
      const errorRecord = records.find((logObj) => logObj.msg === 'provider failed');
      expect(errorRecord).toMatchObject({
        msg: 'provider failed',
        error: {
          type: 'Error',
          message: 'connection failed',
        },
      });
      expect(errorRecord).not.toHaveProperty('lk.pii.error');

      const reasonRecord = records.find((logObj) => logObj.msg === 'provider disconnected');
      expect(reasonRecord).toMatchObject({
        msg: 'provider disconnected',
        reason: 'remote close',
      });
      expect(reasonRecord).not.toHaveProperty('lk.pii.reason');

      const connectionRecord = records.find((logObj) => logObj.msg === 'connecting to framework');
      expect(connectionRecord).toMatchObject({
        msg: 'connecting to framework',
        baseUrl: 'wss://example.livekit.cloud',
      });
      expect(connectionRecord).not.toHaveProperty('lk.pii.base_url');
    });
  });
});
