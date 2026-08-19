// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableOtelLogging, initializeLogger, log } from './log.js';
import {
  PinoCloudExporter,
  flushPinoLogs,
  initPinoCloudExporter,
} from './telemetry/pino_otel_transport.js';
import { REDACTED_EXCEPTION_MESSAGE } from './telemetry/utils.js';

const OTEL_ENABLED_KEY = Symbol.for('@livekit/agents:otelEnabled');

function resetOtelLoggingState() {
  delete (globalThis as Record<symbol, unknown>)[OTEL_ENABLED_KEY];
  initializeLogger({ pretty: false, level: 'silent' });
}

describe('OTEL logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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

  it('keeps operational errors, reasons, framework URLs, and resource IDs in non-PII fields', async () => {
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
    log().info({ avatarId: 'avatar-123' }, 'avatar session started');

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

      const avatarRecord = records.find((logObj) => logObj.msg === 'avatar session started');
      expect(avatarRecord).toMatchObject({
        msg: 'avatar session started',
        avatarId: 'avatar-123',
      });
      expect(avatarRecord).not.toHaveProperty('lk.pii.avatar_id');
    });
  });

  it.each([
    ['error', false],
    ['error', true],
    ['err', false],
    ['err', true],
  ] as const)(
    'redacts serialized %s details when redaction is %s',
    async (exceptionKey, redactionEnabled) => {
      vi.stubEnv('LIVEKIT_API_KEY', 'devkey');
      vi.stubEnv('LIVEKIT_API_SECRET', 'secret');
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      initializeLogger({ pretty: false, level: 'info' });

      initPinoCloudExporter({
        cloudHostname: 'example.livekit.cloud',
        roomId: 'RM_test',
        jobId: 'AJ_test',
        metadata: { 'lk.redaction.enabled': redactionEnabled },
      });
      enableOtelLogging();

      const exception = new Error('secret transcript', {
        cause: new Error('secret nested cause'),
      }) as Error & { body: unknown };
      exception.body = { transcript: 'secret provider payload' };
      log().error({ [exceptionKey]: exception }, 'provider failed');
      await flushPinoLogs();

      expect(fetchMock).toHaveBeenCalledOnce();
      const requestBody = fetchMock.mock.calls[0]![1].body as string;
      const payload = JSON.parse(requestBody) as {
        resourceLogs: Array<{
          scopeLogs: Array<{
            logRecords: Array<{
              attributes: Array<{ key: string; value: { stringValue?: string } }>;
            }>;
          }>;
        }>;
      };
      const attributes = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes;
      const serializedError = attributes.find(({ key }) => key === exceptionKey)?.value.stringValue;
      expect(serializedError).toBeDefined();
      const error = JSON.parse(serializedError!) as Record<string, unknown>;

      if (redactionEnabled) {
        expect(error).toEqual({
          type: 'Error',
          message: REDACTED_EXCEPTION_MESSAGE,
        });
        expect(requestBody).not.toContain('secret transcript');
        expect(requestBody).not.toContain('secret nested cause');
        expect(requestBody).not.toContain('secret provider payload');
      } else {
        expect(error.message).toContain('secret transcript');
        expect(error.message).toContain('secret nested cause');
        expect(error.stack).toContain('secret transcript');
        expect(error.body).toEqual({ transcript: 'secret provider payload' });
      }
    },
  );
});
