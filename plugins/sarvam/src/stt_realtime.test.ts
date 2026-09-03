// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS, stt } from '@livekit/agents';
import type { stt as sttNamespace } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeSpeechStream } from './stt_realtime.js';
import { STTRealtime } from './stt_realtime.js';

interface ServerEvent {
  event: string;
  [key: string]: unknown;
}

// vi.mock/vi.hoisted factories are hoisted above this file's own imports, so the fake
// WebSocket (including its own minimal event emitter) is defined entirely inside the callback.
const { sockets, FakeWebSocket } = vi.hoisted(() => {
  class MiniEmitterImpl {
    #listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    on(event: string, listener: (...args: unknown[]) => void): this {
      if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
      this.#listeners.get(event)!.add(listener);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: (...args: unknown[]) => void): this {
      this.#listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = this.#listeners.get(event);
      if (!listeners || listeners.size === 0) return false;
      for (const listener of [...listeners]) listener(...args);
      return true;
    }
  }

  const sockets: InstanceType<typeof FakeWebSocketImpl>[] = [];

  class FakeWebSocketImpl extends MiniEmitterImpl {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = 0;
    sent: (string | Buffer)[] = [];
    url: string;
    options?: unknown;

    constructor(url: string, options?: unknown) {
      super();
      this.url = url;
      this.options = options;
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = FakeWebSocketImpl.OPEN;
        this.emit('open');
      });
    }

    send(data: string | Buffer) {
      this.sent.push(data);
    }

    close(code = 1000, reason = '') {
      if (this.readyState === FakeWebSocketImpl.CLOSED) return;
      this.readyState = FakeWebSocketImpl.CLOSED;
      this.emit('close', code, Buffer.from(reason));
    }
  }

  return { sockets, FakeWebSocket: FakeWebSocketImpl };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;

function frame(): AudioFrame {
  return new AudioFrame(new Int16Array(160), 16000, 1, 160);
}

async function waitForSocket(): Promise<FakeWebSocketInstance> {
  for (let i = 0; i < 100 && sockets.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (sockets.length === 0) throw new Error('no Sarvam realtime STT socket was created');
  return sockets[sockets.length - 1]!;
}

function onceOpen(socket: FakeWebSocketInstance): Promise<void> {
  if (socket.readyState === FakeWebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve) => socket.once('open', () => resolve()));
}

function send(socket: FakeWebSocketInstance, event: ServerEvent): void {
  socket.emit('message', Buffer.from(JSON.stringify(event)), false);
}

function texts(events: sttNamespace.SpeechEvent[], type: sttNamespace.SpeechEventType): string[] {
  return events.filter((e) => e.type === type).map((e) => e.alternatives![0]!.text);
}

async function scriptAndDrain(
  stream: RealtimeSpeechStream,
  script: (socket: FakeWebSocketInstance) => void | Promise<void>,
): Promise<sttNamespace.SpeechEvent[]> {
  const socket = await waitForSocket();
  await onceOpen(socket);
  await script(socket);

  const events: sttNamespace.SpeechEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('Sarvam realtime STT', () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  it('gates the final transcript behind speech_end in vad endpointing mode', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key' });
    const stream = sttRealtime.stream();
    stream.pushFrame(frame());
    stream.endInput();

    const events = await scriptAndDrain(stream, (socket) => {
      send(socket, { event: 'session.begin' });
      send(socket, { event: 'vad.speech_start' });
      send(socket, { event: 'transcript.partial', text: 'Hel' });
      send(socket, { event: 'transcript.final', text: 'Hello there', confidence: 0.9 });
      // The final must not surface yet — it's held until vad.speech_end supplies the boundary.
      send(socket, { event: 'vad.speech_end' });
      send(socket, { event: 'session.end', audio_duration_s: 1 });
    });

    expect(texts(events, stt.SpeechEventType.INTERIM_TRANSCRIPT)).toEqual(['Hel']);
    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual(['Hello there']);

    const eosIndex = events.findIndex((e) => e.type === stt.SpeechEventType.END_OF_SPEECH);
    const finalIndex = events.findIndex((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(eosIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeGreaterThan(eosIndex);

    expect(events.some((e) => e.type === stt.SpeechEventType.RECOGNITION_USAGE)).toBe(true);
  });

  it('emits the final transcript immediately in manual endpointing mode', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key', endpointing: 'manual' });
    const stream = sttRealtime.stream();
    stream.pushFrame(frame());
    stream.flush();
    stream.endInput();

    const events = await scriptAndDrain(stream, (socket) => {
      // No vad.speech_end is ever sent — manual mode must not wait for one.
      send(socket, { event: 'transcript.final', text: 'Manual mode transcript' });
      send(socket, { event: 'session.end', audio_duration_s: 1 });
    });

    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual(['Manual mode transcript']);
    expect(events.some((e) => e.type === stt.SpeechEventType.START_OF_SPEECH)).toBe(true);
    expect(events.some((e) => e.type === stt.SpeechEventType.END_OF_SPEECH)).toBe(true);
  });

  it('never reconnects, even if a higher maxRetry is requested by the caller', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key' });
    const errors: unknown[] = [];
    sttRealtime.on('error', (e) => errors.push(e));

    const stream = sttRealtime.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 5 },
    });
    stream.pushFrame(frame());
    stream.endInput();

    const socket = await waitForSocket();
    await onceOpen(socket);
    socket.close(1008, 'session timed out');

    const events: sttNamespace.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(sockets).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('throws when _recognize is called (streaming only)', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key' });
    await expect(sttRealtime._recognize()).rejects.toThrow(/only supports streaming/i);
  });
});
