// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as genai from '@google/genai';
import { stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STT, _isSessionDurationClose } from './gemini_stt.js';

type ServerFrame = Pick<genai.LiveServerMessage, 'serverContent'>;

const { live } = vi.hoisted(() => ({
  live: { messages: [] as ServerFrame[] },
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof genai>();
  return {
    ...actual,
    GoogleGenAI: class {
      live = {
        connect: async ({
          callbacks,
        }: {
          callbacks: {
            onopen: () => void;
            onmessage: (message: ServerFrame) => void;
            onclose: (event: CloseEvent) => void;
          };
        }) => {
          callbacks.onopen();
          for (const message of live.messages) callbacks.onmessage(message);
          callbacks.onclose({ code: 1000, reason: '' } as CloseEvent);
          return {
            sendRealtimeInput: () => {},
            close: () => {},
          };
        },
      };
    },
  };
});

function message(serverContent: ServerFrame['serverContent']): ServerFrame {
  return { serverContent };
}

function frame(): AudioFrame {
  return new AudioFrame(new Int16Array(160), 16000, 1, 160);
}

async function drain(messages: ServerFrame[]): Promise<stt.SpeechEvent[]> {
  live.messages = messages;
  const stream = new STT({ apiKey: 'test-key' }).stream();
  stream.pushFrame(frame());
  stream.endInput();
  const events: stt.SpeechEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function texts(events: stt.SpeechEvent[], eventType: stt.SpeechEventType): string[] {
  return events
    .filter((event) => event.type === eventType)
    .map((event) => event.alternatives![0].text);
}

describe('Gemini STT', () => {
  beforeEach(() => {
    live.messages = [];
  });

  it('emits the finalized transcript on arrival', async () => {
    const events = await drain([
      message({ interimInputTranscription: { text: 'Greetings.' } }),
      message({ interimInputTranscription: { text: 'Greetings, welcome' } }),
      message({ inputTranscription: { text: 'Greetings, welcome to the age of AI.' } }),
      message({ generationComplete: true }),
    ]);

    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual([
      'Greetings, welcome to the age of AI.',
    ]);
    expect(texts(events, stt.SpeechEventType.INTERIM_TRANSCRIPT)).toEqual([
      'Greetings.',
      'Greetings, welcome',
    ]);
  });

  it('finalizes each turn separately', async () => {
    const events = await drain([
      message({ inputTranscription: { text: 'First utterance.' } }),
      message({ generationComplete: true }),
      message({ inputTranscription: { text: 'Second utterance.' } }),
      message({ generationComplete: true }),
    ]);

    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual([
      'First utterance.',
      'Second utterance.',
    ]);
  });

  it('keeps back-to-back finals separate without a completion signal', async () => {
    const events = await drain([
      message({ inputTranscription: { text: 'First utterance.' } }),
      message({ inputTranscription: { text: 'Second utterance.' } }),
    ]);

    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual([
      'First utterance.',
      'Second utterance.',
    ]);
  });

  it('does not concatenate cumulative interims', async () => {
    const events = await drain([
      message({ interimInputTranscription: { text: 'I am' } }),
      message({ interimInputTranscription: { text: 'I am a human' } }),
    ]);

    expect(texts(events, stt.SpeechEventType.INTERIM_TRANSCRIPT)).toEqual(['I am', 'I am a human']);
  });

  it('commits an interim-only turn', async () => {
    const events = await drain([
      message({ interimInputTranscription: { text: 'hello there' } }),
      message({ generationComplete: true }),
    ]);

    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual(['hello there']);
  });

  it('does not duplicate a final when completion follows it', async () => {
    const events = await drain([
      message({ interimInputTranscription: { text: 'hello' } }),
      message({ inputTranscription: { text: 'Hello.' } }),
      message({ generationComplete: true }),
    ]);

    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual(['Hello.']);
  });

  it('emits nothing for a completion without a transcript', async () => {
    const events = await drain([message({ generationComplete: true })]);
    expect(texts(events, stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual([]);
  });

  it('reports the detected language', async () => {
    const events = await drain([
      message({ inputTranscription: { text: 'bonjour', languageCode: 'fr-FR' } }),
    ]);
    const finals = events.filter((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT);

    expect(finals).toHaveLength(1);
    expect(finals[0]!.alternatives![0].language).toBe('fr-FR');
  });

  it('uses the configured language when none is detected', async () => {
    const events = await drain([message({ inputTranscription: { text: 'hi' } })]);
    const finals = events.filter((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT);

    expect(finals[0]!.alternatives![0].language).toBe('en-US');
  });

  const goAway =
    'received 1008 (policy violation) Connection aborted because the client failed to ' +
    'close the connection after receiving a GoAway signal once the session duration ' +
    'limit was reached';

  it.each([
    [new Error(goAway), true],
    [new Error('1008 None. ... after receiving a GoAway signal once the session durat'), true],
    [new Error('1007 The requested combination of response modalities is not supported'), false],
    [new Error('429 RESOURCE_EXHAUSTED'), false],
  ])('classifies session-duration close %#', (error, expected) => {
    expect(_isSessionDurationClose(error)).toBe(expected);
  });
});
