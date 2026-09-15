// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as genai from '@google/genai';
import { Modality } from '@google/genai';
import type { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime_api.js';

/** The fields of a server message the session reads — `LiveServerMessage` itself is a class. */
type ServerFrame = Pick<genai.LiveServerMessage, 'serverContent' | 'toolCall'>;

type ServerCallbacks = {
  onopen: () => void;
  onmessage: (message: ServerFrame) => void;
};

/**
 * Captures the callbacks the plugin hands to `live.connect()` so a test can
 * play server frames into the real `RealtimeSession`. Hoisted because `vi.mock` is.
 */
const { live } = vi.hoisted(() => ({
  live: { callbacks: undefined as ServerCallbacks | undefined },
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof genai>();
  return {
    ...actual,
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }: { callbacks: ServerCallbacks }) => {
          live.callbacks = callbacks;
          callbacks.onopen();
          return {
            sendClientContent: () => {},
            sendRealtimeInput: () => {},
            sendToolResponse: () => {},
            close: () => {},
          };
        },
      };
    },
  };
});

type SessionOptions = Partial<ConstructorParameters<typeof RealtimeModel>[0]>;

/** Two PCM16 samples — enough for the plugin to build one AudioFrame. */
const AUDIO_PART: genai.Part = {
  inlineData: { data: Buffer.from([0, 0, 0, 0]).toString('base64'), mimeType: 'audio/pcm' },
};

async function openSession(options: SessionOptions = {}) {
  live.callbacks = undefined;
  const session = new RealtimeModel({
    model: 'gemini-2.0-flash-live-001',
    apiKey: 'test-key',
    ...options,
  }).session();

  const generations: llm.GenerationCreatedEvent[] = [];
  session.on('generation_created', (ev) => generations.push(ev));

  // Frames are only accepted once the main task holds the connected session.
  const internals = session as unknown as { activeSession?: unknown };
  await vi.waitFor(() => expect(internals.activeSession).toBeDefined());

  return {
    generations,
    serverSends: (message: ServerFrame) => live.callbacks!.onmessage(message),
  };
}

/**
 * Frames are handled asynchronously (the plugin serialises them behind its
 * session lock), so wait for the generation they open, then drain it the way
 * AgentActivity would: every message's text and audio, then the tool calls.
 */
async function drainFirst(generations: llm.GenerationCreatedEvent[]) {
  await vi.waitFor(() => expect(generations).toHaveLength(1));
  const ev = generations[0]!;

  let text = '';
  let audioFrames = 0;
  for await (const message of ev.messageStream) {
    for await (const chunk of message.textStream) {
      text += typeof chunk === 'string' ? chunk : chunk.text;
    }
    for await (const _frame of message.audioStream) {
      audioFrames += 1;
    }
  }

  const functionCalls: string[] = [];
  for await (const call of ev.functionStream) {
    functionCalls.push(call.name);
  }

  return { text, audioFrames, functionCalls };
}

describe('Gemini realtime transcript', () => {
  it('carries only the output transcription when audio and transcription are on', async () => {
    const { generations, serverSends } = await openSession();

    // The exact shape seen in production: the model writes a function call out as
    // text, then speaks. Only the spoken words belong in the transcript.
    serverSends({
      serverContent: { modelTurn: { parts: [{ text: 'call:assetGenerator{context:' }] } },
    });
    serverSends({ serverContent: { modelTurn: { parts: [AUDIO_PART] } } });
    serverSends({ serverContent: { outputTranscription: { text: 'Tako je!' } } });
    serverSends({ serverContent: { generationComplete: true } });
    serverSends({ serverContent: { turnComplete: true } });

    await expect(drainFirst(generations)).resolves.toEqual({
      text: 'Tako je!',
      audioFrames: 1,
      functionCalls: [],
    });
  });

  it('still delivers the tool call the model makes after writing one out as text', async () => {
    const { generations, serverSends } = await openSession();

    serverSends({
      serverContent: { modelTurn: { parts: [{ text: 'call:getWeather{location:' }] } },
    });
    serverSends({
      toolCall: {
        functionCalls: [{ id: 'fc-1', name: 'getWeather', args: { location: 'Seattle' } }],
      },
    });

    await expect(drainFirst(generations)).resolves.toEqual({
      text: '',
      audioFrames: 0,
      functionCalls: ['getWeather'],
    });
  });

  it('keeps forwarding model text in text modality', async () => {
    const { generations, serverSends } = await openSession({ modalities: [Modality.TEXT] });

    serverSends({ serverContent: { modelTurn: { parts: [{ text: 'Hello there.' }] } } });
    serverSends({ serverContent: { turnComplete: true } });

    await expect(drainFirst(generations)).resolves.toEqual({
      text: 'Hello there.',
      audioFrames: 0,
      functionCalls: [],
    });
  });

  it('keeps forwarding model text when output transcription is disabled', async () => {
    const { generations, serverSends } = await openSession({ outputAudioTranscription: null });

    serverSends({ serverContent: { modelTurn: { parts: [{ text: 'Hello there.' }] } } });
    serverSends({ serverContent: { turnComplete: true } });

    await expect(drainFirst(generations)).resolves.toEqual({
      text: 'Hello there.',
      audioFrames: 0,
      functionCalls: [],
    });
  });
});
