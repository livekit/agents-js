// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  asLanguageCode,
  log,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';

export { speechsdk };

/** @public */
export interface STTOptions {
  /** Azure Speech subscription key. Defaults to `AZURE_SPEECH_KEY`. */
  speechKey?: string;
  /** Azure Speech region. Defaults to `AZURE_SPEECH_REGION`. */
  speechRegion?: string;
  /** Azure Speech container host. Defaults to `AZURE_SPEECH_HOST`. */
  speechHost?: string;
  /** Ephemeral Microsoft Entra auth token. */
  speechAuthToken?: string;
  /** Azure Speech endpoint URL. */
  speechEndpoint?: string;
  sampleRate: number;
  numChannels: number;
  segmentationSilenceTimeoutMs?: number;
  segmentationMaxTimeMs?: number;
  segmentationStrategy?: string;
  language: string[];
  profanity?: speechsdk.ProfanityOption;
  phraseList?: string[] | null;
  explicitPunctuation: boolean;
  trueTextPostProcessing: boolean;
}

/** @public */
export type STTUpdateOptions = Partial<
  Pick<
    STTOptions,
    'segmentationSilenceTimeoutMs' | 'segmentationMaxTimeMs' | 'segmentationStrategy'
  >
> & {
  language?: string | string[];
};

/** @public */
export interface STTConstructorOptions extends STTUpdateOptions {
  speechKey?: string;
  speechRegion?: string;
  speechHost?: string;
  speechAuthToken?: string;
  speechEndpoint?: string;
  sampleRate?: number;
  numChannels?: number;
  profanity?: speechsdk.ProfanityOption;
  phraseList?: string[] | null;
  explicitPunctuation?: boolean;
  trueTextPostProcessing?: boolean;
}

/** @internal */
export interface _CanceledEvent {
  errorDetails?: string;
  reason: speechsdk.CancellationReason;
  errorCode?: speechsdk.CancellationErrorCode;
}

/** @internal */
export interface _WaitableEvent {
  isSet: boolean;
  wait(): Promise<void>;
  set(): void;
  clear(): void;
}

class DeferredEvent implements _WaitableEvent {
  #resolve?: () => void;
  #promise: Promise<void>;
  isSet = false;

  constructor() {
    this.#promise = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }

  wait(): Promise<void> {
    return this.#promise;
  }

  set(): void {
    if (this.isSet) return;
    this.isSet = true;
    this.#resolve?.();
  }

  clear(): void {
    if (!this.isSet) return;
    this.isSet = false;
    this.#promise = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }
}

const defaultSTTOptions = {
  sampleRate: 16000,
  numChannels: 1,
  language: ['en-US'],
  explicitPunctuation: false,
  trueTextPostProcessing: false,
} satisfies Pick<
  STTOptions,
  'sampleRate' | 'numChannels' | 'language' | 'explicitPunctuation' | 'trueTextPostProcessing'
>;

/** @public */
export class STT extends stt.STT {
  #opts: STTOptions;
  #streams = new Set<WeakRef<SpeechStream>>();
  label = 'azure.STT';

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'Azure STT';
  }

  constructor(opts: STTConstructorOptions = {}) {
    super({ streaming: true, interimResults: true, alignedTranscript: 'chunk' });

    const speechHost = opts.speechHost ?? process.env.AZURE_SPEECH_HOST;
    const speechKey = opts.speechKey ?? process.env.AZURE_SPEECH_KEY;
    const speechRegion = opts.speechRegion ?? process.env.AZURE_SPEECH_REGION;
    const speechAuthToken = opts.speechAuthToken;
    const speechEndpoint = opts.speechEndpoint;

    if (
      !speechHost &&
      !(speechKey && speechRegion) &&
      !(speechAuthToken && speechRegion) &&
      !(speechKey && speechEndpoint)
    ) {
      throw new Error(
        'AZURE_SPEECH_HOST or AZURE_SPEECH_KEY and AZURE_SPEECH_REGION or speechAuthToken and AZURE_SPEECH_REGION or AZURE_SPEECH_KEY and speechEndpoint must be set',
      );
    }

    if (speechRegion && speechEndpoint) {
      log().warn('speechRegion and speechEndpoint both are set, using speechEndpoint');
    }

    this.#opts = {
      ...defaultSTTOptions,
      ...opts,
      speechHost,
      speechKey,
      speechRegion: speechEndpoint ? undefined : speechRegion,
      speechAuthToken,
      speechEndpoint,
      language: normalizeLanguages(opts.language),
    };
  }

