// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import type { protos } from '@google-cloud/text-to-speech';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { TTSGender, TTSLanguage, TTSModel } from './models.js';

const NUM_CHANNELS = 1;
const DEFAULT_SAMPLE_RATE = 24000;

type GaxClientOptions = NonNullable<ConstructorParameters<typeof TextToSpeechClient>[0]>;
type SynthesizeSpeechRequest = protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest;
type StreamingSynthesizeRequest = protos.google.cloud.texttospeech.v1.IStreamingSynthesizeRequest;
type StreamingSynthesizeResponse = protos.google.cloud.texttospeech.v1.StreamingSynthesizeResponse;
type SynthesizeSpeechResponse = protos.google.cloud.texttospeech.v1.ISynthesizeSpeechResponse;
type VoiceSelectionParams = protos.google.cloud.texttospeech.v1.IVoiceSelectionParams;
type GoogleStreamingCall = ReturnType<TextToSpeechClient['streamingSynthesize']>;
type SynthesizeSpeechResult = [
  SynthesizeSpeechResponse,
  SynthesizeSpeechRequest | undefined,
  object | undefined,
];
type CancellablePromise<T> = Promise<T> & { cancel(): void };
type SynthesizeSpeechCallOptions = {
  timeout?: number;
  otherArgs?: {
    headers?: Record<string, string>;
  };
};
type CancellableSynthesizeSpeechCall = (
  request: SynthesizeSpeechRequest,
  options?: SynthesizeSpeechCallOptions,
) => CancellablePromise<SynthesizeSpeechResult>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration options for the Google Cloud TTS plugin. */
export interface TTSOptions {
  /** Model name (e.g. `journey`, `chirp-3-hd`). */
  modelName?: TTSModel | string;
  /** Voice name (e.g. `en-US-Standard-H`). */
  voiceName?: string;
  /** Language code (BCP-47, e.g. `en-US`). */
  language?: TTSLanguage | string;
  /**
   * Voice gender. Builds a Standard-tier voice name and overrides `voiceName`
   * when both are provided.
   */
  gender?: TTSGender;
  /** Output sample rate in Hz. Default: 24000. */
  sampleRate?: number;
  /**
   * Whether to use gRPC bidirectional streaming for `stream()`.
   * Set to `false` to prefer non-streaming REST synthesis.
   * Default: `true`.
   */
  streaming?: boolean;
  /**
   * Google Cloud service account credentials object.
   * Must include `client_email` and `private_key`.
   */
  credentials?: GaxClientOptions['credentials'];
  /**
   * Path to a Google Cloud service account JSON key file.
   * Falls back to `GOOGLE_APPLICATION_CREDENTIALS` environment variable.
   */
  keyFilename?: string;
}

interface ResolvedTTSOptions {
  modelName?: TTSModel | string;
  voiceName: string;
  language: TTSLanguage | string;
  sampleRate: number;
  streaming: boolean;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export class TTS extends tts.TTS {
  readonly label = 'google-cloud.TTS';
  #opts: ResolvedTTSOptions;
  #client: TextToSpeechClient;

  constructor(opts: TTSOptions = {}) {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const streaming = opts.streaming ?? true;

    super(sampleRate, NUM_CHANNELS, { streaming });

    this.#opts = {
      modelName: opts.modelName,
      voiceName: opts.voiceName ?? 'en-US-Standard-H',
      language: opts.language ?? 'en-US',
      sampleRate,
      streaming,
    };

    const gender = opts.gender;
    if (gender) {
      if (opts.voiceName) {
        log().warn(
          `Google Cloud TTS: gender '${gender}' overrides explicit voiceName '${opts.voiceName}'`,
        );
      }
      if (opts.modelName) {
        log().warn(
          `Google Cloud TTS: gender '${gender}' builds a Standard voice name that may not match modelName '${opts.modelName}'`,
        );
      }
      this.#opts.voiceName = buildVoiceName(this.#opts.language, gender);
    }

    const clientOptions: GaxClientOptions = {};
    if (opts.credentials) {
      clientOptions.credentials = opts.credentials;
    }
    if (opts.keyFilename) {
      clientOptions.keyFilename = opts.keyFilename;
    }

    this.#client = new TextToSpeechClient(clientOptions);
  }

