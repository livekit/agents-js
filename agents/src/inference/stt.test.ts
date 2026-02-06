// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Ported from Python tests/test_inference_stt_fallback.py
 * Tests for parseSTTModelString, normalizeSTTFallback, and STT constructor fallback/connOptions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { STT, type STTFallbackModel, normalizeSTTFallback, parseSTTModelString } from './stt.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

/** Helper to create STT with required credentials. */
function makeStt(overrides: Record<string, unknown> = {}) {
  const defaults = {
    model: 'deepgram' as const,
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  };
  return new STT({ ...defaults, ...overrides });
}

describe('parseSTTModelString', () => {
  it('simple model without language', () => {
    const [model, language] = parseSTTModelString('deepgram');
    expect(model).toBe('deepgram');
    expect(language).toBeUndefined();
  });

  it('model with language suffix', () => {
    const [model, language] = parseSTTModelString('deepgram:en');
    expect(model).toBe('deepgram');
    expect(language).toBe('en');
  });

  it('provider/model format without language', () => {
    const [model, language] = parseSTTModelString('deepgram/nova-3');
    expect(model).toBe('deepgram/nova-3');
    expect(language).toBeUndefined();
  });

  it('provider/model format with language', () => {
    const [model, language] = parseSTTModelString('deepgram/nova-3:en');
    expect(model).toBe('deepgram/nova-3');
    expect(language).toBe('en');
  });

  it.each([
    ['cartesia/ink-whisper:de', 'cartesia/ink-whisper', 'de'],
    ['assemblyai:es', 'assemblyai', 'es'],
    ['deepgram/nova-2-medical:ja', 'deepgram/nova-2-medical', 'ja'],
    ['deepgram/nova-3:multi', 'deepgram/nova-3', 'multi'],
    ['cartesia:zh', 'cartesia', 'zh'],
  ])('various providers and languages: %s', (modelStr, expectedModel, expectedLang) => {
    const [model, language] = parseSTTModelString(modelStr);
    expect(model).toBe(expectedModel);
    expect(language).toBe(expectedLang);
  });

  it('auto model without language', () => {
    const [model, language] = parseSTTModelString('auto');
    expect(model).toBe('auto');
    expect(language).toBeUndefined();
  });

  it('auto model with language', () => {
    const [model, language] = parseSTTModelString('auto:pt');
    expect(model).toBe('auto');
    expect(language).toBe('pt');
  });
});

