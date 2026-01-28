// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  Event,
  calculateAudioDurationSeconds,
  createTimedString,
  log,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import * as queryString from 'node:querystring';
import { WebSocket } from 'ws';
import { PeriodicCollector } from './_utils.js';
import type { V2Models } from './models.js';

const _CLOSE_MSG = JSON.stringify({ type: 'CloseStream' });

// --- Configuration ---

/**
 * Configuration options for STTv2 (Deepgram Flux model).
 */
export interface STTv2Options {
  apiKey?: string;
  model: V2Models | string;
  sampleRate: number;
  keyterms: string[];
  endpointUrl: string;
  language?: string;
  eagerEotThreshold?: number;
  eotThreshold?: number;
  eotTimeoutMs?: number;
  mipOptOut?: boolean;
  tags?: string[];
}

const defaultSTTv2Options: Omit<STTv2Options, 'apiKey'> = {
  model: 'flux-general-en',
  sampleRate: 16000,
  keyterms: [],
  endpointUrl: 'wss://api.deepgram.com/v2/listen',
  language: 'en',
  mipOptOut: false,
};

function validateTags(tags: string[]): string[] {
  for (const tag of tags) {
    if (tag.length > 128) {
      throw new Error('tag must be no more than 128 characters');
    }
  }
  return tags;
}

/**
 * Deepgram STTv2 using the Flux model for streaming speech-to-text.
 *
 * This uses Deepgram's V2 API (`/v2/listen`) which provides turn-based
 * transcription with support for preemptive generation.
 *
 * @remarks
 * Key differences from STT (V1):
 * - Uses `TurnInfo` events instead of `SpeechStarted`/`Results`
 * - Supports `eagerEotThreshold` for preemptive LLM generation
 * - Sends `PREFLIGHT_TRANSCRIPT` events when eager end-of-turn is detected
 *
 * @example
 * ```typescript
 * import { STTv2 } from '@livekit/agents-plugin-deepgram';
 *
 * const stt = new STTv2({
 *   model: 'flux-general-en',
 *   eagerEotThreshold: 0.5,  // Enable preemptive generation
 * });
 *
 * const stream = stt.stream();
 * stream.pushFrame(audioFrame);
 *
 * for await (const event of stream) {
 *   if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
 *     console.log(event.alternatives?.[0]?.text);
 *   }
 * }
 * ```
 */
export class STTv2 extends stt.STT {
  readonly label = 'deepgram.STTv2';
  #opts: STTv2Options;
  #apiKey: string;
  #logger = log();

  /**
   * Create a new Deepgram STTv2 instance.
   *
   * @param opts - Configuration options
   * @param opts.apiKey - Deepgram API key (defaults to `DEEPGRAM_API_KEY` env var)
   * @param opts.model - Model to use (default: `flux-general-en`)
   * @param opts.eagerEotThreshold - Threshold (0.3-0.9) for preemptive generation
   * @param opts.eotThreshold - End-of-turn detection threshold (default: 0.7)
   * @param opts.eotTimeoutMs - End-of-turn timeout in ms (default: 3000)
   * @param opts.keyterms - List of key terms to improve recognition
   * @param opts.tags - Tags for usage reporting (max 128 chars each)
   *
   * @throws Error if no API key is provided
   */
  constructor(opts: Partial<STTv2Options> = {}) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
    });

    this.#opts = { ...defaultSTTv2Options, ...opts };

    const apiKey = opts.apiKey || process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error('Deepgram API key is required');
    }
    this.#apiKey = apiKey;

    if (this.#opts.tags) {
      this.#opts.tags = validateTags(this.#opts.tags);
    }
  }

  /** The model being used for transcription */
  get model(): string {
    return this.#opts.model;
  }

  /** The STT provider name */
  get provider(): string {
    return 'Deepgram';
  }

  protected async _recognize(
    _frame: AudioFrame | AudioFrame[],
    _abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    throw new Error('V2 API does not support non-streaming recognize. Use .stream()');
  }

  /**
   * Create a new streaming transcription session.
   *
   * @param options - Stream options
   * @returns A SpeechStream that emits transcription events
   */
  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    const streamOpts = { ...this.#opts, apiKey: this.#apiKey };
    return new SpeechStreamv2(this, streamOpts, options?.connOptions);
  }

  /**
   * Update STT options. Changes will take effect on the next stream.
   *
   * @param opts - Partial options to update
   */
  updateOptions(opts: Partial<STTv2Options>) {
    this.#opts = { ...this.#opts, ...opts };
    if (opts.tags) this.#opts.tags = validateTags(opts.tags);
    this.#logger.debug('Updated STTv2 options');
  }
}

// --- Stream Implementation ---

class SpeechStreamv2 extends stt.SpeechStream {
  readonly label = 'deepgram.SpeechStreamv2';
  #opts: STTv2Options & { apiKey: string };
  #logger = log();
  #ws: WebSocket | null = null;

  #audioDurationCollector: PeriodicCollector<number>;
  #requestId = '';
  #speaking = false;

