// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '@livekit/agents';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { isDialogueModel } from './models.js';
import { TTS } from './tts.js';

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function captureStreamInit(opts: { chunkLengthSchedule?: number[]; autoMode?: boolean }) {
  const { wss, baseURL } = await startWebSocketServer();
  const messages: Record<string, unknown>[] = [];
  let requestUrl = '';

  wss.on('connection', (ws, req) => {
    requestUrl = req.url ?? '';
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);

      if (messages.length >= 2) {
        ws.send(JSON.stringify({ contextId: messages[0]?.context_id, isFinal: true }));
      }
    });
  });

  const elevenlabs = new TTS({
    apiKey: 'test-key',
    baseURL,
    chunkLengthSchedule: opts.chunkLengthSchedule,
    autoMode: opts.autoMode,
  });
  const stream = elevenlabs.stream({
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
  });

  try {
    stream.pushText('hello world.');
    stream.endInput();
    await waitUntil(() => messages.length >= 2);

    return {
      initPacket: messages[0]!,
      requestUrl,
    };
  } finally {
    stream.close();
    await elevenlabs.close();
    await closeWebSocketServer(wss);
  }
}

async function synthesizeWithMessages(
  sendResponses: (ws: WebSocket, messages: Record<string, unknown>[]) => void,
  opts: ConstructorParameters<typeof TTS>[0] = {},
) {
  const { wss, baseURL } = await startWebSocketServer();
  const messages: Record<string, unknown>[] = [];

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);
      sendResponses(ws, messages);
    });
  });

  const elevenlabs = new TTS({
    apiKey: 'test-key',
    baseURL,
    ...opts,
  });
  const stream = elevenlabs.stream({
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
  });
  const events: unknown[] = [];
  const outputTask = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })();

  try {
    stream.pushText('hello world.');
    stream.endInput();
    await waitFor(outputTask);

    return { messages, events };
  } finally {
    stream.close();
    await elevenlabs.close();
    await closeWebSocketServer(wss);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

const hasElevenlabsConfig = Boolean(process.env.ELEVEN_API_KEY && process.env.OPENAI_API_KEY);

if (hasElevenlabsConfig) {
  describe('ElevenLabs', () => {
    it('runs the shared TTS integration tests', async () => {
      const openaiPackage = '@livekit/agents-plugin-openai';
      const testPackage = '@livekit/agents-plugins-test';
      const [{ STT }, { tts }] = await Promise.all([
        import(/* @vite-ignore */ openaiPackage),
        import(/* @vite-ignore */ testPackage),
      ]);

      await tts(new TTS(), new STT());
    });
  });
} else {
  describe('ElevenLabs', () => {
    it.skip('requires ELEVEN_API_KEY and OPENAI_API_KEY', () => {});
  });
}

describe('ElevenLabs TTS options', () => {
  it('includes chunk length schedule in the WebSocket init packet', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
    });

    expect(initPacket.generation_config).toEqual({ chunk_length_schedule: [80, 120] });
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('false');
  });

  it('omits generation config when chunk length schedule is unset', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({});

    expect(initPacket).not.toHaveProperty('generation_config');
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });

  it('respects explicit autoMode with chunk length schedule', async () => {
    const { requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
      autoMode: true,
    });

    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });
});

describe('ElevenLabs TTS websocket', () => {
  const audio = Buffer.alloc(4410).toString('base64');

  it('accepts snake-case context IDs', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('still accepts camel-case context IDs', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            contextId: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('ignores flush_done for active contexts', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            type: 'flush_done',
            context_id: messages[0]?.context_id,
            status_code: 206,
            done: false,
            data: '',
            flush_done: true,
          }),
        );
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('ignores flush_done for inactive contexts', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            type: 'flush_done',
            context_id: 'already_closed_context',
            status_code: 206,
            done: false,
            data: '',
            flush_done: true,
          }),
        );
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });
});

