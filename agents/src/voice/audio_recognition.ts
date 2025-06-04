// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { delay } from '@std/async';
import { ReadableStream } from 'node:stream/web';
import { type ChatContext, ChatRole } from '../llm/chat_context.js';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { Task } from '../utils.js';
import { type VAD, type VADEvent, VADEventType } from '../vad.js';
import type { TurnDetectionMode } from './agent_session.js';
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

export interface _TurnDetector {
  unlikelyThreshold: (language?: string) => number | null;
  supportsLanguage: (language?: string) => boolean;

  predictEndOfTurn(chatCtx: ChatContext): Promise<number>;
}


export class AudioRecognition {
  private deferredInputStream: DeferredReadableStream<AudioFrame>;
  private logger = log();
  private lastFinalTranscriptTime = 0;
  private audioTranscript = '';
  private audioInterimTranscript = '';
  private lastSpeakingTime = 0;
  private userTurnCommitted = false;
  private speaking = false;

  private vadInputStream: ReadableStream<AudioFrame>;
  private sttInputStream: ReadableStream<AudioFrame>;

  // all cancellable tasks
  private bounceEOUTask?: Task<void>;
  private commitUserTurnTask?: Task<void>;
  private vadTask?: Task<void>;
  private sttTask?: Task<void>;

  constructor(
    private readonly hooks: RecognitionHooks,
    private vad: VAD,
    private readonly minEndpointingDelay: number,
    private readonly maxEndpointingDelay: number,
    private stt?: STTNode,
    private turnDetectionMode?: TurnDetectionMode,
    private turnDetector?: _TurnDetector,
    private lastLanguage?: string,
  ) {
    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();

    const [vadInputStream, sttInputStream] = this.deferredInputStream.stream.tee();
    this.vadInputStream = vadInputStream;
    this.sttInputStream = sttInputStream;
  }

  async start() {
    console.log('Start audio recognition with turn detection mode: ', this.turnDetectionMode);
    this.updateVad();
    this.updateStt();

    // every 1 second, print interm transcript and audio transcript and lastFinalTranscriptTime and userTurnCommitted
    (async () => {
      const secondAgo = (time: number) => (Date.now() - time) / 1000;

      while (true) {
        console.log('===============================================');
        const debugObject = {
          interimTranscript: this.audioInterimTranscript,
          audioTranscript: this.audioTranscript,
          lastFinalTranscriptTime: `${secondAgo(this.lastFinalTranscriptTime)}s ago`,
          userTurnCommitted: this.userTurnCommitted,
        };
        console.log('debugObject: ', debugObject);
        await delay(500);
      }
    })();
  }

  private async updateVad() {
    // cancel any existing vad task
    await this.vadTask?.cancelAndWait(1000).catch((err) => {
      this.logger.error(`Error cancelling VAD task: ${err}`);
    });

    this.vadTask = Task.from(this.createVadTask());
    this.vadTask.result.catch((err) => {
      this.logger.error(`Error running VAD task: ${err}`);
    });
  }

  private async updateStt() {
    // cancel any existing stt task
    await this.sttTask?.cancelAndWait(3000).catch((err) => {
      this.logger.error(`Error cancelling STT task: ${err}`);
    });

    this.sttTask = Task.from(this.createSttTask());
    this.sttTask.result.catch((err) => {
      this.logger.error(`Error running STT task: ${err}`);
    });
  }

