// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  type AudioBuffer,
  AudioByteStream,
  Future,
  type LanguageCode,
  asLanguageCode,
  log,
  stt,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const SUPPORTED_SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;

/** @public */
export interface STTOptions {
  apiKey?: string;
  modelEndpoint?: string;
  modelName: string;
  sampleRate: number;
  encoding: 'pcm_s16le';
  bufferSizeSeconds: number;
  vadThreshold: number;
  vadBucket: number | null;
  vadFlush: boolean;
  temperature?: number | null;
  language: string;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.GRADIUM_API_KEY,
  modelEndpoint: process.env.GRADIUM_MODEL_ENDPOINT ?? 'wss://api.gradium.ai/api/speech/asr',
  modelName: 'default',
  sampleRate: SUPPORTED_SAMPLE_RATE,
  encoding: 'pcm_s16le',
  bufferSizeSeconds: 0.08,
  vadThreshold: 0.9,
  vadBucket: 2,
  vadFlush: true,
  temperature: null,
  language: 'en',
};

type ResolvedSTTOptions = Omit<STTOptions, 'apiKey' | 'modelEndpoint' | 'language'> & {
  apiKey: string;
  modelEndpoint: string;
  language: LanguageCode;
};

type GradiumTextMessage = {
  type: 'text';
  text?: string;
  start_s?: number;
};

type GradiumStepMessage = {
  type: 'step';
  vad?: unknown;
};

type GradiumReadyMessage = {
  type: 'ready';
  delay_in_tokens?: number;
  frame_size?: number;
};

type GradiumMessage =
  | GradiumTextMessage
  | GradiumStepMessage
  | GradiumReadyMessage
  | { type: 'end_text' }
  | { type?: string };

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  return Buffer.from(data).toString('utf-8');
}

function inactivityProbability(vad: unknown, bucket: number): number | undefined {
  if (!Array.isArray(vad)) return undefined;
  const bucketData = vad[bucket];
  if (bucketData === null || typeof bucketData !== 'object') return undefined;
  const value = (bucketData as Record<string, unknown>).inactivity_prob;
  return typeof value === 'number' ? value : undefined;
}

/** @public */
export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  #streams = new Set<SpeechStream>();
  label = 'gradium.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
    });

    const apiKey = opts.apiKey ?? defaultSTTOptions.apiKey;
    if (!apiKey) {
      throw new Error(
        'Gradium API key is required. Pass one in via the `apiKey` option, ' +
          'or set it as the `GRADIUM_API_KEY` environment variable',
      );
    }

    const modelEndpoint = opts.modelEndpoint ?? defaultSTTOptions.modelEndpoint;
    if (!modelEndpoint) {
      throw new Error('The model endpoint is required, you can find it in the Gradium dashboard');
    }

    const sampleRate = opts.sampleRate ?? defaultSTTOptions.sampleRate;
    if (sampleRate !== SUPPORTED_SAMPLE_RATE) {
      throw new Error(`Only ${SUPPORTED_SAMPLE_RATE}Hz sample rate is supported`);
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      apiKey,
      modelEndpoint,
      sampleRate,
      language: asLanguageCode(opts.language ?? defaultSTTOptions.language),
    };
  }

  get model(): string {
    return this.#opts.modelName;
  }

  get provider(): string {
    return 'Gradium';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on Gradium STT');
  }

  updateOptions(opts: { bufferSizeSeconds?: number }): void {
    this.#opts = { ...this.#opts, ...opts };
    for (const stream of this.#streams) {
      stream.updateOptions(opts);
    }
  }

  stream(options?: { language?: string; connOptions?: APIConnectOptions }): stt.SpeechStream {
    const opts = {
      ...this.#opts,
      language:
        options?.language !== undefined ? asLanguageCode(options.language) : this.#opts.language,
    };
    const stream = new SpeechStream(this, opts, options?.connOptions);
    this.#streams.add(stream);
    return stream;
  }
}

class SpeechStream extends stt.SpeechStream {
  #opts: ResolvedSTTOptions;
  #readyMessage: GradiumReadyMessage | undefined;
  #bufferedText: string[] = [];
  #speaking = false;
  #remainingVadSteps: number | undefined;
  #logger = log();
  label = 'gradium.SpeechStream';

  constructor(sttInstance: STT, opts: ResolvedSTTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = { ...opts };
  }

  get delayInTokens(): number {
    return this.#readyMessage?.delay_in_tokens ?? 6;
  }

  get frameSize(): number {
    return this.#readyMessage?.frame_size ?? 1920;
  }

  updateOptions(opts: { bufferSizeSeconds?: number }): void {
    this.#opts = { ...this.#opts, ...opts };
  }

  protected async run(): Promise<void> {
    const ws = await this.#connectWS();
    await this.#runWS(ws);
  }

