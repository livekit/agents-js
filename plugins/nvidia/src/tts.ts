// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as grpc from '@grpc/grpc-js';
import {
  type APIConnectOptions,
  APIConnectionError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { readFileSync } from 'node:fs';
import { RivaConnection, toAPIError } from './connection.js';
import {
  type ModelConfigResponse,
  RivaSpeechSynthesis,
  type RivaSpeechSynthesisClient,
  type SynthesizeSpeechRequest,
  type SynthesizeSpeechResponse,
} from './proto.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Leo';
const NUM_CHANNELS = 1;

export type TTSInferenceMode = 'online' | 'offline';

/** Additional NVIDIA Speech synthesis request fields. */
export interface TTSProviderOptions {
  customDictionary?: string;
  customConfiguration?: Record<string, string>;
  enableWordTimeOffsets?: boolean;
}

/** Options for NVIDIA Riva text-to-speech. */
export interface TTSOptions {
  /** NVIDIA API key. Defaults to `NVIDIA_API_KEY`; required when `useSsl` is true. */
  apiKey?: string;
  /** Riva voice name, such as `Magpie-Multilingual.EN-US.Leo`. */
  voice: string;
  /** NVIDIA Cloud Functions ID sent as the `function-id` metadata. */
  functionId: string;
  /** BCP-47 language code, such as `en-US`. */
  languageCode: string;
  /** Sample rate of the synthesized audio, in Hz. */
  sampleRate: number;
  /** Riva gRPC server address as `host:port`. */
  server: string;
  /** Whether to connect with TLS. Disable for a locally hosted Riva NIM service. */
  useSsl: boolean;
  /** WAV reference audio for zero-shot synthesis. */
  audioPromptFile?: string;
  /** Zero-shot decoder quality from 1 to 40. */
  quality?: number;
  options: TTSProviderOptions;
  inferenceMode: TTSInferenceMode;
}

const defaultTTSOptions: TTSOptions = {
  voice: DEFAULT_VOICE,
  functionId: DEFAULT_FUNCTION_ID,
  languageCode: 'en-US',
  sampleRate: 16000,
  server: DEFAULT_SERVER,
  useSsl: true,
  options: {},
  inferenceMode: 'online',
};

const connections = new WeakMap<TTS, RivaConnection<RivaSpeechSynthesisClient>>();

/** Streaming text-to-speech backed by NVIDIA Riva. */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'nvidia.TTS';

  get model(): string {
    return this.#opts.voice.split('.', 1)[0]!;
  }

  get provider(): string {
    return 'NVIDIA Speech';
  }

  /**
   * Create a Riva TTS client.
   *
   * @throws Error when `useSsl` is true and no API key is available.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts: TTSOptions = {
      ...defaultTTSOptions,
      ...opts,
      options: { ...defaultTTSOptions.options, ...opts.options },
      apiKey: opts.apiKey || process.env.NVIDIA_API_KEY,
    };
    if (!['online', 'offline'].includes(resolvedOpts.inferenceMode)) {
      throw new Error("inferenceMode must be either 'online' or 'offline'");
    }
    super(resolvedOpts.sampleRate, NUM_CHANNELS, { streaming: true });
    connections.set(this, new RivaConnection(resolvedOpts, RivaSpeechSynthesis));
    this.#opts = resolvedOpts;
  }

  /** Synthesize complete text in one NVIDIA Speech request. */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, { ...this.#opts }, connOptions, abortSignal);
  }

  /** Open a stream that synthesizes each sentence of the pushed text. */
  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
  }

  /** List the server's voices, grouped by language code. */
  async listVoices(): Promise<Record<string, { voices: string[] }>> {
    const session = connections.get(this)!;
    const client = await session.pool.get();
    try {
      const response = await new Promise<ModelConfigResponse>((resolve, reject) => {
        client.GetRivaSynthesisConfig({}, session.metadata, (error, value) =>
          error ? reject(error) : resolve(value),
        );
      });
      const result: Record<string, { voices: string[] }> = {};
      for (const config of response.modelConfig) {
        const languages =
          config.parameters['language_code']
            ?.split(',')
            .map((language) => language.trim())
            .filter(Boolean) ?? [];
        const voice = config.parameters['voice_name'] ?? 'unknown';
        const subvoices = config.parameters['subvoices'];
        const voices = subvoices
          ? subvoices.split(',').map((item) => `${voice}.${item.split(':')[0]}`)
          : [voice];
        for (const language of languages.length ? languages : ['unknown']) {
          const existing = (result[language] ??= { voices: [] }).voices;
          for (const item of voices) if (!existing.includes(item)) existing.push(item);
        }
      }
      return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
    } finally {
      session.pool.put(client);
    }
  }

  /** Release idle channels and retire in-flight channels when their streams finish. */
  override async releaseIdleConnections(): Promise<void> {
    await connections.get(this)!.pool.releaseIdle();
  }

  /** Close all provider channels after its streams have finished. */
  override async close(): Promise<void> {
    await connections.get(this)!.pool.close();
    await super.close();
  }
}

