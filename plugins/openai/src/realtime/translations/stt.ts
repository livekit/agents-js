// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import {
  DEFAULT_INPUT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSLATION_MODEL,
  SAMPLE_RATE,
  type TranslationErrorEvent,
  TranslationSession,
  type TranslationSessionFactory,
  type TranslationSessionLike,
  type TranslationSessionOptions,
  createSessionUpdateEvent,
} from './session.js';

export interface STTOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  inputLanguage?: string;
  outputLanguage: string;
  inputAudioTranscription?: TranslationSessionOptions['inputAudioTranscription'];
  safetyIdentifier?: string;
  /** @internal */
  sessionFactory?: TranslationSessionFactory;
}

const defaultOptions = {
  model: DEFAULT_TRANSLATION_MODEL,
  inputAudioTranscription: { model: DEFAULT_INPUT_TRANSCRIPTION_MODEL },
};

type ResolvedSTTOptions = Omit<STTOptions, 'model'> & {
  model: string;
  inputAudioTranscription: TranslationSessionOptions['inputAudioTranscription'];
};

export class STT extends stt.STT {
  #options: ResolvedSTTOptions;
  #streams = new Set<SpeechStream>();
  label = 'openai.realtime.translations.STT';

  constructor(options: STTOptions) {
    super({ streaming: true, interimResults: true, alignedTranscript: false });
    this.#options = {
      ...defaultOptions,
      ...options,
      inputLanguage: options.inputLanguage ? normalizeLanguage(options.inputLanguage) : undefined,
      outputLanguage: normalizeLanguage(options.outputLanguage),
    };
  }

  get model(): string {
    return this.#options.model;
  }

  get provider(): string {
    try {
      const url = new URL(this.#options.baseURL || 'https://api.openai.com/v1');
      return url.host;
    } catch {
      return 'api.openai.com';
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on OpenAI realtime translation STT');
  }

  updateOptions(opts: Partial<STTOptions>): void {
    this.#options = {
      ...this.#options,
      ...opts,
      model: opts.model ?? this.#options.model,
      inputLanguage: opts.inputLanguage
        ? normalizeLanguage(opts.inputLanguage)
        : this.#options.inputLanguage,
      outputLanguage: opts.outputLanguage
        ? normalizeLanguage(opts.outputLanguage)
        : this.#options.outputLanguage,
    };
    for (const stream of this.#streams) {
      stream.updateOptions(this.#options);
    }
  }

  stream(options: { connOptions?: APIConnectOptions } = {}): SpeechStream {
    const stream = new SpeechStream(
      this,
      { ...this.#options },
      options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
    this.#streams.add(stream);
    return stream;
  }

  async close(): Promise<void> {
    for (const stream of this.#streams) {
      stream.close();
    }
    this.#streams.clear();
  }
}

export class SpeechStream extends stt.SpeechStream {
  label = 'openai.realtime.translations.SpeechStream';
  #options: ResolvedSTTOptions;
  #sessionFactory: TranslationSessionFactory;
  #targetTranscript = '';
  #speechDuration = 0;
  #requestId = 'translation_stt';
  #speaking = false;

  constructor(stt: STT, options: ResolvedSTTOptions, connOptions?: APIConnectOptions) {
    super(stt, SAMPLE_RATE, connOptions);
    this.#options = options;
    this.#sessionFactory = options.sessionFactory || ((opts) => new TranslationSession(opts));
  }

  updateOptions(options: ResolvedSTTOptions): void {
    this.#options = { ...options };
  }

  protected async run(): Promise<void> {
    const session = this.#sessionFactory(this.#sessionOptions());
    await session.connect();
    session.sendEvent(createSessionUpdateEvent(this.#sessionOptions()));

    try {
      await Promise.race([this.#forwardInput(session), this.#forwardEvents(session)]);
    } finally {
      await session.close();
    }
  }

  #sessionOptions(): TranslationSessionOptions {
    return {
      apiKey: this.#options.apiKey,
      baseURL: this.#options.baseURL,
      model: this.#options.model,
      inputLanguage: this.#options.inputLanguage,
      outputLanguage: this.#options.outputLanguage,
      inputAudioTranscription: this.#options.inputAudioTranscription,
      safetyIdentifier: this.#options.safetyIdentifier,
    };
  }

  async #forwardInput(session: TranslationSessionLike): Promise<void> {
    const audioStream = new AudioByteStream(SAMPLE_RATE, 1, SAMPLE_RATE / 10);
    for await (const item of this.input) {
      if (item === SpeechStream.FLUSH_SENTINEL) {
        for (const frame of audioStream.flush()) {
          this.#sendAudioFrame(session, frame);
        }
        this.#emitFinalTranscript();
        continue;
      }

      for (const frame of audioStream.write(item.data.buffer as ArrayBuffer)) {
        this.#sendAudioFrame(session, frame);
      }
    }
  }

  async #forwardEvents(session: TranslationSessionLike): Promise<void> {
    for await (const event of session.events) {
      switch (event.type) {
        case 'session.output_transcript.delta':
          this.#targetTranscript += event.delta;
          this.#emitStartOfSpeech();
          this.queue.put(this.#speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT));
          break;
        case 'session.output_transcript.done':
          this.#emitFinalTranscript();
          break;
        case 'error': {
          const errorEvent = event as TranslationErrorEvent;
          throw new Error(
            errorEvent.error?.message || errorEvent.message || 'OpenAI translation error',
          );
        }
      }
    }
  }

  #emitFinalTranscript(): void {
    if (!this.#targetTranscript) return;
    this.#emitStartOfSpeech();
    this.queue.put(this.#speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT));
    if (this.#speechDuration > 0) {
      this.queue.put({
        type: stt.SpeechEventType.RECOGNITION_USAGE,
        requestId: this.#requestId,
        recognitionUsage: { audioDuration: this.#speechDuration },
      });
      this.#speechDuration = 0;
    }
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    this.#speaking = false;
    this.#targetTranscript = '';
  }

  #emitStartOfSpeech(): void {
    // Translation sessions do not expose speech-start events. Emit lazily with
    // the first transcript delta to match providers that lack explicit starts.
    if (this.#speaking || this.#targetTranscript.length === 0) return;
    this.#speaking = true;
    this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
  }

  #speechEvent(type: stt.SpeechEventType): stt.SpeechEvent {
    return {
      type,
      alternatives: [
        {
          text: this.#targetTranscript,
          language: normalizeLanguage(this.#options.outputLanguage),
          sourceLanguages: this.#options.inputLanguage
            ? [normalizeLanguage(this.#options.inputLanguage)]
            : undefined,
          startTime: 0,
          endTime: 0,
          confidence: 1,
        },
      ],
    };
  }

  #audioFrameToBase64(frame: AudioFrame): string {
    return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString(
      'base64',
    );
  }

  #sendAudioFrame(session: TranslationSessionLike, frame: AudioFrame): void {
    this.#speechDuration += frame.samplesPerChannel / frame.sampleRate;
    session.sendEvent({
      type: 'session.input_audio_buffer.append',
      audio: this.#audioFrameToBase64(frame),
    });
  }
}
