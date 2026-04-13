// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Ported from:
//   livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py
// See `// Ref: python ... - N-M lines` comments throughout for cross-references.
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  Future,
  Task,
  createTimedString,
  delay,
  log,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import type { STTEncoding, STTModels } from './models.js';

// AssemblyAI Universal-Streaming (v3) message envelope. All fields are optional
// since we narrow on `type` before reading anything else.
interface StreamEventMessage {
  type?: 'Begin' | 'SpeechStarted' | 'Turn' | 'Termination' | string;
  // Begin
  id?: string;
  expires_at?: number;
  // Turn
  transcript?: string;
  utterance?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  language_code?: string;
  words?: Array<{ text?: string; start?: number; end?: number; confidence?: number }>;
  // Termination
  audio_duration_seconds?: number;
  session_duration_seconds?: number;
}

// Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 46-66 lines
export interface STTOptions {
  apiKey?: string;
  sampleRate: number;
  /**
   * How large each chunk of audio is before being sent to AssemblyAI, in
   * milliseconds. Corresponds to Python's `buffer_size_seconds` (seconds there,
   * ms here per this repo's time-unit convention).
   */
  bufferSizeMs: number;
  encoding: STTEncoding;
  speechModel: STTModels;
  languageDetection?: boolean;
  endOfTurnConfidenceThreshold?: number;
  /** Minimum silence (ms) before a confident end-of-turn is finalized. */
  minTurnSilence?: number;
  /** Maximum silence (ms) before end-of-turn is forced regardless of confidence. */
  maxTurnSilence?: number;
  formatTurns?: boolean;
  keytermsPrompt?: string[];
  /** Only supported with the `u3-rt-pro` model. */
  prompt?: string;
  vadThreshold?: number;
  /**
   * Enable speaker diarization. Note: AssemblyAI will return per-word speaker
   * labels, but the JS framework's `stt.SpeechData` type does not yet expose
   * a `speakerId` field (unlike the Python framework), so the labels are not
   * currently surfaced on emitted events. Setting this to `true` still has
   * effect server-side. Once the base `SpeechData` interface gains speaker
   * support, `#processStreamEvent` should forward `data.words[].speaker` too.
   */
  speakerLabels?: boolean;
  maxSpeakers?: number;
  domain?: string;
  baseUrl: string;
}

// Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 72-97 lines
const defaultSTTOptions: STTOptions = {
  apiKey: process.env.ASSEMBLYAI_API_KEY,
  sampleRate: 16000,
  bufferSizeMs: 50,
  encoding: 'pcm_s16le',
  speechModel: 'universal-streaming-english',
  baseUrl: 'wss://streaming.assemblyai.com',
};

// Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 72 lines
export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'assemblyai.STT';

  get model(): string {
    return this.#opts.speechModel;
  }

  get provider(): string {
    return 'AssemblyAI';
  }

  constructor(opts: Partial<STTOptions> = {}) {
    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 111-119 lines
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
    });

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 120-122 lines
    if (opts.speechModel === 'u3-pro') {
      log().warn("'u3-pro' is deprecated, use 'u3-rt-pro' instead.");
      opts.speechModel = 'u3-rt-pro';
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 124-125 lines
    if (opts.prompt !== undefined && opts.speechModel !== 'u3-rt-pro') {
      throw new Error("The 'prompt' parameter is only supported with the 'u3-rt-pro' model.");
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 127-135 lines
    const apiKey = opts.apiKey ?? defaultSTTOptions.apiKey;
    if (!apiKey) {
      throw new Error(
        'AssemblyAI API key is required. Pass one in via the `apiKey` parameter, or set it as the `ASSEMBLYAI_API_KEY` environment variable',
      );
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 147-149 lines
    // Minimize latency; matches LK's end-of-turn detector well.
    const minTurnSilence = opts.minTurnSilence ?? 100;

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      apiKey,
      minTurnSilence,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 185-192 lines
    throw new Error('Non-streaming recognize is not supported on AssemblyAI STT');
  }

  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 212-257 lines
  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 194-210 lines
  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }
}

// Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 260 lines
export class SpeechStream extends stt.SpeechStream {
  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 262 lines
  static readonly CLOSE_MSG = JSON.stringify({ type: 'Terminate' });

  #opts: STTOptions;
  #logger = log();
  #speechDurationInS = 0;
  #lastPreflightStartTime = 0;
  #pendingConfigMessages: Record<string, unknown>[] = [];
  #configMessagePending = new Future();
  #sessionId: string | null = null;
  #expiresAt: number | null = null;
  label = 'assemblyai.SpeechStream';