  // Parity: _reconnect_event - using existing Event class from @livekit/agents
  #reconnectEvent = new Event();

  constructor(
    sttInstance: STTv2,
    opts: STTv2Options & { apiKey: string },
    connOptions?: APIConnectOptions,
  ) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = opts;

    this.#audioDurationCollector = new PeriodicCollector(
      (duration) => this.#onAudioDurationReport(duration),
      { duration: 5.0 },
    );
  }

  updateOptions(opts: Partial<STTv2Options>) {
    this.#logger.debug('Stream received option update', opts);
    this.#opts = { ...this.#opts, ...opts };
    if (opts.tags) this.#opts.tags = validateTags(opts.tags);

    // Trigger reconnection loop
    this.#reconnectEvent.set();
  }

  protected async run() {
    // Outer Loop: Handles reconnections (Configuration updates)
    while (!this.closed) {
      try {
        this.#reconnectEvent.clear();

        const url = this.#getDeepgramUrl();
        this.#logger.debug(`Connecting to Deepgram: ${url}`);

        this.#ws = new WebSocket(url, {
          headers: { Authorization: `Token ${this.#opts.apiKey}` },
        });

        // 1. Wait for Connection Open
        await new Promise<void>((resolve, reject) => {
          if (!this.#ws) return reject(new Error('WebSocket not initialized'));

          const onOpen = () => {
            this.#ws?.off('error', onError);
            resolve();
          };
          const onError = (err: Error) => {
            this.#ws?.off('open', onOpen);
            reject(err);
          };

          this.#ws.once('open', onOpen);
          this.#ws.once('error', onError);
        });

        // 2. Run Concurrent Tasks (Send & Receive)
        const sendPromise = this.#sendTask();
        const recvPromise = this.#recvTask();
        const reconnectWait = this.#reconnectEvent.wait();

        // 3. Race: Normal Completion vs Reconnect Signal
        const result = await Promise.race([
          Promise.all([sendPromise, recvPromise]),
          reconnectWait.then(() => 'RECONNECT'),
        ]);

        if (result === 'RECONNECT') {
          this.#logger.debug('Reconnecting stream due to option update...');
          // Close current socket; loop will restart and open a new one
          this.#ws.close();
        } else {
          // Normal finish (Stream ended or Error thrown)
          break;
        }
      } catch (error) {
        this.#logger.error('Deepgram stream error', { error });
        throw error; // Let Base Class handle retry logic
      } finally {
        if (this.#ws?.readyState === WebSocket.OPEN) {
          this.#ws.close();
        }
      }
    }
    this.close();
  }

  async #sendTask() {
    if (!this.#ws) return;

    // Buffer audio into 50ms chunks (Parity)
    const samples50ms = Math.floor(this.#opts.sampleRate / 20);
    const audioBstream = new AudioByteStream(this.#opts.sampleRate, 1, samples50ms);

    let hasEnded = false;

    // Manual Iterator to allow racing against Reconnect Signal
    const iterator = this.input[Symbol.asyncIterator]();

    while (true) {
      const nextPromise = iterator.next();
      // If reconnect signal fires, abort the wait
      const abortPromise = this.#reconnectEvent.wait().then(() => ({ abort: true }) as const);

      const result = await Promise.race([nextPromise, abortPromise]);

      // Check if we need to abort (Reconnect) or if stream is done
      if ('abort' in result || result.done) {
        if (!('abort' in result) && result.done) {
          // Normal stream end
          hasEnded = true;
        } else {
          // Reconnect triggered - break loop immediately
          break;
        }
      }

      // If we broke above, we don't process data. If not, 'result' is IteratorResult
      if (hasEnded && !('value' in result)) {
        // Process flush below
      } else if ('value' in result) {
        const data = result.value;
        const frames: AudioFrame[] = [];

        if (data === SpeechStreamv2.FLUSH_SENTINEL) {
          frames.push(...audioBstream.flush());
          hasEnded = true;
        } else {
          frames.push(...audioBstream.write((data as AudioFrame).data.buffer as ArrayBuffer));
        }

        for (const frame of frames) {
          this.#audioDurationCollector.push(calculateAudioDurationSeconds(frame));

          if (this.#ws!.readyState === WebSocket.OPEN) {
            this.#ws!.send(frame.data);
          }

          if (hasEnded) {
            this.#audioDurationCollector.flush();
            hasEnded = false;
          }
        }
      }

      if (hasEnded) break;
    }

    // Only send CloseStream if we are exiting normally (not reconnecting)
    if (!this.#reconnectEvent.isSet && this.#ws!.readyState === WebSocket.OPEN) {
      this.#logger.debug('Sending CloseStream message to Deepgram');
      this.#ws!.send(_CLOSE_MSG);
    }
  }

  async #recvTask() {
    if (!this.#ws) return;

    return new Promise<void>((resolve) => {
      if (!this.#ws) return resolve();

      this.#ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.#logger.warn('Received unexpected binary message from Deepgram');
          return;
        }
        try {
          const msg = JSON.parse(data.toString());
          this.#processStreamEvent(msg);
        } catch (error) {
          this.#logger.error('Failed to parse Deepgram message', { error });
        }
      });

      this.#ws.on('close', (code, reason) => {
        this.#logger.debug(`Deepgram WebSocket closed: ${code} ${reason}`);
        resolve();
      });

      // Errors are caught by run() listener, resolve here to clean up task
      this.#ws.on('error', () => resolve());
    });
  }

  #processStreamEvent(data: Record<string, unknown>) {
    if (data.request_id) {
      this.#requestId = data.request_id as string;
    }

    if (data.type === 'TurnInfo') {
      const eventType = data.event;

      if (eventType === 'StartOfTurn') {
        if (this.#speaking) return;

        this.#speaking = true;
        this.queue.put({
          type: stt.SpeechEventType.START_OF_SPEECH,
          requestId: this.#requestId,
        });

        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, data);
      } else if (eventType === 'Update') {
        if (!this.#speaking) return;
        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, data);
      } else if (eventType === 'EagerEndOfTurn') {
        if (!this.#speaking) return;
        this.#sendTranscriptEvent(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, data);
      } else if (eventType === 'TurnResumed') {
        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, data);
      } else if (eventType === 'EndOfTurn') {
        if (!this.#speaking) return;

        this.#speaking = false;
        this.#sendTranscriptEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, data);

        this.queue.put({
          type: stt.SpeechEventType.END_OF_SPEECH,
          requestId: this.#requestId,
        });
      }
    } else if (data.type === 'Error') {
      this.#logger.warn('deepgram sent an error', { data });
      const desc = (data.description as string) || 'unknown error from deepgram';
      throw new Error(`Deepgram API Error: ${desc}`);
    }
  }

  #sendTranscriptEvent(eventType: stt.SpeechEventType, data: Record<string, unknown>) {
    const alts = parseTranscription(this.#opts.language || 'en', data, this.startTimeOffset);

    if (alts.length > 0) {
      this.queue.put({
        type: eventType,
        requestId: this.#requestId,
        alternatives: [alts[0]!, ...alts.slice(1)],
      });
    }
  }

  #onAudioDurationReport(duration: number) {
    const usageEvent: stt.SpeechEvent = {
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: {
        audioDuration: duration,
      },
    };
    this.queue.put(usageEvent);
  }

  #getDeepgramUrl(): string {
    const params: Record<string, string | string[]> = {
      model: this.#opts.model,
      sample_rate: this.#opts.sampleRate.toString(),
      encoding: 'linear16',
      mip_opt_out: String(this.#opts.mipOptOut),
    };

    // Note: v2 API does NOT include 'language' parameter
    if (this.#opts.eagerEotThreshold)
      params.eager_eot_threshold = this.#opts.eagerEotThreshold.toString();
    if (this.#opts.eotThreshold) params.eot_threshold = this.#opts.eotThreshold.toString();
    if (this.#opts.eotTimeoutMs) params.eot_timeout_ms = this.#opts.eotTimeoutMs.toString();

    if (this.#opts.keyterms.length > 0) params.keyterm = this.#opts.keyterms;
    if (this.#opts.tags && this.#opts.tags.length > 0) params.tag = this.#opts.tags;

    const baseUrl = this.#opts.endpointUrl.replace(/^http/, 'ws');
    const qs = queryString.stringify(params);
    return `${baseUrl}?${qs}`;
  }

  override close() {
    super.close();
    this.#ws?.close();
  }
}

// --- Helpers ---

function parseTranscription(
  language: string,
  data: Record<string, unknown>,
  startTimeOffset: number,
): stt.SpeechData[] {
  const transcript = data.transcript as string | undefined;
  const wordsData = (data.words as Array<Record<string, unknown>>) || [];

  if (!wordsData || wordsData.length === 0) {
    return [];
  }

  let confidence = 0;
  if (wordsData.length > 0) {
    const sum = wordsData.reduce((acc: number, w) => acc + ((w.confidence as number) || 0), 0);
    confidence = sum / wordsData.length;
  }

  const sd: stt.SpeechData = {
    language: language,
    startTime: ((data.audio_window_start as number) || 0) + startTimeOffset,
    endTime: ((data.audio_window_end as number) || 0) + startTimeOffset,
    confidence: confidence,
    text: transcript || '',
    // Note: Deepgram V2 (Flux) API does not provide word-level timing (start/end).
    // Words only contain 'word' and 'confidence' fields, so startTime/endTime will be 0.
    // See: https://developers.deepgram.com/docs/flux/nova-3-migration
    words: wordsData.map((word) =>
      createTimedString({
        text: (word.word as string) ?? '',
        startTime: ((word.start as number) ?? 0) + startTimeOffset,
        endTime: ((word.end as number) ?? 0) + startTimeOffset,
        confidence: (word.confidence as number) ?? 0.0,
        startTimeOffset,
      }),
    ),
  };

  return [sd];
}
