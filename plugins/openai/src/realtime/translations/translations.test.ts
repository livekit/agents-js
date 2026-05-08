// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AsyncIterableQueue,
  DEFAULT_API_CONNECT_OPTIONS,
  stt,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import * as realtime from '../index.js';
import {
  DEFAULT_TRANSLATION_MODEL,
  SAMPLE_RATE,
  type TranslationClientEvent,
  type TranslationServerEvent,
  type TranslationSessionFactory,
  buildTranslationUrl,
  createSessionUpdateEvent,
  parseTranslationServerEvent,
} from './session.js';

class FakeTranslationSession {
  readonly events = new AsyncIterableQueue<TranslationServerEvent>();
  readonly sentEvents: TranslationClientEvent[] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  sendEvent(event: TranslationClientEvent): void {
    this.sentEvents.push(event);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.close();
  }
}

const createSessionFactory = (session: FakeTranslationSession): TranslationSessionFactory => {
  return () => session;
};

const createFrame = () => {
  return new AudioFrame(new Int16Array(2400), SAMPLE_RATE, 1, 2400);
};

describe('openai.realtime.translations', () => {
  it('exports STT and TTS under the realtime translations namespace', () => {
    expect(realtime.translations.STT).toBeTypeOf('function');
    expect(realtime.translations.TTS).toBeTypeOf('function');
  });

  it('builds the dedicated translation websocket URL', () => {
    expect(
      buildTranslationUrl({
        baseURL: 'https://api.openai.com/v1',
        model: DEFAULT_TRANSLATION_MODEL,
      }),
    ).toBe('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate');
  });

  it('creates a translation session.update payload with language configuration', () => {
    expect(
      createSessionUpdateEvent({
        model: DEFAULT_TRANSLATION_MODEL,
        inputLanguage: 'en',
        outputLanguage: 'es',
        inputAudioTranscription: { model: 'gpt-realtime-whisper' },
      }),
    ).toEqual({
      type: 'session.update',
      session: {
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            language: 'en',
            transcription: { model: 'gpt-realtime-whisper' },
          },
          output: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            language: 'es',
          },
        },
      },
    });
  });

  it('parses translation transcript and audio server events', () => {
    expect(
      parseTranslationServerEvent(
        JSON.stringify({ type: 'session.output_transcript.delta', delta: 'hola' }),
      ),
    ).toEqual({ type: 'session.output_transcript.delta', delta: 'hola' });

    expect(
      parseTranslationServerEvent(
        JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAA' }),
      ),
    ).toEqual({ type: 'session.output_audio.delta', delta: 'AAAA' });
  });

  it('streams translated transcript deltas as STT interim and final events', async () => {
    const session = new FakeTranslationSession();
    const translator = new realtime.translations.STT({
      apiKey: 'test-key',
      inputLanguage: 'en',
      outputLanguage: 'es',
      sessionFactory: createSessionFactory(session),
    });
    const stream = translator.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 } as APIConnectOptions,
    });

    stream.pushFrame(createFrame());
    await session.events.put({ type: 'session.output_transcript.delta', delta: 'hola' });

    const start = await stream.next();
    expect(start.value).toMatchObject({
      type: stt.SpeechEventType.START_OF_SPEECH,
    });

    const interim = await stream.next();
    expect(interim.value).toMatchObject({
      type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [
        {
          text: 'hola',
          language: 'es',
          sourceLanguages: ['en'],
        },
      ],
    });

    stream.flush();

    const final = await stream.next();
    expect(final.value).toMatchObject({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: 'hola',
          language: 'es',
          sourceLanguages: ['en'],
        },
      ],
    });

    stream.close();
    expect(session.connected).toBe(true);
    expect(session.sentEvents[0]).toMatchObject({ type: 'session.update' });
    expect(
      session.sentEvents.some((event) => event.type === 'session.input_audio_buffer.append'),
    ).toBe(true);
  });

  it('streams translated audio and transcript deltas from audio input through TTS', async () => {
    const session = new FakeTranslationSession();
    const translator = new realtime.translations.TTS({
      apiKey: 'test-key',
      inputLanguage: 'en',
      outputLanguage: 'es',
      sessionFactory: createSessionFactory(session),
    });
    const stream = translator.streamAudio({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 } as APIConnectOptions,
    });

    stream.pushFrame(createFrame());
    await session.events.put({ type: 'session.output_transcript.delta', delta: 'hola' });
    await session.events.put({
      type: 'session.output_audio.delta',
      delta: Buffer.from(new Int16Array(1200).buffer).toString('base64'),
    });

    const audio = await stream.next();
    expect(audio.value).toMatchObject({
      requestId: expect.any(String),
      segmentId: expect.any(String),
      deltaText: 'hola',
      final: false,
    });
    expect(audio.value && typeof audio.value !== 'symbol' && audio.value.frame.sampleRate).toBe(
      SAMPLE_RATE,
    );

    stream.close();
    expect(session.connected).toBe(true);
    expect(session.sentEvents[0]).toMatchObject({ type: 'session.update' });
    expect(
      session.sentEvents.some((event) => event.type === 'session.input_audio_buffer.append'),
    ).toBe(true);
  });

  it('fails fast for text-to-speech because translation sessions only document audio input', () => {
    const translator = new realtime.translations.TTS({
      apiKey: 'test-key',
      inputLanguage: 'en',
      outputLanguage: 'es',
    });

    expect(() => translator.stream()).toThrow(/audio input only/i);
    expect(() => translator.synthesize('hello')).toThrow(/audio input only/i);
  });
});
