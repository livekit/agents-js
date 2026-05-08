// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue } from '@livekit/agents';
import { type MessageEvent, WebSocket } from 'ws';
import { z } from 'zod';

export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;
export const DEFAULT_TRANSLATION_MODEL = 'gpt-realtime-translate';
export const DEFAULT_INPUT_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export const translationInputAudioTranscriptionSchema = z.object({
  model: z.string(),
});

export const translationAudioFormatSchema = z.object({
  type: z.literal('audio/pcm'),
  rate: z.number(),
});

export const translationSessionUpdateEventSchema = z.object({
  type: z.literal('session.update'),
  session: z.object({
    audio: z.object({
      input: z.object({
        format: translationAudioFormatSchema,
        language: z.string().optional(),
        transcription: translationInputAudioTranscriptionSchema.nullable().optional(),
      }),
      output: z.object({
        format: translationAudioFormatSchema,
        language: z.string(),
      }),
    }),
  }),
});

export const translationInputAudioBufferAppendEventSchema = z.object({
  type: z.literal('session.input_audio_buffer.append'),
  audio: z.string(),
});

export const translationClientEventSchema = z.discriminatedUnion('type', [
  translationSessionUpdateEventSchema,
  translationInputAudioBufferAppendEventSchema,
]);

export const translationOutputAudioDeltaEventSchema = z.object({
  type: z.literal('session.output_audio.delta'),
  delta: z.string(),
});

export const translationOutputAudioDoneEventSchema = z.object({
  type: z.literal('session.output_audio.done'),
});

export const translationOutputTranscriptDeltaEventSchema = z.object({
  type: z.literal('session.output_transcript.delta'),
  delta: z.string(),
});

export const translationOutputTranscriptDoneEventSchema = z.object({
  type: z.literal('session.output_transcript.done'),
});

export const translationInputTranscriptDeltaEventSchema = z.object({
  type: z.literal('session.input_transcript.delta'),
  delta: z.string(),
});

export const translationInputTranscriptDoneEventSchema = z.object({
  type: z.literal('session.input_transcript.done'),
});

export const translationErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().optional(),
    })
    .passthrough()
    .optional(),
  message: z.string().optional(),
});

export const translationKnownServerEventSchema = z.discriminatedUnion('type', [
  translationOutputAudioDeltaEventSchema,
  translationOutputAudioDoneEventSchema,
  translationOutputTranscriptDeltaEventSchema,
  translationOutputTranscriptDoneEventSchema,
  translationInputTranscriptDeltaEventSchema,
  translationInputTranscriptDoneEventSchema,
  translationErrorEventSchema,
]);

const knownTranslationServerEventTypes = new Set([
  'session.output_audio.delta',
  'session.output_audio.done',
  'session.output_transcript.delta',
  'session.output_transcript.done',
  'session.input_transcript.delta',
  'session.input_transcript.done',
  'error',
]);

export const translationUnknownServerEventSchema = z
  .object({
    type: z.string().refine((type) => !knownTranslationServerEventTypes.has(type)),
  })
  .passthrough();

export const translationServerEventSchema = z.union([
  translationKnownServerEventSchema,
  translationUnknownServerEventSchema,
]);

export type TranslationInputAudioTranscription = z.infer<
  typeof translationInputAudioTranscriptionSchema
>;
export type TranslationAudioFormat = z.infer<typeof translationAudioFormatSchema>;
export type TranslationSessionUpdateEvent = z.infer<typeof translationSessionUpdateEventSchema>;
export type TranslationInputAudioBufferAppendEvent = z.infer<
  typeof translationInputAudioBufferAppendEventSchema
>;
export type TranslationClientEvent = z.infer<typeof translationClientEventSchema>;
export type TranslationOutputAudioDeltaEvent = z.infer<
  typeof translationOutputAudioDeltaEventSchema
>;
export type TranslationOutputAudioDoneEvent = z.infer<typeof translationOutputAudioDoneEventSchema>;
export type TranslationOutputTranscriptDeltaEvent = z.infer<
  typeof translationOutputTranscriptDeltaEventSchema
