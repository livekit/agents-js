// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  AudioByteStream,
  log,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import type { STTAudioFormat, STTCommitStrategy, STTLanguages, STTModels } from './models.js';

const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1';
const AUTHORIZATION_HEADER = 'xi-api-key';

export interface STTOptions {
  apiKey?: string;
  baseURL: string;
  model: STTModels;
  languageCode?: STTLanguages | string;
  tagAudioEvents: boolean;
  sampleRate: number;
  numChannels: number;
  // Streaming-specific options (only used for scribe_v2_realtime)
  commitStrategy: STTCommitStrategy;
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.ELEVEN_API_KEY,
  baseURL: API_BASE_URL_V1,
  model: 'scribe_v2_realtime',
  tagAudioEvents: true,
  sampleRate: 16000,
  numChannels: 1,
  commitStrategy: 'vad',
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #logger = log();
  label = 'elevenlabs.STT';

  /**
   * Create a new instance of ElevenLabs STT.
   *
   * @remarks
   * `apiKey` must be set to your ElevenLabs API key, either using the argument or by setting the
   * `ELEVEN_API_KEY` environment variable.
   *
   * @param opts - Configuration options for the STT service
   * @param opts.apiKey - ElevenLabs API key (defaults to ELEVEN_API_KEY env var)
   * @param opts.baseURL - Base URL for the API (defaults to https://api.elevenlabs.io/v1)
   * @param opts.model - Model to use: 'scribe_v1' (non-streaming), 'scribe_v2' (non-streaming), or 'scribe_v2_realtime' (streaming)
   * @param opts.languageCode - Language code for transcription (optional, auto-detected if not set)
   * @param opts.tagAudioEvents - Whether to tag audio events like (laughter), (footsteps), etc. (defaults to true, scribe_v1 only)
   * @param opts.sampleRate - Sample rate for audio (defaults to 16000)
   * @param opts.numChannels - Number of audio channels (defaults to 1)
   * @param opts.commitStrategy - Commit strategy: 'vad' (auto) or 'manual' (defaults to 'vad', scribe_v2_realtime only)
   * @param opts.vadSilenceThresholdSecs - VAD silence threshold in seconds, 0.3-3.0 (scribe_v2_realtime only)
   * @param opts.vadThreshold - VAD threshold, 0.1-0.9 (scribe_v2_realtime only)
   * @param opts.minSpeechDurationMs - Minimum speech duration in ms, 50-2000 (scribe_v2_realtime only)
   * @param opts.minSilenceDurationMs - Minimum silence duration in ms, 50-2000 (scribe_v2_realtime only)
   */
  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    const mergedOpts = { ...defaultSTTOptions, ...opts };
    const isStreaming = mergedOpts.model === 'scribe_v2_realtime';

    super({
      streaming: isStreaming,
      interimResults: isStreaming,
    });

