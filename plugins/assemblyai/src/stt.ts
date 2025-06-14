// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioBuffer, AudioByteStream, log, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { AssemblyAI } from 'assemblyai';
import type { RealtimeTranscriber, RealtimeTranscript } from 'assemblyai';

export interface STTOptions {
  apiKey?: string;
  interimResults: boolean;
  sampleRate: number;
  keywords: [string, number][];
  endUtteranceSilenceThreshold?: number;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.ASSEMBLY_AI_KEY,
  interimResults: true,
  sampleRate: 16000,
  keywords: [],
  // NOTE:
  // The default is 700ms from AssemblyAI.
  // We use a low default of 300ms here because we also use
  // the new end-of-utterance model from LiveKit to handle
  // turn detection in my agent. Which means that even though
  // this will quickly return a final transcript EVEN THOUGH
  // USER IS NOT DONE SPEAKING, the EOU model from LiveKit
  // DOES properly differentiate and doesn't interrupt (magically!)
  // Ref: https://blog.livekit.io/using-a-transformer-to-improve-end-of-turn-detection/
  endUtteranceSilenceThreshold: 200,
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #logger = log();
  label = 'assemblyai.STT';

  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    super({
      streaming: true,
      interimResults: opts.interimResults ?? defaultSTTOptions.interimResults,
    });
    if (opts.apiKey === undefined && defaultSTTOptions.apiKey === undefined) {
      throw new Error(
        'AssemblyAI API key is required, whether as an argument or as $ASSEMBLY_AI_KEY',
      );
    }

    this.#opts = { ...defaultSTTOptions, ...opts };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on AssemblyAI STT');
  }

  stream(): stt.SpeechStream {
    return new SpeechStream(this, this.#opts);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  #speaking = false;
  #client: AssemblyAI;
  #transcriber?: RealtimeTranscriber;
  label = 'assemblyai.SpeechStream';

  constructor(stt: STT, opts: STTOptions) {
    super(stt);
    this.#opts = opts;
    this.closed = false;
    this.#client = new AssemblyAI({
      apiKey: this.#opts.apiKey || '',
    });

    this.#run();
  }

  async #run() {
    try {
      this.#transcriber = this.#client.realtime.transcriber({
        sampleRate: this.#opts.sampleRate,
        wordBoost: this.#opts.keywords.map((k) => k[0]),
        endUtteranceSilenceThreshold: this.#opts.endUtteranceSilenceThreshold,
      });

      this.#transcriber.on('open', (data) => {
        this.#logger
          .child({ sessionId: data.sessionId, expiresAt: data.expiresAt })
          .debug(`AssemblyAI session opened`);
      });

      this.#transcriber.on('close', (code, reason) => {
        this.#logger.child({ code, reason }).debug(`AssemblyAI session closed`);
        if (!this.closed) {
          this.#run();
        }
      });

      this.#transcriber.on('error', (error) => {
        this.#logger.child({ error: error.message }).error(`AssemblyAI error`);
      });

      this.#transcriber.on('transcript', (transcript) => {
        if (this.closed) return;

        if (!transcript.text || transcript.text.trim() === '') {
          return;
        }

        if (!this.#speaking) {
          this.#speaking = true;
          this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
        }

        if (transcript.message_type === 'PartialTranscript') {
          this.queue.put({
            type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
            alternatives: [assemblyTranscriptToSpeechData(transcript)],
          });
        } else if (transcript.message_type === 'FinalTranscript') {
          this.queue.put({
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [assemblyTranscriptToSpeechData(transcript)],
          });
        }
      });

      await this.#transcriber.connect();

      const sendTask = async () => {
        const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
        const stream = new AudioByteStream(this.#opts.sampleRate, 1, samples100Ms);

        for await (const data of this.input) {
          if (this.closed) break;

          let frames: AudioFrame[];
          if (data === SpeechStream.FLUSH_SENTINEL) {
            frames = stream.flush();
          } else if (data.sampleRate === this.#opts.sampleRate) {
            frames = stream.write(data.data.buffer);
          } else {
            throw new Error(`Sample rate or channel count of frame does not match`);
          }

          for await (const frame of frames) {
            this.#transcriber?.sendAudio(new Uint8Array(frame.data.buffer));
          }
        }

        if (this.#transcriber) {
          await this.#transcriber.close();
        }
      };

      await sendTask();
    } catch (error: unknown) {
      this.#logger.child({ error }).error(`Error in AssemblyAI STT`);

      if (!this.closed) {
        setTimeout(() => this.#run(), 5000);
      }
    }
  }
}

const assemblyTranscriptToSpeechData = (transcript: RealtimeTranscript): stt.SpeechData => {
  return {
    language: 'en-US',
    startTime: transcript.audio_start || 0,
    endTime: transcript.audio_end || 0,
    confidence: transcript.confidence || 1.0,
    text: transcript.text || '',
  };
};
