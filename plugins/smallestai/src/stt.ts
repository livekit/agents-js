// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  AudioByteStream,
  Future,
  createTimedString,
  log,
  mergeFrames,
  normalizeLanguage,
  shortuuid,
  stt,
  waitForAbort,
} from '@livekit/agents';
import { type AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import { type STTEncoding, type STTModels } from './models.js';

const NUM_CHANNELS = 1;
const SMALLEST_STT_BASE_URL = 'https://api.smallest.ai/waves/v1';
const STREAMING_MODELS = new Set<string>(['pulse']);
const CLOSE_STREAM_MESSAGE = JSON.stringify({ type: 'close_stream' });

/** @public */
export interface STTOptions {
  model: STTModels | string;
  apiKey?: string;
  language: string;
  sampleRate: number;
  encoding: STTEncoding | string;
  wordTimestamps: boolean;
  diarize: boolean;
  /** Silence before the server finalizes an utterance. Valid range: 100-10000ms. */
  eouTimeoutMs: number;
  /** Finalize transcripts on trailing silence detection. */
  endpointing: boolean;
  /** Keyword and intensifier pairs used to boost streaming recognition. */
  keywords: [string, number][];
  /** Apply punctuation and capitalization to streaming transcripts. */
  format: boolean;
  /** Include sentence-level utterances in streaming transcript metadata. */
  sentenceTimestamps: boolean;
  /** Redact names, addresses, and phone numbers in streaming transcripts. */
  redactPii: boolean;
  /** Redact payment card data in streaming transcripts. */
  redactPci: boolean;
  baseUrl: string;
}

const defaultSTTOptions: STTOptions = {
  model: 'pulse',
  apiKey: process.env.SMALLEST_API_KEY,
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  wordTimestamps: true,
  diarize: false,
  eouTimeoutMs: 100,
  endpointing: true,
  keywords: [],
  format: true,
  sentenceTimestamps: false,
  redactPii: false,
  redactPci: false,
  baseUrl: SMALLEST_STT_BASE_URL,
};

/** @public */
export class STT extends stt.STT {
  #opts: STTOptions;
  #streams = new Set<WeakRef<SpeechStream>>();
  label = 'smallestai.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    const merged = { ...defaultSTTOptions, ...opts };
    if (!merged.apiKey) {
      throw new Error('SmallestAI API key is required. Set SMALLEST_API_KEY or pass apiKey');
    }

    super({
      streaming: STREAMING_MODELS.has(merged.model),
      interimResults: true,
      diarization: merged.diarize,
      alignedTranscript: merged.wordTimestamps ? 'word' : false,
    });
    this.#opts = merged;
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'SmallestAI';
  }

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const url = new URL(`${this.#opts.baseUrl}/stt/`);
    appendSearchParams(url, {
      model: this.#opts.model,
      language: this.#opts.language,
      encoding: this.#opts.encoding,
      sample_rate: this.#opts.sampleRate,
      word_timestamps: this.#opts.wordTimestamps,
      diarize: this.#opts.diarize,
    });

    const wav = createWav(frame);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          'Content-Type': 'application/octet-stream',
          'X-Source': 'livekit',
          'X-LiveKit-Version': __PACKAGE_VERSION__,
        },
        body: new Uint8Array(wav),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new APIStatusError({
          message: await res.text(),
          options: { statusCode: res.status },
        });
      }

      return batchTranscriptionToSpeechEvent(this.#opts.language, await res.json());
    } catch (error) {
      if (error instanceof APIError) throw error;
      if (controller.signal.aborted) throw new APITimeoutError({});
      throw new APIConnectionError({ message: `SmallestAI STT request failed: ${error}` });
    } finally {
      clearTimeout(timeout);
    }
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    if (!this.capabilities.streaming) {
      throw new Error(`${this.#opts.model} does not support streaming; use recognize() instead`);
    }
    const stream = new SpeechStream(this, { ...this.#opts }, options?.connOptions);
    this.#streams.add(new WeakRef(stream));
    return stream;
  }

  updateOptions(opts: Partial<Omit<STTOptions, 'apiKey' | 'baseUrl'>>) {
    this.#opts = { ...this.#opts, ...opts };
    this.updateCapabilities({
      streaming: STREAMING_MODELS.has(this.#opts.model),
      diarization: this.#opts.diarize,
      alignedTranscript: this.#opts.wordTimestamps ? 'word' : false,
    });

    for (const ref of this.#streams) {
      const stream = ref.deref();
      if (stream) {
        stream.updateOptions(opts);
      } else {
        this.#streams.delete(ref);
      }
    }
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  #sessionId = '';
  #speaking = false;
  #reconnectEvent = new Future<void>();
  #pendingInput?: Promise<IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>>;
  #connOptions: APIConnectOptions;
  label = 'smallestai.SpeechStream';

  constructor(stt: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#connOptions = connOptions ?? {
      maxRetry: 3,
      retryIntervalMs: 2000,
      timeoutMs: 10000,
    };
  }

  updateOptions(opts: Partial<Omit<STTOptions, 'apiKey' | 'baseUrl'>>): void {
    this.#opts = { ...this.#opts, ...opts };
    if (!this.#reconnectEvent.done) this.#reconnectEvent.resolve();
  }

  protected async run(): Promise<void> {
    while (!this.closed && !this.input.closed) {
      this.#reconnectEvent = new Future<void>();
      const ws = await this.#connectWS();
      const sessionController = new AbortController();

      try {
        const result = await Promise.race([
          Promise.all([
            this.#sendAudio(ws, sessionController.signal),
            this.#receiveEvents(ws, sessionController.signal),
          ]).then(() => 'done' as const),
          this.#reconnectEvent.await.then(() => 'reconnect' as const),
          waitForAbort(this.abortSignal).then(() => 'abort' as const),
        ]);
        if (result !== 'reconnect') return;
      } finally {
        sessionController.abort();
        ws.close();
      }
    }
  }

  async #connectWS(): Promise<WebSocket> {
    const url = new URL(
      `${this.#opts.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/stt/live`,
    );
    appendSearchParams(url, {
      model: this.#opts.model,
      language: this.#opts.language,
      encoding: this.#opts.encoding,
      sample_rate: this.#opts.sampleRate,
      word_timestamps: this.#opts.wordTimestamps,
      diarize: this.#opts.diarize,
      eou_timeout_ms: this.#opts.eouTimeoutMs,
      endpointing: this.#opts.endpointing,
      format: this.#opts.format,
      sentence_timestamps: this.#opts.sentenceTimestamps,
      redact_pii: this.#opts.redactPii,
      redact_pci: this.#opts.redactPci,
      ...(this.#opts.keywords.length
        ? {
            keywords: this.#opts.keywords.map(
              ([keyword, intensifier]) => `${keyword}:${intensifier}`,
            ),
          }
        : {}),
    });

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.#opts.apiKey}`,
        'X-Source': 'livekit',
        'X-LiveKit-Version': __PACKAGE_VERSION__,
      },
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ws.terminate();
    }, this.#connOptions.timeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (error) => reject(error));
        ws.once('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
      });
    } catch (error) {
      if (timedOut) throw new APITimeoutError({ message: 'SmallestAI STT connection timed out' });
      throw new APIConnectionError({ message: `failed to connect to SmallestAI STT: ${error}` });
    } finally {
      clearTimeout(timeout);
    }

    return ws;
  }

  async #sendAudio(ws: WebSocket, abortSignal: AbortSignal): Promise<void> {
    const samplesPerChunk = Math.floor(this.#opts.sampleRate / 20);
    const audioStream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS, samplesPerChunk);

    while (!abortSignal.aborted) {
      this.#pendingInput ??= this.input.next();
      const result = await Promise.race([this.#pendingInput, waitForAbort(abortSignal)]);
      if (result === undefined || result.done) break;
      this.#pendingInput = undefined;
      const data = result.value;
      if (data === SpeechStream.FLUSH_SENTINEL) {
        for (const frame of audioStream.flush()) {
          ws.send(frame.data);
        }
        continue;
      }

      for (const frame of audioStream.write(data.data)) {
        ws.send(frame.data);
      }
    }

    if (!abortSignal.aborted) ws.send(CLOSE_STREAM_MESSAGE);
  }

  async #receiveEvents(ws: WebSocket, abortSignal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onMessage = (raw: RawData) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          this.#logger.warn({ raw: raw.toString() }, 'failed to parse SmallestAI STT message');
          return;
        }

        this.#processStreamEvent(data);
        if (data.is_last === true) resolve();
      };
      ws.on('message', onMessage);
      ws.once('error', reject);
      ws.once('close', () => resolve());
      abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  #processStreamEvent(data: Record<string, unknown>) {
    const sessionId = stringValue(data.session_id);
    if (sessionId) this.#sessionId = sessionId;

    const transcript = stringValue(data.transcript);
    if (!transcript) return;

    if (!this.#speaking) {
      this.#speaking = true;
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
    }

    const alternatives = transcriptToSpeechData(
      this.#opts.language,
      data,
      this.startTimeOffset,
      this.#opts.diarize,
    );

    if (data.is_final === true) {
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId: this.#sessionId,
        alternatives,
      });
      if (this.#speaking) {
        this.#speaking = false;
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
    } else {
      this.queue.put({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        requestId: this.#sessionId,
        alternatives,
      });
    }
  }
}

