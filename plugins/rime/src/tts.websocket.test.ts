// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession, initializeLogger, tts as livekitTts, voice } from '@livekit/agents';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TTS } from './tts.js';

interface FakeSocket {
  url: string;
  readyState: number;
  sent: Record<string, unknown>[];
  terminate(): void;
  receive(data: Record<string, unknown>): void;
}

const transport = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    constructor(readonly url: string) {
      super();
      transport.sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.emit('open');
      });
    }
    send(value: string) {
      this.sent.push(JSON.parse(value));
    }
    terminate() {
      this.readyState = 3;
      this.emit('close', 1000, Buffer.alloc(0));
    }
    close() {
      this.terminate();
    }
    receive(data: Record<string, unknown>) {
      this.emit('message', Buffer.from(JSON.stringify(data)));
    }
  }
  return { WebSocket: FakeWebSocket };
});

const providers: TTS[] = [];
beforeAll(() => initializeLogger({ level: 'silent', pretty: false }));
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  transport.sockets = [];
  vi.useRealTimers();
});
function provider() {
  const result = new TTS({
    modelId: 'coda',
    speaker: 'lyra',
    lang: 'eng',
    samplingRate: 16000,
    segment: 'never',
    apiKey: 'fake-test-credential',
    baseURL: 'ws://127.0.0.1:1',
    reuseWebsocket: true,
    flushSentences: true,
  });
  providers.push(result);
  result.on('error', () => {});
  return result;
}
function start(tts: TTS, text = 'Hello. ', end = true) {
  const stream = tts.stream({
    connOptions: { timeoutMs: 1000, maxRetry: 2, retryIntervalMs: 0 },
  });
  const frames: livekitTts.SynthesizedAudio[] = [];
  const done = (async () => {
    for await (const frame of stream) {
      if (frame !== livekitTts.SynthesizeStream.END_OF_STREAM) frames.push(frame);
    }
  })();
  stream.pushText(text);
  if (end) stream.endInput();
  return { stream, frames, done };
}
async function flushed(index = 0, count = 1) {
  await vi.waitFor(() => {
    expect(transport.sockets[index]?.sent.filter((m) => m.operation === 'flush')).toHaveLength(
      count,
    );
  });
  return transport.sockets[index]!;
}
function complete(socket: FakeSocket, sample = 10, samples = 320) {
  const contextId = [...socket.sent].reverse().find((m) => m.text)?.contextId;
  socket.receive({
    type: 'timestamps',
    contextId,
    word_timestamps: { words: ['Hello'], start: [0], end: [0.01] },
  });
  socket.receive({
    type: 'chunk',
    contextId,
    data: Buffer.from(new Int16Array(samples).fill(sample).buffer).toString('base64'),
  });
  socket.receive({ type: 'done', contextId });
}

