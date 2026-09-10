// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm, log, type metrics, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { CodeInterpreter, FileSearch, WebSearch } from '../tools.js';
import {
  type GPTLiveDelegation,
  GPTLiveModel,
  type GPTLiveModelOptions,
  type GPTLiveSession,
} from './gpt_live_model.js';
import type * as GPTLive from './gpt_live_types.js';

initializeLogger({ pretty: false, level: 'silent' });
const weather = llm.tool({
  name: 'getWeather',
  description: 'Get the weather.',
  parameters: z.object({ location: z.string() }),
  execute: async () => 'rainy',
});
const tools = new llm.ToolContext([weather]);
const pcm = (duration = 100, level = 0, rate = 24000, channels = 1) => {
  const samples = new Int16Array(((rate * duration) / 1000) * channels);
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.trunc(level * 32767) * (i % 2 ? -1 : 1);
  return new AudioFrame(samples, rate, channels, samples.length / channels);
};
const transcript = (
  role: 'user' | 'assistant',
  delta: string,
  start: number,
): GPTLive.ServerEvent => ({
  type: role === 'user' ? 'session.input_transcript.delta' : 'session.output_transcript.delta',
  delta,
  start_ms: start,
  end_ms: start + 200,
});
const callDone = (callId: string): GPTLive.ResponsesEvent => ({
  type: 'response.output_item.done',
  item: {
    id: `fc_${callId}`,
    type: 'function_call',
    call_id: callId,
    name: 'getWeather',
    arguments: '{"location":"Paris"}',
  },
});
const completed = (): GPTLive.ResponsesEvent => ({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    model: 'gpt-5.6-sol',
    usage: {
      input_tokens: 376,
      input_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 },
      output_tokens: 18,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 394,
    },
  },
});
const output = (callId: string) =>
  new llm.FunctionCallOutput({ callId, name: 'getWeather', output: 'rainy', isError: false });

class Server {
  readonly server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  readonly sockets: WebSocket[] = [];
  readonly sent: GPTLive.ClientEvent[][] = [];
  autoStart = true;
  autoClose = true;
  closeUsage = 0;
  closeReason: Extract<GPTLive.ServerEvent, { type: 'session.closed' }>['reason'] =
    'close_requested';
  requests: { url: string | undefined; headers: Record<string, unknown> }[] = [];
  constructor() {
    this.server.on('connection', (ws, req) => {
      const events: GPTLive.ClientEvent[] = [];
      const index = this.sockets.length;
      this.sockets.push(ws);
      this.sent.push(events);
      this.requests.push({ url: req.url, headers: req.headers });
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString()) as GPTLive.ClientEvent;
        events.push(event);
        if (event.type === 'session.start' && this.autoStart)
          ws.send(JSON.stringify({ type: 'session.started', session: { id: `live_${index}` } }));
        if (event.type === 'session.close' && this.autoClose)
          ws.send(
            JSON.stringify({
              type: 'session.closed',
              reason: this.closeReason,
              usage: { seconds: this.closeUsage },
            } satisfies GPTLive.ServerEvent),
          );
      });
    });
  }
  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
  events(index = 0): GPTLive.ClientEvent[] {
    return this.sent[index] ?? [];
  }
  async send(
    session: GPTLiveSession,
    event: GPTLive.ServerEvent,
    index = this.sockets.length - 1,
  ): Promise<void> {
    const received = once(session, 'openai_server_event_received');
    this.sockets[index]!.send(JSON.stringify(event));
    await received;
  }
  response(
    session: GPTLiveSession,
    event: GPTLive.ResponsesEvent,
    delegationId: string | null = 'd1',
  ): Promise<void> {
    return this.send(session, { type: 'response.event', delegation_id: delegationId, event });
  }
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
let server: Server;
let sessions: GPTLiveSession[];
const create = (options: GPTLiveModelOptions = {}) => {
  const session = new GPTLiveModel({
    apiKey: 'sk-test',
    baseURL: server.url,
    ...options,
  }).session();
  session.on('error', () => {});
  sessions.push(session);
  return session;
};
const ready = async (session: GPTLiveSession) => {
  await session._updateSession();
  await vi.waitFor(() => expect(session.sessionId).toBeDefined());
};
const waitCount = async (count: number, index = 0) =>
  vi.waitFor(() => expect(server.events(index)).toHaveLength(count));
const startConfig = (index = 0): GPTLive.SessionConfig => {
  const event = server.events(index)[0];
  if (event?.type !== 'session.start') throw new Error('Missing session.start');
  return event.session;
};