function transcriptToSpeechData(
  language: string,
  data: Record<string, unknown>,
  startTimeOffset: number,
  diarize: boolean,
): [stt.SpeechData, ...stt.SpeechData[]] {
  const rawWords = recordsFrom(data.words);
  const rawUtterances = recordsFrom(data.utterances);
  const redactedEntities = Array.isArray(data.redacted_entities)
    ? data.redacted_entities.filter((entity): entity is string => typeof entity === 'string')
    : [];
  const speakerId = diarize ? mostFrequentSpeaker(rawWords) : null;
  const detectedLanguage = stringValue(data.language) || language;
  const metadata: Record<string, unknown> = {};
  if (rawUtterances.length) {
    metadata.utterances = rawUtterances.map((utterance) => ({
      ...utterance,
      start: numberValue(utterance.start) + startTimeOffset,
      end: numberValue(utterance.end) + startTimeOffset,
    }));
  }
  if (redactedEntities.length) metadata.redacted_entities = redactedEntities;

  return [
    {
      language: normalizeLanguage(detectedLanguage),
      text: stringValue(data.transcript),
      startTime: rawWords[0] ? numberValue(rawWords[0].start) + startTimeOffset : 0,
      endTime: rawWords.at(-1) ? numberValue(rawWords.at(-1)?.end) + startTimeOffset : 0,
      confidence: rawWords[0] ? numberValue(rawWords[0].confidence) : 0,
      words: rawWords.length
        ? rawWords.map((word) =>
            createTimedString({
              text: stringValue(word.word),
              startTime: numberValue(word.start) + startTimeOffset,
              endTime: numberValue(word.end) + startTimeOffset,
              confidence: numberValue(word.confidence),
              speakerId: word.speaker === undefined ? null : `S${String(word.speaker)}`,
            }),
          )
        : undefined,
      speakerId,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    },
  ];
}

