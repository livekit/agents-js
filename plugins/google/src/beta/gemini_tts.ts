// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  isAPIError,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

export type GeminiTTSModels = 'gemini-2.5-flash-preview-tts' | 'gemini-2.5-pro-preview-tts';

export type GeminiVoices =
  | 'Zephyr'
  | 'Puck'
  | 'Charon'
  | 'Kore'
  | 'Fenrir'
  | 'Leda'
  | 'Orus'
  | 'Aoede'
  | 'Callirrhoe'
  | 'Autonoe'
  | 'Enceladus'
  | 'Iapetus'
  | 'Umbriel'
  | 'Algieba'
  | 'Despina'
  | 'Erinome'
  | 'Algenib'
  | 'Rasalgethi'
  | 'Laomedeia'
  | 'Achernar'
  | 'Alnilam'
  | 'Schedar'
  | 'Gacrux'
  | 'Pulcherrima'
  | 'Achird'
  | 'Zubenelgenubi'
  | 'Vindemiatrix'
  | 'Sadachbia'
  | 'Sadaltager'
  | 'Sulafat';

const DEFAULT_MODEL: GeminiTTSModels = 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE: GeminiVoices = 'Kore';
const DEFAULT_SAMPLE_RATE = 24000; // not configurable
const NUM_CHANNELS = 1;
const DEFAULT_INSTRUCTIONS = "Say the text with a proper tone, don't omit or add any words";

export interface TTSOptions {
  model: GeminiTTSModels | string;
  voiceName: GeminiVoices | string;
  vertexai: boolean;
  project?: string;
  location?: string;
  instructions?: string;
}

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #client: GoogleGenAI;
  label = 'google.gemini.TTS';

  /**
   * Create a new instance of Gemini TTS.
   *
   * Environment Requirements:
   * - For VertexAI: Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of the service account key file.
   * - For Google Gemini API: Set the `apiKey` argument or the `GOOGLE_API_KEY` environment variable.
   *
   * @param opts - Configuration options for Gemini TTS
   */
  constructor({
    model = DEFAULT_MODEL,
    voiceName = DEFAULT_VOICE,
    apiKey,
    vertexai,
    project,
    location,
    instructions,
  }: Partial<TTSOptions & { apiKey: string }> = {}) {
    super(DEFAULT_SAMPLE_RATE, NUM_CHANNELS, { streaming: false });

    const gcpProject: string | undefined = project || process.env.GOOGLE_CLOUD_PROJECT;
    const gcpLocation: string | undefined =
      location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const useVertexai = vertexai ?? process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
    const geminiApiKey = apiKey || process.env.GOOGLE_API_KEY;

    let finalProject: string | undefined = gcpProject;
    let finalLocation: string | undefined = gcpLocation;
    let finalApiKey: string | undefined = geminiApiKey;

    if (useVertexai) {
      if (!finalProject) {
        throw new APIConnectionError({
          message:
            'Project ID is required for Vertex AI. Set via project option or GOOGLE_CLOUD_PROJECT environment variable',
        });
      }
      finalApiKey = undefined;
    } else {
      finalProject = undefined;
      finalLocation = undefined;
      if (!finalApiKey) {
        throw new APIConnectionError({
          message:
            'API key is required for Google API either via apiKey or GOOGLE_API_KEY environment variable',
        });
      }
    }

    this.#opts = {
      model,
      voiceName,
      vertexai: useVertexai,
      project: finalProject,
      location: finalLocation,
      instructions: instructions ?? DEFAULT_INSTRUCTIONS,
    };

    const clientOptions: types.GoogleGenAIOptions = useVertexai
      ? {
          vertexai: true,
          project: finalProject,
          location: finalLocation,
        }
      : {
          apiKey: finalApiKey,
        };

    this.#client = new GoogleGenAI(clientOptions);
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(text, this, connOptions, abortSignal);
  }

  /**
   * Update the TTS options.
   *
   * @param opts - Options to update
   */
  updateOptions(opts: { voiceName?: GeminiVoices | string }) {
    if (opts.voiceName !== undefined) {
      this.#opts.voiceName = opts.voiceName;
    }
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Gemini TTS');
  }

  get opts(): TTSOptions {
    return this.#opts;
  }

  get client(): GoogleGenAI {
    return this.#client;
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  #tts: TTS;
  label = 'google.gemini.ChunkedStream';

  constructor(
    inputText: string,
    tts: TTS,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(inputText, tts, connOptions, abortSignal);
    this.#tts = tts;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#tts.sampleRate, this.#tts.numChannels);

    const config: types.GenerateContentConfig = {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.#tts.opts.voiceName,
          },
        },
      },
      abortSignal: this.abortSignal,
    };

    let inputText = this.inputText;
    if (this.#tts.opts.instructions) {
      inputText = `${this.#tts.opts.instructions}:\n"${inputText}"`;
    }

    const contents: types.Content[] = [
      {
        role: 'user',
        parts: [{ text: inputText }],
      },
    ];

    const responseStream = await this.#tts.client.models.generateContentStream({
      model: this.#tts.opts.model,
      contents,
      config,
    });

    try {
      for await (const response of responseStream) {
        await this.#processResponse(response, bstream, requestId);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      if (isAPIError(error)) throw error;

      const err = error as {
        code?: number;
        message?: string;
        status?: string;
        type?: string;
      };

      if (err.code && err.code >= 400 && err.code < 500) {
        if (err.code === 429) {
          throw new APIStatusError({
            message: `Gemini TTS: Rate limit error - ${err.message || 'Unknown error'}`,
            options: {
              statusCode: 429,
              retryable: true,
            },
          });
        } else {
          throw new APIStatusError({
            message: `Gemini TTS: Client error (${err.code}) - ${err.message || 'Unknown error'}`,
            options: {
              statusCode: err.code,
              retryable: false,
            },
          });
        }
      }

      if (err.code && err.code >= 500) {
        throw new APIStatusError({
          message: `Gemini TTS: Server error (${err.code}) - ${err.message || 'Unknown error'}`,
          options: {
            statusCode: err.code,
            retryable: true,
          },
        });
      }

      throw new APIConnectionError({
        message: `Gemini TTS: Connection error - ${err.message || 'Unknown error'}`,
        options: { retryable: true },
      });
    } finally {
      this.queue.close();
    }
  }

  async #processResponse(
    response: types.GenerateContentResponse,
    bstream: AudioByteStream,
    requestId: string,
  ) {
    if (!response.candidates || response.candidates.length === 0) {
      return;
    }

    const candidate = response.candidates[0];
    if (!candidate || !candidate.content?.parts) {
      return;
    }

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (final: boolean) => {
      if (lastFrame) {
        this.queue.put({
          requestId,
          frame: lastFrame,
          segmentId: requestId,
          final,
        });
        lastFrame = undefined;
      }
    };

    for (const part of candidate.content.parts) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
        const audioBuffer = Buffer.from(part.inlineData.data, 'base64');

        for (const frame of bstream.write(audioBuffer)) {
          sendLastFrame(false);
          lastFrame = frame;
        }
      }
    }

    for (const frame of bstream.flush()) {
      sendLastFrame(false);
      lastFrame = frame;
    }

    sendLastFrame(true);
  }
}
