// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import type { TTSOptions } from './models.js';
import { TTS } from './tts.js';

const options = (tts: TTS): TTSOptions => (tts as unknown as { opts: TTSOptions }).opts;

describe('Hume TTS options', () => {
  it('rejects instant mode without a voice in updateOptions', () => {
    let tts = new TTS({ apiKey: 'test-key', voice: null });
    expect(() => tts.updateOptions({ instantMode: true })).toThrow(
      'instant_mode cannot be enabled without',
    );
    expect(options(tts).instantMode).toBe(false);

    tts = new TTS({ apiKey: 'test-key' });
    const voice = options(tts).voice;
    expect(() => tts.updateOptions({ voice: null, speed: 1.5 })).toThrow(
      'instant_mode cannot be enabled without',
    );
    expect(options(tts).voice).toEqual(voice);
    expect(options(tts).speed).toBeUndefined();
  });

  it('accepts a consistent voice and instant mode in updateOptions', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    tts.updateOptions({ voice: null, instantMode: false });
    expect(options(tts).voice).toBeNull();
    expect(options(tts).instantMode).toBe(false);

    const voice = { name: 'Ava Song' };
    tts.updateOptions({ voice, instantMode: true });
    expect(options(tts).voice).toEqual(voice);
    expect(options(tts).instantMode).toBe(true);
  });
});

const hasHumeConfig = Boolean(process.env.HUME_API_KEY && process.env.OPENAI_API_KEY);

if (hasHumeConfig) {
  describe('Hume TTS', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Hume TTS', () => {
    it.skip('requires HUME_API_KEY and OPENAI_API_KEY', () => {});
  });
}
