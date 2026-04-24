// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeLanguage } from '../language.js';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import {
  TTS,
  type TTSFallbackModel,
  hasAlignedTranscript,
  normalizeTTSFallback,
  parseTTSModelString,
} from './tts.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

/** Helper to create TTS with required credentials. */
function makeTts(overrides: Record<string, unknown> = {}) {
  const defaults = {
    model: 'cartesia/sonic' as const,
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  };
  return new TTS({ ...defaults, ...overrides });
}

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

describe('TTS constructor fallback and connOptions', () => {
  it('normalizes language in constructor', () => {
    const tts = makeTts({ language: 'english' });
    expect(tts['opts'].language).toBe('en');
  });

  it('normalizes updated language values', () => {
    const tts = makeTts();
    tts.updateOptions({ language: 'en_US' });
    expect(tts['opts'].language).toBe(normalizeLanguage('en_US'));
  });

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

describe('TTS provider modelOptions parity', () => {
  it('preserves ElevenLabs inference model options', () => {
    const modelOptions = {
      speed: 1.2,
      stability: 0.5,
      similarity_boost: 0.8,
      enable_logging: false,
    };

    const tts = new TTS({
      model: 'elevenlabs/eleven_flash_v2_5' as const,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
      modelOptions,
    });

    expect(tts['opts'].modelOptions).toEqual(modelOptions);
  });

  it('accepts expanded Cartesia inference model options', () => {
    const modelOptions = {
      speed: 1.15,
      emotion: 'curious',
      add_timestamps: true,
    };

    const tts = new TTS({
      model: 'cartesia/sonic' as const,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
      modelOptions,
    });

    expect(tts['opts'].modelOptions).toEqual(modelOptions);
  });

  it('accepts Deepgram inference model options', () => {
    const modelOptions = { mip_opt_out: true };

    const tts = new TTS({
      model: 'deepgram/aura-2' as const,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
      modelOptions,
    });

    expect(tts['opts'].modelOptions).toEqual(modelOptions);
  });

  it('accepts Rime inference model options', () => {
    const modelOptions = {
      speed_alpha: 0.9,
      pause_between_brackets: true,
    };

    const tts = new TTS({
      model: 'rime/mistv2' as const,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
      modelOptions,
    });

    expect(tts['opts'].modelOptions).toEqual(modelOptions);
  });

  it('accepts Inworld inference model options', () => {
    const modelOptions = {
      timestamp_type: 'WORD' as const,
      apply_text_normalization: 'ON' as const,
    };

    const tts = new TTS({
      model: 'inworld/inworld-tts-1' as const,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
      modelOptions,
    });

    expect(tts['opts'].modelOptions).toEqual(modelOptions);
  });
});

describe('hasAlignedTranscript', () => {
  it('returns false for unknown provider', () => {
    expect(hasAlignedTranscript('rime/mistv2', { add_timestamps: true })).toBe(false);
    expect(hasAlignedTranscript('deepgram/aura-2', { sync_alignment: true })).toBe(false);
  });

  it('returns false for an empty options payload', () => {
    expect(hasAlignedTranscript('cartesia/sonic', {})).toBe(false);
    expect(hasAlignedTranscript('elevenlabs/eleven_flash_v2', undefined)).toBe(false);
    expect(hasAlignedTranscript(undefined, { add_timestamps: true })).toBe(false);
  });

  it('detects Cartesia add_timestamps opt-in', () => {
    expect(hasAlignedTranscript('cartesia/sonic', { add_timestamps: true })).toBe(true);
    expect(hasAlignedTranscript('cartesia/sonic-3', { add_timestamps: false })).toBe(false);
  });

  it('detects ElevenLabs sync_alignment opt-in', () => {
    expect(hasAlignedTranscript('elevenlabs/eleven_flash_v2', { sync_alignment: true })).toBe(true);
    expect(
      hasAlignedTranscript('elevenlabs/eleven_multilingual_v2', { sync_alignment: false }),
    ).toBe(false);
  });

  it('detects Inworld WORD/CHARACTER timestamp types', () => {
    expect(hasAlignedTranscript('inworld/inworld-tts-1', { timestamp_type: 'WORD' })).toBe(true);
    expect(hasAlignedTranscript('inworld/inworld-tts-1', { timestamp_type: 'CHARACTER' })).toBe(
      true,
    );
    expect(
      hasAlignedTranscript('inworld/inworld-tts-1', {
        timestamp_type: 'TIMESTAMP_TYPE_UNSPECIFIED',
      }),
    ).toBe(false);
  });
});

describe('TTS alignedTranscript capability', () => {
  it('defaults to alignedTranscript=false when no opt-in is provided', () => {
    const tts = makeTts();
    expect(tts.capabilities.alignedTranscript).toBe(false);
  });

  it('reports alignedTranscript=true when Cartesia add_timestamps is set', () => {
    const tts = makeTts({
      model: 'cartesia/sonic',
      modelOptions: { add_timestamps: true },
    });
    expect(tts.capabilities.alignedTranscript).toBe(true);
  });

  it('reports alignedTranscript=true when ElevenLabs sync_alignment is set', () => {
    const tts = makeTts({
      model: 'elevenlabs/eleven_flash_v2',
      modelOptions: { sync_alignment: true },
    });
    expect(tts.capabilities.alignedTranscript).toBe(true);
  });

  it('reports alignedTranscript=true when Inworld timestamp_type is WORD', () => {
    const tts = makeTts({
      model: 'inworld/inworld-tts-1',
      modelOptions: { timestamp_type: 'WORD' },
    });
    expect(tts.capabilities.alignedTranscript).toBe(true);
  });

  it('recomputes alignedTranscript when updateOptions changes modelOptions', () => {
    const tts = makeTts({ model: 'cartesia/sonic' });
    expect(tts.capabilities.alignedTranscript).toBe(false);

    tts.updateOptions({ modelOptions: { add_timestamps: true } });
    expect(tts.capabilities.alignedTranscript).toBe(true);

    tts.updateOptions({ modelOptions: { add_timestamps: false } });
    expect(tts.capabilities.alignedTranscript).toBe(false);
  });

  it('recomputes alignedTranscript when updateOptions changes the model', () => {
    const tts = makeTts({
      model: 'cartesia/sonic',
      modelOptions: { sync_alignment: true },
    });
    expect(tts.capabilities.alignedTranscript).toBe(false);

    tts.updateOptions({ model: 'elevenlabs/eleven_flash_v2' });
    expect(tts.capabilities.alignedTranscript).toBe(true);
  });

  it('invalidates the connection pool when session-affecting options change', () => {
    const tts = makeTts({ model: 'cartesia/sonic' });
    const invalidateSpy = vi.spyOn(tts.pool, 'invalidate');

    tts.updateOptions({ modelOptions: { add_timestamps: true } });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    tts.updateOptions({ model: 'elevenlabs/eleven_flash_v2' });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);

    tts.updateOptions({ voice: 'narrator' });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);

    tts.updateOptions({ language: 'en' });
    expect(invalidateSpy).toHaveBeenCalledTimes(4);

    // Empty update should not churn the pool.
    tts.updateOptions({});
    expect(invalidateSpy).toHaveBeenCalledTimes(4);
  });
});
