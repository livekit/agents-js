// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { ApiError as GenAIAPIError, GoogleGenAI, Modality } from '@google/genai';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  type LanguageCode,
  log,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { readFile } from 'node:fs/promises';

const DEFAULT_MODEL = 'gemini-3.5-transcribe-live';
const DEFAULT_SAMPLE_RATE = 16000;
const FINALIZE_TIMEOUT = 2000;
const NORMAL_CLOSE_CODE = 1000;

export interface STTOptions {
  model: string;
  language: string | null;
  languageCodes?: string[];
  customVocabulary?: string[];
  sampleRate: number;
  apiKey?: string;
  vertexai?: boolean;
  credentials?: object | string;
  credentialsPath?: string;
  project?: string;
  location?: string;
  httpOptions?: types.HttpOptions;
}

interface StreamOptions {
  model: string;
  language: LanguageCode | null;
  languageCodes?: string[];
  customVocabulary?: string[];
  sampleRate: number;
  apiKey?: string;
  vertexai?: boolean;
  credentials?: object | string;
  credentialsPath?: string;
  project?: string;
  location?: string;
  httpOptions?: types.HttpOptions;
}

interface TranscriptState {
  defaultLanguage: LanguageCode;
  language: LanguageCode;
  pendingInterim: string;
}

function isSessionDurationClose(error: unknown): boolean {
  const text = String(error);
  return text.includes('GoAway') || text.includes('session duration');
}

export class STT extends stt.STT {
  readonly label = 'google.gemini.STT';
  #opts: StreamOptions;

  constructor({
    model = DEFAULT_MODEL,
    language = 'en-US',
    languageCodes,
    customVocabulary,
    sampleRate = DEFAULT_SAMPLE_RATE,
    apiKey,
    vertexai,
    credentials,
    credentialsPath,
    project,
    location,
    httpOptions,
  }: Partial<STTOptions> = {}) {
    super({ streaming: true, interimResults: true, alignedTranscript: false });
    this.#opts = {
      model,
      language: language === null ? null : normalizeLanguage(language),
      languageCodes,
      customVocabulary,
      sampleRate,
      apiKey,
      vertexai,
      credentials,
      credentialsPath,
      project,
      location,
      httpOptions,
    };
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'google';
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('Gemini STT only supports streaming recognition');
  }

  stream(options?: { language?: string; connOptions?: APIConnectOptions }): stt.SpeechStream {
    return new SpeechStream(
      this,
      {
        ...this.#opts,
        language:
          options?.language !== undefined
            ? normalizeLanguage(options.language)
            : this.#opts.language,
      },
      options?.connOptions,
    );
  }
}

class SpeechStream extends stt.SpeechStream {
  readonly label = 'google.gemini.SpeechStream';
  #opts: StreamOptions;
  #logger = log();

