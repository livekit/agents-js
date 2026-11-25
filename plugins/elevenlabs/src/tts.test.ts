// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APITimeoutError, DEFAULT_API_CONNECT_OPTIONS, log, tts, voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { isDialogueModel } from './models.js';
import { type SynthesizeStream, TTS } from './tts.js';

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

const SynthesizeStreamEnd = tts.SynthesizeStream.END_OF_STREAM;

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

  it('replays complete input with a fresh context after a retryable failure', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const contextTexts = new Map<string, string[]>();
    const failedContexts = new Set<string>();
    const closedContexts: string[] = [];
    const audio = Buffer.alloc(4410).toString('base64');

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          context_id?: string;
          text?: string;
          flush?: boolean;
        };
        const contextId = message.context_id;
        if (!contextId) return;
        if (message.text === undefined) {
          if ((message as { close_context?: boolean }).close_context) {
            closedContexts.push(contextId);
          }
          return;
        }

        const text = message.text.trim();
        if (text) {
          const texts = contextTexts.get(contextId) ?? [];
          texts.push(text);
          contextTexts.set(contextId, texts);
        }

        if (message.text !== '' || !message.flush) return;
        if (failedContexts.size === 0) {
          failedContexts.add(contextId);
          ws.send(JSON.stringify({ context_id: contextId, error: 'temporary provider failure' }));
          return;
        }

        ws.send(JSON.stringify({ context_id: contextId, audio, isFinal: true }));
      });
    });

    const elevenlabs = new TTS({ apiKey: 'test-key', baseURL });
    const stream = elevenlabs.stream({
      connOptions: {
        ...DEFAULT_API_CONNECT_OPTIONS,
        maxRetry: 1,
        retryIntervalMs: 0,
      },
    });
    const events: tts.SynthesizedAudio[] = [];

    try {
      stream.pushText('replay this complete sentence.');
      stream.endInput();
      for await (const event of stream) {
        if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).not.toHaveLength(0);
      expect(contextTexts.size).toBe(2);
      expect(new Set(contextTexts.keys()).size).toBe(2);
      // Only the end-of-input close, sent before the error arrived; no second, forced close.
      const failed = [...failedContexts][0];
      expect(closedContexts.filter((contextId) => contextId === failed)).toHaveLength(1);
      expect([...contextTexts.values()]).toEqual([
        ['replay this complete sentence.'],
        ['replay this complete sentence.'],
      ]);
    } finally {
      stream.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  });
});

describe('ElevenLabs TTS context lifecycle', () => {
  const audio = Buffer.alloc(4410).toString('base64');

  async function startServer(onText: (ws: WebSocket, contextId: string, text: string) => void) {
    const { wss, baseURL } = await startWebSocketServer();
    const server = {
      baseURL,
      messages: [] as Record<string, unknown>[],
      close: () => closeWebSocketServer(wss),
    };
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        server.messages.push(message);
        if (typeof message.text === 'string' && message.text.trim()) {
          onText(ws, message.context_id as string, message.text.trim());
        } else if (message.close_context) {
          ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
        }
      });
    });
    return server;
  }

  it('sends nothing more to a context the provider failed while input was open', async () => {
    let failedContext: string | undefined;
    const server = await startServer((ws, contextId) => {
      if (failedContext) return;
      failedContext = contextId;
      ws.send(JSON.stringify({ context_id: contextId, error: 'temporary provider failure' }));
    });
    const elevenlabs = new TTS({ apiKey: 'test-key', baseURL: server.baseURL });
    const stream = elevenlabs.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const output = (async () => {
      const events: unknown[] = [];
      for await (const event of stream) events.push(event);
      return events;
    })();

    try {
      stream.pushText('first sentence.');
      stream.flush();
      await waitUntil(() => failedContext !== undefined);
      // Let the failed attempt wind down while input is still open.
      await new Promise((resolve) => setTimeout(resolve, 150));
      stream.endInput();
      const events = await waitFor(output);

      const failed = server.messages.filter((message) => message.context_id === failedContext);
      // Only the init and the text that failed: no re-init, late flush, or forced close.
      expect(failed).toEqual([
        expect.objectContaining({ text: ' ' }),
        expect.objectContaining({ text: 'first sentence. ' }),
      ]);
      expect(events.filter((event) => event !== SynthesizeStreamEnd).length).toBeGreaterThan(0);
    } finally {
      stream.close();
      await elevenlabs.close();
      await server.close();
    }
  });

  it('closes an interrupted context once and sends nothing after the close', async () => {
    let contextId: string | undefined;
    const server = await startServer((_ws, id) => {
      contextId ??= id;
    });
    const elevenlabs = new TTS({ apiKey: 'test-key', baseURL: server.baseURL });
    const errors: unknown[] = [];
    elevenlabs.on('error', (error) => errors.push(error));
    const stream = elevenlabs.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });

    try {
      stream.pushText('interrupt me.');
      stream.flush();
      await waitUntil(() => contextId !== undefined);
      stream.close();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const sent = server.messages.filter((message) => message.context_id === contextId);
      expect(sent.at(-1)).toEqual({ context_id: contextId, close_context: true });
      expect(sent.filter((message) => message.close_context)).toHaveLength(1);
      expect(sent.filter((message) => message.text === '')).toEqual([]);
      expect(new Set(server.messages.map((message) => message.context_id))).toEqual(
        new Set([contextId]),
      );
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await elevenlabs.close();
      await server.close();
    }
  });

  it('sends no close for a context interrupted before it was opened', async () => {
    const server = await startServer(() => {});
    const elevenlabs = new TTS({ apiKey: 'test-key', baseURL: server.baseURL });
    const stream = elevenlabs.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });

    try {
      // Text without a sentence end stays in the tokenizer, so the context never opens.
      stream.pushText('no sentence end yet');
      await (
        elevenlabs as unknown as { currentConnection(): Promise<unknown> }
      ).currentConnection();
      await new Promise((resolve) => setTimeout(resolve, 50));
      stream.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(server.messages).toEqual([]);
    } finally {
      stream.close();
      await elevenlabs.close();
      await server.close();
    }
  });
});

