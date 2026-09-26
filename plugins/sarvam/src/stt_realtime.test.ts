// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS, stt } from '@livekit/agents';
import type { stt as sttNamespace } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeSpeechStream } from './stt_realtime.js';
import { STTRealtime, encodePcmForWire } from './stt_realtime.js';

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

function toneFrame(samples: number[]): AudioFrame {
  return new AudioFrame(new Int16Array(samples), 16000, 1, samples.length);
}

// Standard ITU G.711 A-law decoder — independent of this plugin's encoder, used to round-trip
// verify linearToAlaw's output rather than asserting on encoder-internal byte values.
function alawDecode(aVal: number): number {
  aVal ^= 0x55;
  let t = (aVal & 0x0f) << 4;
  const seg = (aVal & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else {
    t += 0x108;
    t <<= seg - 1;
  }
  return aVal & 0x80 ? t : -t;
}

// Standard ITU G.711 mu-law decoder — independent of this plugin's encoder.
function mulawDecode(uVal: number): number {
  uVal = ~uVal & 0xff;
  let t = ((uVal & 0x0f) << 3) + 0x84;
  t <<= (uVal & 0x70) >> 4;
  return uVal & 0x80 ? 0x84 - t : t - 0x84;
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
    expect(finalIndex).toBeLessThan(eosIndex);

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

  it('encodes A-law samples with the correct sign and magnitude (regression for inverted sign bug)', () => {
    // Round-trip through an independent reference decoder — not the encoder's own logic —
    // so this actually catches a sign inversion instead of just re-asserting the bug.
    // Values well above A-law's quantization floor (its lowest segment collapses everything
    // under ~16 to one bucket, so sign isn't meaningful that close to zero — see below).
    for (const sample of [100, 5000, 16000, 32000, -100, -5000, -16000, -32000]) {
      const encoded = encodePcmForWire('alaw', toneFrame([sample]));
      const decoded = alawDecode(encoded[0]!);
      expect(Math.sign(decoded)).toBe(Math.sign(sample));
      // A-law is lossy/companded, not lossless — allow generous relative tolerance.
      expect(Math.abs(decoded - sample)).toBeLessThan(Math.abs(sample) * 0.15 + 32);
    }

    // A-law's zero code decodes to a small nonzero value by design (segment-0 offset of 8) —
    // just confirm it stays near silence rather than asserting an exact sign.
    const zeroEncoded = encodePcmForWire('alaw', toneFrame([0]));
    expect(Math.abs(alawDecode(zeroEncoded[0]!))).toBeLessThanOrEqual(8);
  });

  it('encodes mu-law samples with the correct sign and magnitude', () => {
    for (const sample of [100, 5000, 16000, 32000, -100, -5000, -16000, -32000]) {
      const encoded = encodePcmForWire('mulaw', toneFrame([sample]));
      const decoded = mulawDecode(encoded[0]!);
      expect(Math.sign(decoded)).toBe(Math.sign(sample));
      expect(Math.abs(decoded - sample)).toBeLessThan(Math.abs(sample) * 0.15 + 32);
    }
  });

  it('does not hang when the server ends the session before the caller ends input', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key' });
    const stream = sttRealtime.stream();
    stream.pushFrame(frame());
    // Deliberately not calling endInput()/flush() — the caller may keep the stream open
    // across turns, so a server-initiated end must not depend on the caller closing input.

    const socket = await waitForSocket();
    await onceOpen(socket);
    send(socket, { event: 'vad.speech_start' });
    send(socket, { event: 'transcript.final', text: 'done' });
    send(socket, { event: 'vad.speech_end' });
    send(socket, { event: 'session.end', audio_duration_s: 1 });
    socket.close(1000, '');

    const drain = (async () => {
      const events: sttNamespace.SpeechEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    })();
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));

    const result = await Promise.race([drain, timeout]);
    expect(result).not.toBe('timeout');
    expect(
      texts(result as sttNamespace.SpeechEvent[], stt.SpeechEventType.FINAL_TRANSCRIPT),
    ).toEqual(['done']);
  });

  it('stops forwarding updateOptions to a stream that completed naturally', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key' });
    const stream = sttRealtime.stream();
    const updateOptionsSpy = vi.spyOn(stream, 'updateOptions');
    stream.pushFrame(frame());
    stream.endInput();

    await scriptAndDrain(stream, (socket) => {
      send(socket, { event: 'session.end', audio_duration_s: 1 });
    });

    sttRealtime.updateOptions({ language: 'hi-IN' });
    expect(updateOptionsSpy).not.toHaveBeenCalled();
  });

  it('rejects non-mono audio instead of silently corrupting it', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key' });
    const errors: unknown[] = [];
    sttRealtime.on('error', (e) => errors.push(e));

    const stream = sttRealtime.stream();
    const stereoFrame = new AudioFrame(new Int16Array(320), 16000, 2, 160);
    stream.pushFrame(stereoFrame);
    stream.endInput();

    // Deliberately not synchronizing with the socket's 'open' event here: the channel
    // validation error fires almost synchronously once the (mocked) socket opens, which can
    // close the socket before this test's own listener attaches — waiting on 'open' again
    // would then hang forever. Draining the stream is enough to observe the error.
    const events: sttNamespace.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { error: Error }).error.message)).toMatch(/mono/i);
  });

  it('keeps a live stream on its original wire encoding after updateOptions', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key', encoding: 'linear16' });
    const stream = sttRealtime.stream();

    const socket = await waitForSocket();
    await onceOpen(socket);

    stream.pushFrame(toneFrame(new Array(800).fill(1000)));
    await new Promise((r) => setTimeout(r, 0));

    stream.updateOptions({ encoding: 'mulaw' });

    stream.pushFrame(toneFrame(new Array(800).fill(1000)));
    stream.endInput();
    await new Promise((r) => setTimeout(r, 0));
    socket.close(1000, '');

    const events: sttNamespace.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    const binaryPayloads = socket.sent.filter((d): d is Buffer => Buffer.isBuffer(d));
    expect(binaryPayloads.length).toBeGreaterThanOrEqual(2);
    for (const payload of binaryPayloads) {
      expect(payload.byteLength).toBe(1600); // still linear16 (2 bytes/sample), not mulaw
    }
  });

  it('sends the final buffered audio chunk when input ends without a trailing flush()', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key' });
    const stream = sttRealtime.stream();

    const socket = await waitForSocket();
    await onceOpen(socket);

    stream.pushFrame(toneFrame(new Array(200).fill(1000)));
    stream.endInput();
    await new Promise((r) => setTimeout(r, 0));
    socket.close(1000, '');

    const events: sttNamespace.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    const binaryPayloads = socket.sent.filter((d): d is Buffer => Buffer.isBuffer(d));
    expect(binaryPayloads.some((p) => p.byteLength === 400)).toBe(true);
  });

  it('ends the manual-mode turn when input ends without a trailing flush()', async () => {
    const sttRealtime = new STTRealtime({ apiKey: 'test-key', endpointing: 'manual' });
    const stream = sttRealtime.stream();

    const socket = await waitForSocket();
    await onceOpen(socket);

    stream.pushFrame(toneFrame(new Array(200).fill(1000)));
    stream.endInput();
    await new Promise((r) => setTimeout(r, 0));
    socket.close(1000, '');

    const events: sttNamespace.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    const jsonPayloads = socket.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { event: string });
    expect(jsonPayloads.some((p) => p.event === 'speech_start')).toBe(true);
    expect(jsonPayloads.some((p) => p.event === 'speech_end')).toBe(true);
    expect(events.some((e) => e.type === stt.SpeechEventType.END_OF_SPEECH)).toBe(true);
  });
});
