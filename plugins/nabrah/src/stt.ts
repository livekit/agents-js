// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LanguageCode, TimedString } from '@livekit/agents';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  createTimedString,
  log,
  stt,
  waitForAbort,
  waitForWebSocketOpen,
} from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const DEFAULT_BASE_URL = 'wss://api.nabrah.ai/api/ext/stt/ws';
const SAMPLE_RATE = 16000;
const EOT_TOKEN = '<eot>';
const EOT_PUNCTUATION = new Set(['.', '?', '!', '؟']);
const NO_SPACE_BEFORE = new Set('.,?!:;،؛؟');
const WATCHDOG_POLL_MS = 100;

/** @public */
export type NabrahRecognitionModel = 'eot_nabrah' | '';

/** @public */
export interface STTOptions {
  apiKey?: string;
  baseUrl: string;
  recognitionModel: NabrahRecognitionModel | string;
  language: string;
  endOfUtteranceSilenceMs: number;
  disableNumberNormalization: boolean;
  priorityWords: string[];
  priorityWordsStrength: number;
  /** Finalize after this many milliseconds without new transcript text. Disabled when null. */
  maxTranscriptInactivity: number | null;
  /** Wait this many milliseconds before committing an end-of-turn signal. Commit immediately when null. */
  endOfTurnConfirmDelay: number | null;
}

const defaultSTTOptions: Omit<STTOptions, 'apiKey'> = {
  baseUrl: DEFAULT_BASE_URL,
  recognitionModel: 'eot_nabrah',
  language: 'ar-SA',
  endOfUtteranceSilenceMs: -1,
  disableNumberNormalization: false,
  priorityWords: [],
  priorityWordsStrength: 0.5,
  maxTranscriptInactivity: null,
  endOfTurnConfirmDelay: 400,
};

type TranscriptMessage = Record<string, unknown>;

function stripAndDetectEot(newText: string): [string, boolean] {
  const stripped = newText.trimEnd();
  const last = stripped.at(-1) ?? '';
  return [
    newText.replaceAll(EOT_TOKEN, ' '),
    stripped.endsWith(EOT_TOKEN) || EOT_PUNCTUATION.has(last),
  ];
}

function normalizeWhitespace(text: string): string {
  return text.trim().split(/\s+/u).filter(Boolean).join(' ');
}

function appendText(existing: string, next: string): string {
  const head = next.trimStart().at(0) ?? '';
  const separator = !existing || NO_SPACE_BEFORE.has(head) ? '' : ' ';
  return normalizeWhitespace(existing + separator + next);
}

function wordText(word: Record<string, unknown>): string {
  const value = word.word ?? '';
  if (typeof value !== 'string') throw new Error('nabrah word text must be a string');
  return value.replaceAll(EOT_TOKEN, '').trim();
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`nabrah ${field} must be finite and non-negative`);
  }
  return value;
}

function timedWord(word: Record<string, unknown>, offset: number): TimedString {
  const startTime = finiteNumber(word.start_time ?? 0, 'word start_time');
  const endTime = finiteNumber(word.end_time ?? 0, 'word end_time');
  if (endTime < startTime) throw new Error('nabrah word end_time must not precede start_time');

  const confidence =
    word.confidence === undefined || word.confidence === null
      ? undefined
      : finiteNumber(word.confidence, 'word confidence');
  return createTimedString({
    text: wordText(word),
    startTime: startTime / 1000 + offset,
    endTime: endTime / 1000 + offset,
    confidence,
  });
}

/** @public */
export class STT extends stt.STT {
  private opts: STTOptions;
  label = 'nabrah.STT (nabrah-stt-v1)';

