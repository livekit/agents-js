// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { TTS } from './tts.js';

describe('SpeechSDK TTS model strings', () => {
  it('rejects a model without a provider prefix', () => {
    expect(() => new TTS({ model: 'gpt-4o-mini-tts', speechbaseApiKey: undefined })).toThrow(
      /provider\/model/,
    );
  });

  it('rejects an unknown provider prefix', () => {
    expect(() => new TTS({ model: 'acme/some-model', speechbaseApiKey: undefined })).toThrow(
      /Unknown speech-sdk provider/,
    );
  });

  it('splits path-style model ids on the first slash only', () => {
    const instance = new TTS({ model: 'fal-ai/kokoro/american-english' });
    expect(instance.provider).toEqual('fal-ai');
    expect(instance.model).toEqual('fal-ai/kokoro/american-english');
  });
});

const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);

if (hasOpenAIKey) {
  describe('SpeechSDK TTS', async () => {
    await tts(new TTS(), new STT({ useRealtime: false, model: 'whisper-1' }), { streaming: false });
  });
} else {
  describe('SpeechSDK TTS', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
