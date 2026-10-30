// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  AudioByteStream,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { RivaConnection } from './connection.js';
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

  /** Not supported: Riva synthesis is streaming only. Use {@link TTS.stream}. */
  synthesize(_text: string, _connOptions?: APIConnectOptions): tts.ChunkedStream {
    throw new Error('Chunked synthesis is not supported by NVIDIA TTS');
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
    const requestId = shortuuid();
    const audio = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    let receivedAudio = false;
    let synthesisError: APIConnectionError | undefined;
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame) return;
      this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
      lastFrame = undefined;
    };
    const pushFrames = (frames: AudioFrame[]) => {
      for (const frame of frames) {
        sendLastFrame(false);
        lastFrame = frame;
      }
    };
    const endSegment = () => {
      pushFrames(audio.flush());
      sendLastFrame(true);
    };

    const attempt = new AbortController();
    const signal = AbortSignal.any([this.abortSignal, attempt.signal]);
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
    const synthesizeTask = async () => {
      for await (const event of tokenizer) {
        if (!event.token.trim()) continue;
        // Text still buffered when the stream closes must not start new requests.
        if (this.abortSignal.aborted) break;
        this.markStarted();
        try {
          await this.#synthesizeText(client, event.token, signal, (chunk) => {
            receivedAudio = true;
            pushFrames(audio.write(chunk));
          });
        } catch (error) {
          if (!(error instanceof APIConnectionError)) throw error;
          synthesisError = error;
          log().error({ error }, 'NVIDIA TTS sentence failed');
        }
      }
    };

    const tasks = [inputTask(), synthesizeTask()];
    try {
      await Promise.all(tasks);
      endSegment();
      if (synthesisError && !receivedAudio && !this.abortSignal.aborted) throw synthesisError;
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    } finally {
      attempt.abort();
      tokenizer.close();
      await Promise.allSettled(tasks);
    }
  }

  async #synthesizeText(
    client: RivaSpeechSynthesisClient,
    text: string,
    signal: AbortSignal,
    onAudio: (audio: Buffer) => void,
  ): Promise<void> {
    const call = client.SynthesizeOnline(
      {
        text,
        languageCode: this.#opts.languageCode,
        encoding: 'LINEAR_PCM',
        sampleRateHz: this.#opts.sampleRate,
        voiceName: this.#opts.voice,
      },
      this.#connection.metadata,
    );
    const cancel = () => call.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        call.on('data', (response: SynthesizeSpeechResponse) => {
          if (!signal.aborted && response.audio.length > 0) onAudio(response.audio);
        });
        call.on('end', resolve);
        call.on('error', (error) => {
          if (signal.aborted) resolve();
          // The text came off the input queue, so the base retry loop could not replay it.
          else
            reject(
              new APIConnectionError({
                message: `NVIDIA TTS failed: ${error.message}`,
                options: { retryable: false },
              }),
            );
        });
      });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}