/**
 * Synthesizes sentences in one logical audio segment. Flush sends pending text without
 * ending the segment; endInput ends it, matching the Python Riva plugin.
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #connection: RivaConnection<RivaSpeechSynthesisClient>;
  label = 'nvidia.SynthesizeStream';

  constructor(instance: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(instance, connOptions);
    this.#opts = opts;
    this.#connection = connections.get(instance)!;
    // Commit pending metric text before the metrics task observes cancellation.
    this.abortSignal.addEventListener('abort', () => super.flush(), { once: true });
  }

  /** Send buffered text while retaining the stream's logical audio segment. */
  override flush(): void {
    if (!this.input.closed && !this.closed) this.input.put(SynthesizeStream.FLUSH_SENTINEL);
  }

  override endInput(): void {
    if (this.input.closed || this.closed) return;
    super.flush();
    this.input.close();
  }

  protected override onStreamDone(): void {
    super.flush();
  }

  protected async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
    const client = await this.#connection.pool.get(this.connOptions.timeoutMs);
    try {
      await this.#run(client);
    } finally {
      this.#connection.pool.put(client);
    }
  }

  async #run(client: RivaSpeechSynthesisClient): Promise<void> {
    const tokenizer = new tokenize.blingfire.SentenceTokenizer().stream();
    const output = new SegmentWriter(this.#opts.sampleRate, (audio) => this.queue.put(audio));

    const attempt = new AbortController();
    const inputTask = async () => {
      while (true) {
        const item = await this.input.next({ signal: attempt.signal });
        if (item.done) break;
        const data = item.value;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          tokenizer.flush();
          break;
        }
        tokenizer.pushText(data);
      }
      tokenizer.endInput();
    };
    const sentences = async function* () {
      for await (const event of tokenizer) yield event.token;
    };
    const synthesizeTask = synthesizeSentences(sentences(), {
      client,
      metadata: this.#connection.metadata,
      opts: this.#opts,
      output,
      // Text still buffered when the stream closes must not start new requests.
      stopSignal: this.abortSignal,
      callSignal: AbortSignal.any([this.abortSignal, attempt.signal]),
      onSentence: () => this.markStarted(),
    });

    const tasks = [inputTask(), synthesizeTask] as const;
    try {
      try {
        await Promise.all(tasks);
      } catch (error) {
        output.end();
        if (error instanceof Error && !this.abortSignal.aborted) {
          throw new APIConnectionError({ message: error.message, options: { retryable: false } });
        }
        throw error;
      }
      output.end();
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    } finally {
      attempt.abort();
      tokenizer.close();
      await Promise.allSettled(tasks);
    }
  }
}

/**
 * Synthesizes complete text in one NVIDIA Speech request.
 */
export class ChunkedStream extends tts.ChunkedStream {
  #opts: TTSOptions;
  #connection: RivaConnection<RivaSpeechSynthesisClient>;
  #connOptions: APIConnectOptions;
  label = 'nvidia.ChunkedStream';

  constructor(
    instance: TTS,
    text: string,
    opts: TTSOptions,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ) {
    super(text, instance, connOptions, abortSignal);
    this.#opts = opts;
    this.#connection = connections.get(instance)!;
    this.#connOptions = connOptions;
    // The base class only listens for a later abort, so honor one that already happened.
    if (abortSignal?.aborted) this.close();
  }

  protected async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
    const client = await this.#connection.pool.get(this.#connOptions.timeoutMs);
    try {
      const output = new SegmentWriter(this.#opts.sampleRate, (audio) => this.queue.put(audio));
      await synthesizeRequest(
        client,
        this.#connection.metadata,
        this.#opts,
        this.inputText,
        this.abortSignal,
        (chunk) => output.write(chunk),
      );
      output.end();
    } finally {
      this.#connection.pool.put(client);
    }
  }
}

/**
 * Splits PCM into frames of one segment, holding back the newest frame so the segment's last
 * frame can be marked final.
 */
class SegmentWriter {
  #audio: AudioByteStream;
  #requestId = shortuuid();
  #lastFrame: AudioFrame | undefined;
  #put: (audio: tts.SynthesizedAudio) => void;
  /** Whether any provider audio has been written to this segment. */
  wroteAudio = false;

  constructor(sampleRate: number, put: (audio: tts.SynthesizedAudio) => void) {
    this.#audio = new AudioByteStream(sampleRate, NUM_CHANNELS);
    this.#put = put;
  }

