// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { type ChatContext, ChatRole } from '../llm/chat_context.js';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { Future, sleep } from '../utils.js';
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
  onEndOfTurn: (info: EndOfTurnInfo) => Promise<boolean>;

  retrieveChatCtx: () => ChatContext;
}

interface _TurnDetector {
  unlikelyThreshold: (language?: string) => number | null;
  supportsLanguage: (language?: string) => boolean;

  predictEndOfTurn(chatCtx: ChatContext): Promise<number>;
}

export class AudioRecognition {
  private deferredInputStream: DeferredReadableStream<AudioFrame>;
  private vadStreamProcessor?: Promise<void>;
  private sttStreamProcessor?: Promise<void>;
  private logger = log();
  private lastFinalTranscriptTime = 0;
  private audioTranscript = '';
  private audioInterimTranscript = '';
  private lastSpeakingTime = 0;
  private userTurnCommitted = false;
  private speaking = false;
  private bounceEOUAbortController?: AbortController;
  private eouTaskDone?: Future;

  constructor(
    private readonly hooks: RecognitionHooks,
    private vad: VAD,
    private readonly minEndpointingDelay: number,
    private readonly maxEndpointingDelay: number,
    private stt?: STTNode,
    private manualTurnDetection = false,
    private turnDetector?: _TurnDetector,
    private lastLanguage?: string,
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
    if (
      this.manualTurnDetection &&
      this.userTurnCommitted &&
      (this.eouTaskDone === undefined ||
        this.eouTaskDone.done ||
        ev.type == SpeechEventType.INTERIM_TRANSCRIPT)
    ) {
      // ignore stt event if user turn already committed and EOU task is done
      // or it's an interim transcript
      return;
    }

    switch (ev.type) {
      case SpeechEventType.FINAL_TRANSCRIPT:
        this.hooks.onFinalTranscript(ev);
        const transcript = ev.alternatives?.[0]?.text;
        this.lastLanguage = ev.alternatives?.[0]?.language;

        if (!transcript) return;

        this.logger.debug(
          {
            user_transcript: transcript,
            language: this.lastLanguage,
          },
          'received user transcript',
        );

        this.lastFinalTranscriptTime = Date.now();
        this.audioTranscript += ` ${transcript}`;
        this.audioTranscript = this.audioTranscript.trimStart();
        this.audioInterimTranscript = '';

        if (!this.speaking) {
          if (!this.vad) {
            // Copied from python agents:
            // vad disabled, use stt timestamp
            // TODO: this would screw up transcription latency metrics
            // but we'll live with it for now.
            // the correct way is to ensure STT fires SpeechEventType.END_OF_SPEECH
            // and using that timestamp for _last_speaking_time
            this.lastSpeakingTime = Date.now();
          }
        }

        if (!this.manualTurnDetection || this.userTurnCommitted) {
          const chatCtx = this.hooks.retrieveChatCtx();
          this.runEOUDetection(chatCtx);
        }
        break;
      case SpeechEventType.INTERIM_TRANSCRIPT:
        this.hooks.onInterimTranscript(ev);
        this.audioInterimTranscript = ev.alternatives?.[0]?.text ?? '';
        break;
    }
  }

  private async runEOUDetection(chatCtx: ChatContext) {
    if (this.stt && !this.audioTranscript && !this.manualTurnDetection) {
      // stt enabled but no transcript yet
      return;
    }

    chatCtx = chatCtx.copy();
    chatCtx.append({ role: ChatRole.USER, text: this.audioTranscript });

    const turnDetector =
      // disable EOU model if manual turn detection enabled
      this.audioTranscript && !this.manualTurnDetection ? this.turnDetector : null;

    const bounceEOUTask = async (lastSpeakingTime: number, abortSignal: AbortSignal) => {
      let endpointingDelay = this.minEndpointingDelay;

      if (turnDetector) {
        if (!turnDetector.supportsLanguage(this.lastLanguage)) {
          this.logger.debug(`Turn detector does not support language ${this.lastLanguage}`);
        } else {
          const endOfTurnProbability = await turnDetector.predictEndOfTurn(chatCtx);
          const unlikelyThreshold = turnDetector.unlikelyThreshold(this.lastLanguage);
          if (unlikelyThreshold && endOfTurnProbability < unlikelyThreshold) {
            endpointingDelay = this.maxEndpointingDelay;
          }
        }
      }

      const extraSleep = lastSpeakingTime + endpointingDelay - Date.now();
      if (abortSignal.aborted) {
        return;
      }
      await sleep(Math.max(extraSleep, 0));

      this.logger.debug('end of user turn', {
        transcript: this.audioTranscript,
      });

      const committed = await this.hooks.onEndOfTurn({
        newTranscript: this.audioTranscript,
        transcriptionDelay: Math.max(this.lastFinalTranscriptTime - lastSpeakingTime, 0),
        endOfUtteranceDelay: Date.now() - lastSpeakingTime,
      });

      if (committed) {
        // clear the transcript if the user turn was committed
        this.audioTranscript = '';
      }
    };

    if (this.bounceEOUAbortController) {
      this.bounceEOUAbortController.abort();
    }

    this.bounceEOUAbortController = new AbortController();
    this.eouTaskDone = new Future();
    bounceEOUTask(this.lastSpeakingTime, this.bounceEOUAbortController.signal).then(() => {
      this.eouTaskDone?.resolve();
    });
  }

  private async sttTask(inputStream: ReadableStream<AudioFrame>) {
    if (!this.stt) {
      return;
    }

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
          if (this.bounceEOUAbortController) {
            this.bounceEOUAbortController.abort();
          }
          break;
        case VADEventType.INFERENCE_DONE:
          this.hooks.onVADInferenceDone(ev);
          break;
        case VADEventType.END_OF_SPEECH:
          this.hooks.onEndOfSpeech(ev);
          this.speaking = false;
          // when VAD fires END_OF_SPEECH, it already waited for the silence_duration
          this.lastSpeakingTime = Date.now() - ev.silenceDuration;

          if (!this.manualTurnDetection) {
            const chatCtx = this.hooks.retrieveChatCtx();
            this.runEOUDetection(chatCtx);
          }
          break;
      }
    }
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }
}