  async _recognize(_frame: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Azure STT does not support single frame recognition');
  }

  updateOptions(opts: STTUpdateOptions): void {
    this.#opts = {
      ...this.#opts,
      ...opts,
      language:
        opts.language === undefined ? this.#opts.language : normalizeLanguages(opts.language),
    };

    for (const ref of this.#streams) {
      const stream = ref.deref();
      if (stream) {
        stream.updateOptions(opts);
      } else {
        this.#streams.delete(ref);
      }
    }
  }

  stream(options: { language?: string; connOptions?: APIConnectOptions } = {}): SpeechStream {
    const opts = {
      ...this.#opts,
      language: options.language ? [options.language] : [...this.#opts.language],
    };
    const stream = new SpeechStream(this, opts, options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
    this.#streams.add(new WeakRef(stream));
    return stream;
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  /** @internal */
  _opts: STTOptions;
  /** @internal */
  _speaking = false;
  /** @internal */
  _sessionStoppedEvent: _WaitableEvent = new DeferredEvent();
  /** @internal */
  _sessionStartedEvent: _WaitableEvent = new DeferredEvent();
  /** @internal */
  _reconnectEvent: _WaitableEvent = new DeferredEvent();
  /** @internal */
  _cancellationError: _CanceledEvent | null = null;
  #connOptions: APIConnectOptions;
  #audioDuration = 0;
  #lastAudioDurationReportTime = performance.now();
  label = 'azure.SpeechStream';

  constructor(stt: STT, opts: STTOptions, connOptions: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this._opts = opts;
    this.#connOptions = connOptions;
  }

  updateOptions(opts: STTUpdateOptions): void {
    this._opts = {
      ...this._opts,
      ...opts,
      language:
        opts.language === undefined ? this._opts.language : normalizeLanguages(opts.language),
    };
    this._reconnectEvent.set();
  }

  protected async run(): Promise<void> {
    while (!this.input.closed && !this.closed) {
      this._sessionStoppedEvent.clear();
      this._sessionStartedEvent.clear();
      this._cancellationError = null;
      this._speaking = false;

      const pushStream = speechsdk.AudioInputStream.createPushStream(
        speechsdk.AudioStreamFormat.getWaveFormatPCM(
          this._opts.sampleRate,
          16,
          this._opts.numChannels,
        ),
      );
      const recognizer = createSpeechRecognizer(this._opts, pushStream);
      this.#connectRecognizerEvents(recognizer);

      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, (error) => reject(new Error(error)));
      });

      try {
        await withTimeout(this._sessionStartedEvent.wait(), this.#connOptions.timeoutMs);

        const inputAbortController = new AbortController();
        const inputTask = this.#processInput(pushStream, inputAbortController.signal);
        let inputEnded = false;
        try {
          const completed = await Promise.race([
            inputTask.then(() => 'input' as const),
            this._reconnectEvent.wait().then(() => 'reconnect' as const),
            this._sessionStoppedEvent.wait().then(() => 'stopped' as const),
          ]);

          if (completed === 'stopped') {
            const details = this._cancellationError as _CanceledEvent | null;
            if (details !== null) {
              throw new APIConnectionError({
                message:
                  `Azure STT canceled: ${details.errorDetails || details.reason} ` +
                  `(${details.errorCode})`,
              });
            }
            throw new APIConnectionError({ message: 'SpeechRecognition session stopped' });
          }

          if (completed === 'reconnect') {
            this._reconnectEvent.clear();
          }

          inputEnded = completed === 'input';
        } finally {
          inputAbortController.abort();
          await inputTask;
          pushStream.close();
        }

        if (inputEnded) {
          await this._sessionStoppedEvent.wait();
          break;
        }
      } finally {
        await new Promise<void>((resolve) => {
          recognizer.stopContinuousRecognitionAsync(resolve, () => resolve());
        });
        recognizer.close();
      }
    }
  }

  async #processInput(
    pushStream: speechsdk.PushAudioInputStream,
    abortSignal: AbortSignal,
  ): Promise<void> {
    try {
      while (!this.closed) {
        let result: IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>;
        try {
          result = await this.input.next({ signal: abortSignal });
        } catch (error) {
          if (abortSignal.aborted) break;
          throw error;
        }
        if (result.done) break;

        const input = result.value;
        if (input === SpeechStream.FLUSH_SENTINEL) {
          this.#emitRecognitionUsage();
          continue;
        }

        this.#audioDuration += input.samplesPerChannel / input.sampleRate;
        this.#maybeEmitRecognitionUsage();
        pushStream.write(toArrayBuffer(input));
      }
    } finally {
      this.#emitRecognitionUsage();
    }
  }

  #connectRecognizerEvents(recognizer: speechsdk.SpeechRecognizer): void {
    recognizer.recognizing = (_sender, evt) => this._onRecognizing(evt);
    recognizer.recognized = (_sender, evt) => this._onRecognized(evt);
    recognizer.speechStartDetected = (_sender, evt) => this._onSpeechStart(evt);
    recognizer.speechEndDetected = (_sender, evt) => this._onSpeechEnd(evt);
    recognizer.sessionStarted = (_sender, evt) => this._onSessionStarted(evt);
    recognizer.sessionStopped = (_sender, evt) => this._onSessionStopped(evt);
    recognizer.canceled = (_sender, evt) => this._onCanceled(evt);
  }

  /** @internal */
  _onRecognized(evt: speechsdk.SpeechRecognitionEventArgs): void {
    const text = evt.result.text.trim();
    if (!text) return;

    this.queue.put({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [this.#speechData(evt, 1)],
    });
  }

  /** @internal */
  _onRecognizing(evt: speechsdk.SpeechRecognitionEventArgs): void {
    const text = evt.result.text.trim();
    if (!text) return;

    this.queue.put({
      type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [this.#speechData(evt, 0)],
    });
  }

  /** @internal */
  _onSpeechStart(_evt: speechsdk.RecognitionEventArgs): void {
    if (this._speaking) return;
    this._speaking = true;
    this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
  }

  /** @internal */
  _onSpeechEnd(_evt: speechsdk.RecognitionEventArgs): void {
    if (!this._speaking) return;
    this._speaking = false;
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
  }

  /** @internal */
  _onSessionStarted(_evt: speechsdk.SessionEventArgs): void {
    this._sessionStartedEvent.set();
  }

  /** @internal */
  _onSessionStopped(_evt: speechsdk.SessionEventArgs): void {
    this._sessionStoppedEvent.set();
  }

  /** @internal */
  _onCanceled(evt: _CanceledEvent): void {
    if (evt.reason === speechsdk.CancellationReason.Error) {
      log().warn(
        {
          code: evt.errorCode,
          reason: evt.reason,
          errorDetails: evt.errorDetails,
        },
        `Speech recognition canceled: ${evt.errorDetails || evt.reason}`,
      );
      this._cancellationError = evt;
      this._sessionStoppedEvent.set();
    }
  }

  #speechData(evt: speechsdk.SpeechRecognitionEventArgs, confidence: number): stt.SpeechData {
    const result = speechsdk.AutoDetectSourceLanguageResult.fromResult(evt.result);
    const language = result.language || this._opts.language[0] || '';
    return {
      language: asLanguageCode(language),
      confidence,
      text: evt.result.text,
      startTime: evt.result.offset / 10 ** 7 + this.startTimeOffset,
      endTime: (evt.result.offset + evt.result.duration) / 10 ** 7 + this.startTimeOffset,
    };
  }

  #maybeEmitRecognitionUsage(): void {
    if (performance.now() - this.#lastAudioDurationReportTime >= 5000) {
      this.#emitRecognitionUsage();
    }
  }

  #emitRecognitionUsage(): void {
    if (this.#audioDuration <= 0) return;

    const audioDuration = this.#audioDuration;
    this.#audioDuration = 0;
    this.#lastAudioDurationReportTime = performance.now();
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      recognitionUsage: { audioDuration },
    });
  }
}

