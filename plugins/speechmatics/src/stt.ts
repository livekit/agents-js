// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  DEFAULT_API_CONNECT_OPTIONS,
  AudioByteStream,
  log,
  stt,
  type APIConnectOptions,
} from '@livekit/agents';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import {
  RealtimeClient,
  type AddPartialTranscript,
  type AddTranscript,
  type RecognitionAlternative,
  type RealtimeTranscriptionConfig,
} from '@speechmatics/real-time-client';

import type {
  AdditionalVocabEntry,
  DiarizationFocusMode,
  EndOfUtteranceMode,
  KnownSpeaker,
  OperatingPoint,
  PunctuationOverrides,
  SpeechmaticsSTTOptions,
} from './types.js';

const DEFAULT_JWT_TTL = 60;
const DEFAULT_CLIENT_REF = 'livekit-agents';

type TranscriptMessage = AddPartialTranscript | AddTranscript;

type ResolvedSpeechmaticsSTTOptions = {
  apiKey: string;
  baseUrl: string;
  appId: string;
  operatingPoint: OperatingPoint;
  language: string;
  outputLocale?: string;
  enablePartials: boolean;
  enableDiarization: boolean;
  maxDelay: number;
  endOfUtteranceSilence: number;
  endOfUtteranceMode: EndOfUtteranceMode;
  additionalVocab: AdditionalVocabEntry[];
  punctuationOverrides: PunctuationOverrides;
  diarizationSensitivity: number;
  speakerActiveFormat: string;
  speakerPassiveFormat: string;
  preferCurrentSpeaker: boolean;
  focusSpeakers: string[];
  ignoreSpeakers: string[];
  focusMode: DiarizationFocusMode;
  knownSpeakers: KnownSpeaker[];
  sampleRate: number;
  chunkSize: number;
  getJwt?: () => Promise<string>;
};

const DEFAULT_OPTIONS: ResolvedSpeechmaticsSTTOptions = {
  apiKey: process.env.SPEECHMATICS_API_KEY ?? '',
  baseUrl: 'wss://eu2.rt.speechmatics.com/v2',
  appId: DEFAULT_CLIENT_REF,
  operatingPoint: 'enhanced',
  language: 'en',
  outputLocale: undefined,
  enablePartials: true,
  enableDiarization: false,
  maxDelay: 1.2,
  endOfUtteranceSilence: 0.6,
  endOfUtteranceMode: 'fixed',
  additionalVocab: [],
  punctuationOverrides: {},
  diarizationSensitivity: 0.5,
  speakerActiveFormat: '{text}',
  speakerPassiveFormat: '{text}',
  preferCurrentSpeaker: false,
  focusSpeakers: [],
  ignoreSpeakers: [],
  focusMode: 'retain',
  knownSpeakers: [],
  sampleRate: 16_000,
  chunkSize: 160,
  getJwt: undefined,
};

export class STT extends stt.STT {
  #opts: ResolvedSpeechmaticsSTTOptions;
  label = 'speechmatics.STT';

