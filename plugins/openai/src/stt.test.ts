// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD as BaseVAD, type VADStream } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STT } from './stt.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

class FakeVAD extends BaseVAD {
  label = 'fake-vad';

  stream(): VADStream {
    return {} as VADStream;
  }
}

describe('OpenAI STT options', () => {
  it('defaults to realtime whisper streaming', () => {
    const openai = new STT({ apiKey: 'test-key', vad: new FakeVAD({ updateInterval: 1 }) });

    expect(openai.model).toBe('gpt-realtime-whisper');
    expect(openai.capabilities.streaming).toBe(true);
    expect(openai.capabilities.interimResults).toBe(true);
    expect(openai.capabilities.alignedTranscript).toBe(false);
  });

  it('supports explicitly opting into batch STT', () => {
    const openai = new STT({ apiKey: 'test-key', useRealtime: false });

    expect(openai.model).toBe('whisper-1');
    expect(openai.capabilities.streaming).toBe(false);
    expect(() => openai.stream()).toThrow(/useRealtime/i);
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI STT integration', async () => {
    const vad = await VAD.load();
    await stt(new STT({ useRealtime: false }), vad, { streaming: false });
  });

  describe('OpenAI STT realtime integration', async () => {
    const vad = await VAD.load();
    await stt(new STT({ vad }), vad, {
      nonStreaming: false,
    });
  });
} else {
  describe('OpenAI', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
