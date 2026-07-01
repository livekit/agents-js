// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  type LanguageCode,
  getBaseLanguage,
  log,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const SUPPORTED_SAMPLE_RATE = 24000;
const DEFAULT_MODEL_ENDPOINT = 'wss://api.gradium.ai/api/speech/asr';
const DEFAULT_FRAME_SIZE = 1920;
const DEFAULT_DELAY_IN_TOKENS = 6;

/** @public */
export interface STTOptions {
  /** Gradium API key. Defaults to $GRADIUM_API_KEY. */
  apiKey?: string;
  /** Gradium model endpoint. Defaults to $GRADIUM_MODEL_ENDPOINT or Gradium's hosted ASR endpoint. */
  modelEndpoint?: string;
  /** Gradium model name. */
  modelName?: string;
  /** Audio sample rate. Gradium currently supports 24kHz input. */
  sampleRate?: number;
  /** Audio input encoding. */
  encoding?: 'pcm_s16le';
  /** Buffered audio chunk size in seconds. */
  bufferSizeSeconds?: number;
  /** Model temperature. */
  temperature?: number;
  /** Transcript language code. */
  language?: string;
  /** VAD inactivity threshold used to finalize speech. */
  vadThreshold?: number;
  /** VAD bucket index used for inactivity probability. */
  vadBucket?: number | null;
  /** Flush zero audio when VAD first detects inactivity. */
  vadFlush?: boolean;
}

interface ResolvedSTTOptions {
  apiKey: string;
  modelEndpoint: string;
  modelName: string;
  sampleRate: number;
  encoding: 'pcm_s16le';
  bufferSizeSeconds: number;
  temperature?: number;
  language: LanguageCode;
  vadThreshold: number;
  vadBucket: number | null;
  vadFlush: boolean;
}

interface ReadyMessage {
  delay_in_tokens?: number;
  frame_size?: number;
}

function resolveOptions(opts: Partial<STTOptions>): ResolvedSTTOptions {
  const apiKey = opts.apiKey ?? process.env.GRADIUM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Gradium API key is required, either pass it as `apiKey` or set $GRADIUM_API_KEY',
    );
  }

  const modelEndpoint =
    opts.modelEndpoint ?? process.env.GRADIUM_MODEL_ENDPOINT ?? DEFAULT_MODEL_ENDPOINT;
  if (!modelEndpoint) {
    throw new Error('Gradium model endpoint is required');
  }

  const sampleRate = opts.sampleRate ?? SUPPORTED_SAMPLE_RATE;
  if (sampleRate !== SUPPORTED_SAMPLE_RATE) {
    throw new Error(`Only ${SUPPORTED_SAMPLE_RATE}Hz sample rate is supported`);
  }

  return {
    apiKey,
    modelEndpoint,
    modelName: opts.modelName ?? 'default',
    sampleRate,
    encoding: opts.encoding ?? 'pcm_s16le',
    bufferSizeSeconds: opts.bufferSizeSeconds ?? 0.08,
    temperature: opts.temperature,
    language: normalizeLanguage(opts.language ?? 'en'),
    vadThreshold: opts.vadThreshold ?? 0.9,
    // Distinguish `undefined` (not provided → default bucket) from an explicit
    // `null`, which disables VAD-based finalization. `??` would coalesce both.
    vadBucket: opts.vadBucket !== undefined ? opts.vadBucket : 2,
    vadFlush: opts.vadFlush ?? true,
  };
}

function rawDataToString(data: RawData): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof Buffer) return data.toString('utf-8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  return undefined;
}

function viewToArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** @public */
export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  label = 'gradium.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
    });
    this.#opts = resolveOptions(opts);
  }

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'Gradium';
  }

  async _recognize(_frame: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on Gradium STT');
  }

  updateOptions(opts: Partial<Pick<STTOptions, 'bufferSizeSeconds'>>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  stream(options: { connOptions?: APIConnectOptions } = {}): SpeechStream {
    return new SpeechStream(this, this.#opts, options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  #opts: ResolvedSTTOptions;
  #logger = log();
  #readyMessage?: ReadyMessage;
  label = 'gradium.SpeechStream';

  constructor(stt: STT, opts: ResolvedSTTOptions, connOptions: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = { ...opts };
  }

  get delayInTokens(): number {
    return this.#readyMessage?.delay_in_tokens ?? DEFAULT_DELAY_IN_TOKENS;
  }

  get frameSize(): number {
    return this.#readyMessage?.frame_size ?? DEFAULT_FRAME_SIZE;
  }

  protected async run(): Promise<void> {
    const ws = await this.#connect();
    try {
      await Promise.all([this.#sendAudio(ws), this.#receive(ws)]);
    } finally {
      ws.close();
    }
  }

  async #connect(): Promise<WebSocket> {
    const ws = new WebSocket(this.#opts.modelEndpoint, {
      headers: { 'x-api-key': this.#opts.apiKey, 'x-api-source': 'livekit' },
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const jsonConfig: Record<string, unknown> = {
      language: getBaseLanguage(this.#opts.language),
    };
    if (this.#opts.temperature != null) {
      jsonConfig.temp = this.#opts.temperature;
    }
    const setup: Record<string, unknown> = {
      type: 'setup',
      model_name: this.#opts.modelName,
      input_format: 'pcm',
      json_config: jsonConfig,
    };
    ws.send(JSON.stringify(setup));
    return ws;
  }

  async #sendAudio(ws: WebSocket): Promise<void> {
    const samplesPerBuffer = Math.trunc(this.#opts.sampleRate * this.#opts.bufferSizeSeconds);
    const audioByteStream = new AudioByteStream(
      this.#opts.sampleRate,
      1,
      samplesPerBuffer || DEFAULT_FRAME_SIZE,
    );

    try {
      for await (const data of this.input) {
        if (this.abortSignal.aborted) break;
        const frames =
          data === SpeechStream.FLUSH_SENTINEL
            ? audioByteStream.flush()
            : audioByteStream.write(viewToArrayBuffer(data.data));

        for (const frame of frames) {
          const audio = Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          ).toString('base64');
          ws.send(JSON.stringify({ type: 'audio', audio }));
        }
      }
    } finally {
      ws.close();
    }
  }

  async #receive(ws: WebSocket): Promise<void> {
    let bufferedText: string[] = [];
    let speaking = false;
    let remainingVadSteps: number | undefined;

    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => {
        try {
          const raw = rawDataToString(data);
          if (!raw) return;
          const message = JSON.parse(raw) as Record<string, unknown>;
          const type = message.type;

          if (type === 'text') {
            if (!speaking) {
              speaking = true;
              this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
            }

            const text = String(message.text ?? '');
            bufferedText.push(text);
            this.queue.put({
              type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
              alternatives: [
                {
                  text,
                  language: this.#opts.language,
                  startTime: Number(message.start_s ?? 0) + this.startTimeOffset,
                  endTime: 0,
                  confidence: 0,
                },
              ],
            });
          } else if (type === 'step') {
            if (!speaking || this.#opts.vadBucket == null) return;

            const vad = message.vad as Array<{ inactivity_prob?: number }> | undefined;
            const inactivity = vad?.[this.#opts.vadBucket]?.inactivity_prob ?? 0;
            if (inactivity > this.#opts.vadThreshold) {
              if (remainingVadSteps == null) {
                remainingVadSteps = this.delayInTokens;
                if (this.#opts.vadFlush) {
                  const samplesPerChannel = this.frameSize * this.delayInTokens;
                  this.input.put(
                    new AudioFrame(
                      new Int16Array(samplesPerChannel),
                      this.#opts.sampleRate,
                      1,
                      samplesPerChannel,
                    ),
                  );
                }
              } else {
                remainingVadSteps -= 1;
                if (remainingVadSteps <= 0) {
                  speaking = false;
                  remainingVadSteps = undefined;
                  this.queue.put({
                    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives: [
                      {
                        text: bufferedText.join(' '),
                        language: this.#opts.language,
                        startTime: 0,
                        endTime: 0,
                        confidence: 0,
                      },
                    ],
                  });
                  bufferedText = [];
                  this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
                }
              }
            } else {
              remainingVadSteps = undefined;
            }
          } else if (type === 'ready') {
            this.#readyMessage = message as ReadyMessage;
          } else if (type !== 'end_text') {
            this.#logger.warn(`unknown message type from Gradium: ${String(type)}`);
          }
        } catch (error) {
          this.#logger.error({ error }, 'failed to process Gradium message');
        }
      });
      ws.once('close', () => resolve());
      ws.once('error', reject);
      this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}
