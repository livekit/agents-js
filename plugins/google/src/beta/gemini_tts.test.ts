// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, expect, it, vi } from 'vitest';
import { TTS } from './gemini_tts.js';

const { generateContentStream } = vi.hoisted(() => ({
  generateContentStream: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    return {
      models: {
        generateContentStream,
      },
    };
  }),
}));

describe('Google Gemini TTS integration', () => {
  it.skip('synthesizes with live providers', async () => {
    await tts(new TTS(), new STT());
  });
});

describe('Google Gemini TTS', () => {
  it('synthesizes audio from a streamed Gemini response', async () => {
    const audioChunk = Buffer.alloc(4800);

    generateContentStream.mockImplementation(async function* () {
      yield buildResponseChunk(audioChunk);
      yield buildResponseChunk(audioChunk);
    });

    const stream = new TTS({ apiKey: 'test-api-key' }).synthesize('Hello world');
    let audioCount = 0;

    for await (const _frame of stream) {
      audioCount += 1;
    }

    expect(generateContentStream).toHaveBeenCalledOnce();
    expect(audioCount).toBeGreaterThan(0);
  });
});

function buildResponseChunk(data: Buffer) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                data: data.toString('base64'),
                mimeType: 'audio/pcm',
              },
            },
          ],
        },
      },
    ],
  };
}
