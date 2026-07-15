// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, tts } from '@livekit/agents';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const servers: WebSocketServer[] = [];
const synthesizers: TTS[] = [];

async function startServer(
  onMessage: (
    socket: WebSocket,
    message: Record<string, unknown>,
    messages: Record<string, unknown>[],
  ) => void,
): Promise<{ url: string; messages: Record<string, unknown>[] }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }

  const messages: Record<string, unknown>[] = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message: Record<string, unknown> = JSON.parse(raw.toString());
      messages.push(message);
      onMessage(socket, message, messages);
    });
  });
  return { url: `ws://127.0.0.1:${address.port}`, messages };
}

function createTTS(options: ConstructorParameters<typeof TTS>[0] = {}): TTS {
  const synthesizer = new TTS({ apiKey: 'test-key', ...options });
  synthesizers.push(synthesizer);
  return synthesizer;
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Consume the complete stream.
  }
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function settlementByNextTurn(promise: Promise<void>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
}

const swallowExpectedRejection = (reason: unknown) => {
  if (reason instanceof APIStatusError) return;
  throw reason;
};

beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

afterEach(async () => {
  await Promise.all(synthesizers.splice(0).map((synthesizer) => synthesizer.close()));
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe('Soniox TTS speed options', () => {
  it.each([0.7, 1, 1.3])('accepts constructor speed %s', (speed) => {
    expect(() => createTTS({ speed })).not.toThrow();
  });

  it.each([0.69, 1.31, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects constructor speed %s',
    (speed) => {
      expect(() => createTTS({ speed })).toThrow(/speed must be between 0.7 and 1.3/);
    },
  );

  it.each([0.69, 1.31, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects updated speed %s',
    (speed) => {
      const synthesizer = createTTS();
      expect(() => synthesizer.updateOptions({ speed })).toThrow(
        /speed must be between 0.7 and 1.3/,
      );
    },
  );

  it('sends default speed and bitrate in the initial request', async () => {
    const { url, messages } = await startServer((socket, message) => {
      if (typeof message.stream_id === 'string' && typeof message.text === 'string') {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            audio: Buffer.alloc(480).toString('base64'),
            audio_end: true,
            terminated: true,
          }),
        );
      }
    });
    const synthesizer = createTTS({ websocketUrl: url, bitrate: 32000 });

    await consume(synthesizer.synthesize('hello'));

    expect(messages[0]).toMatchObject({ speed: 1, bitrate: 32000 });
  });

  it('sends an updated custom speed in the initial request', async () => {
    const { url, messages } = await startServer((socket, message) => {
      if (typeof message.stream_id === 'string' && typeof message.text === 'string') {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            audio: Buffer.alloc(480).toString('base64'),
            audio_end: true,
            terminated: true,
          }),
        );
      }
    });
    const synthesizer = createTTS({ websocketUrl: url });
    synthesizer.updateOptions({ speed: 1.3 });

    await consume(synthesizer.synthesize('hello'));

    expect(messages[0]).toMatchObject({ speed: 1.3 });
  });
});

