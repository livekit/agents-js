// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '@livekit/agents';
// import { STT as BaseSTT, SpeechStream as BaseSpeechStream, SpeechEvent, SpeechEventType } from '@livekit/agents/src/stt/stt.js';
import { AudioByteStream, log, stt } from '@livekit/agents';
import { RealtimeClient, type RealtimeTranscriptionConfig } from '@speechmatics/real-time-client';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import type { SpeechmaticsSTTOptions } from './types.js';

export class STT extends stt.STT {
  label = 'speechmatics.STT';
  #opts: Required<SpeechmaticsSTTOptions>;
  constructor(opts: SpeechmaticsSTTOptions = {}) {
    super({
      streaming: true,
      interimResults: opts.enablePartials ?? true,
    });
    this.#opts = {
      apiKey: opts.apiKey ?? process.env.SPEECHMATICS_API_KEY ?? '',
      baseUrl: opts.baseUrl ?? 'wss://eu2.rt.speechmatics.com/v2',
      appId: opts.appId ?? 'livekit-agents',
      operatingPoint: opts.operatingPoint ?? 'enhanced',
      language: opts.language ?? 'en',
      outputLocale: opts.outputLocale ?? undefined,
      enablePartials: opts.enablePartials ?? true,
      enableDiarization: opts.enableDiarization ?? false,
      maxDelay: opts.maxDelay ?? 0.7,
      endOfUtteranceSilence: opts.endOfUtteranceSilence ?? 0.3,
      endOfUtteranceMode: opts.endOfUtteranceMode ?? 'fixed',
      additionalVocab: opts.additionalVocab ?? [],
      punctuationOverrides: opts.punctuationOverrides ?? {},
      diarizationSensitivity: opts.diarizationSensitivity ?? 0.5,
      speakerActiveFormat: opts.speakerActiveFormat ?? '{text}',
      speakerPassiveFormat: opts.speakerPassiveFormat ?? '{text}',
      preferCurrentSpeaker: opts.preferCurrentSpeaker ?? false,
      focusSpeakers: opts.focusSpeakers ?? [],
      ignoreSpeakers: opts.ignoreSpeakers ?? [],
      focusMode: opts.focusMode ?? 'retain',
      knownSpeakers: opts.knownSpeakers ?? [],
      sampleRate: opts.sampleRate ?? 16000,
      chunkSize: opts.chunkSize ?? 160,
      getJwt: opts.getJwt ?? undefined,
    } as Required<SpeechmaticsSTTOptions>;
  }

  // one-shot recognition can be added later
  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('Not implemented');
  }

  stream({ connOptions = DEFAULT_API_CONNECT_OPTIONS }: { connOptions?: APIConnectOptions } = {}) {
    return new SpeechStream(this, this.#opts.sampleRate, connOptions, this.#opts);
  }
}

class SpeechStream extends stt.SpeechStream {
  label = 'speechmatics.SpeechStream';
  #opts: Required<SpeechmaticsSTTOptions>;
  #client?: RealtimeClient;
  #logger = log();
  #fallbackEouTimer?: ReturnType<typeof setTimeout>;
  #bstream: AudioByteStream;

  constructor(stt: STT, sampleRate: number, conn: APIConnectOptions, opts: Required<SpeechmaticsSTTOptions>) {
    super(stt, sampleRate, conn);
    this.#opts = opts;
    this.#bstream = new AudioByteStream(sampleRate, 1);
  }

