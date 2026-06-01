// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  Future,
  Task,
  createTimedString,
  log,
  mergeFrames,
  normalizeLanguage,
  shortuuid,
  stt,
  waitForAbort,
} from '@livekit/agents';
import { WebSocket } from 'ws';

const DEFAULT_MODEL = 'inworld/inworld-stt-1';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_NUM_CHANNELS = 1;
const DEFAULT_BASE_URL = 'https://api.inworld.ai/';
const DEFAULT_WS_URL = 'wss://api.inworld.ai/';
const WS_ENDPOINT = 'stt/v1/transcribe:streamBidirectional';
const REST_ENDPOINT = 'stt/v1/transcribe';
const AUDIO_DURATION_REPORT_INTERVAL = 5;

/** Supported Inworld STT model identifiers. */
export type STTModels = 'inworld/inworld-stt-1' | string;

/** Per-word timestamp entry returned by the Inworld STT API. */
export interface WordTimestamp {
  word: string;
  confidence?: number;
  /** Start offset in seconds (streaming WebSocket). */
  startTime?: number;
  /** Start offset in milliseconds (batch REST). */
  startTimeMs?: number;
  /** End offset in seconds (streaming WebSocket). */
  endTime?: number;
  /** End offset in milliseconds (batch REST). */
  endTimeMs?: number;
}

/**
 * Acoustic voice profile returned alongside the transcript when
 * `enableVoiceProfile` is `true`. Each dimension is an array of
 * `{label, confidence}` candidates ordered by descending confidence.
 *
 * @remarks The response schema is not publicly documented by Inworld;
 * additional dimension keys may appear at runtime.
 */
export interface VoiceProfile {
  emotion?: { label: string; confidence: number }[];
  accent?: { label: string; confidence: number }[];
  age?: { label: string; confidence: number }[];
  pitch?: { label: string; confidence: number }[];
  vocalStyle?: { label: string; confidence: number }[];
  [key: string]: unknown;
}

/** Billing and model metadata returned in batch REST responses. */
export interface TranscriptionUsage {
  /** Duration of audio that was transcribed, in milliseconds. */
  transcribedAudioMs?: number;
  modelId?: string;
}

/** Configuration options for {@link STT}. */
export interface STTOptions {
  /** Inworld API key. Defaults to `$INWORLD_API_KEY`. */
  apiKey?: string;
  /** Model to use. Default: `'inworld/inworld-stt-1'`. */
  model: STTModels;
  /** BCP-47 language tag. Default: `'en-US'`. */
  language: string;
  /** Input audio sample rate in Hz. Default: `16000`. */
  sampleRate: number;
  /** Number of audio channels. Default: `1`. */
  numChannels: number;
  /** Enable acoustic voice profiling (emotion, accent, age, pitch, style). Default: `true`. */
  enableVoiceProfile: boolean;
  /** Number of top candidates to return per voice profile dimension. Default: `1`. */
  voiceProfileTopN: number;
  /** VAD activity threshold (0–1). Omit to use the server default. */
  vadThreshold?: number;
  /** Minimum silence in ms before committing end-of-turn when confidence is high. Default: `200`. */
  minEndOfTurnSilenceWhenConfident: number;
  /** Confidence threshold for end-of-turn detection. Default: `0.3`. */
  endOfTurnConfidenceThreshold: number;
  /** Base URL for the REST API. Default: `'https://api.inworld.ai/'`. */
  baseURL: string;
  /** Base URL for the WebSocket API. Default: `'wss://api.inworld.ai/'`. */
  wsURL: string;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.INWORLD_API_KEY,
  model: DEFAULT_MODEL,
  language: DEFAULT_LANGUAGE,
  sampleRate: DEFAULT_SAMPLE_RATE,
  numChannels: DEFAULT_NUM_CHANNELS,
  enableVoiceProfile: true,
  voiceProfileTopN: 1,
  minEndOfTurnSilenceWhenConfident: 200,
  endOfTurnConfidenceThreshold: 0.3,
  baseURL: DEFAULT_BASE_URL,
  wsURL: DEFAULT_WS_URL,
};

/**
 * Inworld STT — supports both streaming (bidirectional WebSocket) and batch (REST) modes.
 *
 * When `enableVoiceProfile` is `true` (the default), each recognized transcript includes an
 * acoustic {@link VoiceProfile} in `SpeechData.metadata.voiceProfile`.
 *
 * @example
 * ```ts
 * const sttInstance = new STT({ enableVoiceProfile: true });
 * session = new AgentSession({ stt: sttInstance, ... });
 * ```
 */
