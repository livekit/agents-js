// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError, DEFAULT_API_CONNECT_OPTIONS, stt } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt as testStt } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STT } from './stt.js';

const hasCartesiaApiKey = Boolean(process.env.CARTESIA_API_KEY);

const swallowExpectedRejection = (reason: unknown) => {
  if (reason instanceof APIError) return;
  throw reason;
};
beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

describe('Cartesia STT capabilities', () => {
  it('reports no aligned transcript for Ink-2', () => {
    const instance = new STT({ apiKey: 'test-key', model: 'ink-2' });

    expect(instance.capabilities.alignedTranscript).toBe(false);
  });
});

describe('Cartesia STT connection errors', () => {
  it('does not retain synchronous WebSocket connection errors', async () => {
    const secret = 'cartesia-secret-api-key-do-not-log';
    const cartesia = new STT({ apiKey: 'test-key', baseUrl: `http://[${secret}` });
    const errorEvent = once(cartesia, 'error') as Promise<Parameters<stt.STTCallbacks['error']>>;
    const stream = cartesia.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
    });
    const drain = (async () => {
      for await (const _ of stream) {
        // discard events
      }
    })();

    try {
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIConnectionError);
      expect(error.message).toBe('SyntaxError');
      expect(error.message).not.toContain(secret);
      expect(error.toString()).not.toContain(secret);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      stream.close();
      await drain.catch(() => {});
      // Let SpeechStream.mainTask's expected rejection reach the file-level handler.
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});

if (hasCartesiaApiKey) {
  describe('Cartesia STT', async () => {
    await testStt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Cartesia STT', () => {
    it.skip('requires CARTESIA_API_KEY', () => {});
  });
}
