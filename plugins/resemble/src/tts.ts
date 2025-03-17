// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, log, tokenize, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { WebSocket } from 'ws';
import type { OutputFormat, Precision } from './models.js';

export const TTSDefaultVoiceId = '55592656';

const RESEMBLE_WEBSOCKET_URL = 'wss://websocket.cluster.resemble.ai/stream';
const NUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;

export interface TTSOptions {
  voiceUuid: string;
  sampleRate: number;
  precision: Precision;
  outputFormat: OutputFormat;
  binaryResponse: boolean;
  apiKey?: string;
}

const defaultTTSOptions: TTSOptions = {
  voiceUuid: TTSDefaultVoiceId,
  sampleRate: 44100,
  precision: 'PCM_16',
  outputFormat: 'wav',
  binaryResponse: false,
  apiKey: process.env.RESEMBLE_API_KEY,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'resemble.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(opts.sampleRate || defaultTTSOptions.sampleRate, NUM_CHANNELS, {
      streaming: true,
    });

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
    };

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Resemble API key is required, whether as an argument or as $RESEMBLE_API_KEY',
      );
    }
  }

  synthesize(text: string): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts);
  }

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'resemble.ChunkedStream';
  #opts: TTSOptions;
  #text: string;

  constructor(tts: TTS, text: string, opts: TTSOptions) {
    super(text, tts);
    this.#text = text;
    this.#opts = opts;
    this.#run();
  }

  async #run() {
    const requestId = randomUUID();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const json = toResembleOptions(this.#opts);
    json.data = this.#text;

    const req = request(
      {
        hostname: 'f.cluster.resemble.ai',
        port: 443,
        path: '/synthesize',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey!}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);

            if (!response.success) {
              const issues = response.issues || ['Unknown error'];
              const errorMsg = issues.join('; ');
              throw new Error(`Resemble API returned failure: ${errorMsg}`);
            }

            const audioContentB64 = response.audio_content;
            if (!audioContentB64) {
              throw new Error('No audio content in response');
            }

            const audioBytes = Buffer.from(audioContentB64, 'base64');

            for (const frame of bstream.write(audioBytes)) {
              this.queue.put({
                requestId,
                frame,
                final: false,
                segmentId: requestId,
              });
            }

            for (const frame of bstream.flush()) {
              this.queue.put({
                requestId,
                frame,
                final: false,
                segmentId: requestId,
              });
            }

            this.queue.close();
          } catch (error) {
            console.error('Error processing Resemble API response:', error);
            this.queue.close();
          }
        });

        res.on('error', (error) => {
          console.error('Resemble API error:', error);
          this.queue.close();
        });
      },
    );

    req.write(JSON.stringify(json));
    req.end();
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  #tokenizer = new tokenize.basic.SentenceTokenizer(undefined, BUFFERED_WORDS_COUNT).stream();
  #websocket: WebSocket | null = null;
  #requestId = 0;
  #connectionTimeout: NodeJS.Timeout | null = null;
  #isProcessing = false;
  label = 'resemble.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
    this.#run();
  }

  #resetConnectionTimeout(ws: WebSocket) {
    if (this.#connectionTimeout) {
      clearTimeout(this.#connectionTimeout);
    }

    this.#connectionTimeout = setTimeout(() => {
      if (this.#isProcessing) {
        this.#logger.warn('Connection appears to be stuck, attempting recovery');
        this.#isProcessing = false;

        // Force a done event if we're stuck
        this.queue.put(SynthesizeStream.END_OF_STREAM);

        // Attempt to gracefully close and reconnect
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'Timeout - forcing reconnection');
        }
      }
    }, 10000); // 10 second timeout
  }

  async #run() {
    const requestId = randomUUID();
    let closing = false;

    const sentenceStreamTask = async (ws: WebSocket) => {
      const packet = toResembleOptions(this.#opts, true);

      for await (const event of this.#tokenizer) {
        packet.data = event.token + ' ';
        packet.request_id = this.#requestId++;
        packet.binary_response = this.#opts.binaryResponse;
        packet.continue = true;
        this.#isProcessing = true;
        this.#logger.info(`Sending packet: ${JSON.stringify(packet)}`);
        ws.send(JSON.stringify(packet));

        // Set timeout to detect stuck connections
        this.#resetConnectionTimeout(ws);
      }
    };

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.#tokenizer.flush();
          continue;
        }
        this.#tokenizer.pushText(data);
      }
      this.#tokenizer.endInput();
      this.#tokenizer.close();
    };

    const recvTask = async (ws: WebSocket) => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      ws.on('message', (data) => {
        try {
          // Reset timeout on each message received
          this.#resetConnectionTimeout(ws);

          const json = JSON.parse(data.toString());
          const segmentId = json.context_id;
          this.#logger.info(`Received message: ${JSON.stringify(json).substring(0, 100)}`);

          if ('audio_content' in json) {
            try {
              const audioData = Buffer.from(json.audio_content, 'base64');
              for (const frame of bstream.write(audioData)) {
                sendLastFrame(segmentId, false);
                lastFrame = frame;
              }
              // Mark that we're still actively processing
              this.#isProcessing = true;
            } catch (audioError) {
              this.#logger.error(`Error processing audio content: ${audioError}`);
            }
          } else if ('type' in json && json.type === 'done') {
            for (const frame of bstream.flush()) {
              sendLastFrame(segmentId, false);
              lastFrame = frame;
            }
            sendLastFrame(segmentId, true);
            this.queue.put(SynthesizeStream.END_OF_STREAM);
            this.#isProcessing = false;

            if (segmentId === requestId) {
              closing = true;
              ws.close();
              return;
            }
          } else if ('success' in json && json.success === false) {
            // Handle error response from Resemble
            const errorName = json.error_name || 'Unknown';
            const explanation = json.error_params?.explanation || 'No details provided';
            this.#logger.error(`Resemble API error: ${errorName} - ${explanation}`);

            // Close the WebSocket and end the stream
            closing = true;
            ws.close();
            this.queue.put(SynthesizeStream.END_OF_STREAM);
            this.#isProcessing = false;
          }
        } catch (error) {
          this.#logger.error(`Error parsing WebSocket message: ${error}`);
          // Don't terminate on message parsing errors
        }
      });

      ws.on('error', (error) => {
        this.#logger.error(`WebSocket error: ${error}`);
        if (!closing) {
          closing = true;
          this.queue.put(SynthesizeStream.END_OF_STREAM);
          this.#isProcessing = false;
          ws.close();
        }
      });

      ws.on('close', (code, reason) => {
        if (!closing) {
          this.#logger.error(`WebSocket closed with code ${code}: ${reason}`);
          this.queue.put(SynthesizeStream.END_OF_STREAM);
          this.#isProcessing = false;
        }
        ws.removeAllListeners();

        // Clear the timeout when connection closes
        if (this.#connectionTimeout) {
          clearTimeout(this.#connectionTimeout);
          this.#connectionTimeout = null;
        }
      });
    };

    const url = `${RESEMBLE_WEBSOCKET_URL}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.#opts.apiKey}`,
      },
    });
    this.#websocket = ws;

    try {
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', (error) => reject(error));
        ws.on('close', (code) => reject(`WebSocket returned ${code}`));
      });

      // Set initial timeout
      this.#resetConnectionTimeout(ws);

      await Promise.all([inputTask(), sentenceStreamTask(ws), recvTask(ws)]);
    } catch (e) {
      this.#logger.error(`WebSocket connection failed: ${e}`);
      // Ensure we always send an end of stream signal when things fail
      this.queue.put(SynthesizeStream.END_OF_STREAM);
      this.#isProcessing = false;
      throw new Error(`failed to connect to Resemble: ${e}`);
    }
  }

  override close(): void {
    // Clear timeout if it exists
    if (this.#connectionTimeout) {
      clearTimeout(this.#connectionTimeout);
      this.#connectionTimeout = null;
    }

    if (this.#websocket) {
      // Force a closing frame to be sent
      if (this.#websocket.readyState === WebSocket.OPEN) {
        this.#websocket.close(1000, 'Stream closed by client');
      }
      this.#websocket = null;
    }

    this.#tokenizer.close();

    // Ensure the queue gets an end signal if we're still processing
    if (this.#isProcessing) {
      this.queue.put(SynthesizeStream.END_OF_STREAM);
      this.#isProcessing = false;
    }

    super.close();
  }
}

const toResembleOptions = (
  opts: TTSOptions,
  stream: boolean = false,
): { [id: string]: unknown } => {
  const options: { [id: string]: unknown } = {
    voice_uuid: opts.voiceUuid,
    sample_rate: opts.sampleRate,
    output_format: opts.outputFormat.toLowerCase(),
    precision: opts.precision,
  };

  if (stream) {
    options.no_audio_header = true;
  }

  return options;
};