  private async onSTTEvent(ev: SpeechEvent) {
    if (
      this.turnDetectionMode === 'manual' &&
      this.userTurnCommitted &&
      (this.bounceEOUTask === undefined ||
        this.bounceEOUTask.done ||
        ev.type == SpeechEventType.INTERIM_TRANSCRIPT)
    ) {
      // ignore stt event if user turn already committed and EOU task is done
      // or it's an interim transcript
      this.logger.debug(
        {
          userTurnCommitted: this.userTurnCommitted,
          eouTaskDone: this.bounceEOUTask?.done,
          evType: ev.type,
          turnDetectionMode: this.turnDetectionMode,
        },
        'ignoring stt event',
      );
      return;
    }

    switch (ev.type) {
      case SpeechEventType.FINAL_TRANSCRIPT:
        this.hooks.onFinalTranscript(ev);
        const transcript = ev.alternatives?.[0]?.text;
        this.lastLanguage = ev.alternatives?.[0]?.language;

        if (!transcript) {
          this.logger.debug('stt final transcript received but no transcript');
          return;
        }

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

          if (this.vadBaseTurnDetection || this.userTurnCommitted) {
            const chatCtx = this.hooks.retrieveChatCtx();
            this.logger.debug('running EOU detection on stt FINAL_TRANSCRIPT');
            this.runEOUDetection(chatCtx);
          }
        }
        break;
      case SpeechEventType.INTERIM_TRANSCRIPT:
        this.hooks.onInterimTranscript(ev);
        this.audioInterimTranscript = ev.alternatives?.[0]?.text ?? '';
        break;
    }
  }

  private async runEOUDetection(chatCtx: ChatContext) {
    this.logger.debug(
      {
        stt: this.stt,
        audioTranscript: this.audioTranscript,
        turnDetectionMode: this.turnDetectionMode,
      },
      'running EOU detection',
    );

    if (this.stt && !this.audioTranscript && this.turnDetectionMode !== 'manual') {
      // stt enabled but no transcript yet
      this.logger.debug('skipping EOU detection');
      return;
    }

    chatCtx = chatCtx.copy();
    chatCtx.append({ role: ChatRole.USER, text: this.audioTranscript });

    const turnDetector =
      // disable EOU model if manual turn detection enabled
      this.audioTranscript && this.turnDetectionMode !== 'manual' ? this.turnDetector : undefined;

    const bounceEOUTask = (lastSpeakingTime: number) => async (controller: AbortController) => {
      let endpointingDelay = this.minEndpointingDelay;

      // TODO(AJS-74): need to support actual turn detection model plugins for following code to run
      if (turnDetector) {
        this.logger.debug('Running turn detector model');
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
      // add delay to see if there's a potential upcoming EOU task that cancels this one
      await delay(Math.max(extraSleep, 0), { signal: controller.signal });

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

      this.userTurnCommitted = false;
    };

    // cancel any existing EOU task
    this.bounceEOUTask?.cancel();
    this.bounceEOUTask = Task.from(bounceEOUTask(this.lastSpeakingTime));

    this.bounceEOUTask.result
      .then(() => {
        this.logger.debug('EOU detection task completed');
      })
      .catch((err: any) => {
        if (err.name === 'AbortError') {
          this.logger.debug('EOU detection task was aborted');
        } else {
          this.logger.error('Error in EOU detection task:', err);
        }
      });
  }

  private createSttTask() {
    return async (controller: AbortController) => {
      if (!this.stt) {
        return;
      }

      this.logger.debug({ step: 1 }, 'createSttTask');
      const sttStream = await this.stt(this.sttInputStream, {});
      this.logger.debug({ step: 2 }, 'createSttTask');

      if (controller.signal.aborted) return;
      if (sttStream === null) return;

      this.logger.debug({ step: 3 }, 'createSttTask');
      if (sttStream instanceof ReadableStream) {
        const reader = sttStream.getReader();
        while (!controller.signal.aborted) {
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

        this.logger.debug('STT task cancelled');
        this.logger.debug({ step: 4 }, 'createSttTask');
        reader.releaseLock();
        this.logger.debug({ step: 5 }, 'createSttTask');
        sttStream.cancel();
        this.logger.debug({ step: 6 }, 'createSttTask');
      }
    };
  }

  private createVadTask() {
    return async (controller: AbortController) => {
      const vadStream = this.vad.stream();
      vadStream.updateInputStream(this.vadInputStream);

      for await (const ev of vadStream) {
        if (controller.signal.aborted) {
          this.logger.debug('VAD task cancelled');
          break;
        }

        switch (ev.type) {
          case VADEventType.START_OF_SPEECH:
            this.hooks.onStartOfSpeech(ev);
            this.speaking = true;

            this.bounceEOUTask?.cancel();
            break;
          case VADEventType.INFERENCE_DONE:
            this.hooks.onVADInferenceDone(ev);
            break;
          case VADEventType.END_OF_SPEECH:
            this.hooks.onEndOfSpeech(ev);
            this.speaking = false;
            // when VAD fires END_OF_SPEECH, it already waited for the silence_duration
            this.lastSpeakingTime = Date.now() - ev.silenceDuration;

            if (this.turnDetectionMode !== 'manual') {
              const chatCtx = this.hooks.retrieveChatCtx();
              this.logger.debug('running EOU detection on vad END_OF_SPEECH');
              this.runEOUDetection(chatCtx);
            }
            break;
        }
      }
    };
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }

  clearUserTurn() {
    console.log('clearUserTurn');
    this.audioTranscript = '';
    this.audioInterimTranscript = '';
    this.userTurnCommitted = false;

    // reset stt to clear the buffer from previous user turn
    this.updateStt();
  }

  commitUserTurn(audioDetached: boolean) {
    console.log('commitUserTurn', audioDetached);

    const commitUserTurnTask =
      (delayDuration: number = 500) =>
      async (controller: AbortController) => {
        if (Date.now() - this.lastFinalTranscriptTime > delayDuration) {
          // TODO(brian): push silence to stt to flush the buffer
          // ...

          await delay(delayDuration, { signal: controller.signal });
        }

        if (this.audioInterimTranscript) {
          // append interim transcript in case the final transcript is not ready
          this.audioTranscript = `${this.audioTranscript} ${this.audioInterimTranscript}`.trim();
        }
        this.audioInterimTranscript = '';

        const chatCtx = this.hooks.retrieveChatCtx();
        this.runEOUDetection(chatCtx);
        this.userTurnCommitted = true;
      };

    // cancel any existing commit user turn task
    this.commitUserTurnTask?.cancel();
    this.commitUserTurnTask = Task.from(commitUserTurnTask());

    this.commitUserTurnTask.result
      .then(() => {
        this.logger.debug('User turn committed');
      })
      .catch((err: any) => {
        if (err.name === 'AbortError') {
          this.logger.debug('User turn commit task was aborted');
        } else {
          this.logger.error('Error in user turn commit task:', err);
        }
      });
  }

  private get vadBaseTurnDetection() {
    return this.turnDetectionMode === undefined || this.turnDetectionMode === 'vad';
  }
}