  protected async run() {
    const jwt = await this.#getJwt();
    const client = new RealtimeClient({ url: this.#opts.baseUrl, appId: this.#opts.appId });
    this.#client = client;

    // Wire Speechmatics -> LiveKit SpeechEvent
    client.addEventListener('receiveMessage', ({ data }) => {
      // Handle partials
      if (data.message === 'AddPartialTranscript' && this.#opts.enablePartials) {
        this.#handleTranscript(data, false);
      }
      // Handle finals
      if (data.message === 'AddTranscript') {
        this.#handleTranscript(data, true);
      }
      // Handle EOU (when using fixed EOU from Speechmatics)
      if (data.message === 'EndOfUtterance') {
        this.#flushEOU();
      }
    });

    // Start session
    await client.start(jwt, this.#toTranscriptionConfig());

    // Pump audio in
    for await (const inFrame of this.input) {
       // flush branch
      if (typeof inFrame === 'symbol') {
        const frames = this.#bstream.flush();
        for (const f of frames) this.#client!.sendAudio(f.data);
        continue;
      }

      // here: inFrame is AudioFrame
      for (const f of this.#bstream.write(inFrame.data.buffer)) {
        this.#client!.sendAudio(f.data);
      }
      this.#armFallbackEOU();
    }
    // Client close is handled by Agent lifecycle
  }

  async aclose() {
    clearTimeout(this.#fallbackEouTimer);
    const c = this.#client;
    if (c) {
      try { await c.stopRecognition(); } catch {}
    }
  }

  #handleTranscript(msg: any, isFinal: boolean) {
    const alternatives = (msg.results ?? []).flatMap((result: any) => {
      const startTime = result.start_time ?? msg.metadata?.start_time ?? 0;
      const endTime = result.end_time ?? msg.metadata?.end_time ?? 0;
      return (result.alternatives ?? []).map((alt: any): stt.SpeechData => ({
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

    const [primary, ...rest] = alternatives;
    this.queue.put({
      type: isFinal ? stt.SpeechEventType.FINAL_TRANSCRIPT : stt.SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [primary, ...rest] as [stt.SpeechData, ...stt.SpeechData[]],
    });

    if (isFinal) {
      // send END_OF_SPEECH + usage, then clear
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH } as  stt.SpeechEvent);
      clearTimeout(this.#fallbackEouTimer);
      this.#fallbackEouTimer = undefined;
    } else {
      this.#armFallbackEOU();
    }
  }

  #armFallbackEOU() {
    if (this.#opts.endOfUtteranceMode !== 'fixed') return;
    clearTimeout(this.#fallbackEouTimer);
    // match the Python plugin’s “*4” grace period to avoid premature cuts
    this.#fallbackEouTimer = setTimeout(() => this.#flushEOU(), this.#opts.endOfUtteranceSilence * 1000 * 4);
  }

  #flushEOU() {
    // Emit a “final” boundary if we still have buffered partials
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH } as stt.SpeechEvent);
    clearTimeout(this.#fallbackEouTimer);
    this.#fallbackEouTimer = undefined;
  }

  #toTranscriptionConfig(): RealtimeTranscriptionConfig {
    const cfg: RealtimeTranscriptionConfig = {
      transcription_config: {
        language: this.#opts.language!,
        output_locale: this.#opts.outputLocale,
        operating_point: this.#opts.operatingPoint,
        diarization: this.#opts.enableDiarization ? 'speaker' : 'none',
        enable_partials: this.#opts.enablePartials,
        max_delay: this.#opts.maxDelay,
        punctuation_overrides: this.#opts.punctuationOverrides,
        speaker_diarization_config: this.#opts.enableDiarization ? {
          speaker_sensitivity: this.#opts.diarizationSensitivity,
          prefer_current_speaker: this.#opts.preferCurrentSpeaker,
        } : undefined,
        additional_vocab: this.#opts.additionalVocab?.map(v => ({ content: v.content, sounds_like: v.sounds_like })),
        // Conversation config when using fixed EOU:
        conversation_config: this.#opts.endOfUtteranceMode === 'fixed' ? {
          end_of_utterance_silence_trigger: this.#opts.endOfUtteranceSilence,
        } : undefined,
      },
      audio_format: {
        type: 'raw',
        encoding: 'pcm_s16le',     // our AudioByteStream yields PCM16
        sample_rate: this.#opts.sampleRate,
      },
    };
    return cfg;
  }

  async #getJwt(): Promise<string> {
    if (this.#opts.getJwt) return this.#opts.getJwt();
    if (!this.#opts.apiKey) throw new Error('Missing Speechmatics API key or getJwt()');
    // mint short-lived temporary key (recommended path)
    return await createSpeechmaticsJWT({ type: 'rt', apiKey: this.#opts.apiKey, ttl: 60, clientRef: 'livekit-agents' });
  }
}

// trivial “speaker format” helper; flesh out like Python’s fragments logic
function toSpeakerFormatted(
  alt: any,
  activeFmt: string,
  passiveFmt: string,
  opts: Required<SpeechmaticsSTTOptions>,
) {
  const content = alt?.content ?? '';
  const spk = alt?.speaker ?? null;
  const fmt = opts.enableDiarization && spk && opts.focusSpeakers?.includes(spk) ? activeFmt : passiveFmt;
  return spk ? fmt.replace('{speaker_id}', spk).replace('{text}', content) : content;
}
