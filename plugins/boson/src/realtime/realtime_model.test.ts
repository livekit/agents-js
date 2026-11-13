// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, DEFAULT_API_CONNECT_OPTIONS, llm, log } from '@livekit/agents';
import type { APIConnectionError } from '@livekit/agents';
import type { realtime } from '@livekit/agents-plugin-openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import {
  RealtimeModel,
  type RealtimeModelOptions,
  RealtimeSession,
  type RealtimeSessionOptionsUpdate,
} from './realtime_model.js';

type WireEvent = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class TestSession extends RealtimeSession {
  sessionUpdate(): realtime.SessionUpdateEvent {
    return this.createSessionUpdateEvent();
  }

  toolUpdate(tools: llm.ToolContext): realtime.SessionUpdateEvent {
    return this.createToolsUpdateEvent(tools);
  }

  chatEvents(ctx: llm.ChatContext) {
    return this.createChatCtxUpdateEvents(ctx);
  }

  closeError(code: number, reason = ''): Error | undefined {
    return this.websocketCloseError(code, reason);
  }

  durationResult(): Error | undefined {
    return this.maxSessionDurationResult();
  }

  hasGeneration(): boolean {
    return this.currentGeneration !== undefined;
  }

  inject(event: WireEvent): void {
    this.emit('openai_server_event_received', event);
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.handleInputAudioBufferSpeechStarted(
          event as unknown as realtime.InputAudioBufferSpeechStartedEvent,
        );
        break;
      case 'input_audio_buffer.speech_stopped':
        this.handleInputAudioBufferSpeechStopped(
          event as unknown as realtime.InputAudioBufferSpeechStoppedEvent,
        );
        break;
      case 'conversation.item.added':
        this.handleConversationItemCreated(
          event as unknown as realtime.ConversationItemCreatedEvent,
        );
        break;
      case 'conversation.item.deleted':
        this.handleConversationItemDeleted(
          event as unknown as realtime.ConversationItemDeletedEvent,
        );
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.handleConversationItemInputAudioTranscriptionCompleted(
          event as unknown as realtime.ConversationItemInputAudioTranscriptionCompletedEvent,
        );
        break;
      case 'response.created':
        this.handleResponseCreated(event as unknown as realtime.ResponseCreatedEvent);
        break;
      case 'response.output_item.added':
        this.handleResponseOutputItemAdded(
          event as unknown as realtime.ResponseOutputItemAddedEvent,
        );
        break;
      case 'response.content_part.added':
        this.handleResponseContentPartAdded(
          event as unknown as realtime.ResponseContentPartAddedEvent,
        );
        break;
      case 'response.output_text.delta':
        this.handleResponseTextDelta(event as unknown as realtime.ResponseTextDeltaEvent);
        break;
      case 'response.output_text.done':
        this.handleResponseTextDone(event as unknown as realtime.ResponseTextDoneEvent);
        break;
      case 'response.output_audio.delta':
        this.handleResponseAudioDelta(event as unknown as realtime.ResponseAudioDeltaEvent);
        break;
      case 'response.output_audio.done':
        this.handleResponseAudioDone(event as unknown as realtime.ResponseAudioDoneEvent);
        break;
      case 'response.output_item.done':
        this.handleResponseOutputItemDone(event as unknown as realtime.ResponseOutputItemDoneEvent);
        break;
      case 'response.done':
        this.handleResponseDone(event as unknown as realtime.ResponseDoneEvent);
        break;
      case 'error':
        this.handleError(event as unknown as realtime.ErrorEvent);
        break;
    }
  }
}

class TestModel extends RealtimeModel {
  override session(options?: llm.RealtimeSessionOptions): TestSession {
    const session = new TestSession(this, options);
    this.sessions.add(session);
    return session;
  }
}

class UnknownProviderTool extends llm.ProviderTool {
  constructor() {
    super({ id: 'provider' });
  }
}

const item = (id: string, role = 'user', text = '') => ({
  id,
  object: 'realtime.item',
  type: 'message',
  role,
  status: 'completed',
  content: text ? [{ type: role === 'assistant' ? 'text' : 'input_text', text }] : [],
});

const added = (id: string, text = '', previous_item_id?: string) => ({
  type: 'conversation.item.added',
  event_id: `event_${id}`,
  previous_item_id,
  item: item(id, 'user', text),
});

const response = (id: string, status = 'in_progress') => ({
  id,
  object: 'realtime.response',
  status,
  status_details: '',
  output: [],
  metadata: {},
});

