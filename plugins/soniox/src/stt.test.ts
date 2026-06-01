// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  type LangSegment,
  type SonioxMessage,
  type SonioxToken,
  TokenAccumulator,
  mergeLangSegments,
  newProcessMessageState,
  processMessage,
} from './_internal.js';
import { STT } from './stt.js';

// ---------------------------------------------------------------------------
// TokenAccumulator: language-segment coalescing
// ---------------------------------------------------------------------------

describe('TokenAccumulator', () => {
  it('coalesces consecutive same-language token runs into segments', () => {
    const accumulator = new TokenAccumulator();
    for (const [lang, text] of [
      ['en', 'Hello'],
      ['en', ' world'],
      ['es', ' hola'],
      ['es', ' mundo'],
      ['en', ' again'],
    ] as const) {
      accumulator.update({ text, language: lang, is_final: true });
    }

    expect(accumulator.langSegments).toEqual([
      ['en', 'Hello world'],
      ['es', ' hola mundo'],
      ['en', ' again'],
    ]);
    expect(accumulator.text).toBe('Hello world hola mundo again');
    expect(accumulator.langSegments.map(([, t]: [string, string]) => t).join('')).toBe(
      accumulator.text,
    );
  });

  it('starts with no lang segments', () => {
    const accumulator = new TokenAccumulator();
    expect(accumulator.langSegments).toEqual([]);
  });

  it('resets all state via reset()', () => {
    const accumulator = new TokenAccumulator();
    accumulator.update({ text: 'hi', language: 'en', is_final: true, start_ms: 100, end_ms: 200 });
    accumulator.reset();
    expect(accumulator.text).toBe('');
    expect(accumulator.startTime).toBe(0);
    expect(accumulator.endTime).toBe(0);
    expect(accumulator.langSegments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeLangSegments helper
// ---------------------------------------------------------------------------

describe('mergeLangSegments', () => {
  it('appends adjacent same-language segments instead of duplicating them', () => {
    const merged = mergeLangSegments(
      [['en' as stt.SpeechData['language'], 'Hello']],
      [['en' as stt.SpeechData['language'], ' world']],
    );
    expect(merged).toEqual([['en', 'Hello world']]);
  });

  it('keeps distinct-language boundaries as separate runs', () => {
    const merged = mergeLangSegments(
      [['en' as stt.SpeechData['language'], 'Hello']],
      [['es' as stt.SpeechData['language'], ' hola']],
    );
    expect(merged).toEqual([
      ['en', 'Hello'],
      ['es', ' hola'],
    ]);
  });

  it('does not mutate the input segments when extending a trailing run', () => {
    const a: LangSegment[] = [['en' as stt.SpeechData['language'], 'Hello']];
    const b: LangSegment[] = [['en' as stt.SpeechData['language'], ' world']];
    mergeLangSegments(a, b);
    expect(a).toEqual([['en', 'Hello']]);
    expect(b).toEqual([['en', ' world']]);
  });
});

// ---------------------------------------------------------------------------
// processMessage end-to-end via direct invocation
// ---------------------------------------------------------------------------

function finalToken(text: string, language: string, translationStatus?: string): SonioxToken {
  const token: SonioxToken = { text, language, is_final: true };
  if (translationStatus !== undefined) token.translation_status = translationStatus;
  return token;
}

function nonfinalToken(text: string, language: string, translationStatus?: string): SonioxToken {
  const token: SonioxToken = { text, language, is_final: false };
  if (translationStatus !== undefined) token.translation_status = translationStatus;
  return token;
}

const END_TOKEN_FINAL: SonioxToken = { text: '<end>', is_final: true } as SonioxToken;

function runProcess(
  messages: SonioxMessage[],
  options: { isTranslationMode: boolean; startTimeOffset?: number } = { isTranslationMode: false },
): stt.SpeechEvent[] {
  const state = newProcessMessageState();
  const events: stt.SpeechEvent[] = [];
  for (const msg of messages) {
    events.push(
      ...processMessage(state, msg, {
        isTranslationMode: options.isTranslationMode,
        startTimeOffset: options.startTimeOffset ?? 0,
      }),
    );
  }
  return events;
}

describe('processMessage', () => {
  it('two-way translation, code-switched input produces per-run source and target lists', () => {
    const events = runProcess(
      [
        {
          tokens: [
            finalToken('No hablo español, ', 'es', 'original'),
            finalToken('but I speak English.', 'en', 'original'),
            finalToken("I don't speak Spanish, ", 'en', 'translation'),
            finalToken('pero hablo inglés.', 'es', 'translation'),
            END_TOKEN_FINAL,
          ],
          total_audio_proc_ms: 1000,
        },
      ],
      { isTranslationMode: true },
    );

    const types = events.map((e) => e.type);
    expect(types).toContain(stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(types).toContain(stt.SpeechEventType.END_OF_SPEECH);

    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!;
    const sd = final.alternatives![0]!;

    expect(sd.text).toBe("I don't speak Spanish, pero hablo inglés.");
    expect(sd.language).toBe('en');
    expect(sd.sourceLanguages).toEqual(['es', 'en']);
    expect(sd.sourceTexts).toEqual(['No hablo español, ', 'but I speak English.']);
    expect(sd.targetLanguages).toEqual(['en', 'es']);
    expect(sd.targetTexts).toEqual(["I don't speak Spanish, ", 'pero hablo inglés.']);
    expect(sd.targetTexts!.join('')).toBe(sd.text);
  });

  it('one-way translation produces a single-entry target language list', () => {
    const events = runProcess(
      [
        {
          tokens: [
            finalToken('Hello world.', 'en', 'original'),
            finalToken('Hola mundo.', 'es', 'translation'),
            END_TOKEN_FINAL,
          ],
          total_audio_proc_ms: 500,
        },
      ],
      { isTranslationMode: true },
    );

    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!;
    const sd = final.alternatives![0]!;

    expect(sd.text).toBe('Hola mundo.');
    expect(sd.language).toBe('es');
    expect(sd.sourceLanguages).toEqual(['en']);
    expect(sd.sourceTexts).toEqual(['Hello world.']);
    expect(sd.targetLanguages).toEqual(['es']);
    expect(sd.targetTexts).toEqual(['Hola mundo.']);
  });

  it('untranslated "none" chunk yields asymmetric source and target lists', () => {
    const events = runProcess(
      [
        {
          tokens: [
            finalToken('Good morning. ', 'en', 'original'),
            finalToken('Bonjour à tous. ', 'fr', 'none'),
            finalToken('How are you?', 'en', 'original'),
            finalToken('Guten Morgen. ', 'de', 'translation'),
            finalToken("Wie geht's?", 'de', 'translation'),
            END_TOKEN_FINAL,
          ],
          total_audio_proc_ms: 1200,
        },
      ],
      { isTranslationMode: true },
    );

    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!;
    const sd = final.alternatives![0]!;

    // fr chunk sits between two en chunks → three source runs.
    expect(sd.sourceLanguages).toEqual(['en', 'fr', 'en']);
    expect(sd.sourceTexts).toEqual(['Good morning. ', 'Bonjour à tous. ', 'How are you?']);
    // Both translation tokens are de → single coalesced target run.
    expect(sd.targetLanguages).toEqual(['de']);
    expect(sd.targetTexts).toEqual(["Guten Morgen. Wie geht's?"]);
    // Independent per-run lists may legitimately have different lengths.
    expect(sd.sourceLanguages!.length).not.toBe(sd.targetLanguages!.length);
  });

  it('interim transcript merges final-so-far with non-final tokens per run', () => {
    const events = runProcess(
      [
        {
          tokens: [
            finalToken('Hola, ', 'es', 'original'),
            finalToken('Hello, ', 'en', 'translation'),
            nonfinalToken('¿cómo estás?', 'es', 'original'),
            nonfinalToken('how are you?', 'en', 'translation'),
          ],
          total_audio_proc_ms: 800,
        },
      ],
      { isTranslationMode: true },
    );

    const interim = events.find(
      (e) =>
        e.type === stt.SpeechEventType.INTERIM_TRANSCRIPT ||
        e.type === stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
    )!;
    const sd = interim.alternatives![0]!;

    expect(sd.sourceLanguages).toEqual(['es']);
    expect(sd.sourceTexts).toEqual(['Hola, ¿cómo estás?']);
    expect(sd.targetLanguages).toEqual(['en']);
    expect(sd.targetTexts).toEqual(['Hello, how are you?']);
  });

  it('interim transcript surfaces per-run source breakdown in non-translation mode', () => {
    const events = runProcess([
      {
        tokens: [finalToken('こんにちは、', 'ja'), nonfinalToken('My name is Sam.', 'en')],
        total_audio_proc_ms: 600,
      },
    ]);

    const interim = events.find(
      (e) =>
        e.type === stt.SpeechEventType.INTERIM_TRANSCRIPT ||
        e.type === stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
    )!;
    const sd = interim.alternatives![0]!;

    expect(sd.sourceLanguages).toEqual(['ja', 'en']);
    expect(sd.sourceTexts).toEqual(['こんにちは、', 'My name is Sam.']);
    expect(sd.targetLanguages).toBeUndefined();
    expect(sd.targetTexts).toBeUndefined();
  });

  it('non-translation mode populates source from the per-run breakdown (single language)', () => {
    const events = runProcess([
      {
        tokens: [finalToken('Hello world.', 'en'), END_TOKEN_FINAL],
        total_audio_proc_ms: 500,
      },
    ]);

    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!;
    const sd = final.alternatives![0]!;

    expect(sd.text).toBe('Hello world.');
    expect(sd.language).toBe('en');
    expect(sd.sourceLanguages).toEqual(['en']);
    expect(sd.sourceTexts).toEqual(['Hello world.']);
    expect(sd.targetLanguages).toBeUndefined();
    expect(sd.targetTexts).toBeUndefined();
  });

  it('non-translation, code-switched input carries the per-run source breakdown', () => {
    const events = runProcess([
      {
        tokens: [
          finalToken('こんにちは、君の名前は何だ。', 'ja'),
          finalToken(' My name is Sam.', 'en'),
          END_TOKEN_FINAL,
        ],
        total_audio_proc_ms: 1500,
      },
    ]);

    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!;
    const sd = final.alternatives![0]!;

    expect(sd.text).toBe('こんにちは、君の名前は何だ。 My name is Sam.');
    // sd.language is the plugin's opinionated lossy summary (most-chars-wins);
    // the per-run sourceLanguages / sourceTexts are what this test exercises.
    expect(sd.sourceLanguages).toEqual(['ja', 'en']);
    expect(sd.sourceTexts).toEqual(['こんにちは、君の名前は何だ。', ' My name is Sam.']);
    expect(sd.targetLanguages).toBeUndefined();
    expect(sd.targetTexts).toBeUndefined();
    expect(sd.sourceTexts!.join('')).toBe(sd.text);
  });
});

// ---------------------------------------------------------------------------
// Server error frames surface as APIStatusError (covers SpeechStream.run /
// #runWS, which the processMessage-only tests above do not exercise).
// Mirrors the Python `test_recv_messages_raises_on_server_error_frame`.
// ---------------------------------------------------------------------------

async function startWebSocketServer(): Promise<{ wss: WebSocketServer; baseUrl: string }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

describe('SpeechStream server errors', () => {
  // SpeechStream.mainTask re-throws after emitting the 'error' event (the
  // rethrow only drives `.finally()` cleanup; the error is observed via the
  // event). Suppress the resulting by-design unhandled rejection.
  const swallowRejection = () => {};
  beforeAll(() => process.on('unhandledRejection', swallowRejection));
  afterAll(() => void process.off('unhandledRejection', swallowRejection));

  it('surfaces a Soniox error frame as a non-retryable APIStatusError', async () => {
    const { wss, baseUrl } = await startWebSocketServer();

    // Reply to the initial config message after a short delay so the receive
    // loop's message listener is attached before the error frame arrives.
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              error_code: 401,
              error_message: 'Incorrect API key provided',
              total_audio_proc_ms: 0,
            }),
          );
        }, 20);
      });
    });

    try {
      const soniox = new STT({ apiKey: 'test-key', baseUrl });
      const errorEvent = once(soniox, 'error') as Promise<Parameters<stt.STTCallbacks['error']>>;

      const stream = soniox.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });
      // Drain the stream so it runs to completion; fatal errors surface via the
      // STT 'error' event rather than through the event iterator.
      const drain = (async () => {
        for await (const _ of stream) {
          /* discard events */
        }
      })();

      const [{ error, recoverable }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      const statusError = error as APIStatusError;
      expect(statusError.statusCode).toBe(401);
      expect(statusError.retryable).toBe(false);
      expect(statusError.body).not.toBeNull();
      expect(recoverable).toBe(false);

      stream.close();
      await drain.catch(() => {});
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful end-of-audio: when the audio input ends, the stream sends an empty
// frame so the server flushes its final transcript before the socket closes,
// instead of tearing down the moment the input runs dry.
// ---------------------------------------------------------------------------

function makeFrame(samplesPerChannel = 800, sampleRate = 16000): AudioFrame {
  return new AudioFrame(new Int16Array(samplesPerChannel), sampleRate, 1, samplesPerChannel);
}

describe('SpeechStream graceful close', () => {
  it('signals end-of-audio on input end and delivers the flushed final transcript', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let sawEndOfAudioFrame = false;

    // The server withholds the final transcript until it receives the empty
    // end-of-audio frame — so a passing assertion proves the stream waited for
    // that response rather than closing as soon as the input drained.
    wss.on('connection', (ws) => {
      let configured = false;
      ws.on('message', (data: Buffer) => {
        if (!configured) {
          configured = true; // first message is the JSON config
          return;
        }
        if (data.length === 0) {
          sawEndOfAudioFrame = true;
          ws.send(
            JSON.stringify({
              tokens: [
                { text: 'Hello world.', language: 'en', is_final: true },
                { text: '<end>', is_final: true },
              ],
              total_audio_proc_ms: 500,
            }),
          );
          ws.send(JSON.stringify({ finished: true }));
          ws.close();
        }
      });
    });

    try {
      const soniox = new STT({ apiKey: 'test-key', baseUrl });
      const stream = soniox.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });

      stream.pushFrame(makeFrame());
      stream.endInput();

      const events: stt.SpeechEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      stream.close();

      expect(sawEndOfAudioFrame).toBe(true);
      const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
      expect(final?.alternatives?.[0]?.text).toBe('Hello world.');
      expect(events.some((e) => e.type === stt.SpeechEventType.END_OF_SPEECH)).toBe(true);
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});
