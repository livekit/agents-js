// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, log, tts } from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { OutputFormat, Precision } from './models.js';

const RESEMBLE_REST_API_URL = 'https://f.cluster.resemble.ai/synthesize';
const NUM_CHANNELS = 1;

export interface TTSOptions {
  voiceUuid: string;
  sampleRate: number;
  precision: Precision;
  outputFormat: OutputFormat;
  binaryResponse: boolean;
  noAudioHeader: boolean;
  apiKey?: string;
}

const defaultTTSOptions: TTSOptions = {
  voiceUuid: '',
  sampleRate: 44100,
  precision: 'PCM_16',
  outputFormat: 'wav',
  binaryResponse: true,
  noAudioHeader: true,
  apiKey: process.env.RESEMBLE_API_KEY,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'resemble.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(opts.sampleRate || defaultTTSOptions.sampleRate, NUM_CHANNELS, {
      streaming: false, // Set to false for now to use chunked approach
    });

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
    };

    if (!this.#opts.voiceUuid) {
      throw new Error('Resemble voice UUID is required');
    }

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Resemble API key is required, whether as an argument or as $RESEMBLE_API_KEY',
      );
    }
  }

  updateOptions(opts: Partial<TTSOptions>): void {
    this.#opts = {
      ...this.#opts,
      ...opts,
    };
  }

  synthesize(text: string): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts);
  }

  stream(): tts.SynthesizeStream {
    // Use a simple implementation that just collects text and uses the chunked API
    return new SimpleSynthesizeStream(this, this.#opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'resemble.ChunkedStream';
  #opts: TTSOptions;
  #text: string;
  #logger = log();

  constructor(tts: TTS, text: string, opts: TTSOptions) {
    super(text, tts);
    this.#text = text;
    this.#opts = opts;
    this.#run();
  }

  async #run() {
    const requestId = randomUUID();
    const segmentId = randomUUID();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

    try {
      // Prepare request payload
      const payload = {
        voice_uuid: this.#opts.voiceUuid,
        data: this.#text,
        sample_rate: this.#opts.sampleRate,
        output_format: this.#opts.outputFormat.toLowerCase(),
        precision: this.#opts.precision,
        binary_response: this.#opts.binaryResponse,
        no_audio_header: this.#opts.noAudioHeader,
      };

      // Parse the URL to get the hostname, path, etc.
      const url = new URL(RESEMBLE_REST_API_URL);

      this.#logger.info(`Sending HTTP request to Resemble API: ${url.toString()}`);
      this.#logger.debug(`Request payload: ${JSON.stringify(payload)}`);

      // Add this right before sending the request
      this.#logger.info(`Sending payload: ${JSON.stringify(payload)}`);

      // Create a promise that will resolve or reject based on the HTTP response
      await new Promise<void>((resolve, reject) => {
        // Make the HTTP request
        const req = request(
          {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.#opts.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          },
          (res) => {
            let data = '';
            let audioBuffer: Buffer | null = null;

            res.on('data', (chunk) => {
              if (this.#opts.binaryResponse && res.headers['content-type']?.includes('audio/')) {
                // Handle binary response
                if (!audioBuffer) {
                  audioBuffer = Buffer.from(chunk);
                } else {
                  audioBuffer = Buffer.concat([audioBuffer, chunk]);
                }
              } else {
                // Handle JSON response
                data += chunk;
              }
            });

            res.on('end', () => {
              this.#logger.info(
                `Received response from Resemble API with status: ${res.statusCode}`,
              );

              try {
                // Check for HTTP error status
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                  reject(new Error(`HTTP error ${res.statusCode}: ${data}`));
                  return;
                }

                if (audioBuffer) {
                  // Process binary audio data
                  this.#logger.info(`Processing binary audio data: ${audioBuffer.length} bytes`);
                  for (const frame of bstream.write(audioBuffer)) {
                    this.queue.put({
                      requestId,
                      frame,
                      final: false,
                      segmentId,
                    });
                  }

                  // Flush any remaining frames
                  for (const frame of bstream.flush()) {
                    this.queue.put({
                      requestId,
                      frame,
                      final: false,
                      segmentId,
                    });
                  }

                  // Mark the last frame as final
                  this.queue.put({
                    requestId,
                    frame: null as any, // This will be ignored if null
                    final: true,
                    segmentId,
                  });

                  resolve();
                  return;
                }

                // Parse JSON response
                let response;
                try {
                  response = JSON.parse(data);
                } catch (parseError: unknown) {
                  reject(
                    new Error(
                      `Failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                    ),
                  );
                  return;
                }

                if (!response.success) {
                  const issues = response.issues || ['Unknown error'];
                  const errorMsg = issues.join('; ');
                  reject(new Error(`Resemble API returned failure: ${errorMsg}`));
                  return;
                }

                // Decode base64 audio content
                let audioBytes;
                try {
                  audioBytes = Buffer.from(response.audio_content, 'base64');
                } catch (decodeError: unknown) {
                  reject(
                    new Error(
                      `Failed to decode audio content: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`,
                    ),
                  );
                  return;
                }

                // Process audio frames
                this.#logger.info(
                  `Processing audio frames from JSON response: ${audioBytes.length} bytes`,
                );
                for (const frame of bstream.write(audioBytes)) {
                  this.queue.put({
                    requestId,
                    frame,
                    final: false,
                    segmentId,
                  });
                }

                // Flush any remaining frames
                for (const frame of bstream.flush()) {
                  this.queue.put({
                    requestId,
                    frame,
                    final: false,
                    segmentId,
                  });
                }

                // Mark the last frame as final
                this.queue.put({
                  requestId,
                  frame: null as any, // This will be ignored if null
                  final: true,
                  segmentId,
                });

                resolve();
              } catch (error: unknown) {
                reject(
                  new Error(
                    `Failed to process Resemble API response: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            });

            res.on('error', (error) => {
              reject(new Error(`Resemble API request error: ${error.message}`));
            });
          },
        );

        req.on('error', (error) => {
          reject(new Error(`Resemble API connection error: ${error.message}`));
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Resemble API request timed out'));
        });

        // Write request body and end
        req.write(JSON.stringify(payload));
        req.end();
      });
    } catch (error: unknown) {
      this.#logger.error(
        `Error in Resemble TTS synthesis: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.queue.close();
      throw error;
    }
  }
}

// A simple implementation that just collects text and uses the chunked API
export class SimpleSynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  #ttsInstance: TTS;
  #buffer: string = '';
  label = 'resemble.SimpleSynthesizeStream';
  closed = false;

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
    this.#ttsInstance = tts;
    this.#logger.info('SimpleSynthesizeStream constructor called');
    this.#run().catch((error) => {
      this.#logger.error(
        `Unhandled error in SimpleSynthesizeStream: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async #run() {
    this.#logger.info('SimpleSynthesizeStream #run method started');

    try {
      // Process input text
      for await (const text of this.input) {
        if (this.closed) break;

        if (text === SimpleSynthesizeStream.FLUSH_SENTINEL) {
          this.#logger.info('Received flush sentinel, synthesizing buffered text');
          await this.#synthesizeBuffer();
          continue;
        }

        if (typeof text !== 'string') {
          this.#logger.warn(`Received non-string input: ${typeof text}`);
          continue;
        }

        this.#logger.info(`Adding text to buffer: ${text.substring(0, 50)}`);
        this.#buffer += text;
      }

      // Synthesize any remaining text
      if (this.#buffer.trim().length > 0) {
        this.#logger.info('Input ended, synthesizing remaining text');
        await this.#synthesizeBuffer();
      }
    } catch (error: unknown) {
      this.#logger.error(
        `Error in run method: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.queue.close();
    }
  }

  async #synthesizeBuffer() {
    if (!this.#buffer.trim()) {
      this.#logger.info('Buffer is empty, nothing to synthesize');
      return;
    }

    this.#logger.info(`Synthesizing buffer: ${this.#buffer.substring(0, 50)}`);

    try {
      const chunkedStream = new ChunkedStream(this.#ttsInstance, this.#buffer, this.#opts);
      for await (const audio of chunkedStream) {
        this.queue.put(audio);
      }

      // Send END_OF_STREAM to signal completion
      this.queue.put(SimpleSynthesizeStream.END_OF_STREAM);
      this.#logger.info('Sent END_OF_STREAM after synthesizing buffer');

      // Clear the buffer
      this.#buffer = '';
    } catch (error: unknown) {
      this.#logger.error(
        `Error synthesizing buffer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  close() {
    this.#logger.info('Closing SimpleSynthesizeStream');
    this.closed = true;
    super.close();
  }
}
