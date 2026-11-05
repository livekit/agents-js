// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIError,
  APIStatusError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  type LanguageCode,
  type VAD,
  type VADEvent,
  VADEventType,
  type VADStream,
  stt,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type * as r from '@rimelabs/sdk';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';

/** Recognition settings. An injected SDK client and VAD remain caller-owned. */
export interface STTOptions {
  apiKey?: string;
  client?: r.Rime;
  language?: string;
  mode?: r.TranscriptionMode;
  contextTerms?: readonly string[];
  vad?: VAD;
  outputContract?: r.TranscriptionOutputContract;
  /** Whole-recording requests use these retries and timeout, in milliseconds. */
  connOptions?: Partial<APIConnectOptions>;
}
interface Settings {
  language: string;
  mode: r.TranscriptionMode;
  contextTerms: string[];
  outputContract: r.TranscriptionOutputContract;
}

/** Rime recording transcription, with native utterance streaming when a VAD is supplied. */
export class STT extends stt.STT {
  label = 'rime.STT';
  private settings: Settings;
  private sessionTerms: string[] = [];
  private client?: r.Rime;
  private initialized: Promise<typeof r>;
  private streams = new Set<RimeSpeechStream>();
  private lifetime = new AbortController();
  private requests = new Set<Promise<stt.SpeechEvent>>();
  private closing?: Promise<void>;
  constructor(private options: STTOptions = {}) {
    super({
      streaming: Boolean(options.vad),
      interimResults: Boolean(options.vad),
      keyterms: true,
    });
    if (options.apiKey && options.client) throw new Error('Provide either a client or an API key');
    this.settings = {
      language: options.language ?? 'en',
      mode: options.mode ?? 'written',
      contextTerms: [...(options.contextTerms ?? [])],
      outputContract: options.outputContract ?? 'revised_hypotheses',
    };
    this.validate(this.settings);
    const connection = { ...DEFAULT_API_CONNECT_OPTIONS, ...options.connOptions };
    if (
      !Number.isFinite(connection.timeoutMs) ||
      connection.timeoutMs <= 0 ||
      !Number.isSafeInteger(connection.maxRetry) ||
      connection.maxRetry < 0 ||
      !Number.isFinite(connection.retryIntervalMs) ||
      connection.retryIntervalMs < 0
    )
      throw new Error('Invalid Rime STT connection options');
    this.options = { ...options, connOptions: connection };
    if (!options.vad && this.settings.outputContract === 'append_fragments')
      throw new Error('append_fragments requires a VAD');
    this.initialized = import('@rimelabs/sdk').then((sdk) => {
      this.client = this.options.client ?? new sdk.Rime({ apiKey: this.options.apiKey });
      return sdk;
    });
    void this.initialized.catch(() => undefined);
  }
  override get model(): string {
    return 'rime-stt';
  }
  override get provider(): string {
    return 'Rime';
  }
  private validate(value: Settings): void {
    if (
      typeof value.language !== 'string' ||
      !value.language ||
      !['written', 'verbatim'].includes(value.mode) ||
      !['revised_hypotheses', 'append_fragments'].includes(value.outputContract) ||
      value.contextTerms.some((term) => typeof term !== 'string')
    )
      throw new Error('Invalid Rime STT settings');
  }
  updateOptions(options: Pick<STTOptions, 'language' | 'mode' | 'contextTerms'>): void {
    const next = {
      ...this.settings,
      ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
      contextTerms: [...(options.contextTerms ?? this.settings.contextTerms)],
    };
    this.validate(next);
    this.settings = next;
  }
  override _updateSessionKeyterms(terms: string[]): void {
    this.sessionTerms = [...terms];
  }
  /** @internal Capture options once per utterance. */
  snapshot(): Settings {
    return {
      ...this.settings,
      contextTerms: [...new Set([...this.settings.contextTerms, ...this.sessionTerms])],
    };
  }
  /** @internal */
  async sdk(): Promise<{ client: r.Rime; types: typeof r }> {
    const types = await this.initialized;
    this.lifetime.signal.throwIfAborted();
    return { client: this.client!, types };
  }
  /** Whole recordings are downmixed and resampled to mono 16 kHz WAV. */
  protected override _recognize(
    buffer: AudioBuffer,
    signal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    const settings = this.snapshot();
    const options = { ...DEFAULT_API_CONNECT_OPTIONS, ...this.options.connOptions };
    const work = (async () => {
      const { client, types } = await this.sdk();
      const audio = wav(buffer);
      const cancel = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await client.stt.transcribe(audio, {
            ...settings,
            timeout: options.timeoutMs / 1000,
            signal: cancel,
          });
          return transcript(
            stt.SpeechEventType.FINAL_TRANSCRIPT,
            result.text,
            result.language,
            result.requestId ?? '',
          );
        } catch (error) {
          const retry =
            error instanceof types.RimeTimeoutError || error instanceof types.RimeUnavailableError;
          if (!retry || cancel.aborted || attempt >= options.maxRetry)
            throw recognitionError(error, types, false);
          await delay(attempt === 0 ? 100 : options.retryIntervalMs, undefined, { signal: cancel });
        }
      }
    })();
    this.requests.add(work);
    void work.then(
      () => this.requests.delete(work),
      () => this.requests.delete(work),
    );
    return work;
  }
  stream(options: { connOptions?: APIConnectOptions } = {}): stt.SpeechStream {
    this.lifetime.signal.throwIfAborted();
    if (!this.options.vad) throw new Error('Pass a VAD to Rime STT for native streaming');
    const stream = new RimeSpeechStream(
      this,
      this.options.vad,
      options.connOptions ?? { ...DEFAULT_API_CONNECT_OPTIONS, ...this.options.connOptions },
      () => this.streams.delete(stream),
    );
    this.streams.add(stream);
    return stream;
  }
  override close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.closing = (async () => {
      await Promise.allSettled(
        [...this.streams].map((stream) => {
          stream.close();
          return stream.finished;
        }),
      );
      await this.initialized.catch(() => undefined);
      if (!this.options.client) await this.client?.close();
      await Promise.allSettled([...this.requests]);
    })();
    return this.closing;
  }
}
function recognitionError(error: unknown, sdk: typeof r, streaming: boolean): APIError {
  return new APIStatusError({
    message: 'Rime STT request failed',
    options: {
      requestId: error instanceof sdk.RimeError ? error.requestId ?? undefined : undefined,
      retryable:
        !streaming &&
        (error instanceof sdk.RimeTimeoutError || error instanceof sdk.RimeUnavailableError),
    },
  });
}
function transcript(
  type: stt.SpeechEventType,
  text: string,
  language: string,
  requestId = '',
): stt.SpeechEvent {
  return {
    type,
    requestId,
    alternatives: [
      { text, language: language as LanguageCode, startTime: 0, endTime: 0, confidence: 0 },
    ],
  };
}
function pcm(frame: AudioFrame): Uint8Array {
  const data = Buffer.alloc(frame.samplesPerChannel * 2);
  for (let i = 0; i < frame.samplesPerChannel; i++) data.writeInt16LE(frame.data[i]!, i * 2);
  return data;
}
function wav(buffer: AudioBuffer): Uint8Array {
  const frames = Array.isArray(buffer) ? buffer : [buffer];
  const first = frames[0];
  if (!first || !first.sampleRate || !first.channels)
    throw new APIError('Invalid Rime STT audio', { retryable: false });
  const parts: Uint8Array[] = [];
  let bytes = 44;
  const append = (frame: AudioFrame) => {
    bytes += frame.samplesPerChannel * 2;
    if (bytes > 16 * 1024 * 1024)
      throw new APIError('Rime STT WAV exceeds 16 MiB', { retryable: false });
    parts.push(pcm(frame));
  };
  const resampler =
    first.sampleRate === 16000 ? undefined : new AudioResampler(first.sampleRate, 16000, 1);
  try {
    for (const frame of frames) {
      if (frame.sampleRate !== first.sampleRate || frame.channels !== first.channels)
        throw new APIError('Mixed Rime STT audio formats', { retryable: false });
      const mono = new Int16Array(frame.samplesPerChannel);
      for (let i = 0; i < mono.length; i++) {
        let sum = 0;
        for (let c = 0; c < frame.channels; c++) sum += frame.data[i * frame.channels + c]!;
        mono[i] = Math.trunc(sum / frame.channels);
      }
      const input = new AudioFrame(mono, frame.sampleRate, 1, mono.length);
      for (const output of resampler ? resampler.push(input) : [input]) append(output);
    }
    if (resampler) for (const output of resampler.flush()) append(output);
  } finally {
    resampler?.close();
  }
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(bytes - 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes - 44, 40);
  return Buffer.concat([header, ...parts]);
}

