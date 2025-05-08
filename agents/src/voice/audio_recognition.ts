import type { AudioFrame, AudioStream } from '@livekit/rtc-node';
import { log } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { type VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import type { STTNode } from './io.js';

export interface EndOfTurnInfo {
  newTranscript: string;
  transcriptionDelay: number;
  endOfUtteranceDelay: number;
}

export interface RecognitionHooks {
  onStartOfSpeech: (ev: VADEvent) => void;
  onEndOfSpeech: (ev: VADEvent) => void;
  onVADInferenceDone: (ev: VADEvent) => void;
  onInterimTranscript: (ev: SpeechEvent) => void;
  onFinalTranscript: (ev: SpeechEvent) => void;
  onEndOfTurn: (info: EndOfTurnInfo) => void;
}

export class AudioRecognition {
  private inputAudioStream: Promise<ReadableStream<AudioFrame>>;
  private inputAudioStreamResolver: (value: ReadableStream<AudioFrame>) => void = () => {};
  private vadStreamProcessor?: Promise<void>;
  private sttStreamProcessor?: Promise<void>;
  private logger = log();
  private lastLanguage?: string;
  private lastFinalTranscriptTime = 0;
  private audioTranscript = '';
  private audioInterimTranscript = '';
  private lastSpeakingTime = 0;
  private userTurnCommitted = false;
  private speaking = false;
  constructor(
    private hooks: RecognitionHooks,
    private vad: VAD,
    private stt: STTNode,
    private manualTurnDetection = false,
  ) {
    this.inputAudioStream = new Promise((resolve) => {
      this.inputAudioStreamResolver = resolve;
    });
  }

  async start() {
    const inputStream = await this.inputAudioStream;
    const [vadInputStream, sttInputStream] = inputStream.tee();
    this.vadStreamProcessor = this.vadTask(vadInputStream).catch((err) => {
      throw err;
    });
    this.sttStreamProcessor = this.sttTask(sttInputStream).catch((err) => {
      throw err;
    });
  }

  private async onSTTEvent(ev: SpeechEvent) {
    // TODO(shubhra) ignore stt event if user turn already committed and EOU task is done
    // or it's an interim transcript

    switch (ev.type) {
      case SpeechEventType.FINAL_TRANSCRIPT:
        this.hooks.onFinalTranscript(ev);
        const transcript = ev.alternatives?.[0]?.text;
        this.lastLanguage = ev.alternatives?.[0]?.language;

        if (!transcript) return;

        this.logger.debug('received user transcript', {
          user_transcript: transcript,
          language: this.lastLanguage,
        });

        this.lastFinalTranscriptTime = Date.now();
        this.audioTranscript += ` ${transcript}`;
        this.audioTranscript = this.audioTranscript.trim();
        this.audioInterimTranscript = '';

        if (!this.speaking) {
          if (!this.vad) {
            this.lastSpeakingTime = Date.now();
          }
        }

        if (!this.manualTurnDetection || this.userTurnCommitted) {
          this.hooks.onEndOfTurn({
            newTranscript: transcript,
            transcriptionDelay: this.lastFinalTranscriptTime - this.lastSpeakingTime,
            endOfUtteranceDelay: this.lastFinalTranscriptTime - Date.now(),
          });
        }

        break;
      case SpeechEventType.INTERIM_TRANSCRIPT:
        this.hooks.onInterimTranscript(ev);
        break;
    }
  }

  private async sttTask(inputStream: ReadableStream<AudioFrame>) {
    const sttStream = await this.stt(inputStream, {});
    if (sttStream instanceof ReadableStream) {
      // @ts-ignore for some reason we can't export asCompatibleStream
      for await (const ev of sttStream) {
        if (typeof ev === 'string') throw new Error('STT node must yield SpeechEvent');
        await this.onSTTEvent(ev);
      }
    }
  }

  private async vadTask(inputStream: ReadableStream<AudioFrame>) {
    const vadStream = this.vad.stream();
    vadStream.updateInputStream(inputStream);

    for await (const ev of vadStream) {
      switch (ev.type) {
        case VADEventType.START_OF_SPEECH:
          this.hooks.onStartOfSpeech(ev);
          this.speaking = true;
          break;
        case VADEventType.INFERENCE_DONE:
          this.hooks.onVADInferenceDone(ev);
          break;
        case VADEventType.END_OF_SPEECH:
          this.hooks.onEndOfSpeech(ev);
          this.speaking = false;
          // when VAD fires END_OF_SPEECH, it already waited for the silence_duration
          this.lastSpeakingTime = Date.now() - ev.silenceDuration;
          break;
      }
    }
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>) {
    this.inputAudioStreamResolver(audioStream);
  }
}
