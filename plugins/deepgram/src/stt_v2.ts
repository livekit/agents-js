// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  AudioByteStream,
  Event,
  calculateAudioDurationSeconds,
  createTimedString,
  log,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import * as queryString from 'node:querystring';
import { WebSocket } from 'ws';
import { PeriodicCollector } from './_utils.js';
import type { V2Models } from './models.js';

const _CLOSE_MSG = JSON.stringify({ type: 'CloseStream' });

type ReceiveTaskResult =
  | { status: 'expected-close' }
  | { status: 'unexpected-close'; message: string };

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
  /**
   * List of language hints to bias the model for improved accuracy.
   * Only usable with `flux-general-multi`.
   */
  // Ref: python livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/stt_v2.py - 61 line
  languageHint?: string[];
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
  // session keyterm propagation)
  #streams = new Set<WeakRef<SpeechStreamv2>>();
  #userKeyterms: string[];
  #sessionKeyterms: string[] = [];

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
   * @param opts.languageHint - List of language hints to bias the model for improved accuracy.
   *   Only usable with `flux-general-multi`.
   *
   * @throws Error if no API key is provided
   */
  constructor(opts: Partial<STTv2Options> = {}) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
      keyterms: true,
    });

    this.#opts = {
      ...defaultSTTv2Options,
      ...opts,
      language: opts.language ? normalizeLanguage(opts.language) : defaultSTTv2Options.language,
    };
    this.#userKeyterms = [...this.#opts.keyterms];

    const apiKey = opts.apiKey || process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error('Deepgram API key is required');
    }
    this.#apiKey = apiKey;

    if (this.#opts.tags) {
      this.#opts.tags = validateTags(this.#opts.tags);
    }

    // Ref: python livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/stt_v2.py - 134-138 lines
    if (
      this.#opts.languageHint &&
      this.#opts.languageHint.length > 0 &&
      this.#opts.model !== 'flux-general-multi'
    ) {
      this.#logger.warn(
        { model: this.#opts.model },
        '`languageHint` is only supported by `flux-general-multi` and will be ignored for this model',
      );
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
    const stream = new SpeechStreamv2(this, streamOpts, options?.connOptions);
    this.#streams.add(new WeakRef(stream));
    return stream;
  }

  /**
   * Update STT options. Changes will take effect on the next stream.
   *
   * @param opts - Partial options to update
   */
  updateOptions(opts: Partial<STTv2Options>) {
    const nextOpts = { ...opts };
    if (nextOpts.keyterms !== undefined) {
      this.#userKeyterms = [...nextOpts.keyterms];
      nextOpts.keyterms = [...new Set([...this.#userKeyterms, ...this.#sessionKeyterms])];
    }
    this.#opts = {
      ...this.#opts,
      ...nextOpts,
      language:
        opts.language !== undefined ? normalizeLanguage(opts.language) : this.#opts.language,
    };
    if (opts.tags) this.#opts.tags = validateTags(opts.tags);
    // Ref: python livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/stt_v2.py - 244-249 lines
    if (
      this.#opts.languageHint &&
      this.#opts.languageHint.length > 0 &&
      this.#opts.model !== 'flux-general-multi'
    ) {
      this.#logger.warn(
        { model: this.#opts.model },
        '`languageHint` is only supported by `flux-general-multi` and will be ignored for this model',
      );
    }
    this.#logger.debug('Updated STTv2 options');
  }

  override _updateSessionKeyterms(keyterms: string[]): void {
    if (
      keyterms.length === this.#sessionKeyterms.length &&
      keyterms.every((t, i) => t === this.#sessionKeyterms[i])
    ) {
      return;
    }
    this.#sessionKeyterms = [...keyterms];
    const merged = [...new Set([...this.#userKeyterms, ...keyterms])];
    this.#opts.keyterms = merged;
    for (const ref of this.#streams) {
      const stream = ref.deref();
      if (!stream) {
        this.#streams.delete(ref);
        continue;
      }
      if (stream._speaking) {
        // defer the reconnect to the end of the utterance so we don't cut it off
        stream._pendingKeyterm = merged;
      } else {
        stream.updateOptions({ keyterms: merged });
      }
    }
  }
}

// --- Stream Implementation ---

class SpeechStreamv2 extends stt.SpeechStream {
  readonly label = 'deepgram.SpeechStreamv2';
  #opts: STTv2Options & { apiKey: string };
  #logger = log();
  #ws: WebSocket | null = null;
  #closingWs = new WeakSet<WebSocket>();

  #audioDurationCollector: PeriodicCollector<number>;
  #requestId = '';
  #speaking = false;

  // Monotonic timestamp base across reconnects. Deepgram's audio_window restarts
  // at 0 on every new socket, so each connection's window times are offset by the
  // audio already streamed to prior connections (#sentAudioInS snapshotted at
  // connect into #connectionTimeBaseInS). Without this, transcripts after a
  // reconnect would be timestamped near the start of the session.
  //
  // The SDK sets startTimeOffset once at stream creation (voice/agent.ts sttNode)
  // and relies on the plugin to keep audio_window continuous across its own
  // reconnects ("linear timestamps across reconnections") — this preserves that.
  #sentAudioInS = 0;
  #connectionTimeBaseInS = 0;

  // Set only when a runtime close reconnects the socket mid-stream. While true,
  // the next transcript-bearing event may re-open speech to recover a turn
  // whose StartOfTurn was delivered on the previous connection. Cleared at
  // clean turn boundaries so steady-state trailing transcripts after EndOfTurn
  // do not open spurious turns.
  #reconnectRecoveryPending = false;

  // Parity: _reconnect_event - using existing Event class from @livekit/agents
  #reconnectEvent = new Event();

  // keyterms set while the user is speaking; applied at END_OF_SPEECH (latest wins)
  /** @internal */
  _pendingKeyterm: string[] | null = null;

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

  /** @internal */
  get _speaking(): boolean {
    return this.#speaking;
  }

  updateOptions(opts: Partial<STTv2Options>) {
    this.#logger.debug('Stream received option update', opts);
    this.#opts = {
      ...this.#opts,
      ...opts,
      language:
        opts.language !== undefined ? normalizeLanguage(opts.language) : this.#opts.language,
    };
    if (opts.tags) this.#opts.tags = validateTags(opts.tags);
    if (opts.keyterms !== undefined) {
      this._pendingKeyterm = null;
    }

    // Trigger reconnection loop
    this.#reconnectEvent.set();
  }

  #onEndOfSpeech() {
    if (this._pendingKeyterm !== null) {
      this.updateOptions({ keyterms: this._pendingKeyterm });
      this._pendingKeyterm = null;
    }
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

        // Snapshot the timeline base for this connection: the fresh socket's
        // audio_window starts at 0, so offset it by the audio already streamed.
        this.#connectionTimeBaseInS = this.#sentAudioInS;

        // 2. Run Concurrent Tasks (Send & Receive)
        const ws = this.#ws;
        if (!ws) throw new Error('WebSocket not initialized');

        const wsClosedEvent = new Event();
        const sendPromise = this.#sendTask(ws, wsClosedEvent);
        const recvPromise = this.#recvTask(ws, wsClosedEvent);
        const reconnectWait = this.#reconnectEvent.wait();

        // 3. Race: Normal Completion vs Reconnect Signal
        const streamTasks = Promise.all([sendPromise, recvPromise]) as Promise<
          [void, ReceiveTaskResult]
        >;
        const result = await Promise.race([
          streamTasks,
          reconnectWait.then(() => 'RECONNECT' as const),
        ]);

        if (result === 'RECONNECT') {
          this.#logger.debug('Reconnecting stream due to option update...');
          // Close current socket; loop will restart and open a new one
          this.#expectWsClose(this.#ws);
          this.#ws.close();
        } else {
          const [, receiveResult] = result;
          if (receiveResult.status === 'unexpected-close') {
            this.#reconnectRecoveryPending = this.#sentAudioInS > this.#connectionTimeBaseInS;
            throw new APIConnectionError({ message: receiveResult.message });
          }

          // Normal finish (Stream ended or Error thrown)
          break;
        }
      } catch (error) {
        this.#logger.error('Deepgram stream error', { error });
        throw error; // Let Base Class handle retry logic
      } finally {
        if (this.#ws?.readyState === WebSocket.OPEN) {
          this.#expectWsClose(this.#ws);
          this.#ws.close();
        }
      }
    }
    this.close();
  }

  async #sendTask(ws: WebSocket, wsClosedEvent: Event) {
    // Buffer audio into 50ms chunks (Parity)
    const samples50ms = Math.floor(this.#opts.sampleRate / 20);
    const audioBstream = new AudioByteStream(this.#opts.sampleRate, 1, samples50ms);

    // Manual Iterator to allow racing against Reconnect Signal
    const iterator = this.input[Symbol.asyncIterator]();
    const sendFrames = (frames: AudioFrame[]) => {
      for (const frame of frames) {
        const durationInS = calculateAudioDurationSeconds(frame);
        this.#audioDurationCollector.push(durationInS);
        // Track total audio consumed so reconnects can preserve the timeline.
        this.#sentAudioInS += durationInS;

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(frame.data);
        }
      }
    };

    while (true) {
      const nextPromise = iterator.next();
      // If reconnect or WebSocket close fires, abort the wait
      const abortPromise = Promise.race([this.#reconnectEvent.wait(), wsClosedEvent.wait()]).then(
        () => ({ abort: true }) as const,
      );

      const result = await Promise.race([nextPromise, abortPromise]);

      // Check if we need to abort (Reconnect) or if stream is done
      if ('abort' in result || result.done) {
        break;
      }

      const data = result.value;

      if (data === SpeechStreamv2.FLUSH_SENTINEL) {
        sendFrames(audioBstream.flush());
        this.#audioDurationCollector.flush();
        continue;
      }

      sendFrames(audioBstream.write((data as AudioFrame).data.buffer as ArrayBuffer));
    }

    // Only send CloseStream if we are exiting normally (not reconnecting)
    if (!this.#reconnectEvent.isSet && !wsClosedEvent.isSet && ws.readyState === WebSocket.OPEN) {
      this.#logger.debug('Sending CloseStream message to Deepgram');
      this.#expectWsClose(ws);
      ws.send(_CLOSE_MSG);
    }
  }

  async #recvTask(ws: WebSocket, wsClosedEvent: Event): Promise<ReceiveTaskResult> {
    return new Promise<ReceiveTaskResult>((resolve) => {
      let wsError: Error | undefined;

      ws.on('message', (data: Buffer, isBinary: boolean) => {
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

      ws.on('close', (code, reason) => {
        wsClosedEvent.set();
        this.#logger.debug(`Deepgram WebSocket closed: ${code} ${reason}`);

        if (this.#closingWs.has(ws) || this.closed || this.input.closed) {
          resolve({ status: 'expected-close' });
          return;
        }

        const reasonText = reason.toString();
        const message = reasonText
          ? `Deepgram WebSocket closed unexpectedly: ${code} ${reasonText}`
          : `Deepgram WebSocket closed unexpectedly: ${code}`;
        resolve({
          status: 'unexpected-close',
          message: wsError ? `${message}: ${wsError.message}` : message,
        });
      });

      ws.on('error', (error) => {
        wsError = error;
      });
    });
  }

  #processStreamEvent(data: Record<string, unknown>) {
    if (data.request_id) {
      this.#requestId = data.request_id as string;
    }

    if (data.type === 'TurnInfo') {
      const eventType = data.event;

      if (eventType === 'StartOfTurn') {
        this.#reconnectRecoveryPending = false;
        if (!this.#speaking) this.#startSpeech();

        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, data);
      } else if (eventType === 'Update') {
        if (!this.#speaking && !this.#startSpeechFromTranscript(data)) return;
        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, data);
      } else if (eventType === 'EagerEndOfTurn') {
        if (!this.#speaking && !this.#startSpeechFromTranscript(data)) return;
        this.#sendTranscriptEvent(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, data);
      } else if (eventType === 'TurnResumed') {
        if (!this.#speaking) this.#startSpeechFromTranscript(data);
        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, data);
      } else if (eventType === 'EndOfTurn') {
        if (!this.#speaking && !this.#startSpeechFromTranscript(data)) return;

        this.#speaking = false;
        this.#reconnectRecoveryPending = false;
        this.#sendTranscriptEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, data);
        this.resetRetryBudget();

        this.queue.put({
          type: stt.SpeechEventType.END_OF_SPEECH,
          requestId: this.#requestId,
        });
        this.#onEndOfSpeech();
      }
    } else if (data.type === 'Error') {
      this.#logger.warn('deepgram sent an error', { data });
      const desc = (data.description as string) || 'unknown error from deepgram';
      throw new Error(`Deepgram API Error: ${desc}`);
    }
  }

  #startSpeech() {
    if (this.#speaking) return;

    this.#speaking = true;
    this.queue.put({
      type: stt.SpeechEventType.START_OF_SPEECH,
      requestId: this.#requestId,
    });
  }

  #startSpeechFromTranscript(data: Record<string, unknown>) {
    if (!this.#reconnectRecoveryPending) return false;

    const transcript = data.transcript;
    if (typeof transcript !== 'string' || transcript.trim().length === 0) {
      return false;
    }

    this.#startSpeech();
    return true;
  }

  #sendTranscriptEvent(eventType: stt.SpeechEventType, data: Record<string, unknown>) {
    const alts = parseTranscription(
      this.#opts.language || 'en',
      data,
      this.startTimeOffset + this.#connectionTimeBaseInS,
    );

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

    // Ref: python livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/stt_v2.py - 480-481 lines
    if (this.#opts.languageHint && this.#opts.languageHint.length > 0) {
      params.language_hint = this.#opts.languageHint;
    }

    const baseUrl = this.#opts.endpointUrl.replace(/^http/, 'ws');
    const qs = queryString.stringify(params);
    return `${baseUrl}?${qs}`;
  }

  #expectWsClose(ws: WebSocket | null) {
    if (ws) {
      this.#closingWs.add(ws);
    }
  }

  override close() {
    this.#expectWsClose(this.#ws);
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

  // Ref: python livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/stt_v2.py - 587-591 lines
  const detectedLanguagesRaw = Array.isArray(data.languages) ? (data.languages as string[]) : [];
  const detectedLanguages = detectedLanguagesRaw.map((lang) => normalizeLanguage(lang));
  const primaryLanguage =
    detectedLanguages.length > 0 ? detectedLanguages[0]! : normalizeLanguage(language);

  const sd: stt.SpeechData = {
    language: primaryLanguage,
    startTime: ((data.audio_window_start as number) || 0) + startTimeOffset,
    endTime: ((data.audio_window_end as number) || 0) + startTimeOffset,
    confidence: confidence,
    text: transcript || '',
    // Ref: python livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/stt_v2.py - 598 line
    sourceLanguages: detectedLanguages.length > 0 ? detectedLanguages : undefined,
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
