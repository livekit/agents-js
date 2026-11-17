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
import { RivaConnection, toAPIConnectionError } from './connection.js';
import { log } from './log.js';
import {
  type ModelConfigResponse,
  RivaSpeechSynthesis,
  type RivaSpeechSynthesisClient,
  type SynthesizeSpeechResponse,
} from './proto.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Leo';
const NUM_CHANNELS = 1;

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
}

const defaultTTSOptions: TTSOptions = {
  voice: DEFAULT_VOICE,
  functionId: DEFAULT_FUNCTION_ID,
  languageCode: 'en-US',
  sampleRate: 16000,
  server: DEFAULT_SERVER,
  useSsl: true,
};

const connections = new WeakMap<TTS, RivaConnection<RivaSpeechSynthesisClient>>();

/** Streaming text-to-speech backed by NVIDIA Riva. */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'nvidia.TTS';

  get model(): string {
    return this.#opts.voice;
  }

  get provider(): string {
    return 'NVIDIA';
  }

  /**
   * Create a Riva TTS client.
   *
   * @throws Error when `useSsl` is true and no API key is available.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = {
      ...defaultTTSOptions,
      ...opts,
      apiKey: opts.apiKey || process.env.NVIDIA_API_KEY,
    };
    super(resolvedOpts.sampleRate, NUM_CHANNELS, { streaming: true });
    connections.set(this, new RivaConnection(resolvedOpts, RivaSpeechSynthesis));
    this.#opts = resolvedOpts;
  }

  /** Synthesize complete text, one Riva request per sentence. */
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
        const language = config.parameters['language_code'] ?? 'unknown';
        const voice = config.parameters['voice_name'] ?? 'unknown';
        const subvoices = config.parameters['subvoices'];
        const voices = subvoices
          ? subvoices.split(',').map((item) => `${voice}.${item.split(':')[0]}`)
          : [voice];
        (result[language] ??= { voices: [] }).voices.push(...voices);
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
        if (data === SynthesizeStream.FLUSH_SENTINEL) tokenizer.flush();
        else tokenizer.pushText(data);
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
      const [, error] = await Promise.all(tasks);
      output.end();
      if (error && !this.abortSignal.aborted) {
        // The stream already consumed its input, so a retry would have no text to send.
        throw new APIConnectionError({ message: error.message, options: { retryable: false } });
      }
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    } finally {
      attempt.abort();
      tokenizer.close();
      await Promise.allSettled(tasks);
    }
  }
}

/**
 * Synthesizes complete text, one Riva request per sentence. Like the stream, a failed sentence is
 * logged and skipped; the request fails only when no audio was produced, so a retry replays
 * nothing the caller already received.
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
      const error = await synthesizeSentences(
        new tokenize.blingfire.SentenceTokenizer().tokenize(this.inputText),
        {
          client,
          metadata: this.#connection.metadata,
          opts: this.#opts,
          output,
          stopSignal: this.abortSignal,
          callSignal: this.abortSignal,
        },
      );
      output.end();
      // Nothing reached the caller, so the error's own status decides whether to retry.
      if (error && !this.abortSignal.aborted) throw error;
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
 * Synthesize sentences in order, one Riva request each. A failed sentence is logged and skipped,
 * matching the Python plugin. Returns the last failure only when no audio was produced, so the
 * caller decides whether the request fails.
 */
async function synthesizeSentences(
  sentences: AsyncIterable<string> | Iterable<string>,
  ctx: SentenceContext,
): Promise<APIConnectionError | undefined> {
  let failure: APIConnectionError | undefined;
  for await (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (ctx.stopSignal.aborted) break;
    ctx.onSentence?.();
    try {
      await synthesizeSentence(
        ctx.client,
        ctx.metadata,
        ctx.opts,
        sentence,
        ctx.callSignal,
        (chunk) => ctx.output.write(chunk),
      );
    } catch (error) {
      if (!(error instanceof APIConnectionError)) throw error;
      failure = error;
      log().error({ error }, 'NVIDIA TTS sentence failed');
    }
  }
  return ctx.output.wroteAudio ? undefined : failure;
}

/** Synthesize one sentence, forwarding its PCM chunks until the call ends. */
async function synthesizeSentence(
  client: RivaSpeechSynthesisClient,
  metadata: grpc.Metadata,
  opts: TTSOptions,
  text: string,
  signal: AbortSignal,
  onAudio: (audio: Buffer) => void,
): Promise<void> {
  const call = client.SynthesizeOnline(
    {
      text,
      languageCode: opts.languageCode,
      encoding: 'LINEAR_PCM',
      sampleRateHz: opts.sampleRate,
      voiceName: opts.voice,
    },
    metadata,
  );
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
        else reject(toAPIConnectionError(error, 'NVIDIA TTS failed'));
      });
    });
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