describe('Rime WebSocket transport', () => {
  it('delivers first sentence audio before model EOF and rebases timestamps', async () => {
    const tts = provider();
    const metrics: { charactersCount: number; audioDurationMs: number }[] = [];
    tts.on('metrics_collected', (event) => metrics.push(event));
    const run = start(tts, 'I can help with that. Next', false);
    const socket = await flushed();
    run.stream.pushText(' sentence. ');
    expect(socket.sent.filter((m) => m.operation === 'flush')).toHaveLength(1);
    complete(socket);
    await vi.waitFor(() => expect(run.frames.length).toBeGreaterThan(0));
    run.stream.endInput();
    await flushed(0, 2);
    complete(socket, 20);
    await run.done;
    expect(
      run.frames.flatMap((frame) => frame.timedTranscripts ?? []).map((entry) => entry.startTime),
    ).toEqual([0, 0.02]);
    expect(new Set(run.frames.map((frame) => frame.segmentId)).size).toBe(1);
    expect(run.frames.filter((frame) => frame.final)).toHaveLength(1);
    expect(run.frames.at(-1)?.final).toBe(true);
    expect(run.frames.flatMap((frame) => Array.from(frame.frame.data))).toEqual([
      ...Array<number>(320).fill(10),
      ...Array<number>(320).fill(20),
    ]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.audioDurationMs).toBeCloseTo(40);
    expect(metrics[0]?.charactersCount).toBe('I can help with that. Next sentence. '.length);
  });

  it('serializes multiple ready sentences until each matching context completes', async () => {
    const tts = provider();
    const sentences = [
      'This is the first complete sentence.',
      'This is the second complete sentence.',
      'This is the third complete sentence.',
    ];
    // EOF makes all three sentences available independently of tokenizer lookahead.
    const run = start(tts, sentences.join(' '));
    const socket = await flushed();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.sent.filter((message) => message.text).map((message) => message.text)).toEqual([
      `${sentences[0]} `,
    ]);
    const firstContext = socket.sent[0]!.contextId;
    complete(socket, 10);
    await flushed(0, 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.sent.filter((message) => message.text).map((message) => message.text)).toEqual([
      `${sentences[0]} `,
      `${sentences[1]} `,
    ]);
    socket.receive({ type: 'done', contextId: firstContext });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.sent.filter((message) => message.operation === 'flush')).toHaveLength(2);
    complete(socket, 20);
    await flushed(0, 3);
    complete(socket, 30);
    await run.done;
    expect(socket.sent.filter((message) => message.text).map((message) => message.text)).toEqual(
      sentences.map((sentence) => `${sentence} `),
    );
    expect(
      new Set(socket.sent.filter((message) => message.text).map((message) => message.contextId))
        .size,
    ).toBe(3);
    expect(run.frames.flatMap((frame) => Array.from(frame.frame.data))).toEqual([
      ...Array<number>(320).fill(10),
      ...Array<number>(320).fill(20),
      ...Array<number>(320).fill(30),
    ]);
    expect(run.frames.filter((frame) => frame.final)).toHaveLength(1);
  });

  it('honors explicit SDK flush boundaries with separate final segments and metrics', async () => {
    const tts = provider();
    const metrics: { charactersCount: number; audioDurationMs: number }[] = [];
    tts.on('metrics_collected', (event) => metrics.push(event));
    const run = start(tts, 'First segment. ', false);
    run.stream.flush();
    const socket = await flushed();
    complete(socket, 10);
    await vi.waitFor(() => expect(run.frames.filter((frame) => frame.final)).toHaveLength(1));
    expect(metrics).toHaveLength(1);
    run.stream.pushText('Second segment. ');
    run.stream.endInput();
    await flushed(0, 2);
    complete(socket, 20);
    await run.done;
    expect(new Set(run.frames.map((frame) => frame.segmentId)).size).toBe(2);
    expect(run.frames.filter((frame) => frame.final)).toHaveLength(2);
    expect(metrics.map((event) => event.charactersCount)).toEqual([
      'First segment. '.length,
      'Second segment. '.length,
    ]);
    expect(metrics.map((event) => event.audioDurationMs)).toEqual([20, 20]);
  });

  it('records metrics for SDK segments queued before previous audio has drained', async () => {
    const tts = provider();
    const metrics: { charactersCount: number; audioDurationMs: number }[] = [];
    tts.on('metrics_collected', (event) => metrics.push(event));
    const run = start(tts, 'First segment. ', false);
    run.stream.flush();
    run.stream.pushText('Second segment. ');
    run.stream.endInput();
    const socket = await flushed();
    complete(socket, 10, 6400);
    await flushed(0, 2);
    complete(socket, 20, 6400);
    await run.done;
    expect(metrics.map((event) => event.charactersCount)).toEqual([
      'First segment. '.length,
      'Second segment. '.length,
    ]);
    expect(metrics.map((event) => event.audioDurationMs)).toEqual([400, 400]);
  });

  it('does not attribute a spoken segment to earlier whitespace-only input', async () => {
    const tts = provider();
    const metrics: { charactersCount: number; audioDurationMs: number }[] = [];
    tts.on('metrics_collected', (event) => metrics.push(event));
    const run = start(tts, ' ', false);
    run.stream.flush();
    run.stream.pushText('Hello. ');
    run.stream.endInput();
    complete(await flushed());
    await run.done;
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ charactersCount: 'Hello. '.length, audioDurationMs: 20 });
    expect(run.frames.filter((frame) => frame.final)).toHaveLength(1);
  });

  it('fails visibly when a nonempty synthesis completes without audio', async () => {
    const tts = provider();
    const errors: Error[] = [];
    tts.on('error', (event) => errors.push(event.error));
    const run = start(tts);
    const socket = await flushed();
    socket.receive({ type: 'done', contextId: socket.sent[0]!.contextId });
    await run.done;
    expect(run.frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('Rime WebSocket synthesis completed without audio');
    expect(socket.readyState).toBe(3);
  });

  it('records the actual Rime context IDs for provider trace correlation', async () => {
    const run = start(provider(), 'This is the first sentence. This is the second sentence.');
    const noted = vi.spyOn(
      run.stream as unknown as { noteProviderRequestId(id: string): void },
      'noteProviderRequestId',
    );
    const socket = await flushed();
    const firstContext = socket.sent[0]!.contextId;
    complete(socket);
    await flushed(0, 2);
    const secondContext = [...socket.sent].reverse().find((message) => message.text)?.contextId;
    complete(socket);
    await run.done;
    expect(firstContext).not.toBe(secondContext);
    expect(run.frames[0]?.segmentId).toBe(firstContext);
    expect(noted).toHaveBeenCalledWith(firstContext);
    expect(noted).toHaveBeenCalledWith(secondContext);
  });

  it('reuses only a completed socket and ignores audio/done from an old context', async () => {
    const tts = provider();
    const first = start(tts);
    const socket = await flushed();
    const staleContext = socket.sent[0]!.contextId;
    complete(socket);
    await first.done;
    const second = start(tts);
    await flushed(0, 2);
    socket.receive({
      type: 'chunk',
      contextId: staleContext,
      data: Buffer.from(new Int16Array(320).fill(99).buffer).toString('base64'),
    });
    socket.receive({ type: 'done', contextId: staleContext });
    complete(socket, 20);
    await second.done;
    expect(transport.sockets).toHaveLength(1);
    expect(second.frames.flatMap((frame) => Array.from(frame.frame.data))).not.toContain(99);
  });

  it('gives concurrent streams separate sockets and retains only one idle connection', async () => {
    const tts = provider();
    const first = start(tts);
    const second = start(tts);
    const a = await flushed(0);
    const b = await flushed(1);
    complete(a, 10);
    complete(b, 20);
    await Promise.all([first.done, second.done]);
    expect(transport.sockets.filter((socket) => socket.readyState === 1)).toHaveLength(1);
    expect(first.frames[0]!.frame.data[0]).toBe(10);
    expect(second.frames[0]!.frame.data[0]).toBe(20);
  });

  it('terminates an interrupted synthesis and cannot reuse or emit its late audio', async () => {
    const tts = provider();
    const first = start(tts, 'This sentence is interrupted. Next', false);
    const old = await flushed();
    first.stream.close();
    await first.done;
    await vi.waitFor(() => expect(old.readyState).toBe(3));
    const second = start(tts);
    const fresh = await flushed(1);
    complete(old, 99);
    complete(fresh, 20);
    await second.done;
    expect(first.frames).toHaveLength(0);
    expect(second.frames.flatMap((frame) => Array.from(frame.frame.data))).not.toContain(99);
  });

  it('reconnects after an idle socket closes and after voice/language changes', async () => {
    const tts = provider();
    const first = start(tts);
    complete(await flushed());
    await first.done;
    transport.sockets[0]!.terminate();
    const second = start(tts);
    complete(await flushed(1));
    await second.done;
    tts.updateOptions({ lang: 'spa', speaker: 'luz' });
    expect(transport.sockets[1]!.readyState).toBe(3);
    const third = start(tts);
    const socket = await flushed(2);
    expect(new URL(socket.url).searchParams.get('lang')).toBe('spa');
    expect(new URL(socket.url).searchParams.get('speaker')).toBe('luz');
    expect(socket.url).not.toContain('fake-test-credential');
    complete(socket);
    await third.done;
  });

  it('reports socket failure without replaying partial speech or exposing provider error text', async () => {
    const tts = provider();
    const errors: Error[] = [];
    tts.on('error', (event) => errors.push(event.error));
    const run = start(tts);
    const socket = await flushed();
    socket.receive({
      type: 'error',
      message: 'fake-test-credential raw patient input',
    });
    await run.done;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('Rime WebSocket synthesis failed');
    expect(transport.sockets).toHaveLength(1);
    expect(socket.readyState).toBe(3);
    const next = start(tts);
    complete(await flushed(1));
    await next.done;
  });

  it('handles empty input and sub-frame PCM without waiting for another sentence', async () => {
    const tts = provider();
    const empty = start(tts, ' ');
    await empty.done;
    expect(empty.frames).toHaveLength(0);
    const short = start(tts);
    complete(await flushed(), 7, 4);
    await short.done;
    expect(short.frames).toHaveLength(2);
    expect(short.frames.reduce((sum, frame) => sum + frame.frame.samplesPerChannel, 0)).toBe(4);
    expect(short.frames.at(-1)?.final).toBe(true);
    expect(short.frames[0]?.frame.data[0]).toBe(7);
  });

  it('close releases active and idle sockets and prevents reopening', async () => {
    const tts = provider();
    const idle = start(tts);
    complete(await flushed());
    await idle.done;
    const active = start(tts, 'This sentence is currently active. Next', false);
    await flushed(0, 2);
    await tts.close();
    await active.done;
    expect(transport.sockets.every((socket) => socket.readyState === 3)).toBe(true);
    const later = start(tts);
    await later.done;
    expect(transport.sockets).toHaveLength(1);
  });
  it('the unchanged upstream path delays synthesis until EOF and opens another socket next turn', async () => {
    const tts = provider();
    tts.updateOptions({ flushSentences: false, reuseWebsocket: false });
    const run = start(tts, 'This is the first sentence. Next', false);
    await vi.waitFor(() =>
      expect(transport.sockets[0]?.sent.some((message) => message.text)).toBe(true),
    );
    const socket = transport.sockets[0]!;
    expect(socket.sent.filter((message) => message.operation === 'flush')).toHaveLength(0);
    expect(run.frames).toHaveLength(0);
    run.stream.endInput();
    await flushed();
    complete(socket);
    await run.done;
    expect(socket.readyState).toBe(3);
    const next = start(tts);
    complete(await flushed(1));
    await next.done;
    expect(transport.sockets).toHaveLength(2);
  });

  it('expires a warm idle socket after 30 seconds', async () => {
    const tts = provider();
    const run = start(tts);
    const socket = await flushed();
    vi.useFakeTimers();
    complete(socket);
    await run.done;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.readyState).toBe(3);
  });

  it('times out a stalled synthesis with a useful sanitized error and no retry', async () => {
    const tts = provider();
    const errors: Error[] = [];
    tts.on('error', (event) => errors.push(event.error));
    const run = start(tts);
    const socket = await flushed();
    await run.done;
    expect(errors[0]?.message).toBe('Rime WebSocket synthesis timed out');
    expect(socket.readyState).toBe(3);
    expect(transport.sockets).toHaveLength(1);
  });

  it('does not retain an old active voice after options change', async () => {
    const tts = provider();
    const old = start(tts);
    const socket = await flushed();
    tts.updateOptions({ lang: 'spa', speaker: 'luz' });
    complete(socket);
    await old.done;
    expect(socket.readyState).toBe(3);
    const next = start(tts);
    complete(await flushed(1));
    await next.done;
  });
  it('delivers PCM through the actual LiveKit default ttsNode before model EOF', async () => {
    const tts = provider();
    const agent = new voice.Agent({ instructions: 'Test voice output.' });
    const session = new AgentSession({ tts });
    await session.start({ agent });
    let source!: ReadableStreamDefaultController<string>;
    const input = new ReadableStream<string>({
      start(controller) {
        source = controller;
      },
    });
    const output = await voice.Agent.default.ttsNode(agent, input, {});
    const reader = output!.getReader();
    try {
      source.enqueue('I can help with that. Next');
      const socket = await flushed();
      complete(socket, 7, 4);
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.samplesPerChannel).toBe(3);
      source.close();
      await flushed(0, 2);
      complete(socket, 8, 4);
      const last = await reader.read();
      expect(last.value?.samplesPerChannel).toBe(1);
      expect((await reader.read()).value?.samplesPerChannel).toBe(3);
      expect((await reader.read()).value?.samplesPerChannel).toBe(1);
      expect((await reader.read()).done).toBe(true);
    } finally {
      reader.releaseLock();
      await session.close();
    }
  });
});