  get model(): string {
    return this.#opts.modelName ?? this.#opts.voiceName;
  }

  get provider(): string {
    return 'google-cloud';
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(text, this, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    if (!this.capabilities.streaming) {
      throw new Error(
        'Google Cloud TTS streaming is disabled (`streaming: false`). Use synthesize() for REST synthesis.',
      );
    }
    return new SynthesizeStream(this, options?.connOptions);
  }

  /**
   * Update mutable TTS options without recreating the client.
   */
  updateOptions(opts: {
    modelName?: TTSModel | string;
    voiceName?: string;
    language?: TTSLanguage | string;
    gender?: TTSGender;
  }): void {
    if (opts.modelName !== undefined) this.#opts.modelName = opts.modelName;
    if (opts.voiceName !== undefined) this.#opts.voiceName = opts.voiceName;
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.gender !== undefined) {
      if (opts.voiceName !== undefined) {
        log().warn(
          `Google Cloud TTS: gender '${opts.gender}' overrides explicit voiceName '${opts.voiceName}'`,
        );
      }
      if (this.#opts.modelName) {
        log().warn(
          `Google Cloud TTS: gender '${opts.gender}' builds a Standard voice name that may not match modelName '${this.#opts.modelName}'`,
        );
      }
      this.#opts.voiceName = buildVoiceName(this.#opts.language, opts.gender);
    }
  }

  get opts() {
    return this.#opts;
  }

  get client() {
    return this.#client;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

// ---------------------------------------------------------------------------
// Streaming synthesis
// ---------------------------------------------------------------------------

export class SynthesizeStream extends tts.SynthesizeStream {
  readonly label = 'google-cloud.SynthesizeStream';
  #tts: TTS;

  constructor(ttsProvider: TTS, connOptions?: APIConnectOptions) {
    super(ttsProvider, connOptions);
    this.#tts = ttsProvider;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const call = this.#tts.client.streamingSynthesize();
    let tokenizer: tokenize.SentenceStream | undefined;
    let tasks: Promise<void>[] | undefined;
    const abort = () => {
      try {
        call.cancel();
      } catch {
        call.destroy();
      }
    };

    this.abortSignal.addEventListener('abort', abort, { once: true });

    try {
      await writeStreamingRequest(call, {
        streamingConfig: {
          voice: buildVoiceSelectionParams(this.#tts.opts),
          streamingAudioConfig: {
            audioEncoding: 1 /* PCM */,
            sampleRateHertz: this.#tts.opts.sampleRate,
          },
        },
      });

      tokenizer = new tokenize.basic.SentenceTokenizer().stream();
      tasks = [
        this.#tokenizeInput(tokenizer),
        this.#sendText(call, tokenizer),
        this.#receiveAudio(call, requestId),
      ];

      await Promise.all(tasks);
    } catch (error: unknown) {
      tokenizer?.close();
      if (tasks) {
        destroyStreamingCall(call, error);
        if (!this.input.closed) {
          this.input.close();
        }
        await Promise.allSettled(tasks);
      } else {
        call.destroy();
      }

      if (this.abortSignal.aborted) {
        return;
      }

      if (error instanceof APIError) {
        throw error;
      }

      throw toLiveKitTtsError(error);
    } finally {
      this.abortSignal.removeEventListener('abort', abort);
      tokenizer?.close();
      call.destroy();
    }
  }

  async #tokenizeInput(tokenizer: tokenize.SentenceStream): Promise<void> {
    try {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          tokenizer.flush();
          continue;
        }

        tokenizer.pushText(data);
      }

      tokenizer.endInput();
    } catch {
      // Stream shutdown can close tokenizer/input concurrently.
    }
  }

  async #sendText(call: GoogleStreamingCall, tokenizer: tokenize.SentenceStream): Promise<void> {
    for await (const event of tokenizer) {
      if (this.abortSignal.aborted) {
        break;
      }

      await writeStreamingRequest(call, {
        input: {
          text: event.token,
        },
      });
    }

