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

type AggregatedAlternativeState = {
  text: string;
  startTime: number;
  endTime: number;
  language?: string;
  speaker?: string | null;
  confidences: number[];
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
  #finalizedAlternatives: stt.SpeechData[] = [];
  #latestSpeech?: stt.SpeechData;
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

    const getPreview = (msg: TranscriptMessage) =>
      msg.metadata?.transcript?.trim() ?? msg.results?.[0]?.alternatives?.[0]?.content ?? '';

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

  #aggregateAlternatives(msg: TranscriptMessage): stt.SpeechData[] {
    const defaultStart = msg.metadata?.start_time ?? 0;
    const defaultEnd = msg.metadata?.end_time ?? defaultStart;
    const altMap = new Map<number, AggregatedAlternativeState>();

    for (const result of msg.results ?? []) {
      const resultStart = result.start_time ?? defaultStart;
      const resultEnd = result.end_time ?? defaultEnd;
      const attachesTo = (result as { attaches_to?: 'previous' | 'next' }).attaches_to;
      const { type } = result;

      for (const [index, alt] of (result.alternatives ?? []).entries()) {
        if (!alt?.content) {
          continue;
        }

        const entry =
          altMap.get(index) ?? {
            text: '',
            startTime: resultStart,
            endTime: resultEnd,
            language: alt.language ?? this.#opts.language,
            speaker: alt.speaker ?? null,
            confidences: [],
          };

        entry.text = appendToken(entry.text, alt.content, type, attachesTo);
        entry.startTime = Math.min(entry.startTime, resultStart);
        entry.endTime = Math.max(entry.endTime, resultEnd);
        entry.language = alt.language ?? entry.language;
        entry.speaker = alt.speaker ?? entry.speaker;
        if (typeof alt.confidence === 'number') {
          entry.confidences.push(alt.confidence);
        }

        altMap.set(index, entry);
      }
    }

    if (!altMap.size) {
      const transcript = msg.metadata?.transcript?.trim();
      if (!transcript) {
        return [];
      }

      return [
        {
          language: this.#opts.language,
          text: toSpeakerFormatted(
            { content: transcript, language: this.#opts.language, confidence: 0 },
            this.#opts.speakerActiveFormat,
            this.#opts.speakerPassiveFormat,
            this.#opts,
          ),
          startTime: defaultStart,
          endTime: defaultEnd,
          confidence: 0,
        },
      ];
    }

    return Array.from(altMap.values())
      .map((entry) => {
        const content = entry.text.trim() || msg.metadata?.transcript?.trim() || '';
        if (!content) {
          return undefined;
        }

        const confidence = entry.confidences.length
          ? entry.confidences.reduce((sum, value) => sum + value, 0) / entry.confidences.length
          : 0;

        return {
          language: entry.language ?? this.#opts.language,
          text: toSpeakerFormatted(
            {
              content,
              language: entry.language ?? this.#opts.language,
              speaker: entry.speaker ?? undefined,
              confidence,
            } as RecognitionAlternative,
            this.#opts.speakerActiveFormat,
            this.#opts.speakerPassiveFormat,
            this.#opts,
          ),
          startTime: entry.startTime,
          endTime: entry.endTime,
          confidence,
        } satisfies stt.SpeechData;
      })
      .filter((alt): alt is stt.SpeechData => alt !== undefined);
  }

  #handleTranscript(msg: TranscriptMessage, isFinal: boolean) {
    const alternatives = this.#aggregateAlternatives(msg);

    if (!alternatives.length) {
      if (isFinal) {
        this.#flushEOU();
      } else {
        this.#armFallbackEOU();
      }
      return;
    }

    let merged: stt.SpeechData | undefined;

    if (isFinal) {
      this.#mergeFinalAlternatives(alternatives);
      merged = this.#buildCombinedAlternatives(this.#finalizedAlternatives);
    } else {
      merged = this.#buildCombinedAlternatives([
        ...this.#finalizedAlternatives,
        ...alternatives,
      ]);
    }

    if (merged) {
      const changed = this.#latestSpeech?.text !== merged.text;
      this.#latestSpeech = merged;
      if (changed) {
        this.queue.put({
          type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
          alternatives: [merged],
        });
      }
    }

    if (!isFinal) {
      this.#armFallbackEOU();
    }
  }

  #mergeFinalAlternatives(alternatives: stt.SpeechData[]) {
    const eps = 0.02;
    for (const alt of alternatives) {
      this.#finalizedAlternatives = this.#finalizedAlternatives.filter(
        (existing) => existing.startTime + eps < alt.startTime,
      );
      this.#finalizedAlternatives.push(alt);
    }
    this.#finalizedAlternatives.sort((a, b) => a.startTime - b.startTime);
  }

  #buildCombinedAlternatives(segments: stt.SpeechData[]): stt.SpeechData | undefined {
    if (!segments.length) {
      return undefined;
    }

    const text = combineTextSegments(segments.map((seg) => seg.text));
    if (!text) {
      return undefined;
    }

    const startTime = Math.min(...segments.map((s) => s.startTime));
    const endTime = Math.max(...segments.map((s) => s.endTime));
    const language = segments.find((s) => s.language)?.language ?? this.#opts.language;
    const confidence =
      segments.reduce((sum, seg) => sum + (seg.confidence ?? 0), 0) / segments.length;

    return {
      language,
      text,
      startTime,
      endTime,
      confidence,
    } satisfies stt.SpeechData;
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
    if (this.#latestSpeech) {
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [this.#latestSpeech],
      });
    }

    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    if (this.#fallbackEouTimer) {
      clearTimeout(this.#fallbackEouTimer);
      this.#fallbackEouTimer = undefined;
    }
    this.#finalizedAlternatives = [];
    this.#latestSpeech = undefined;
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
  const formatted = speaker
    ? fmt.replace('{speaker_id}', speaker).replace('{text}', content)
    : content;
  return formatted.trim();
}

function appendToken(
  current: string,
  token: string,
  type: string | undefined,
  attachesTo: 'previous' | 'next' | undefined,
): string {
  if (!token) {
    return current;
  }
  if (!current) {
    return token;
  }
  if (type === 'punctuation' || attachesTo === 'previous') {
    return `${current}${token}`;
  }
  return `${current} ${token}`;
}

function combineTextSegments(segments: string[]): string {
  const text = segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}
