// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Ported from Python tests/test_inference_tts_fallback.py
 * Tests for parseTTSModelString, normalizeTTSFallback, and TTS constructor fallback/connOptions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { TTS, type TTSFallbackModel, normalizeTTSFallback, parseTTSModelString } from './tts.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

/** Helper to create TTS with required credentials. */
// Ref: Python tests/test_inference_tts_fallback.py lines 14-23 - _make_tts helper
function makeTts(overrides: Record<string, unknown> = {}) {
  const defaults = {
    model: 'cartesia/sonic' as const,
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  };
  return new TTS({ ...defaults, ...overrides });
}

// Ref: Python tests/test_inference_tts_fallback.py lines 26-72 - TestParseModelString
describe('parseTTSModelString', () => {
  it('simple model without voice', () => {
    const [model, voice] = parseTTSModelString('cartesia');
    expect(model).toBe('cartesia');
    expect(voice).toBeUndefined();
  });

  it('model with voice suffix', () => {
    const [model, voice] = parseTTSModelString('cartesia:my-voice-id');
    expect(model).toBe('cartesia');
    expect(voice).toBe('my-voice-id');
  });

  it('provider/model format without voice', () => {
    const [model, voice] = parseTTSModelString('cartesia/sonic');
    expect(model).toBe('cartesia/sonic');
    expect(voice).toBeUndefined();
  });

  it('provider/model format with voice', () => {
    const [model, voice] = parseTTSModelString('cartesia/sonic:my-voice-id');
    expect(model).toBe('cartesia/sonic');
    expect(voice).toBe('my-voice-id');
  });

  it.each([
    ['elevenlabs/eleven_flash_v2:voice123', 'elevenlabs/eleven_flash_v2', 'voice123'],
    ['rime:speaker-a', 'rime', 'speaker-a'],
    ['rime/mist:narrator', 'rime/mist', 'narrator'],
    ['inworld/inworld-tts-1:character', 'inworld/inworld-tts-1', 'character'],
    ['cartesia/sonic-turbo:deep-voice', 'cartesia/sonic-turbo', 'deep-voice'],
  ])('various providers and voices: %s', (modelStr, expectedModel, expectedVoice) => {
    const [model, voice] = parseTTSModelString(modelStr);
    expect(model).toBe(expectedModel);
    expect(voice).toBe(expectedVoice);
  });

  it('empty voice after colon', () => {
    const [model, voice] = parseTTSModelString('cartesia/sonic:');
    expect(model).toBe('cartesia/sonic');
    expect(voice).toBe('');
  });
});

// Ref: Python tests/test_inference_tts_fallback.py lines 74-173 - TestNormalizeFallback
describe('normalizeTTSFallback', () => {
  it('single string model', () => {
    const result = normalizeTTSFallback('cartesia/sonic');
    expect(result).toEqual([{ model: 'cartesia/sonic', voice: '' }]);
  });

  it('single string model with voice', () => {
    const result = normalizeTTSFallback('cartesia/sonic:my-voice');
    expect(result).toEqual([{ model: 'cartesia/sonic', voice: 'my-voice' }]);
  });

  it('single FallbackModel dict', () => {
    const fallback: TTSFallbackModel = { model: 'cartesia/sonic', voice: 'narrator' };
    const result = normalizeTTSFallback(fallback);
    expect(result).toEqual([{ model: 'cartesia/sonic', voice: 'narrator' }]);
  });

  it('list of string models', () => {
    const result = normalizeTTSFallback(['cartesia/sonic', 'elevenlabs/eleven_flash_v2']);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: '' },
      { model: 'elevenlabs/eleven_flash_v2', voice: '' },
    ]);
  });

  it('list of string models with voices', () => {
    const result = normalizeTTSFallback(['cartesia/sonic:voice1', 'elevenlabs:voice2']);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'voice1' },
      { model: 'elevenlabs', voice: 'voice2' },
    ]);
  });

  it('list of FallbackModel dicts', () => {
    const fallbacks: TTSFallbackModel[] = [
      { model: 'cartesia/sonic', voice: 'narrator' },
      { model: 'elevenlabs', voice: '' },
    ];
    const result = normalizeTTSFallback(fallbacks);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'narrator' },
      { model: 'elevenlabs', voice: '' },
    ]);
  });

  it('mixed list of strings and dicts', () => {
    const result = normalizeTTSFallback([
      'cartesia/sonic:voice1',
      { model: 'elevenlabs/eleven_flash_v2', voice: 'custom' } as TTSFallbackModel,
      'rime/mist',
    ]);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'voice1' },
      { model: 'elevenlabs/eleven_flash_v2', voice: 'custom' },
      { model: 'rime/mist', voice: '' },
    ]);
  });

  it('FallbackModel with extraKwargs is preserved', () => {
    const fallback: TTSFallbackModel = {
      model: 'cartesia/sonic',
      voice: 'narrator',
      extraKwargs: { duration: 30.0, speed: 'fast' },
    };
    const result = normalizeTTSFallback(fallback);
    expect(result).toEqual([
      {
        model: 'cartesia/sonic',
        voice: 'narrator',
        extraKwargs: { duration: 30.0, speed: 'fast' },
      },
    ]);
  });

  it('list with extraKwargs preserved', () => {
    const result = normalizeTTSFallback([
      { model: 'cartesia/sonic', voice: 'v1', extraKwargs: { speed: 'slow' } } as TTSFallbackModel,
      'elevenlabs:voice2',
      { model: 'rime/mist', voice: '', extraKwargs: { custom: true } } as TTSFallbackModel,
    ]);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'v1', extraKwargs: { speed: 'slow' } },
      { model: 'elevenlabs', voice: 'voice2' },
      { model: 'rime/mist', voice: '', extraKwargs: { custom: true } },
    ]);
  });

  it('empty list returns empty list', () => {
    const result = normalizeTTSFallback([]);
    expect(result).toEqual([]);
  });

  it('FallbackModel with empty voice', () => {
    const fallback: TTSFallbackModel = { model: 'cartesia/sonic', voice: '' };
    const result = normalizeTTSFallback(fallback);
    expect(result).toEqual([{ model: 'cartesia/sonic', voice: '' }]);
  });
});