describe('normalizeSTTFallback', () => {
  it('single string model', () => {
    const result = normalizeSTTFallback('deepgram/nova-3');
    expect(result).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('single FallbackModel dict', () => {
    const fallback: STTFallbackModel = { model: 'deepgram/nova-3' };
    const result = normalizeSTTFallback(fallback);
    expect(result).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('list of string models', () => {
    const result = normalizeSTTFallback(['deepgram/nova-3', 'cartesia/ink-whisper']);
    expect(result).toEqual([{ model: 'deepgram/nova-3' }, { model: 'cartesia/ink-whisper' }]);
  });

  it('list of FallbackModel dicts', () => {
    const fallbacks: STTFallbackModel[] = [{ model: 'deepgram/nova-3' }, { model: 'assemblyai' }];
    const result = normalizeSTTFallback(fallbacks);
    expect(result).toEqual([{ model: 'deepgram/nova-3' }, { model: 'assemblyai' }]);
  });

  it('mixed list of strings and dicts', () => {
    const result = normalizeSTTFallback([
      'deepgram/nova-3',
      { model: 'cartesia/ink-whisper' } as STTFallbackModel,
      'assemblyai',
    ]);
    expect(result).toEqual([
      { model: 'deepgram/nova-3' },
      { model: 'cartesia/ink-whisper' },
      { model: 'assemblyai' },
    ]);
  });

  it('string with language suffix discards language', () => {
    const result = normalizeSTTFallback('deepgram/nova-3:en');
    expect(result).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('FallbackModel with extraKwargs is preserved', () => {
    const fallback: STTFallbackModel = {
      model: 'deepgram/nova-3',
      extraKwargs: { keywords: [['livekit', 1.5]], punctuate: true },
    };
    const result = normalizeSTTFallback(fallback);
    expect(result).toEqual([
      {
        model: 'deepgram/nova-3',
        extraKwargs: { keywords: [['livekit', 1.5]], punctuate: true },
      },
    ]);
  });

  it('list with extraKwargs preserved', () => {
    const result = normalizeSTTFallback([
      { model: 'deepgram/nova-3', extraKwargs: { punctuate: true } } as STTFallbackModel,
      'cartesia/ink-whisper',
      { model: 'assemblyai', extraKwargs: { format_turns: true } } as STTFallbackModel,
    ]);
    expect(result).toEqual([
      { model: 'deepgram/nova-3', extraKwargs: { punctuate: true } },
      { model: 'cartesia/ink-whisper' },
      { model: 'assemblyai', extraKwargs: { format_turns: true } },
    ]);
  });

  it('empty list returns empty list', () => {
    const result = normalizeSTTFallback([]);
    expect(result).toEqual([]);
  });

  it('multiple colons in model string splits on last', () => {
    const result = normalizeSTTFallback('some:model:part:fr');
    expect(result).toEqual([{ model: 'some:model:part' }]);
  });
});

describe('STT constructor fallback and connOptions', () => {
  it('fallback not given defaults to undefined', () => {
    const stt = makeStt();
    expect(stt['opts'].fallback).toBeUndefined();
  });

  it('fallback single string is normalized', () => {
    const stt = makeStt({ fallback: 'cartesia/ink-whisper' });
    expect(stt['opts'].fallback).toEqual([{ model: 'cartesia/ink-whisper' }]);
  });

  it('fallback list of strings is normalized', () => {
    const stt = makeStt({ fallback: ['deepgram/nova-3', 'assemblyai'] });
    expect(stt['opts'].fallback).toEqual([{ model: 'deepgram/nova-3' }, { model: 'assemblyai' }]);
  });

  it('fallback single FallbackModel is normalized to list', () => {
    const stt = makeStt({ fallback: { model: 'deepgram/nova-3' } });
    expect(stt['opts'].fallback).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('fallback with extraKwargs is preserved', () => {
    const stt = makeStt({
      fallback: {
        model: 'deepgram/nova-3',
        extraKwargs: { punctuate: true, keywords: [['livekit', 1.5]] },
      },
    });
    expect(stt['opts'].fallback).toEqual([
      {
        model: 'deepgram/nova-3',
        extraKwargs: { punctuate: true, keywords: [['livekit', 1.5]] },
      },
    ]);
  });

  it('fallback mixed list is normalized', () => {
    const stt = makeStt({
      fallback: [
        'deepgram/nova-3',
        { model: 'cartesia', extraKwargs: { min_volume: 0.5 } },
        'assemblyai',
      ],
    });
    expect(stt['opts'].fallback).toEqual([
      { model: 'deepgram/nova-3' },
      { model: 'cartesia', extraKwargs: { min_volume: 0.5 } },
      { model: 'assemblyai' },
    ]);
  });

  it('fallback string with language discards language', () => {
    const stt = makeStt({ fallback: 'deepgram/nova-3:en' });
    expect(stt['opts'].fallback).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('connOptions not given uses default', () => {
    const stt = makeStt();
    expect(stt['opts'].connOptions).toEqual(DEFAULT_API_CONNECT_OPTIONS);
  });

  it('connOptions custom timeout', () => {
    const custom: APIConnectOptions = { timeoutMs: 30000, maxRetry: 3, retryIntervalMs: 2000 };
    const stt = makeStt({ connOptions: custom });
    expect(stt['opts'].connOptions).toEqual(custom);
    expect(stt['opts'].connOptions!.timeoutMs).toBe(30000);
  });

  it('connOptions custom maxRetry', () => {
    const custom: APIConnectOptions = { timeoutMs: 10000, maxRetry: 5, retryIntervalMs: 2000 };
    const stt = makeStt({ connOptions: custom });
    expect(stt['opts'].connOptions).toEqual(custom);
    expect(stt['opts'].connOptions!.maxRetry).toBe(5);
  });

  it('connOptions full custom', () => {
    const custom: APIConnectOptions = { timeoutMs: 60000, maxRetry: 10, retryIntervalMs: 2000 };
    const stt = makeStt({ connOptions: custom });
    expect(stt['opts'].connOptions).toEqual(custom);
    expect(stt['opts'].connOptions!.timeoutMs).toBe(60000);
    expect(stt['opts'].connOptions!.maxRetry).toBe(10);
    expect(stt['opts'].connOptions!.retryIntervalMs).toBe(2000);
  });
});