describe('Soniox TTS stream cleanup', () => {
  it('delivers retry audio before ending a streaming consumer', async () => {
    let requestCount = 0;
    let retryRequestCompletedResolve: (() => void) | undefined;
    const retryRequestCompleted = new Promise<void>((resolve) => {
      retryRequestCompletedResolve = resolve;
    });
    const { url, messages } = await startServer((socket, message) => {
      if (typeof message.stream_id !== 'string') return;
      if (message.text_end === true && requestCount === 2) {
        retryRequestCompletedResolve?.();
      }
      if (typeof message.text !== 'string') return;
      requestCount += 1;
      if (requestCount === 1) {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            error_code: 503,
            error_message: 'temporarily unavailable',
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.alloc(480, 1).toString('base64'),
          audio_end: true,
          terminated: true,
        }),
      );
    });
    const synthesizer = createTTS({ websocketUrl: url });
    const stream = synthesizer.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const outputOrder: Array<'audio' | 'end'> = [];
    const audioBytes: number[] = [];
    stream.pushText('hello');
    stream.endInput();
    const outputTask = (async () => {
      for await (const event of stream) {
        if (event === tts.SynthesizeStream.END_OF_STREAM) {
          outputOrder.push('end');
          break;
        }
        outputOrder.push('audio');
        audioBytes.push(...new Uint8Array(event.frame.data.buffer));
      }
      if (outputOrder.at(-1) !== 'end') outputOrder.push('end');
    })();

    await waitFor(outputTask);
    await retryRequestCompleted;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const textMessages = messages.filter((message) => typeof message.text === 'string');
    expect(textMessages.map((message) => message.text)).toEqual(['hello', 'hello']);
    expect(messages.filter((message) => message.text_end === true)).toHaveLength(2);
    expect(outputOrder).toEqual(['audio', 'end']);
    expect(audioBytes).toEqual(expect.arrayContaining([1]));
  });

  it('cancels and settles an active streaming retry when TTS closes', async () => {
    let requestCount = 0;
    let retryStartedResolve: (() => void) | undefined;
    const retryStarted = new Promise<void>((resolve) => {
      retryStartedResolve = resolve;
    });
    let cancelObservedResolve: (() => void) | undefined;
    const cancelObserved = new Promise<'cancel'>((resolve) => {
      cancelObservedResolve = () => resolve('cancel');
    });
    let socketClosedResolve: (() => void) | undefined;
    const socketClosed = new Promise<'closed'>((resolve) => {
      socketClosedResolve = () => resolve('closed');
    });
    const { url, messages } = await startServer((socket, message) => {
      if (message.cancel === true) {
        cancelObservedResolve?.();
        return;
      }
      if (typeof message.stream_id !== 'string' || typeof message.text !== 'string') return;
      requestCount += 1;
      if (requestCount === 1) {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            error_code: 503,
            error_message: 'temporarily unavailable',
          }),
        );
        return;
      }
      socket.once('close', () => socketClosedResolve?.());
      retryStartedResolve?.();
    });
    const synthesizer = createTTS({ websocketUrl: url });
    const stream = synthesizer.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    stream.pushText('hello');
    stream.endInput();
    const outputTask = consume(stream);
    await retryStarted;

    const terminalEvent = Promise.race([cancelObserved, socketClosed]);
    await synthesizer.close();

    expect(await terminalEvent).toBe('cancel');
    expect(messages.filter((message) => message.cancel === true)).toHaveLength(1);
    expect(await settlementByNextTurn(outputTask)).toBe('settled');
  });

  it('delivers successful chunked retry audio before closing the consumer', async () => {
    let requestCount = 0;
    let retryRequestCompletedResolve: (() => void) | undefined;
    const retryRequestCompleted = new Promise<void>((resolve) => {
      retryRequestCompletedResolve = resolve;
    });
    const { url, messages } = await startServer((socket, message) => {
      if (typeof message.stream_id !== 'string') return;
      if (message.text_end === true && requestCount === 2) {
        retryRequestCompletedResolve?.();
      }
      if (typeof message.text !== 'string') return;
      requestCount += 1;
      if (requestCount === 1) {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            error_code: 503,
            error_message: 'temporarily unavailable',
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.alloc(480, 2).toString('base64'),
          audio_end: true,
          terminated: true,
        }),
      );
    });
    const synthesizer = createTTS({ websocketUrl: url });
    const audioBytes: number[] = [];

    for await (const event of synthesizer.synthesize('hello', {
      maxRetry: 1,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    })) {
      audioBytes.push(...new Uint8Array(event.frame.data.buffer));
    }
    await retryRequestCompleted;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(messages.filter((message) => typeof message.text === 'string')).toHaveLength(2);
    expect(messages.filter((message) => message.text_end === true)).toHaveLength(2);
    expect(audioBytes).toEqual(expect.arrayContaining([2]));
  });

  it('settles and deregisters a streaming request when close receives no response', async () => {
    let requestStartedResolve: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      requestStartedResolve = resolve;
    });
    let cancelObservedResolve: (() => void) | undefined;
    const cancelObserved = new Promise<void>((resolve) => {
      cancelObservedResolve = resolve;
    });
    const { url } = await startServer((_socket, message) => {
      if (typeof message.text === 'string') requestStartedResolve?.();
      if (message.cancel === true) cancelObservedResolve?.();
    });
    const synthesizer = createTTS({ websocketUrl: url });
    const stream = synthesizer.stream();
    const originalClose = stream.close.bind(stream);
    let closeCalls = 0;
    stream.close = () => {
      closeCalls += 1;
      originalClose();
    };
    stream.pushText('hello');
    void consume(stream);
    await requestStarted;

    stream.close();
    await cancelObserved;
    await synthesizer.close();

    expect(closeCalls).toBe(1);
  });

  it('settles and deregisters a chunked request when aborted without a response', async () => {
    let requestStartedResolve: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      requestStartedResolve = resolve;
    });
    let cancelObservedResolve: (() => void) | undefined;
    const cancelObserved = new Promise<void>((resolve) => {
      cancelObservedResolve = resolve;
    });
    const { url } = await startServer((_socket, message) => {
      if (typeof message.text === 'string') requestStartedResolve?.();
      if (message.cancel === true) cancelObservedResolve?.();
    });
    const synthesizer = createTTS({ websocketUrl: url });
    synthesizer.on('error', () => {});
    const abortController = new AbortController();
    const stream = synthesizer.synthesize('hello', { maxRetry: 0 }, abortController.signal);
    const outputTask = consume(stream);
    await requestStarted;

    abortController.abort();

    expect(await settlementByNextTurn(outputTask)).toBe('settled');
    await cancelObserved;
  });

  it('finishes a streaming request when the server completes before input ends', async () => {
    const { url } = await startServer((socket, message) => {
      if (typeof message.stream_id === 'string' && typeof message.text === 'string') {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            audio: Buffer.alloc(480).toString('base64'),
            audio_end: true,
            terminated: true,
          }),
        );
      }
    });
    const synthesizer = createTTS({ websocketUrl: url });
    const stream = synthesizer.stream();
    stream.pushText('hello');

    await waitFor(consume(stream));
  });

  it('removes completed streaming requests from TTS state', async () => {
    const { url } = await startServer((socket, message) => {
      if (typeof message.stream_id === 'string' && typeof message.text === 'string') {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            audio: Buffer.alloc(480).toString('base64'),
            audio_end: true,
            terminated: true,
          }),
        );
      }
    });
    const synthesizer = createTTS({ websocketUrl: url });
    const stream = synthesizer.stream();
    const originalClose = stream.close.bind(stream);
    let closeCalls = 0;
    stream.close = () => {
      closeCalls += 1;
      originalClose();
    };
    stream.pushText('hello');

    await waitFor(consume(stream));
    await synthesizer.close();

    expect(closeCalls).toBe(0);
  });

  it('finishes a streaming request when the server errors before input ends', async () => {
    const { url } = await startServer((socket, message) => {
      if (typeof message.stream_id === 'string' && typeof message.text === 'string') {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            error_code: 400,
            error_message: 'invalid request',
          }),
        );
      }
    });
    const synthesizer = createTTS({ websocketUrl: url });
    synthesizer.on('error', () => {});
    const stream = synthesizer.stream({ connOptions: { maxRetry: 0 } });
    stream.pushText('hello');

    await waitFor(consume(stream));
  });

  it('reuses the pooled connection after a failed chunked request', async () => {
    let requestCount = 0;
    let connectionCount = 0;
    const { url } = await startServer((socket, message) => {
      if (typeof message.stream_id !== 'string' || typeof message.text !== 'string') return;
      requestCount += 1;
      if (requestCount === 1) {
        socket.send(
          JSON.stringify({
            stream_id: message.stream_id,
            error_code: 400,
            error_message: 'invalid request',
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          stream_id: message.stream_id,
          audio: Buffer.alloc(480).toString('base64'),
          audio_end: true,
          terminated: true,
        }),
      );
    });
    servers.at(-1)?.on('connection', () => {
      connectionCount += 1;
    });
    const synthesizer = createTTS({ websocketUrl: url });
    synthesizer.on('error', () => {});

    await consume(synthesizer.synthesize('fail', { maxRetry: 0 }));
    await consume(synthesizer.synthesize('succeed', { maxRetry: 0 }));

    expect(connectionCount).toBe(1);
  });
});