describe('ElevenLabs text-to-dialogue', () => {
  const audio = Buffer.alloc(4410).toString('base64');

  it.each([
    ['eleven_v3', true],
    ['eleven_v3_conversational', true],
    ['eleven_v4', true],
    ['eleven_v4_turbo', true],
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
      voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
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
      settings: { stability: 0.5, similarity: 0.75 },
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
      voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
      enableSsmlParsing: true,
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('voiceSettings.style'));
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
      voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
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
        voice_settings: { stability: 0.5, similarity: 0.75 },
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

  it('sends clone strength to eleven_v4 over HTTP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.alloc(4410), {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      model: 'eleven_v4',
      voiceId: 'voice-1',
      voiceSettings: { stability: 0.5, similarity_boost: 0.75, clone_strength: 0.3 },
    });

    for await (const _event of elevenlabs.synthesize('hello there')) {
      // Consume the generated audio.
    }

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).settings).toEqual({
      stability: 0.5,
      similarity: 0.75,
      clone_strength: 0.3,
    });
    await elevenlabs.close();
  });

  it('sends clone strength to eleven_v4 over websocket', async () => {
    const { messages } = await synthesizeWithMessages(
      (ws, received) => {
        if (received.length === 2) {
          ws.send(JSON.stringify({ context_id: received[0]?.context_id, is_final: true }));
        }
      },
      {
        model: 'eleven_v4_turbo',
        voiceId: 'voice-1',
        voiceSettings: { stability: 0.5, similarity_boost: 0.75, clone_strength: 0.3 },
      },
    );

    expect(messages[0]?.voice_settings).toEqual({
      stability: 0.5,
      similarity: 0.75,
      clone_strength: 0.3,
    });
  });

  it.each(['eleven_v3_conversational', 'eleven_flash_v2_5'])(
    'warns and drops clone strength for %s',
    async (model) => {
      const warnSpy = vi.spyOn(log(), 'warn');
      const { messages } = await synthesizeWithMessages(
        (ws, received) => {
          if (received.length === 2) {
            ws.send(
              JSON.stringify({
                [isDialogueModel(model) ? 'context_id' : 'contextId']: received[0]?.context_id,
                [isDialogueModel(model) ? 'is_final' : 'isFinal']: true,
              }),
            );
          }
        },
        {
          model,
          voiceId: 'voice-1',
          voiceSettings: { stability: 0.5, similarity_boost: 0.75, clone_strength: 0.3 },
        },
      );

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('voiceSettings.clone_strength'));
      expect(messages[0]?.voice_settings).not.toHaveProperty('clone_strength');
    },
  );

  it('warns when updateOptions sets ignored clone strength', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      model: 'eleven_flash_v2_5',
      voiceId: 'voice-1',
    });

    elevenlabs.updateOptions({
      voiceSettings: { stability: 0.5, similarity_boost: 0.75, clone_strength: 0.3 },
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('voiceSettings.clone_strength'));
  });

  it('sends clone strength again after switching back to eleven_v4', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.alloc(4410), {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      model: 'eleven_v4',
      voiceId: 'voice-1',
      voiceSettings: { stability: 0.5, similarity_boost: 0.75, clone_strength: 0.3 },
    });

    elevenlabs.updateOptions({ model: 'eleven_flash_v2_5' });
    for await (const _event of elevenlabs.synthesize('first')) {
      // Consume the generated audio.
    }
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)).voice_settings).not.toHaveProperty(
      'clone_strength',
    );

    elevenlabs.updateOptions({ model: 'eleven_v4' });
    for await (const _event of elevenlabs.synthesize('second')) {
      // Consume the generated audio.
    }
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]?.body)).settings.clone_strength).toBe(0.3);
    await elevenlabs.close();
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
      expect.objectContaining({ error: 'something went wrong' }),
      'elevenlabs text-to-dialogue returned error',
    );
  });

  it('re-arms the response timeout after audio arrives', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let textMessages = 0;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!message.inputs) return;
        // Answer only the first text send, then stall.
        if (++textMessages === 1) {
          ws.send(JSON.stringify({ context_id: message.context_id, audio }));
        }
      });
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL,
      model: 'eleven_v3_conversational',
    });
    const errors: unknown[] = [];
    elevenlabs.on('error', (event) => errors.push(event.error));
    const stream = elevenlabs.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 300 },
    });
    const output = (async () => {
      for await (const _event of stream) {
        // Consume the generated audio.
      }
    })();

    try {
      stream.pushText('hello world.');
      stream.flush();
      await waitUntil(() => textMessages === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      stream.pushText('second sentence.');
      stream.flush();
      await waitUntil(() => errors.length > 0);
      expect(errors[0]).toBeInstanceOf(APITimeoutError);
      await waitFor(output);
    } finally {
      stream.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  });

  it('times out when the final response stalls after close_context', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        // Answer every text send with audio, but never send is_final.
        if (message.inputs) ws.send(JSON.stringify({ context_id: message.context_id, audio }));
      });
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL,
      model: 'eleven_v3_conversational',
    });
    const errors: unknown[] = [];
    elevenlabs.on('error', (event) => errors.push(event.error));
    const stream = elevenlabs.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 300 },
    });
    const output = (async () => {
      for await (const _event of stream) {
        // Consume the generated audio.
      }
    })();

    try {
      stream.pushText('hello world.');
      stream.endInput();
      await waitUntil(() => errors.length > 0);
      expect(errors[0]).toBeInstanceOf(APITimeoutError);
      await waitFor(output);
    } finally {
      stream.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
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

  /**
   * A dialogue stand-in that, like ElevenLabs, closes the socket with 1008 when a message reaches a
   * context it already closed. `onInputs` handles text for an open context.
   */
  async function startDialogueServer(
    onInputs: (ws: WebSocket, contextId: unknown, connection: number) => void = () => {},
  ) {
    const { wss, baseURL } = await startWebSocketServer();
    const server = {
      baseURL,
      received: [] as Record<string, unknown>[],
      rejected: [] as Record<string, unknown>[],
      connections: 0,
      close: () => closeWebSocketServer(wss),
    };
    wss.on('connection', (ws) => {
      const connection = ++server.connections;
      const closedContexts = new Set<unknown>();
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        server.received.push(message);
        if (closedContexts.has(message.context_id)) {
          server.rejected.push(message);
          ws.close(1008);
        } else if (message.close_context) {
          closedContexts.add(message.context_id);
          ws.send(JSON.stringify({ context_id: message.context_id, audio, is_final: true }));
        } else if (message.inputs) {
          onInputs(ws, message.context_id, connection);
        }
      });
    });
    return server;
  }

  async function synthesize(stream: SynthesizeStream, text: string) {
    stream.pushText(text);
    stream.endInput();
    const events: (tts.SynthesizedAudio | typeof SynthesizeStreamEnd)[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  const dialogueConnOptions = { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 };

  it('finishes an interrupted stream when its pending connection becomes ready', async () => {
    const server = await startDialogueServer();
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      model: 'eleven_v3_conversational',
    });
    const currentConnection = elevenlabs.currentConnection.bind(elevenlabs);
    let releaseConnection!: () => void;
    const held = new Promise<void>((resolve) => (releaseConnection = resolve));
    const acquire = vi.spyOn(elevenlabs, 'currentConnection').mockImplementation(async () => {
      const connection = await currentConnection();
      await held;
      return connection;
    });
    const stream = elevenlabs.stream({ connOptions: dialogueConnOptions });
    const done = vi.spyOn(stream as unknown as { onStreamDone(): void }, 'onStreamDone');

    try {
      stream.pushText('hello world.');
      await waitUntil(() => server.connections === 1);
      stream.close();
      releaseConnection();

      await waitUntil(() => done.mock.calls.length === 1);
      expect(server.received).toEqual([]);
      acquire.mockRestore();
      expect(await waitFor(synthesize(elevenlabs.stream(), 'next reply.'))).not.toHaveLength(0);
      expect(server.connections).toBe(1);
    } finally {
      releaseConnection();
      stream.close();
      await elevenlabs.close();
      await server.close();
    }
  });

  it('keeps the shared socket open after the session interrupts a reply', async () => {
    const server = await startDialogueServer();
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      model: 'eleven_v3_conversational',
    });
    const errors: unknown[] = [];
    elevenlabs.on('error', (error) => errors.push(error));

    class TestAudioOutput extends voice.AudioOutput {
      frames: AudioFrame[] = [];

      override async captureFrame(frame: AudioFrame): Promise<void> {
        const segmentCount = this.capturedPlayoutSegments;
        await super.captureFrame(frame);
        this.frames.push(frame);
        if (this.capturedPlayoutSegments > segmentCount) this.onPlaybackStarted(Date.now());
      }

      override flush(): void {
        super.flush();
        if (this.pendingPlayoutSegments > 0) {
          this.onPlaybackFinished({ playbackPosition: 0.1, interrupted: false });
        }
      }

      override clearBuffer(): void {
        if (this.pendingPlayoutSegments > 0) {
          this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
        }
      }
    }

    const session = new voice.AgentSession({
      tts: elevenlabs,
      connOptions: { ttsConnOptions: { ...dialogueConnOptions, maxRetry: 0 } },
    });
    const output = new TestAudioOutput();
    session.output.audio = output;

    try {
      await session.start({ agent: new voice.Agent({ instructions: 'Read the supplied text.' }) });
      const text = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('This is the first sentence of the reply. The input is still open. ');
        },
      });
      const interrupted = session.say(text, { allowInterruptions: true });
      await waitUntil(() => server.received.some((message) => message.inputs));
      const contextId = server.received.find((message) => message.inputs)?.context_id;

      await waitFor(session.interrupt().await);
      await waitFor(interrupted.waitForPlayout());
      expect(interrupted.interrupted).toBe(true);
      expect(output.frames).toHaveLength(0);

      await waitFor(session.say('This is the next reply.').waitForPlayout());

      const closes = server.received.filter(
        (message) => message.context_id === contextId && message.close_context,
      );
      expect(closes).toHaveLength(1);
      expect(server.rejected).toEqual([]);
      expect(server.connections).toBe(1);
      expect(output.frames.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally {
      await session.close();
      await elevenlabs.close();
      await server.close();
    }
  });

  it('retries on a new socket when it closes with 1008 before audio', async () => {
    const server = await startDialogueServer((ws, _contextId, connection) => {
      if (connection === 1) ws.close(1008);
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      model: 'eleven_v3_conversational',
    });
    const errors: unknown[] = [];
    elevenlabs.on('error', (error) => errors.push(error));
    const stream = elevenlabs.stream({ connOptions: dialogueConnOptions });

    const initialContextId = stream.contextId;

    try {
      const events = await waitFor(synthesize(stream, 'hello world.'), 2000);

      expect(server.connections).toBe(2);
      const contextIds = server.received
        .filter((message) => message.voices)
        .map((message) => message.context_id);
      expect(contextIds).toHaveLength(2);
      expect(contextIds[0]).toBe(initialContextId);
      expect(contextIds[1]).not.toBe(initialContextId);
      expect(stream.contextId).toBe(initialContextId);
      const inputs = server.received.flatMap(
        (message) => (message.inputs as { text: string }[] | undefined) ?? [],
      );
      expect(inputs.map((input) => input.text.trim()).filter(Boolean)).toEqual([
        'hello world.',
        'hello world.',
      ]);
      const frames = events.filter((event) => typeof event !== 'symbol');
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.requestId).toBe(initialContextId);
        expect(frame.segmentId).toBe(initialContextId);
      }
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await elevenlabs.close();
      await server.close();
    }
  });

  it('fails without a retry when it closes with 1008 after audio', async () => {
    const server = await startDialogueServer((ws, contextId) => {
      // Close before the final response, so the context ends after its audio but unfinished.
      ws.send(JSON.stringify({ context_id: contextId, audio }));
      ws.close(1008);
    });
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      model: 'eleven_v3_conversational',
    });
    const errors: { recoverable: boolean }[] = [];
    elevenlabs.on('error', (error) => errors.push(error));
    const stream = elevenlabs.stream({ connOptions: dialogueConnOptions });

    try {
      const events = await waitFor(synthesize(stream, 'hello world.'), 2000);

      expect(server.connections).toBe(1);
      expect(events.filter((event) => event !== SynthesizeStreamEnd).length).toBeGreaterThan(0);
      expect(errors.map((error) => error.recoverable)).toEqual([false]);
    } finally {
      stream.close();
      await elevenlabs.close();
      await server.close();
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
