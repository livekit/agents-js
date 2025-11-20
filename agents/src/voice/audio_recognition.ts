// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import type { WritableStreamDefaultWriter } from 'node:stream/web';
import { ReadableStream } from 'node:stream/web';
import { type ChatContext } from '../llm/chat_context.js';
import { log } from '../log.js';
import { DeferredReadableStream, isStreamReaderReleaseError } from '../stream/deferred_stream.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { mergeReadableStreams } from '../stream/merge_readable_streams.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { Task, delay } from '../utils.js';
import { type VAD, type VADEvent, VADEventType } from '../vad.js';
import type { TurnDetectionMode } from './agent_session.js';
import type { STTNode } from './io.js';

export interface EndOfTurnInfo {
  newTranscript: string;
  transcriptConfidence: number;
  transcriptionDelay: number;
  endOfUtteranceDelay: number;
  startedSpeakingAt: number | undefined;
  stoppedSpeakingAt: number | undefined;
}

export interface PreemptiveGenerationInfo {
  newTranscript: string;
  transcriptConfidence: number;
}

export interface RecognitionHooks {
  onStartOfSpeech: (ev: VADEvent) => void;
  onVADInferenceDone: (ev: VADEvent) => void;
  onEndOfSpeech: (ev: VADEvent) => void;
  onInterimTranscript: (ev: SpeechEvent) => void;
  onFinalTranscript: (ev: SpeechEvent) => void;
  onEndOfTurn: (info: EndOfTurnInfo) => Promise<boolean>;
  onPreemptiveGeneration: (info: PreemptiveGenerationInfo) => void;

  retrieveChatCtx: () => ChatContext;
}

export interface _TurnDetector {
  unlikelyThreshold: (language?: string) => Promise<number | undefined>;
  supportsLanguage: (language?: string) => Promise<boolean>;
  predictEndOfTurn(chatCtx: ChatContext): Promise<number>;
}

export interface AudioRecognitionOptions {
  recognitionHooks: RecognitionHooks;
  stt?: STTNode;
  vad?: VAD;
  turnDetector?: _TurnDetector;
  turnDetectionMode?: Exclude<TurnDetectionMode, _TurnDetector>;
  minEndpointingDelay: number;
  maxEndpointingDelay: number;
}

// TODO(brian): PR3 - Add span: private _userTurnSpan?: Span, create lazily in _ensureUserTurnSpan() method (tracer.startSpan('user_turn') with participant attributes)
// TODO(brian): PR3 - Add span: 'eou_detection' span when running EOU detection (in runEOUDetection method)
export class AudioRecognition {
  private hooks: RecognitionHooks;
  private stt?: STTNode;
  private vad?: VAD;
  private turnDetector?: _TurnDetector;
  private turnDetectionMode?: Exclude<TurnDetectionMode, _TurnDetector>;
  private minEndpointingDelay: number;
  private maxEndpointingDelay: number;
  private lastLanguage?: string;

  private deferredInputStream: DeferredReadableStream<AudioFrame>;
  private logger = log();
  private lastFinalTranscriptTime = 0;
  private audioTranscript = '';
  private audioInterimTranscript = '';
  private audioPreflightTranscript = '';
  private finalTranscriptConfidence: number[] = [];
  private lastSpeakingTime: number | undefined;
  private speechStartTime: number | undefined;
  private userTurnCommitted = false;
  private speaking = false;
  private sampleRate?: number;

  private vadInputStream: ReadableStream<AudioFrame>;
  private sttInputStream: ReadableStream<AudioFrame>;
  private silenceAudioTransform = new IdentityTransform<AudioFrame>();
  private silenceAudioWriter: WritableStreamDefaultWriter<AudioFrame>;

  // all cancellable tasks
  private bounceEOUTask?: Task<void>;
  private commitUserTurnTask?: Task<void>;
  private vadTask?: Task<void>;
  private sttTask?: Task<void>;