/** Bounded upload queue; draining or cancellation releases the shared audio budget. */
class AudioQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private ended = false;
  private wake?: () => void;
  constructor(private account: (bytes: number) => void) {}
  push(data: Uint8Array): void {
    this.account(data.length);
    this.chunks.push(data);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  clear(): void {
    for (const data of this.chunks) this.account(-data.length);
    this.chunks = [];
    this.end();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const data = this.chunks.shift();
        if (data) {
          this.account(-data.length);
          yield data;
        } else if (this.ended) return;
        else
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
      }
    } finally {
      this.clear();
    }
  }
}
interface Utterance {
  audio: AudioQueue;
  settings: Settings;
  started: number;
  ended?: number;
  emittedStart: boolean;
  interim?: string;
  final?: stt.SpeechEvent;
  error?: Error;
  duration: number;
  work?: Promise<void>;
}
class RimeSpeechStream extends stt.SpeechStream {
  label = 'rime.SpeechStream';
  private detector?: VADStream;
  private utterances: Utterance[] = [];
  private active?: Utterance;
  private work = new Set<Promise<void>>();
  private queuedBytes = 0;
  private inputSamples = 0;
  private processedSamples = 0;
  private detectorProgress?: () => void;
  private failure?: Error;
  private uploads = new AbortController();
  private resolveFinished!: () => void;
  readonly finished = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });
  constructor(
    private owner: STT,
    private vad: VAD,
    private options: APIConnectOptions,
    private forget: () => void,
  ) {
    super(owner, 16000, { ...options, maxRetry: 0 });
  }
  override pushFrame(frame: AudioFrame): void {
    if (frame.channels !== 1)
      throw new APIError('Rime streaming STT requires mono audio', { retryable: false });
    super.pushFrame(frame);
  }
  private publish(): void {
    if (this.failure) return;
    while (this.utterances.length && !this.closed && !this.abortSignal.aborted) {
      const u = this.utterances[0]!;
      if (u.error) {
        this.failure = u.error;
        this.uploads.abort();
        this.stopDetector();
        this.input.close();
        return;
      }
      if (!u.emittedStart) {
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH, createdAt: u.started });
        u.emittedStart = true;
      }
      if (u.interim !== undefined) {
        this.queue.put(
          transcript(stt.SpeechEventType.INTERIM_TRANSCRIPT, u.interim, u.settings.language),
        );
        u.interim = undefined;
      }
      if (!u.final || u.ended === undefined) return;
      this.queue.put({ ...u.final, speechEndTime: u.ended });
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH, speechEndTime: u.ended });
      this.queue.put({
        type: stt.SpeechEventType.RECOGNITION_USAGE,
        requestId: u.final.requestId,
        recognitionUsage: { audioDuration: u.duration },
      });
      this.utterances.shift();
    }
  }
  private start(event: VADEvent): void {
    if (this.active || this.utterances.length >= 8)
      throw new APIError('Rime pending utterance limit exceeded', { retryable: false });
    const u: Utterance = {
      audio: new AudioQueue((bytes) => {
        if (this.queuedBytes + bytes > 320000)
          throw new APIError('Rime upload audio exceeds ten seconds', { retryable: false });
        this.queuedBytes += bytes;
      }),
      settings: this.owner.snapshot(),
      started: Date.now() - (event.speechDuration ?? 0) - (event.inferenceDuration ?? 0),
      emittedStart: false,
      duration: 0,
    };
    this.utterances.push(u);
    this.active = u;
    u.work = this.transcribe(u);
    this.work.add(u.work);
    void u.work.finally(() => this.work.delete(u.work!)).catch(() => undefined);
    this.publish();
  }
  private async transcribe(u: Utterance): Promise<void> {
    let stream: r.TranscriptStream | undefined;
    try {
      const { client, types } = await this.owner.sdk();
      try {
        stream = client.stt.stream(u.audio, {
          ...u.settings,
          timeout: this.options.timeoutMs / 1000,
          signal: AbortSignal.any([this.abortSignal, this.uploads.signal]),
        });
        let text = '',
          completed = false;
        for await (const update of stream) {
          if (update.kind === 'final') {
            u.final = transcript(
              stt.SpeechEventType.FINAL_TRANSCRIPT,
              update.text,
              update.language,
              stream.requestId ?? '',
            );
            completed = true;
          } else {
            text = update.kind === 'delta' ? text + update.text : update.text;
            u.interim = text;
          }
          this.publish();
        }
        if (!completed && !this.abortSignal.aborted)
          throw new APIError('Rime transcription ended without confirmation', { retryable: false });
      } catch (error) {
        throw recognitionError(error, types, true);
      }
    } catch (error) {
      if (!this.closed && !this.abortSignal.aborted)
        u.error = error instanceof Error ? error : new Error('Rime transcription failed');
    } finally {
      try {
        await stream?.cancel();
      } finally {
        u.audio.clear();
        this.publish();
      }
    }
  }
  private finish(end = Date.now()): void {
    if (!this.active) return;
    this.active.ended = end;
    this.active.audio.end();
    this.active = undefined;
    this.publish();
  }
  private async readDetector(detector: VADStream): Promise<void> {
    for await (const event of detector) {
      if (this.closed || this.abortSignal.aborted) return;
      if (event.type === VADEventType.INFERENCE_DONE) {
        this.processedSamples += event.frames.reduce((n, frame) => n + frame.samplesPerChannel, 0);
        this.detectorProgress?.();
      }
      if (event.type === VADEventType.START_OF_SPEECH) this.start(event);
      if (
        this.active &&
        (event.type === VADEventType.START_OF_SPEECH || event.type === VADEventType.INFERENCE_DONE)
      ) {
        for (const frame of event.frames) {
          if (frame.channels !== 1 || frame.sampleRate !== 16000)
            throw new APIError('Rime streaming requires mono 16 kHz VAD frames', {
              retryable: false,
            });
          this.active.audio.push(pcm(frame));
          this.active.duration += frame.samplesPerChannel / frame.sampleRate;
        }
      }
      if (event.type === VADEventType.END_OF_SPEECH)
        this.finish(Date.now() - (event.silenceDuration ?? 0) - (event.inferenceDuration ?? 0));
    }
    this.finish();
  }
  // Some released VADStream implementations close a locked writer in endInput().
  // Drain through public inference events, then close the detector instead.
  private async drainDetector(): Promise<void> {
    if (!this.inputSamples) return;
    const window = Math.round(this.vad.capabilities.updateInterval * 16);
    if (!Number.isSafeInteger(window) || window < 1 || window > 16000)
      throw new APIError('Invalid Rime VAD inference interval', { retryable: false });
    const padding = (window - (this.inputSamples % window)) % window;
    if (padding) {
      this.inputSamples += padding;
      this.detector!.pushFrame(new AudioFrame(new Int16Array(padding), 16000, 1, padding));
    }
    const signal = AbortSignal.any([this.abortSignal, this.uploads.signal]);
    const deadline = Date.now() + this.options.timeoutMs;
    while (this.processedSamples < this.inputSamples) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          this.detectorProgress = undefined;
          if (error) reject(error);
          else resolve();
        };
        const cancel = () =>
          done(this.failure ?? new APIError('Rime VAD drain cancelled', { retryable: false }));
        const timer = setTimeout(
          () => done(new APIError('Rime VAD drain timed out', { retryable: false })),
          Math.max(1, deadline - Date.now()),
        );
        this.detectorProgress = () => done();
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    // START/END events for the last window follow its INFERENCE_DONE event.
    await nextTurn();
    signal.throwIfAborted();
  }
  private stopDetector(): void {
    const detector = this.detector;
    this.detector = undefined;
    if (detector) {
      try {
        detector.flush();
      } finally {
        detector.close();
      }
    }
  }
  protected async run(): Promise<void> {
    let reading: Promise<void> | undefined;
    const start = () => {
      this.inputSamples = this.processedSamples = 0;
      this.detector = this.vad.stream();
      reading = this.readDetector(this.detector);
      void reading.catch((error) => {
        this.failure = error;
        // Abort provider uploads, but leave the base stream able to emit this failure.
        this.uploads.abort();
        this.stopDetector();
        this.input.close();
      });
    };
    try {
      if (this.closed || this.abortSignal.aborted) return;
      start();
      for await (const input of this.input) {
        if (this.closed || this.abortSignal.aborted || this.failure) break;
        if (input === RimeSpeechStream.FLUSH_SENTINEL) {
          await this.drainDetector();
          this.finish();
          this.detector!.flush();
          this.inputSamples = this.processedSamples = 0;
        } else {
          this.inputSamples += input.samplesPerChannel;
          this.detector!.pushFrame(input);
        }
      }
      if (!this.abortSignal.aborted && !this.failure) {
        await this.drainDetector();
        this.finish();
      }
      this.stopDetector();
      await reading;
      await Promise.all([...this.work]);
      if (this.failure) throw this.failure;
    } finally {
      this.uploads.abort();
      this.stopDetector();
      for (const u of this.utterances) u.audio.clear();
      await Promise.allSettled([...this.work]);
      this.forget();
      this.resolveFinished();
    }
  }
  override close(): void {
    super.close();
    this.stopDetector();
    for (const u of this.utterances) u.audio.clear();
  }
}