    call.end();
  }

  async #receiveAudio(call: GoogleStreamingCall, requestId: string): Promise<void> {
    const bstream = new AudioByteStream(this.#tts.sampleRate, this.#tts.numChannels);
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame || this.queue.closed) {
        return;
      }

      this.queue.put({
        requestId,
        segmentId: requestId,
        frame: lastFrame,
        final,
      });
      lastFrame = undefined;
    };

    await new Promise<void>((resolve, reject) => {
      let errored = false;

      call.on('data', (response: StreamingSynthesizeResponse) => {
        const audioContent = response.audioContent;
        if (!audioContent) {
          return;
        }

        const audioBuffer =
          typeof audioContent === 'string'
            ? Buffer.from(audioContent, 'base64')
            : Buffer.from(audioContent);

        const audioData = extractArrayBuffer(audioBuffer);
        for (const frame of bstream.write(audioData)) {
          sendLastFrame(false);
          lastFrame = frame;
        }
      });

      call.once('end', () => {
        if (errored) {
          return;
        }

        for (const frame of bstream.flush()) {
          sendLastFrame(false);
          lastFrame = frame;
        }
        sendLastFrame(true);

        if (!this.queue.closed) {
          this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
        }
        resolve();
      });

      call.once('error', (error) => {
        errored = true;
        reject(error);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Non-streaming (one-shot) synthesis
// ---------------------------------------------------------------------------

export class ChunkedStream extends tts.ChunkedStream {
  readonly label = 'google-cloud.ChunkedStream';
  #tts: TTS;
  #connOptions: APIConnectOptions;

  constructor(
    inputText: string,
    ttsProvider: TTS,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ) {
    super(inputText, ttsProvider, connOptions, abortSignal);
    this.#tts = ttsProvider;
    this.#connOptions = connOptions;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const request: SynthesizeSpeechRequest = {
      input: {
        text: this.inputText,
      },
      voice: buildVoiceSelectionParams(this.#tts.opts),
      audioConfig: {
        audioEncoding: 1 /* LINEAR16 */,
        sampleRateHertz: this.#tts.opts.sampleRate,
      },
    };

    try {
      const [response] = await synthesizeSpeechWithAbort(
        this.#tts.client,
        request,
        {
          timeout: this.#connOptions.timeoutMs,
          otherArgs: {
            headers: {
              'x-goog-request-params': `voice.language_code=${encodeURIComponent(
                this.#tts.opts.language,
              )}`,
            },
          },
        },
        this.abortSignal,
      );

      if (this.abortSignal.aborted) {
        return;
      }

      const audioContent = response.audioContent;
      if (!audioContent) {
        throw new APIConnectionError({
          message: 'Google Cloud TTS returned empty audio',
          options: { retryable: true },
        });
      }

      const audioBuffer =
        typeof audioContent === 'string'
          ? Buffer.from(audioContent, 'base64')
          : Buffer.from(audioContent);

      const pcmAudio = extractLinear16Pcm(audioBuffer);
      const bstream = new AudioByteStream(this.#tts.sampleRate, this.#tts.numChannels);
      const frames = [...bstream.write(extractArrayBuffer(pcmAudio)), ...bstream.flush()];

      if (frames.length === 0) {
        throw new APIConnectionError({
          message: 'Google Cloud TTS returned audio but no playable PCM frames',
          options: { retryable: true },
        });
      }

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (final: boolean) => {
        if (!lastFrame) {
          return;
        }

        this.queue.put({
          requestId,
          segmentId: requestId,
          frame: lastFrame,
          final,
        });
        lastFrame = undefined;
      };

      for (const frame of frames) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
    } catch (error: unknown) {
      if (this.abortSignal.aborted || isAbortError(error)) {
        return;
      }

      if (error instanceof APIError) {
        throw error;
      }

      throw toLiveKitTtsError(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildVoiceName(language: string, gender: TTSGender): string {
  // Map gender to the Standard voice suffix
  const suffix = gender === 'male' ? 'B' : gender === 'female' ? 'C' : 'A';
  return `${language}-Standard-${suffix}`;
}

function buildVoiceSelectionParams(opts: ResolvedTTSOptions): VoiceSelectionParams {
  const voice: VoiceSelectionParams = {
    languageCode: opts.language,
    name: opts.voiceName,
  };

  if (opts.modelName !== undefined) {
    voice.modelName = opts.modelName;
  }

  return voice;
}

async function writeStreamingRequest(
  call: GoogleStreamingCall,
  request: StreamingSynthesizeRequest,
): Promise<void> {
  if (call.write(request)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      call.off('drain', onDrain);
      call.off('error', onError);
      call.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(
        new APIConnectionError({
          message: 'Google Cloud TTS stream closed while waiting for drain',
          options: { retryable: true },
        }),
      );
    };

    call.once('drain', onDrain);
    call.once('error', onError);
    call.once('close', onClose);
  });
}

function destroyStreamingCall(call: GoogleStreamingCall, error: unknown): void {
  const streamError =
    error instanceof Error ? error : new Error('Google Cloud TTS streaming request failed');

  call.on('error', () => {});
  call.destroy(streamError);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function synthesizeSpeechWithAbort(
  client: TextToSpeechClient,
  request: SynthesizeSpeechRequest,
  options: SynthesizeSpeechCallOptions,
  abortSignal: AbortSignal,
): Promise<SynthesizeSpeechResult> {
  const synthesizeSpeech = client.innerApiCalls.synthesizeSpeech as CancellableSynthesizeSpeechCall;
  const call = synthesizeSpeech(request, options);
  const abort = () => {
    call.cancel();
  };

  abortSignal.addEventListener('abort', abort, { once: true });
  if (abortSignal.aborted) {
    call.cancel();
  }

  try {
    return await call;
  } finally {
    abortSignal.removeEventListener('abort', abort);
  }
}

function extractArrayBuffer(buf: Buffer): ArrayBuffer {
  return new Uint8Array(buf).buffer as ArrayBuffer;
}

function extractLinear16Pcm(audioBuffer: Buffer): Buffer {
  if (
    audioBuffer.length < 12 ||
    audioBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
    audioBuffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return audioBuffer;
  }

  let offset = 12;
  while (offset + 8 <= audioBuffer.length) {
    const chunkId = audioBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = audioBuffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;

    if (dataEnd > audioBuffer.length) {
      break;
    }

    if (chunkId === 'data') {
      return audioBuffer.subarray(dataStart, dataEnd);
    }

    offset = dataEnd + (chunkSize % 2);
  }

  throw new APIConnectionError({
    message: 'Google Cloud TTS returned LINEAR16 audio without a WAV data chunk',
    options: { retryable: true },
  });
}

function toLiveKitTtsError(error: unknown): Error {
  if (error instanceof APIError) {
    return error;
  }

  const maybeGoogleError = error as {
    code?: number;
    message?: string;
    details?: string;
  };

  if (typeof maybeGoogleError.code === 'number') {
    // Google returns gRPC status codes here (0-16), not HTTP status codes.
    // Retryability is set explicitly so APIStatusError's HTTP 4xx heuristic
    // does not classify these provider errors for us.
    const retryable =
      maybeGoogleError.code === 4 ||
      maybeGoogleError.code === 8 ||
      maybeGoogleError.code === 10 ||
      maybeGoogleError.code === 13 ||
      maybeGoogleError.code === 14;

    return new APIStatusError({
      message: `Google Cloud TTS error (${maybeGoogleError.code}): ${
        maybeGoogleError.message ?? maybeGoogleError.details ?? 'unknown error'
      }`,
      options: {
        statusCode: maybeGoogleError.code,
        retryable,
      },
    });
  }

  return new APIConnectionError({
    message: `Google Cloud TTS connection error: ${
      error instanceof Error ? error.message : 'unknown error'
    }`,
    options: { retryable: true },
  });
}
