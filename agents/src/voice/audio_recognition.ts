import type { AudioFrame, AudioStream } from '@livekit/rtc-node';
import { log } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
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
  private logger = log();
  constructor(
    private hooks: RecognitionHooks,
    private vad: VAD,
  ) {
    this.inputAudioStream = new Promise((resolve) => {
      this.inputAudioStreamResolver = resolve;
    });
  }

  start() {
    this.vadStreamProcessor = this.vadTask().catch((err) => {
      this.logger.error('Error in VAD task', err);
    });
  }

  private async vadTask() {
    const inputStream = await this.inputAudioStream;
    const vadStream = this.vad.stream();
    vadStream.updateInputStream(inputStream);

    for await (const ev of vadStream) {
      switch (ev.type) {
        case VADEventType.START_OF_SPEECH:
          this.hooks.onStartOfSpeech(ev);
          break;
        case VADEventType.END_OF_SPEECH:
          this.hooks.onEndOfSpeech(ev);
          break;
        case VADEventType.INFERENCE_DONE:
          this.hooks.onVADInferenceDone(ev);
          break;
      }
    }
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>) {
    this.inputAudioStreamResolver(audioStream);
  }
}
