// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError, DEFAULT_API_CONNECT_OPTIONS, stt } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt as testStt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';

const hasCartesiaApiKey = Boolean(process.env.CARTESIA_API_KEY);

const swallowExpectedRejection = (reason: unknown) => {
  if (reason instanceof APIError) return;
  throw reason;
};
beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

describe('Cartesia STT capabilities', () => {
  it('reports no aligned transcript for Ink-2', () => {
    const instance = new STT({ apiKey: 'test-key', model: 'ink-2' });

    expect(instance.capabilities.alignedTranscript).toBe(false);
  });
});

describe('Cartesia STT connection errors', () => {
  it('does not retain synchronous WebSocket connection errors', async () => {
    const secret = 'cartesia-secret-api-key-do-not-log';
    const cartesia = new STT({ apiKey: 'test-key', baseUrl: `http://[${secret}` });
    const errorEvent = once(cartesia, 'error') as Promise<Parameters<stt.STTCallbacks['error']>>;
    const stream = cartesia.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
    });
    const drain = (async () => {
      for await (const _ of stream) {
        // discard events
      }
    })();

    try {
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIConnectionError);
      expect(error.message).toBe('SyntaxError');
      expect(error.message).not.toContain(secret);
      expect(error.toString()).not.toContain(secret);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      stream.close();
      await drain.catch(() => {});
      // Let SpeechStream.mainTask's expected rejection reach the file-level handler.
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// Half-open socket detection
// ---------------------------------------------------------------------------

const SAMPLES_PER_FRAME = 2560;

const frameWithValue = (value: number) =>
  new AudioFrame(new Int16Array(SAMPLES_PER_FRAME).fill(value), 16_000, 1, SAMPLES_PER_FRAME);

const bytesOf = (frame: AudioFrame) =>
  Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);

type TestConnection = { ws: WebSocket; audio: Buffer[] };

/** Accepts sockets and records their audio. The first sockets never answer a ping, as if they were half-open. */
async function startSilentFirstSocketServer(
  onAudio?: (connection: TestConnection) => void,
  silentSocketCount = 1,
) {
  const wss = new WebSocketServer({ port: 0, autoPong: false });
  await once(wss, 'listening');
  const connections: TestConnection[] = [];
  wss.on('connection', (ws) => {
    const connection: TestConnection = { ws, audio: [] };
    connections.push(connection);
    if (connections.length > silentSocketCount) ws.on('ping', () => ws.pong());
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      connection.audio.push(data);
      onAudio?.(connection);
    });
  });
  const { port } = wss.address() as AddressInfo;
  return { wss, connections, baseUrl: `http://127.0.0.1:${port}` };
}

/** Shrinks the heartbeat interval and the pong timeout, which share the same 5 s default. */
function speedUpHeartbeat() {
  const nativeSetInterval = globalThis.setInterval;
  const nativeSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number) =>
    nativeSetInterval(callback, delay === 5000 ? 100 : delay)) as typeof setInterval);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) =>
    nativeSetTimeout(callback, delay === 5000 ? 50 : delay)) as typeof setTimeout);
}

