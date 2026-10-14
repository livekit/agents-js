// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import * as llm from '../llm/index.js';
import type * as apiProto from '../llm/openai_realtime/api_proto.js';
import {
  DiscardedGeneration,
  type ResponseGeneration,
} from '../llm/openai_realtime/realtime_model.js';
import * as stream from '../stream/index.js';
import { Future, Task, type TimedString } from '../utils.js';
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

  it('emits one final transcript per turn on hosted xAI sessions', () => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'xai/grok-voice-think-fast-3.0',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as {
      currentGeneration?: ResponseGeneration | DiscardedGeneration;
      handleConversationItemInputAudioTranscriptionCompleted: (
        event: apiProto.ConversationItemInputAudioTranscriptionCompletedEvent,
      ) => void;
      handleResponseAudioDelta: (event: apiProto.ResponseAudioDeltaEvent) => void;
      remoteChatCtx: llm.RemoteChatContext;
    };
    session.currentGeneration = new DiscardedGeneration();
    session.remoteChatCtx.insert(
      undefined,
      new llm.ChatMessage({ id: 'item_1', role: 'user', content: [''] }),
    );
    const emitted: llm.InputTranscriptionCompleted[] = [];
    realtimeSession.on('input_audio_transcription_completed', (event) => emitted.push(event));

    session.handleConversationItemInputAudioTranscriptionCompleted({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt',
      item_id: 'item_1',
      content_index: 0,
      transcript: 'Hello, how',
      status: 'in_progress',
    });
    session.handleConversationItemInputAudioTranscriptionCompleted({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt',
      item_id: 'item_1',
      content_index: 0,
      transcript: 'Hello, how are you? Last ones.',
      status: 'completed',
    });
    session.handleConversationItemInputAudioTranscriptionCompleted({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt',
      item_id: 'item_1',
      content_index: 0,
      transcript: 'Hello, how are you? Last once. I paid twice.',
      status: 'completed',
    });
    expect(emitted.filter((event) => event.isFinal)).toEqual([]);

    session.handleResponseAudioDelta({
      type: 'response.audio.delta',
      event_id: 'evt',
      item_id: 'reply',
      response_id: 'resp',
      output_index: 0,
      content_index: 0,
      delta: '',
    });

    expect(
      emitted.filter((event) => event.isFinal).map((event) => [event.itemId, event.transcript]),
    ).toEqual([['item_1', 'Hello, how are you? Last once. I paid twice.']]);
    const item = session.remoteChatCtx.get('item_1')?.item as llm.ChatMessage;
    expect(item.content).toEqual(['Hello, how are you? Last once. I paid twice.']);
  });

  it('finalizes transcripts immediately on hosted OpenAI sessions', () => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'openai/gpt-realtime',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as {
      handleConversationItemInputAudioTranscriptionCompleted: (
        event: apiProto.ConversationItemInputAudioTranscriptionCompletedEvent,
      ) => void;
    };
    const emitted: llm.InputTranscriptionCompleted[] = [];
    realtimeSession.on('input_audio_transcription_completed', (event) => emitted.push(event));

    session.handleConversationItemInputAudioTranscriptionCompleted({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt',
      item_id: 'item_1',
      content_index: 0,
      transcript: 'what is the weather',
    });

    expect(emitted).toEqual([
      {
        itemId: 'item_1',
        transcript: 'what is the weather',
        isFinal: true,
      },
    ]);
  });

  it('preserves held turns in chat context updates and appends unanchored items on hosted xAI', async () => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'xai/grok-voice-think-fast-3.0',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as {
      createChatCtxUpdateEvents: (
        chatCtx: llm.ChatContext,
      ) => Promise<(apiProto.ConversationItemCreateEvent | apiProto.ConversationItemDeleteEvent)[]>;
      handleConversationItemCreated: (event: apiProto.ConversationItemCreatedEvent) => void;
      handleConversationItemInputAudioTranscriptionCompleted: (
        event: apiProto.ConversationItemInputAudioTranscriptionCompletedEvent,
      ) => void;
      remoteChatCtx: llm.RemoteChatContext;
    };
    session.remoteChatCtx.insert(
      undefined,
      new llm.ChatMessage({ id: 'earlier', role: 'assistant', content: ['hi'] }),
    );
    session.remoteChatCtx.insert(
      'earlier',
      new llm.ChatMessage({ id: 'item_1', role: 'user', content: [''] }),
    );
    session.remoteChatCtx.insert(
      'item_1',
      new llm.ChatMessage({ id: 'reply', role: 'assistant', content: ['the full reply'] }),
    );
    session.handleConversationItemInputAudioTranscriptionCompleted({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt',
      item_id: 'item_1',
      content_index: 0,
      transcript: 'are you there',
      status: 'completed',
    });

    const agentCtx = new llm.ChatContext([
      new llm.ChatMessage({ id: 'earlier', role: 'assistant', content: ['hi'] }),
      new llm.ChatMessage({ id: 'reply', role: 'assistant', content: ['the trunc'] }),
    ]);
    const events = await session.createChatCtxUpdateEvents(agentCtx);
    const deleted = events
      .filter(
        (event): event is apiProto.ConversationItemDeleteEvent =>
          event.type === 'conversation.item.delete',
      )
      .map((event) => event.item_id);
    const created = Object.fromEntries(
      events
        .filter(
          (event): event is apiProto.ConversationItemCreateEvent =>
            event.type === 'conversation.item.create',
        )
        .map((event) => [event.item.id, event.previous_item_id]),
    );
    expect(deleted).not.toContain('item_1');
    expect(created).toEqual({ reply: 'item_1' });

    session.handleConversationItemCreated({
      type: 'conversation.item.added',
      event_id: 'evt',
      previous_item_id: '',
      item: {
        id: 'tail_item',
        object: 'realtime.item',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    } as unknown as apiProto.ConversationItemCreatedEvent);
    expect(session.remoteChatCtx.toChatCtx().items.map((item) => item.id)).toEqual([
      'earlier',
      'item_1',
      'reply',
      'tail_item',
    ]);
  });

  it('discards an interrupted response that never spoke on hosted xAI', async () => {
    stubTaskRuntime();
    const model = new RealtimeModel({
      model: 'xai/grok-voice-think-fast-3.0',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    const realtimeSession = model.session();
    const session = realtimeSession as unknown as {
      currentGeneration?: ResponseGeneration | DiscardedGeneration;
      handleResponseCreated: (event: apiProto.ResponseCreatedEvent) => void;
      remoteChatCtx: llm.RemoteChatContext;
    };
    session.handleResponseCreated({
      type: 'response.created',
      event_id: 'evt',
      response: {
        id: 'resp',
        object: 'realtime.response',
        status: 'in_progress',
        status_details: 'in_progress',
        output: [],
      },
    });
    session.remoteChatCtx.insert(
      undefined,
      new llm.ChatMessage({ id: 'phantom', role: 'assistant', content: [] }),
    );
    const generation = session.currentGeneration as ResponseGeneration;
    generation.messages.set('phantom', {
      messageId: 'phantom',
      textChannel: stream.createStreamChannel<string | TimedString>(),
      audioChannel: stream.createStreamChannel(),
      audioTranscript: '',
      modalities: new Future<('text' | 'audio')[]>(),
    });

    await realtimeSession.interrupt();

    expect(generation._doneFut.done).toBe(true);
    expect(session.currentGeneration).toBeInstanceOf(DiscardedGeneration);
  });
});