  constructor(stt: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.closed = false;
  }

  /**
   * The AssemblyAI session ID. Set when the WebSocket connection is established
   * (before any speech events). Null until the connection completes.
   * Share this with the AssemblyAI team when reporting issues.
   */
  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 286-291 lines
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /**
   * Unix timestamp when the AssemblyAI session expires. Set alongside
   * {@link sessionId} when the WebSocket connection is established.
   */
  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 293-297 lines
  get expiresAt(): number | null {
    return this.#expiresAt;
  }

  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 299-351 lines
  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };

    const configMsg: Record<string, unknown> = { type: 'UpdateConfiguration' };
    if (opts.prompt !== undefined) configMsg.prompt = opts.prompt;
    if (opts.keytermsPrompt !== undefined) configMsg.keyterms_prompt = opts.keytermsPrompt;
    if (opts.maxTurnSilence !== undefined) configMsg.max_turn_silence = opts.maxTurnSilence;
    if (opts.minTurnSilence !== undefined) configMsg.min_turn_silence = opts.minTurnSilence;
    if (opts.endOfTurnConfidenceThreshold !== undefined) {
      configMsg.end_of_turn_confidence_threshold = opts.endOfTurnConfidenceThreshold;
    }
    if (opts.vadThreshold !== undefined) configMsg.vad_threshold = opts.vadThreshold;

    // Only send if any actual fields (besides `type`) were specified.
    if (Object.keys(configMsg).length > 1) {
      this.#pendingConfigMessages.push(configMsg);
      if (!this.#configMessagePending.done) this.#configMessagePending.resolve();
    }
  }

  /**
   * Force-finalize the current turn immediately.
   */
  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 353-355 lines
  forceEndpoint() {
    this.#pendingConfigMessages.push({ type: 'ForceEndpoint' });
    if (!this.#configMessagePending.done) this.#configMessagePending.resolve();
  }

  // Deepgram-style reconnect loop around a single websocket lifetime.
  protected async run() {
    const maxRetry = 32;
    let retries = 0;

    while (!this.input.closed && !this.closed) {
      try {
        const ws = await this.#connectWS();
        await this.#runWS(ws);
        retries = 0;
      } catch (e) {
        if (!this.closed && !this.input.closed) {
          if (retries >= maxRetry) {
            throw new Error(`failed to connect to AssemblyAI after ${retries} attempts: ${e}`);
          }

          const retryDelaySeconds = Math.min(retries * 5, 10);
          retries++;

          this.#logger.warn(
            `failed to connect to AssemblyAI, retrying in ${retryDelaySeconds} seconds: ${e} (${retries}/${maxRetry})`,
          );
          await delay(retryDelaySeconds * 1000);
        } else {
          this.#logger.warn(
            `AssemblyAI disconnected, connection is closed: ${e} (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
          );
        }
      }
    }

    this.closed = true;
  }

  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 442-505 lines
  async #connectWS(): Promise<WebSocket> {
    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 443-461 lines
    // u3-rt-pro has different silence defaults — if unset, both min and max default to 100ms.
    let minSilence = this.#opts.minTurnSilence;
    let maxSilence = this.#opts.maxTurnSilence;
    if (this.#opts.speechModel === 'u3-rt-pro') {
      if (minSilence === undefined) minSilence = 100;
      if (maxSilence === undefined) maxSilence = minSilence;
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 476-480 lines
    // Default language_detection to true for multilingual / u3-rt-pro models, false otherwise.
    const defaultLanguageDetection =
      this.#opts.speechModel.includes('multilingual') || this.#opts.speechModel === 'u3-rt-pro';
    const languageDetection = this.#opts.languageDetection ?? defaultLanguageDetection;

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 463-502 lines
    const liveConfig: Record<string, unknown> = {
      sample_rate: this.#opts.sampleRate,
      encoding: this.#opts.encoding,
      speech_model: this.#opts.speechModel,
      format_turns: this.#opts.formatTurns,
      end_of_turn_confidence_threshold: this.#opts.endOfTurnConfidenceThreshold,
      min_turn_silence: minSilence,
      max_turn_silence: maxSilence,
      keyterms_prompt:
        this.#opts.keytermsPrompt !== undefined
          ? JSON.stringify(this.#opts.keytermsPrompt)
          : undefined,
      language_detection: languageDetection,
      prompt: this.#opts.prompt,
      vad_threshold: this.#opts.vadThreshold,
      speaker_labels: this.#opts.speakerLabels,
      max_speakers: this.#opts.maxSpeakers,
      domain: this.#opts.domain,
    };

    const url = new URL(`${this.#opts.baseUrl}/v3/ws`);
    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 498-502 lines
    // Python serializes booleans as the strings "true"/"false", so we mirror that.
    for (const [key, value] of Object.entries(liveConfig)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean') {
        url.searchParams.append(key, value ? 'true' : 'false');
      } else {
        url.searchParams.append(key, String(value));
      }
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 492-496 lines
    const ws = new WebSocket(url, {
      headers: {
        Authorization: this.#opts.apiKey!,
        'Content-Type': 'application/json',
        'User-Agent': 'AssemblyAI/1.0 (integration=Livekit)',
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (error) => reject(error));
      ws.on('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
    });

    return ws;
  }

  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 357-440 lines
  async #runWS(ws: WebSocket) {
    let closing = false;
    const sessionController = new AbortController();

    // gets cancelled also when sendTask is complete
    const wsMonitor = Task.from(async (controller) => {
      const closed = new Promise<void>((_, reject) => {
        ws.once('close', (code, reason) => {
          if (!closing) {
            this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
            reject(new Error('WebSocket closed'));
          }
        });
      });

      await Promise.race([closed, waitForAbort(controller.signal)]);
    });

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 361-385 lines
    const sendTask = async () => {
      const samplesPerBuffer = Math.floor((this.#opts.sampleRate * this.#opts.bufferSizeMs) / 1000);
      const audioStream = new AudioByteStream(this.#opts.sampleRate, 1, samplesPerBuffer);

      const abortPromise = waitForAbort(this.abortSignal);
      const sessionAbort = waitForAbort(sessionController.signal);

      try {
        while (!this.closed) {
          const result = await Promise.race([this.input.next(), abortPromise, sessionAbort]);

          if (result === undefined) return; // aborted
          if (result.done) break;

          const data = result.value;

          let frames: AudioFrame[];
          if (data === SpeechStream.FLUSH_SENTINEL) {
            frames = audioStream.flush();
          } else if (data.sampleRate === this.#opts.sampleRate && data.channels === 1) {
            // AssemblyAI expects mono PCM. The base SpeechStream only resamples
            // sample rate, so reject any frame that is not already downmixed.
            frames = audioStream.write(data.data.buffer as ArrayBuffer);
          } else {
            throw new Error('sample rate or channel count of frame does not match');
          }

          for (const frame of frames) {
            this.#speechDurationInS += frame.samplesPerChannel / frame.sampleRate;
            ws.send(frame.data.buffer);
          }
        }
      } finally {
        closing = true;
        try {
          ws.send(SpeechStream.CLOSE_MSG);
        } catch {
          // ignore — socket may already be closing
        }
        wsMonitor.cancel();
      }
    };

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 387-418 lines
    let messageHandler: ((msg: RawData, isBinary: boolean) => void) | null = null;
    const listenTask = Task.from(async (controller) => {
      const listenMessage = new Promise<void>((resolve, reject) => {
        messageHandler = (msg, isBinary) => {
          if (isBinary) {
            this.#logger.error('unexpected binary message from AssemblyAI');
            return;
          }
          try {
            const json = JSON.parse(msg.toString()) as StreamEventMessage;
            this.#processStreamEvent(json);
            if (this.closed || closing) {
              resolve();
            }
          } catch (err) {
            this.#logger.error(`AssemblyAI: error processing message: ${msg}`);
            reject(err);
          }
        };
        ws.on('message', messageHandler);
      });

      await Promise.race([listenMessage, waitForAbort(controller.signal)]);
    });

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 420-424 lines
    const configTask = Task.from(async (controller) => {
      // Drain any messages queued while the socket was reconnecting.
      while (this.#pendingConfigMessages.length > 0) {
        const msg = this.#pendingConfigMessages.shift()!;
        ws.send(JSON.stringify(msg));
      }

      while (!controller.signal.aborted) {
        await Promise.race([this.#configMessagePending.await, waitForAbort(controller.signal)]);
        if (controller.signal.aborted) return;

        this.#configMessagePending = new Future();
        while (this.#pendingConfigMessages.length > 0) {
          const msg = this.#pendingConfigMessages.shift()!;
          ws.send(JSON.stringify(msg));
        }
      }
    });

    try {
      await Promise.all([sendTask(), listenTask.result, wsMonitor.result]);
    } finally {
      closing = true;
      sessionController.abort();
      listenTask.cancel();
      configTask.cancel();
      if (messageHandler) ws.off('message', messageHandler);
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  #averageConfidence(words: Array<{ confidence?: number }>): number {
    if (words.length === 0) return 0;
    return words.reduce((sum, w) => sum + (w.confidence ?? 0), 0) / words.length;
  }

  // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 507-661 lines
  #processStreamEvent(data: StreamEventMessage) {
    const messageType = data.type;

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 510-518 lines
    if (messageType === 'Begin') {
      this.#sessionId = data.id ?? null;
      this.#expiresAt = data.expires_at ?? null;
      this.#logger.info(
        `AssemblyAI session started id=${this.#sessionId} expires_at=${this.#expiresAt}`,
      );
      return;
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 520-522 lines
    if (messageType === 'SpeechStarted') {
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
      return;
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 524-532 lines
    if (messageType === 'Termination') {
      this.#logger.debug(
        `AssemblyAI session terminated audio_duration=${data.audio_duration_seconds}s session_duration=${data.session_duration_seconds}s`,
      );
      return;
    }

    if (messageType !== 'Turn') {
      return;
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 536-546 lines
    const words = data.words ?? [];
    const endOfTurn = Boolean(data.end_of_turn);
    const turnIsFormatted = Boolean(data.turn_is_formatted);
    const utterance = data.utterance ?? '';
    const transcript = data.transcript ?? '';
    const language = normalizeLanguage(data.language_code ?? 'en');

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 555-564 lines
    // Word timestamps are in milliseconds:
    // https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api#receive.receiveTurn.words
    const timedWords = words.map((word) =>
      createTimedString({
        text: word.text ?? '',
        startTime: (word.start ?? 0) / 1000 + this.startTimeOffset,
        endTime: (word.end ?? 0) / 1000 + this.startTimeOffset,
        confidence: word.confidence ?? 0,
        startTimeOffset: this.startTimeOffset,
      }),
    );

    let startTime = 0;
    let endTime = 0;
    let confidence = 0;

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 566-588 lines
    // `words` are cumulative for the turn — emit as an interim transcript.
    if (timedWords.length > 0) {
      const interimText = timedWords.map((w) => w.text).join(' ');
      startTime = timedWords[0]!.startTime ?? 0;
      endTime = timedWords[timedWords.length - 1]!.endTime ?? 0;
      confidence = this.#averageConfidence(timedWords);

      this.queue.put({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [
          {
            language,
            text: interimText,
            startTime,
            endTime,
            confidence,
            words: timedWords,
          },
        ],
      });
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 590-621 lines
    // `utterance` is chunk-based (not cumulative) — emit as a preflight transcript
    // covering only the words since the last preflight.
    if (utterance) {
      if (this.#lastPreflightStartTime === 0) {
        this.#lastPreflightStartTime = startTime;
      }

      const utteranceWords = timedWords.filter(
        (w) => w.startTime !== undefined && w.startTime >= this.#lastPreflightStartTime,
      );
      const utteranceConfidence = this.#averageConfidence(utteranceWords);

      this.queue.put({
        type: stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
        alternatives: [
          {
            language,
            text: utterance,
            startTime: this.#lastPreflightStartTime,
            endTime,
            confidence: utteranceConfidence,
            words: utteranceWords,
          },
        ],
      });
      this.#lastPreflightStartTime = endTime;
    }

    // Ref: python livekit-plugins/livekit-plugins-assemblyai/livekit/plugins/assemblyai/stt.py - 623-661 lines
    // End-of-turn: emit FINAL_TRANSCRIPT + END_OF_SPEECH.
    // If the user asked for formatted turns, wait for a formatted final.
    const waitingForFormatted = this.#opts.formatTurns === true && !turnIsFormatted;
    if (endOfTurn && !waitingForFormatted) {
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            language,
            text: transcript,
            startTime,
            endTime,
            confidence,
            words: timedWords,
          },
        ],
      });

      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });

      if (this.#speechDurationInS > 0) {
        this.queue.put({
          type: stt.SpeechEventType.RECOGNITION_USAGE,
          // Propagate the AssemblyAI session id as the request id so metrics
          // can be correlated back to a specific connection, mirroring how
          // Deepgram surfaces its `request_id`.
          requestId: this.#sessionId ?? undefined,
          recognitionUsage: {
            audioDuration: this.#speechDurationInS,
          },
        });
        this.#speechDurationInS = 0;
        this.#lastPreflightStartTime = 0;
      }
    }
  }
}
