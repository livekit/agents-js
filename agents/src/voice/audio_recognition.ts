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
  private spreaking: boolean = false;
  private inputAudioStream: Promise<AudioStream>;
  private inputAudioStreamResolver: (value: AudioStream) => void = () => {};
  private vadStream?: VADStream;
  private vadStreamProcessor?: Promise<void>;
  private logger = log();
  constructor(
    private hooks: RecognitionHooks,
    private stt?: STTNode,
    private vad?: VAD,
  ) {
    this.inputAudioStream = new Promise((resolve) => {
      this.inputAudioStreamResolver = resolve;
    });
  }

  start() {
    this.updateVad(this.vad);
  }

  async updateVad(vad?: VAD) {
    this.vad = vad;
    if (this.vad) {
      const inputStream = await this.inputAudioStream;
      this.vadStream = this.vad.stream();
      this.vadStream.updateInputStream(inputStream);

      // Set up frame forwarding directly
      this.vadStreamProcessor = (async () => {
        for await (const ev of this.vadStream!) {
          switch (ev.type) {
            case VADEventType.START_OF_SPEECH:
              this.spreaking = true;
              this.hooks.onStartOfSpeech(ev);
              break;
            case VADEventType.END_OF_SPEECH:
              this.spreaking = false;
              this.hooks.onEndOfSpeech(ev);
              break;
            case VADEventType.INFERENCE_DONE:
              this.hooks.onVADInferenceDone(ev);
              break;
          }
        }
      })();
    } else {
      this.logger.warn('No VAD instance provided to updateVad - VAD functionality disabled');
    }
  }

  setInputAudioStream(audioStream: AudioStream) {
    this.inputAudioStreamResolver(audioStream);
  }
}
