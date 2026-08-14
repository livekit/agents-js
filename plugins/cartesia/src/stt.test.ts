// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STT, buildSTTWebsocketUrl } from './stt.js';

const hasCartesiaApiKey = Boolean(process.env.CARTESIA_API_KEY);

describe('Cartesia STT capabilities', () => {
  it('reports no aligned transcript for Ink-2', () => {
    const instance = new STT({ apiKey: 'test-key', model: 'ink-2' });

    expect(instance.capabilities.alignedTranscript).toBe(false);
  });
});

describe('Cartesia STT keyterms', () => {
  const baseOpts = {
    apiKey: 'test-key',
    model: 'ink-2',
    sampleRate: 16_000,
    baseUrl: 'https://api.cartesia.ai',
    audioChunkDurationMS: 160,
    language: 'en',
  };

  it('sends one keyterm query param per term', () => {
    const url = new URL(buildSTTWebsocketUrl({ ...baseOpts, keyterm: ['LiveKit', 'Cartesia'] }));

    expect(url.searchParams.getAll('keyterm')).toEqual(['LiveKit', 'Cartesia']);
    expect(url.searchParams.get('model')).toBe('ink-2');
  });

  it('omits the keyterm param when no terms are set', () => {
    const url = new URL(buildSTTWebsocketUrl(baseOpts));

    expect(url.searchParams.has('keyterm')).toBe(false);
  });

  it('rejects keyterms on non turn-detecting models', () => {
    expect(
      () => new STT({ apiKey: 'test-key', model: 'ink-whisper', keyterm: ['LiveKit'] }),
    ).toThrow(/only supported by turn-detecting models/);
  });

  it('rejects a language switch that would route keyterms to ink-whisper', () => {
    const instance = new STT({ apiKey: 'test-key', keyterm: ['LiveKit'] });
    expect(instance.model).toBe('ink-2');

    // 'fr' resolves to the multilingual ink-whisper, which does not take keyterms
    expect(() => instance.updateOptions({ language: 'fr' })).toThrow(
      /only supported by turn-detecting models/,
    );
    // the rejected update must not have been committed
    expect(instance.model).toBe('ink-2');
  });

  it('allows switching to ink-whisper once keyterms are cleared', () => {
    const instance = new STT({ apiKey: 'test-key', keyterm: ['LiveKit'] });

    instance.updateOptions({ keyterm: [], language: 'fr' });
    expect(instance.model).toBe('ink-whisper');
  });
});

if (hasCartesiaApiKey) {
  describe('Cartesia STT', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Cartesia STT', () => {
    it.skip('requires CARTESIA_API_KEY', () => {});
  });
}
