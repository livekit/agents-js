// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STTv2, type STTv2Options } from './stt_v2.js';

const TEST_CONN_OPTIONS = { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 };

async function startWebSocketServer(): Promise<{
  wss: WebSocketServer;
  endpointUrl: string;
}> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind test WebSocket server');
  }

  return {
    wss,
    endpointUrl: `ws://127.0.0.1:${address.port}/v2/listen`,
  };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    wss.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1000) {
    if (condition()) return;
    await sleep(5);
  }

  throw new Error(message);
}

function createStream(endpointUrl: string, maxRetry = 1) {
  return new STTv2({ apiKey: 'test-api-key', endpointUrl }).stream({
    connOptions: { ...TEST_CONN_OPTIONS, maxRetry },
  });
}

describe('Deepgram STTv2 WebSocket recovery', () => {
  it('reconnects when Deepgram closes the WebSocket unexpectedly', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const stream = createStream(endpointUrl);

    wss.on('connection', (ws) => {
      connections.push(ws);

      if (connections.length === 1) {
        setTimeout(() => ws.close(1011, 'unexpected close'), 10);
      }
    });

    try {
      await waitFor(
        () => connections.length === 2,
        `expected retry to open a second WebSocket, saw ${connections.length}`,
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('does not reconnect after normal input end closes the WebSocket', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const messages: Array<Record<string, unknown>> = [];
    const stream = createStream(endpointUrl);

    wss.on('connection', (ws) => {
      connections.push(ws);

      ws.on('message', (data, isBinary) => {
        if (isBinary) return;

        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        ws.close(1000, 'stream complete');
      });
    });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      stream.endInput();

      await waitFor(
        () => messages.some((message) => message.type === 'CloseStream'),
        'expected client to send CloseStream',
      );
      await sleep(50);

      expect(connections).toHaveLength(1);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('does not reconnect or close after flush before normal input end', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const messages: Array<Record<string, unknown>> = [];
    const stream = createStream(endpointUrl);

    wss.on('connection', (ws) => {
      connections.push(ws);

      ws.on('message', (data, isBinary) => {
        if (isBinary) return;

        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        messages.push(message);
        if (message.type === 'CloseStream') {
          ws.close(1000, 'stream complete');
        }
      });
    });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      stream.flush();

      await sleep(50);
      expect(messages.some((message) => message.type === 'CloseStream')).toBe(false);
      expect(connections).toHaveLength(1);

      stream.endInput();

      await waitFor(
        () => messages.some((message) => message.type === 'CloseStream'),
        'expected client to send CloseStream',
      );
      await sleep(50);

      expect(connections).toHaveLength(1);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('treats option-update reconnects as intentional WebSocket closes', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const stream = createStream(endpointUrl, 0) as stt.SpeechStream & {
      updateOptions(opts: Partial<STTv2Options>): void;
    };

    wss.on('connection', (ws) => {
      connections.push(ws);
    });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      stream.updateOptions({ keyterms: ['updated'] });

      await waitFor(
        () => connections.length === 2,
        `expected option update to reconnect once, saw ${connections.length}`,
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('keeps transcript timestamps monotonic across an unexpected reconnect', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    let firstConnAudioBytes = 0;
    const stream = createStream(endpointUrl);

    wss.on('connection', (ws) => {
      const index = connections.push(ws);
      if (index === 1) {
        ws.on('message', (data, isBinary) => {
          if (isBinary) firstConnAudioBytes += (data as Buffer).length;
        });
      }
    });

    const startOfTurn = JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' });
    const endOfTurn = (audioWindowEnd: number) =>
      JSON.stringify({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        transcript: 'hello',
        audio_window_start: Math.max(0, audioWindowEnd - 0.5),
        audio_window_end: audioWindowEnd,
        words: [
          {
            word: 'hello',
            start: Math.max(0, audioWindowEnd - 0.5),
            end: audioWindowEnd,
            confidence: 0.9,
          },
        ],
      });

    const finalEndTimes: number[] = [];
    const consume = (async () => {
      for await (const event of stream) {
        if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT && event.alternatives?.[0]) {
          finalEndTimes.push(event.alternatives[0].endTime);
        }
      }
    })();

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      // Stream ~2s of 16 kHz mono audio so the first connection advances the timeline.
      const oneSecond = () => new AudioFrame(new Int16Array(16_000), 16_000, 1, 16_000);
      stream.pushFrame(oneSecond());
      stream.pushFrame(oneSecond());
      // 16 kHz * 2 bytes/sample * 1.5s = 48_000 bytes => at least 1.5s reached the socket.
      await waitFor(
        () => firstConnAudioBytes >= 48_000,
        `expected ~2s of audio at the first connection, saw ${firstConnAudioBytes} bytes`,
      );

      // First turn ends 1.0s into the first connection's audio window.
      connections[0]!.send(startOfTurn);
      connections[0]!.send(endOfTurn(1.0));
      await waitFor(() => finalEndTimes.length === 1, 'expected first final transcript');

      // Unexpected close -> base-class retry reconnects.
      connections[0]!.close(1011, 'unexpected close');
      await waitFor(() => connections.length === 2, 'expected reconnect after unexpected close');

      // The fresh Deepgram socket restarts audio_window near 0; this turn ends at
      // 0.5 within the NEW connection's window.
      connections[1]!.send(startOfTurn);
      connections[1]!.send(endOfTurn(0.5));
      await waitFor(() => finalEndTimes.length === 2, 'expected second final transcript');

      // Without timebase preservation the second final lands at ~0.5s — earlier than
      // the first — and downstream "before answer audio" logic would drop it.
      expect(finalEndTimes[1]!).toBeGreaterThan(finalEndTimes[0]!);
    } finally {
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });

  it('emits start of speech after reconnecting during an active turn', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const stream = createStream(endpointUrl);
    const eventTypes: stt.SpeechEventType[] = [];

    wss.on('connection', (ws) => {
      connections.push(ws);
    });

    const consume = (async () => {
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
    })();

    const startOfTurn = JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      connections[0]!.send(startOfTurn);
      await waitFor(
        () =>
          eventTypes.filter((eventType) => eventType === stt.SpeechEventType.START_OF_SPEECH)
            .length === 1,
        'expected first start of speech',
      );

      connections[0]!.close(1011, 'unexpected close during speech');
      await waitFor(() => connections.length === 2, 'expected reconnect after unexpected close');

      connections[1]!.send(startOfTurn);
      await waitFor(
        () =>
          eventTypes.filter((eventType) => eventType === stt.SpeechEventType.START_OF_SPEECH)
            .length === 2,
        'expected second start of speech after reconnect',
      );
    } finally {
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });

  it('starts speech from a non-empty update after reconnecting when StartOfTurn is absent', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const stream = createStream(endpointUrl);
    const events: Array<{ type: stt.SpeechEventType; text?: string }> = [];

    wss.on('connection', (ws) => {
      connections.push(ws);
    });

    const consume = (async () => {
      for await (const event of stream) {
        events.push({
          type: event.type,
          text: event.alternatives?.[0]?.text,
        });
      }
    })();

    const startOfTurn = JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' });
    const update = JSON.stringify({
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'after reconnect',
      audio_window_start: 0,
      audio_window_end: 0.5,
      words: [
        { word: 'after', start: 0, end: 0.25, confidence: 0.9 },
        { word: 'reconnect', start: 0.25, end: 0.5, confidence: 0.9 },
      ],
    });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      connections[0]!.send(startOfTurn);
      await waitFor(
        () =>
          events.filter((event) => event.type === stt.SpeechEventType.START_OF_SPEECH).length === 1,
        'expected first start of speech',
      );

      connections[0]!.close(1011, 'unexpected close during speech');
      await waitFor(() => connections.length === 2, 'expected reconnect after unexpected close');

      connections[1]!.send(update);
      await waitFor(
        () =>
          events.filter((event) => event.type === stt.SpeechEventType.START_OF_SPEECH).length ===
            2 && events.some((event) => event.text === 'after reconnect'),
        'expected synthesized start of speech and update transcript after reconnect',
      );
    } finally {
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });
});

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    const sileroPackage = '@livekit/agents-plugin-silero';
    const pluginsTestPackage = '@livekit/agents-plugins-test';
    const [{ VAD }, { stt: runSttTests }] = await Promise.all([
      import(/* @vite-ignore */ sileroPackage),
      import(/* @vite-ignore */ pluginsTestPackage),
    ]);

    await runSttTests(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
