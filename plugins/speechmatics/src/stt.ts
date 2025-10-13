// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  stt,
} from '@livekit/agents';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import {
  type AddPartialTranscript,
  type AddTranscript,
  RealtimeClient,
  type RealtimeTranscriptionConfig,
  type RecognitionAlternative,
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

type FragmentAttachment = 'previous' | 'next' | 'both' | 'none' | undefined;

type SpeechFragment = {
  startTime: number;
  endTime: number;
  language: string;
  content: string;
  speaker: string | null;
  confidence: number;
  attachesTo: FragmentAttachment;
  isFinal: boolean;
  isEos: boolean;
  tokenType?: string;
};

type SpeakerFragments = {
  startTime: number;
  endTime: number;
  language: string;
  speakerId: string | null;
  isActive: boolean;
  fragments: SpeechFragment[];
};

const SPEAKER_FILTER_REGEX = /^__[A-Z0-9_]{2,}__$/;

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
  #speechFragments: SpeechFragment[] = [];
  #lastSpeakerTexts = new Map<string, string>();
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

  #handleTranscript(msg: TranscriptMessage, isFinal: boolean) {
    const hasChanged = this.#addSpeechFragments(msg, isFinal);

    if (!hasChanged) {
      if (isFinal) {
        if (this.#speechFragments.length === 0) {
          this.#flushEOU();
        } else {
          this.#armFallbackEOU();
        }
      } else {
        this.#armFallbackEOU();
      }
      return;
    }

    this.#armFallbackEOU();
    this.#sendFrames(false);
  }

  #addSpeechFragments(msg: TranscriptMessage, isFinal: boolean): boolean {
    const newFragments = this.#extractFragments(msg, isFinal);
    const currentLength = this.#speechFragments.length;

    this.#speechFragments = this.#speechFragments.filter((fragment) => fragment.isFinal);

    if (!newFragments.length && this.#speechFragments.length === currentLength) {
      return false;
    }

    const combined = [...this.#speechFragments, ...newFragments];
    combined.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    this.#speechFragments = combined;

    return true;
  }

  #extractFragments(msg: TranscriptMessage, isFinal: boolean): SpeechFragment[] {
    const fragments: SpeechFragment[] = [];
    const defaultStart = Number(msg.metadata?.start_time ?? 0);
    const defaultEnd = Number(msg.metadata?.end_time ?? defaultStart);

    for (const result of msg.results ?? []) {
      const alternatives = result.alternatives ?? [];
      if (!alternatives.length) {
        continue;
      }

      const alt = alternatives[0];
      const content = alt?.content?.trim();
      if (!content) {
        continue;
      }

      const speaker = (alt?.speaker ?? null) as string | null;
      if (!this.#shouldRetainSpeaker(speaker)) {
        continue;
      }

      fragments.push({
        startTime: Number((result as { start_time?: number }).start_time ?? defaultStart),
        endTime: Number((result as { end_time?: number }).end_time ?? defaultEnd),
        language: alt?.language ?? this.#opts.language,
        content,
        speaker,
        confidence: typeof alt?.confidence === 'number' ? alt.confidence : 0,
        attachesTo: (result as { attaches_to?: FragmentAttachment }).attaches_to,
        isFinal,
        isEos: Boolean((alt as { is_eos?: boolean }).is_eos),
        tokenType: (result as { type?: string }).type,
      });
    }

    if (!fragments.length) {
      const transcript = msg.metadata?.transcript?.trim();
      if (transcript) {
        fragments.push({
          startTime: defaultStart,
          endTime: defaultEnd,
          language: this.#opts.language,
          content: transcript,
          speaker: null,
          confidence: 0,
          attachesTo: undefined,
          isFinal,
          isEos: false,
          tokenType: undefined,
        });
      }
    }

    return fragments;
  }

  #shouldRetainSpeaker(speaker: string | null): boolean {
    if (!speaker) {
      return true;
    }

    if (SPEAKER_FILTER_REGEX.test(speaker)) {
      return false;
    }

    if (
      this.#opts.focusMode === 'ignore' &&
      this.#opts.focusSpeakers.length > 0 &&
      !this.#opts.focusSpeakers.includes(speaker)
    ) {
      return false;
    }

    if (this.#opts.ignoreSpeakers.length > 0 && this.#opts.ignoreSpeakers.includes(speaker)) {
      return false;
    }

    return true;
  }

  #sendFrames(finalized: boolean): boolean {
    const frames = this.#getSpeakerFragments();
    if (!frames.length) {
      return false;
    }

    if (!frames.some((frame) => frame.isActive)) {
      return false;
    }

    const eventType = finalized
      ? stt.SpeechEventType.FINAL_TRANSCRIPT
      : stt.SpeechEventType.INTERIM_TRANSCRIPT;

    let emitted = false;

    for (const frame of frames) {
      if (!frame.isActive) {
        continue;
      }

      const speechData = this.#buildSpeechDataFromGroup(frame);
      if (!speechData) {
        continue;
      }

      const speakerKey = frame.speakerId ?? '__default__';
      const previous = this.#lastSpeakerTexts.get(speakerKey);
      if (!finalized && previous === speechData.text) {
        continue;
      }

      this.#lastSpeakerTexts.set(speakerKey, speechData.text);
      this.queue.put({
        type: eventType,
        alternatives: [speechData],
      });
      emitted = true;
    }

    return emitted;
  }

  #getSpeakerFragments(): SpeakerFragments[] {
    if (!this.#speechFragments.length) {
      return [];
    }

    const speakerGroups: SpeechFragment[][] = [];
    let currentGroup: SpeechFragment[] | undefined;
    let currentSpeaker: string | null | undefined;

    for (const fragment of this.#speechFragments) {
      const speakerId = fragment.speaker;
      if (!currentGroup || speakerId !== currentSpeaker) {
        currentGroup = [];
        speakerGroups.push(currentGroup);
        currentSpeaker = speakerId;
      }
      currentGroup.push(fragment);
    }

    const assembled: SpeakerFragments[] = [];
    for (const group of speakerGroups) {
      const fragments = this.#getSpeakerFragmentsFromGroup(group);
      if (fragments) {
        assembled.push(fragments);
      }
    }

    return assembled;
  }

  #getSpeakerFragmentsFromGroup(group: SpeechFragment[]): SpeakerFragments | undefined {
    if (!group.length) {
      return undefined;
    }

    let trimmed = [...group];
    while (trimmed.length > 0 && trimmed[0]?.attachesTo === 'previous') {
      trimmed = trimmed.slice(1);
    }

    while (
      trimmed.length > 0 &&
      trimmed[trimmed.length - 1]?.attachesTo === 'next'
    ) {
      trimmed = trimmed.slice(0, -1);
    }

    if (!trimmed.length) {
      return undefined;
    }

    const startTime = Math.min(...trimmed.map((fragment) => fragment.startTime));
    const endTime = Math.max(...trimmed.map((fragment) => fragment.endTime));
    const language = trimmed.find((fragment) => fragment.language)?.language ?? this.#opts.language;
    const firstFragment = trimmed[0];
    if (!firstFragment) {
      return undefined;
    }
    const speakerId = firstFragment.speaker;

    let isActive = true;
    if (this.#opts.enableDiarization && this.#opts.focusSpeakers.length > 0) {
      isActive = Boolean(speakerId && this.#opts.focusSpeakers.includes(speakerId));
    }

    return {
      startTime,
      endTime,
      language,
      speakerId,
      isActive,
      fragments: trimmed,
    };
  }

  #buildSpeechDataFromGroup(group: SpeakerFragments): stt.SpeechData | undefined {
    const text = this.#formatGroupText(group.fragments);
    if (!text) {
      return undefined;
    }

    const confidences = group.fragments
      .map((fragment) => fragment.confidence)
      .filter((value) => Number.isFinite(value));
    const confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : 0;

    const formatted = toSpeakerFormatted(
      {
        content: text,
        language: group.language,
        speaker: group.speakerId ?? undefined,
        confidence,
      } as RecognitionAlternative,
      this.#opts.speakerActiveFormat,
      this.#opts.speakerPassiveFormat,
      this.#opts,
    );

    return {
      language: group.language,
      text: formatted,
      startTime: group.startTime,
      endTime: group.endTime,
      confidence,
    } satisfies stt.SpeechData;
  }

  #formatGroupText(fragments: SpeechFragment[]): string {
    let text = '';
    let previousAttachesToNext = false;

    for (const fragment of fragments) {
      const token = fragment.content;
      if (!token) {
        continue;
      }

      const attachesToPrev = fragment.attachesTo === 'previous' || fragment.attachesTo === 'both';
      const attachesToNext = fragment.attachesTo === 'next' || fragment.attachesTo === 'both';

      if (text && !previousAttachesToNext && !attachesToPrev) {
        text += ' ';
      }

      text += token;
      previousAttachesToNext = attachesToNext;
    }

    return text
      .replace(/\s+([,.;!?])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
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
    this.#sendFrames(true);
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    if (this.#fallbackEouTimer) {
      clearTimeout(this.#fallbackEouTimer);
      this.#fallbackEouTimer = undefined;
    }
    this.#speechFragments = [];
    this.#lastSpeakerTexts.clear();
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
