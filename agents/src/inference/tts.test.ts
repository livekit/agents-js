// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { APIConnectionError, APIStatusError } from '../_exceptions.js';
import * as agents from '../index.js';
import { normalizeLanguage } from '../language.js';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { STT } from './stt.js';
import { describeLiveKitInference } from './test_utils.js';
import {
  type FallbackActivatedEvent,
  TTS,
  type TTSFallbackModel,
  type TTSFallbackModelType,
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

async function captureSessionCreate(overrides: Record<string, unknown> = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  let resolvePayload!: (payload: Record<string, unknown>) => void;
  const payload = new Promise<Record<string, unknown>>((resolve) => {
    resolvePayload = resolve;
  });

  server.on('connection', (socket) => {
    socket.once('message', (raw) => {
      resolvePayload(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  const tts = makeTts({ ...overrides, baseURL: `http://127.0.0.1:${port}` });
  let socket: WebSocket | undefined;
  try {
    socket = await tts.connectWs(1_000);
    return await payload;
  } finally {
    socket?.terminate();
    await tts.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runGatewayEvents(events: Record<string, unknown>[]) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string };
      if (event.type !== 'session.flush') return;
      for (const serverEvent of events) {
        socket.send(JSON.stringify(serverEvent));
      }
    });
  });

  const tts = makeTts({
    baseURL: `http://127.0.0.1:${port}`,
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1_000 },
  });
  const fallbackEvents: FallbackActivatedEvent[] = [];
  tts.on('fallback_activated', (event) => fallbackEvents.push(event));
  const stream = tts.stream();

  try {
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello');
          controller.close();
        },
      }),
    );

    const output = [];
    for await (const event of stream) output.push(event);
    return {
      fallbackEvents,
      audioEvents: output.filter((event) => typeof event !== 'symbol'),
    };
  } finally {
    stream.close();
    await tts.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Inference TTS connection', () => {
  it('includes the model in the dial URL', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let resolveRequestUrl!: (url: string) => void;
    const requestUrl = new Promise<string>((resolve) => {
      resolveRequestUrl = resolve;
    });

    server.on('connection', (_socket, request) => {
      resolveRequestUrl(request.url ?? '');
    });

    const tts = makeTts({
      model: 'cartesia/sonic-3',
      baseURL: `http://127.0.0.1:${address.port}`,
    });
    let socket: WebSocket | undefined;

    try {
      socket = await tts.connectWs(1_000);

      expect(new URL(await requestUrl, 'ws://127.0.0.1').searchParams.get('model')).toBe(
        'cartesia/sonic-3',
      );
    } finally {
      socket?.terminate();
      for (const client of server.clients) client.terminate();
      await tts.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Inference TTS session.create fallback', () => {
  const basePayload = {
    type: 'session.create',
    handoff_protocol: 1,
    sample_rate: '16000',
    encoding: 'pcm_s16le',
    extra: {},
    model: 'cartesia/sonic',
    language: 'en',
    connection: { timeout: 10, retries: 3 },
  };

  it.each([{}, { fallback: [] }])(
    'omits fallback when no models and system fallback remains enabled',
    async (overrides) => {
      expect(await captureSessionCreate(overrides)).toEqual(basePayload);
    },
  );

  it.each([
    { disableSystemDefaultFallback: true },
    { fallback: [], disableSystemDefaultFallback: true },
  ])('can disable system fallback without customer fallback models', async (overrides) => {
    expect(await captureSessionCreate(overrides)).toEqual({
      ...basePayload,
      fallback: {
        models: [],
        disable_system_default_fallback: true,
      },
    });
  });

  it.each([false, true])(
    'maps customer fallback models exactly when opt-out is %s',
    async (disableSystemDefaultFallback) => {
      expect(
        await captureSessionCreate({
          fallback: [
            'deepgram/aura-2:asteria',
            {
              model: 'rime/mistv3',
              voice: 'speaker-1',
              extraKwargs: { speed_alpha: 0.9 },
            },
          ],
          disableSystemDefaultFallback,
        }),
      ).toEqual({
        ...basePayload,
        fallback: {
          models: [
            { model: 'deepgram/aura-2', voice: 'asteria', extra: {} },
            {
              model: 'rime/mistv3',
              voice: 'speaker-1',
              extra: { speed_alpha: 0.9 },
            },
          ],
          ...(disableSystemDefaultFallback ? { disable_system_default_fallback: true } : {}),
        },
      });
    },
  );
});

describe('Inference TTS gateway notices', () => {
  const audioEvent = {
    type: 'output_audio',
    session_id: 'session-1',
    audio: Buffer.alloc(3200).toString('base64'),
  };
  const doneEvent = { type: 'done', session_id: 'session-1' };

  it('emits fallback activation notices without interrupting audio', async () => {
    const result = await runGatewayEvents([
      { type: 'session.created', session_id: 'session-1' },
      {
        type: 'fallback_activated',
        session_id: 'session-1',
        fallback_type: 'fallback',
        provider: 'deepgram',
        model: 'deepgram/aura-2',
        voice: 'asteria',
        cause: 'quota_exceeded',
      },
      audioEvent,
      doneEvent,
    ]);

    expect(result.fallbackEvents).toEqual([
      {
        sessionId: 'session-1',
        fallbackType: 'fallback',
        provider: 'deepgram',
        model: 'deepgram/aura-2',
        voice: 'asteria',
        cause: 'quota_exceeded',
      },
    ]);
    expect(result.audioEvents).toHaveLength(1);
  });

  it('ignores unrelated unknown gateway messages', async () => {
    const result = await runGatewayEvents([
      { type: 'session.created', session_id: 'session-1' },
      { type: 'future_message', session_id: 'session-1', data: 'ignored' },
      audioEvent,
      doneEvent,
    ]);

    expect(result.fallbackEvents).toEqual([]);
    expect(result.audioEvents).toHaveLength(1);
  });

  it('drops malformed fallback activation notices without interrupting audio', async () => {
    const result = await runGatewayEvents([
      { type: 'session.created', session_id: 'session-1' },
      {
        type: 'fallback_activated',
        session_id: 'session-1',
        fallback_type: 'fallback',
        model: 42,
        cause: 'timeout',
      },
      audioEvent,
      doneEvent,
    ]);

    expect(result.fallbackEvents).toEqual([]);
    expect(result.audioEvents).toHaveLength(1);
  });

  it('normalizes unsupported fallback causes without interrupting audio', async () => {
    const result = await runGatewayEvents([
      { type: 'session.created', session_id: 'session-1' },
      {
        type: 'fallback_activated',
        session_id: 'session-1',
        fallback_type: 'future_type',
        provider: 'deepgram',
        model: 'deepgram/aura-2',
        voice: 'asteria',
        cause: 'future_cause',
      },
      audioEvent,
      doneEvent,
    ]);

    expect(result.fallbackEvents).toEqual([
      {
        sessionId: 'session-1',
        fallbackType: 'unknown',
        provider: 'deepgram',
        model: 'deepgram/aura-2',
        voice: 'asteria',
        cause: 'unknown',
      },
    ]);
    expect(result.audioEvents).toHaveLength(1);
  });
});

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
    ['deepgram/aura-2:voice123', 'deepgram/aura-2', 'voice123'],
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
    const result = normalizeTTSFallback(['cartesia/sonic', 'deepgram/aura-2']);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: '' },
      { model: 'deepgram/aura-2', voice: '' },
    ]);
  });

  it('list of string models with voices', () => {
    const result = normalizeTTSFallback(['cartesia/sonic:voice1', 'deepgram/aura-2:voice2']);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'voice1' },
      { model: 'deepgram/aura-2', voice: 'voice2' },
    ]);
  });

  it('list of FallbackModel dicts', () => {
    const fallbacks: TTSFallbackModel[] = [
      { model: 'cartesia/sonic', voice: 'narrator' },
      { model: 'deepgram/aura-2', voice: '' },
    ];
    const result = normalizeTTSFallback(fallbacks);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'narrator' },
      { model: 'deepgram/aura-2', voice: '' },
    ]);
  });

  it('mixed list of strings and dicts', () => {
    const result = normalizeTTSFallback([
      'cartesia/sonic:voice1',
      { model: 'deepgram/aura-2', voice: 'custom' } as TTSFallbackModel,
      'rime/mist',
    ]);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'voice1' },
      { model: 'deepgram/aura-2', voice: 'custom' },
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
      'deepgram/aura-2:voice2',
      { model: 'rime/mist', voice: '', extraKwargs: { custom: true } } as TTSFallbackModel,
    ]);
    expect(result).toEqual([
      { model: 'cartesia/sonic', voice: 'v1', extraKwargs: { speed: 'slow' } },
      { model: 'deepgram/aura-2', voice: 'voice2' },
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
    expect(tts['opts'].disableSystemDefaultFallback).toBe(false);
  });

  it('stores the system fallback opt-out', () => {
    const tts = makeTts({ disableSystemDefaultFallback: true });
    expect(tts['opts'].disableSystemDefaultFallback).toBe(true);
  });

  it('fallback single string is normalized', () => {
    const tts = makeTts({ fallback: 'deepgram/aura-2' });
    expect(tts['opts'].fallback).toEqual([{ model: 'deepgram/aura-2', voice: '' }]);
  });

  it('fallback single string with voice is normalized', () => {
    const tts = makeTts({ fallback: 'cartesia/sonic:my-voice' });
    expect(tts['opts'].fallback).toEqual([{ model: 'cartesia/sonic', voice: 'my-voice' }]);
  });

  it('fallback list of strings is normalized', () => {
    const tts = makeTts({ fallback: ['cartesia/sonic', 'deepgram/aura-2'] });
    expect(tts['opts'].fallback).toEqual([
      { model: 'cartesia/sonic', voice: '' },
      { model: 'deepgram/aura-2', voice: '' },
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
        { model: 'deepgram/aura-2', voice: 'custom', extraKwargs: { mip_opt_out: true } },
        'rime/mist',
      ],
    });
    expect(tts['opts'].fallback).toEqual([
      { model: 'cartesia/sonic', voice: 'voice1' },
      { model: 'deepgram/aura-2', voice: 'custom', extraKwargs: { mip_opt_out: true } },
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

describe('TTS provider modelOptions', () => {
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
    expect(hasAlignedTranscript('deepgram/aura-2', { timestamp_type: 'WORD' })).toBe(false);
  });

  it('returns false for an empty options payload', () => {
    expect(hasAlignedTranscript('cartesia/sonic', {})).toBe(false);
    expect(hasAlignedTranscript('inworld/inworld-tts-1', undefined)).toBe(false);
    expect(hasAlignedTranscript(undefined, { add_timestamps: true })).toBe(false);
  });

  it('detects Cartesia add_timestamps opt-in', () => {
    expect(hasAlignedTranscript('cartesia/sonic', { add_timestamps: true })).toBe(true);
    expect(hasAlignedTranscript('cartesia/sonic-3', { add_timestamps: false })).toBe(false);
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

  it('reports alignedTranscript=true when Inworld timestamp_type is WORD', () => {
    const tts = makeTts({
      model: 'inworld/inworld-tts-1',
      modelOptions: { timestamp_type: 'WORD' },
    });
    expect(tts.capabilities.alignedTranscript).toBe(true);
  });

  it('reports AssemblyAI aligned transcripts by default unless explicitly disabled', () => {
    const capabilities = (modelOptions?: Record<string, unknown>) =>
      makeTts({
        model: 'assemblyai/assemblyai-tts-1',
        ...(modelOptions === undefined ? {} : { modelOptions }),
      }).capabilities.alignedTranscript;

    expect(capabilities()).toBe(true);
    expect(capabilities({ word_timestamps: true })).toBe(true);
    expect(capabilities({ word_timestamps: false })).toBe(false);
    expect(capabilities({ word_timestamps: 'no' })).toBe(true);
  });

  it('drops alignedTranscript when a server-side fallback cannot emit alignment', () => {
    const capabilities = (fallback: TTSFallbackModelType | TTSFallbackModelType[]) =>
      makeTts({ model: 'assemblyai/assemblyai-tts-1', fallback }).capabilities.alignedTranscript;

    expect(capabilities('deepgram/aura-2')).toBe(false);
    expect(capabilities({ model: 'cartesia/sonic', voice: 'v' })).toBe(false);
    expect(
      capabilities([
        { model: 'cartesia/sonic', voice: 'v', extraKwargs: { add_timestamps: true } },
        'assemblyai/assemblyai-tts-1',
      ]),
    ).toBe(true);
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
      modelOptions: { timestamp_type: 'WORD' },
    });
    expect(tts.capabilities.alignedTranscript).toBe(false);

    tts.updateOptions({ model: 'inworld/inworld-tts-1' });
    expect(tts.capabilities.alignedTranscript).toBe(true);
  });

  it('invalidates the connection pool when session-affecting options change', () => {
    const tts = makeTts({ model: 'cartesia/sonic' });
    const invalidateSpy = vi.spyOn(tts.pool, 'invalidate');

    tts.updateOptions({ modelOptions: { add_timestamps: true } });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    tts.updateOptions({ model: 'deepgram/aura-2' });
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

describeLiveKitInference('LiveKit Inference TTS integration', agents, async (harness) => {
  const models = [
    {
      model: 'cartesia/sonic-3',
      voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
    },
    { model: 'inworld/inworld-tts-2', voice: 'Ashley' },
    { model: 'rime/coda', voice: 'celeste' },
  ] as const;

  for (const options of models) {
    describe(options.model, async () => {
      await harness.tts(
        new TTS(options),
        new STT({
          model: 'deepgram/nova-3',
          modelOptions: { endpointing: 1000 },
        }),
        {
          streamingValidationStt: true,
        },
      );
    });
  }
});

describe('Inference TTS releaseIdleConnections', () => {
  it('closes pooled sockets and reconnects on the next use', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const opened: WebSocket[] = [];
    const closed: number[] = [];
    server.on('connection', (socket) => {
      opened.push(socket);
      socket.on('close', (code) => closed.push(code));
    });

    const tts = makeTts({ baseURL: `http://127.0.0.1:${address.port}` });
    try {
      tts.prewarm();
      await vi.waitFor(() => expect(opened).toHaveLength(1));

      await tts.releaseIdleConnections();
      await vi.waitFor(() => expect(closed).toHaveLength(1));
      expect(closed[0]).not.toBe(1006);

      // the pool is still usable
      tts.prewarm();
      await vi.waitFor(() => expect(opened).toHaveLength(2));
    } finally {
      for (const client of server.clients) client.terminate();
      await tts.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Inference TTS gateway drain', () => {
  it.each(['close', 'socket error'])('reports %s during synthesis promptly', async (failure) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created', session_id: 'session-1' }));
        } else if (event.type === 'session.flush' && failure === 'close') {
          socket.close(1001);
        }
      });
    });
    const original = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket['send']>
    ) {
      const data = args[0];
      if (
        failure === 'socket error' &&
        typeof data === 'string' &&
        JSON.parse(data).type === 'session.flush'
      ) {
        queueMicrotask(() => this.emit('error', new Error('test transport error')));
      }
      return original.apply(this, args);
    });
    const tts = makeTts({
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 },
    });
    const errors: unknown[] = [];
    tts.on('error', ({ error }) => errors.push(error));
    const synth = tts.stream();
    try {
      synth.updateInputStream(
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue('Hello.');
            controller.close();
          },
        }),
      );
      await vi.waitFor(
        () =>
          expect(errors[0]).toBeInstanceOf(
            failure === 'close' ? APIStatusError : APIConnectionError,
          ),
        { timeout: 1_000 },
      );
    } finally {
      send.mockRestore();
      await synth.close();
      await tts.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['idle', 'synthesizing', 'closed'])(
    'gets the next turn off the %s pooled socket',
    async (state) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      const requests: Array<{ socket: WebSocket; event: Record<string, unknown> }> = [];
      const tts = makeTts({
        baseURL: `http://127.0.0.1:${port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 2_000 },
      });
      server.on('connection', (socket) => {
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          requests.push({ socket, event });
          if (event.type === 'session.create') {
            socket.send(JSON.stringify({ type: 'session.created', session_id: 'session-1' }));
          }
        });
      });
      const synthesize = async () => {
        const synth = tts.stream();
        try {
          synth.updateInputStream(
            new ReadableStream<string>({
              start(controller) {
                controller.enqueue('Hello.');
                controller.close();
              },
            }),
          );
          const output = [];
          for await (const frame of synth) {
            if (typeof frame !== 'symbol') output.push(frame);
          }
          return output;
        } finally {
          await synth.close();
        }
      };
      const sendAudio = (socket: WebSocket) => {
        socket.send(
          JSON.stringify({
            type: 'output_audio',
            session_id: 'session-1',
            audio: Buffer.alloc(640).toString('base64'),
          }),
        );
        socket.send(JSON.stringify({ type: 'done', session_id: 'session-1' }));
      };
      try {
        tts.prewarm();
        await vi.waitFor(() => expect(requests[0]?.event.type).toBe('session.create'));
        const first = requests[0]!.socket;
        expect(requests[0]!.event.handoff_protocol).toBe(1);

        const firstTurn = state === 'synthesizing' ? synthesize() : undefined;
        if (firstTurn) {
          void firstTurn.catch(() => {});
          await vi.waitFor(() =>
            expect(requests.some(({ event }) => event.type === 'session.flush')).toBe(true),
          );
        }

        if (state === 'closed') {
          const closed = once(first, 'close');
          first.close();
          await closed;
        } else {
          first.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'tts-drain' }));
        }
        if (firstTurn) {
          await new Promise((resolve) => setTimeout(resolve, 75));
          expect(requests.filter(({ event }) => event.type === 'session.handoff.complete')).toEqual(
            [],
          );
          sendAudio(first);
          expect(await firstTurn).toHaveLength(1);
        }

        const expectedAck =
          state === 'closed'
            ? []
            : [
                {
                  socket: first,
                  event: { type: 'session.handoff.complete', handoff_id: 'tts-drain' },
                },
              ];
        if (state !== 'closed') {
          await vi.waitFor(() =>
            expect(requests.filter(({ event }) => event.type === 'session.create')).toHaveLength(2),
          );
        }
        expect(requests.filter(({ event }) => event.type === 'session.handoff.complete')).toEqual(
          expectedAck,
        );
        const secondTurn = synthesize();
        void secondTurn.catch(() => {});
        await vi.waitFor(() =>
          expect(requests.filter(({ event }) => event.type === 'session.create')).toHaveLength(2),
        );
        const next = requests.find(({ socket }) => socket !== first)!.socket;
        await vi.waitFor(() =>
          expect(
            requests.some(({ socket, event }) => socket === next && event.type === 'session.flush'),
          ).toBe(true),
        );
        sendAudio(next);
        expect(await secondTurn).toHaveLength(1);
      } finally {
        await tts.close();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe('Inference TTS retry replays the turn', () => {
  const PCM_100MS = Buffer.alloc(16000 * 2 * 0.1).toString('base64');
  const RETRY_OPTIONS: APIConnectOptions = { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 2_000 };

  interface Conn {
    index: number;
    socket: WebSocket;
    events: Record<string, unknown>[];
  }

  async function gateway(onEvent: (conn: Conn, event: Record<string, unknown>) => void) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const conns: Conn[] = [];
    server.on('connection', (socket) => {
      const conn: Conn = { index: conns.length, socket, events: [] };
      conns.push(conn);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        conn.events.push(event);
        onEvent(conn, event);
      });
    });
    return {
      conns,
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  const send = (conn: Conn, event: Record<string, unknown>) =>
    conn.socket.send(JSON.stringify({ session_id: `s${conn.index}`, ...event }));

  const transcripts = (conn: Conn) =>
    conn.events.filter((e) => e.type === 'input_transcript').map((e) => e.transcript as string);

  /** Audio and done for a turn that has text; a bare done for an empty flush. */
  function serveTurn(conn: Conn) {
    if (transcripts(conn).length > 0) send(conn, { type: 'output_audio', audio: PCM_100MS });
    send(conn, { type: 'done' });
  }

  async function drainAll(stream: AsyncIterable<unknown>) {
    const events: Array<'audio' | 'END_OF_STREAM'> = [];
    for await (const event of stream) {
      events.push(typeof event === 'symbol' ? 'END_OF_STREAM' : 'audio');
    }
    return events;
  }

  async function drain(stream: AsyncIterable<unknown>) {
    return (await drainAll(stream)).filter((e) => e === 'audio').length;
  }

  it('sends the same text on the retry connection and speaks it', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      if (conn.index === 0) {
        send(conn, { type: 'error', message: 'boom' });
      } else {
        serveTurn(conn);
      }
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const frames = await drain(stream);

      expect(gw.conns).toHaveLength(2);
      expect(transcripts(gw.conns[0]!)).toEqual(['Hello there. ']);
      expect(transcripts(gw.conns[1]!)).toEqual(['Hello there. ']);
      expect(frames).toBeGreaterThan(0);
      expect(stream.error).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('sends text pushed while the retry is running once, in order', async () => {
    const gw = await gateway((conn, event) => {
      if (conn.index === 0) {
        // the gateway drops the connection while the turn is still being written
        if (event.type === 'input_transcript') conn.socket.close(1011);
        return;
      }
      if (event.type === 'session.flush') serveTurn(conn);
    });
    const tts = makeTts({ baseURL: gw.url });
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('First sentence is lost. ');
      stream.pushText('Second ');
      await vi.waitFor(() => expect(gw.conns).toHaveLength(2));
      stream.pushText('sentence is spoken.');
      stream.endInput();
      const frames = await drain(stream);

      expect(transcripts(gw.conns[1]!).join('')).toBe(
        'First sentence is lost. Second sentence is spoken. ',
      );
      expect(frames).toBeGreaterThan(0);
      expect(stream.error).toBeUndefined();
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('opens no new connection when the stream is closed during the retry delay', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type === 'session.flush') send(conn, { type: 'error', message: 'boom' });
    });
    const tts = makeTts({ baseURL: gw.url });
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      await vi.waitFor(() =>
        expect(gw.conns[0]?.events.map((e) => e.type)).toContain('session.flush'),
      );
      // the first retry waits 100 ms; close well inside it
      await new Promise((resolve) => setTimeout(resolve, 30));
      stream.close();
      await drain(stream);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(gw.conns).toHaveLength(1);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('does not open a second connection after audio, and reports the error once', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      // the stream holds back the newest frame, so send enough for one to reach the consumer
      send(conn, { type: 'output_audio', audio: PCM_100MS });
      send(conn, { type: 'output_audio', audio: PCM_100MS });
      send(conn, { type: 'error', message: 'boom' });
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: Array<{ recoverable: boolean }> = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const frames = await drain(stream);

      expect(gw.conns).toHaveLength(1);
      expect(frames).toBeGreaterThan(0);
      expect(errors.map((e) => e.recoverable)).toEqual([false]);
      expect(stream.error).toBeDefined();
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  const handoffRequest = (conn: Conn) =>
    conn.socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'drain-1' }));

  it('finishes the turn on the draining socket without a retry', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush' || conn.index !== 0) return;
      handoffRequest(conn);
      // the turn is still in flight when the drain request arrives
      setTimeout(() => serveTurn(conn), 50);
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const frames = await drain(stream);

      expect(frames).toBeGreaterThan(0);
      expect(stream.error).toBeUndefined();
      expect(errors).toEqual([]);
      // the text went out once, on the draining socket
      expect(transcripts(gw.conns[0]!)).toEqual(['Hello there. ']);
      for (const conn of gw.conns.slice(1)) expect(transcripts(conn)).toEqual([]);
      // the socket is retired after the turn, not during it
      await vi.waitFor(() =>
        expect(gw.conns[0]!.events.map((e) => e.type)).toContain('session.handoff.complete'),
      );
      const types = gw.conns[0]!.events.map((e) => e.type);
      expect(types.indexOf('session.handoff.complete')).toBeGreaterThan(
        types.indexOf('session.flush'),
      );
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('replays the turn when the draining gateway closes the socket before any audio', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      if (conn.index === 0) {
        handoffRequest(conn);
        conn.socket.close(1001);
      } else {
        serveTurn(conn);
      }
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const frames = await drain(stream);

      expect(frames).toBeGreaterThan(0);
      expect(stream.error).toBeUndefined();
      expect(errors).toEqual([]);
      expect(transcripts(gw.conns[0]!)).toEqual(['Hello there. ']);
      expect(transcripts(gw.conns[1]!)).toEqual(['Hello there. ']);
      // no acknowledgement for a socket that was already closed
      expect(gw.conns[0]!.events.map((e) => e.type)).not.toContain('session.handoff.complete');
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('reports one unrecoverable error when the draining gateway closes the socket after audio', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      send(conn, { type: 'output_audio', audio: PCM_100MS });
      send(conn, { type: 'output_audio', audio: PCM_100MS });
      handoffRequest(conn);
      // let the consumer see the audio before the socket goes away
      setTimeout(() => conn.socket.close(1001), 100);
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: Array<{ recoverable: boolean }> = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const frames = await drain(stream);

      expect(frames).toBeGreaterThan(0);
      expect(errors.map((e) => e.recoverable)).toEqual([false]);
      expect(stream.error).toBeDefined();
      expect(gw.conns).toHaveLength(1);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });
  it('retries with the text when the gateway ends a turn with done and no audio, then speaks it', async () => {
    let flushes = 0;
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      flushes++;
      if (flushes === 1) {
        send(conn, { type: 'done' }); // the turn ends with no audio
      } else {
        serveTurn(conn);
      }
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const events = await drainAll(stream);

      // two turns reached the gateway, both with the whole text, on two connections: a silent
      // `done` takes its socket out of the pool
      expect(gw.conns.map(transcripts)).toEqual([['Hello there. '], ['Hello there. ']]);
      // the silent turn's END_OF_STREAM did not end the consumer's read before the retry's audio
      expect(events.filter((e) => e === 'audio').length).toBeGreaterThan(0);
      expect(events.at(-1)).toBe('END_OF_STREAM');
      expect(events.filter((e) => e === 'END_OF_STREAM')).toHaveLength(1);
      expect(stream.error).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('reports one unrecoverable error when every turn ends with done and no audio', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type === 'session.flush') send(conn, { type: 'done' });
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: Array<{ recoverable: boolean; error: Error }> = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: { ...RETRY_OPTIONS, maxRetry: 2 } });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const events = await drainAll(stream);

      expect(gw.conns.flatMap(transcripts)).toEqual([
        'Hello there. ',
        'Hello there. ',
        'Hello there. ',
      ]);
      expect(events).toEqual([]);
      expect(errors.map((e) => e.recoverable)).toEqual([false]);
      expect(errors[0]!.error.message).toMatch(/no audio frames were pushed/);
      expect(stream.error).toBeDefined();
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('opens a new connection for the retry after a silent done', async () => {
    // the first connection always answers done with no audio; a new one serves the turn
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      if (conn.index === 0) send(conn, { type: 'done' });
      else serveTurn(conn);
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const events = await drainAll(stream);

      expect(gw.conns.map(transcripts)).toEqual([['Hello there. '], ['Hello there. ']]);
      expect(events.filter((e) => e === 'audio').length).toBeGreaterThan(0);
      expect(stream.error).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('acknowledges a pending handoff when a silent done ends the turn', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      if (conn.index === 0) {
        send(conn, { type: 'session.handoff.request', handoff_id: 'h1' });
        send(conn, { type: 'done' });
      } else {
        serveTurn(conn);
      }
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const events = await drainAll(stream);

      expect(events.filter((e) => e === 'audio').length).toBeGreaterThan(0);
      expect(gw.conns).toHaveLength(2);
      expect(gw.conns[0]!.events).toContainEqual({
        type: 'session.handoff.complete',
        handoff_id: 'h1',
      });
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('keeps the connection after a silent done for text that is not speakable', async () => {
    // a gateway that returns no audio for punctuation
    const gw = await gateway((conn, event) => {
      if (event.type === 'session.flush') send(conn, { type: 'done' });
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    try {
      for (let turn = 0; turn < 2; turn++) {
        const stream = tts.stream({ connOptions: RETRY_OPTIONS });
        stream.pushText('...');
        stream.endInput();
        expect(await drainAll(stream)).toEqual(['END_OF_STREAM']);
        stream.close();
      }

      expect(gw.conns).toHaveLength(1); // the second turn reused it
      expect(gw.conns[0]!.events.filter((e) => e.type === 'input_transcript')).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      await tts.close();
      await gw.close();
    }
  });

  it('reports one unrecoverable error at once with maxRetry 0', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type === 'session.flush') send(conn, { type: 'done' });
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: Array<{ recoverable: boolean; error: Error }> = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: { ...RETRY_OPTIONS, maxRetry: 0 } });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const events = await drainAll(stream);

      expect(gw.conns.flatMap(transcripts)).toEqual(['Hello there. ']);
      expect(events).toEqual([]);
      expect(errors.map((e) => e.recoverable)).toEqual([false]);
      expect(errors[0]!.error.message).toMatch(/no audio frames were pushed/);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('retries a turn that the gateway ends with session.closed and no audio', async () => {
    let flushes = 0;
    const gw = await gateway((conn, event) => {
      if (event.type !== 'session.flush') return;
      flushes++;
      if (flushes === 1) send(conn, { type: 'session.closed' });
      else serveTurn(conn);
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('Hello there.');
      stream.endInput();
      const events = await drainAll(stream);

      expect(gw.conns.flatMap(transcripts)).toEqual(['Hello there. ', 'Hello there. ']);
      expect(events.filter((e) => e === 'audio').length).toBeGreaterThan(0);
      expect(events.at(-1)).toBe('END_OF_STREAM');
      expect(stream.error).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });

  it('does not raise for a turn with no text that the gateway ends with done', async () => {
    const gw = await gateway((conn, event) => {
      if (event.type === 'session.flush') send(conn, { type: 'done' });
    });
    const tts = makeTts({ baseURL: gw.url });
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = tts.stream({ connOptions: RETRY_OPTIONS });
    try {
      stream.pushText('   ');
      stream.endInput();
      const events = await drainAll(stream);

      expect(events).toEqual(['END_OF_STREAM']);
      expect(stream.error).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await tts.close();
      await gw.close();
    }
  });
});