export class STT extends stt.STT {
  #opts: STTOptions;
  #logger = log();
  label = 'inworld.STT';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Inworld';
  }

  /**
   * @param opts - Partial {@link STTOptions}. `apiKey` defaults to `$INWORLD_API_KEY`.
   */
  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
    });

    const apiKey = opts.apiKey ?? defaultSTTOptions.apiKey;
    if (!apiKey) {
      throw new Error('Inworld API key is required, whether as an argument or as $INWORLD_API_KEY');
    }

    this.#opts = { ...defaultSTTOptions, ...opts, apiKey };
  }

  async _recognize(buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const b64 = Buffer.from(
      frame.data.buffer,
      frame.data.byteOffset,
      frame.data.byteLength,
    ).toString('base64');

    const url = new URL(REST_ENDPOINT, this.#opts.baseURL);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.#opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transcribeConfig: {
          modelId: this.#opts.model,
          audioEncoding: 'LINEAR16',
          sampleRateHertz: this.#opts.sampleRate,
          numberOfChannels: this.#opts.numChannels,
          language: this.#opts.language,
          voiceProfileConfig: {
            enableVoiceProfile: this.#opts.enableVoiceProfile,
            topN: this.#opts.voiceProfileTopN,
          },
        },
        audioData: { content: b64 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Inworld STT API error ${response.status}: ${await response.text()}`);
    }

    const result = (await response.json()) as {
      transcription: {
        transcript: string;
        isFinal: boolean;
        wordTimestamps?: WordTimestamp[];
        voiceProfile?: VoiceProfile;
      };
      usage?: TranscriptionUsage;
    };

    const { transcript, wordTimestamps, voiceProfile } = result.transcription;
    const metadata = voiceProfile ? { voiceProfile: voiceProfile } : undefined;

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: transcript,
          language: normalizeLanguage(this.#opts.language),
          startTime: 0,
          endTime: 0,
          confidence: 1,
          words: wordTimestampsToTimedStrings(wordTimestamps ?? []),
          metadata,
        },
      ],
    };
  }

  updateOptions(opts: Partial<STTOptions>): void {
    this.#opts = { ...this.#opts, ...opts };
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }

  async close(): Promise<void> {}
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  #speaking = false;
  #resetWS = new Future();
  #requestId = shortuuid('stt_');
  #audioDuration = 0;
  #lastAudioReport = 0;
  label = 'inworld.SpeechStream';

  constructor(sttInstance: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = opts;
  }

  updateOptions(opts: Partial<STTOptions>): void {
    this.#opts = { ...this.#opts, ...opts };
    this.#resetWS.resolve();
  }

  protected async run(): Promise<void> {
    const maxRetry = 32;
    let retries = 0;

    while (!this.input.closed && !this.closed) {
      const wsUrl = new URL(WS_ENDPOINT, this.#opts.wsURL);
      const ws = new WebSocket(wsUrl.toString(), {
        headers: { Authorization: `Basic ${this.#opts.apiKey}` },
      });

      try {
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => resolve());
          ws.on('error', (err) => reject(err));
          ws.on('close', (code) => reject(new Error(`WebSocket closed with code ${code}`)));
        });

        retries = 0;
        await this.#runWS(ws);
      } catch (e) {
        if (!this.closed && !this.input.closed) {
          if (retries >= maxRetry) {
            throw new Error(`Failed to connect to Inworld STT after ${retries} attempts: ${e}`);
          }

          const delay = Math.min(retries * 5, 10);
          retries++;
          this.#logger.warn(
            `Failed to connect to Inworld STT, retrying in ${delay}s: ${e} (${retries}/${maxRetry})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        } else {
          this.#logger.warn(
            `Inworld STT disconnected, connection is closed: ${e} (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
          );
        }
      }
    }

    this.closed = true;
  }

  async #runWS(ws: WebSocket): Promise<void> {
    this.#resetWS = new Future();
    let closing = false;

    ws.send(
      JSON.stringify({
        transcribeConfig: {
          modelId: this.#opts.model,
          audioEncoding: 'LINEAR16',
          sampleRateHertz: this.#opts.sampleRate,
          numberOfChannels: this.#opts.numChannels,
          language: this.#opts.language,
          voiceProfileConfig: {
            enableVoiceProfile: this.#opts.enableVoiceProfile,
            topN: this.#opts.voiceProfileTopN,
          },
          endOfTurnConfidenceThreshold: this.#opts.endOfTurnConfidenceThreshold,
          inworldSttV1Config: {
            minEndOfTurnSilenceWhenConfident: this.#opts.minEndOfTurnSilenceWhenConfident,
            ...(this.#opts.vadThreshold !== undefined
              ? { vadThreshold: this.#opts.vadThreshold }
              : {}),
          },
        },
      }),
    );

    const wsMonitor = Task.from(async (controller) => {
      const closed = new Promise<void>((_, reject) => {
        ws.once('close', (code, reason) => {
          if (!closing) {
            this.#logger.error(`Inworld STT WebSocket closed with code ${code}: ${reason}`);
            reject(new Error('WebSocket closed'));
          }
        });
      });
      await Promise.race([closed, waitForAbort(controller.signal)]);
    });

    const sendTask = async () => {
      const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
      const stream = new AudioByteStream(
        this.#opts.sampleRate,
        this.#opts.numChannels,
        samples100Ms,
      );

      const abortPromise = waitForAbort(this.abortSignal);

      try {
        while (!this.closed) {
          const result = await Promise.race([this.input.next(), abortPromise]);

          if (result === undefined) return;
          if (result.done) break;

          const data = result.value;
          const frames =
            data === SpeechStream.FLUSH_SENTINEL
              ? stream.flush()
              : stream.write(data.data.buffer as ArrayBuffer);

          for await (const frame of frames) {
            const frameDuration = frame.samplesPerChannel / frame.sampleRate;
            this.#audioDuration += frameDuration;
            this.#maybeReportUsage();

            const b64 = Buffer.from(
              frame.data.buffer,
              frame.data.byteOffset,
              frame.data.byteLength,
            ).toString('base64');
            ws.send(JSON.stringify({ audioChunk: { content: b64 } }));
          }
        }
      } finally {
        closing = true;
        ws.send(JSON.stringify({ endTurn: {} }));
        ws.send(JSON.stringify({ closeStream: {} }));
        wsMonitor.cancel();
      }
    };

    const listenTask = Task.from(async (controller) => {
      const listenMessage = new Promise<void>((resolve, reject) => {
        ws.on('message', (msg) => {
          try {
            const json = JSON.parse(msg.toString()) as {
              result?: {
                speechStarted?: unknown;
                transcription?: {
                  transcript: string;
                  isFinal: boolean;
                  wordTimestamps?: WordTimestamp[];
                  voiceProfile?: VoiceProfile;
                };
              };
              error?: { message: string };
            };

            if (json.error) {
              reject(new Error(`Inworld STT error: ${json.error.message}`));
              return;
            }

            const result = json.result;
            if (!result) return;

            if (result.speechStarted !== undefined) {
              if (!this.#speaking) {
                this.#speaking = true;
                this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
              }
              return;
            }

            if (result.transcription) {
              const { transcript, isFinal, wordTimestamps, voiceProfile } = result.transcription;
              const metadata = voiceProfile ? { voiceProfile: voiceProfile } : undefined;

              if (!this.#speaking && transcript) {
                this.#speaking = true;
                this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
              }

              if (isFinal) {
                if (transcript) {
                  this.queue.put({
                    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                    requestId: this.#requestId,
                    alternatives: [
                      {
                        text: transcript,
                        language: normalizeLanguage(this.#opts.language),
                        startTime: this.startTimeOffset,
                        endTime: this.startTimeOffset,
                        confidence: 1,
                        words: wordTimestampsToTimedStrings(
                          wordTimestamps ?? [],
                          this.startTimeOffset,
                        ),
                        metadata,
                      },
                    ],
                  });
                }
                if (this.#speaking) {
                  this.#speaking = false;
                  this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
                }
              } else if (transcript) {
                this.queue.put({
                  type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
                  requestId: this.#requestId,
                  alternatives: [
                    {
                      text: transcript,
                      language: normalizeLanguage(this.#opts.language),
                      startTime: this.startTimeOffset,
                      endTime: this.startTimeOffset,
                      confidence: 0,
                      words: wordTimestampsToTimedStrings(
                        wordTimestamps ?? [],
                        this.startTimeOffset,
                      ),
                      metadata,
                    },
                  ],
                });
              }
            }

            if (this.closed || closing) {
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      await Promise.race([listenMessage, waitForAbort(controller.signal)]);
    }, this.abortController);

    await Promise.race([
      this.#resetWS.await,
      Promise.all([sendTask(), listenTask.result, wsMonitor.result]),
    ]);
    closing = true;
    ws.close();
  }

  #maybeReportUsage(): void {
    const elapsed = this.#audioDuration - this.#lastAudioReport;
    if (elapsed >= AUDIO_DURATION_REPORT_INTERVAL) {
      this.#lastAudioReport = this.#audioDuration;
      this.queue.put({
        type: stt.SpeechEventType.RECOGNITION_USAGE,
        requestId: this.#requestId,
        recognitionUsage: { audioDuration: elapsed },
      });
    }
  }
}

function wordTimestampsToTimedStrings(
  words: WordTimestamp[],
  startTimeOffset = 0,
): ReturnType<typeof createTimedString>[] {
  return words.map((w) => {
    // REST endpoint uses startTimeMs/endTimeMs (ms); streaming uses startTime/endTime (s).
    const startTime =
      w.startTimeMs !== undefined
        ? w.startTimeMs / 1000 + startTimeOffset
        : (w.startTime ?? 0) + startTimeOffset;
    const endTime =
      w.endTimeMs !== undefined
        ? w.endTimeMs / 1000 + startTimeOffset
        : (w.endTime ?? 0) + startTimeOffset;

    return createTimedString({
      text: w.word,
      startTime,
      endTime,
      startTimeOffset,
      confidence: w.confidence ?? 0,
    });
  });
}
