import { v2 } from '@google-cloud/speech';
import type * as protos from '@google-cloud/speech/build/protos/protos.js';
import { type AudioBuffer, AudioByteStream, AudioEnergyFilter, log, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import {
  AudioEncoding,
  type GoogleCredentials,
  type LanguageCode,
  type LanguageType,
  SpeechEventType,
  type SpeechModels,
} from './models.js';

type StreamingRecognizerInitialConfigRequest = {
  recognizer: string;
  streamingConfig: protos.google.cloud.speech.v2.IStreamingRecognitionConfig;
};

// Google STT has a timeout of 5 mins, we'll attempt to restart the session before that timeout is reached
const MAX_SESSION_DURATION = 240;

// Google is very sensitive to background noise, so we'll ignore results with low confidence
const DEFAULT_MIN_CONFIDENCE = 0.65;

export interface STTOptions {
  languages?: LanguageCode;
  detectLanguage?: boolean;
  interimResults?: boolean;
  punctuate?: boolean;
  spokenPunctuation?: boolean;
  model?: SpeechModels | string;
  location?: string;
  sampleRate: number;
  minConfidenceThreshold: number;
  credentialsInfo?: GoogleCredentials;
  credentialsFile?: string;
  keywords?: Array<[string, number]>;
  useStreaming?: boolean;
}

const defaultSTTOptions: STTOptions = {
  languages: 'en-US',
  detectLanguage: true,
  interimResults: true,
  punctuate: true,
  spokenPunctuation: false,
  model: 'latest_long',
  location: 'global',
  sampleRate: 16000,
  minConfidenceThreshold: DEFAULT_MIN_CONFIDENCE,
  useStreaming: true,
};

export interface InternalSTTOptions {
  languages: LanguageType[];
  detectLanguage: boolean;
  interimResults: boolean;
  punctuate: boolean;
  spokenPunctuation: boolean;
  model: SpeechModels | string;
  sampleRate: number;
  minConfidenceThreshold: number;
  keywords?: Array<[string, number]>;
}

export class STT extends stt.STT {
  #opts: STTOptions;
  #config: InternalSTTOptions;
  #location: string;
  #credentialsInfo?: GoogleCredentials;
  #credentialsFile?: string;
  #logger = log();
  #streams = new Set<SpeechStream>();
  #pool: ConnectionPool<v2.SpeechClient>;
  label = 'google.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: opts.useStreaming ?? defaultSTTOptions.useStreaming!,
      interimResults: opts.interimResults ?? defaultSTTOptions.interimResults!,
    });

    this.#opts = { ...defaultSTTOptions, ...opts };
    this.#location = this.#opts.location!;
    this.#credentialsInfo = this.#opts.credentialsInfo;
    this.#credentialsFile = this.#opts.credentialsFile;

    // Validate credentials
    if (!this.#credentialsFile && !this.#credentialsInfo) {
      // Check for Application Default Credentials
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new Error(
          'Google Cloud credentials must be provided, either by using credentialsInfo, ' +
            'credentialsFile, or setting GOOGLE_APPLICATION_CREDENTIALS environment variable.',
        );
      }
    }

    const languages = Array.isArray(this.#opts.languages)
      ? this.#opts.languages
      : [this.#opts.languages!];

    this.#config = {
      languages,
      detectLanguage: this.#opts.detectLanguage!,
      interimResults: this.#opts.interimResults!,
      punctuate: this.#opts.punctuate!,
      spokenPunctuation: this.#opts.spokenPunctuation!,
      model: this.#opts.model!,
      sampleRate: this.#opts.sampleRate!,
      minConfidenceThreshold: this.#opts.minConfidenceThreshold!,
      keywords: this.#opts.keywords,
    };

    this.#pool = new ConnectionPool<v2.SpeechClient>(
      MAX_SESSION_DURATION,
      this.createClient.bind(this),
    );
  }

  private async createClient(): Promise<v2.SpeechClient> {
    let client: v2.SpeechClient;

    const clientOptions = {
      ...(this.#location !== 'global' && {
        apiEndpoint: `${this.#location}-speech.googleapis.com`,
      }),
    };
    if (this.#credentialsInfo) {
      client = new v2.SpeechClient({
        ...clientOptions,
        credentials: this.#credentialsInfo,
      });
    } else if (this.#credentialsFile) {
      client = new v2.SpeechClient({
        ...clientOptions,
        keyFilename: this.#credentialsFile,
      });
    } else {
      client = new v2.SpeechClient(clientOptions);
    }

    return client;
  }

  private getRecognizer(client: v2.SpeechClient): string {
    // Get project ID from credentials or environment
    let projectId: string;

    if (this.#credentialsInfo?.project_id) {
      projectId = this.#credentialsInfo.project_id;
    } else if (process.env.GOOGLE_CLOUD_PROJECT) {
      projectId = process.env.GOOGLE_CLOUD_PROJECT;
    } else {
      // Try to get from client auth
      try {
        projectId = (client as any).authClient?.projectId;
      } catch {
        throw new Error(
          'Project ID is required. Please set GOOGLE_CLOUD_PROJECT environment variable or provide credentials with project_id field.',
        );
      }
    }

    if (!projectId) {
      throw new Error(
        'Project ID is required. Please set GOOGLE_CLOUD_PROJECT environment variable or provide credentials with project_id field.',
      );
    }

    // For Google Speech-to-Text v2, we can use the default recognizer
    return `projects/${projectId}/locations/${this.#location}/recognizers/_`;
  }

  private sanitizeOptions(language?: string): InternalSTTOptions {
    const config = { ...this.#config };

    if (language) {
      config.languages = [language];
    }

    if (!Array.isArray(config.languages)) {
      config.languages = [config.languages];
    } else if (!config.detectLanguage && config.languages.length > 1) {
      this.#logger.warn('Multiple languages provided, but language detection is disabled');
      config.languages = [(config.languages as [string])[0]];
    }

    return config;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on Google STT');
  }

  stream(): stt.SpeechStream {
    const config = this.sanitizeOptions();
    const stream = new SpeechStream(this, this.#pool, this.getRecognizer.bind(this), config);
    this.#streams.add(stream);
    return stream;
  }

  updateOptions(options: Partial<STTOptions>): void {
    if (options.languages !== undefined) {
      const languages = Array.isArray(options.languages) ? options.languages : [options.languages];
      this.#config.languages = languages;
    }
    if (options.detectLanguage !== undefined) {
      this.#config.detectLanguage = options.detectLanguage;
    }
    if (options.interimResults !== undefined) {
      this.#config.interimResults = options.interimResults;
    }
    if (options.punctuate !== undefined) {
      this.#config.punctuate = options.punctuate;
    }
    if (options.spokenPunctuation !== undefined) {
      this.#config.spokenPunctuation = options.spokenPunctuation;
    }
    if (options.model !== undefined) {
      this.#config.model = options.model;
    }
    if (options.location !== undefined) {
      this.#location = options.location;
      // if location is changed, fetch a new client and recognizer as per the new location
      this.#pool.invalidate();
    }
    if (options.keywords !== undefined) {
      this.#config.keywords = options.keywords;
    }

    for (const stream of this.#streams) {
      stream.updateOptions(options);
    }
  }

  async aclose(): Promise<void> {
    await this.#pool.aclose();
  }
}

class ConnectionPool<T> {
  private maxSessionDuration: number;
  private createClient: () => Promise<T>;
  private client?: T;
  private createdAt?: number;

  constructor(maxSessionDuration: number, createClient: () => Promise<T>) {
    this.maxSessionDuration = maxSessionDuration;
    this.createClient = createClient;
  }

  async connection(): Promise<T> {
    const now = Date.now();

    if (!this.client || !this.createdAt || now - this.createdAt > this.maxSessionDuration * 1000) {
      this.client = await this.createClient();
      this.createdAt = now;
    }

    return this.client;
  }

  invalidate(): void {
    this.client = undefined;
    this.createdAt = undefined;
  }

  async aclose(): Promise<void> {
    this.client = undefined;
    this.createdAt = undefined;
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: InternalSTTOptions;
  #audioEnergyFilter: AudioEnergyFilter;
  #logger = log();
  #speaking = false;
  #pool: ConnectionPool<v2.SpeechClient>;
  #getRecognizer: (client: v2.SpeechClient) => string;
  #config: InternalSTTOptions;
  #reconnectEvent = new EventTarget();
  #sessionConnectedAt = 0;
  label = 'google.SpeechStream';

  constructor(
    stt: STT,
    pool: ConnectionPool<v2.SpeechClient>,
    getRecognizer: (client: v2.SpeechClient) => string,
    config: InternalSTTOptions,
  ) {
    super(stt);
    this.#opts = config;
    this.#pool = pool;
    this.#getRecognizer = getRecognizer;
    this.#config = config;
    this.closed = false;
    this.#audioEnergyFilter = new AudioEnergyFilter();

    this.#run();
  }

  updateOptions(options: Partial<STTOptions>): void {
    if (options.languages !== undefined) {
      const languages = Array.isArray(options.languages) ? options.languages : [options.languages];
      this.#config.languages = languages;
    }
    if (options.detectLanguage !== undefined) {
      this.#config.detectLanguage = options.detectLanguage;
    }
    if (options.interimResults !== undefined) {
      this.#config.interimResults = options.interimResults;
    }
    if (options.punctuate !== undefined) {
      this.#config.punctuate = options.punctuate;
    }
    if (options.spokenPunctuation !== undefined) {
      this.#config.spokenPunctuation = options.spokenPunctuation;
    }
    if (options.model !== undefined) {
      this.#config.model = options.model;
    }
    if (options.minConfidenceThreshold !== undefined) {
      this.#config.minConfidenceThreshold = options.minConfidenceThreshold;
    }
    if (options.keywords !== undefined) {
      this.#config.keywords = options.keywords;
    }

    this.#reconnectEvent.dispatchEvent(new Event('reconnect'));
  }

  async #run(maxRetry = 32) {
    let retries = 0;

    while (!this.input.closed) {
      try {
        const client = await this.#pool.connection();
        this.#sessionConnectedAt = Date.now();

        const recognizer = this.#getRecognizer(client);

        // Create streaming recognize request
        const request: StreamingRecognizerInitialConfigRequest = {
          recognizer,
          streamingConfig: {
            config: {
              explicitDecodingConfig: {
                encoding: AudioEncoding.LINEAR16,
                sampleRateHertz: this.#config.sampleRate,
                audioChannelCount: 1,
              },
              adaptation: this.buildAdaptation(),
              languageCodes: this.#config.languages as string[],
              model: this.#config.model,
              features: {
                enableAutomaticPunctuation: this.#config.punctuate,
                enableWordTimeOffsets: true,
                enableSpokenPunctuation: this.#config.spokenPunctuation,
              },
            },
            streamingFeatures: {
              interimResults: this.#config.interimResults,
              enableVoiceActivityEvents: true,
            },
          },
        };

        const stream = client._streamingRecognize();

        // Send initial config
        stream.write(request);

        await this.#runStream(stream);
      } catch (e) {
        if (retries >= maxRetry) {
          throw new Error(`Failed to connect to Google STT after ${retries} attempts: ${e}`);
        }

        const delay = Math.min(retries * 5, 10);
        retries++;

        this.#logger.warn(
          `Failed to connect to Google STT, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }

    this.closed = true;
  }

  private buildAdaptation(): protos.google.cloud.speech.v2.ISpeechAdaptation | undefined {
    if (this.#config.keywords && this.#config.keywords.length > 0) {
      return {
        phraseSets: [
          {
            inlinePhraseSet: {
              phrases: this.#config.keywords.map(([keyword, boost]) => ({
                value: keyword,
                boost,
              })),
            },
          },
        ],
      };
    }
    return undefined;
  }

  async #runStream(stream: any) {
    let hasStarted = false;

    const emptyAudioChunk = AudioFrame.create(16000, 1, 160);

    // keepalive - to prevent from timeouts from Google STT when no audio is sent during agent responses
    const keepalive = setInterval(() => {
      try {
        if (!hasStarted) {
          this.#logger.debug('Google STT stream - sent keepalive');
          stream.write({ audio: Buffer.from(emptyAudioChunk.data.buffer) });
        }
      } catch {
        clearInterval(keepalive);
        return;
      }
    }, 5000);

    // Handle incoming responses
    stream.on('data', (response: protos.google.cloud.speech.v2.StreamingRecognizeResponse) => {
      if (response.speechEventType === SpeechEventType.SPEECH_ACTIVITY_BEGIN) {
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
        hasStarted = true;
      }

      if (response.speechEventType === SpeechEventType.SPEECH_EVENT_TYPE_UNSPECIFIED) {
        const result = response.results?.[0];
        if (!result) return;

        const speechData = this.#streamingRecognizeResponseToSpeechData(response);
        if (!speechData) return;

        if (!result.isFinal) {
          this.queue.put({
            type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
            alternatives: [speechData],
          });
        } else {
          this.queue.put({
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [speechData],
          });

          // Check if we need to reconnect due to session duration
          if (Date.now() - this.#sessionConnectedAt > MAX_SESSION_DURATION * 1000) {
            this.#logger.debug('Google STT maximum connection time reached. Reconnecting...');
            this.#pool.invalidate();
            if (hasStarted) {
              this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
              hasStarted = false;
            }
            this.#reconnectEvent.dispatchEvent(new Event('reconnect'));
            return;
          }
        }
      }

      if (response.speechEventType === SpeechEventType.SPEECH_ACTIVITY_END) {
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
        hasStarted = false;
      }
    });

    // Handle errors
    stream.on('error', (error: Error) => {
      this.#logger.error('Google STT stream error:', { error });
      throw error;
    });

    // Send audio data
    const sendTask = async () => {
      const samples100Ms = Math.floor(this.#config.sampleRate / 10);
      const audioStream = new AudioByteStream(
        this.#config.sampleRate,
        1, // Google STT expects mono audio
        samples100Ms,
      );

      for await (const data of this.input) {
        let frames: AudioFrame[];
        if (data === SpeechStream.FLUSH_SENTINEL) {
          frames = audioStream.flush();
        } else if (data.sampleRate === this.#config.sampleRate || data.channels === 1) {
          frames = audioStream.write(data.data.buffer);
        } else {
          throw new Error('Sample rate or channel count of frame does not match');
        }

        for await (const frame of frames) {
          if (this.#audioEnergyFilter.pushFrame(frame)) {
            stream.write({ audio: Buffer.from(frame.data.buffer) });
          }
        }
      }

      stream.end();
    };

    await sendTask();
    clearInterval(keepalive);
  }

  #streamingRecognizeResponseToSpeechData(
    response: protos.google.cloud.speech.v2.StreamingRecognizeResponse,
  ): stt.SpeechData | null {
    if (!response.results || response.results.length === 0) {
      return null;
    }

    let text = '';
    let confidence = 0.0;
    let language = 'en-US';

    for (const result of response.results) {
      if (!result.alternatives || result.alternatives.length === 0) {
        continue;
      }
      text += result?.alternatives?.[0]?.transcript || '';
      confidence += result?.alternatives?.[0]?.confidence || 0;
      language = result?.languageCode || language;
    }

    confidence /= response.results.length;

    if (confidence < this.#config.minConfidenceThreshold || text === '') {
      return null;
    }

    return {
      language,
      startTime: 0,
      endTime: 0,
      confidence,
      text,
    };
  }
}
