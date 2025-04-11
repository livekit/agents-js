// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioBuffer,
  AudioByteStream,
  AudioEnergyFilter,
  log,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { OpenAI } from 'openai';
import { type RawData, WebSocket } from 'ws';
import type { GroqAudioModels, OpenAISTTModels, WhisperModels } from './models.js';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const MAX_SESSION_DURATION = 10 * 60 * 1000; // 10 minutes
const DELTA_TRANSCRIPT_INTERVAL = 500; // 0.5 seconds in ms

export interface STTOptions {
  apiKey?: string;
  language?: string;
  prompt?: string;
  model: OpenAISTTModels | WhisperModels | (string & {});
  baseURL?: string;
  client?: OpenAI;
  turnDetection?: {
    type: string;
    threshold: number;
    prefix_padding_ms: number;
    silence_duration_ms: number;
  };
  noiseReductionType?: string;
  sampleRate?: number;
  numChannels?: number;
}

// Interfaces for OpenAI Realtime API session configuration
interface InputAudioTranscription {
  model: string;
  prompt: string;
  language?: string;
}

interface InputAudioNoiseReduction {
  type: string;
}

interface TranscriptionSession {
  input_audio_format: string;
  input_audio_transcription: InputAudioTranscription;
  input_audio_noise_reduction?: InputAudioNoiseReduction;
  turn_detection?: {
    type: string;
    threshold: number;
    prefix_padding_ms: number;
    silence_duration_ms: number;
  };
}