  constructor(opts: SpeechmaticsSTTOptions = {}) {
    super({
      streaming: true,
      interimResults: opts.enablePartials ?? true,
    });

    const {
      apiKey = DEFAULT_OPTIONS.apiKey,
      baseUrl = DEFAULT_OPTIONS.baseUrl,
      appId = DEFAULT_OPTIONS.appId,
      operatingPoint = DEFAULT_OPTIONS.operatingPoint,
      language = DEFAULT_OPTIONS.language,
      outputLocale = DEFAULT_OPTIONS.outputLocale,
      enablePartials = DEFAULT_OPTIONS.enablePartials,
      enableDiarization = DEFAULT_OPTIONS.enableDiarization,
      maxDelay = DEFAULT_OPTIONS.maxDelay,
      endOfUtteranceSilence = DEFAULT_OPTIONS.endOfUtteranceSilence,
      endOfUtteranceMode = DEFAULT_OPTIONS.endOfUtteranceMode,
      additionalVocab = DEFAULT_OPTIONS.additionalVocab,
      punctuationOverrides = DEFAULT_OPTIONS.punctuationOverrides,
      diarizationSensitivity = DEFAULT_OPTIONS.diarizationSensitivity,
      speakerActiveFormat = DEFAULT_OPTIONS.speakerActiveFormat,
      speakerPassiveFormat = DEFAULT_OPTIONS.speakerPassiveFormat,
      preferCurrentSpeaker = DEFAULT_OPTIONS.preferCurrentSpeaker,
      focusSpeakers = DEFAULT_OPTIONS.focusSpeakers,
      ignoreSpeakers = DEFAULT_OPTIONS.ignoreSpeakers,
      focusMode = DEFAULT_OPTIONS.focusMode,
      knownSpeakers = DEFAULT_OPTIONS.knownSpeakers,
      sampleRate = DEFAULT_OPTIONS.sampleRate,
      chunkSize = DEFAULT_OPTIONS.chunkSize,
      getJwt = DEFAULT_OPTIONS.getJwt,
    } = opts;

    this.#opts = {
      ...DEFAULT_OPTIONS,
      apiKey,
      baseUrl,
      appId,
      operatingPoint,
      language,
      outputLocale,
      enablePartials,
      enableDiarization,
      maxDelay,
      endOfUtteranceSilence,
      endOfUtteranceMode,
      additionalVocab,
      punctuationOverrides,
      diarizationSensitivity,
      speakerActiveFormat,
      speakerPassiveFormat,
      preferCurrentSpeaker,
      focusSpeakers,
      ignoreSpeakers,
      focusMode,
      knownSpeakers,
      sampleRate,
      chunkSize,
      getJwt,
    };
  }

  // one-shot recognition can be added later
  async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('Not implemented');
  }

  stream({ connOptions = DEFAULT_API_CONNECT_OPTIONS } = {}): SpeechStream {
    return new SpeechStream(this, this.#opts.sampleRate, connOptions, this.#opts);
  }
}

class SpeechStream extends stt.SpeechStream {
  #opts: ResolvedSpeechmaticsSTTOptions;
  #client?: RealtimeClient;
  #logger = log();
  #fallbackEouTimer?: NodeJS.Timeout;
  #bstream: AudioByteStream;
  label = 'speechmatics.SpeechStream';

  constructor(
    stt: STT,
    sampleRate: number,
    conn: APIConnectOptions,
    opts: ResolvedSpeechmaticsSTTOptions,
  ) {
    super(stt, sampleRate, conn);
    this.#opts = opts;
    this.#bstream = new AudioByteStream(sampleRate, 1, opts.chunkSize);
  }