>;
export type TranslationOutputTranscriptDoneEvent = z.infer<
  typeof translationOutputTranscriptDoneEventSchema
>;
export type TranslationInputTranscriptDeltaEvent = z.infer<
  typeof translationInputTranscriptDeltaEventSchema
>;
export type TranslationInputTranscriptDoneEvent = z.infer<
  typeof translationInputTranscriptDoneEventSchema
>;
export type TranslationErrorEvent = z.infer<typeof translationErrorEventSchema>;
export type TranslationServerEvent = z.infer<typeof translationServerEventSchema>;

export interface TranslationSessionLike {
  readonly events: AsyncIterable<TranslationServerEvent>;
  connect(): Promise<void>;
  sendEvent(event: TranslationClientEvent): void;
  close(): Promise<void>;
}

export interface TranslationSessionOptions {
  apiKey?: string;
  baseURL?: string;
  model: string;
  inputLanguage?: string;
  outputLanguage: string;
  inputAudioTranscription?: TranslationInputAudioTranscription | null;
  safetyIdentifier?: string;
}

export type TranslationSessionFactory = (
  options: TranslationSessionOptions,
) => TranslationSessionLike;

export function buildTranslationUrl({
  baseURL = DEFAULT_BASE_URL,
  model,
}: {
  baseURL?: string;
  model: string;
}): string {
  const url = new URL(baseURL);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }

  const path = url.pathname.replace(/\/$/, '');
  if (!path || path === '/v1') {
    url.pathname = `${path}/realtime/translations`;
  } else if (!path.endsWith('/realtime/translations')) {
    url.pathname = `${path}/realtime/translations`;
  }

  url.searchParams.set('model', model);
  return url.toString();
}

export function createSessionUpdateEvent(
  options: Pick<
    TranslationSessionOptions,
    'inputAudioTranscription' | 'inputLanguage' | 'model' | 'outputLanguage'
  >,
): TranslationSessionUpdateEvent {
  const format: TranslationAudioFormat = { type: 'audio/pcm', rate: SAMPLE_RATE };
  return {
    type: 'session.update',
    session: {
      audio: {
        input: {
          format,
          ...(options.inputLanguage ? { language: options.inputLanguage } : {}),
          ...(options.inputAudioTranscription !== undefined
            ? { transcription: options.inputAudioTranscription }
            : {}),
        },
        output: {
          format,
          language: options.outputLanguage,
        },
      },
    },
  };
}

export function parseTranslationServerEvent(data: string): TranslationServerEvent {
  return translationServerEventSchema.parse(JSON.parse(data));
}

export class TranslationSession implements TranslationSessionLike {
  readonly events = new AsyncIterableQueue<TranslationServerEvent>();
  #options: TranslationSessionOptions;
  #ws?: WebSocket;

  constructor(options: TranslationSessionOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.#ws) return;

    const apiKey = this.#options.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenAI API key is required, either using the argument or by setting OPENAI_API_KEY',
      );
    }

    const ws = new WebSocket(
      buildTranslationUrl({ baseURL: this.#options.baseURL, model: this.#options.model }),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(this.#options.safetyIdentifier
            ? { 'OpenAI-Safety-Identifier': this.#options.safetyIdentifier }
            : {}),
        },
      },
    );
    this.#ws = ws;

    ws.onmessage = (message: MessageEvent) => {
      const data =
        typeof message.data === 'string'
          ? message.data
          : Buffer.from(message.data as ArrayBuffer).toString();
      this.events.put(parseTranslationServerEvent(data));
    };
    ws.onclose = () => {
      this.events.close();
    };

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (error) => reject(new Error(error.message));
    });
  }

  sendEvent(event: TranslationClientEvent): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('OpenAI realtime translation session is not connected');
    }
    this.#ws.send(JSON.stringify(translationClientEventSchema.parse(event)));
  }

  async close(): Promise<void> {
    if (this.#ws && this.#ws.readyState < WebSocket.CLOSING) {
      this.#ws.close();
    }
    this.events.close();
  }
}