beforeEach(async () => {
  sessions = [];
  server = new Server();
  await once(server.server, 'listening');
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.map((session) => session.close()));
  await server.stop();
  vi.restoreAllMocks();
});

describe('GPTLiveModel', () => {
  it('holds the connection tick and rides out sentence pauses with its audio gate', () => {
    const model = new GPTLiveModel({ apiKey: 'test' });
    const gate = model.audioGate();
    for (const level of [0.000578, 0.000093, 0.000027, 0.000013, 0])
      expect(gate.update(pcm(100, level))).toBe(false);
    expect(gate.update(pcm(100, 0.005))).toBe(true);
    for (let i = 0; i < 5; i++) expect(gate.update(pcm())).toBe(true);
    expect(gate.update(pcm(100, 0.005))).toBe(true);
    for (let i = 0; i < 9; i++) gate.update(pcm());
    expect(gate.update(pcm())).toBe(false);
  });

  it.each([
    'aster',
    'beacon',
    'cinder',
    'marin',
    'stone',
    'vesper',
    'future-voice',
    { id: 'voice_test' },
  ])('sends the complete startup configuration with voice %j unchanged', async (selectedVoice) => {
    const session = create({ voice: selectedVoice });
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    await server.send(session, { type: 'session.updated' });
    expect(server.events()).toEqual([]);
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'a prior turn' });
    await session._updateSession('Be concise.', ctx, tools);
    await waitCount(1);
    expect(startConfig()).toMatchObject({
      model: 'gpt-live-1',
      instructions: 'Be concise.',
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: selectedVoice } },
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a prior turn' }] },
      ],
      delegation: {
        type: 'responses',
        responses: {
          model: 'gpt-5.6-luna',
          tools: [{ name: 'getWeather', parameters: { required: ['location'] } }],
        },
      },
    });
    expect(server.requests[0]).toMatchObject({
      url: '/v1/live/sessions',
      headers: {
        authorization: 'Bearer sk-test',
        'user-agent': 'LiveKit Agents',
      },
    });
    expect(server.requests[0]?.headers).not.toHaveProperty('openai-alpha');
  });

  it.each(['config', 'ack', 'immediate'] as const)(
    'closes promptly while waiting for %s',
    async (stage) => {
      server.autoStart = false;
      const session = create();
      if (stage !== 'immediate') await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
      if (stage === 'ack') {
        await session._updateSession();
        await waitCount(1);
        session.appendCommentary('hello');
      }
      const start = performance.now();
      await session.close();
      expect(performance.now() - start).toBeLessThan(500);
      expect(await session.audioStream.getReader().read()).toMatchObject({ done: true });
    },
  );

  it('sends custom voices and all backend options without dropping false values', async () => {
    const session = create({
      voice: { id: 'voice_123' },
      responsesOptions: {
        model: 'backend',
        instructions: 'Use tools.',
        parallelToolCalls: false,
        toolChoice: { type: 'function', function: { name: 'getWeather' } },
        reasoning: { effort: 'medium' },
        text: { verbosity: 'low' },
        serviceTier: 'priority',
        maxOutputTokens: 32,
      },
    });
    await ready(session);
    expect(startConfig()).toMatchObject({
      audio: { output: { voice: { id: 'voice_123' } } },
      delegation: {
        responses: {
          model: 'backend',
          instructions: 'Use tools.',
          parallel_tool_calls: false,
          tool_choice: { type: 'function', name: 'getWeather' },
          reasoning: { effort: 'medium' },
          text: { verbosity: 'low' },
          service_tier: 'priority',
          max_output_tokens: 32,
        },
      },
    });
  });

  it('preserves function schemas and tool context order with hosted tools', async () => {
    const session = create();
    class OtherProviderTool extends llm.ProviderTool {}
    const raw = llm.tool({
      name: 'raw',
      description: 'Raw schema',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: async () => 'ok',
    });
    await session._updateSession(
      '',
      undefined,
      new llm.ToolContext([
        raw,
        new WebSearch({ searchContextSize: 'low' }),
        new OtherProviderTool({ id: 'other' }),
        weather,
        new FileSearch({ vectorStoreIds: ['vs_1'] }),
        new CodeInterpreter({ container: 'c1' }),
      ]),
    );
    await waitCount(1);
    expect(startConfig().delegation).toMatchObject({
      responses: {
        tools: [
          { name: 'raw', parameters: { required: ['value'] } },
          { name: 'getWeather' },
          { type: 'web_search', search_context_size: 'low' },
          { type: 'file_search', vector_store_ids: ['vs_1'] },
          { type: 'code_interpreter', container: 'c1' },
        ],
      },
    });
  });

  it('refuses changed startup instructions and sends only sparse backend updates', async () => {
    const session = create();
    await session._updateSession('Be concise.');
    await vi.waitFor(() => expect(session.sessionId).toBeDefined());
    await session._updateInstructions('Be concise.');
    await expect(session._updateInstructions('Be verbose.')).rejects.toThrow('immutable');
    expect(startConfig().delegation).toEqual({
      type: 'responses',
      responses: { model: 'gpt-5.6-luna' },
    });
    await session._updateTools(tools);
    session._updateOptions({ toolChoice: 'required' });
    session._updateOptions({ toolChoice: null });
    await session._updateTools(llm.ToolContext.empty());
    await waitCount(5);
    expect(server.events()[1]).toMatchObject({
      type: 'session.update',
      session: { delegation: { responses: { tools: [{ name: 'getWeather' }] } } },
    });
    expect(
      server
        .events()
        .slice(2)
        .map((event) => event.type === 'session.update' && event.session),
    ).toEqual([
      { delegation: { type: 'responses', responses: { tool_choice: 'required' } } },
      { delegation: { type: 'responses', responses: { tool_choice: 'auto' } } },
      { delegation: { type: 'responses', responses: { tools: [] } } },
    ]);
  });

  it('waits specifically for session.started before sending commands or audio', async () => {
    server.autoStart = false;
    const session = create();
    await session._updateSession();
    await waitCount(1);
    session._generateReply('Greet the caller.');
    session.pushAudio(pcm());
    await server.send(session, { type: 'session.updated' });
    expect(server.events().map((event) => event.type)).toEqual(['session.start']);
    expect(session.sessionId).toBeUndefined();
    await server.send(session, { type: 'session.started', session: { id: 'live_test' } });
    await waitCount(3);
    expect(server.events()[1]).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: null,
      content:
        'Immediately follow the instruction below. Do not wait for the caller to speak first. After that, pause and listen.\n\nGreet the caller.',
    });
    expect(server.events()[2]?.type).toBe('session.input_audio.append');
  });

  it('times out missing startup acknowledgments and exhausts the retry budget', async () => {
    server.autoStart = false;
    const session = create({
      connOptions: { timeoutMs: 100, maxRetry: 1, retryIntervalMs: 10 },
    });
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));
    await session._updateSession();
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors.map((error) => error.recoverable)).toEqual([true, false]);
    expect(errors.map((error) => error.error.name)).toEqual(['APITimeoutError', 'APITimeoutError']);
    expect(server.sockets).toHaveLength(2);
    expect(await session.audioStream.getReader().read()).toMatchObject({ done: true });
  });

  it('preserves retries across sockets that disconnect before session.started', async () => {
    server.autoStart = false;
    const session = create({
      connOptions: { timeoutMs: 1000, maxRetry: 2, retryIntervalMs: 10 },
    });
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));
    await session._updateSession();
    for (let index = 0; index < 3; index++) {
      await waitCount(1, index);
      server.sockets[index]!.terminate();
    }
    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors.map((error) => error.recoverable)).toEqual([true, true, false]);
    expect(await session.audioStream.getReader().read()).toMatchObject({ done: true });
    expect(server.sockets).toHaveLength(3);
  });

  it('starts the acknowledgment deadline after configuration and clears it on startup', async () => {
    const session = create({
      connOptions: { timeoutMs: 100, maxRetry: 0, retryIntervalMs: 10 },
    });
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    await delay(150);
    expect(server.events()).toEqual([]);
    await ready(session);
    await delay(150);
    session.appendThinking('Still connected.');
    await waitCount(2);
    expect(errors).toEqual([]);
  });

  it('resets the retry budget once a reconnected session starts', async () => {
    server.autoStart = false;
    const session = create({
      connOptions: { timeoutMs: 1000, maxRetry: 1, retryIntervalMs: 10 },
    });
    const errors: llm.RealtimeModelError[] = [];
    const reconnected = vi.fn();
    session.on('error', (error) => errors.push(error));
    session.on('session_reconnected', reconnected);
    await session._updateSession();
    await waitCount(1);
    server.sockets[0]!.terminate();
    await waitCount(1, 1);
    expect(reconnected).not.toHaveBeenCalled();
    server.autoStart = true;
    await server.send(session, { type: 'session.started', session: { id: 'live_1' } });
    expect(reconnected).toHaveBeenCalledOnce();
    server.sockets[1]!.terminate();
    await vi.waitFor(() => expect(session.sessionId).toBe('live_2'));
    expect(errors.map((error) => error.recoverable)).toEqual([true, true]);
    expect(reconnected).toHaveBeenCalledTimes(2);
  });

  it('delivers client delegations with the pending transcript and answers by id', async () => {
    const session = create({ delegation: 'client' });
    const delegations: GPTLiveDelegation[] = [];
    session.on('delegation_created', (event) => delegations.push(event));
    await ready(session);
    expect(session.capabilities.midSessionToolsUpdate).toBe(false);
    expect(startConfig().delegation).toEqual({ type: 'client' });
    await server.send(session, {
      type: 'session.delegation.created',
      delegation: { id: 'backend', target: 'responses' },
    });
    await server.send(session, transcript('user', 'What is the weather', 1000));
    await server.send(session, {
      type: 'session.delegation.created',
      delegation: { id: 'd1', target: 'client' },
    });
    expect(delegations).toEqual([{ id: 'd1', pendingTranscript: 'What is the weather' }]);
    session.appendCommentary('62 and raining.', { delegationId: 'd1' });
    session.appendThinking('Still checking.', { delegationId: 'd1' });
    await waitCount(3);
    expect(server.events().slice(1)).toMatchObject([
      { type: 'session.commentary.append', delegation_id: 'd1', content: '62 and raining.' },
      { type: 'session.thinking.append', delegation_id: 'd1', content: 'Still checking.' },
    ]);
  });

  it('does not block commands or finish speech on delayed context acknowledgments', async () => {
    const model = new GPTLiveModel({ apiKey: 'sk-test', baseURL: server.url });
    const session = model.session();
    sessions.push(session);
    vi.spyOn(model, 'session').mockReturnValue(session);
    const adapted = new llm.DuplexRealtimeAdapter(model).session();
    const generations: llm.GenerationCreatedEvent[] = [];
    const errors: llm.RealtimeModelError[] = [];
    adapted.on('generation_created', (event) => generations.push(event));
    adapted.on('error', (event) => errors.push(event));
    try {
      await adapted._updateSession();
      await vi.waitFor(() => expect(session.sessionId).toBeDefined());
      session.appendInstructions('Be concise.');
      session.appendThinking('The caller is returning a chair.');
      session.appendCommentary('Ask for the order number.');
      session.pushAudio(pcm());
      await waitCount(5);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await vi.advanceTimersByTimeAsync(model._opts.connOptions.timeoutMs * 2);
      vi.useRealTimers();
      expect(server.events().map((event) => event.type)).toEqual([
        'session.start',
        'session.instructions.append',
        'session.thinking.append',
        'session.commentary.append',
        'session.input_audio.append',
      ]);
      expect(errors).toEqual([]);
      expect(generations).toEqual([]);

      const speech = {
        type: 'session.output_audio.delta',
        delta: Buffer.from(pcm(100, 0.2).data.buffer).toString('base64'),
      } satisfies GPTLive.ServerEvent;
      await server.send(session, transcript('assistant', 'What is', 0));
      await server.send(session, speech);
      await vi.waitFor(() => expect(generations).toHaveLength(1));
      const messages = generations[0]!.messageStream.getReader();
      const message = (await messages.read()).value!;
      const audio = message.audioStream.getReader();
      expect((await audio.read()).value?.samplesPerChannel).toBe(2400);
      let nextArrived = false;
      const nextAudio = audio.read().then((value) => {
        nextArrived = true;
        return value;
      });
      const acknowledgmentTypes = [
        'session.instructions.appended',
        'session.thinking.appended',
        'session.commentary.appended',
      ] as const;
      for (const [index, type] of acknowledgmentTypes.entries()) {
        await server.send(session, { type, client_event_id: server.events()[index + 1]!.event_id });
        await setImmediate();
        expect(nextArrived).toBe(false);
        expect(generations).toHaveLength(1);
        expect(adapted.chatCtx.items).toEqual([]);
      }
      await server.send(session, transcript('assistant', ' your order number?', 100));
      await server.send(session, speech);
      expect((await nextAudio).value?.samplesPerChannel).toBe(2400);
      for (let i = 0; i < 8; i++)
        await server.send(session, {
          type: 'session.output_audio.delta',
          delta: Buffer.from(pcm().data.buffer).toString('base64'),
        });
      while (!(await audio.read()).done) {
        /* Drain the trailing silence. */
      }
      const chunks: string[] = [];
      for await (const chunk of message.textStream)
        chunks.push(typeof chunk === 'string' ? chunk : chunk.text);
      expect(chunks.join('')).toBe('What is your order number?');
      expect((await messages.read()).done).toBe(true);
      expect(generations).toHaveLength(1);
      expect(errors).toEqual([]);
      audio.releaseLock();
      messages.releaseLock();
    } finally {
      vi.useRealTimers();
      await adapted.close();
      await model.close();
    }
  });

  it('rejects tools under client delegation and accepts an empty tool list', async () => {
    const session = create({ delegation: 'client' });
    await expect(session._updateSession('Be concise.', undefined, tools)).rejects.toThrow(
      'no tool channel',
    );
    await expect(session._updateTools(new llm.ToolContext([new WebSearch()]))).rejects.toThrow(
      'no tool channel',
    );
    await session._updateSession('Be concise.', undefined, llm.ToolContext.empty());
    await waitCount(1);
    expect(session.tools.flatten()).toEqual([]);
  });

  it('keeps null delegation ids and supports input mute commands', async () => {
    const session = create();
    await ready(session);
    session.appendThinking('Premium customer.');
    session.appendInstructions('Speak slowly.');
    session.appendCommentary('Hello.');
    session.muteInput();
    session.unmuteInput();
    await waitCount(6);
    for (const event of server.events().slice(1, 4))
      expect(event).toHaveProperty('delegation_id', null);
    expect(
      server
        .events()
        .slice(4)
        .map((event) => event.type),
    ).toEqual(['session.input_audio.mute', 'session.input_audio.unmute']);
  });

  it('forwards every output frame, including silence, and handles stream cancellation', async () => {
    const session = create();
    await ready(session);
    const reader = session.audioStream.getReader();
    for (let i = 0; i < 3; i++) {
      await server.send(session, {
        type: 'session.output_audio.delta',
        delta: Buffer.alloc(4800).toString('base64'),
      });
      const { value } = await reader.read();
      expect(value?.frame.sampleRate).toBe(24000);
      expect(value?.frame.samplesPerChannel).toBe(2400);
      expect(value?.startMs).toBeUndefined();
    }
    await reader.cancel();
    await server.send(session, {
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(4800).toString('base64'),
    });
    await session.close();
  });

  it('resamples input, handles channel and rate changes, and sends 100 ms chunks', async () => {
    const session = create();
    await ready(session);
    session.pushAudio(pcm(200, 0, 48000, 2));
    await vi.waitFor(() => expect(server.events().length).toBeGreaterThan(1));
    session.pushAudio(pcm(200));
    await vi.waitFor(() => expect(server.events().length).toBeGreaterThan(2));
    for (const event of server.events().slice(1)) {
      expect(event.type).toBe('session.input_audio.append');
      if (event.type === 'session.input_audio.append') {
        const bytes = Buffer.from(event.audio, 'base64');
        expect(bytes).toHaveLength(4800);
        for (let offset = 0; offset < bytes.length; offset += 2)
          expect(Math.abs(bytes.readInt16LE(offset))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('queues a tool result before completing the response and then continues once', async () => {
    const session = create();
    const calls: llm.FunctionCall[] = [];
    session.on('function_call', (call) => calls.push(call));
    await ready(session);
    await server.response(session, { type: 'response.created' });
    await server.response(session, callDone('c1'));
    expect(calls.map((call) => [call.callId, call.name, call.args])).toEqual([
      ['c1', 'getWeather', '{"location":"Paris"}'],
    ]);
    await session._appendItems([output('c1')]);
    await waitCount(2);
    expect(server.events()[1]).toMatchObject({
      type: 'response.item.create',
      item: { type: 'function_call_output', call_id: 'c1', output: 'rainy' },
    });
    await server.response(session, completed());
    await waitCount(3);
    expect(server.events()[2]?.type).toBe('response.create');
    await session._appendItems([output('c1')]);
    await waitCount(4);
    expect(server.events()[3]?.type).toBe('session.thinking.append');
  });

  it('waits for every result in a parallel batch, including null delegation ids', async () => {
    const session = create();
    await ready(session);
    await server.response(session, { type: 'response.created' }, null);
    await server.response(session, callDone('a'), null);
    await server.response(session, callDone('b'), null);
    await server.response(session, completed(), null);
    await session._appendItems([output('a')]);
    await waitCount(2);
    expect(server.events()[1]?.type).toBe('response.item.create');
    await session._appendItems([output('b')]);
    await waitCount(4);
    expect(
      server
        .events()
        .slice(1)
        .map((event) => event.type),
    ).toEqual(['response.item.create', 'response.item.create', 'response.create']);
  });

  it.each(['response.failed', 'response.incomplete'])(
    'clears tool routing after %s',
    async (type) => {
      const session = create();
      await ready(session);
      await server.response(session, { type: 'response.created' });
      await server.response(session, callDone('a'));
      await server.response(session, { type });
      await session._appendItems([output('a')]);
      await waitCount(2);
      expect(server.events()[1]?.type).toBe('session.thinking.append');
    },
  );

  it('ignores incomplete function items and accepts complete calls without response.created', async () => {
    const session = create();
    const calls = vi.fn();
    session.on('function_call', calls);
    await ready(session);
    await server.response(session, {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'bad' },
    });
    expect(calls).not.toHaveBeenCalled();
    await server.response(session, callDone('a'));
    await session._appendItems([output('a')]);
    await waitCount(3);
    expect(server.events().at(-1)?.type).toBe('response.create');
  });

  it.each([
    'close_requested',
    'expired',
    'content',
    'remote_hangup',
    'connection_lost',
    null,
    undefined,
  ] as const)(
    'logs close reason %s and drains final usage separately from backend tokens',
    async (reason) => {
      const debug = vi.spyOn(log(), 'debug');
      const session = create();
      const collected: (metrics.AgentMetrics & { reasoningTokens?: number })[] = [];
      session.on('metrics_collected', (metric) => collected.push(metric));
      await ready(session);
      await server.send(session, {
        type: 'session.usage.updated',
        usage: { seconds: 14 },
        context_window: { usage_ratio: 0.2 },
      });
      await server.response(session, completed());
      server.closeUsage = 27;
      server.closeReason = reason;
      await session.close();
      expect(debug).toHaveBeenCalledWith(
        { reason: reason ?? null, sessionId: 'live_0' },
        'GPT-Live session closed',
      );
      expect(collected.filter((metric) => metric.type === 'llm_metrics')).toMatchObject([
        {
          requestId: 'resp_1',
          promptTokens: 376,
          promptCachedTokens: 100,
          cacheCreationTokens: 20,
          completionTokens: 18,
          reasoningTokens: 5,
          metadata: { modelName: 'gpt-5.6-sol' },
        },
      ]);
      const frontend = collected.filter(
        (metric): metric is metrics.RealtimeModelMetrics =>
          metric.type === 'realtime_model_metrics' && metric.sessionDurationMs !== undefined,
      );
      expect(frontend.map((metric) => metric.sessionDurationMs)).toEqual([14000, 13000]);
      expect(
        frontend.every((metric) => metric.inputTokens === 0 && metric.outputTokens === 0),
      ).toBe(true);
    },
  );

  it('bounds the close drain when the service never sends session.closed', async () => {
    const session = create();
    await ready(session);
    server.autoClose = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    vi.useRealTimers();
  });

  it('mirrors growing transcripts and reseeds them in order on reconnect', async () => {
    const session = create();
    const deltas: llm.DuplexOutputTranscriptDelta[] = [];
    session.on('transcript_delta', (delta) => deltas.push(delta));
    await ready(session);
    for (const [role, text, start] of [
      ['user', ' What is', 7000],
      ['assistant', 'Let me', 7400],
      ['user', ' the weather', 7200],
      ['assistant', ' check.', 7600],
      ['assistant', 'Sixty-two.', 9000],
    ] as const)
      await server.send(session, transcript(role, text, start));
    expect(deltas).toEqual([
      { text: 'Let me', startMs: 7400, endMs: 7600 },
      { text: ' check.', startMs: 7600, endMs: 7800 },
      { text: 'Sixty-two.', startMs: 9000, endMs: 9200 },
    ]);
    server.sockets[0]!.terminate();
    await vi.waitFor(() => expect(session.sessionId).toBe('live_1'));
    expect(startConfig(1).input?.map((item) => [item.role, item.content[0]?.text])).toEqual([
      ['user', ' What is the weather'],
      ['assistant', 'Let me check.'],
      ['assistant', 'Sixty-two.'],
    ]);
  });

  it('ends a caller turn after 800 ms of input audio without new fragments', async () => {
    const session = create();
    const events: { name: string; data: object }[] = [];
    for (const name of [
      'input_speech_started',
      'input_audio_transcription_completed',
      'input_speech_stopped',
    ] as const)
      session.on(name, (data: object) => events.push({ name, data }));
    await ready(session);
    for (let i = 0; i < 20; i++) session.pushAudio(pcm());
    await server.send(session, transcript('user', ' What', 1800));
    await server.send(session, transcript('user', ' is the', 2000));
    expect(events.map((event) => event.name)).toEqual([
      'input_speech_started',
      'input_audio_transcription_completed',
      'input_audio_transcription_completed',
    ]);
    for (let i = 0; i < 7; i++) session.pushAudio(pcm());
    expect(events).toHaveLength(3);
    session.pushAudio(pcm());
    expect(events.slice(-2).map((event) => event.name)).toEqual([
      'input_audio_transcription_completed',
      'input_speech_stopped',
    ]);
    expect(events[3]?.data).toEqual({ ...events[2]?.data, isFinal: true });
    expect(events[3]?.data).toMatchObject({ transcript: ' What is the' });
  });

  it('splits bursty transcript delivery on gaps in the model timeline', async () => {
    const session = create();
    const finals: string[] = [];
    session.on('input_audio_transcription_completed', (event) => {
      if (event.isFinal) finals.push(event.transcript);
    });
    await ready(session);
    await server.send(session, transcript('user', 'Hello', 1000));
    await server.send(session, transcript('user', 'Again', 4000));
    expect(finals).toEqual(['Hello']);
  });

  it.each(['responses', 'client'] as const)(
    'carries typed input once in the next ask under %s delegation',
    async (delegation) => {
      const session = create({ delegation });
      await ready(session);
      await session._appendItems([
        new llm.ChatMessage({ role: 'system', content: 'Answer in French.' }),
        new llm.ChatMessage({ role: 'user', content: 'What is the weather in Paris?' }),
      ]);
      session._generateReply();
      await waitCount(4);
      expect(server.events().slice(1)).toMatchObject([
        { type: 'session.instructions.append', content: 'Answer in French.' },
        { type: 'session.thinking.append', content: 'user: What is the weather in Paris?' },
        {
          type: 'session.commentary.append',
          content:
            "Reply to the caller now, don't repeat what they said. Do not wait for the caller to speak first. After that, pause and listen.\n\nWhat is the weather in Paris?",
        },
      ]);
      session._generateReply();
      await waitCount(5);
      const bare = server.events()[4];
      expect(bare).toMatchObject({
        content:
          'Reply to the caller now. Do not wait for the caller to speak first. After that, pause and listen.',
      });
      await session._appendItems([new llm.ChatMessage({ role: 'user', content: 'Never mind.' })]);
      await server.send(session, transcript('assistant', 'Okay.', 1));
      session._generateReply();
      await waitCount(7);
      expect(server.events()[6]).toMatchObject({
        content:
          'Reply to the caller now. Do not wait for the caller to speak first. After that, pause and listen.',
      });
    },
  );

  it('caps startup history at 128 rendered messages and narrates old tool traffic', async () => {
    const session = create();
    const ctx = llm.ChatContext.empty();
    for (let i = 0; i < 130; i++) ctx.addMessage({ role: 'user', content: `message ${i}` });
    ctx.insert(new llm.FunctionCall({ callId: 'old', name: 'getWeather', args: '{}' }));
    ctx.insert(output('old'));
    await session._updateSession(undefined, ctx);
    await waitCount(1);
    expect(startConfig().input).toHaveLength(128);
    expect(startConfig().input?.[0]?.content[0]?.text).toBe('message 4');
    expect(startConfig().input?.slice(-2)).toMatchObject([
      { role: 'developer', content: [{ text: 'Called tool getWeather with {}' }] },
      { role: 'developer', content: [{ text: 'Tool getWeather returned rainy' }] },
    ]);
  });

  it('reseeds context received during retry and clears delegated calls and usage', async () => {
    const session = create();
    const errors: llm.RealtimeModelError[] = [];
    const durations: number[] = [];
    session.on('error', (event) => errors.push(event));
    session.on('metrics_collected', (metric) => {
      if (metric.type === 'realtime_model_metrics' && metric.sessionDurationMs !== undefined)
        durations.push(metric.sessionDurationMs);
    });
    await ready(session);
    await server.response(session, { type: 'response.created' });
    await server.response(session, callDone('old'));
    await server.send(session, { type: 'session.usage.updated', usage: { seconds: 10 } });
    server.sockets[0]!.terminate();
    await vi.waitFor(() => expect(errors).toHaveLength(1), { interval: 5 });
    await session._appendItems([
      new llm.ChatMessage({ role: 'user', content: 'While reconnecting' }),
    ]);
    await vi.waitFor(() => expect(session.sessionId).toBe('live_1'));
    expect(startConfig(1).input).toMatchObject([
      { content: [{ text: 'Called tool getWeather with {"location":"Paris"}' }] },
      { content: [{ text: 'While reconnecting' }] },
    ]);
    await server.send(session, { type: 'session.usage.updated', usage: { seconds: 2 } });
    expect(durations).toEqual([10000, 2000]);
    await session._appendItems([output('old')]);
    await waitCount(2, 1);
    expect(server.events(1)[1]?.type).toBe('session.thinking.append');
  });

  it('recycles a connection at maxSessionDuration in milliseconds', async () => {
    const session = create({ maxSessionDuration: 200 });
    await ready(session);
    await vi.waitFor(() => expect(session.sessionId).toBe('live_1'));
    expect(server.sockets).toHaveLength(2);
  });

  it.each(['invalid_api_key', 'insufficient_quota'])(
    'does not reconnect after fatal %s errors',
    async (code) => {
      const session = create();
      const errors: llm.RealtimeModelError[] = [];
      session.on('error', (error) => errors.push(error));
      await ready(session);
      await server.send(session, { type: 'error', error: { code, message: 'Rejected' } });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]?.recoverable).toBe(false);
      await session.close();
      expect(server.sockets).toHaveLength(1);
    },
  );

  it('reports recoverable protocol errors without disconnecting', async () => {
    const session = create();
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error) => errors.push(error));
    await ready(session);
    await server.send(session, {
      type: 'error',
      error: { code: 'invalid_request', message: 'Bad command' },
    });
    expect(errors[0]?.recoverable).toBe(true);
    session.appendThinking('Still connected.');
    await waitCount(2);
    expect(server.sockets).toHaveLength(1);
  });

  it('cancels retry sleep during shutdown', async () => {
    const session = create();
    const failed = new Promise<void>((resolve) => session.once('error', () => resolve()));
    await ready(session);
    server.sockets[0]!.terminate();
    await failed;
    await session.close();
    await delay(120);
    expect(server.sockets).toHaveLength(1);
  });
});

