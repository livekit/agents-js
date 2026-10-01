// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  VADEventType,
  stt,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientOptions, WebSocket } from 'ws';
import { STT, type WebSocketFactory } from './stt.js';
import { ScriptedVAD } from './stt_test_utils.js';

const URL = 'wss://stt.example.invalid/v1/realtime?intent=transcription&deployment=dummy';
const CONNECTION = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 200 };
const TRANSCRIPTION = 'conversation.item.input_audio_transcription.';

class FakeSocket extends EventEmitter {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly commits: Buffer[] = [];
  pendingAudio = Buffer.alloc(0);
  closed = false;
  autoUpdate = true;
  autoCommit = true;
  handshakeStatus?: number;

  constructor(
    options: { autoUpdate?: boolean; autoCommit?: boolean; handshakeStatus?: number } = {},
  ) {
    super();
    this.autoUpdate = options.autoUpdate ?? true;
    this.autoCommit = options.autoCommit ?? true;
    this.handshakeStatus = options.handshakeStatus;
  }

  connect(): void {
    queueMicrotask(() => {
      if (this.closed) return;
      if (this.handshakeStatus !== undefined) {
        this.emit('unexpected-response', {}, { statusCode: this.handshakeStatus });
        return;
      }
      this.readyState = 1;
      this.emit('open');
      this.emitJson({ type: 'session.created', session: { id: 'test-session' } });
    });
  }

  send(data: string, callback?: (error?: Error) => void): void {
    const event = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(event);
    if (event.type === 'input_audio_buffer.append') {
      this.pendingAudio = Buffer.concat([
        this.pendingAudio,
        Buffer.from(event.audio as string, 'base64'),
      ]);
    }
    callback?.();
    if (event.type === 'session.update' && this.autoUpdate) {
      this.emitJson({ type: 'session.updated' });
    } else if (event.type === 'input_audio_buffer.commit') {
      this.commits.push(this.pendingAudio);
      this.pendingAudio = Buffer.alloc(0);
      if (this.autoCommit) {
        const item = `item-${this.commits.length}`;
        this.complete(item, `turn ${this.commits.length}`);
      }
    }
  }

  emitJson(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(event)), false);
  }

  emitRaw(data: string | Buffer, isBinary = false): void {
    this.emit('message', Buffer.isBuffer(data) ? data : Buffer.from(data), isBinary);
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit('close', 1006, Buffer.alloc(0));
  }

  transcript(kind: string, fields: Record<string, unknown> = {}, itemId = 'item-1'): void {
    this.emitJson({ type: `${TRANSCRIPTION}${kind}`, item_id: itemId, ...fields });
  }

  complete(itemId = 'item-1', transcript = 'hello'): void {
    this.emitJson({ type: 'input_audio_buffer.committed', item_id: itemId });
    this.transcript('delta', { delta: transcript }, itemId);
    this.transcript('completed', { transcript }, itemId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }
}

class Factory {
  readonly calls: Array<{ url: string; options: ClientOptions }> = [];
  readonly outcomes: Array<FakeSocket | Error>;

  constructor(...outcomes: Array<FakeSocket | Error>) {
    this.outcomes = outcomes;
  }

  create: WebSocketFactory = (url, options) => {
    this.calls.push({ url, options });
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('no fake socket');
    if (outcome instanceof Error) throw outcome;
    outcome.connect();
    return outcome as unknown as WebSocket;
  };
}

function frame(samples = 800, value = -127, sampleRate = 16_000): AudioFrame {
  const data = new Int16Array(samples);
  data.fill(value);
  return new AudioFrame(data, sampleRate, 1, samples);
}

function provider(socket: FakeSocket, options: Partial<ConstructorParameters<typeof STT>[0]> = {}) {
  const factory = new Factory(socket);
  const instance = new STT({
    vad: null,
    url: URL,
    model: 'test-transcriber',
    apiKey: 'dummy-key',
    webSocketFactory: factory.create,
    ...options,
  });
  instance.on('error', () => {});
  return {
    instance,
    factory,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function collect(stream: stt.SpeechStream): Promise<stt.SpeechEvent[]> {
  const events: stt.SpeechEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        for await (const event of stream) events.push(event);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('collection timed out')), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return events;
}

function finals(events: stt.SpeechEvent[]): string[] {
  return events
    .filter((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
    .map((event) => event.alternatives![0]!.text);
}

async function nextEvent(stream: stt.SpeechStream): Promise<stt.SpeechEvent> {
  const result = await Promise.race([
    stream.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('event timed out')), 1000)),
  ]);
  if (result.done) throw new Error('stream ended before the expected event');
  return result.value;
}

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('MICROSOFT_AI_')) delete process.env[name];
  }
  delete process.env.OPENAI_API_KEY;
});