const waitFor = async (condition: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('Cartesia STT socket liveness', () => {
  const connOptions = { maxRetry: 2, retryIntervalMs: 1, timeoutMs: 1000 };

  const drainStream = (stream: stt.SpeechStream) =>
    (async () => {
      for await (const _ of stream) {
        // discard events
      }
    })();

  it('redials a socket that stops answering pings', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer();
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const drain = drainStream(stream);

    try {
      await waitFor(() => connections.length >= 2);
      expect(connections[0]!.ws.readyState).not.toBe(connections[0]!.ws.OPEN);
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('fails with an APIConnectionError when no retry is left', async () => {
    const { wss, baseUrl } = await startSilentFirstSocketServer();
    speedUpHeartbeat();
    const cartesia = new STT({ apiKey: 'test-key', baseUrl });
    const errorEvent = once(cartesia, 'error') as Promise<Parameters<stt.STTCallbacks['error']>>;
    const stream = cartesia.stream({ connOptions: { ...connOptions, maxRetry: 0 } });
    const drain = drainStream(stream);

    try {
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIConnectionError);
      expect(error.message).toContain('heartbeat timed out');
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('sends the audio the silent socket swallowed to its replacement first', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer();
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const drain = drainStream(stream);
    const frames = [1, 2, 3].map(frameWithValue);

    try {
      await waitFor(() => connections.length >= 1);
      for (const frame of frames) stream.pushFrame(frame);
      await waitFor(() => connections[0]!.audio.length >= 3);
      await waitFor(() => (connections[1]?.audio.length ?? 0) >= 3);

      expect(connections[1]!.audio.slice(0, 3)).toEqual(frames.map(bytesOf));
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('does not replay audio of a turn that already ended', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer((connection) => {
      if (connection.audio.length !== 3) return;
      connection.ws.send(JSON.stringify({ type: 'turn.start', request_id: 'r' }));
      connection.ws.send(
        JSON.stringify({ type: 'turn.end', transcript: 'hello', request_id: 'r' }),
      );
    });
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const events: stt.SpeechEvent[] = [];
    const drain = (async () => {
      for await (const event of stream) events.push(event);
    })();
    const fresh = frameWithValue(9);

    try {
      await waitFor(() => connections.length >= 1);
      for (const value of [1, 2, 3]) stream.pushFrame(frameWithValue(value));
      await waitFor(() =>
        events.some((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT),
      );
      await waitFor(() => connections.length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(connections[1]!.audio).toHaveLength(0);

      stream.pushFrame(fresh);
      await waitFor(() => connections[1]!.audio.length >= 1);
      expect(connections[1]!.audio[0]).toEqual(bytesOf(fresh));
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('keeps the unfinished chunk of a dropped socket for its replacement', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer();
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const drain = drainStream(stream);
    const half = (value: number) =>
      new AudioFrame(
        new Int16Array(SAMPLES_PER_FRAME / 2).fill(value),
        16_000,
        1,
        SAMPLES_PER_FRAME / 2,
      );

    try {
      await waitFor(() => connections.length >= 1);
      stream.pushFrame(half(1));
      await waitFor(() => connections.length >= 2);
      stream.pushFrame(half(2));
      await waitFor(() => (connections[1]?.audio.length ?? 0) >= 1);

      expect(connections[1]!.audio[0]).toEqual(Buffer.concat([bytesOf(half(1)), bytesOf(half(2))]));
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('replays the whole unfinished turn instead of committing its partial transcript', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer((connection) => {
      if (connection !== connections[0] || connection.audio.length !== 1) return;
      connection.ws.send(JSON.stringify({ type: 'turn.start', request_id: 'r' }));
      connection.ws.send(
        JSON.stringify({ type: 'turn.update', transcript: 'hello', request_id: 'r' }),
      );
    });
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const events: stt.SpeechEvent[] = [];
    const drain = (async () => {
      for await (const event of stream) events.push(event);
    })();
    const frames = [1, 2].map(frameWithValue);

    try {
      await waitFor(() => connections.length >= 1);
      stream.pushFrame(frames[0]!);
      await waitFor(() =>
        events.some((event) => event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT),
      );
      stream.pushFrame(frames[1]!);
      await waitFor(() => (connections[1]?.audio.length ?? 0) >= 2);

      expect(connections[1]!.audio.slice(0, 2)).toEqual(frames.map(bytesOf));
      expect(events.map((event) => event.type)).not.toContain(stt.SpeechEventType.FINAL_TRANSCRIPT);
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('replays the opening of a turn that outlasts the usual replay window', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer((connection) => {
      if (connection !== connections[0] || connection.audio.length !== 1) return;
      connection.ws.send(JSON.stringify({ type: 'turn.start', request_id: 'r' }));
      connection.ws.send(
        JSON.stringify({ type: 'turn.update', transcript: 'hello', request_id: 'r' }),
      );
    });
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const events: stt.SpeechEvent[] = [];
    const drain = (async () => {
      for await (const event of stream) events.push(event);
    })();
    const opening = frameWithValue(1);
    const frameCount = 80;

    try {
      await waitFor(() => connections.length >= 1);
      stream.pushFrame(opening);
      await waitFor(() =>
        events.some((event) => event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT),
      );
      for (let i = 1; i < frameCount; i++) stream.pushFrame(frameWithValue(2));
      await waitFor(() => (connections[1]?.audio.length ?? 0) >= frameCount);

      expect(connections[1]!.audio[0]).toEqual(bytesOf(opening));
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('replays a long turn from its start after two drops in a row', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer((connection) => {
      if (connection !== connections[0] || connection.audio.length !== 1) return;
      connection.ws.send(JSON.stringify({ type: 'turn.start', request_id: 'r' }));
      connection.ws.send(
        JSON.stringify({ type: 'turn.update', transcript: 'hello', request_id: 'r' }),
      );
    }, 2);
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const events: stt.SpeechEvent[] = [];
    const drain = (async () => {
      for await (const event of stream) events.push(event);
    })();
    const opening = frameWithValue(1);
    const firstSocketFrameCount = 100;
    const secondSocketFrameCount = 10;

    try {
      await waitFor(() => connections.length >= 1);
      stream.pushFrame(opening);
      await waitFor(() =>
        events.some((event) => event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT),
      );
      for (let i = 1; i < firstSocketFrameCount; i++) stream.pushFrame(frameWithValue(2));
      await waitFor(() => (connections[1]?.audio.length ?? 0) >= firstSocketFrameCount);
      for (let i = 0; i < secondSocketFrameCount; i++) stream.pushFrame(frameWithValue(3));
      await waitFor(
        () => (connections[2]?.audio.length ?? 0) >= firstSocketFrameCount + secondSocketFrameCount,
      );

      expect(connections[2]!.audio[0]).toEqual(bytesOf(opening));
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });

  it('reports the duration of replayed audio that the first socket never turned into a turn', async () => {
    const { wss, connections, baseUrl } = await startSilentFirstSocketServer((connection) => {
      if (connection !== connections[1] || connection.audio.length !== 3) return;
      connection.ws.send(JSON.stringify({ type: 'turn.start', request_id: 'r' }));
      connection.ws.send(
        JSON.stringify({ type: 'turn.end', transcript: 'hello', request_id: 'r' }),
      );
    });
    speedUpHeartbeat();
    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream({ connOptions });
    const events: stt.SpeechEvent[] = [];
    const drain = (async () => {
      for await (const event of stream) events.push(event);
    })();

    try {
      await waitFor(() => connections.length >= 1);
      for (const value of [1, 2, 3]) stream.pushFrame(frameWithValue(value));
      await waitFor(() =>
        events.some((event) => event.type === stt.SpeechEventType.RECOGNITION_USAGE),
      );

      const usage = events.find((event) => event.type === stt.SpeechEventType.RECOGNITION_USAGE);
      expect(usage?.recognitionUsage?.audioDuration).toBeCloseTo(0.48);
    } finally {
      vi.restoreAllMocks();
      stream.close();
      await drain.catch(() => {});
      wss.close();
    }
  });
});

if (hasCartesiaApiKey) {
  describe('Cartesia STT', async () => {
    await testStt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Cartesia STT', () => {
    it.skip('requires CARTESIA_API_KEY', () => {});
  });
}