describe('Boson realtime', () => {
  let server: WebSocketServer;
  let url: string;
  let sockets: WebSocket[];
  let received: WireEvent[][];
  let sessions: RealtimeSession[];

  beforeEach(async () => {
    sockets = [];
    received = [];
    sessions = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('missing server address');
    url = `ws://127.0.0.1:${address.port}/v1/realtime`;
    server.on('connection', (socket) => {
      const events: WireEvent[] = [];
      sockets.push(socket as WebSocket);
      received.push(events);
      socket.on('message', (data) => events.push(JSON.parse(data.toString())));
    });
  });

  afterEach(async () => {
    await Promise.allSettled(sessions.map((session) => session.close()));
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  const model = (options: RealtimeModelOptions = {}) =>
    new TestModel({ url, apiKey: 'test-key', ...options });

  const open = (options: RealtimeModelOptions = {}) => {
    const session = model(options).session();
    sessions.push(session);
    return session;
  };

  const eventually = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('condition not reached');
  };

  const sendServer = (event: WireEvent, connection = 0) => {
    sockets[connection]!.send(JSON.stringify(event));
  };

  it.each([[['text', 'audio']], [[]], [['video']]])(
    'rejects invalid output modalities %#',
    (outputModalities) => {
      expect(() => model({ outputModalities: outputModalities as realtime.Modality[] })).toThrow(
        'outputModalities',
      );
    },
  );

  it.each([
    [{}, 'higgs-realtime'],
    [{ model: 'custom' }, 'custom'],
    [{ apiKey: null }, 'higgs-realtime'],
    [{ url: 'http://localhost:9000/custom' }, 'higgs-realtime'],
  ])('resolves endpoint and API key %#', (options, expected) => {
    const instance = model(options as RealtimeModelOptions);
    expect(instance.model).toBe(expected);
    expect(instance.provider).toBe(new URL(instance._bosonOptions.url).host);
  });

  it.each([undefined, ''])('requires a non-empty environment API key %#', (key) => {
    const old = process.env.BOSON_API_KEY;
    if (key === undefined) delete process.env.BOSON_API_KEY;
    else process.env.BOSON_API_KEY = key;
    expect(() => new RealtimeModel({ url })).toThrow('BOSON_API_KEY');
    if (old === undefined) delete process.env.BOSON_API_KEY;
    else process.env.BOSON_API_KEY = old;
  });

  it.each([
    [{ inputAudioTranscriptionModel: 'higgs-stt-3.1' }, 1_200_000],
    [{ inputAudioTranscription: { model: 'higgs-stt-3.1' } }, 1_200_000],
    [{}, null],
    [{ inputAudioTranscriptionModel: 'x', maxSessionDuration: null }, null],
    [{ maxSessionDuration: 600 }, 600],
  ])('selects the max session duration default %#', (options, expected) => {
    expect(model(options as RealtimeModelOptions)._options.maxSessionDuration).toBe(expected);
  });

  it.each([0, -1, Number.NaN])('rejects non-positive max duration %#', (duration) => {
    expect(() => model({ maxSessionDuration: duration })).toThrow('maxSessionDuration');
  });

  it.each([
    [{}, ['audio'], true, true],
    [{ outputModalities: ['text'] }, ['text'], false, true],
    [{ turnDetection: null }, ['audio'], true, false],
    [{ turnDetection: false }, ['audio'], true, false],
    [{ inputAudioTranscription: { language: 'en' } }, ['audio'], true, true],
    [{ temperature: 0.2 }, ['audio'], true, true],
    [{ inputAudioNoiseReduction: 'near_field' }, ['audio'], true, true],
    [{ inputAudioTranscription: null }, ['audio'], true, true],
  ])('builds the initial session update %#', (options, modalities, audio, vad) => {
    const session = open(options as RealtimeModelOptions);
    const update = session.sessionUpdate().session;
    expect(update.output_modalities).toEqual(modalities);
    expect(session.realtimeModel.capabilities.audioOutput).toBe(audio);
    expect(session.realtimeModel.capabilities.turnDetection).toBe(vad);
  });

  it.each([
    [{ voice: 'coral' }, ['audio', 'output', 'voice'], 'coral'],
    [{ speed: 1.2 }, ['audio', 'output', 'speed'], 1.2],
    [{ temperature: 0.5 }, ['temperature'], 0.5],
    [{ truncation: 'disabled' }, ['truncation'], 'disabled'],
    [{ turnDetection: null }, ['audio', 'input', 'turn_detection'], null],
    [
      { inputAudioTranscription: { model: 'asr' } },
      ['audio', 'input', 'transcription'],
      { model: 'asr' },
    ],
    [
      { inputAudioNoiseReduction: 'near_field' },
      ['audio', 'input', 'noise_reduction'],
      { type: 'near_field' },
    ],
  ])('sends partial option updates %#', (update, path, expected) => {
    const session = open();
    session.updateOptions(update as RealtimeSessionOptionsUpdate);
    const full = session.sessionUpdate().session as WireEvent;
    let value: unknown = full;
    for (const key of path as string[]) value = (value as WireEvent)[key];
    expect(value).toEqual(expected);
  });

  it('session updates send only changed fields', async () => {
    const session = open();
    await eventually(() => received[0]?.length === 1);
    session.updateOptions({ voice: 'coral' });
    await eventually(() => received[0]!.length === 2);
    expect(received[0]![1]!.session).toEqual({
      type: 'realtime',
      audio: { output: { voice: 'coral' } },
    });
  });

  it('reconnect config carries partial updates', async () => {
    const session = open({ inputAudioTranscription: { model: 'asr', language: 'en' } });
    session.updateOptions({
      turnDetection: { type: 'server_vad', threshold: 0.7 },
      inputAudioTranscription: { model: 'asr-v2' },
    });
    const input = (session.sessionUpdate().session.audio as WireEvent).input;
    expect(input.transcription).toEqual({ model: 'asr-v2', language: 'en' });
    expect(input.turn_detection).toMatchObject({ threshold: 0.7, silence_duration_ms: 500 });
  });

  it('model options recursively merge and propagate', async () => {
    const instance = model({ inputAudioTranscriptionModel: 'asr' });
    const session = instance.session();
    sessions.push(session);
    instance.updateOptions({ inputAudioTranscription: { language: 'fr' } });
    expect((session.sessionUpdate().session.audio as WireEvent).input.transcription).toEqual({
      model: 'asr',
      language: 'fr',
    });
  });

  it('unsupported tool types are omitted', () => {
    const session = open();
    const warning = vi.spyOn(log(), 'warn');
    const context = new llm.ToolContext([new UnknownProviderTool()]);
    expect(session.toolUpdate(context).session.tools).toEqual([]);
    expect(session.toolUpdate(context).session.tools).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('function tool schemas use the Boson shape', () => {
    const session = open();
    const tool = llm.tool({
      name: 'lookup',
      description: 'Lookup',
      meta: { provider: 'local' },
      execute: async () => 'ok',
    });
    const tools = session.toolUpdate(new llm.ToolContext([tool])).session.tools!;
    expect(tools[0]).toMatchObject({ type: 'function', name: 'lookup', description: 'Lookup' });
    expect(tools[0]).not.toHaveProperty('meta');
    session.updateOptions({
      toolChoice: { type: 'function', function: { name: 'lookup' } },
    });
    expect(session.sessionUpdate().session.tool_choice).toEqual({
      type: 'function',
      name: 'lookup',
    });
  });

  it('transcription configuration tracks the active model', () => {
    const session = open({ inputAudioTranscriptionModel: 'higgs-stt-3.1' });
    const collected = vi.fn();
    session.on('metrics_collected', collected);
    expect(session.realtimeModel.capabilities.userTranscription).toBe(true);
    session.updateOptions({ inputAudioTranscription: { model: 'higgs-stt-4' } });
    expect(
      ((session.sessionUpdate().session.audio as WireEvent).input.transcription as WireEvent).model,
    ).toBe('higgs-stt-4');
    session.inject(added('user'));
    session.inject({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'transcription',
      item_id: 'user',
      content_index: 0,
      transcript: 'hello',
      usage: { type: 'duration', seconds: 1.5 },
    });
    expect(collected).toHaveBeenCalledWith(
      expect.objectContaining({
        audioDurationMs: 1500,
        metadata: expect.objectContaining({ modelName: 'higgs-stt-4' }),
      }),
    );
  });

  it.each([
    [['text'], { type: 'text', text: '' }],
    [['audio'], { type: 'audio', transcript: '' }],
  ])('streams generation output %#', async (modalities, part) => {
    const session = open({ outputModalities: modalities as realtime.Modality[] });
    const generationPromise = session.generateReply();
    await eventually(() => received[0]?.some((event) => event.type === 'response.create') ?? false);
    const create = received[0]!.find((event) => event.type === 'response.create')!;
    sendServer({
      type: 'response.created',
      event_id: 'created',
      response: { ...response('resp'), metadata: { client_event_id: create.event_id } },
    });
    const generation = await generationPromise;
    expect(generation.responseId).toBe('resp');
    sendServer({
      type: 'response.output_item.added',
      event_id: 'out',
      response_id: 'resp',
      output_index: 0,
      item: item('assistant', 'assistant'),
    });
    sendServer({
      type: 'response.content_part.added',
      event_id: 'part',
      response_id: 'resp',
      item_id: 'assistant',
      output_index: 0,
      content_index: 0,
      part,
    });
    const message = (await generation.messageStream.getReader().read()).value!;
    expect(await message.modalities).toEqual(part.type === 'text' ? ['text'] : ['audio', 'text']);
    if (part.type === 'text') {
      sendServer({
        type: 'response.output_text.delta',
        event_id: 'text_delta',
        response_id: 'resp',
        item_id: 'assistant',
        output_index: 0,
        content_index: 0,
        delta: 'Hi.',
      });
      expect((await message.textStream.getReader().read()).value).toBe('Hi.');
    } else {
      sendServer({
        type: 'response.output_audio.delta',
        event_id: 'audio_delta',
        response_id: 'resp',
        item_id: 'assistant',
        output_index: 0,
        content_index: 0,
        delta: Buffer.alloc(480).toString('base64'),
      });
      const frame = (await message.audioStream.getReader().read()).value!;
      expect([frame.sampleRate, frame.channels, frame.samplesPerChannel]).toEqual([24000, 1, 240]);
    }
    sendServer({
      type: 'response.output_item.done',
      event_id: 'item_done',
      response_id: 'resp',
      output_index: 0,
      item: item('assistant', 'assistant'),
    });
    sendServer({
      type: 'response.done',
      event_id: 'response_done',
      response: { ...response('resp', 'completed'), usage: null },
    });
    await eventually(() => !session.hasGeneration());
  });

  it('per-response instructions ride in response.create', async () => {
    const session = open();
    await session.updateInstructions('Base.');
    void session.generateReply('Extra.').catch(() => {});
    await eventually(() => received[0]?.some((event) => event.type === 'response.create') ?? false);
    const event = received[0]!.find((candidate) => candidate.type === 'response.create')!;
    expect(event.response.instructions).toBe('Base.\nExtra.');
  });

  it('per-response tools are not sent', async () => {
    const session = open();
    void session.generateReply(undefined, { toolChoice: 'none', tools: [] }).catch(() => {});
    await eventually(() => received[0]?.some((event) => event.type === 'response.create') ?? false);
    const event = received[0]!.find((candidate) => candidate.type === 'response.create')!;
    expect(event.response?.tools).toBeUndefined();
    expect(event.response?.tool_choice).toBeUndefined();
  });

  it('a discarded response keeps an active generation', async () => {
    const session = open();
    const generations: llm.GenerationCreatedEvent[] = [];
    session.on('generation_created', (event) => generations.push(event));
    await eventually(() => sockets.length === 1);
    sendServer({ type: 'response.created', event_id: 'active', response: response('active') });
    await eventually(() => generations.length === 1);
    sendServer({
      type: 'response.output_item.added',
      event_id: 'active_item',
      response_id: 'active',
      output_index: 0,
      item: item('active_item', 'assistant'),
    });
    sendServer({
      type: 'response.content_part.added',
      event_id: 'active_part',
      response_id: 'active',
      item_id: 'active_item',
      output_index: 0,
      content_index: 0,
      part: { type: 'text', text: '' },
    });
    const activeMessage = (await generations[0]!.messageStream.getReader().read()).value!;
    const activeText = activeMessage.textStream.getReader();

    const controller = new AbortController();
    const discarded = session.generateReply(undefined, { signal: controller.signal });
    await eventually(() => received[0]?.some((event) => event.type === 'response.create') ?? false);
    const create = received[0]!.find((event) => event.type === 'response.create')!;
    controller.abort();
    await expect(discarded).rejects.toThrow('aborted');
    sendServer({
      type: 'response.created',
      event_id: 'stale_created',
      response: {
        ...response('stale'),
        metadata: { client_event_id: create.event_id },
      },
    });
    await eventually(
      () =>
        received[0]?.some(
          (event) => event.type === 'response.cancel' && event.response_id === 'stale',
        ) ?? false,
    );
    expect(session.hasGeneration()).toBe(true);
    sendServer({
      type: 'response.done',
      event_id: 'stale_done',
      response: response('stale', 'cancelled'),
    });
    expect(session.hasGeneration()).toBe(true);
    sendServer({
      type: 'response.output_text.delta',
      event_id: 'active_delta',
      response_id: 'active',
      item_id: 'active_item',
      output_index: 0,
      content_index: 0,
      delta: 'still active',
    });
    expect((await activeText.read()).value).toBe('still active');
    sendServer({
      type: 'response.done',
      event_id: 'active_done',
      response: response('active', 'completed'),
    });
    await eventually(() => !session.hasGeneration());
  });

  it('a discarded response without an active generation is skipped', async () => {
    const session = open();
    const controller = new AbortController();
    const discarded = session.generateReply(undefined, { signal: controller.signal });
    await eventually(() => received[0]?.some((event) => event.type === 'response.create') ?? false);
    const create = received[0]!.find((event) => event.type === 'response.create')!;
    controller.abort();
    await expect(discarded).rejects.toThrow('aborted');
    sendServer({
      type: 'response.created',
      event_id: 'created',
      response: { ...response('stale'), metadata: { client_event_id: create.event_id } },
    });
    await eventually(() => session.hasGeneration());
    sendServer({
      type: 'response.done',
      event_id: 'done',
      response: response('stale', 'cancelled'),
    });
    await eventually(() => !session.hasGeneration());
  });

  it('a superseded response still records call arguments', () => {
    const session = open();
    const call = {
      id: 'call_item',
      object: 'realtime.item',
      type: 'function_call',
      call_id: 'call',
      name: 'lookup',
      arguments: '',
    };
    session.inject({ type: 'conversation.item.added', event_id: 'i', item: call });
    session.inject({ type: 'response.created', event_id: 'b', response: response('b') });
    session.inject({
      type: 'response.output_item.done',
      event_id: 'd',
      response_id: 'old',
      output_index: 0,
      item: { ...call, arguments: '{"city":"Paris"}' },
    });
    expect((session.chatCtx.getById('call_item') as llm.FunctionCall).args).toContain('Paris');
  });

  it('stale response.done does not corrupt a newer generation', () => {
    const session = open();
    session.inject({ type: 'response.created', event_id: 'a', response: response('a') });
    session.inject({ type: 'response.created', event_id: 'b', response: response('b') });
    session.inject({ type: 'response.done', event_id: 'ad', response: response('a', 'completed') });
    expect(() =>
      session.inject({
        type: 'response.done',
        event_id: 'bd',
        response: response('b', 'completed'),
      }),
    ).not.toThrow();
  });

  it('late scoped events after completion are dropped', () => {
    const session = open();
    expect(() =>
      session.inject({
        type: 'response.output_text.delta',
        event_id: 'late',
        response_id: 'old',
        item_id: 'old_item',
        output_index: 0,
        content_index: 0,
        delta: 'late',
      }),
    ).not.toThrow();
  });

  it('discarded trailing events do not attach to another response', () => {
    const session = open();
    session.inject({ type: 'response.created', event_id: 'a', response: response('a') });
    expect(() =>
      session.inject({
        type: 'response.output_item.added',
        event_id: 'x',
        response_id: 'discarded',
        output_index: 0,
        item: item('x', 'assistant'),
      }),
    ).not.toThrow();
  });

  it.each([
    [undefined, true],
    [{ type: 'server_vad', interrupt_response: false }, true],
    [null, false],
  ])(
    'interrupt suppresses the duplicate server-VAD cancel %#',
    async (turnDetection, serverVad) => {
      const session = open({
        turnDetection: turnDetection as RealtimeModelOptions['turnDetection'],
      });
      await eventually(() => received[0]?.length === 1);
      session.inject({ type: 'response.created', event_id: 'r', response: response('r') });
      const before = received[0]?.length ?? 0;
      session.on('input_speech_started', () => void session.interrupt());
      session.inject({
        type: 'input_audio_buffer.speech_started',
        event_id: 'speech',
        item_id: 'user',
        audio_start_ms: 0,
      });
      if (serverVad) await new Promise((resolve) => setTimeout(resolve, 10));
      else await eventually(() => (received[0]?.length ?? 0) > before);
      expect((received[0]?.length ?? 0) - before).toBe(serverVad ? 0 : 1);
    },
  );

  it.each([
    [[added('user', 'first'), added('user', 'first second')], 'first second'],
    [
      [
        added('user'),
        {
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: 't',
          item_id: 'user',
          content_index: 0,
          transcript: 'hello',
        },
      ],
      'hello',
    ],
    [
      [
        added('user', 'hello'),
        {
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: 't',
          item_id: 'user',
          content_index: 0,
          transcript: 'hello world',
        },
      ],
      'hello world',
    ],
  ])('remote item text follows merged server turns %#', (events, expected) => {
    const session = open();
    for (const event of events) session.inject(event);
    expect((session.chatCtx.getById('user') as llm.ChatMessage).textContent).toBe(expected);
  });

  it('transcription carries the first fragment turn timestamp', () => {
    const session = open();
    const completed = vi.fn();
    session.on('input_audio_transcription_completed', completed);
    session.inject({
      type: 'input_audio_buffer.speech_started',
      event_id: 's1',
      item_id: 'user',
      audio_start_ms: 0,
    });
    session.inject(added('user'));
    session.inject({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 't1',
      item_id: 'user',
      content_index: 0,
      transcript: 'first',
      logprobs: [{ logprob: -0.1 }, { logprob: -2 }],
    });
    session.inject({
      type: 'input_audio_buffer.speech_started',
      event_id: 's2',
      item_id: 'user',
      audio_start_ms: 10,
    });
    session.inject({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 't2',
      item_id: 'user',
      content_index: 0,
      transcript: 'merged',
    });
    expect(completed.mock.calls[0]![0].turnStartedAt).toBe(
      completed.mock.calls[1]![0].turnStartedAt,
    );
    expect(completed.mock.calls[0]![0].confidence).toBeCloseTo(Math.exp(-1.05));
  });

  it('tracks the server-assigned session id', () => {
    const session = open();
    session.inject({ type: 'session.created', event_id: 'created', session: { id: 'sess_1' } });
    expect(session.sessionId).toBe('sess_1');
  });

  it.each([
    ['assistant', 'text'],
    ['user', 'input_text'],
  ])('chat context items use Boson content shape %#', async (role, contentType) => {
    const session = open();
    const ctx = new llm.ChatContext([
      llm.ChatMessage.create({ id: 'message', role: role as llm.ChatRole, content: 'hello' }),
    ]);
    const update = session.updateChatCtx(ctx);
    await eventually(
      () => received[0]?.some((event) => event.type === 'conversation.item.create') ?? false,
    );
    const create = received[0]!.find((event) => event.type === 'conversation.item.create')!;
    expect(create.previous_item_id).toBeNull();
    expect(create.item).toMatchObject({
      id: 'message',
      object: 'realtime.item',
      type: 'message',
      role,
      content: [{ type: contentType, text: 'hello' }],
    });
    sendServer({
      type: 'conversation.item.added',
      event_id: 'echo',
      previous_item_id: null,
      item: create.item,
    });
    await expect(update).resolves.toBeUndefined();
  });

  it.each(['system', 'developer'])(
    'skips unsupported role %s and remaps predecessors',
    async (role) => {
      const session = open();
      const ctx = new llm.ChatContext([
        llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' }),
        llm.ChatMessage.create({ id: 'skip', role: role as llm.ChatRole, content: 'skip' }),
        llm.ChatMessage.create({ id: 'two', role: 'user', content: 'two' }),
      ]);
      const update = session.updateChatCtx(ctx);
      await eventually(
        () =>
          (received[0]?.filter((event) => event.type === 'conversation.item.create').length ??
            0) === 2,
      );
      const creates = received[0]!.filter((event) => event.type === 'conversation.item.create');
      expect(creates.map((event) => [event.item.id, event.previous_item_id])).toEqual([
        ['one', null],
        ['two', 'one'],
      ]);
      for (const create of creates) {
        sendServer({
          type: 'conversation.item.added',
          event_id: `echo_${create.item.id}`,
          previous_item_id: create.previous_item_id,
          item: create.item,
        });
      }
      await expect(update).resolves.toBeUndefined();
    },
  );

  it('deletes removed chat context items', async () => {
    const session = open();
    session.inject(added('one', 'one'));
    const update = session.updateChatCtx(new llm.ChatContext());
    await eventually(
      () => received[0]?.some((event) => event.type === 'conversation.item.delete') ?? false,
    );
    const deletion = received[0]!.find((event) => event.type === 'conversation.item.delete')!;
    expect(deletion.item_id).toBe('one');
    sendServer({ type: 'conversation.item.deleted', event_id: 'deleted', item_id: 'one' });
    await expect(update).resolves.toBeUndefined();
  });

  it('rebuilds the conversation for a head insert', async () => {
    const session = open();
    session.inject(added('one', 'one'));
    const ctx = new llm.ChatContext([
      llm.ChatMessage.create({ id: 'summary', role: 'assistant', content: 'summary' }),
      llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' }),
    ]);
    expect((await session.chatEvents(ctx)).map((event) => event.type)).toEqual([
      'conversation.item.delete',
      'conversation.item.create',
      'conversation.item.create',
    ]);
  });

  it('an unsupported role at the head does not rebuild', async () => {
    const session = open();
    session.inject(added('one', 'one'));
    const events = await session.chatEvents(
      new llm.ChatContext([
        llm.ChatMessage.create({ id: 'system', role: 'system', content: 'prompt' }),
        llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' }),
      ]),
    );
    expect(events).toEqual([]);
  });

  it('a head text change rebuilds instead of reordering', async () => {
    const session = open();
    session.inject(added('one', 'one'));
    session.inject(added('two', 'two', 'one'));
    const events = await session.chatEvents(
      new llm.ChatContext([
        llm.ChatMessage.create({ id: 'one', role: 'user', content: 'changed' }),
        llm.ChatMessage.create({ id: 'two', role: 'user', content: 'two' }),
      ]),
    );
    expect(events).toHaveLength(4);
  });

  it('rebuild reports turns it cannot put back', async () => {
    const session = open();
    session.inject(added('audio'));
    const events = await session.chatEvents(
      new llm.ChatContext([
        llm.ChatMessage.create({ id: 'summary', role: 'assistant', content: 'summary' }),
        llm.ChatMessage.create({ id: 'audio', role: 'user', content: [] }),
      ]),
    );
    expect(events.filter((event) => event.type === 'conversation.item.create')).toHaveLength(1);
  });

  it('an emptied turn is deleted rather than recreated', async () => {
    const session = open();
    session.inject(added('one', 'one'));
    const events = await session.chatEvents(
      new llm.ChatContext([llm.ChatMessage.create({ id: 'one', role: 'user', content: [] })]),
    );
    expect(events.map((event) => event.type)).toEqual(['conversation.item.delete']);
  });

  it.each(['insufficient_quota', 'monthly_cap_reached', 'contract_ended', 'no_billing_account'])(
    'entitlement refusal %s is non-recoverable',
    async (code) => {
      const session = open({
        connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 5 },
      });
      const errors: llm.RealtimeModelError[] = [];
      session.on('error', (event) => errors.push(event));
      await eventually(() => sockets.length === 1);
      await eventually(() => (received[0]?.length ?? 0) > 0);
      sendServer({
        type: 'error',
        event_id: 'error',
        error: { type: 'insufficient_quota', code, message: 'refused', param: '' },
      });
      await eventually(() => errors.length === 1);
      expect(errors[0]!.recoverable).toBe(false);
      expect(errors[0]!.error).toBeInstanceOf(APIError);
      expect((errors[0]!.error as APIError).retryable).toBe(false);
    },
  );

  it.each([
    ['bad_request', false, 1],
    ['input_audio_buffer_commit_empty', true, 0],
    ['response_not_active', true, 0],
    ['response_id_mismatch', true, 0],
  ])('reports or suppresses Boson errors %#', async (code, serverVad, count) => {
    const session = open({ turnDetection: serverVad ? undefined : null });
    const errors = vi.fn();
    session.on('error', errors);
    await eventually(() => sockets.length === 1);
    sendServer({
      type: 'error',
      event_id: 'e',
      error: { type: 'invalid_request_error', code, message: 'error', param: '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(errors).toHaveBeenCalledTimes(count);
  });

  it('an error fails only the generateReply it names', async () => {
    const session = open();
    session.on('error', () => {});
    const pending = session.generateReply();
    await eventually(() => received[0]?.some((event) => event.type === 'response.create') ?? false);
    const create = received[0]!.find((event) => event.type === 'response.create')!;
    sendServer({
      type: 'error',
      event_id: 'server',
      error: {
        type: 'invalid_request_error',
        code: 'bad',
        message: 'failed',
        param: '',
        event_id: create.event_id,
      },
    });
    await expect(pending).rejects.toThrow('failed');
  });

  it.each([false, true])(
    'invalid previous item fails chat sync promptly %#',
    async (withEventId) => {
      const session = open();
      session.inject(added('one', 'one'));
      const ctx = new llm.ChatContext([
        llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' }),
        llm.ChatMessage.create({ id: 'two', role: 'user', content: 'two' }),
      ]);
      const update = session.updateChatCtx(ctx);
      await eventually(
        () =>
          received[0]?.some(
            (event) => event.type === 'conversation.item.create' && event.item.id === 'two',
          ) ?? false,
      );
      const create = received[0]!.find(
        (event) => event.type === 'conversation.item.create' && event.item.id === 'two',
      )!;
      session.inject({
        type: 'error',
        event_id: 'server_error',
        error: {
          type: 'invalid_previous_item_id',
          message: "previous_item_id 'one' not found",
          param: '',
          item_id: 'two',
          ...(withEventId ? { event_id: create.event_id } : {}),
        },
      });
      await expect(update).rejects.toThrow("previous_item_id 'one' not found");
    },
  );

  it.each([false, true])('a rejected item settles its own create %#', async (fatal) => {
    const session = open();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (event) => errors.push(event));
    const update = session.updateChatCtx(
      new llm.ChatContext([llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' })]),
    );
    await eventually(
      () => received[0]?.some((event) => event.type === 'conversation.item.create') ?? false,
    );
    const create = received[0]!.find((event) => event.type === 'conversation.item.create')!;
    const error = {
      type: fatal ? 'insufficient_quota' : 'invalid_request_error',
      code: fatal ? 'monthly_cap_reached' : 'item_rejected',
      message: 'rejected',
      param: '',
      event_id: create.event_id,
    };
    sendServer({ type: 'error', event_id: 'server_error', error });
    await expect(update).resolves.toBeUndefined();
    if (fatal) {
      await eventually(() => errors.length === 1);
      expect(errors[0]!.recoverable).toBe(false);
    } else {
      expect(errors).toEqual([]);
    }
  });

  it('a rejected item tolerates a later echo', async () => {
    const session = open();
    const update = session.updateChatCtx(
      new llm.ChatContext([llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' })]),
    );
    await eventually(
      () => received[0]?.some((event) => event.type === 'conversation.item.create') ?? false,
    );
    const create = received[0]!.find((event) => event.type === 'conversation.item.create')!;
    sendServer({
      type: 'error',
      event_id: 'rejected',
      error: {
        type: 'invalid_request_error',
        code: 'item_rejected',
        message: 'rejected',
        param: '',
        event_id: create.event_id,
      },
    });
    sendServer({
      type: 'conversation.item.added',
      event_id: 'late_echo',
      previous_item_id: null,
      item: create.item,
    });
    await expect(update).resolves.toBeUndefined();
  });

  it.each(['unattributable', 'stale-item'])(
    'unmatched invalid previous item blames nobody: %s',
    async () => {
      const session = open();
      const update = session.updateChatCtx(
        new llm.ChatContext([llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' })]),
      );
      await eventually(
        () => received[0]?.some((event) => event.type === 'conversation.item.create') ?? false,
      );
      const create = received[0]!.find((event) => event.type === 'conversation.item.create')!;
      sendServer({
        type: 'error',
        event_id: 'unmatched',
        error: { type: 'invalid_previous_item_id', message: 'missing', param: '' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      let settled = false;
      void update.finally(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      sendServer({
        type: 'conversation.item.added',
        event_id: 'echo',
        previous_item_id: null,
        item: create.item,
      });
      await expect(update).resolves.toBeUndefined();
    },
  );

  it('concurrent chat updates retain the correlated sync error', async () => {
    const session = open();
    session.inject(added('one', 'one'));
    const first = session.updateChatCtx(
      new llm.ChatContext([
        llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' }),
        llm.ChatMessage.create({ id: 'two', role: 'user', content: 'two' }),
      ]),
    );
    const second = session.updateChatCtx(
      new llm.ChatContext([llm.ChatMessage.create({ id: 'one', role: 'user', content: 'one' })]),
    );
    await eventually(
      () =>
        received[0]?.some(
          (event) => event.type === 'conversation.item.create' && event.item.id === 'two',
        ) ?? false,
    );
    sendServer({
      type: 'error',
      event_id: 'invalid',
      error: {
        type: 'invalid_previous_item_id',
        message: "previous_item_id 'one' not found",
        param: '',
        item_id: 'two',
      },
    });
    await expect(first).rejects.toThrow("previous_item_id 'one' not found");
    await expect(second).resolves.toBeUndefined();
  });

  it.each([
    [1006, true],
    [3000, false],
  ])('WebSocket close fails a pending generateReply %#', async (code, retryable) => {
    const session = open({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 5 },
    });
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (event) => errors.push(event));
    const pending = session.generateReply();
    await eventually(() => received[0]?.some((event) => event.type === 'response.create') ?? false);
    if (code === 3000) sockets[0]!.close(3000, 'Invalid API key');
    else sockets[0]!.terminate();
    await expect(pending).rejects.toThrow();
    await eventually(() => errors.length > 0);
    expect(errors.at(-1)!.recoverable).toBe(false);
    expect((errors.at(-1)!.error as APIConnectionError).retryable).toBe(retryable);
  });

  it.each([
    [4429, false],
    [3000, false],
    [1006, true],
    ['idle', false],
  ])('terminal connection failures stop or exhaust retries %#', async (code, retryable) => {
    const session = open({
      ...(code === 1006 ? { url: 'ws://127.0.0.1:1/v1/realtime' } : {}),
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 2, retryIntervalMs: 5 },
    });
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (event) => errors.push(event));
    if (code === 1006) {
      await eventually(() => errors.some((event) => !event.recoverable));
      expect(errors.map((event) => event.recoverable)).toEqual([true, true, false]);
    } else {
      await eventually(() => sockets.length === 1);
      if (code === 'idle') {
        sendServer({ type: 'session.idle_timeout', seconds_idle: 120 });
        sockets[0]!.close(1000, 'idle');
      } else {
        sockets[0]!.close(Number(code), 'terminal');
      }
      await eventually(() => errors.length === 1);
      expect(sockets).toHaveLength(1);
      expect(errors[0]!.recoverable).toBe(false);
    }
    expect(retryable).toBe(code === 1006);
  });

  it('reconnect replay preserves user and tool item payloads', async () => {
    const session = open();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (event) => errors.push(event));
    await eventually(() => sockets.length === 1);
    sendServer({
      type: 'conversation.item.added',
      event_id: 'user_added',
      previous_item_id: null,
      item: item('user', 'user', 'hello'),
    });
    sendServer({
      type: 'conversation.item.added',
      event_id: 'call_added',
      previous_item_id: 'user',
      item: {
        id: 'call',
        object: 'realtime.item',
        type: 'function_call',
        call_id: 'long-call-id',
        name: 'lookup',
        arguments: '{}',
        status: 'completed',
      },
    });
    sendServer({
      type: 'conversation.item.added',
      event_id: 'output_added',
      previous_item_id: 'call',
      item: {
        id: 'output',
        object: 'realtime.item',
        type: 'function_call_output',
        call_id: 'long-call-id',
        output: 'sunny',
        status: 'completed',
      },
    });
    await eventually(() => session.chatCtx.items.length === 3);
    sockets[0]!.terminate();
    await eventually(() => sockets.length === 2);
    await eventually(
      () =>
        (received[1]?.filter((event) => event.type === 'conversation.item.create').length ?? 0) ===
        3,
    );
    const creates = received[1]!.filter((event) => event.type === 'conversation.item.create');
    expect(creates.map((event) => event.previous_item_id)).toEqual([null, 'user', 'call']);
    expect(creates.map((event) => event.item)).toMatchObject([
      { id: 'user', object: 'realtime.item', type: 'message' },
      { id: 'call', object: 'realtime.item', type: 'function_call', status: 'completed' },
      {
        id: 'output',
        object: 'realtime.item',
        type: 'function_call_output',
        status: 'completed',
      },
    ]);
    expect(errors[0]!.recoverable).toBe(true);
  });

  it('server item IDs are sent without shortening', async () => {
    const callItemId = 'fd1c99fd-6798-4b02-aa27-0c173b1ff1da';
    const callId = 'chatcmpl-tool-303f9ba2eef6422cbfd4cf2dcad3108f';
    const session = open();
    await eventually(() => sockets.length === 1);
    sendServer({
      type: 'conversation.item.added',
      event_id: 'call_added',
      previous_item_id: null,
      item: {
        id: callItemId,
        object: 'realtime.item',
        type: 'function_call',
        call_id: callId,
        name: 'lookup',
        arguments: '{}',
      },
    });
    await eventually(() => session.chatCtx.getById(callItemId) !== undefined);
    const ctx = session.chatCtx.copy();
    ctx.items.push(llm.FunctionCallOutput.create({ callId, output: 'sunny', isError: false }));
    const update = session.updateChatCtx(ctx);
    await eventually(
      () =>
        received[0]?.some(
          (event) =>
            event.type === 'conversation.item.create' && event.previous_item_id === callItemId,
        ) ?? false,
    );
    const create = received[0]!.find(
      (event) => event.type === 'conversation.item.create' && event.previous_item_id === callItemId,
    )!;
    expect(create.item.call_id).toBe(callId);
    sendServer({
      type: 'conversation.item.added',
      event_id: 'output_echo',
      previous_item_id: callItemId,
      item: create.item,
    });
    await expect(update).resolves.toBeUndefined();
  });

  it('configured max duration is a planned recycle', async () => {
    const session = open({ maxSessionDuration: 50 });
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (event) => errors.push(event));
    await session.updateInstructions('Be thorough.');
    await eventually(() => sockets.length === 2);
    await eventually(() => (received[1]?.length ?? 0) > 0);
    expect(errors).toEqual([]);
    expect(received[1]![0]).toMatchObject({
      type: 'session.update',
      session: { instructions: 'Be thorough.' },
    });
  });

  it('server max-duration notice makes the close a planned recycle', async () => {
    const session = open({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 5 },
    });
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (event) => errors.push(event));
    await eventually(() => sockets.length === 1);
    sendServer(added('user', 'hello'));
    sendServer({ type: 'session.max_duration_reached', max_duration_sec: 7200 });
    await eventually(() => session.chatCtx.getById('user') !== undefined);
    sockets[0]!.close(1000, 'max duration');
    await eventually(() => sockets.length === 2);
    await eventually(
      () => received[1]?.some((event) => event.type === 'conversation.item.create') ?? false,
    );
    expect(errors).toEqual([]);
    expect(received[1]!.find((event) => event.type === 'conversation.item.create')).toMatchObject({
      previous_item_id: null,
      item: { id: 'user' },
    });
  });

  it('close promptly terminates an open session', async () => {
    const session = open();
    const reports: unknown[] = [];
    const onUnhandled = (reason: unknown) => reports.push(reason);
    process.on('unhandledRejection', onUnhandled);
    await eventually(() => sockets.length === 1);
    sockets[0]!.close(3000, 'refused');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(session.close()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(reports).toEqual([]);
  });
});
