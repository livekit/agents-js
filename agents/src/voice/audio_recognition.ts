// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { type VAD, type VADEvent, VADEventType } from '../vad.js';
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
  private deferredInputStream: DeferredReadableStream<AudioFrame>;
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
    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();
  }

  async start() {
    const [vadInputStream, sttInputStream] = this.deferredInputStream.stream.tee();
    this.vadStreamProcessor = this.vadTask(vadInputStream).catch((err) => {
      this.logger.error(`Error in VAD task: ${err}`);
    });
    this.sttStreamProcessor = this.sttTask(sttInputStream).catch((err) => {
      this.logger.error(`Error in STT task: ${err}`);
    });
  }

  private async onSTTEvent(ev: SpeechEvent) {
    // TODO(AJS-30) ignore stt event if user turn already committed and EOU task is done
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
        this.audioInterimTranscript = ev.alternatives?.[0]?.text ?? '';
        break;
    }
  }

  private async sttTask(inputStream: ReadableStream<AudioFrame>) {
    const sttStream = await this.stt(inputStream, {});
    if (sttStream === null) {
      return;
    }
    if (sttStream instanceof ReadableStream) {
      const reader = sttStream.getReader();
      while (true) {
        const { done, value: ev } = await reader.read();
        if (done) {
          break;
        }
        if (typeof ev === 'string') {
          throw new Error('STT node must yield SpeechEvent');
        } else {
          await this.onSTTEvent(ev);
        }
      }
      reader.releaseLock();
      sttStream.cancel();
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
    this.deferredInputStream.setSource(audioStream);
  }
}
