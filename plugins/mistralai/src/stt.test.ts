// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { VADStream } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import type { Mistral } from '@mistralai/mistralai';
import { RealtimeTranscription } from '@mistralai/mistralai/extra/realtime';
import { describe, expect, it, vi } from 'vitest';
import { STT } from './stt.js';

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral STT', { timeout: 30_000 }, async () => {
    await stt(new STT(), await VAD.load(), { streaming: false });
  });
} else {
  describe('Mistral STT', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}

describe('Mistral realtime STT provider progress', () => {
  it.each([
    ['session.created', 2],
    ['transcription.language', 0],
  ] as const)('classifies %s without a transcript', async (type, expectedRetries) => {
    const connection = {
      async *events() {
        yield type === 'transcription.language'
          ? { type, audioLanguage: 'en' }
          : { type, session: undefined };
      },
      sendAudio: vi.fn(),
      flushAudio: vi.fn(),
      endAudio: vi.fn(),
      close: vi.fn(),
    };
    const connect = vi
      .spyOn(RealtimeTranscription.prototype, 'connect')
      .mockResolvedValue(connection as never);
    const vadStream = {
      async *[Symbol.asyncIterator]() {},
      pushFrame: vi.fn(),
      close: vi.fn(),
    } as unknown as VADStream;
    const vad = { stream: () => vadStream };
    const client = { _options: {} } as unknown as Mistral;
    const provider = new STT({
      model: 'voxtral-mini-transcribe-realtime-2602',
      client,
      vad: vad as never,
    });
    const stream = provider.stream();
    const internal = stream as unknown as { _numRetries: number };
    internal._numRetries = 2;
    stream.endInput();

    try {
      for await (const _event of stream) {
        // Drain the stream.
      }
      expect(internal._numRetries).toBe(expectedRetries);
    } finally {
      connect.mockRestore();
      stream.close();
    }
  });
});