    this.#opts = mergedOpts;

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'ElevenLabs API key is required, whether as an argument or as $ELEVEN_API_KEY',
      );
    }
  }

  #createWav(frame: AudioFrame): Buffer {
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
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(frame.data.byteLength, 40);
    return Buffer.concat([header, Buffer.from(frame.data.buffer)]);
  }

  async _recognize(buffer: AudioBuffer, language?: string): Promise<stt.SpeechEvent> {
    if (this.#opts.model === 'scribe_v2_realtime') {
      throw new Error(
        'scribe_v2_realtime requires streaming. Use stream() method instead, or use scribe_v1/scribe_v2 for non-streaming recognize()',
      );
    }

    const mergedBuffer = mergeFrames(buffer);
    const wavBytes = this.#createWav(mergedBuffer);

    // Create form data for the request
    const form = new FormData();
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav');
    form.append('model_id', this.#opts.model);
    form.append('tag_audio_events', this.#opts.tagAudioEvents.toString());

    // Add language code if provided (either from options or recognize call)
    const languageCode = language || this.#opts.languageCode;
    if (languageCode) {
      form.append('language_code', languageCode);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch(`${this.#opts.baseURL}/speech-to-text`, {
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: this.#opts.apiKey!,
        },
        body: form,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIStatusError({
          message: `ElevenLabs API error: ${response.statusText} - ${errorText}`,
          options: {
            statusCode: response.status,
            requestId: null,
            body: null,
            retryable: response.status >= 500,
          },
        });
      }

      const responseJson = await response.json();
      const extractedText = responseJson.text || '';
      const detectedLanguage = responseJson.language_code || languageCode || 'en';
      const words = responseJson.words || [];

      let startTime = 0;
      let endTime = 0;

      if (words.length > 0) {
        startTime = Math.min(...words.map((w: any) => w.start || 0));
        endTime = Math.max(...words.map((w: any) => w.end || 0));
      }

      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text: extractedText,
            language: detectedLanguage,
            startTime,
            endTime,
            confidence: 1.0, // ElevenLabs doesn't provide confidence scores
          },
        ],
      };
    } catch (error) {
      if (error instanceof APIStatusError) {
        throw error;
      }
      if ((error as any).name === 'AbortError') {
        throw new APITimeoutError({
          message: 'ElevenLabs API request timed out',
          options: { retryable: true },
        });
      }
      throw new APIConnectionError({
        message: `Failed to connect to ElevenLabs: ${error}`,
        options: { retryable: true },
      });
    }
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  stream(): SpeechStream {
    if (this.#opts.model !== 'scribe_v2_realtime') {
      throw new Error(
        'Streaming is only supported with scribe_v2_realtime model. For non-streaming, use recognize() method.',
      );
    }
    return new SpeechStream(this, this.#opts);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  #speaking = false;
  #lastCommittedText = '';
  label = 'elevenlabs.SpeechStream';

  constructor(stt: STT, opts: STTOptions) {
    super(stt, opts.sampleRate);
    this.#opts = opts;
    this.closed = false;
  }

  protected async run() {
    const maxRetry = 32;
    let retries = 0;
    let ws: WebSocket;

    while (!this.input.closed) {
      // Build WebSocket URL
      const audioFormat: STTAudioFormat = `pcm_${this.#opts.sampleRate}` as STTAudioFormat;
      const baseUrl = this.#opts.baseURL.replace('https://', 'wss://').replace('http://', 'ws://');
      const streamURL = new URL(`${baseUrl}/speech-to-text/realtime`);

      const params = {
        model_id: this.#opts.model,
        encoding: audioFormat,
        sample_rate: this.#opts.sampleRate,
        commit_strategy: this.#opts.commitStrategy,
        vad_silence_threshold_secs: this.#opts.vadSilenceThresholdSecs,
        vad_threshold: this.#opts.vadThreshold,
        min_speech_duration_ms: this.#opts.minSpeechDurationMs,
        min_silence_duration_ms: this.#opts.minSilenceDurationMs,
        language_code: this.#opts.languageCode,
      };

      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) {
          streamURL.searchParams.append(k, String(v));
        }
      });

      ws = new WebSocket(streamURL.toString(), {
        headers: { [AUTHORIZATION_HEADER]: `${this.#opts.apiKey}` },
      });

      try {
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', (error) => reject(error));
          ws.on('close', (code) => reject(`WebSocket returned ${code}`));
        });

        // on success reset retries
        retries = 0;

        await this.#runWS(ws);
      } catch (e) {
        if (retries >= maxRetry) {
          throw new Error(`failed to connect to ElevenLabs after ${retries} attempts: ${e}`);
        }

        ws.removeAllListeners();

        const delay = Math.min(retries * 5, 10);
        retries++;

        this.#logger.warn(
          `STT: failed to connect to ElevenLabs, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }

    this.closed = true;
  }

  async #runWS(ws: WebSocket) {
    let closing = false;

    const keepalive = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      } catch {
        clearInterval(keepalive);
        return;
      }
    }, 5000);

    const sendTask = async () => {
      const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
      const stream = new AudioByteStream(
        this.#opts.sampleRate,
        this.#opts.numChannels,
        samples100Ms,
      );

      let frame_count = 0;
      for await (const data of this.input) {
        let frames: AudioFrame[];
        if (data === SpeechStream.FLUSH_SENTINEL) {
          frames = stream.flush();

          // Send any remaining frames
          for (const frame of frames) {
            const audioB64 = Buffer.from(frame.data.buffer).toString('base64');
            ws.send(
              JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: audioB64,
                commit: false,
                sample_rate: this.#opts.sampleRate,
              }),
            );
          }

          // Send commit message if using manual commit strategy
          if (this.#opts.commitStrategy === 'manual') {
            ws.send(
              JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: '',
                commit: true,
                sample_rate: this.#opts.sampleRate,
              }),
            );
          }
        } else {
          if (
            data.sampleRate !== this.#opts.sampleRate ||
            data.channels !== this.#opts.numChannels
          ) {
            throw new Error(
              `sample rate or channel count of frame does not match (expected ${this.#opts.sampleRate}/${this.#opts.numChannels}, got ${data.sampleRate}/${data.channels})`,
            );
          }
          frames = stream.write(data.data.buffer);
          frame_count += frames.length;

          if (frame_count % 100 == 0) {
            this.#logger.debug(`STT: Sent ${frame_count} audio frames`);
          }

          for (const frame of frames) {
            const audioB64 = Buffer.from(frame.data.buffer).toString('base64');
            ws.send(
              JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: audioB64,
                commit: false,
                sample_rate: this.#opts.sampleRate,
              }),
            );
          }
        }
      }

      this.#logger.info(`STT: Send task complete, sent ${frame_count} total frames`);
      closing = true;
    };

    const wsMonitor = new Promise<void>((resolve, reject) =>
      ws.once('close', (code, reason) => {
        console.log('code', code, reason);
        if (!closing) {
          this.#logger.error(`STT: WebSocket closed unexpectedly with code ${code}: ${reason}`);
          reject(new Error('WebSocket closed'));
        } else {
          this.#logger.error(`STT: WebSocket closed normally ${code}: ${reason}`);
          resolve();
        }
      }),
    );

    const listenTask = async () => {
      await new Promise<void>((resolve, reject) => {
        ws.on('message', (msg) => {
          try {
            const json = JSON.parse(msg.toString());
            this.#processStreamEvent(json);

            if (this.closed || closing) {
              resolve();
            }
          } catch (err) {
            this.#logger.error(`STT: Error processing message: ${msg}`);
            reject(err);
          }
        });
      });
    };

    await Promise.all([sendTask(), listenTask(), wsMonitor]);
    closing = true;
    ws.close();
    clearInterval(keepalive);
  }

  #processStreamEvent(data: any) {
    const messageType = data.message_type;

    if (messageType === 'partial_transcript') {
      const text = data.text || '';

      // Ignore stale partial transcripts that match the last committed text
      if (text && text === this.#lastCommittedText) {
        return;
      }

      if (text) {
        // Send START_OF_SPEECH if this is the first transcript in a new segment
        if (!this.#speaking) {
          this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          this.#speaking = true;
          this.#lastCommittedText = '';
        }

        this.queue.put({
          type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
          alternatives: [
            {
              text,
              language: this.#opts.languageCode || 'en',
              startTime: 0,
              endTime: 0,
              confidence: 1.0,
            },
          ],
        });
      }
    } else if (
      messageType === 'committed_transcript' ||
      messageType === 'committed_transcript_with_timestamps'
    ) {
      const text = data.text || '';

      if (text) {
        // Send START_OF_SPEECH if we get a FINAL without any INTERIM first
        if (!this.#speaking) {
          this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
        }

        this.queue.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [
            {
              text,
              language: this.#opts.languageCode || 'en',
              startTime: 0,
              endTime: 0,
              confidence: 1.0,
            },
          ],
        });

        // Send end of speech event
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
        this.#speaking = false;
        this.#lastCommittedText = text;
      } else {
        // Empty commit - just reset state
        this.#speaking = false;
        this.#lastCommittedText = '';
      }
    } else if (messageType === 'session_started') {
      const sessionId = data.session_id || 'unknown';
      this.#logger.info(`STT: ElevenLabs session started with ID: ${sessionId}`);
    } else if (messageType === 'input_error') {
      this.#logger.error(`STT: Input Error received: ${data.error}. We ignore this for now.`);
    } else {
      this.#logger.warn(`STT: Unknown message type: ${messageType}`);
    }
  }
}