describe('Microsoft AI STT', () => {
  it('requires explicit Microsoft configuration and does not use OpenAI defaults', () => {
    process.env.OPENAI_API_KEY = 'must-not-be-used';
    expect(() => new STT({ vad: null })).toThrow('MICROSOFT_AI_STT_MODEL');
    expect(() => new STT({ vad: null, model: 'test' })).toThrow('MICROSOFT_AI_STT_URL');
    expect(() => new STT({ vad: null, model: 'test', url: URL })).toThrow(
      'MICROSOFT_AI_STT_API_KEY',
    );
  });

  it('declares only its supported capabilities and rejects batch recognition', async () => {
    const socket = new FakeSocket();
    const { instance, factory } = provider(socket);
    expect(instance.capabilities).toEqual({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
      diarization: false,
    });
    expect(instance.provider).toBe('Microsoft AI');
    await expect(instance.recognize(frame())).rejects.toThrow('stream(), not batch recognize()');
    expect(factory.calls).toEqual([]);
    await instance.close();
  });

  it('loads a selected dotenv literally without mutating the environment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'microsoft-ai-stt-'));
    const path = join(directory, 'endpoints.env');
    const interpolationName = ['SHOULD', 'NOT', 'EXPAND'].join('_');
    const literalCredential = `literal-\${${interpolationName}}`;
    writeFileSync(
      path,
      [
        'MICROSOFT_AI_STT_URL=wss://file.example.invalid/realtime?intent=transcription',
        'MICROSOFT_AI_STT_MODEL=file-transcriber',
        `MICROSOFT_AI_STT_API_KEY='${literalCredential}'`,
        'MICROSOFT_AI_STT_LANGUAGE=en',
        'MICROSOFT_AI_STT_AUTH_HEADER=api-key',
      ].join('\n'),
    );
    process.env[interpolationName] = 'not-a-credential';
    const socket = new FakeSocket();
    const factory = new Factory(socket);
    const instance = new STT({ vad: null, envFile: path, webSocketFactory: factory.create });
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.endInput();
    expect(await collect(stream)).toEqual([]);
    expect(instance.model).toBe('file-transcriber');
    expect(factory.calls[0]).toMatchObject({
      url: 'wss://file.example.invalid/realtime?intent=transcription',
      options: {
        headers: { 'api-key': literalCredential, 'User-Agent': 'LiveKit Agents' },
      },
    });
    expect(process.env.MICROSOFT_AI_STT_API_KEY).toBeUndefined();
    delete process.env[interpolationName];
    await instance.close();
    rmSync(directory, { recursive: true });
  });

  it('uses constructor, environment, then file precedence for values and auth selectors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'microsoft-ai-stt-'));
    const path = join(directory, 'endpoints.env');
    writeFileSync(
      path,
      [
        `MICROSOFT_AI_STT_URL=${URL}`,
        'MICROSOFT_AI_STT_MODEL=file-model',
        'MICROSOFT_AI_STT_API_KEY=file-key',
        'MICROSOFT_AI_STT_AUTH_HEADER=api-key',
      ].join('\n'),
    );
    process.env.MICROSOFT_AI_STT_MODEL = 'environment-model';
    process.env.MICROSOFT_AI_STT_AUTH_HEADER = 'Authorization';
    const socket = new FakeSocket();
    const factory = new Factory(socket);
    const instance = new STT({
      vad: null,
      envFile: path,
      model: 'argument-model',
      apiKey: 'argument-key',
      authHeader: 'api-key',
      webSocketFactory: factory.create,
    });
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.endInput();
    await collect(stream);
    expect(instance.model).toBe('argument-model');
    expect(factory.calls[0]?.options.headers).toEqual({
      'api-key': 'argument-key',
      'User-Agent': 'LiveKit Agents',
    });
    await instance.close();
    rmSync(directory, { recursive: true });
  });

  it.each(['', ' ', 'Api-Key', 'Bearer', 'api-key\r\nx-secret: dummy'])(
    'rejects invalid auth selector %j without echoing it',
    (selector) => {
      process.env.MICROSOFT_AI_STT_AUTH_HEADER = selector;
      expect(
        () => new STT({ vad: null, url: URL, model: 'test', apiKey: 'dummy-private-key' }),
      ).toThrow('must be Authorization or api-key');
      try {
        new STT({ vad: null, url: URL, model: 'test', apiKey: 'dummy-private-key' });
      } catch (error) {
        expect(String(error)).not.toContain('dummy-private-key');
        if (selector.trim()) expect(String(error)).not.toContain(selector.trim());
      }
    },
  );

  it.each(['dummy\r\nx-header:value', 'dummy\n', 'dummy\0', 'dummy\x7f'])(
    'rejects API credentials containing header control characters',
    (apiKey) => {
      expect(
        () => new STT({ vad: null, url: URL, model: 'test', apiKey, authHeader: 'api-key' }),
      ).toThrow('control characters');
    },
  );

  it('does not silently ignore a missing selected dotenv file', () => {
    expect(
      () =>
        new STT({
          vad: null,
          envFile: '/definitely/missing/private-location.env',
        }),
    ).toThrow('Could not read the selected Microsoft AI environment file');
    try {
      new STT({ vad: null, envFile: '/definitely/missing/private-location.env' });
    } catch (error) {
      expect(String(error)).not.toContain('private-location');
    }
  });

  it('uses environment configuration while explicit headers bypass API-key lookup', async () => {
    process.env.MICROSOFT_AI_STT_URL = URL;
    process.env.MICROSOFT_AI_STT_MODEL = 'environment-model';
    process.env.MICROSOFT_AI_STT_API_KEY = 'unused-environment-key';
    const socket = new FakeSocket();
    const factory = new Factory(socket);
    const instance = new STT({
      vad: null,
      headers: { 'api-key': 'dummy' },
      webSocketFactory: factory.create,
    });
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.endInput();
    expect(await collect(stream)).toEqual([]);
    expect(factory.calls[0]?.options.headers).toEqual({
      'api-key': 'dummy',
      'User-Agent': 'LiveKit Agents',
    });
    expect(instance.model).toBe('environment-model');
    expect(
      () =>
        new STT({
          vad: null,
          url: URL,
          model: 'test',
          apiKey: 'dummy',
          headers: {},
        }),
    ).toThrow('either apiKey');
    await instance.close();
  });

  it('gates audio on the exact created/update/updated handshake', async () => {
    const socket = new FakeSocket({ autoUpdate: false });
    const { instance, factory } = provider(socket);
    const stream = instance.stream({ language: 'en', connOptions: CONNECTION });
    stream.pushFrame(frame());
    stream.endInput();
    await waitUntil(() => socket.sent.length === 1);
    expect(socket.sent[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 16000 },
            transcription: { model: 'test-transcriber', language: 'en' },
            turn_detection: null,
            noise_reduction: null,
          },
        },
      },
    });
    socket.emitJson({ type: 'session.updated' });
    expect(finals(await collect(stream))).toEqual(['turn 1']);
    expect(factory.calls[0]?.url).toBe(URL);
    expect(factory.calls[0]?.options.headers).toMatchObject({
      Authorization: 'Bearer dummy-key',
      'User-Agent': 'LiveKit Agents',
    });
    expect(socket.closed).toBe(true);
    await instance.close();
  });

  for (const samples of [1, 157, 799, 800, 801, 2417]) {
    it(`drains an exact ${samples}-sample PCM tail without padding`, async () => {
      const socket = new FakeSocket();
      const { instance } = provider(socket);
      const stream = instance.stream({ connOptions: CONNECTION });
      stream.pushFrame(frame(samples));
      stream.endInput();
      const events = await collect(stream);
      expect(socket.commits).toHaveLength(1);
      expect(socket.commits[0]).toHaveLength(samples * 2);
      const chunks = socket.sent
        .filter((event) => event.type === 'input_audio_buffer.append')
        .map((event) => Buffer.from(event.audio as string, 'base64'));
      expect(chunks.slice(0, -1).every((chunk) => chunk.length === 1600)).toBe(true);
      expect(chunks.at(-1)?.length).toBe((((samples - 1) % 800) + 1) * 2);
      expect(finals(events)).toEqual(['turn 1']);
      const usage = events.find((event) => event.recognitionUsage)?.recognitionUsage;
      expect(usage?.audioDuration).toBe(samples / 16000);
      await instance.close();
    });
  }

  it('deduplicates revisions and treats the acknowledged completion as authoritative', async () => {
    const socket = new FakeSocket({ autoCommit: false });
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame());
    stream.flush();
    await waitUntil(() => socket.sent.some((event) => event.type === 'input_audio_buffer.commit'));
    socket.transcript('delta', { delta: 'I agree', event_id: 'delta-1' });
    socket.transcript('delta', { delta: 'I agree', event_id: 'delta-1' });
    socket.transcript('intermediate', { intermediate: ' completely' });
    socket.emitJson({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    socket.transcript('completed', { transcript: 'I agree' });
    socket.transcript('completed', { transcript: 'I agree' });
    stream.endInput();
    const events = await collect(stream);
    expect(finals(events)).toEqual(['I agree']);
    expect(
      events.filter((event) => event.type === stt.SpeechEventType.RECOGNITION_USAGE),
    ).toHaveLength(1);
    expect(events.at(-1)?.type).toBe(stt.SpeechEventType.END_OF_SPEECH);
    await instance.close();
  });

  it('emits the exact interim revision sequence without duplicating deltas or the final', async () => {
    const socket = new FakeSocket({ autoCommit: false });
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame());
    await waitUntil(() => socket.sent.some((event) => event.type === 'input_audio_buffer.append'));
    socket.transcript('intermediate', { intermediate: 'helo', event_id: 'revision-1' });
    socket.transcript('intermediate', { intermediate: 'hello' });
    socket.transcript('delta', { delta: 'hello ', event_id: 'delta-1' });
    socket.transcript('delta', { delta: 'hello ', event_id: 'delta-1' });
    socket.transcript('intermediate', { intermediate: 'wurld' });
    socket.transcript('intermediate', { intermediate: 'world' });
    socket.transcript('delta', { delta: 'world' });
    stream.endInput();
    await waitUntil(() => socket.sent.some((event) => event.type === 'input_audio_buffer.commit'));
    socket.emitJson({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    socket.transcript('completed', { transcript: 'hello world' });
    socket.transcript('completed', { transcript: 'hello world' });
    const events = await collect(stream);
    expect(
      events
        .filter((event) => event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT)
        .map((event) => event.alternatives![0]!.text),
    ).toEqual(['helo', 'hello', 'hello ', 'hello wurld', 'hello world']);
    expect(finals(events)).toEqual(['hello world']);
    await instance.close();
  });

  it.each([
    ['retracted interim', 'I agree', [' completely'], 'I agree'],
    ['corrected interim', 'I agree', [' completly', ' completely'], 'I agree completely.'],
    ['replaced interim', 'I agree', [' completely', ' in part'], 'I agree in part.'],
    ['empty final', '', ['spurious speech'], ''],
    ['empty final after delta', 'I agree', [' completely'], ''],
  ] as const)(
    'treats the acknowledged final as authoritative for %s and continues to the next turn',
    async (_name, delta, hypotheses, transcript) => {
      const socket = new FakeSocket({ autoCommit: false });
      const { instance, factory } = provider(socket);
      const first = frame(901);
      const second = frame(83, 1);
      const stream = instance.stream({ connOptions: CONNECTION });
      stream.pushFrame(first);
      stream.flush();
      await waitUntil(() =>
        socket.sent.some((event) => event.type === 'input_audio_buffer.commit'),
      );
      socket.transcript('delta', { delta });
      for (const hypothesis of hypotheses) {
        socket.transcript('intermediate', { intermediate: hypothesis });
      }
      socket.emitJson({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
      socket.transcript('completed', { transcript });
      socket.transcript('completed', { transcript });
      const firstEvents: stt.SpeechEvent[] = [];
      while (firstEvents.at(-1)?.type !== stt.SpeechEventType.END_OF_SPEECH) {
        firstEvents.push(await nextEvent(stream));
      }
      expect(finals(firstEvents)).toEqual(transcript ? [transcript] : []);
      expect(
        firstEvents.filter((event) => event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT).at(-1)
          ?.alternatives?.[0].text,
      ).toBe(delta + hypotheses.at(-1)!);
      expect(
        firstEvents.filter((event) => event.type === stt.SpeechEventType.RECOGNITION_USAGE),
      ).toHaveLength(1);
      expect(socket.closed).toBe(false);

      stream.pushFrame(second);
      stream.endInput();
      await waitUntil(
        () =>
          socket.sent.filter((event) => event.type === 'input_audio_buffer.commit').length === 2,
      );
      socket.complete('item-2', 'Next turn.');
      expect(finals(await collect(stream))).toEqual(['Next turn.']);
      expect(socket.commits).toEqual([
        Buffer.from(first.data.buffer, first.data.byteOffset, first.data.byteLength),
        Buffer.from(second.data.buffer, second.data.byteOffset, second.data.byteLength),
      ]);
      expect(factory.calls).toHaveLength(1);
      await instance.close();
    },
  );

  it('accepts an authoritative empty completion without inventing text', async () => {
    const socket = new FakeSocket({ autoCommit: false });
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame());
    stream.endInput();
    await waitUntil(() => socket.sent.some((event) => event.type === 'input_audio_buffer.commit'));
    socket.emitJson({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    socket.transcript('completed', { transcript: '' });
    const events = await collect(stream);
    expect(events.map((event) => event.type)).toEqual([stt.SpeechEventType.RECOGNITION_USAGE]);
    await instance.close();
  });

  it('keeps one socket open for ordered flushes across multiple utterances', async () => {
    const socket = new FakeSocket();
    const { instance, factory } = provider(socket);
    const first = frame(917);
    const second = frame(83, 1);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(first);
    stream.flush();
    const firstEvents: stt.SpeechEvent[] = [];
    while (firstEvents.at(-1)?.type !== stt.SpeechEventType.END_OF_SPEECH) {
      firstEvents.push(await nextEvent(stream));
    }
    expect(finals(firstEvents)).toEqual(['turn 1']);
    expect(socket.closed).toBe(false);
    stream.pushFrame(second);
    stream.endInput();
    expect(finals(await collect(stream))).toEqual(['turn 2']);
    expect(socket.commits).toEqual([
      Buffer.from(first.data.buffer, first.data.byteOffset, first.data.byteLength),
      Buffer.from(second.data.buffer, second.data.byteOffset, second.data.byteLength),
    ]);
    expect(factory.calls).toHaveLength(1);
    await instance.close();
  });

  it('rejects a completion whose item does not match the commit acknowledgement', async () => {
    const socket = new FakeSocket({ autoCommit: false });
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame());
    stream.endInput();
    await waitUntil(() => socket.sent.some((event) => event.type === 'input_audio_buffer.commit'));
    socket.emitJson({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    socket.transcript('completed', { transcript: 'wrong' }, 'item-2');
    await collect(stream);
    expect(stream.terminalError).toBeInstanceOf(APIError);
    expect(stream.terminalError?.message).toContain('changed item');
    await instance.close();
  });

  it.each([
    [undefined, 'item-1'],
    ['item-2', 'item-1'],
    ['item-1', 'item-2'],
  ] as const)('requires a matching commit acknowledgement (%s, %s)', async (ack, completed) => {
    const socket = new FakeSocket({ autoCommit: false });
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame());
    stream.endInput();
    await waitUntil(() => socket.sent.some((event) => event.type === 'input_audio_buffer.commit'));
    socket.transcript('delta', { delta: 'I agree' });
    if (ack !== undefined) {
      socket.emitJson({ type: 'input_audio_buffer.committed', item_id: ack });
    }
    socket.transcript('completed', { transcript: 'I agree' }, completed);
    await collect(stream);
    expect(stream.terminalError).toBeInstanceOf(APIError);
    expect((stream.terminalError as APIError).retryable).toBe(false);
    await instance.close();
  });

  it.each([{}, { transcript: null }, { transcript: 123 }, { transcript: [] }])(
    'rejects a completed event without a string transcript: %j',
    async (payload) => {
      const socket = new FakeSocket({ autoCommit: false });
      const { instance } = provider(socket);
      const stream = instance.stream({ connOptions: CONNECTION });
      stream.pushFrame(frame());
      stream.endInput();
      await waitUntil(() =>
        socket.sent.some((event) => event.type === 'input_audio_buffer.commit'),
      );
      socket.emitJson({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
      socket.transcript('completed', payload);
      await collect(stream);
      expect(stream.terminalError?.message).toContain('string transcript');
      await instance.close();
    },
  );

  it.each([false, true])(
    'times out when the final protocol event is missing (ack=%s)',
    async (ack) => {
      const socket = new FakeSocket({ autoCommit: false });
      const { instance } = provider(socket);
      const stream = instance.stream({
        connOptions: { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 20 },
      });
      stream.pushFrame(frame());
      stream.endInput();
      await waitUntil(() =>
        socket.sent.some((event) => event.type === 'input_audio_buffer.commit'),
      );
      if (ack) socket.emitJson({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
      await collect(stream);
      expect(stream.terminalError).toBeInstanceOf(APITimeoutError);
      expect((stream.terminalError as APITimeoutError).retryable).toBe(false);
      expect(socket.commits).toHaveLength(1);
      await instance.close();
    },
  );

  it('retries only before queued audio is consumed', async () => {
    const socket = new FakeSocket();
    const factory = new Factory(new Error('private endpoint'), socket);
    const instance = new STT({
      vad: null,
      url: URL,
      model: 'test-transcriber',
      apiKey: 'dummy-key',
      webSocketFactory: factory.create,
    });
    const stream = instance.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
    });
    stream.pushFrame(frame(33));
    stream.endInput();
    expect(finals(await collect(stream))).toEqual(['turn 1']);
    expect(factory.calls).toHaveLength(2);
    expect(socket.commits[0]).toHaveLength(66);
    await instance.close();
  });

  it('does not retry or replay after audio has reached the transport', async () => {
    const first = new FakeSocket({ autoCommit: false });
    const second = new FakeSocket();
    const factory = new Factory(first, second);
    const instance = new STT({
      vad: null,
      url: URL,
      model: 'test-transcriber',
      apiKey: 'dummy-key',
      webSocketFactory: factory.create,
    });
    instance.on('error', () => {});
    const stream = instance.stream({
      connOptions: { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 200 },
    });
    stream.pushFrame(frame(817));
    await waitUntil(() => first.sent.some((event) => event.type === 'input_audio_buffer.append'));
    first.disconnect();
    await collect(stream);
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
    expect((stream.terminalError as APIConnectionError).retryable).toBe(false);
    expect(factory.calls).toHaveLength(1);
    expect(first.commits).toEqual([]);
    await instance.close();
  });

  it.each([400, 401, 403, 429, 503])(
    'preserves and sanitizes handshake HTTP status %i',
    async (status) => {
      const socket = new FakeSocket({ handshakeStatus: status });
      const { instance } = provider(socket);
      const stream = instance.stream({ connOptions: CONNECTION });
      await collect(stream);
      expect(stream.terminalError).toBeInstanceOf(APIStatusError);
      expect((stream.terminalError as APIStatusError).statusCode).toBe(status);
      expect((stream.terminalError as APIStatusError).retryable).toBe([429, 503].includes(status));
      expect(String(stream.terminalError)).not.toContain(URL);
      await instance.close();
    },
  );

  it.each([
    ['invalid_api_key', 401],
    ['rate_limit_exceeded', 429],
    ['content_filter', 403],
  ] as const)('maps and sanitizes provider error %s', async (code, status) => {
    const socket = new FakeSocket({ autoCommit: false });
    const { instance, factory } = provider(socket);
    const stream = instance.stream({
      connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 200 },
    });
    stream.pushFrame(frame());
    await waitUntil(() => socket.sent.some((event) => event.type === 'input_audio_buffer.append'));
    socket.emitJson({ type: 'error', error: { code, message: 'do-not-log-transcript' } });
    await collect(stream);
    expect(stream.terminalError).toBeInstanceOf(APIStatusError);
    expect((stream.terminalError as APIStatusError).statusCode).toBe(status);
    expect((stream.terminalError as APIStatusError).retryable).toBe(false);
    expect(String(stream.terminalError)).not.toContain('do-not-log');
    expect(factory.calls).toHaveLength(1);
    await instance.close();
  });

  it('retries a provider rate limit received before any audio is sent', async () => {
    const first = new FakeSocket({ autoUpdate: false });
    const second = new FakeSocket();
    const factory = new Factory(first, second);
    const instance = new STT({
      vad: null,
      url: URL,
      model: 'test-transcriber',
      apiKey: 'dummy-key',
      webSocketFactory: factory.create,
    });
    instance.on('error', () => {});
    const stream = instance.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
    });
    stream.pushFrame(frame(17));
    stream.endInput();
    await waitUntil(() => first.sent.some((event) => event.type === 'session.update'));
    first.emitJson({ type: 'error', error: { status_code: 429, message: 'private' } });
    expect(finals(await collect(stream))).toEqual(['turn 1']);
    expect(factory.calls).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(second.commits[0]).toHaveLength(34);
    await instance.close();
  });

  it('uses a finite retry budget for handshake update timeouts', async () => {
    const sockets = [
      new FakeSocket({ autoUpdate: false }),
      new FakeSocket({ autoUpdate: false }),
      new FakeSocket({ autoUpdate: false }),
    ];
    const factory = new Factory(...sockets);
    const instance = new STT({
      vad: null,
      url: URL,
      model: 'test-transcriber',
      apiKey: 'dummy-key',
      webSocketFactory: factory.create,
    });
    instance.on('error', () => {});
    const stream = instance.stream({
      connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 10 },
    });
    stream.endInput();
    await collect(stream);
    expect(stream.terminalError).toBeInstanceOf(APITimeoutError);
    expect(factory.calls).toHaveLength(3);
    expect(sockets.every((socket) => socket.closed)).toBe(true);
    await instance.close();
  });

  it.each([
    ['{', false],
    ['[]', false],
    ['{"event":"missing-type"}', false],
    [Buffer.from([1, 2, 3]), true],
  ] as const)('treats malformed or raw protocol data as terminal: %s', async (body, binary) => {
    const socket = new FakeSocket({ autoUpdate: false });
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    await waitUntil(() => socket.sent.some((event) => event.type === 'session.update'));
    socket.emitRaw(body, binary);
    await collect(stream);
    expect(stream.terminalError).toBeInstanceOf(APIError);
    expect((stream.terminalError as APIError).retryable).toBe(false);
    await instance.close();
  });

  it.each([
    { type: `${TRANSCRIPTION}delta`, delta: 'missing id' },
    { type: `${TRANSCRIPTION}intermediate`, item_id: 'one', intermediate: 1 },
    { type: `${TRANSCRIPTION}completed`, item_id: 'one', transcript: 'unsolicited' },
    { type: 'input_audio_buffer.committed', item_id: 'one' },
  ])('fails explicitly on invalid item event %#', async (event) => {
    const socket = new FakeSocket({ autoCommit: false });
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame());
    await waitUntil(() => socket.sent.some((sent) => sent.type === 'input_audio_buffer.append'));
    socket.emitJson(event);
    await collect(stream);
    expect(stream.terminalError).toBeInstanceOf(APIError);
    expect((stream.terminalError as APIError).retryable).toBe(false);
    await instance.close();
  });

  it('bounds queued audio and surfaces overflow to the stream', async () => {
    const socket = new FakeSocket();
    const { instance } = provider(socket, { maxBufferedAudio: 60 });
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame(800));
    expect(() => stream.pushFrame(frame(800))).toThrow('buffer is full');
    await collect(stream);
    expect(stream.terminalError?.message).toContain('buffer is full');
    await instance.close();
  });

  it('bounds queued flush markers', async () => {
    const socket = new FakeSocket();
    const { instance } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    for (let index = 0; index < 1024; index++) stream.flush();
    expect(() => stream.flush()).toThrow('buffer is full');
    stream.close();
    await instance.close();
  });

  it('uses the VAD-provided onset prefix without guessed padding', async () => {
    const detector = new ScriptedVAD(
      {
        16384: VADEventType.START_OF_SPEECH,
        32768: VADEventType.END_OF_SPEECH,
      },
      12000,
    );
    const socket = new FakeSocket();
    const { instance } = provider(socket, { vad: detector });
    const samples = new Int16Array(32768 + 123);
    samples.fill(0, 0, 4800);
    samples.fill(0x123, 4800, 24000);
    samples.fill(0x234, 24000, 24064);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(new AudioFrame(samples, 16000, 1, samples.length));
    stream.endInput();
    expect(finals(await collect(stream))).toEqual(['turn 1']);
    const allBytes = Buffer.from(samples.buffer);
    expect(socket.commits).toEqual([allBytes.subarray((16384 - 12000) * 2, 32768 * 2)]);
    expect((stream as stt.SpeechStream & { processedSamples: number }).processedSamples).toBe(
      samples.length,
    );
    await instance.close();
  });

  it('fails instead of dropping a VAD onset when no prefix is supplied', async () => {
    const detector = new ScriptedVAD({ 512: VADEventType.START_OF_SPEECH }, 0);
    const socket = new FakeSocket();
    const { instance } = provider(socket, { vad: detector });
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame(512));
    stream.endInput();
    await collect(stream);
    expect(stream.terminalError?.message).toContain('preserve the speech prefix');
    expect(socket.commits).toEqual([]);
    await instance.close();
  });

  it('does not send silent VAD audio or create an empty commit', async () => {
    const detector = new ScriptedVAD();
    const socket = new FakeSocket();
    const { instance } = provider(socket, { vad: detector });
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame(1307, 0));
    stream.endInput();
    expect(await collect(stream)).toEqual([]);
    expect((stream as stt.SpeechStream & { processedSamples: number }).processedSamples).toBe(1307);
    expect(socket.commits).toEqual([]);
    expect(socket.pendingAudio).toHaveLength(0);
    await instance.close();
  });

  it.each([false, true])('drains the 48kHz resampler tail (VAD=%s)', async (useVad) => {
    const socket = new FakeSocket();
    const detector = useVad ? new ScriptedVAD({ 512: VADEventType.START_OF_SPEECH }) : null;
    const { instance } = provider(socket, { vad: detector });
    const input = frame(4817, -127, 48_000);
    const reference = new AudioResampler(48_000, 16_000);
    const pushed = reference.push(input);
    const flushed = reference.flush();
    const expectedSamples = [...pushed, ...flushed].reduce(
      (total, output) => total + output.samplesPerChannel,
      0,
    );
    const pushedSamples = pushed.reduce((total, output) => total + output.samplesPerChannel, 0);
    reference.close();
    expect(expectedSamples).toBe(Math.round(4817 / 3));
    expect(expectedSamples).toBeGreaterThan(pushedSamples);

    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(input);
    stream.endInput();
    expect(finals(await collect(stream))).toEqual(['turn 1']);
    expect((stream as stt.SpeechStream & { processedSamples: number }).processedSamples).toBe(
      expectedSamples,
    );
    expect(socket.commits[0]).toHaveLength(expectedSamples * 2);
    await instance.close();
  });

  it('validates mono audio and a stable input sample rate', async () => {
    const socket = new FakeSocket();
    const { instance } = provider(socket);
    expect(() =>
      instance.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 0 },
      }),
    ).toThrow('greater than zero');
    const stream = instance.stream({ connOptions: CONNECTION });
    expect(() => stream.pushFrame(new AudioFrame(new Int16Array(1600), 16_000, 2, 800))).toThrow(
      'mono',
    );
    stream.pushFrame(frame(800, -127, 48_000));
    expect(() => stream.pushFrame(frame(800, -127, 16_000))).toThrow('sample rate');
    stream.endInput();
    await collect(stream);
    await instance.close();
  });

  it('closes immediately while the handshake is pending', async () => {
    const socket = new FakeSocket({ autoUpdate: false });
    const { instance } = provider(socket);
    const stream = instance.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 },
    });
    await waitUntil(() => socket.sent.length === 1);
    await instance.close();
    expect(socket.closed).toBe(true);
    expect(await collect(stream)).toEqual([]);
  });

  it('does not connect or upload when closed before the stream task starts', async () => {
    const socket = new FakeSocket();
    const { instance, factory } = provider(socket);
    const stream = instance.stream({ connOptions: CONNECTION });
    stream.pushFrame(frame());
    stream.close();
    expect(await collect(stream)).toEqual([]);
    expect(factory.calls).toEqual([]);
    expect(socket.sent).toEqual([]);
    await instance.close();
  });
});