  async #connectWS(): Promise<WebSocket> {
    const ws = new WebSocket(this.#opts.modelEndpoint, {
      headers: {
        'x-api-key': this.#opts.apiKey,
        'x-api-source': 'livekit',
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (error) =>
        reject(
          new APIConnectionError({
            message: `Gradium connection error: ${error.message}`,
          }),
        ),
      );
    });

    const jsonConfig: Record<string, string | number> = { language: this.#opts.language };
    if (this.#opts.temperature !== null && this.#opts.temperature !== undefined) {
      jsonConfig.temp = this.#opts.temperature;
    }

    await this.#sendJSON(ws, {
      type: 'setup',
      model_name: this.#opts.modelName,
      input_format: 'pcm',
      json_config: jsonConfig,
    });

    return ws;
  }

  async #runWS(ws: WebSocket): Promise<void> {
    let closing = false;
    const stopSend = new Future<void, never>();

    const sendTask = this.#sendTask(ws, stopSend).catch((error: unknown) => {
      if (!closing) throw error;
    });
    const recvTask = this.#recvTask(ws, () => closing, stopSend);

    try {
      await Promise.race([sendTask, recvTask]);
    } finally {
      closing = true;
      if (!stopSend.done) stopSend.resolve();
      ws.close();
      await Promise.allSettled([sendTask, recvTask]);
    }
  }

  async #sendTask(ws: WebSocket, stopSend: Future<void, never>): Promise<void> {
    const samplesPerBuffer = Math.trunc(this.#opts.sampleRate * this.#opts.bufferSizeSeconds);
    const audioByteStream = new AudioByteStream(this.#opts.sampleRate, 1, samplesPerBuffer);

    while (!this.closed) {
      const result = await Promise.race([
        this.input.next(),
        stopSend.await.then(
          (): IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL> => ({
            done: true,
            value: undefined,
          }),
        ),
      ]);

      if (result.done) break;

      const data = result.value;
      const frames =
        data === SpeechStream.FLUSH_SENTINEL
          ? audioByteStream.flush()
          : audioByteStream.write(data.data.buffer as ArrayBuffer);

      for (const frame of frames) {
        if (frame.data.byteLength % BYTES_PER_SAMPLE !== 0) {
          this.#logger.warn('Frame data size not aligned to int16 (multiple of 2)');
        }

        const audio = Buffer.from(
          frame.data.buffer,
          frame.data.byteOffset,
          frame.data.byteLength,
        ).toString('base64');
        await this.#sendJSON(ws, { type: 'audio', audio });
      }
    }
  }

  #recvTask(ws: WebSocket, isClosing: () => boolean, stopSend: Future<void, never>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => {
        try {
          this.#processMessage(JSON.parse(rawDataToString(data)) as GradiumMessage);
        } catch (error) {
          this.#logger.error({ error }, 'Failed to process message from Gradium');
        }
      });

      ws.on('error', (error) => {
        if (!stopSend.done) stopSend.resolve();
        if (isClosing() || this.closed || this.abortSignal.aborted) {
          resolve();
          return;
        }
        reject(new APIConnectionError({ message: `Gradium connection error: ${error.message}` }));
      });

      ws.on('close', (code, reason) => {
        if (!stopSend.done) stopSend.resolve();
        if (isClosing() || this.closed || this.input.closed || this.abortSignal.aborted) {
          resolve();
          return;
        }
        reject(
          new APIStatusError({
            message: 'Gradium connection closed unexpectedly',
            options: {
              statusCode: code || -1,
              body: { reason: reason.toString('utf-8') },
            },
          }),
        );
      });
    });
  }

  #processMessage(message: GradiumMessage): void {
    switch (message.type) {
      case 'text':
        this.#handleText(message as GradiumTextMessage);
        break;
      case 'step':
        this.#handleStep(message as GradiumStepMessage);
        break;
      case 'ready':
        this.#readyMessage = message as GradiumReadyMessage;
        break;
      case 'end_text':
        break;
      default:
        this.#logger.warn(`Unknown message type from Gradium ${message.type ?? ''}`);
    }
  }

  #handleText(message: GradiumTextMessage): void {
    if (!message.text) return;
    if (!this.#speaking) {
      this.#speaking = true;
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
    }

    this.#bufferedText.push(message.text);
    this.queue.put({
      type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [
        {
          text: message.text,
          language: this.#opts.language,
          startTime: (message.start_s ?? 0) + this.startTimeOffset,
          endTime: 0,
          confidence: 0,
        },
      ],
    });
  }

  #handleStep(message: GradiumStepMessage): void {
    if (!this.#speaking || this.#opts.vadBucket === null) return;

    const probability = inactivityProbability(message.vad, this.#opts.vadBucket);
    if (probability === undefined || probability <= this.#opts.vadThreshold) {
      this.#remainingVadSteps = undefined;
      return;
    }

    if (this.#remainingVadSteps === undefined) {
      this.#remainingVadSteps = this.delayInTokens;
      if (this.#opts.vadFlush && !this.input.closed) {
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
      return;
    }

    this.#remainingVadSteps -= 1;
    if (this.#remainingVadSteps > 0) return;

    this.#speaking = false;
    this.#remainingVadSteps = undefined;
    this.queue.put({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: this.#bufferedText.join(' '),
          language: this.#opts.language,
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    });
    this.#bufferedText = [];
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
  }

  #sendJSON(ws: WebSocket, payload: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(payload), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