function normalizeLanguages(language?: string | string[]): string[] {
  if (language === undefined) return [...defaultSTTOptions.language];
  return Array.isArray(language) ? [...language] : [language];
}

function createSpeechRecognizer(
  config: STTOptions,
  stream: speechsdk.PushAudioInputStream,
): speechsdk.SpeechRecognizer {
  const speechConfig = createSpeechConfig(config);

  if (config.segmentationSilenceTimeoutMs !== undefined) {
    speechConfig.setProperty(
      speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
      String(config.segmentationSilenceTimeoutMs),
    );
  }
  if (config.segmentationMaxTimeMs !== undefined) {
    speechConfig.setProperty(
      speechsdk.PropertyId.Speech_SegmentationMaximumTimeMs,
      String(config.segmentationMaxTimeMs),
    );
  }
  if (config.segmentationStrategy !== undefined) {
    speechConfig.setProperty(
      speechsdk.PropertyId.Speech_SegmentationStrategy,
      config.segmentationStrategy,
    );
  }
  if (config.profanity !== undefined) {
    speechConfig.setProfanity(config.profanity);
  }
  if (config.explicitPunctuation) {
    speechConfig.setServiceProperty(
      'punctuation',
      'explicit',
      speechsdk.ServicePropertyChannel.UriQueryParameter,
    );
  }
  if (config.trueTextPostProcessing) {
    speechConfig.setProperty(
      speechsdk.PropertyId.SpeechServiceResponse_PostProcessingOption,
      'TrueText',
    );
  }

  const audioConfig = speechsdk.AudioConfig.fromStreamInput(stream);
  const recognizer =
    config.language.length > 1
      ? createMultiLanguageRecognizer(speechConfig, audioConfig, config.language)
      : new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

  if (config.phraseList?.length) {
    const phraseListGrammar = speechsdk.PhraseListGrammar.fromRecognizer(recognizer);
    for (const phrase of config.phraseList) {
      phraseListGrammar.addPhrase(phrase);
    }
  }

  return recognizer;
}

