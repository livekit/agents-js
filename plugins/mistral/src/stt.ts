import {
  type APIConnectOptions,
  type AudioBuffer,
  mergeFrames,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import { type AudioFrame } from '@livekit/rtc-node';
import { Mistral } from '@mistralai/mistralai';
import { RealtimeTranscription } from '@mistralai/mistralai/extra/realtime';
import { AudioEncoding } from '@mistralai/mistralai/extra/realtime';
import type { MistralSTTModels } from './models.js';

type audioFormat = {
  encoding: AudioEncoding;
  sampleRate: number;
};

export interface STTOptions {
  apiKey?: string;
  language: string;
  liveModel: MistralSTTModels | string;
  offlineModel: MistralSTTModels | string;
  audioFormat: audioFormat;
  baseURL?: string;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.MISTRAL_API_KEY,
  language: 'en',
  liveModel: 'voxtral-mini-transcribe-realtime-2602',
  offlineModel: 'voxtral-small-latest',
  audioFormat: { encoding: AudioEncoding.PcmS16le, sampleRate: 16000 },
  baseURL: 'https://api.mistral.ai',
};

export class STT extends stt.STT {
  #opts: STTOptions;
  #client: RealtimeTranscription;
  label = 'mistral.STT';

  constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
    super({ streaming: true, interimResults: true, alignedTranscript: 'word', diarization: false });

    if (!opts.apiKey) {
      throw new Error('Mistral API key is required');
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
    };

    this.#client = new RealtimeTranscription({
      apiKey: this.#opts.apiKey,
      serverURL: this.#opts.baseURL,
    });
  }

  get options(): Readonly<STTOptions> {
    return this.#opts;
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

  async _recognize(frame: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    let buffer = mergeFrames(frame);
    let wavBuffer = this.#createWav(buffer);
    const audio_file = new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' });

    // Use the standard Mistral client for offline transcripts
    const offlineClient = new Mistral({ apiKey: this.#opts.apiKey, serverURL: this.#opts.baseURL });

    const resp = await offlineClient.audio.transcriptions.complete(
      {
        file: {
          content: audio_file,
          fileName: 'audio.wav',
        },
        model: this.#opts.offlineModel as string,
      },
      {
        fetchOptions: { signal: abortSignal },
      },
    );

    // Return the final result to LiveKit
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: resp.text || '',
          language: normalizeLanguage(this.#opts.language),
          startTime: 0,
          endTime: 0,
          confidence: 1.0,
        },
      ],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    // All this does is instantiate our async listener!
    return new SpeechStream(this.#client, this, this.#opts.audioFormat, options?.connOptions);
  }
}

export class SpeechStream extends stt.SpeechStream {
  label = 'mistral.SpeechStream';
  #stt: STT;
  #client: RealtimeTranscription;
  #audioFormat: audioFormat;

  constructor(
    client: RealtimeTranscription,
    sttInstance: STT,
    audioFormat: audioFormat,
    connOptions?: APIConnectOptions,
  ) {
    super(sttInstance, audioFormat.sampleRate, connOptions);
    this.#stt = sttInstance;
    this.#client = client;
    this.#audioFormat = audioFormat;
  }

  protected async run(): Promise<void> {
    let currentText = '';
    const createAudioGenerator = async function* (that: SpeechStream) {
      for await (const chunk of that.input) {
        if (chunk === stt.SpeechStream.FLUSH_SENTINEL) {
          continue;
        }

        const pcmBuffer = Buffer.from(chunk.data.buffer);
        yield new Uint8Array(pcmBuffer);
      }
    };

    const audioStream = createAudioGenerator(this);

    try {
      for await (const event of this.#client.transcribeStream(
        audioStream,
        this.#stt.options.liveModel,
        { audioFormat: this.#audioFormat },
      )) {
        if (event.type === 'transcription.text.delta') {
          const typedEvent = event as any;
          currentText += typedEvent.text || '';
          this.output.put({
            type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
            alternatives: [
              {
                text: currentText,
                language: normalizeLanguage(this.#stt.options.language),
                startTime: 0,
                endTime: 0,
                confidence: 1.0,
              },
            ],
          });
        } else if (event.type === 'transcription.segment') {
          const typedEvent = event as any;
          currentText = typedEvent.text || currentText;
          this.output.put({
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [
              {
                text: currentText,
                language: normalizeLanguage(this.#stt.options.language),
                startTime: typedEvent.start || 0,
                endTime: typedEvent.end || 0,
                confidence: 1.0,
              },
            ],
          });
          currentText = ''; // reset for the next utterance
        } else if (event.type === 'transcription.done') {
          if (currentText.trim().length > 0) {
            this.output.put({
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              alternatives: [
                {
                  text: currentText,
                  language: normalizeLanguage(this.#stt.options.language),
                  startTime: 0,
                  endTime: 0,
                  confidence: 1.0,
                },
              ],
            });
          }
          break;
        } else if (event.type === 'error') {
          const errEvent = event as any;
          const errorMessage =
            typeof errEvent.error === 'string' ? errEvent.error : JSON.stringify(errEvent.error);
          console.error(`\nTranscription error: ${errorMessage}`);
          break;
        }
      }
    } finally {
      await audioStream.return?.();
    }
  }
}