// Ref: Python tests/test_inference_tts_fallback.py (constructor tests follow same pattern as STT)
describe('TTS constructor fallback and connOptions', () => {
  it('fallback not given defaults to undefined', () => {
    const tts = makeTts();
    expect(tts['opts'].fallback).toBeUndefined();
  });

  it('fallback single string is normalized', () => {
    const tts = makeTts({ fallback: 'elevenlabs/eleven_flash_v2' });
    expect(tts['opts'].fallback).toEqual([{ model: 'elevenlabs/eleven_flash_v2', voice: '' }]);
  });

  it('fallback single string with voice is normalized', () => {
    const tts = makeTts({ fallback: 'cartesia/sonic:my-voice' });
    expect(tts['opts'].fallback).toEqual([{ model: 'cartesia/sonic', voice: 'my-voice' }]);
  });

  it('fallback list of strings is normalized', () => {
    const tts = makeTts({ fallback: ['cartesia/sonic', 'elevenlabs'] });
    expect(tts['opts'].fallback).toEqual([
      { model: 'cartesia/sonic', voice: '' },
      { model: 'elevenlabs', voice: '' },
    ]);
  });

  it('fallback single FallbackModel is normalized to list', () => {
    const tts = makeTts({ fallback: { model: 'cartesia/sonic', voice: 'narrator' } });
    expect(tts['opts'].fallback).toEqual([{ model: 'cartesia/sonic', voice: 'narrator' }]);
  });

  it('fallback with extraKwargs is preserved', () => {
    const tts = makeTts({
      fallback: {
        model: 'cartesia/sonic',
        voice: 'narrator',
        extraKwargs: { duration: 30.0, speed: 'fast' },
      },
    });
    expect(tts['opts'].fallback).toEqual([
      {
        model: 'cartesia/sonic',
        voice: 'narrator',
        extraKwargs: { duration: 30.0, speed: 'fast' },
      },
    ]);
  });

  it('fallback mixed list is normalized', () => {
    const tts = makeTts({
      fallback: [
        'cartesia/sonic:voice1',
        { model: 'elevenlabs', voice: 'custom', extraKwargs: { speed: 'slow' } },
        'rime/mist',
      ],
    });
    expect(tts['opts'].fallback).toEqual([
      { model: 'cartesia/sonic', voice: 'voice1' },
      { model: 'elevenlabs', voice: 'custom', extraKwargs: { speed: 'slow' } },
      { model: 'rime/mist', voice: '' },
    ]);
  });

  it('connOptions not given uses default', () => {
    const tts = makeTts();
    expect(tts['opts'].connOptions).toEqual(DEFAULT_API_CONNECT_OPTIONS);
  });

  it('connOptions custom timeout', () => {
    const custom: APIConnectOptions = { timeoutMs: 30000, maxRetry: 3, retryIntervalMs: 2000 };
    const tts = makeTts({ connOptions: custom });
    expect(tts['opts'].connOptions).toEqual(custom);
    expect(tts['opts'].connOptions!.timeoutMs).toBe(30000);
  });

  it('connOptions custom maxRetry', () => {
    const custom: APIConnectOptions = { timeoutMs: 10000, maxRetry: 5, retryIntervalMs: 2000 };
    const tts = makeTts({ connOptions: custom });
    expect(tts['opts'].connOptions).toEqual(custom);
    expect(tts['opts'].connOptions!.maxRetry).toBe(5);
  });

  it('connOptions full custom', () => {
    const custom: APIConnectOptions = { timeoutMs: 60000, maxRetry: 10, retryIntervalMs: 2000 };
    const tts = makeTts({ connOptions: custom });
    expect(tts['opts'].connOptions).toEqual(custom);
    expect(tts['opts'].connOptions!.timeoutMs).toBe(60000);
    expect(tts['opts'].connOptions!.maxRetry).toBe(10);
    expect(tts['opts'].connOptions!.retryIntervalMs).toBe(2000);
  });
});