function createSpeechConfig(config: STTOptions): speechsdk.SpeechConfig {
  if (config.speechEndpoint) {
    const speechConfig = speechsdk.SpeechConfig.fromEndpoint(
      new URL(config.speechEndpoint),
      config.speechKey,
    );
    if (config.speechAuthToken) speechConfig.authorizationToken = config.speechAuthToken;
    speechConfig.speechRecognitionLanguage = firstLanguage(config);
    return speechConfig;
  }
  if (config.speechHost) {
    const speechConfig = speechsdk.SpeechConfig.fromHost(
      new URL(config.speechHost),
      config.speechKey,
    );
    if (config.speechAuthToken) speechConfig.authorizationToken = config.speechAuthToken;
    speechConfig.speechRecognitionLanguage = firstLanguage(config);
    return speechConfig;
  }
  if (config.speechAuthToken) {
    const speechConfig = speechsdk.SpeechConfig.fromAuthorizationToken(
      config.speechAuthToken,
      config.speechRegion!,
    );
    speechConfig.speechRecognitionLanguage = firstLanguage(config);
    return speechConfig;
  }
  const speechConfig = speechsdk.SpeechConfig.fromSubscription(
    config.speechKey!,
    config.speechRegion!,
  );
  speechConfig.speechRecognitionLanguage = firstLanguage(config);
  return speechConfig;
}

function firstLanguage(config: STTOptions): string {
  return config.language[0] ?? 'en-US';
}

function createMultiLanguageRecognizer(
  speechConfig: speechsdk.SpeechConfig,
  audioConfig: speechsdk.AudioConfig,
  languages: string[],
): speechsdk.SpeechRecognizer {
  speechConfig.setProperty(
    speechsdk.PropertyId.SpeechServiceConnection_LanguageIdMode,
    'Continuous',
  );
  const autoDetectSourceLanguageConfig =
    speechsdk.AutoDetectSourceLanguageConfig.fromLanguages(languages);
  return speechsdk.SpeechRecognizer.FromConfig(
    speechConfig,
    autoDetectSourceLanguageConfig,
    audioConfig,
  );
}

function toArrayBuffer(frame: AudioFrame): ArrayBuffer {
  const view = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new APIConnectionError({ message: 'Request timed out.' })),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