  write(chunk: Buffer): void {
    this.wroteAudio = true;
    this.#push(this.#audio.write(chunk));
  }

  end(): void {
    this.#push(this.#audio.flush());
    this.#send(true);
  }

  #push(frames: AudioFrame[]): void {
    for (const frame of frames) {
      this.#send(false);
      this.#lastFrame = frame;
    }
  }

  #send(final: boolean): void {
    if (!this.#lastFrame) return;
    const requestId = this.#requestId;
    this.#put({ requestId, segmentId: requestId, frame: this.#lastFrame, final });
    this.#lastFrame = undefined;
  }
}

/** Shared state for synthesizing a sequence of sentences into one segment. */
interface SentenceContext {
  client: RivaSpeechSynthesisClient;
  metadata: grpc.Metadata;
  opts: TTSOptions;
  output: SegmentWriter;
  /** Once aborted, no further sentence starts. */
  stopSignal: AbortSignal;
  /** Cancels the in-flight Riva call. */
  callSignal: AbortSignal;
  /** Called before each sentence request starts. */
  onSentence?: () => void;
}

/**
 * Synthesize sentences in order, stopping on the first provider failure.
 */
async function synthesizeSentences(
  sentences: AsyncIterable<string> | Iterable<string>,
  ctx: SentenceContext,
): Promise<void> {
  for await (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (ctx.stopSignal.aborted) break;
    ctx.onSentence?.();
    await synthesizeRequest(ctx.client, ctx.metadata, ctx.opts, sentence, ctx.callSignal, (chunk) =>
      ctx.output.write(chunk),
    );
  }
}

/** Synthesize one request, forwarding its PCM chunks until the call ends. */
async function synthesizeRequest(
  client: RivaSpeechSynthesisClient,
  metadata: grpc.Metadata,
  opts: TTSOptions,
  text: string,
  signal: AbortSignal,
  onAudio: (audio: Buffer) => void,
): Promise<void> {
  const request = synthesisRequest(text.trimStart().trim(), opts);
  if (signal.aborted) return;
  if (opts.inferenceMode === 'offline') {
    await new Promise<void>((resolve, reject) => {
      let cancel = () => {};
      const call = client.Synthesize(request, metadata, {}, (error, response) => {
        signal.removeEventListener('abort', cancel);
        if (error) reject(toAPIError(error, 'NVIDIA Speech offline TTS'));
        else {
          if (!signal.aborted && response.audio.length > 0) onAudio(response.audio);
          resolve();
        }
      });
      cancel = () => call.cancel();
      signal.addEventListener('abort', cancel, { once: true });
    });
    return;
  }

  const call = client.SynthesizeOnline(request, metadata);
  const cancel = () => call.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      call.on('data', (response: SynthesizeSpeechResponse) => {
        if (!signal.aborted && response.audio.length > 0) onAudio(response.audio);
      });
      call.on('end', resolve);
      call.on('error', (error: grpc.ServiceError) => {
        if (signal.aborted) resolve();
        else reject(toAPIError(error, 'NVIDIA Speech online TTS'));
      });
    });
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function synthesisRequest(text: string, opts: TTSOptions): SynthesizeSpeechRequest {
  return {
    text,
    languageCode: opts.languageCode,
    encoding: 'LINEAR_PCM',
    sampleRateHz: opts.sampleRate,
    voiceName: opts.voice,
    ...(opts.audioPromptFile && { zeroShotData: wavPrompt(opts.audioPromptFile, opts.quality) }),
    ...(opts.options.customDictionary && { customDictionary: opts.options.customDictionary }),
    ...(opts.options.customConfiguration && {
      customConfiguration: opts.options.customConfiguration,
    }),
    ...(opts.options.enableWordTimeOffsets !== undefined && {
      enableWordTimeOffsets: opts.options.enableWordTimeOffsets,
    }),
  };
}

function wavPrompt(
  path: string,
  quality = 20,
): NonNullable<SynthesizeSpeechRequest['zeroShotData']> {
  const wav = readFileSync(path);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('audioPromptFile must be a WAV file');
  }
  let offset = 12;
  let sampleRate = 0;
  let audio: Buffer | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      if (wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1) {
        throw new Error('audioPromptFile must contain mono LINEAR_PCM audio');
      }
      sampleRate = wav.readUInt32LE(start + 4);
      if (wav.readUInt16LE(start + 14) !== 16) {
        throw new Error('audioPromptFile must contain 16-bit LINEAR_PCM audio');
      }
    } else if (id === 'data') {
      audio = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !audio) throw new Error('audioPromptFile is missing WAV audio data');
  return { audioPrompt: audio, sampleRateHz: sampleRate, encoding: 'LINEAR_PCM', quality };
}
