// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STTv2, type STTv2Options } from './stt_v2.js';

type TestSpeechStream = {
  updateOptions(opts: Partial<STTv2Options>): void;
  readonly _reconnectPending: boolean;
  _liveConfig(): Record<string, string | string[] | boolean>;
  close(): void;
};

function makeStream(opts: Partial<STTv2Options> = {}): TestSpeechStream {
  return new STTv2({ apiKey: 'test-api-key', ...opts }).stream() as unknown as TestSpeechStream;
}

describe('Deepgram STTv2 connection options', () => {
  it.each([
    ['numerals', 'numerals', true],
    ['profanityFilter', 'profanity_filter', true],
    ['redact', 'redact', 'numbers'],
  ] as const)('reconnects when %s changes', (field, configField, value) => {
    const stream = makeStream();

    stream.updateOptions({ [field]: value });

    expect(stream._reconnectPending).toBe(true);
    expect(stream._liveConfig()[configField]).toBe(value);
    stream.close();
  });

  it('includes formatting fields in the connection config', () => {
    const stream = makeStream({
      numerals: true,
      profanityFilter: true,
      redact: 'aggressive_numbers',
    });

    expect(stream._liveConfig()).toMatchObject({
      numerals: true,
      profanity_filter: true,
      redact: 'aggressive_numbers',
    });
    stream.close();

    const defaultStream = makeStream();
    expect(defaultStream._liveConfig()).not.toHaveProperty('numerals');
    expect(defaultStream._liveConfig()).not.toHaveProperty('profanity_filter');
    expect(defaultStream._liveConfig()).not.toHaveProperty('redact');
    defaultStream.close();
  });
});

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    await stt(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