  constructor(opts: AudioRecognitionOptions) {
    this.hooks = opts.recognitionHooks;
    this.stt = opts.stt;
    this.vad = opts.vad;
    this.turnDetector = opts.turnDetector;
    this.turnDetectionMode = opts.turnDetectionMode;
    this.minEndpointingDelay = opts.minEndpointingDelay;
    this.maxEndpointingDelay = opts.maxEndpointingDelay;
    this.lastLanguage = undefined;

    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();
    const [vadInputStream, sttInputStream] = this.deferredInputStream.stream.tee();
    this.vadInputStream = vadInputStream;
    this.sttInputStream = mergeReadableStreams(sttInputStream, this.silenceAudioTransform.readable);
    this.silenceAudioWriter = this.silenceAudioTransform.writable.getWriter();
  }

  /**
   * Current transcript of the user's speech, including interim transcript if available.
   */
  get currentTranscript(): string {
    if (this.audioInterimTranscript) {
      return `${this.audioTranscript} ${this.audioInterimTranscript}`.trim();
    }
    return this.audioTranscript;
  }

  async start() {
    this.vadTask = Task.from(({ signal }) => this.createVadTask(this.vad, signal));
    this.vadTask.result.catch((err) => {
      this.logger.error(`Error running VAD task: ${err}`);
    });

    this.sttTask = Task.from(({ signal }) => this.createSttTask(this.stt, signal));
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
        const confidence = ev.alternatives?.[0]?.confidence ?? 0;
        this.lastLanguage = ev.alternatives?.[0]?.language;

        if (!transcript) {
          // stt final transcript received but no transcript
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
        this.finalTranscriptConfidence.push(confidence);
        const transcriptChanged = this.audioTranscript !== this.audioPreflightTranscript;
        this.audioInterimTranscript = '';
        this.audioPreflightTranscript = '';

        if (!this.vad || this.lastSpeakingTime === undefined) {
          // vad disabled, use stt timestamp
          // TODO: this would screw up transcription latency metrics
          // but we'll live with it for now.
          // the correct way is to ensure STT fires SpeechEventType.END_OF_SPEECH
          // and using that timestamp for lastSpeakingTime
          this.lastSpeakingTime = Date.now();
        }

        if (this.vadBaseTurnDetection || this.userTurnCommitted) {
          if (transcriptChanged) {
            this.logger.debug(
              { transcript: this.audioTranscript },
              'triggering preemptive generation (FINAL_TRANSCRIPT)',
            );
            this.hooks.onPreemptiveGeneration({
              newTranscript: this.audioTranscript,
              transcriptConfidence:
                this.finalTranscriptConfidence.length > 0
                  ? this.finalTranscriptConfidence.reduce((a, b) => a + b, 0) /
                    this.finalTranscriptConfidence.length
                  : 0,
            });
          }

          if (!this.speaking) {
            const chatCtx = this.hooks.retrieveChatCtx();
            this.logger.debug('running EOU detection on stt FINAL_TRANSCRIPT');
            this.runEOUDetection(chatCtx);
          }
        }
        break;
      case SpeechEventType.PREFLIGHT_TRANSCRIPT:
        this.hooks.onInterimTranscript(ev);
        const preflightTranscript = ev.alternatives?.[0]?.text ?? '';
        const preflightConfidence = ev.alternatives?.[0]?.confidence ?? 0;
        const preflightLanguage = ev.alternatives?.[0]?.language;

        const MIN_LANGUAGE_DETECTION_LENGTH = 5;
        if (
          !this.lastLanguage ||
          (preflightLanguage && preflightTranscript.length > MIN_LANGUAGE_DETECTION_LENGTH)
        ) {
          this.lastLanguage = preflightLanguage;
        }

        if (!preflightTranscript) {
          return;
        }

        this.logger.debug(
          {
            user_transcript: preflightTranscript,
            language: this.lastLanguage,
          },
          'received user preflight transcript',
        );

        // still need to increment it as it's used for turn detection,
        this.lastFinalTranscriptTime = Date.now();
        // preflight transcript includes all pre-committed transcripts (including final transcript from the previous STT run)
        this.audioPreflightTranscript =
          `${this.audioTranscript} ${preflightTranscript}`.trimStart();
        this.audioInterimTranscript = preflightTranscript;

        if (!this.vad || this.lastSpeakingTime === undefined) {
          // vad disabled, use stt timestamp
          this.lastSpeakingTime = Date.now();
        }

        if (this.turnDetectionMode !== 'manual' || this.userTurnCommitted) {
          const confidenceVals = [...this.finalTranscriptConfidence, preflightConfidence];
          this.logger.debug(
            {
              transcript:
                this.audioPreflightTranscript.length > 100
                  ? this.audioPreflightTranscript.slice(0, 100) + '...'
                  : this.audioPreflightTranscript,
            },
            'triggering preemptive generation (PREFLIGHT_TRANSCRIPT)',
          );
          this.hooks.onPreemptiveGeneration({
            newTranscript: this.audioPreflightTranscript,
            transcriptConfidence:
              confidenceVals.length > 0
                ? confidenceVals.reduce((a, b) => a + b, 0) / confidenceVals.length
                : 0,
          });
        }
        break;
      case SpeechEventType.INTERIM_TRANSCRIPT:
        this.logger.debug({ transcript: ev.alternatives?.[0]?.text }, 'interim transcript');
        this.hooks.onInterimTranscript(ev);
        this.audioInterimTranscript = ev.alternatives?.[0]?.text ?? '';
        break;
      case SpeechEventType.START_OF_SPEECH:
        if (this.turnDetectionMode !== 'stt') break;
        this.hooks.onStartOfSpeech({
          type: VADEventType.START_OF_SPEECH,
          samplesIndex: 0,
          timestamp: Date.now(),
          speechDuration: 0,
          silenceDuration: 0,
          frames: [],
          probability: 0,
          inferenceDuration: 0,
          speaking: true,
          rawAccumulatedSilence: 0,
          rawAccumulatedSpeech: 0,
        });
        this.speaking = true;
        this.lastSpeakingTime = Date.now();

        this.bounceEOUTask?.cancel();
        break;
      case SpeechEventType.END_OF_SPEECH:
        if (this.turnDetectionMode !== 'stt') break;
        this.hooks.onEndOfSpeech({
          type: VADEventType.END_OF_SPEECH,
          samplesIndex: 0,
          timestamp: Date.now(),
          speechDuration: 0,
          silenceDuration: 0,
          frames: [],
          probability: 0,
          inferenceDuration: 0,
          speaking: false,
          rawAccumulatedSilence: 0,
          rawAccumulatedSpeech: 0,
        });
        this.speaking = false;
        this.userTurnCommitted = true;
        this.lastSpeakingTime = Date.now();

        if (!this.speaking) {
          const chatCtx = this.hooks.retrieveChatCtx();
          this.logger.debug('running EOU detection on stt END_OF_SPEECH');
          this.runEOUDetection(chatCtx);
        }
    }
  }

