// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';
import { STTv2 } from './stt_v2.js';

let server: WebSocketServer;
let stream: stt.SpeechStream | undefined;

async function startServer() {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP server');
  return `ws://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  stream?.close();
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('Deepgram STT error recovery', () => {
  it('preserves API errors when v1 exhausts its reconnect attempts', async () => {
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
      schedule(callback, ms === 5000 || ms === 10000 ? 0 : ms, ...args),
    );
    const baseUrl = await startServer();
    server.on('connection', (socket) => socket.close(1011));
    const provider = new STT({ apiKey: 'test', baseUrl });
    const onError = vi.fn();
    provider.on('error', onError);
    stream = provider.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 } });
    for await (const _ of stream) {
      /* drain */
    }
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error: stream.terminalError }),
    );
  });

  it('propagates a v2 provider error without waiting for the socket to close', async () => {
    const endpointUrl = await startServer();
    const body = { type: 'Error', description: 'service unavailable' };
    server.on('connection', (socket) => {
      socket.once('pong', () => socket.send(JSON.stringify(body)));
      socket.ping();
    });
    const provider = new STTv2({ apiKey: 'test', endpointUrl });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 } });
    await vi.waitFor(() => expect(stream?.terminalError).toBeInstanceOf(APIStatusError));
    expect(stream.terminalError?.message).toContain('service unavailable');
  });
});

describe('Deepgram v1 dead socket recovery', () => {
  const FAST_CONN_OPTIONS = { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1000 };

  const STALL_WINDOW_MS = 50;
  const PAST_STALL_WINDOW_MS = 120;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  function frameOf(value: number, samples = 1600) {
    return new AudioFrame(new Int16Array(samples).fill(value), 16000, 1, samples);
  }

  function resultsMessage(opts: {
    text: string;
    isFinal: boolean;
    speechFinal?: boolean;
    start: number;
    duration: number;
    wordEnd?: number;
  }) {
    return JSON.stringify({
      type: 'Results',
      is_final: opts.isFinal,
      speech_final: opts.speechFinal ?? false,
      start: opts.start,
      duration: opts.duration,
      metadata: { request_id: 'req' },
      channel: {
        alternatives: [
          {
            transcript: opts.text,
            confidence: 0.9,
            words: opts.text
              ? [
                  {
                    word: opts.text,
                    start: opts.start,
                    end: opts.wordEnd ?? opts.start + opts.duration,
                  },
                ]
              : [],
          },
        ],
      },
    });
  }

  function collectEvents(s: stt.SpeechStream) {
    const events: stt.SpeechEvent[] = [];
    (async () => {
      for await (const event of s) events.push(event);
    })().catch(() => {});
    return events;
  }

  function recordConnections() {
    const sockets: WebSocket[] = [];
    const audio: number[][] = [];
    const commands: string[][] = [];
    server.on('connection', (socket) => {
      const index = sockets.push(socket) - 1;
      audio[index] = [];
      commands[index] = [];
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          commands[index]!.push(JSON.parse(data.toString()).type);
          return;
        }
        const pcm = new Int16Array(
          (data as Buffer).buffer,
          (data as Buffer).byteOffset,
          (data as Buffer).byteLength / 2,
        );
        audio[index]!.push(...pcm);
      });
    });
    return { sockets, audio, commands };
  }

  const typesOf = (events: stt.SpeechEvent[]) =>
    events.filter((e) => e.type !== stt.SpeechEventType.RECOGNITION_USAGE).map((e) => e.type);

  it('does not redial when usage is reported after the event queue closed', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    (stream as unknown as { queue: { close(): void } }).queue.close();
    stream.pushFrame(frameOf(1));
    stream.flush();
    await sleep(100);

    expect(sockets).toHaveLength(1);
  });

  it('commits the open turn and starts the next one when the socket drops mid-turn', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    sockets[0]!.send(resultsMessage({ text: 'hello', isFinal: false, start: 0, duration: 0.5 }));
    await vi.waitFor(() => expect(typesOf(events)).toHaveLength(2));
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(typesOf(events)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(final?.alternatives?.[0]?.text).toBe('hello');

    sockets[1]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    await vi.waitFor(() => expect(typesOf(events)).toHaveLength(5));
    expect(typesOf(events)[4]).toBe(stt.SpeechEventType.START_OF_SPEECH);
  });

  it('replays the audio Deepgram had not transcribed to the next socket', async () => {
    const baseUrl = await startServer();
    const { sockets, audio } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    for (const value of [1, 2, 3, 4, 5]) stream.pushFrame(frameOf(value));
    await vi.waitFor(() => expect(audio[0]).toHaveLength(5 * 1600));

    // transcribed up to 0.2 s: the first two frames are acknowledged, the other three are owed
    sockets[0]!.send(resultsMessage({ text: '', isFinal: true, start: 0, duration: 0.2 }));
    await sleep(50);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    stream.pushFrame(frameOf(6));
    const owed = [3, 4, 5, 6].flatMap((value) => new Array<number>(1600).fill(value));
    await vi.waitFor(() => expect(audio[1]).toHaveLength(owed.length));
    expect(audio[1]).toEqual(owed);
  });

  it('keeps the audio past the last recognized word when an interim is committed on a drop', async () => {
    const baseUrl = await startServer();
    const { sockets, audio } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    for (let value = 1; value <= 10; value++) stream.pushFrame(frameOf(value));
    await vi.waitFor(() => expect(audio[0]).toHaveLength(10 * 1600));

    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    sockets[0]!.send(
      resultsMessage({ text: 'hello', isFinal: false, start: 0, duration: 1, wordEnd: 0.7 }),
    );
    await sleep(50);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    const owed = [8, 9, 10].flatMap((value) => new Array<number>(1600).fill(value));
    await vi.waitFor(() => expect(audio[1]).toHaveLength(owed.length));
    expect(audio[1]).toEqual(owed);
  });

  it('continues word times from the stream position after a redial with audio replayed', async () => {
    const baseUrl = await startServer();
    const { sockets, audio } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    for (let value = 1; value <= 10; value++) stream.pushFrame(frameOf(value));
    await vi.waitFor(() => expect(audio[0]).toHaveLength(10 * 1600));

    // transcribed up to 0.3 s: the next socket receives the audio from 0.3 s on
    sockets[0]!.send(resultsMessage({ text: '', isFinal: true, start: 0, duration: 0.3 }));
    await sleep(50);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(audio[1]).toHaveLength(7 * 1600));

    sockets[1]!.send(
      resultsMessage({
        text: 'hello',
        isFinal: true,
        speechFinal: true,
        start: 0.1,
        duration: 0.3,
      }),
    );
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
    );
    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    const word = final?.alternatives?.[0]?.words?.[0];
    expect(word?.startTime).toBeCloseTo(0.4, 5);
    expect(word?.endTime).toBeCloseTo(0.7, 5);
  });

  it('continues word times from the audio already sent after a redial with nothing to replay', async () => {
    const baseUrl = await startServer();
    const { sockets, audio } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    for (let value = 1; value <= 5; value++) stream.pushFrame(frameOf(value));
    await vi.waitFor(() => expect(audio[0]).toHaveLength(5 * 1600));

    sockets[0]!.send(resultsMessage({ text: '', isFinal: true, start: 0, duration: 0.5 }));
    await sleep(50);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    stream.pushFrame(frameOf(6));
    await vi.waitFor(() => expect(audio[1]).toHaveLength(1600));
    sockets[1]!.send(
      resultsMessage({ text: 'again', isFinal: true, speechFinal: true, start: 0, duration: 0.1 }),
    );
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
    );
    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(final?.alternatives?.[0]?.words?.[0]?.startTime).toBeCloseTo(0.5, 5);
  });

  it('does not place a transcript before an earlier one when audio was sent faster than real time and a retry has nothing to replay', async () => {
    const baseUrl = await startServer();
    const { sockets, audio } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    for (let value = 1; value <= 5; value++) stream.pushFrame(frameOf(value));
    await vi.waitFor(() => expect(audio[0]).toHaveLength(5 * 1600));

    sockets[0]!.send(
      resultsMessage({
        text: 'first',
        isFinal: true,
        speechFinal: true,
        start: 0.3,
        duration: 0.2,
      }),
    );
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true),
    );

    // the next dial is refused once, so the attempt fails and the base class retries it after
    // far less wall time than the 0.5 s of audio already sent
    let refused = false;
    const handleUpgrade = server.handleUpgrade.bind(server);
    server.handleUpgrade = (request, socket, head, callback) => {
      if (refused) return handleUpgrade(request, socket, head, callback);
      refused = true;
      socket.destroy();
    };
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(refused).toBe(true);

    stream.pushFrame(frameOf(6));
    await vi.waitFor(() => expect(audio[1]).toHaveLength(1600));
    sockets[1]!.send(
      resultsMessage({ text: 'second', isFinal: true, speechFinal: true, start: 0, duration: 0.1 }),
    );
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toHaveLength(2),
    );
    const [first, second] = events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(first?.alternatives?.[0]?.words?.[0]?.endTime).toBeCloseTo(0.5, 5);
    expect(second?.alternatives?.[0]?.words?.[0]?.startTime).toBeGreaterThanOrEqual(0.5);
  });

  it('resends a Finalize the dead socket never answered', async () => {
    const baseUrl = await startServer();
    const { sockets, audio, commands } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    stream.pushFrame(frameOf(1));
    stream.flush();
    await vi.waitFor(() => expect(commands[0]).toContain('Finalize'));
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    await vi.waitFor(() => expect(commands[1]).toContain('Finalize'));
    expect(audio[1]).toHaveLength(1600);
  });

  it('does not resend a Finalize that Deepgram already answered', async () => {
    const baseUrl = await startServer();
    const { sockets, commands } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    stream.pushFrame(frameOf(1));
    stream.flush();
    await vi.waitFor(() => expect(commands[0]).toContain('Finalize'));
    sockets[0]!.send(resultsMessage({ text: 'hi', isFinal: true, start: 0, duration: 0.1 }));
    await sleep(50);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await sleep(50);

    expect(commands[1]).not.toContain('Finalize');
  });

  it('does not treat a long utterance as a stall when interim results are off', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({
      apiKey: 'test',
      baseUrl,
      interimResults: false,
      turnStallTimeoutMs: 50,
    });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    await sleep(250);

    expect(sockets).toHaveLength(1);
    expect(typesOf(events)).toEqual([stt.SpeechEventType.START_OF_SPEECH]);
  });

  it('replays on the real audio timeline when the input is stereo', async () => {
    const baseUrl = await startServer();
    const { sockets, audio } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, numChannels: 2 });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    const stereoFrame = (value: number) =>
      new AudioFrame(new Int16Array(3200).fill(value), 16000, 2, 1600);
    for (const value of [1, 2, 3, 4, 5]) stream.pushFrame(stereoFrame(value));
    await vi.waitFor(() => expect(audio[0]).toHaveLength(5 * 3200));

    sockets[0]!.send(resultsMessage({ text: '', isFinal: true, start: 0, duration: 0.2 }));
    await sleep(50);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    stream.pushFrame(stereoFrame(6));
    const owed = [3, 4, 5, 6].flatMap((value) => new Array<number>(3200).fill(value));
    await vi.waitFor(() => expect(audio[1]).toHaveLength(owed.length));
    expect(audio[1]).toEqual(owed);
  });

  it('counts a repeated SpeechStarted as a sign of life', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: 300 });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    await sleep(200);
    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    await sleep(200);

    expect(sockets).toHaveLength(1);
  });

  it('commits a turn that stalls on a socket that is still answering', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: 100 });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    sockets[0]!.send(resultsMessage({ text: 'hello', isFinal: false, start: 0, duration: 0.5 }));

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(typesOf(events)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
  });

  it('does not treat silence between turns as a stall', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: 50 });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await sleep(200);

    expect(sockets).toHaveLength(1);
  });

  it('gives up with a non-retryable error when sockets keep dropping without a finished turn', async () => {
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
      schedule(callback, ms === 5000 || ms === 10000 ? 0 : ms, ...args),
    );
    const baseUrl = await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      socket.close(1011);
    });
    const provider = new STT({ apiKey: 'test', baseUrl });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    for await (const _ of stream) {
      /* drain */
    }

    expect(connections).toBe(2);
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
  });

  it('counts only drops since the last finished turn toward the budget', async () => {
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
      schedule(callback, ms === 5000 || ms === 10000 ? 0 : ms, ...args),
    );
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: STALL_WINDOW_MS });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    collectEvents(stream);

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(i + 1));
      sockets[i]!.send(JSON.stringify({ type: 'SpeechStarted' }));
      sockets[i]!.send(
        resultsMessage({ text: 'hi', isFinal: true, speechFinal: true, start: 0, duration: 0.5 }),
      );
      await sleep(PAST_STALL_WINDOW_MS);
      sockets[i]!.terminate();
    }
    await vi.waitFor(() => expect(sockets).toHaveLength(5));
    expect(stream.terminalError).toBeUndefined();
  });

  it('keeps recovering from drops spread over a long silent call when each socket answered', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: STALL_WINDOW_MS });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    collectEvents(stream);

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(i + 1));
      sockets[i]!.send(resultsMessage({ text: '', isFinal: false, start: 0, duration: 1 }));
      await sleep(PAST_STALL_WINDOW_MS);
      sockets[i]!.terminate();
    }
    await vi.waitFor(() => expect(sockets).toHaveLength(5));
    expect(stream.terminalError).toBeUndefined();
  });

  it('counts a socket that answers a ping as serving even when it sends no result', async () => {
    const scheduleInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number) =>
      scheduleInterval(callback, ms === 30_000 ? 20 : ms)) as typeof setInterval);
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: STALL_WINDOW_MS });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    collectEvents(stream);

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(i + 1));
      await sleep(PAST_STALL_WINDOW_MS);
      sockets[i]!.terminate();
    }
    await vi.waitFor(() => expect(sockets).toHaveLength(5));
    expect(stream.terminalError).toBeUndefined();
  });

  it('still gives up when sockets die without answering, counting only since one that did', async () => {
    const baseUrl = await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      if (connections === 2) {
        setTimeout(
          () => socket.send(resultsMessage({ text: '', isFinal: false, start: 0, duration: 1 })),
          20,
        );
        setTimeout(() => socket.terminate(), PAST_STALL_WINDOW_MS);
        return;
      }
      socket.close(1011);
    });
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: STALL_WINDOW_MS });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    for await (const _ of stream) {
      /* drain */
    }

    expect(connections).toBe(3);
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
  });

  it('counts a socket that answers and drops within the stall window toward the budget and backs off', async () => {
    const waits: number[] = [];
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      if (ms !== 5000 && ms !== 10000) return schedule(callback, ms, ...args);
      waits.push(ms);
      return schedule(callback, 0, ...args);
    });
    const baseUrl = await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      setTimeout(
        () => socket.send(resultsMessage({ text: '', isFinal: false, start: 0, duration: 1 })),
        20,
      );
      setTimeout(() => socket.terminate(), 40);
    });
    const provider = new STT({ apiKey: 'test', baseUrl });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1000 } });
    for await (const _ of stream) {
      /* drain */
    }

    expect(connections).toBe(4);
    expect(waits).toEqual([5000, 10000]);
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
  });

  it('redials without a wait after each socket that answered', async () => {
    const waits: number[] = [];
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      if (ms !== 5000 && ms !== 10000) return schedule(callback, ms, ...args);
      waits.push(ms);
      return schedule(callback, 0, ...args);
    });
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: STALL_WINDOW_MS });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    collectEvents(stream);

    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(i + 1));
      sockets[i]!.send(resultsMessage({ text: '', isFinal: false, start: 0, duration: 1 }));
      await sleep(PAST_STALL_WINDOW_MS);
      sockets[i]!.terminate();
    }
    await vi.waitFor(() => expect(sockets).toHaveLength(4));
    expect(waits).toEqual([]);
  });

  it('backs off between redials of sockets that never answered', async () => {
    const waits: number[] = [];
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      if (ms !== 5000 && ms !== 10000) return schedule(callback, ms, ...args);
      waits.push(ms);
      return schedule(callback, 0, ...args);
    });
    const baseUrl = await startServer();
    server.on('connection', (socket) => socket.close(1011));
    const provider = new STT({ apiKey: 'test', baseUrl });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    for await (const _ of stream) {
      /* drain */
    }

    expect(waits).toEqual([5000, 10000]);
  });
});