describe('ElevenLabs text-to-dialogue', () => {
  const audio = Buffer.alloc(4410).toString('base64');

  it.each([
    ['eleven_v3', true],
    ['eleven_v3_conversational', true],
    ['eleven_turbo_v2_5', false],
    ['eleven_flash_v2_5', false],
  ])('classifies %s as dialogue=%s', (model, expected) => {
    expect(isDialogueModel(model)).toBe(expected);
  });

  it('uses the dialogue HTTP endpoint and body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.alloc(4410), {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      model: 'eleven_v3_conversational',
      voiceId: 'voice-1',
      voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
      pronunciationDictionaryLocators: [
        { pronunciation_dictionary_id: 'dict-1', version_id: 'v1' },
      ],
    });

    for await (const _event of elevenlabs.synthesize('hello there')) {
      // Consume the generated audio.
    }

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/text-to-dialogue/stream?');
    expect(String(url)).not.toContain('voice-1');
    expect(JSON.parse(String(init?.body))).toEqual({
      inputs: [{ text: 'hello there', voice_id: 'voice-1' }],
      model_id: 'eleven_v3_conversational',
      apply_text_normalization: 'auto',
      settings: { stability: 0.5 },
      pronunciation_dictionary_locators: [
        { pronunciation_dictionary_id: 'dict-1', version_id: 'v1' },
      ],
    });
    await elevenlabs.close();
  });

  it('warns about unsupported dialogue options', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    new TTS({
      apiKey: 'test-key',
      model: 'eleven_v3_conversational',
      voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
      enableSsmlParsing: true,
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('voiceSettings.similarity_boost'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('enableSsmlParsing'));
  });

  it('uses dialogue websocket framing, settings, dictionaries, and immediate close', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const messages: Record<string, unknown>[] = [];
    let requestUrl = '';
    wss.on('connection', (ws, req) => {
      requestUrl = req.url ?? '';
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        messages.push(message);
        if (message.close_context) {
          ws.send(JSON.stringify({ context_id: message.context_id, is_final: true }));
        }
      });
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL,
      model: 'eleven_v3_conversational',
      voiceId: 'voice-1',
      voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
      enableSsmlParsing: true,
      chunkLengthSchedule: [80, 120],
      pronunciationDictionaryLocators: [
        { pronunciation_dictionary_id: 'dict-1', version_id: 'v1' },
      ],
    });
    const stream = elevenlabs.stream();
    const output = (async () => {
      for await (const _event of stream) {
        // Consume the generated audio.
      }
    })();

    try {
      stream.pushText('hello world.');
      stream.endInput();
      await waitFor(output);

      expect(requestUrl).toContain('/text-to-dialogue/multi-stream-input?');
      expect(requestUrl).not.toContain('voice-1');
      expect(requestUrl).not.toContain('enable_ssml_parsing');
      expect(requestUrl).not.toContain('inactivity_timeout');
      expect(requestUrl).not.toContain('auto_mode');
      expect(messages[0]).toMatchObject({
        voices: ['voice-1'],
        voice_settings: { stability: 0.5 },
        pronunciation_dictionary_locators: [
          { pronunciation_dictionary_id: 'dict-1', version_id: 'v1' },
        ],
      });
      const inputs = messages.flatMap(
        (message) => (message.inputs as { text: string; voice_id: string }[] | undefined) ?? [],
      );
      expect(inputs.map((input) => input.text).join('')).toBe('hello world. ');
      expect(inputs.every((input) => input.voice_id === 'voice-1')).toBe(true);
      expect(messages.at(-1)).toMatchObject({ close_context: true });
    } finally {
      stream.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  });

  it('parses dialogue audio and snake-case alignment, ignoring turn boundaries', async () => {
    const { events } = await synthesizeWithMessages(
      (ws, messages) => {
        if (messages.length === 2) {
          ws.send(
            JSON.stringify({
              context_id: messages[0]?.context_id,
              audio,
              alignment: {
                chars: ['h', 'i'],
                char_start_times_ms: [0, 100],
                char_durations_ms: [100, 100],
              },
              is_final_audio_for_turn: true,
            }),
          );
          ws.send(JSON.stringify({ context_id: messages[0]?.context_id, is_final: true }));
        }
      },
      { model: 'eleven_v3_conversational' },
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it('reports dialogue errors', async () => {
    const errorSpy = vi.spyOn(log(), 'error');
    await synthesizeWithMessages(
      (ws, messages) => {
        if (messages.length === 2) {
          ws.send(
            JSON.stringify({ context_id: messages[0]?.context_id, error: 'something went wrong' }),
          );
        }
      },
      { model: 'eleven_v3_conversational' },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ 'lk.pii.error': 'something went wrong' }),
      'elevenlabs text-to-dialogue returned error',
    );
  });

  it('drops late dialogue audio after a stream is closed', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const events: unknown[] = [];
    let serverSocket: WebSocket | undefined;
    let contextId: unknown;
    wss.on('connection', (ws) => {
      serverSocket = ws;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        contextId ??= message.context_id;
      });
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL,
      model: 'eleven_v3_conversational',
    });
    const stream = elevenlabs.stream();
    const output = (async () => {
      for await (const event of stream) events.push(event);
    })();

    try {
      stream.pushText('hello world.');
      stream.flush();
      await waitUntil(() => contextId !== undefined);
      stream.close();
      serverSocket!.send(JSON.stringify({ context_id: contextId, audio, is_final: true }));
      await waitFor(output);
      expect(events).toEqual([]);
    } finally {
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  });

  it('sends per-context keep-alives and stops after close', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const messages: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        messages.push(message);
        if (message.close_context) {
          ws.send(JSON.stringify({ context_id: message.context_id, is_final: true }));
        }
      });
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL,
      model: 'eleven_v3_conversational',
    });
    const stream = elevenlabs.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 30_000 },
    });
    const output = (async () => {
      for await (const _event of stream) {
        // Consume the generated audio.
      }
    })();

    try {
      stream.pushText('hello world.');
      stream.flush();
      await waitUntil(() => messages.length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 10_100));
      expect(messages).toContainEqual(
        expect.objectContaining({ context_id: messages[0]?.context_id, keep_alive: true }),
      );

      stream.endInput();
      await waitFor(output);
      const keepAliveCount = messages.filter((message) => message.keep_alive).length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messages.filter((message) => message.keep_alive)).toHaveLength(keepAliveCount);
    } finally {
      stream.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  }, 15_000);

  it('keeps an idle dialogue context alive during traffic on another context', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const messages: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        messages.push(message);
        if (message.close_context) {
          ws.send(JSON.stringify({ context_id: message.context_id, is_final: true }));
        }
      });
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL,
      model: 'eleven_v3_conversational',
    });
    const connOptions = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 30_000 };
    const idle = elevenlabs.stream({ connOptions });
    const busy = elevenlabs.stream({ connOptions });
    const consume = (async () => {
      await Promise.all([
        (async () => {
          for await (const _event of idle) {
            // Consume the generated audio.
          }
        })(),
        (async () => {
          for await (const _event of busy) {
            // Consume the generated audio.
          }
        })(),
      ]);
    })();

    try {
      idle.pushText('idle context.');
      idle.flush();
      busy.pushText('busy context.');
      busy.flush();
      await waitUntil(() => new Set(messages.map((message) => message.context_id)).size >= 2);
      const idleContext = messages[0]?.context_id;
      for (let i = 0; i < 11; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        busy.pushText('more traffic.');
        busy.flush();
      }
      expect(messages).toContainEqual({ context_id: idleContext, keep_alive: true });

      idle.endInput();
      busy.endInput();
      await waitFor(consume);
    } finally {
      idle.close();
      busy.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  }, 15_000);
});