  protected async run(): Promise<void> {
    const jwt = await this.#getJwt();
    const client = new RealtimeClient({ url: this.#opts.baseUrl, appId: this.#opts.appId });
    this.#client = client;

    const getPreview = (msg: TranscriptMessage) => {
      const firstResult = msg.results?.[0];
      const firstAlt = firstResult?.alternatives?.[0];
      return firstAlt?.content ?? '';
    };

    client.addEventListener('receiveMessage', ({ data }) => {
      const message = data.message ?? 'unknown';
      const resultCount = Array.isArray((data as { results?: unknown }).results)
        ? ((data as { results?: unknown[] }).results ?? []).length
        : 0;

      if (message !== 'AudioAdded' && resultCount > 0) {
        this.#logger.info({ message, results: resultCount, data }, 'speechmatics receive data');
      }

      switch (data.message) {
        case 'AddPartialTranscript': {
          if (!this.#opts.enablePartials) break;
          const partial = data as AddPartialTranscript;
          const preview = getPreview(partial);
          if (preview !== '') {
            this.#logger.info({ preview }, 'forwarding partial transcript');
          }
          this.#handleTranscript(partial, false);
          break;
        }
        case 'AddTranscript': {
          const finalMsg = data as AddTranscript;
          const preview = getPreview(finalMsg);
          if (preview !== '') {
            this.#logger.info({ preview }, 'forwarding final transcript');
          }
          this.#handleTranscript(finalMsg, true);
          break;
        }
        case 'EndOfUtterance': {
          this.#logger.info('received end of utterance signal');
          this.#flushEOU();
          break;
        }
        default:
          break;
      }
    });

    await client.start(jwt, this.#toTranscriptionConfig());

    for await (const inFrame of this.input) {
      if (inFrame === SpeechStream.FLUSH_SENTINEL) {
        for (const frame of this.#bstream.flush()) {
          this.#client?.sendAudio(frame.data);
        }
        continue;
      }

      for (const frame of this.#bstream.write(inFrame.data.buffer)) {
        this.#client?.sendAudio(frame.data);
      }

      this.#armFallbackEOU();
    }
  }

  async aclose(): Promise<void> {
    if (this.#fallbackEouTimer) {
      clearTimeout(this.#fallbackEouTimer);
      this.#fallbackEouTimer = undefined;
    }

    const client = this.#client;
    if (client) {
      try {
        await client.stopRecognition();
      } catch (err) {
        this.#logger.warn({ err }, 'failed to stop Speechmatics recognition');
      }
    }
  }

  #handleTranscript(msg: TranscriptMessage, isFinal: boolean) {
    const alternatives: stt.SpeechData[] = (msg.results ?? []).flatMap((result) => {
      const startTime = result.start_time ?? msg.metadata?.start_time ?? 0;
      const endTime = result.end_time ?? msg.metadata?.end_time ?? 0;

      return (result.alternatives ?? []).map((alt): stt.SpeechData => ({
        language: alt.language ?? this.#opts.language,
        text: toSpeakerFormatted(
          alt,
          this.#opts.speakerActiveFormat,
          this.#opts.speakerPassiveFormat,
          this.#opts,
        ),
        startTime,
        endTime,
        confidence: alt.confidence ?? 0,
      }));
    });

    if (!alternatives.length) {
      if (isFinal) {
        this.#flushEOU();
      } else {
        this.#armFallbackEOU();
      }
      return;
    }

    const [primary, ...rest] = alternatives as [stt.SpeechData, ...stt.SpeechData[]];
    this.queue.put({
      type: isFinal
        ? stt.SpeechEventType.FINAL_TRANSCRIPT
        : stt.SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [primary, ...rest],
    });

    if (!isFinal) {
      this.#armFallbackEOU();
    }
  }

  #armFallbackEOU() {
    if (this.#opts.endOfUtteranceMode !== 'fixed') {
      return;
    }

    if (this.#fallbackEouTimer) {
      clearTimeout(this.#fallbackEouTimer);
    }

    this.#fallbackEouTimer = setTimeout(
      () => this.#flushEOU(),
      this.#opts.endOfUtteranceSilence * 1_000 * 4,
    );
  }

  #flushEOU() {
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    if (this.#fallbackEouTimer) {
      clearTimeout(this.#fallbackEouTimer);
      this.#fallbackEouTimer = undefined;
    }
  }

  #toTranscriptionConfig(): RealtimeTranscriptionConfig {
    const cfg: RealtimeTranscriptionConfig = {
      transcription_config: {
        language: this.#opts.language,
        output_locale: this.#opts.outputLocale,
        operating_point: this.#opts.operatingPoint,
        diarization: this.#opts.enableDiarization ? 'speaker' : 'none',
        enable_partials: this.#opts.enablePartials,
        max_delay: this.#opts.maxDelay,
        punctuation_overrides: this.#opts.punctuationOverrides,
        speaker_diarization_config: this.#opts.enableDiarization
          ? {
              speaker_sensitivity: this.#opts.diarizationSensitivity,
              prefer_current_speaker: this.#opts.preferCurrentSpeaker,
            }
          : undefined,
        additional_vocab: this.#opts.additionalVocab?.map((v) => ({
          content: v.content,
          sounds_like: v.sounds_like,
        })),
        // Conversation config when using fixed EOU:
        conversation_config:
          this.#opts.endOfUtteranceMode === 'fixed'
            ? {
                end_of_utterance_silence_trigger: this.#opts.endOfUtteranceSilence,
              }
            : undefined,
      },
      audio_format: {
        type: 'raw',
        encoding: 'pcm_s16le',
        // our AudioByteStream yields PCM16
        sample_rate: this.#opts.sampleRate,
      },
    };
    return cfg;
  }

  async #getJwt(): Promise<string> {
    if (this.#opts.getJwt) {
      return this.#opts.getJwt();
    }

    if (!this.#opts.apiKey) {
      throw new Error('Missing Speechmatics API key or getJwt()');
    }

    return await createSpeechmaticsJWT({
      type: 'rt',
      apiKey: this.#opts.apiKey,
      ttl: DEFAULT_JWT_TTL,
      clientRef: DEFAULT_CLIENT_REF,
    });
  }
}

function toSpeakerFormatted(
  alt: RecognitionAlternative | undefined,
  activeFmt: string,
  passiveFmt: string,
  opts: ResolvedSpeechmaticsSTTOptions,
): string {
  const content = alt?.content ?? '';
  const speaker = alt?.speaker ?? null;
  const fmt =
    opts.enableDiarization && speaker && opts.focusSpeakers?.includes(speaker)
      ? activeFmt
      : passiveFmt;
  return speaker ? fmt.replace('{speaker_id}', speaker).replace('{text}', content) : content;
}