function batchTranscriptionToSpeechEvent(
  language: string,
  data: Record<string, unknown>,
): stt.SpeechEvent {
  const rawWords = recordsFrom(data.words);
  const rawUtterances = recordsFrom(data.utterances);
  const detectedLanguage = stringValue(data.language) || language;
  return {
    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
    requestId: shortuuid(),
    alternatives: [
      {
        language: normalizeLanguage(detectedLanguage),
        text: stringValue(data.transcription),
        startTime: rawWords[0] ? numberValue(rawWords[0].start) : 0,
        endTime: rawWords.at(-1) ? numberValue(rawWords.at(-1)?.end) : 0,
        confidence: rawWords[0] ? numberValue(rawWords[0].confidence) : 0,
        words: rawWords.length
          ? rawWords.map((word) =>
              createTimedString({
                text: stringValue(word.word),
                startTime: numberValue(word.start),
                endTime: numberValue(word.end),
                confidence: numberValue(word.confidence),
              }),
            )
          : undefined,
        metadata: rawUtterances.length ? { utterances: rawUtterances } : undefined,
      },
    ],
  };
}

function appendSearchParams(url: URL, params: Record<string, unknown>) {
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'object' && item !== null)
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function mostFrequentSpeaker(words: Record<string, unknown>[]): string | null {
  const counts = new Map<string, number>();
  for (const word of words) {
    if (word.speaker === undefined) continue;
    const speaker = String(word.speaker);
    counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best === null ? null : `S${best}`;
}

function createWav(frame: AudioFrame): Buffer {
  const bitsPerSample = 16;
  const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
  const blockAlign = (frame.channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + frame.data.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(frame.channels, 22);
  header.writeUInt32LE(frame.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(frame.data.byteLength, 40);

  const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  return Buffer.concat([header, pcm]);
}