describe('GPT-Live AgentSession integration', () => {
  it('runs framework tools and retains final usage through shutdown', async () => {
    const execute = vi.fn(async () => 'rainy');
    const agent = new voice.Agent({
      instructions: 'Be concise.',
      tools: [
        llm.tool({
          name: 'getWeather',
          description: 'Get weather',
          parameters: z.object({ location: z.string() }),
          execute,
        }),
      ],
    });
    const session = new voice.AgentSession({
      llm: new GPTLiveModel({ apiKey: 'test', baseURL: server.url }),
      vad: null,
      aecWarmupDuration: null,
    });
    const collected: metrics.AgentMetrics[] = [];
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) =>
      collected.push(event.metrics),
    );
    try {
      await session.start({ agent });
      const live = agent.duplexSession as GPTLiveSession;
      await vi.waitFor(() => expect(live.sessionId).toBeDefined());
      await server.response(live, { type: 'response.created' });
      await server.response(live, callDone('framework'));
      await server.response(live, completed());
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(server.events().some((event) => event.type === 'response.create')).toBe(true),
      );
      const result = server.events().find((event) => event.type === 'response.item.create');
      expect(result).toMatchObject({
        item: { call_id: 'framework', output: JSON.stringify('rainy') },
      });
      server.closeUsage = 17;
      await session.close();
      expect(collected).toContainEqual(
        expect.objectContaining({ type: 'realtime_model_metrics', sessionDurationMs: 17000 }),
      );
    } finally {
      await session.close();
    }
  });

  it('commits user transcripts with the turn start time through the adapter', async () => {
    const agent = new voice.Agent({ instructions: 'Be concise.' });
    const session = new voice.AgentSession({
      llm: new GPTLiveModel({ apiKey: 'test', baseURL: server.url }),
      vad: null,
      aecWarmupDuration: null,
    });
    try {
      await session.start({ agent });
      const live = agent.duplexSession as GPTLiveSession;
      await vi.waitFor(() => expect(live.sessionId).toBeDefined());
      const start = Date.now();
      await server.send(live, transcript('user', 'Where is my order?', 1000));
      live.pushAudio(pcm(800));
      await vi.waitFor(() =>
        expect(
          agent.chatCtx.items.some(
            (item) => item.type === 'message' && item.textContent === 'Where is my order?',
          ),
        ).toBe(true),
      );
      const message = agent.chatCtx.items.find(
        (item) => item.type === 'message' && item.role === 'user',
      );
      expect(message?.createdAt).toBeGreaterThanOrEqual(start);
      expect(message?.createdAt).toBeLessThanOrEqual(Date.now());
    } finally {
      await session.close();
    }
  });
});
