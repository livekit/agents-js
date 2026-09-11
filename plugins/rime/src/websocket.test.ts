// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  create,
  fromBinary,
  fromJsonString,
  toBinary,
  toJson,
  toJsonString,
} from '@bufbuild/protobuf';
import type { APIError, TTSMetrics } from '@livekit/agents';
import { type APIConnectOptions, tokenize, tts } from '@livekit/agents';
import {
  WebSocketErrorSchema,
  type WebSocketRequest,
  WebSocketRequestSchema,
  type WebSocketResponse,
  WebSocketResponseSchema,
} from '@rimelabs/api';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeMuLaw } from './audio.js';
import { RimeConnection, decodeResponse, providerError } from './connection.js';
import type { RimeAudioFormat, WebSocketProtocol } from './options.js';
import { TTS } from './tts.js';

const options: APIConnectOptions = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 500 };
const clients: TTS[] = [];
const servers: WebSocketServer[] = [];
const secret = 'private text Bearer secret-key https://user:password@host/?token=secret';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

type Send = (payload: WebSocketResponse['payload'], contextId?: string) => void;
async function server(
  config: {
    onRequest?: (request: WebSocketRequest, send: Send, socket: WebSocket) => void;
    onConnect?: (send: Send) => void;
    ready?: WebSocketResponse['payload'];
    audio?: Buffer;
    noEnd?: boolean;
    noCancel?: boolean;
    noStarted?: boolean;
    noReady?: boolean;
  } = {},
) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const requests: WebSocketRequest[] = [];
  const sockets: WebSocket[] = [];
  const headers: string[] = [];
  wss.on('connection', (socket, request) => {
    sockets.push(socket);
    headers.push(request.headers.authorization!);
    const binary = socket.protocol === 'rime.v1.binary';
    const send: Send = (payload, contextId = '') => {
      const response = create(WebSocketResponseSchema, { contextId, payload });
      socket.send(
        binary
          ? toBinary(WebSocketResponseSchema, response)
          : toJsonString(WebSocketResponseSchema, response),
      );
    };
    config.onConnect?.(send);
    if (!config.noReady)
      send(
        config.ready ?? {
          case: 'ready',
          value: { $typeName: 'rime.WebSocketReady', protocol: 1, languages: [] },
        },
      );
    socket.on('message', (data, isBinary) => {
      expect(isBinary).toBe(binary);
      const request = binary
        ? fromBinary(WebSocketRequestSchema, Buffer.from(data as Buffer))
        : fromJsonString(WebSocketRequestSchema, data.toString());
      requests.push(request);
      if (config.onRequest) {
        config.onRequest(request, send, socket);
        return;
      }
      const id = request.contextId;
      if (request.payload.case === 'start' && !config.noStarted)
        send(
          {
            case: 'started',
            value: { $typeName: 'rime.WebSocketStarted', requestId: `request-${id}` },
          },
          id,
        );
      if (request.payload.case === 'text') {
        const audio = config.audio ?? Buffer.alloc(4800, 1);
        for (let offset = 0; offset < audio.length; offset += 777)
          send({ case: 'audio', value: audio.subarray(offset, offset + 777) }, id);
      }
      if (request.payload.case === 'end' && !config.noEnd)
        send({ case: 'done', value: { $typeName: 'rime.WebSocketDone' } }, id);
      if (request.payload.case === 'cancel' && !config.noCancel)
        send({ case: 'cancelled', value: { $typeName: 'rime.WebSocketCancelled' } }, id);
    });
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/coda/ws`,
    requests,
    sockets,
    headers,
  };
}

function client(
  url: string,
  protocol: WebSocketProtocol = 'binary',
  extra: ConstructorParameters<typeof TTS>[0] = {},
) {
  const value = new TTS({
    apiKey: 'test-key',
    websocketURL: url,
    websocketProtocol: protocol,
    ...extra,
  });
  clients.push(value);
  const errors: APIError[] = [];
  value.on('error', (event) => errors.push(event.error as APIError));
  return { value, errors };
}

async function collect(stream: tts.SynthesizeStream, onFrame?: () => void) {
  const frames: tts.SynthesizedAudio[] = [];
  for await (const frame of stream)
    if (frame !== tts.SynthesizeStream.END_OF_STREAM) {
      frames.push(frame);
      onFrame?.();
    }
  return frames;
}

describe.each(['binary', 'json'] as const)('Rime v1 %s', (protocol) => {
  it('handles tokenizer rejection while input remains open', async () => {
    const peer = await server();
    const tokenizer = new tokenize.basic.SentenceTokenizer();
    const tokens = tokenizer.stream();
    vi.spyOn(tokenizer, 'stream').mockReturnValue(tokens);
    vi.spyOn(tokens, 'next').mockRejectedValue(new Error(secret));
    const { value, errors } = client(peer.url, protocol, { tokenizer });
    const stream = value.stream({ connOptions: options });
    stream.pushText('Hello.');
    try {
      await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 1000 });
      expect(errors[0]).toMatchObject({
        message: 'Rime sentence tokenization failed',
        retryable: false,
      });
      expect(errors[0]!.cause).toBeUndefined();
      await stream.waitClosed();
      expect(tokens.closed).toBe(true);
      expect(await collect(stream)).toEqual([]);
    } finally {
      stream.close();
      await stream.waitClosed();
    }
  });

  it('rejects completion without audio for nonempty input', async () => {
    const peer = await server({ audio: Buffer.alloc(0) });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: options });
    stream.pushText('Hello.');
    stream.endInput();
    expect(await collect(stream)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: 'Rime synthesis completed without audio',
      retryable: true,
    });
    expect(errors[0]!.cause).toBeUndefined();
  });

  it('retries completion without audio and replays the text', async () => {
    let attempt = 0;
    const peer = await server({
      onRequest(request, send) {
        if (request.payload.case === 'start') {
          attempt++;
          send(
            {
              case: 'started',
              value: {
                $typeName: 'rime.WebSocketStarted',
                requestId: `request-${attempt}`,
              },
            },
            request.contextId,
          );
        }
        if (attempt > 1 && request.payload.case === 'text')
          send({ case: 'audio', value: Buffer.alloc(4800) }, request.contextId);
        if (request.payload.case === 'end')
          send({ case: 'done', value: { $typeName: 'rime.WebSocketDone' } }, request.contextId);
      },
    });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: { ...options, maxRetry: 1 } });
    stream.pushText('Hello.');
    stream.endInput();
    expect((await collect(stream)).length).toBeGreaterThan(0);
    expect(attempt).toBe(2);
    expect(
      peer.requests
        .filter((request) => request.payload.case === 'text')
        .map((request) => request.payload.value),
    ).toEqual(['Hello. ', 'Hello. ']);
    expect(errors).toEqual([]);
  });

  it.each(['cancelled', 'failed'])(
    'records pending metrics when %s after audio delivery',
    async (mode) => {
      const peer = await server();
      const { value } = client(peer.url, protocol);
      const metrics: TTSMetrics[] = [];
      value.on('metrics_collected', (event) => metrics.push(event));
      const stream = value.stream({ connOptions: options });
      stream.pushText('Hello.');
      stream.flush();
      const first = await stream.next();
      expect(first.done).toBe(false);
      if (mode === 'cancelled') stream.close();
      else {
        const response = create(WebSocketResponseSchema, {
          contextId: peer.requests[0]!.contextId,
          payload: {
            case: 'error',
            value: { kind: 'internal', message: 'failure' },
          },
        });
        peer.sockets[0]!.send(
          protocol === 'binary'
            ? toBinary(WebSocketResponseSchema, response)
            : toJsonString(WebSocketResponseSchema, response),
        );
      }
      await stream.waitClosed();
      await vi.waitFor(() => expect(metrics).toHaveLength(1));
      expect(metrics[0]).toMatchObject({ charactersCount: 6, cancelled: mode === 'cancelled' });
      expect(metrics[0]!.audioDurationMs).toBeGreaterThan(0);
      expect(metrics[0]!.ttfbMs).toBeGreaterThanOrEqual(0);
    },
  );

  it('replaces a closed idle connection without a synthesis retry', async () => {
    const peer = await server();
    const { value, errors } = client(peer.url, protocol);
    const first = value.stream({ connOptions: options });
    first.pushText('First.');
    first.endInput();
    expect((await collect(first)).length).toBeGreaterThan(0);
    await first.waitClosed();
    peer.sockets[0]!.close();
    await vi.waitFor(() => expect(peer.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
    const next = value.stream({ connOptions: options });
    next.pushText('Next.');
    next.endInput();
    expect((await collect(next)).length).toBeGreaterThan(0);
    expect(peer.sockets).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('bounds acquisition while prewarm waits for ready', async () => {
    const peer = await server({ noReady: true });
    const { value, errors } = client(peer.url, protocol);
    value.prewarm();
    await vi.waitFor(() => expect(peer.sockets).toHaveLength(1));
    const stream = value.stream({ connOptions: { ...options, timeoutMs: 20 } });
    stream.pushText('Hello.');
    stream.endInput();
    const frames = collect(stream);
    try {
      await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 200, interval: 10 });
      expect(errors[0]!.message).toContain('timed out');
      expect(await frames).toEqual([]);
    } finally {
      stream.close();
      await frames;
    }
  });

  it('cancels pending prewarm before pool close completes', async () => {
    const connect = vi.spyOn(RimeConnection, 'connect');
    const peer = await server({ noReady: true });
    const { value } = client(peer.url, protocol);
    value.prewarm();
    await vi.waitFor(() => expect(peer.sockets).toHaveLength(1));
    let settled = false;
    void connect.mock.results[0]!.value.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await value.close();
    expect(settled).toBe(true);
    await vi.waitFor(() => expect(peer.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
  });

  it('closes a connection acquired after the request timeout', async () => {
    let sendReady!: Send;
    const peer = await server({
      noReady: true,
      onConnect: (send) => {
        sendReady = send;
      },
    });
    const { value, errors } = client(peer.url, protocol);
    value.prewarm();
    await vi.waitFor(() => expect(peer.sockets).toHaveLength(1));
    const stream = value.stream({ connOptions: { ...options, timeoutMs: 20 } });
    stream.pushText('Hello.');
    stream.endInput();
    await collect(stream);
    expect(errors).toHaveLength(1);
    sendReady({
      case: 'ready',
      value: { $typeName: 'rime.WebSocketReady', protocol: 1, languages: [] },
    });
    await vi.waitFor(() => expect(peer.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
    expect(peer.requests).toHaveLength(0);
  });

  it('keeps the v1 endpoint when an update supplies undefined', async () => {
    const peer = await server();
    const connect = RimeConnection.connect;
    vi.spyOn(RimeConnection, 'connect').mockImplementation((url, ...args) => {
      // Keep a transport regression from reaching the public default endpoint.
      expect(url).toBe(peer.url);
      return connect(url, ...args);
    });
    const { value, errors } = client(peer.url, protocol);
    value.updateOptions({ websocketURL: undefined, speaker: 'astra' });
    const stream = value.stream({ connOptions: options });
    stream.pushText('Hello.');
    stream.endInput();
    expect((await collect(stream)).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect(peer.sockets[0]!.protocol).toBe(`rime.v1.${protocol}`);
  });

  it('preserves provider status and request ID when an error has no message', async () => {
    const peer = await server({
      ready: {
        case: 'error',
        value: create(WebSocketErrorSchema, { kind: 'internal', requestId: 'request' }),
      },
    });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: options });
    stream.pushText('Hello.');
    stream.endInput();
    await collect(stream);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ statusCode: 500, retryable: true, requestId: 'request' });
  });

  it('does not retry after audio has reached the consumer', async () => {
    const peer = await server({
      onRequest(request, send) {
        if (request.payload.case === 'start')
          send(
            {
              case: 'started',
              value: { $typeName: 'rime.WebSocketStarted', requestId: 'request' },
            },
            request.contextId,
          );
        if (request.payload.case === 'text') {
          send({ case: 'audio', value: Buffer.alloc(4800) }, request.contextId);
          send(
            {
              case: 'error',
              value: { $typeName: 'rime.WebSocketError', kind: 'unavailable', message: secret },
            },
            request.contextId,
          );
        }
      },
    });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: { ...options, maxRetry: 2 } });
    stream.pushText('Hello.');
    stream.endInput();
    expect((await collect(stream)).length).toBeGreaterThan(0);
    expect(peer.sockets).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.retryable).toBe(false);
    expect(String(errors[0])).not.toContain(secret);
  });

  it('does not retry unimplemented, even before audio', async () => {
    const peer = await server({
      ready: {
        case: 'error',
        value: { $typeName: 'rime.WebSocketError', kind: 'unimplemented', message: secret },
      },
    });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: { ...options, maxRetry: 2 } });
    stream.pushText('Hello.');
    stream.endInput();
    await collect(stream);
    expect(peer.sockets).toHaveLength(1);
    expect(errors[0]).toMatchObject({ statusCode: 501, retryable: false });
    expect(String(errors[0])).not.toContain(secret);
  });

  it('rejects a wrong ready version before sending a context', async () => {
    const peer = await server({
      ready: {
        case: 'ready',
        value: { $typeName: 'rime.WebSocketReady', protocol: 2, languages: [] },
      },
    });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: options });
    stream.pushText('Hello.');
    stream.endInput();
    await collect(stream);
    expect(peer.requests).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('bounds started waits and closes an unfinished context', async () => {
    const peer = await server({ onRequest() {} });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: { ...options, timeoutMs: 60 } });
    stream.pushText('Hello.');
    stream.flush();
    await collect(stream);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Timed out');
    await vi.waitFor(() => expect(peer.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
  });
  it('streams sentence audio before end, drains locally, and keeps one context across flush', async () => {
    const peer = await server();
    const { value, errors } = client(peer.url, protocol, { timeScaleFactor: 1.25 });
    const metrics: number[] = [];
    value.on('metrics_collected', (event) => metrics.push(event.charactersCount));
    const stream = value.stream({ connOptions: options });
    let receivedAudio = false;
    const frames = collect(stream, () => {
      receivedAudio = true;
    });
    stream.pushText('Hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.requests).toHaveLength(0);
    stream.pushText(' world.');
    stream.flush();
    await vi.waitFor(() =>
      expect(peer.requests.map((r) => r.payload.case)).toEqual(['start', 'text']),
    );
    expect(peer.headers).toEqual(['Bearer test-key']);
    await vi.waitFor(() => expect(receivedAudio).toBe(true));
    const start = peer.requests[0]!.payload;
    expect(
      start.case === 'start' && toJson(WebSocketRequestSchema, peer.requests[0]!),
    ).toMatchObject({
      start: {
        speaker: 'astra',
        language: 'eng',
        audioParameters: { audioFormat: 'audio/pcm', samplingRate: 24000, timeScaleFactor: 1.25 },
      },
    });
    // A normal input pause can exceed the API timeout after started.
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(errors).toEqual([]);
    stream.pushText(' More text.');
    stream.flush();
    stream.endInput();
    const result = await frames;
    expect(errors).toEqual([]);
    expect(result.length).toBeGreaterThan(2);
    expect(result.filter((frame) => frame.final)).toHaveLength(1);
    expect(new Set(result.map((frame) => frame.segmentId)).size).toBe(1);
    expect(metrics).toEqual(['Hello world. More text.'.length]);
    expect(peer.requests.map((r) => r.payload.case)).toEqual(['start', 'text', 'text', 'end']);
    expect(peer.requests[1]!.payload.value).toBe('Hello world. ');
  });

  it('reuses connections, skips empty contexts, and separates overlapping streams', async () => {
    const peer = await server();
    const { value, errors } = client(peer.url, protocol);
    value.prewarm();
    await vi.waitFor(() => expect(peer.sockets).toHaveLength(1));
    const empty = value.stream({ connOptions: options });
    empty.flush();
    empty.endInput();
    expect(await collect(empty)).toEqual([]);
    expect(errors).toEqual([]);
    expect(peer.requests).toHaveLength(0);
    for (let i = 0; i < 2; i++) {
      const stream = value.stream({ connOptions: options });
      stream.pushText('Hello.');
      stream.endInput();
      await collect(stream);
    }
    expect(peer.sockets).toHaveLength(1);
    const a = value.stream({ connOptions: options });
    const b = value.stream({ connOptions: options });
    a.pushText('A.');
    a.flush();
    b.pushText('B.');
    b.flush();
    await vi.waitFor(() => expect(peer.sockets).toHaveLength(2));
    a.endInput();
    b.endInput();
    await Promise.all([collect(a), collect(b)]);
  });

  it('cancels and drains a context before reusing its connection', async () => {
    const peer = await server();
    const { value, errors } = client(peer.url, protocol);
    const first = value.stream({ connOptions: options });
    first.pushText('Hello.');
    first.flush();
    await vi.waitFor(() => expect(peer.requests.some((r) => r.payload.case === 'text')).toBe(true));
    first.close();
    await first.waitClosed();
    expect(peer.requests.some((r) => r.payload.case === 'cancel')).toBe(true);
    const next = value.stream({ connOptions: options });
    next.pushText('Again.');
    next.endInput();
    await collect(next);
    expect(peer.sockets).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('discards a connection if cancellation has no reply', async () => {
    const peer = await server({ noCancel: true });
    const { value } = client(peer.url, protocol);
    const first = value.stream({ connOptions: { ...options, timeoutMs: 60 } });
    first.pushText('Hello.');
    first.flush();
    await vi.waitFor(() => expect(peer.requests.some((r) => r.payload.case === 'text')).toBe(true));
    first.close();
    await first.waitClosed();
    const next = value.stream({ connOptions: options });
    next.endInput();
    await collect(next);
    expect(peer.sockets).toHaveLength(2);
  });

  it('bounds the wait for done after end', async () => {
    const peer = await server({ noEnd: true });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: { ...options, timeoutMs: 60 } });
    stream.pushText('Hello.');
    stream.endInput();
    await collect(stream);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Timed out');
  });

  it.each([
    'earlyDone',
    'wrongContext',
    'audioBeforeStarted',
    'missingRequestId',
    'duplicateStarted',
    'unexpectedCancelled',
  ] as const)('rejects %s and closes the connection', async (mode) => {
    const peer = await server({
      onRequest(request, send) {
        if (request.payload.case !== 'start') return;
        const id = request.contextId;
        const started = {
          case: 'started',
          value: {
            $typeName: 'rime.WebSocketStarted',
            requestId: mode === 'missingRequestId' ? '' : 'request',
          },
        } as const;
        if (mode === 'audioBeforeStarted') {
          send({ case: 'audio', value: Buffer.alloc(10) }, id);
          return;
        }
        send(started, mode === 'wrongContext' ? secret : id);
        if (mode === 'earlyDone')
          send({ case: 'done', value: { $typeName: 'rime.WebSocketDone' } }, id);
        if (mode === 'duplicateStarted') send(started, id);
        if (mode === 'unexpectedCancelled')
          send({ case: 'cancelled', value: { $typeName: 'rime.WebSocketCancelled' } }, id);
      },
    });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: options });
    stream.pushText('Hello.');
    stream.flush();
    await collect(stream);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).not.toContain(secret);
    await vi.waitFor(() => expect(peer.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
  });

  it('snapshots options and retires old pools after their last stream finishes', async () => {
    const a = await server();
    const b = await server();
    const { value } = client(a.url, protocol);
    const models: (string | undefined)[] = [];
    value.on('metrics_collected', (event) => models.push(event.metadata?.modelName));
    const first = value.stream({ connOptions: options });
    const second = value.stream({ connOptions: options });
    value.updateOptions({
      websocketURL: b.url.replace('/coda/', '/mist/'),
      samplingRate: 16000,
      speaker: 'cove',
      pauseBetweenBrackets: false,
    });
    for (const stream of [first, second]) {
      stream.pushText('Hello.');
      stream.endInput();
    }
    const old = await Promise.all([collect(first), collect(second)]);
    expect(old.flat().every((frame) => frame.frame.sampleRate === 24000)).toBe(true);
    expect(models).toEqual(['coda', 'coda']);
    await vi.waitFor(() =>
      expect(a.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true),
    );
    const next = value.stream({ connOptions: options });
    next.pushText('New.');
    next.endInput();
    expect((await collect(next)).every((frame) => frame.frame.sampleRate === 16000)).toBe(true);
    expect(models).toEqual(['coda', 'coda', 'mistv3']);
    const start = b.requests[0]!.payload;
    expect(start.case === 'start' && start.value.mistParameters?.pauseBetweenBrackets).toBe(false);
  });

  it('replays complete input on retry before audio', async () => {
    let attempt = 0;
    const peer = await server({
      onRequest(request, send) {
        if (request.payload.case === 'start') {
          attempt++;
          if (attempt === 1)
            send(
              {
                case: 'error',
                value: { $typeName: 'rime.WebSocketError', kind: 'unavailable', message: secret },
              },
              request.contextId,
            );
          else
            send(
              {
                case: 'started',
                value: { $typeName: 'rime.WebSocketStarted', requestId: 'second' },
              },
              request.contextId,
            );
        }
        if (attempt > 1 && request.payload.case === 'text')
          send({ case: 'audio', value: Buffer.alloc(4800) }, request.contextId);
        if (attempt > 1 && request.payload.case === 'end')
          send({ case: 'done', value: { $typeName: 'rime.WebSocketDone' } }, request.contextId);
      },
    });
    const { value, errors } = client(peer.url, protocol);
    const stream = value.stream({ connOptions: { ...options, maxRetry: 1 } });
    stream.pushText('Hello.');
    stream.endInput();
    expect((await collect(stream)).length).toBeGreaterThan(0);
    expect(attempt).toBe(2);
    expect(errors).toEqual([]);
  });

  it.each([
    'audio/pcm',
    'audio/pcmu',
    'audio/wav',
    'audio/mpeg',
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
  ] as const)('decodes %s including split packets', async (format) => {
    const pcm = Buffer.alloc(12000);
    for (let i = 0; i < pcm.length; i += 2)
      pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 5000), i);
    const fixtures = JSON.parse(
      readFileSync(new URL('./fixtures/audio-formats.json', import.meta.url), 'utf8'),
    ) as Record<RimeAudioFormat, string>;
    const audio =
      format === 'audio/pcm'
        ? pcm
        : format === 'audio/pcmu'
          ? Buffer.alloc(6000, 255)
          : Buffer.from(fixtures[format], 'base64');
    const peer = await server({ audio });
    const { value, errors } = client(peer.url, protocol, { audioFormat: format });
    const stream = value.stream({ connOptions: { ...options, timeoutMs: 2000 } });
    stream.pushText('Audio.');
    stream.endInput();
    const frames = await collect(stream);
    expect(errors).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);
    expect(
      frames.every((frame) => frame.frame.sampleRate === 24000 && frame.frame.channels === 1),
    ).toBe(true);
    expect(frames.at(-1)!.final).toBe(true);
    const samples = frames.reduce((sum, frame) => sum + frame.frame.samplesPerChannel, 0);
    expect(samples).toBeGreaterThanOrEqual(5500);
    expect(samples).toBeLessThan(8500);
  });
});

it('decodes G.711 mu-law as signed little-endian PCM', () => {
  expect([...new Int16Array(decodeMuLaw(Uint8Array.from([0, 128, 255, 127])).buffer)]).toEqual([
    -32124, 32124, 0, 0,
  ]);
});

it.each([
  '{',
  '{"done":null}',
  '{"done":[],"contextId":"ctx"}',
  '{"done":{},"audio":""}',
  '{"audio":"!!!"}',
  '{"audio":1}',
])('sanitizes malformed JSON %s', (data) => {
  expect(() => decodeResponse(Buffer.from(data), false, 'json')).toThrow(
    'invalid protocol envelope',
  );
});

it.each([
  ['invalid_input', 400, false],
  ['unauthenticated', 401, false],
  ['permission_denied', 403, false],
  ['not_found', 404, false],
  ['resource_exhausted', 429, true],
  ['timeout', 504, true],
  ['unavailable', 503, true],
  ['unimplemented', 501, false],
  ['internal', 500, true],
  [secret, 500, true],
] as const)('maps and sanitizes provider kind %s', (kind, statusCode, retryable) => {
  const error = providerError(
    { $typeName: 'rime.WebSocketError', kind, message: secret },
    'request',
  );
  expect(error).toMatchObject({ statusCode, retryable, requestId: 'request' });
  expect(String(error)).not.toContain(secret);
  expect(error.cause).toBeUndefined();
});

it('times out a blocked write without retaining its payload', async () => {
  const peer = await server();
  const connection = await RimeConnection.connect(peer.url, 'key', 500, 'binary');
  vi.spyOn(connection.socket, 'send').mockImplementation(() => {});
  await expect(connection.send(secret, new AbortController().signal, 20)).rejects.toThrow(
    'timed out',
  );
  connection.close();
});

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/websocket-v1.json', import.meta.url), 'utf8'),
) as { message: string; binary: string; json: Record<string, never> }[];
describe('published protocol wire contract', () => {
  it.each(fixtures.map((fixture, i) => ({ ...fixture, i })))(
    'matches fixed envelope $i',
    (fixture) => {
      const bytes = Buffer.from(fixture.binary, 'hex');
      if (fixture.message === 'WebSocketRequest') {
        const message = fromJsonString(WebSocketRequestSchema, JSON.stringify(fixture.json));
        expect(Buffer.from(toBinary(WebSocketRequestSchema, message)).toString('hex')).toBe(
          fixture.binary,
        );
        expect(toJson(WebSocketRequestSchema, fromBinary(WebSocketRequestSchema, bytes))).toEqual(
          fixture.json,
        );
      } else {
        for (const protocol of ['binary', 'json'] as const) {
          const message = decodeResponse(
            protocol === 'binary' ? bytes : Buffer.from(JSON.stringify(fixture.json)),
            protocol === 'binary',
            protocol,
          );
          expect(toJson(WebSocketResponseSchema, message)).toEqual(fixture.json);
          expect(Buffer.from(toBinary(WebSocketResponseSchema, message)).toString('hex')).toBe(
            fixture.binary,
          );
        }
      }
    },
  );
});
