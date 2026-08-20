// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL, DEFAULT_TTS_REGION, TTS_REGIONAL_BASE_URLS } from './models.js';
import { TTS } from './tts.js';

const hasMinimaxConfig = Boolean(process.env.MINIMAX_API_KEY);

if (hasMinimaxConfig) {
  describe('MiniMax TTS', () => {
    it('constructs without throwing', () => {
      new TTS();
    });
  });
} else {
  describe('MiniMax TTS', () => {
    it.skip('requires MINIMAX_API_KEY', () => {});
  });
}

describe('MiniMax TTS endpoint selection', () => {
  const apiKey = 'key';
  const savedBaseUrl = process.env.MINIMAX_BASE_URL;

  beforeEach(() => {
    delete process.env.MINIMAX_BASE_URL;
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) {
      delete process.env.MINIMAX_BASE_URL;
    } else {
      process.env.MINIMAX_BASE_URL = savedBaseUrl;
    }
  });

  it('defaults to the endpoint of the default region', () => {
    expect(DEFAULT_BASE_URL).toBe(TTS_REGIONAL_BASE_URLS[DEFAULT_TTS_REGION]);
    expect(new TTS({ apiKey }).baseUrl).toBe(TTS_REGIONAL_BASE_URLS.global_en);
  });

  it('uses the endpoint of the requested region', () => {
    expect(new TTS({ apiKey, region: 'global_en' }).baseUrl).toBe(TTS_REGIONAL_BASE_URLS.global_en);
    expect(new TTS({ apiKey, region: 'cn_zh' }).baseUrl).toBe(TTS_REGIONAL_BASE_URLS.cn_zh);
  });

  it('keeps distinct hosts per region', () => {
    expect(TTS_REGIONAL_BASE_URLS.global_en).not.toBe(TTS_REGIONAL_BASE_URLS.cn_zh);
  });

  it('prefers an explicit base URL over the region', () => {
    const baseUrl = 'https://tts.example.invalid';
    expect(new TTS({ apiKey, region: 'cn_zh', baseUrl }).baseUrl).toBe(baseUrl);
  });

  it('falls back to $MINIMAX_BASE_URL when no region is requested', () => {
    process.env.MINIMAX_BASE_URL = 'https://tts.example.invalid';
    expect(new TTS({ apiKey }).baseUrl).toBe('https://tts.example.invalid');
  });
});