  constructor(geminiSTT: STT, opts: StreamOptions, connOptions?: APIConnectOptions) {
    super(geminiSTT, opts.sampleRate, connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    let session: types.Session | undefined;
    let sendTask: Promise<void> | undefined;
    const attemptAbort = new AbortController();
    let acceptSession = true;

    try {
      const client = await this.#createClient();
      let resolveReceive!: () => void;
      let rejectReceive!: (reason: unknown) => void;
      const receiveDone = new Promise<void>((resolve, reject) => {
        resolveReceive = resolve;
        rejectReceive = reject;
      });
      const state = this.#newTranscriptState();

      const connectTask = client.live.connect({
        model: this.#opts.model,
        config: this.#connectConfig(),
        callbacks: {
          onopen: () => {},
          onmessage: (message: types.LiveServerMessage) => {
            try {
              this.#processMessage(message, state);
            } catch (error) {
              rejectReceive(error);
            }
          },
          onerror: (event: ErrorEvent) => {
            const error = event.error ?? event.message ?? event;
            this.#logger.warn(
              { errorType: errorName(error), 'lk.pii.error': String(error) },
              'Gemini STT connection failed',
            );
            rejectReceive(
              new APIConnectionError({
                message: `Gemini STT connection failed (${errorName(error)})`,
              }),
            );
          },
          onclose: (event: CloseEvent) => {
            if (event.code === NORMAL_CLOSE_CODE) {
              this.#logger.debug(
                { 'lk.pii.error': event.reason },
                'Gemini ASR session closed normally',
              );
              resolveReceive();
              return;
            }

            const error = new Error(event.reason || `WebSocket closed with code ${event.code}`);
            if (isSessionDurationClose(error)) {
              this.#logger.debug(
                { errorType: error.name, 'lk.pii.error': String(error) },
                'Gemini ASR session reached its duration limit, reconnecting',
              );
            } else {
              this.#logger.warn(
                { errorType: error.name, 'lk.pii.error': String(error) },
                'Gemini ASR receive error',
              );
            }
            rejectReceive(
              new APIStatusError({
                message: `Gemini STT request failed (${error.name})`,
                options: { statusCode: event.code, body: null, retryable: true },
              }),
            );
          },
        },
      });

      void connectTask
        .then(async (connectedSession) => {
          if (!acceptSession) await connectedSession.close();
        })
        .catch(() => {});

      const connected = await Promise.race([
        connectTask.then((connectedSession) => ({ kind: 'connected' as const, connectedSession })),
        receiveDone.then(() => ({ kind: 'closed' as const })),
        waitForAbort(this.abortSignal).then(() => ({ kind: 'aborted' as const })),
      ]);
      if (connected.kind === 'aborted') return;
      if (connected.kind === 'closed') {
        throw new APIConnectionError({
          message: 'Gemini STT connection closed before setup completed',
        });
      }
      session = connected.connectedSession;

      sendTask = this.#sendLoop(session, attemptAbort.signal);
      const first = await Promise.race([
        sendTask.then(() => 'send' as const),
        receiveDone.then(() => 'receive' as const),
        waitForAbort(this.abortSignal).then(() => 'abort' as const),
      ]);

      if (first === 'send') {
        await Promise.race([
          receiveDone,
          new Promise<void>((resolve) => setTimeout(resolve, FINALIZE_TIMEOUT)),
          waitForAbort(this.abortSignal),
        ]);
      }
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;

      if (error instanceof GenAIAPIError) {
        const fields = { errorType: errorName(error), 'lk.pii.error': String(error) };
        if (isSessionDurationClose(error)) {
          this.#logger.debug(fields, 'Gemini STT request failed');
        } else {
          this.#logger.warn(fields, 'Gemini STT request failed');
        }
        throw new APIStatusError({
          message: `Gemini STT request failed (${errorName(error)})`,
          options: { statusCode: Number(error.status) || -1, body: null },
        });
      }

      if (isSessionDurationClose(error)) {
        this.#logger.debug(
          { errorType: errorName(error), 'lk.pii.error': String(error) },
          'Gemini STT connection failed',
        );
      } else {
        this.#logger.warn(
          { errorType: errorName(error), 'lk.pii.error': String(error) },
          'Gemini STT connection failed',
        );
      }
      throw new APIConnectionError({
        message: `Gemini STT connection failed (${errorName(error)})`,
      });
    } finally {
      acceptSession = false;
      attemptAbort.abort();
      await sendTask?.catch(() => {});
      await session?.close();
    }
  }

  async #createClient(): Promise<GoogleGenAI> {
    let creds: object | undefined;
    let projectId = this.#opts.project;

    if (this.#opts.credentials) {
      if (typeof this.#opts.credentials === 'string') {
        const jsonAccountInfo = JSON.parse(this.#opts.credentials) as Record<string, unknown>;
        projectId = projectId ?? (jsonAccountInfo.project_id as string | undefined);
        creds = jsonAccountInfo;
      } else {
        creds = this.#opts.credentials;
      }
    } else if (this.#opts.credentialsPath) {
      const jsonAccountInfo = JSON.parse(
        await readFile(this.#opts.credentialsPath, 'utf8'),
      ) as Record<string, unknown>;
      projectId = projectId ?? (jsonAccountInfo.project_id as string | undefined);
      creds = jsonAccountInfo;
    }

    // Env fallbacks (GOOGLE_API_KEY/GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION,
    // GOOGLE_GENAI_USE_VERTEXAI) are resolved by the genai client itself, so only explicitly
    // passed options participate in the backend choice here.
    let isEnterprise = this.#opts.vertexai;
    if (isEnterprise === undefined) {
      if (this.#opts.apiKey !== undefined) {
        isEnterprise = false;
      } else if (creds || projectId || this.#opts.location) {
        isEnterprise = true;
      }
    }

    const clientOptions: types.GoogleGenAIOptions = {
      apiKey: this.#opts.apiKey,
      httpOptions: this.#opts.httpOptions,
    };

    if (isEnterprise) {
      clientOptions.enterprise = true;
      if (projectId) clientOptions.project = projectId;
      clientOptions.location = this.#opts.location ?? 'global';
      if (creds) {
        clientOptions.googleAuthOptions = {
          credentials: creds,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        };
      }
    }

    return new GoogleGenAI(clientOptions);
  }

  #connectConfig(): types.LiveConnectConfig {
    let langCodes = this.#opts.languageCodes;
    if (langCodes === undefined && this.#opts.language) {
      langCodes = [this.#opts.language];
    }

    // An empty list means "detect the language", per
    // https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
    // Both backends accept these -- verified against gemini-3.5-transcribe-live on the
    // Gemini Developer API, which takes them the same as Vertex.
    const inputAudioTranscription: types.AudioTranscriptionConfig = {
      languageCodes: langCodes ?? [],
      customVocabulary: this.#opts.customVocabulary?.length
        ? this.#opts.customVocabulary
        : undefined,
    };

    return {
      responseModalities: [Modality.TEXT],
      inputAudioTranscription,
    };
  }

  async #sendLoop(session: types.Session, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let result: IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>;
      try {
        result = await this.input.next({ signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (result.done) break;
      const data = result.value;
      if (data === SpeechStream.FLUSH_SENTINEL) continue;

      const bytes = Buffer.from(data.data.buffer, data.data.byteOffset, data.data.byteLength);
      if (bytes.byteLength === 0) continue;

      session.sendRealtimeInput({
        audio: {
          data: bytes.toString('base64'),
          mimeType: `audio/pcm;rate=${this.#opts.sampleRate}`,
        },
      });
    }

    if (signal.aborted) return;

    try {
      session.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      // The receive side may have already closed the session.
    }
  }

  #newTranscriptState(): TranscriptState {
    const defaultLanguage = this.#opts.language ?? normalizeLanguage('en-US');
    return { defaultLanguage, language: defaultLanguage, pendingInterim: '' };
  }

  #processMessage(message: types.LiveServerMessage, state: TranscriptState): void {
    const serverContent = message.serverContent;
    if (!serverContent) return;

    const interim = serverContent.interimInputTranscription;
    if (interim) {
      if (interim.languageCode) state.language = normalizeLanguage(interim.languageCode);
      const text = interim.text?.trim();
      if (text) {
        state.pendingInterim = text;
        this.#put(this.#speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, text, state.language));
      }
    }

    const transcription = serverContent.inputTranscription;
    if (transcription) {
      if (transcription.languageCode) {
        state.language = normalizeLanguage(transcription.languageCode);
      }
      const text = transcription.text?.trim();
      if (text) {
        state.pendingInterim = '';
        this.#put(this.#speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, text, state.language));
        state.language = state.defaultLanguage;
      }
    }

    if (serverContent.generationComplete || serverContent.turnComplete) {
      if (state.pendingInterim) {
        this.#put(
          this.#speechEvent(
            stt.SpeechEventType.FINAL_TRANSCRIPT,
            state.pendingInterim,
            state.language,
          ),
        );
        state.pendingInterim = '';
      }
      state.language = state.defaultLanguage;
    }
  }

  #speechEvent(type: stt.SpeechEventType, text: string, language: LanguageCode): stt.SpeechEvent {
    return {
      type,
      alternatives: [{ language, text, confidence: 1, startTime: 0, endTime: 0 }],
    };
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) this.queue.put(event);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export { isSessionDurationClose as _isSessionDurationClose };