interface SessionConfig {
  type: string;
  session: TranscriptionSession;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-transcribe',
  sampleRate: SAMPLE_RATE,
  numChannels: NUM_CHANNELS,
  turnDetection: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 600,
    silence_duration_ms: 350,
  },
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #client: OpenAI;
  #streams = new Set<SpeechStream>();
  label = 'openai.STT';

  /**
   * Create a new instance of OpenAI STT.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or by setting the
   * `OPENAI_API_KEY` environmental variable.
   */
  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    super({
      streaming: true,
      interimResults: true,
    });

    this.#opts = { ...defaultSTTOptions, ...opts };
    if (this.#opts.apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.#client =
      this.#opts.client ||
      new OpenAI({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
      });
  }

  /**
   * Create a new instance of Groq STT.
   *
   * @remarks
   * `apiKey` must be set to your Groq API key, either using the argument or by setting the
   * `GROQ_API_KEY` environmental variable.
   */
  static withGroq(
    opts: Partial<{
      model: string | GroqAudioModels;
      apiKey?: string;
      baseURL?: string;
      client: OpenAI;
      language: string;
      detectLanguage: boolean;
    }> = {},
  ): STT {
    opts.apiKey = opts.apiKey || process.env.GROQ_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('Groq API key is required, whether as an argument or as $GROQ_API_KEY');
    }

    return new STT({
      model: 'whisper-large-v3-turbo',
      baseURL: 'https://api.groq.com/openai/v1',
      ...opts,
    });
  }

  #sanitizeOptions(language?: string): STTOptions {
    if (language) {
      return { ...this.#opts, language };
    } else {
      return this.#opts;
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
    const config = this.#sanitizeOptions(language);
    buffer = mergeFrames(buffer);
    const file = new File([this.#createWav(buffer)], 'audio.wav', { type: 'audio/wav' });
    const resp = await this.#client.audio.transcriptions.create({
      file,
      model: this.#opts.model,
      language: config.language,
      prompt: config.prompt,
      response_format: 'json',
    });

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: resp.text || '',
          language: language || '',
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    };
  }

  /**
   * Creates a stream for real-time speech to text processing.
   */
  stream(language?: string): stt.SpeechStream {
    const opts = this.#sanitizeOptions(language);
    const stream = new SpeechStream(this, opts);
    this.#streams.add(stream);
    return stream;
  }

  updateOptions(options: Partial<STTOptions>): void {
    this.#opts = { ...this.#opts, ...options };

    // Update all active streams with the new options
    for (const stream of this.#streams) {
      if (stream instanceof SpeechStream) {
        stream.updateOptions(this.#opts);
      }
    }
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #audioEnergyFilter: AudioEnergyFilter;
  #logger = log();
  #speaking = false;
  #ws?: WebSocket;
  #currentText = '';
  #lastInterimAt = 0;
  #connectedAt = 0;
  #closed = false;
  #reconnectTimeout?: NodeJS.Timeout;
  label = 'openai.SpeechStream';

  constructor(stt: STT, opts: STTOptions) {
    super(stt);
    this.#opts = opts;
    this.closed = false;
    this.#audioEnergyFilter = new AudioEnergyFilter();

    this.#run();
  }

  updateOptions(options: Partial<STTOptions>): void {
    this.#opts = { ...this.#opts, ...options };

    // Reconnect to apply new options
    if (this.#ws) {
      this.#reconnect();
    }
  }

  #reconnect(): void {
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
    }

    if (this.#ws) {
      try {
        this.#ws.close();
      } catch (e) {
        this.#logger.warn('Error closing WebSocket:', e);
      }
      this.#ws = undefined;
    }

    // Reconnect after a brief delay
    this.#reconnectTimeout = setTimeout(() => {
      this.#run();
    }, 100);
  }

  async #run(maxRetry = 32) {
    let retries = 0;

    while (!this.input.closed && !this.#closed) {
      try {
        if (!this.#ws) {
          const apiKey = this.#opts.apiKey;
          if (!apiKey) {
            throw new Error('API key is required for OpenAI STT');
          }

          // Create WebSocket URL for OpenAI's realtime API
          const url = 'wss://api.openai.com/v1/realtime?intent=transcription'; // TODO: make this configurable

          // Create WebSocket connection
          this.#ws = new WebSocket(url.toString(), {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'OpenAI-Beta': 'realtime=v1',
              'User-Agent': 'LiveKit Agents',
            },
          });

          // Setup event handlers
          await new Promise<void>((resolve, reject) => {
            if (!this.#ws) return reject(new Error('WebSocket was closed'));

            this.#ws.on('open', () => {
              this.#connectedAt = Date.now();
              resolve();
            });

            this.#ws.on('error', (error) => reject(error));
            this.#ws.on('close', (code) => reject(`WebSocket closed with code ${code}`));
          });

          // Configure the transcription session
          const sessionConfig: SessionConfig = {
            type: 'transcription_session.update',
            session: {
              input_audio_format: 'pcm16',
              input_audio_transcription: {
                model: this.#opts.model,
                prompt: this.#opts.prompt || '',
              },
              turn_detection: this.#opts.turnDetection,
            },
          };

          if (this.#opts.language) {
            sessionConfig.session.input_audio_transcription.language = this.#opts.language;
          }

          if (this.#opts.noiseReductionType) {
            sessionConfig.session.input_audio_noise_reduction = {
              type: this.#opts.noiseReductionType,
            };
          }

          // Send config to initialize the session
          this.#ws.send(JSON.stringify(sessionConfig));
        }

        // Run the WebSocket
        await this.#runWS(this.#ws);
      } catch (e) {
        if (retries >= maxRetry) {
          throw new Error(
            `Failed to connect to OpenAI realtime API after ${retries} attempts: ${e}`,
          );
        }

        const delay = Math.min(retries * 5, 10);
        retries++;

        this.#logger.warn(
          `Failed to connect to OpenAI, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
        );

        // Close the existing WebSocket if any
        if (this.#ws) {
          try {
            this.#ws.close();
          } catch {}
          this.#ws = undefined;
        }

        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }

    this.closed = true;
  }

  async #runWS(ws: WebSocket) {
    let closing = false;

    // Keep the connection alive
    const keepalive = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch {
        clearInterval(keepalive);
        return;
      }
    }, 5000);

    // Function to handle sending audio data
    const sendTask = async () => {
      const samples100Ms = Math.floor((this.#opts.sampleRate || SAMPLE_RATE) / 10);
      const stream = new AudioByteStream(
        this.#opts.sampleRate || SAMPLE_RATE,
        this.#opts.numChannels || NUM_CHANNELS,
        samples100Ms,
      );

      for await (const data of this.input) {
        if (this.#closed) break;

        let frames: AudioFrame[];
        if (data === SpeechStream.FLUSH_SENTINEL) {
          frames = stream.flush();
        } else if (
          data.sampleRate === (this.#opts.sampleRate || SAMPLE_RATE) &&
          data.channels === (this.#opts.numChannels || NUM_CHANNELS)
        ) {
          frames = stream.write(Buffer.from(data.data.buffer));
        } else {
          throw new Error(`Sample rate or channel count of frame does not match`);
        }

        for (const frame of frames) {
          if (this.#audioEnergyFilter.pushFrame(frame)) {
            // Base64 encode audio data for OpenAI realtime API
            const base64Audio = Buffer.from(frame.data.buffer).toString('base64');
            ws.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: base64Audio,
              }),
            );
          }
        }

        // Check if we need to restart the session due to duration limitation
        if (Date.now() - this.#connectedAt > MAX_SESSION_DURATION) {
          this.#logger.info('Resetting realtime STT session due to timeout');
          this.#reconnect();
          break;
        }
      }

      closing = true;
      ws.close();
    };

    // Monitor WebSocket for closure
    const wsMonitor = new Promise<void>((_, reject) => {
      ws.once('close', (code, reason) => {
        if (!closing && !this.#closed) {
          this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
          reject(new Error(`WebSocket closed with code ${code}: ${reason}`));
        }
      });
    });

    // Listen for transcription results
    const listenTask = async () => {
      ws.on('message', (data: RawData) => {
        try {
          const json = JSON.parse(data.toString()); //todo type this
          const msgType = json.type;

          if (msgType === 'conversation.item.input_audio_transcription.delta') {
            // Handle interim transcription results
            const delta = json.delta || '';
            if (delta) {
              this.#currentText += delta;
              const now = Date.now();
              if (now - this.#lastInterimAt > DELTA_TRANSCRIPT_INTERVAL) {
                this.queue.put({
                  type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
                  alternatives: [
                    {
                      text: this.#currentText,
                      language: this.#opts.language || '',
                      startTime: 0,
                      endTime: 0,
                      confidence: 0,
                    },
                  ],
                });
                this.#lastInterimAt = now;
              }
            }
          } else if (msgType === 'conversation.item.input_audio_transcription.completed') {
            // Handle final transcription results
            // todo handle ordering here
            this.#currentText = '';
            const transcript = json.transcript || '';
            if (transcript) {
              this.queue.put({
                type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                alternatives: [
                  {
                    text: transcript,
                    language: this.#opts.language || '',
                    startTime: 0,
                    endTime: 0,
                    confidence: 0,
                  },
                ],
              });
            }
          }
        } catch (error) {
          this.#logger.error('Failed to process message:', error);
        }
      });

      // Wait until the WebSocket is closed or the send task completes
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });
    };

    // Run all tasks in parallel
    await Promise.all([sendTask(), listenTask(), wsMonitor]);
    clearInterval(keepalive);
  }

  close(): void {
    this.#closed = true;
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch (e) {
        this.#logger.warn('Error closing WebSocket', e);
      }
      this.#ws = undefined;
    }

    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = undefined;
    }

    super.close();
  }
}