  private runEOUDetection(chatCtx: ChatContext) {
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
    chatCtx.addMessage({ role: 'user', content: this.audioTranscript });

    const turnDetector =
      // disable EOU model if manual turn detection enabled
      this.audioTranscript && this.turnDetectionMode !== 'manual' ? this.turnDetector : undefined;

    const bounceEOUTask =
      (
        lastSpeakingTime: number | undefined,
        lastFinalTranscriptTime: number,
        speechStartTime: number | undefined,
      ) =>
      async (controller: AbortController) => {
        let endpointingDelay = this.minEndpointingDelay;

        if (turnDetector) {
          this.logger.debug('Running turn detector model');
          if (!(await turnDetector.supportsLanguage(this.lastLanguage))) {
            this.logger.debug(`Turn detector does not support language ${this.lastLanguage}`);
          } else {
            const endOfTurnProbability = await turnDetector.predictEndOfTurn(chatCtx);
            this.logger.debug(
              { endOfTurnProbability, language: this.lastLanguage },
              'end of turn probability',
            );

            const unlikelyThreshold = await turnDetector.unlikelyThreshold(this.lastLanguage);
            this.logger.debug(
              {
                unlikelyThreshold,
                endOfTurnProbability,
                language: this.lastLanguage,
                transcript: this.audioTranscript,
              },
              'EOU Detection',
            );

            if (unlikelyThreshold && endOfTurnProbability < unlikelyThreshold) {
              endpointingDelay = this.maxEndpointingDelay;
            }
          }
        }

        let extraSleep = endpointingDelay;
        if (lastSpeakingTime !== undefined) {
          extraSleep += lastSpeakingTime - Date.now();
        }

        if (extraSleep > 0) {
          // add delay to see if there's a potential upcoming EOU task that cancels this one
          await delay(Math.max(extraSleep, 0), { signal: controller.signal });
        }

        this.logger.debug({ transcript: this.audioTranscript }, 'end of user turn');

        const confidenceAvg =
          this.finalTranscriptConfidence.length > 0
            ? this.finalTranscriptConfidence.reduce((a, b) => a + b, 0) /
              this.finalTranscriptConfidence.length
            : 0;

        let startedSpeakingAt: number | undefined;
        let stoppedSpeakingAt: number | undefined;
        let transcriptionDelay: number | undefined;
        let endOfUtteranceDelay: number | undefined;

        // sometimes, we can't calculate the metrics because VAD was unreliable.
        // in this case, we just ignore the calculation, it's better than providing likely wrong values
        if (
          lastFinalTranscriptTime !== 0 &&
          lastSpeakingTime !== undefined &&
          speechStartTime !== undefined
        ) {
          startedSpeakingAt = speechStartTime;
          stoppedSpeakingAt = lastSpeakingTime;
          transcriptionDelay = Math.max(lastFinalTranscriptTime - lastSpeakingTime, 0);
          endOfUtteranceDelay = Date.now() - lastSpeakingTime;
        }

        const committed = await this.hooks.onEndOfTurn({
          newTranscript: this.audioTranscript,
          transcriptConfidence: confidenceAvg,
          transcriptionDelay: transcriptionDelay ?? 0,
          endOfUtteranceDelay: endOfUtteranceDelay ?? 0,
          startedSpeakingAt,
          stoppedSpeakingAt,
        });

        if (committed) {
          // clear the transcript if the user turn was committed
          this.audioTranscript = '';
          this.finalTranscriptConfidence = [];
          this.lastSpeakingTime = undefined;
          this.lastFinalTranscriptTime = 0;
          this.speechStartTime = undefined;
        }

        this.userTurnCommitted = false;
      };

    // cancel any existing EOU task
    this.bounceEOUTask?.cancel();
    // copy the values before awaiting (the values can change)
    this.bounceEOUTask = Task.from(
      bounceEOUTask(this.lastSpeakingTime, this.lastFinalTranscriptTime, this.speechStartTime),
    );

    this.bounceEOUTask.result
      .then(() => {
        this.logger.debug('EOU detection task completed');
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('This operation was aborted')) {
          // ignore aborted errors
          return;
        }
        this.logger.error(err, 'Error in EOU detection task:');
      });
  }

  private async createSttTask(stt: STTNode | undefined, signal: AbortSignal) {
    if (!stt) return;

    this.logger.debug('createSttTask: create stt stream from stt node');

    const sttStream = await stt(this.sttInputStream, {});

    if (signal.aborted || sttStream === null) return;

    if (sttStream instanceof ReadableStream) {
      const reader = sttStream.getReader();

      signal.addEventListener('abort', async () => {
        try {
          reader.releaseLock();
          await sttStream?.cancel();
        } catch (e) {
          this.logger.debug('createSttTask: error during abort handler:', e);
        }
      });

      try {
        while (true) {
          if (signal.aborted) break;

          const { done, value: ev } = await reader.read();
          if (done) break;

          if (typeof ev === 'string') {
            throw new Error('STT node must yield SpeechEvent');
          } else {
            await this.onSTTEvent(ev);
          }
        }
      } catch (e) {
        if (isStreamReaderReleaseError(e)) {
          return;
        }
        this.logger.error({ error: e }, 'createSttTask: error reading sttStream');
      } finally {
        reader.releaseLock();
        try {
          await sttStream.cancel();
        } catch (e) {
          this.logger.debug(
            'createSttTask: error cancelling sttStream (may already be cancelled):',
            e,
          );
        }
      }
    }
  }

  private async createVadTask(vad: VAD | undefined, signal: AbortSignal) {
    if (!vad) return;

    const vadStream = vad.stream();
    vadStream.updateInputStream(this.vadInputStream);

    const abortHandler = () => {
      vadStream.detachInputStream();
      vadStream.close();
      signal.removeEventListener('abort', abortHandler);
    };
    signal.addEventListener('abort', abortHandler);

    try {
      for await (const ev of vadStream) {
        if (signal.aborted) break;

        switch (ev.type) {
          case VADEventType.START_OF_SPEECH:
            this.logger.debug('VAD task: START_OF_SPEECH');
            this.hooks.onStartOfSpeech(ev);
            this.speaking = true;

            // Capture sample rate from the first VAD event if not already set
            if (ev.frames.length > 0 && ev.frames[0]) {
              this.sampleRate = ev.frames[0].sampleRate;
            }

            this.bounceEOUTask?.cancel();
            break;
          case VADEventType.INFERENCE_DONE:
            this.hooks.onVADInferenceDone(ev);
            // for metrics, get the "earliest" signal of speech as possible
            if (ev.rawAccumulatedSpeech > 0.0) {
              this.lastSpeakingTime = Date.now();

              if (this.speechStartTime === undefined) {
                this.speechStartTime = Date.now();
              }
            }
            break;
          case VADEventType.END_OF_SPEECH:
            this.logger.debug('VAD task: END_OF_SPEECH');
            this.hooks.onEndOfSpeech(ev);

            // when VAD fires END_OF_SPEECH, it already waited for the silence_duration
            this.speaking = false;

            if (
              this.vadBaseTurnDetection ||
              (this.turnDetectionMode === 'stt' && this.userTurnCommitted)
            ) {
              const chatCtx = this.hooks.retrieveChatCtx();
              this.runEOUDetection(chatCtx);
            }
            break;
        }
      }
    } catch (e) {
      this.logger.error(e, 'Error in VAD task');
    } finally {
      this.logger.debug('VAD task closed');
    }
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }

  detachInputAudioStream() {
    this.deferredInputStream.detachSource();
  }

  clearUserTurn() {
    this.audioTranscript = '';
    this.audioInterimTranscript = '';
    this.audioPreflightTranscript = '';
    this.finalTranscriptConfidence = [];
    this.userTurnCommitted = false;

    this.sttTask?.cancelAndWait().finally(() => {
      this.sttTask = Task.from(({ signal }) => this.createSttTask(this.stt, signal));
      this.sttTask.result.catch((err) => {
        this.logger.error(`Error running STT task: ${err}`);
      });
    });
  }

  commitUserTurn(audioDetached: boolean) {
    const commitUserTurnTask =
      (delayDuration: number = 500) =>
      async (controller: AbortController) => {
        if (Date.now() - this.lastFinalTranscriptTime > delayDuration) {
          // flush the stt by pushing silence
          if (audioDetached && this.sampleRate !== undefined) {
            const numSamples = Math.floor(this.sampleRate * 0.5);
            const silence = new Int16Array(numSamples * 2);
            const silenceFrame = new AudioFrame(silence, this.sampleRate, 1, numSamples);
            this.silenceAudioWriter.write(silenceFrame);
          }

          // wait for the final transcript to be available
          await delay(delayDuration, { signal: controller.signal });
        }

        if (this.audioInterimTranscript) {
          // append interim transcript in case the final transcript is not ready
          this.audioTranscript = `${this.audioTranscript} ${this.audioInterimTranscript}`.trim();
        }
        this.audioInterimTranscript = '';

        const chatCtx = this.hooks.retrieveChatCtx();
        this.logger.debug('running EOU detection on commitUserTurn');
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
      .catch((err: unknown) => {
        this.logger.error(err, 'Error in user turn commit task:');
      });
  }

  async close() {
    this.detachInputAudioStream();
    await this.commitUserTurnTask?.cancelAndWait();
    await this.sttTask?.cancelAndWait();
    await this.vadTask?.cancelAndWait();
    await this.bounceEOUTask?.cancelAndWait();
  }

  private get vadBaseTurnDetection() {
    return ['vad', undefined].includes(this.turnDetectionMode);
  }
}
