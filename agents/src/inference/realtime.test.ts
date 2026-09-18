// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import type * as apiProto from '../llm/openai_realtime/api_proto.js';
import { Task } from '../utils.js';
import { RealtimeModel, type RealtimeModelOptions, RealtimeSession } from './realtime.js';
import * as inferenceUtils from './utils.js';

class TestRealtimeSession extends RealtimeSession {
  sessionUpdate(): apiProto.SessionUpdateEvent {
    return this.createSessionUpdateEvent();
  }

  fatal(error: unknown): boolean {
    return this.isFatalError(error);
  }

  connect(): Promise<WebSocket> {
    return this.createWsConn();
  }
}

function stubTaskRuntime(): void {
  vi.spyOn(Task, 'from').mockReturnValue({
    cancel: vi.fn(),
    done: true,
    result: Promise.resolve(undefined),
  } as unknown as Task<void>);
}

describe('inference RealtimeModel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is publicly exported with its canonical label', async () => {
    const inference = await import('./index.js');
    expect(inference.RealtimeModel).toBe(RealtimeModel);
    expect(inference.RealtimeSession).toBe(RealtimeSession);
    expect(
      new RealtimeModel({
        model: 'openai/gpt-realtime',
        apiKey: 'key',
        apiSecret: 'secret',
      }).label(),
    ).toBe('inference.RealtimeModel');
  });

  it('requires a provider-prefixed model', () => {
    expect(
      () => new RealtimeModel({ model: 'gpt-realtime', apiKey: 'key', apiSecret: 'secret' }),
    ).toThrow('provider-prefixed');
  });

  it.each([
    ['apiKey', 'apiKey is required'],
    ['apiSecret', 'apiSecret is required'],
  ] as const)('requires LiveKit %s', (missing, message) => {
    vi.stubEnv('LIVEKIT_INFERENCE_API_KEY', '');
    vi.stubEnv('LIVEKIT_API_KEY', '');
    vi.stubEnv('LIVEKIT_INFERENCE_API_SECRET', '');
    vi.stubEnv('LIVEKIT_API_SECRET', '');
    const options = {
      model: 'openai/gpt-realtime',
      apiKey: 'key',
      apiSecret: 'secret',
      [missing]: undefined,
    };
    expect(() => new RealtimeModel(options)).toThrow(message);
  });

  it('resolves credentials and URL from the inference environment', () => {
    vi.stubEnv('LIVEKIT_INFERENCE_API_KEY', 'inference-key');
    vi.stubEnv('LIVEKIT_INFERENCE_API_SECRET', 'inference-secret');
    vi.stubEnv('LIVEKIT_INFERENCE_URL', 'https://inference.example/v1');

    const model = new RealtimeModel({ model: 'openai/gpt-realtime' });

    expect(model._inferenceOptions).toMatchObject({
      apiKey: 'inference-key',
      apiSecret: 'inference-secret',
    });
    expect(model._options.baseURL).toBe('https://inference.example/v1');
  });

  it('uses OpenAI wire format and omits the gateway model field', () => {
    stubTaskRuntime();
    vi.stubEnv('OPENAI_API_VERSION', '2025-04-01-preview');
    vi.stubEnv('AZURE_OPENAI_ENDPOINT', 'https://azure.example');
    const model = new RealtimeModel({
      model: 'openai/gpt-realtime',
      baseURL: 'https://inference.example/v1',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const session = new TestRealtimeSession(model);
    const event = session.sessionUpdate();

    expect(event.session.type).toBe('realtime');
    expect(event.session.model).toBeUndefined();
  });

  it('refreshes LiveKit auth and sends inference routing headers for each connection', async () => {
    stubTaskRuntime();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected TCP address');

    const authorizations: Array<string | undefined> = [];
    const priorities: Array<string | undefined> = [];
    const providers: Array<string | undefined> = [];
    server.on('connection', (socket, request) => {
      authorizations.push(request.headers.authorization);
      priorities.push(request.headers['x-livekit-inference-priority'] as string | undefined);
      providers.push(request.headers['x-livekit-inference-provider'] as string | undefined);
      socket.close();
    });
    vi.spyOn(inferenceUtils, 'createAccessToken')
      .mockResolvedValueOnce('token-one')
      .mockResolvedValueOnce('token-two');

    const model = new RealtimeModel({
      model: 'openai/gpt-realtime',
      provider: 'openai',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'key',
      apiSecret: 'secret',
      inferenceClass: 'priority',
    });
    const session = new TestRealtimeSession(model);
    const first = await session.connect();
    const second = await session.connect();
    first.close();
    second.close();
    await vi.waitFor(() => expect(authorizations).toHaveLength(2));

    expect(authorizations).toEqual(['Bearer token-one', 'Bearer token-two']);
    expect(priorities).toEqual(['priority', 'priority']);
    expect(providers).toEqual(['openai', 'openai']);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each([
    'unsupported_transcription_model',
    'unsupported_audio_transport',
    'unsupported_audio_format',
    'insufficient_quota',
  ])('treats gateway configuration error %s as fatal', (code) => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'openai/gpt-realtime',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    expect(new TestRealtimeSession(model).fatal({ code })).toBe(true);
  });

  it('treats malformed and invalid-audio gateway errors as recoverable', () => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'openai/gpt-realtime',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const session = new TestRealtimeSession(model);

    expect(session.fatal({ code: 'invalid_audio_payload' })).toBe(false);
    expect(session.fatal({ code: ['unsupported_audio_transport'] })).toBe(false);
  });

  it('uses gateway-compatible xAI defaults', () => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'xai/grok-voice-latest',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const event = new TestRealtimeSession(model).sessionUpdate();

    expect(model._options.voice).toBe('eve');
    expect(model.capabilities.turnDetection).toBe(true);
    expect(model.capabilities.canDisableTurnDetection).toBe(true);
    expect(event.session.audio?.input?.transcription?.model).toBe('grok-transcribe');
    expect(event.session.audio?.input?.turn_detection?.type).toBe('server_vad');
  });

  it('allows xAI defaults to be overridden', () => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'xai/grok-voice-latest',
      apiKey: 'key',
      apiSecret: 'secret',
      voice: 'Ara',
      inputAudioTranscription: null,
      turnDetection: null,
    });
    const event = new TestRealtimeSession(model).sessionUpdate();

    expect(model._options.voice).toBe('Ara');
    expect(model.capabilities.turnDetection).toBe(false);
    expect(model.capabilities.canDisableTurnDetection).toBe(false);
    expect(event.session.audio?.input?.transcription).toBeNull();
    expect(event.session.audio?.input?.turn_detection).toBeNull();
  });

  it('preserves explicit xAI turn detection', () => {
    const turnDetection: apiProto.TurnDetectionType = {
      type: 'server_vad',
      threshold: 0.8,
      create_response: false,
      interrupt_response: false,
    };
    const model = new RealtimeModel({
      model: 'xai/grok-voice-latest',
      apiKey: 'key',
      apiSecret: 'secret',
      turnDetection,
    });

    expect(model._options.turnDetection).toBe(turnDetection);
    expect(model.capabilities.turnDetection).toBe(true);
    expect(model.capabilities.canDisableTurnDetection).toBe(false);
  });

  it('does not expose the deprecated temperature option', () => {
    const options: RealtimeModelOptions = {
      model: 'openai/gpt-realtime',
      // @ts-expect-error temperature is intentionally absent from the hosted API.
      temperature: 0.8,
    };
    expect(options).toHaveProperty('temperature', 0.8);
  });
});
