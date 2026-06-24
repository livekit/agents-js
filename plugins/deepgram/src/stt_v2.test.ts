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

  it('recovers repeated runtime closes within the stream retry budget', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const receivedBinaryMessages: number[] = [];
    const sttInstance = new STTv2({ apiKey: 'test-api-key', endpointUrl });
    const errors: unknown[] = [];
    sttInstance.on('error', (event) => errors.push(event.error));
    const stream = sttInstance.stream({
      connOptions: { ...TEST_CONN_OPTIONS, maxRetry: 2 },
    });
    const events: Array<{
      type: stt.SpeechEventType;
      text?: string;
      start?: number;
      end?: number;
    }> = [];

    wss.on('connection', (ws) => {
      const connectionIndex = connections.push(ws) - 1;
      receivedBinaryMessages[connectionIndex] = 0;

      ws.on('message', (_data, isBinary) => {
        if (!isBinary) return;

        const receivedCount = (receivedBinaryMessages[connectionIndex] ?? 0) + 1;
        receivedBinaryMessages[connectionIndex] = receivedCount;
        if (receivedCount !== 1) return;

        if (connectionIndex < 2) {
          ws.close(1011, 'progress close');
          return;
        }

        ws.send(
          JSON.stringify({
            type: 'TurnInfo',
            event: 'Update',
            transcript: 'after two closes',
            audio_window_start: 0.1,
            audio_window_end: 0.4,
            words: [
              { word: 'after', start: 0.1, end: 0.2, confidence: 0.9 },
              { word: 'two', start: 0.2, end: 0.3, confidence: 0.9 },
              { word: 'closes', start: 0.3, end: 0.4, confidence: 0.9 },
            ],
          }),
        );
      });
    });

    const consume = (async () => {
      for await (const event of stream) {
        events.push({
          type: event.type,
          text: event.alternatives?.[0]?.text,
          start: event.alternatives?.[0]?.startTime,
          end: event.alternatives?.[0]?.endTime,
        });
      }
    })();

    const feedAudio = setInterval(() => {
      stream.pushFrame(new AudioFrame(new Int16Array(1600), 16_000, 1, 1600));
    }, 10);

    try {
      stream.pushFrame(new AudioFrame(new Int16Array(1600), 16_000, 1, 1600));

      await waitFor(
        () => events.some((event) => event.text === 'after two closes'),
        'expected transcript after repeated runtime closes',
      );

      expect(connections).toHaveLength(3);
      expect(receivedBinaryMessages[0]).toBeGreaterThan(0);
      expect(receivedBinaryMessages[1]).toBeGreaterThan(0);
      expect(receivedBinaryMessages[2]).toBeGreaterThan(0);
      expect(
        events.find((event) => event.text === 'after two closes')?.start,
      ).toBeGreaterThanOrEqual(0.3);
      expect(errors).toEqual([]);
    } finally {
      clearInterval(feedAudio);
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });

  it('uses the stream retry budget for repeated runtime closes with audio progress', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const receivedBinaryMessages: number[] = [];
    const sttInstance = new STTv2({ apiKey: 'test-api-key', endpointUrl });
    const errors: unknown[] = [];
    sttInstance.on('error', (event) => errors.push(event.error));
    const stream = sttInstance.stream({
      connOptions: { ...TEST_CONN_OPTIONS, maxRetry: 1 },
    });

    wss.on('connection', (ws) => {
      const connectionIndex = connections.push(ws) - 1;
      receivedBinaryMessages[connectionIndex] = 0;

      ws.on('message', (_data, isBinary) => {
        if (!isBinary) return;

        const receivedCount = (receivedBinaryMessages[connectionIndex] ?? 0) + 1;
        receivedBinaryMessages[connectionIndex] = receivedCount;
        if (receivedCount === 1) {
          ws.close(1011, 'progress close');
        }
      });
    });

    const consume = (async () => {
      for await (const _event of stream) {
        // Drain until the stream reports the final retry-budget error.
      }
    })().catch((error: unknown) => error);

    const feedAudio = setInterval(() => {
      stream.pushFrame(new AudioFrame(new Int16Array(1600), 16_000, 1, 1600));
    }, 10);

    try {
      stream.pushFrame(new AudioFrame(new Int16Array(1600), 16_000, 1, 1600));

      await waitFor(
        () => errors.length > 0 || connections.length > 2,
        'expected repeated progress closes to consume the retry budget',
      );

      expect(connections).toHaveLength(2);
      expect(receivedBinaryMessages[0]).toBeGreaterThan(0);
      expect(receivedBinaryMessages[1]).toBeGreaterThan(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    } finally {
      clearInterval(feedAudio);
      stream.close();
      await consume;
      await closeWebSocketServer(wss);
    }
  });

  it('resets the stream retry budget after a final transcript', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const receivedBinaryMessages: number[] = [];
    const sttInstance = new STTv2({ apiKey: 'test-api-key', endpointUrl });
    const errors: unknown[] = [];
    sttInstance.on('error', (event) => errors.push(event.error));
    const stream = sttInstance.stream({
      connOptions: { ...TEST_CONN_OPTIONS, maxRetry: 1 },
    });
    const events: Array<{ type: stt.SpeechEventType; text?: string }> = [];

    wss.on('connection', (ws) => {
      const connectionIndex = connections.push(ws) - 1;
      receivedBinaryMessages[connectionIndex] = 0;

      ws.on('message', (_data, isBinary) => {
        if (!isBinary) return;
        receivedBinaryMessages[connectionIndex] =
          (receivedBinaryMessages[connectionIndex] ?? 0) + 1;
      });
    });

    const consume = (async () => {
      for await (const event of stream) {
        events.push({
          type: event.type,
          text: event.alternatives?.[0]?.text,
        });
      }
    })();

    const startOfTurn = JSON.stringify({
      type: 'TurnInfo',
      event: 'StartOfTurn',
      transcript: '',
    });
    const endOfTurn = JSON.stringify({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: 'retry budget reset',
      audio_window_start: 0.1,
      audio_window_end: 0.5,
      words: [
        { word: 'retry', start: 0.1, end: 0.2, confidence: 0.9 },
        { word: 'budget', start: 0.2, end: 0.35, confidence: 0.9 },
        { word: 'reset', start: 0.35, end: 0.5, confidence: 0.9 },
      ],
    });

    const feedAudio = setInterval(() => {
      stream.pushFrame(new AudioFrame(new Int16Array(1600), 16_000, 1, 1600));
    }, 10);

    try {
      stream.pushFrame(new AudioFrame(new Int16Array(1600), 16_000, 1, 1600));

      await waitFor(
        () => (receivedBinaryMessages[0] ?? 0) > 0,
        'expected audio on first WebSocket connection',
      );
      connections[0]!.close(1011, 'close before final');
      await waitFor(() => connections.length === 2, 'expected first reconnect');

      await waitFor(
        () => (receivedBinaryMessages[1] ?? 0) > 0,
        'expected audio on second WebSocket connection',
      );
      connections[1]!.send(startOfTurn);
      connections[1]!.send(endOfTurn);
      await waitFor(
        () => events.some((event) => event.text === 'retry budget reset'),
        'expected final transcript to reset retry budget',
      );

      connections[1]!.close(1011, 'close after final');
      await waitFor(
        () => connections.length === 3 || errors.length > 0,
        'expected reconnect after final transcript reset',
      );

      expect(connections).toHaveLength(3);
      expect(errors).toEqual([]);
    } finally {
      clearInterval(feedAudio);
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });

  it('does not emit duplicate start of speech after reconnecting during an active turn', async () => {
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

    const startOfTurn = (transcript = '') =>
      JSON.stringify({
        type: 'TurnInfo',
        event: 'StartOfTurn',
        transcript,
        audio_window_start: 0.1,
        audio_window_end: 0.2,
        words: transcript ? [{ word: transcript, start: 0.1, end: 0.2, confidence: 0.9 }] : [],
      });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      connections[0]!.send(startOfTurn());
      await waitFor(
        () =>
          events.filter((event) => event.type === stt.SpeechEventType.START_OF_SPEECH).length === 1,
        'expected first start of speech',
      );

      connections[0]!.close(1011, 'unexpected close during speech');
      await waitFor(() => connections.length === 2, 'expected reconnect after unexpected close');

      connections[1]!.send(startOfTurn('still'));
      await waitFor(
        () =>
          events.filter((event) => event.type === stt.SpeechEventType.START_OF_SPEECH).length ===
            1 && events.some((event) => event.text === 'still'),
        'expected duplicate StartOfTurn transcript without duplicate start of speech',
      );
    } finally {
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });

  it('keeps an active turn open across reconnect when StartOfTurn is absent', async () => {
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
            1 && events.some((event) => event.text === 'after reconnect'),
        'expected update transcript without duplicate start of speech after reconnect',
      );
    } finally {
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });

  it('does not open a turn from trailing transcript after EndOfTurn without reconnect', async () => {
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

    const startOfTurn = JSON.stringify({
      type: 'TurnInfo',
      event: 'StartOfTurn',
      transcript: 'hello',
      audio_window_start: 0.1,
      audio_window_end: 0.2,
      words: [{ word: 'hello', start: 0.1, end: 0.2, confidence: 0.9 }],
    });
    const endOfTurn = JSON.stringify({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: 'hello there',
      audio_window_start: 0.1,
      audio_window_end: 1.0,
      words: [
        { word: 'hello', start: 0.1, end: 0.5, confidence: 0.9 },
        { word: 'there', start: 0.5, end: 1.0, confidence: 0.9 },
      ],
    });
    const trailingUpdate = JSON.stringify({
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'and one more thing',
      audio_window_start: 1.0,
      audio_window_end: 2.0,
      words: [
        { word: 'and', start: 1.0, end: 1.2, confidence: 0.9 },
        { word: 'one', start: 1.2, end: 1.4, confidence: 0.9 },
        { word: 'more', start: 1.4, end: 1.7, confidence: 0.9 },
        { word: 'thing', start: 1.7, end: 2.0, confidence: 0.9 },
      ],
    });
    const startOfSpeechCount = () =>
      events.filter((event) => event.type === stt.SpeechEventType.START_OF_SPEECH).length;

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      connections[0]!.send(startOfTurn);
      await waitFor(() => startOfSpeechCount() === 1, 'expected first start of speech');

      connections[0]!.send(endOfTurn);
      await waitFor(
        () => events.some((event) => event.type === stt.SpeechEventType.END_OF_SPEECH),
        'expected end of speech',
      );

      connections[0]!.send(trailingUpdate);
      await sleep(50);

      expect(startOfSpeechCount()).toBe(1);
      expect(events.some((event) => event.text === 'and one more thing')).toBe(false);
    } finally {
      stream.close();
      await consume.catch(() => {});
      await closeWebSocketServer(wss);
    }
  });

  it('uses the base retry budget for runtime closes that make no audio progress', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const errors: unknown[] = [];
    const sttInstance = new STTv2({ apiKey: 'test-api-key', endpointUrl });
    sttInstance.on('error', (event) => errors.push(event.error));
    const stream = sttInstance.stream({
      connOptions: { ...TEST_CONN_OPTIONS, maxRetry: 1 },
    });

    wss.on('connection', (ws) => {
      connections.push(ws);
      if (connections.length === 1) {
        ws.close(1011, 'no progress');
      }
    });

    try {
      await waitFor(
        () => connections.length === 2,
        `expected base retry to open a second WebSocket, saw ${connections.length}`,
      );
      expect(connections).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      stream.close();
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