  constructor(opts: Partial<STTOptions> = {}) {
    const merged = { ...defaultSTTOptions, ...opts };
    const apiKey = opts.apiKey ?? process.env.NABRAH_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Nabrah API key is required, either as an argument or by setting NABRAH_API_KEY',
      );
    }

    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
    });
    this.opts = {
      ...merged,
      apiKey,
      baseUrl: opts.baseUrl ?? process.env.NABRAH_STT_URL ?? DEFAULT_BASE_URL,
    };
  }

  get model(): string {
    return 'nabrah-stt-v1';
  }

  get provider(): string {
    return 'nabrah';
  }

  async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Nabrah STT does not support single-shot recognition');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.opts, options?.connOptions);
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  private opts: STTOptions;
  private connOptions: APIConnectOptions;
  private nabrahLogger = log();
  private isSpeaking = false;
  private turnText = '';
  private utteranceClean = '';
  private utteranceRaw = '';
  private utteranceClosed = false;
  private utteranceFlushedClean = '';
  private utteranceFlushedChars = 0;
  private turnWords: TimedString[] = [];
  private utteranceWords: TimedString[] = [];
  private utteranceFlushedWords = 0;
  private utteranceRawSeen = 0;
  private inputDone = false;
  private segmentStartTime = 0;
  private segmentEndTime = 0;
  private requestId = '';
  private lastProgressAt = 0;
  private pendingEotAt: number | null = null;
  private latestAudioProcessed: number | null = null;
  private audioPosition = 0;
  private reportedAudioPosition = 0;
  private lastMessagePosition = 0;
  label = 'nabrah.SpeechStream';

  constructor(sttInstance: STT, opts: STTOptions, connOptions = DEFAULT_API_CONNECT_OPTIONS) {
    super(sttInstance, SAMPLE_RATE, connOptions);
    this.opts = opts;
    this.connOptions = connOptions;
  }

  protected async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
    this.latestAudioProcessed = null;
    this.audioPosition = 0;
    this.reportedAudioPosition = 0;
    this.lastMessagePosition = 0;
    this.inputDone = false;

    let ws: WebSocket | undefined;
    try {
      ws = await this.connectWebSocket();
      await this.awaitReady(ws);
      await this.runWebSocket(ws);
    } finally {
      if (this.currentText() || this.isSpeaking || this.audioClock() > this.reportedAudioPosition) {
        this.flushEos();
      }
      ws?.close();
    }
  }

  private configFrame(): Record<string, unknown> {
    return {
      api_key: this.opts.apiKey,
      recognition_model: this.opts.recognitionModel,
      end_of_utterance_silence_ms: this.opts.endOfUtteranceSilenceMs,
      disable_number_normalization: this.opts.disableNumberNormalization,
      priority_words: this.opts.priorityWords,
      priority_words_strength: this.opts.priorityWordsStrength,
    };
  }

  private async connectWebSocket(): Promise<WebSocket> {
    const ws = new WebSocket(this.opts.baseUrl);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        waitForWebSocketOpen(ws, 'Nabrah STT'),
        waitForAbort(this.abortSignal).then(() => {
          ws.close();
          throw new APIConnectionError({
            message: 'Nabrah STT connection cancelled',
            options: { retryable: false },
          });
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            ws.terminate();
            reject(new APIConnectionError({ message: 'failed to connect to Nabrah STT' }));
          }, this.connOptions.timeoutMs);
        }),
      ]);
      return ws;
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({ message: 'failed to connect to Nabrah STT' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async awaitReady(ws: WebSocket): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
      };
      const onMessage = (message: Buffer) => {
        let payload: unknown;
        try {
          payload = JSON.parse(message.toString());
        } catch {
          cleanup();
          reject(new APIConnectionError({ message: 'Nabrah STT sent an invalid ready response' }));
          return;
        }
        if (!payload || typeof payload !== 'object') {
          cleanup();
          reject(new APIConnectionError({ message: 'Nabrah STT sent an invalid ready response' }));
          return;
        }
        const type = (payload as Record<string, unknown>).type;
        if (type === 'error') {
          cleanup();
          reject(
            new APIStatusError({
              message: 'Nabrah STT rejected the configuration',
              options: { statusCode: -1, retryable: false },
            }),
          );
        } else if (type === 'ready') {
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new APIConnectionError({ message: 'Nabrah STT closed before ready' }));
      };
      const onError = () => {
        cleanup();
        reject(new APIConnectionError({ message: 'Nabrah STT ready handshake failed' }));
      };
      ws.on('message', onMessage);
      ws.once('close', onClose);
      ws.once('error', onError);
    });

    try {
      ws.send(JSON.stringify(this.configFrame()));
    } catch (error) {
      throw new APIConnectionError({
        message: `Nabrah STT configuration send failed (${errorName(error)})`,
      });
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        waitForAbort(this.abortSignal).then(() => {
          ws.close();
          throw new APIConnectionError({
            message: 'Nabrah STT ready handshake cancelled',
            options: { retryable: false },
          });
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new APIConnectionError({ message: 'Nabrah STT never sent ready' })),
            this.connOptions.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async runWebSocket(ws: WebSocket): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.abortSignal, controller.signal]);
    const watchdog = this.eotWatchdog(signal);
    const send = this.sendAudio(ws, signal);
    const receive = this.receiveMessages(ws, signal);
    try {
      await Promise.race([Promise.all([send, receive]), waitForAbort(signal)]);
    } finally {
      controller.abort();
      await Promise.allSettled([watchdog, send, receive]);
    }
  }

  private async eotWatchdog(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, WATCHDOG_POLL_MS)),
        waitForAbort(signal),
      ]);
      if (signal.aborted) return;

      const now = performance.now();
      if (
        this.opts.endOfTurnConfirmDelay !== null &&
        this.pendingEotAt !== null &&
        now - this.pendingEotAt >= this.opts.endOfTurnConfirmDelay
      ) {
        this.flushEos();
        continue;
      }
      if (
        this.opts.maxTranscriptInactivity !== null &&
        this.currentText() &&
        now - this.lastProgressAt >= this.opts.maxTranscriptInactivity
      ) {
        this.flushEos();
      }
    }
  }

  private async sendAudio(ws: WebSocket, signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const result = await this.input.next({ signal });
        if (result.done) break;
        const data = result.value;
        if (data === SpeechStream.FLUSH_SENTINEL) continue;
        if (data.data.byteLength > 0) {
          this.audioPosition += data.samplesPerChannel / data.sampleRate;
          ws.send(Buffer.from(data.data.buffer, data.data.byteOffset, data.data.byteLength));
        }
      }
      if (signal.aborted) return;
      this.inputDone = true;
      ws.send(JSON.stringify({ type: 'eof' }));
    } catch (error) {
      if (signal.aborted) return;
      throw this.streamFailure(`Nabrah STT send failed (${errorName(error)})`);
    }
  }

  private async receiveMessages(ws: WebSocket, signal: AbortSignal): Promise<void> {
    const messages = new Promise<void>((resolve, reject) => {
      ws.on('message', (message) => {
        try {
          this.handleMessage(message.toString());
        } catch (error) {
          reject(error);
        }
      });
      ws.once('close', () => {
        if (this.inputDone) resolve();
        else reject(this.streamFailure('Nabrah STT closed unexpectedly'));
      });
      ws.once('error', () => reject(this.streamFailure('Nabrah STT WebSocket failed')));
    });
    await Promise.race([messages, waitForAbort(signal)]);
  }

  /** @internal */
  handleMessage(message: string): void {
    try {
      this.processMessage(JSON.parse(message) as TranscriptMessage);
    } catch (error) {
      if (error instanceof APIError) throw error;
      // Provider payloads can contain customer transcripts, so do not attach either here.
      this.nabrahLogger.warn('Nabrah STT returned malformed data');
    }
  }

  /** @internal */
  streamFailure(message: string): APIConnectionError {
    return new APIConnectionError({
      message,
      options: { retryable: this.audioPosition === 0 },
    });
  }

  private emit(event: stt.SpeechEvent): void {
    if (!this.queue.closed) this.queue.put(event);
  }

  private audioClock(): number {
    return this.latestAudioProcessed ?? this.audioPosition;
  }

  private allTurnWords(): TimedString[] {
    return [...this.turnWords, ...this.utteranceWords];
  }

  /** @internal */
  currentText(): string {
    return appendText(this.turnText, this.utteranceClean);
  }

  /** @internal */
  flushEos(): void {
    const text = this.currentText();
    const endTime = this.segmentEndTime || this.audioClock() + this.startTimeOffset;
    const startTime = Math.min(this.segmentStartTime, endTime);

    if (text) {
      const words = this.allTurnWords();
      this.emit({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId: this.requestId,
        alternatives: [speechData(this.opts.language, text, startTime, endTime, words)],
      });
    }

    const audioClock = this.audioClock();
    const usageDuration = audioClock - this.reportedAudioPosition;
    if (usageDuration > 0) {
      this.emit({
        type: stt.SpeechEventType.RECOGNITION_USAGE,
        recognitionUsage: { audioDuration: usageDuration },
      });
      this.reportedAudioPosition = audioClock;
    }

    if (this.isSpeaking) {
      this.emit({
        type: stt.SpeechEventType.END_OF_SPEECH,
        alternatives: [speechData(this.opts.language, '', startTime, endTime)],
      });
    }

    this.utteranceFlushedClean = appendText(this.utteranceFlushedClean, this.utteranceClean);
    this.utteranceFlushedChars = this.utteranceFlushedClean.length;
    this.utteranceFlushedWords = this.utteranceRawSeen;
    this.turnText = '';
    this.utteranceClean = '';
    this.turnWords = [];
    this.utteranceWords = [];
    this.isSpeaking = false;
    this.pendingEotAt = null;
    this.segmentStartTime = 0;
    this.segmentEndTime = 0;
    this.requestId = '';
  }

  private emitPreflight(): void {
    const text = this.currentText();
    if (!text) return;
    this.emit({
      type: stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
      requestId: this.requestId,
      alternatives: [
        speechData(this.opts.language, text, this.segmentStartTime, this.segmentEndTime),
      ],
    });
  }

  /** @internal */
  processMessage(data: TranscriptMessage): void {
    const messageType = data.type;
    if (messageType === 'error') {
      throw new APIStatusError({
        message: 'Nabrah STT reported an error',
        options: { statusCode: -1, retryable: false },
      });
    }
    if (messageType !== 'transcript') return;

    const text = data.text ?? '';
    if (typeof text !== 'string') throw new Error('nabrah text must be a string');
    const isFinal = data.is_final ?? false;
    if (typeof isFinal !== 'boolean') throw new Error('nabrah is_final must be a boolean');

    const previousAudioPosition = this.lastMessagePosition;
    if (data.audio_processed !== undefined && data.audio_processed !== null) {
      const reported = finiteNumber(data.audio_processed, 'audio_processed');
      if (this.latestAudioProcessed === null || reported > this.latestAudioProcessed) {
        this.latestAudioProcessed = reported;
      }
    }
    this.lastMessagePosition = this.audioClock();
    if (!text) return;

    const [cleanText] = stripAndDetectEot(text);
    const cleanNow = normalizeWhitespace(cleanText);
    if (this.utteranceClosed) {
      this.turnText = appendText(this.turnText, this.utteranceClean);
      this.utteranceClean = '';
      this.utteranceRaw = '';
      this.utteranceFlushedClean = '';
      this.utteranceFlushedChars = 0;
      this.turnWords.push(...this.utteranceWords);
      this.utteranceWords = [];
      this.utteranceFlushedWords = 0;
      this.utteranceRawSeen = 0;
    }
    this.utteranceClosed = false;

    const rawWords = data.words ?? [];
    if (!Array.isArray(rawWords)) throw new Error('nabrah words must be an array');
    if (rawWords.length > 0) {
      this.utteranceWords = rawWords
        .slice(this.utteranceFlushedWords)
        .map((word) => {
          if (!word || typeof word !== 'object') throw new Error('nabrah word must be an object');
          return word as Record<string, unknown>;
        })
        .filter((word) => wordText(word))
        .map((word) => timedWord(word, this.startTimeOffset));
      this.utteranceRawSeen = rawWords.length;
    }

    const newText = text.startsWith(this.utteranceRaw)
      ? text.slice(this.utteranceRaw.length)
      : text;
    const [, isEot] = stripAndDetectEot(newText);
    this.utteranceClean = cleanNow.slice(this.utteranceFlushedChars);
    this.utteranceRaw = text;
    if (isFinal) this.utteranceClosed = true;
    if (!newText) return;

    const hasRealProgress = Boolean(newText.replaceAll(EOT_TOKEN, '').trim());
    if (hasRealProgress) {
      this.lastProgressAt = performance.now();
      this.pendingEotAt = null;
      const words = this.allTurnWords();
      const wordStart = words.at(0)?.startTime;
      const wordEnd = words.at(-1)?.endTime;
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.segmentStartTime =
          wordStart ?? Math.min(previousAudioPosition, this.audioClock()) + this.startTimeOffset;
        this.emit({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
      this.segmentEndTime = wordEnd ?? this.audioClock() + this.startTimeOffset;
    }

    if (!this.requestId) this.requestId = `nabrah-${randomUUID()}`;
    const current = this.currentText();
    if (current) {
      this.emit({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [speechData(this.opts.language, current)],
      });
    }

    if (isEot) {
      if (this.opts.endOfTurnConfirmDelay === null) {
        this.flushEos();
      } else if (this.pendingEotAt === null) {
        this.pendingEotAt = performance.now();
        this.emitPreflight();
      }
    }
  }
}

function speechData(
  language: string,
  text: string,
  startTime = 0,
  endTime = 0,
  words?: TimedString[],
): stt.SpeechData {
  return {
    language: language as LanguageCode,
    text,
    startTime,
    endTime,
    confidence: 0,
    words: words?.length ? words : undefined,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
