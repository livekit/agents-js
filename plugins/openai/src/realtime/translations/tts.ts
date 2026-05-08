// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AsyncIterableQueue,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tts,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import {
  DEFAULT_TRANSLATION_MODEL,
  NUM_CHANNELS,
  SAMPLE_RATE,
  type TranslationErrorEvent,
  type TranslationOutputAudioDeltaEvent,
  type TranslationOutputTranscriptDeltaEvent,
  TranslationSession,
  type TranslationSessionFactory,
  type TranslationSessionLike,
  type TranslationSessionOptions,
  createSessionUpdateEvent,
} from './session.js';

export interface TTSOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  inputLanguage?: string;
  outputLanguage: string;
  safetyIdentifier?: string;
  inputAudioTranscription?: TranslationSessionOptions['inputAudioTranscription'];
  /** @internal */
  sessionFactory?: TranslationSessionFactory;
}

const TEXT_INPUT_UNSUPPORTED =
  'OpenAI realtime translation sessions currently document audio input only; text-to-speech is not supported by gpt-realtime-translate.';

export class TTS extends tts.TTS {
  #options: Required<Pick<TTSOptions, 'model' | 'outputLanguage'>> & TTSOptions;
  #streams = new Set<AudioTranslationStream>();
  label = 'openai.realtime.translations.TTS';

  constructor(options: TTSOptions) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: false, alignedTranscript: false });
    this.#options = {
      model: DEFAULT_TRANSLATION_MODEL,
      ...options,
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

  updateOptions(opts: Partial<TTSOptions>): void {
    this.#options = {
      ...this.#options,
      ...opts,
      model: opts.model ?? this.#options.model,
      outputLanguage: opts.outputLanguage ?? this.#options.outputLanguage,
    };
    for (const stream of this.#streams) {
      stream.updateOptions(this.#options);
    }
  }

  streamAudio(options: { connOptions?: APIConnectOptions } = {}): AudioTranslationStream {
    const stream = new AudioTranslationStream(
      this,
      { ...this.#options },
      options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
    this.#streams.add(stream);
    return stream;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  synthesize(_: string, __?: APIConnectOptions, ___?: AbortSignal): tts.ChunkedStream {
    throw new Error(TEXT_INPUT_UNSUPPORTED);
  }

  stream(): tts.SynthesizeStream {
    throw new Error(TEXT_INPUT_UNSUPPORTED);
  }

  async close(): Promise<void> {
    for (const stream of this.#streams) {
      stream.close();
    }
    this.#streams.clear();
  }
}

export class AudioTranslationStream
  extends tts.SynthesizeStream
  implements
    AsyncIterableIterator<tts.SynthesizedAudio | typeof tts.SynthesizeStream.END_OF_STREAM>
{
  #audioInput = new AsyncIterableQueue<AudioFrame | typeof AudioTranslationStream.FLUSH_SENTINEL>();
  #options: Required<Pick<TTSOptions, 'model' | 'outputLanguage'>> & TTSOptions;
  #sessionFactory: TranslationSessionFactory;
  #requestId = shortuuid('translation_tts_');
  #segmentId = shortuuid('translation_segment_');
  #deltaText = '';
  label = 'openai.realtime.translations.AudioTranslationStream';

  constructor(
    tts: TTS,
    options: Required<Pick<TTSOptions, 'model' | 'outputLanguage'>> & TTSOptions,
    connOptions?: APIConnectOptions,
  ) {
    super(tts, connOptions);
    this.#options = options;
    this.#sessionFactory = options.sessionFactory || ((opts) => new TranslationSession(opts));
  }

  updateOptions(
    options: Required<Pick<TTSOptions, 'model' | 'outputLanguage'>> & TTSOptions,
  ): void {
    this.#options = { ...options };
  }

  pushFrame(frame: AudioFrame): void {
    if (this.closed) return;
    this.#audioInput.put(frame);
  }

  flush(): void {
    if (this.closed) return;
    this.#audioInput.put(AudioTranslationStream.FLUSH_SENTINEL);
  }

  endInput(): void {
    this.#audioInput.close();
  }

  override close(): void {
    this.#audioInput.close();
    super.close();
  }

  protected async run(): Promise<void> {
    const session = this.#sessionFactory(this.#sessionOptions());
    try {
      await session.connect();
      session.sendEvent(createSessionUpdateEvent(this.#sessionOptions()));
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
    for await (const item of this.#audioInput) {
      if (item === AudioTranslationStream.FLUSH_SENTINEL) {
        this.#segmentId = shortuuid('translation_segment_');
        this.#deltaText = '';
        continue;
      }

      session.sendEvent({
        type: 'session.input_audio_buffer.append',
        audio: this.#audioFrameToBase64(item),
      });
    }
  }

  async #forwardEvents(session: TranslationSessionLike): Promise<void> {
    for await (const event of session.events) {
      switch (event.type) {
        case 'session.output_transcript.delta':
          this.#deltaText += (event as TranslationOutputTranscriptDeltaEvent).delta;
          break;
        case 'session.output_audio.delta':
          this.output.put({
            requestId: this.#requestId,
            segmentId: this.#segmentId,
            frame: this.#audioDeltaToFrame((event as TranslationOutputAudioDeltaEvent).delta),
            deltaText: this.#deltaText,
            final: false,
          });
          break;
        case 'session.output_audio.done':
          this.output.put(tts.SynthesizeStream.END_OF_STREAM);
          this.#segmentId = shortuuid('translation_segment_');
          this.#deltaText = '';
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

  #audioDeltaToFrame(delta: string): AudioFrame {
    const bytes = Buffer.from(delta, 'base64');
    return new AudioFrame(
      new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
      SAMPLE_RATE,
      NUM_CHANNELS,
      bytes.byteLength / 2,
    );
  }

  #audioFrameToBase64(frame: AudioFrame): string {
    return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString(
      'base64',
    );
  }
}
