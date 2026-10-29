// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import { type AudioFrame, AudioResampler, type Room } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { getJobContext } from '../../job.js';
import type { LanguageCode } from '../../language.js';
import { log } from '../../log.js';
import { Task } from '../../utils.js';
import {
  type CloseEvent,
  CloseReason,
  type UserInputTranscribedEvent,
  type UserState,
  type UserStateChangedEvent,
  createCloseEvent,
  createUserInputTranscribedEvent,
  createUserStateChangedEvent,
} from '../../voice/events.js';
import { AgentInput, AgentOutput, type AudioOutput } from '../../voice/io.js';
import { TranslationRoomIO, type TranslationRoomOptions } from './room_io.js';
import {
  type InputSpeechStarted,
  type InputSpeechStopped,
  type InputTranscript,
  OutputSpeechStopped,
  type OutputTranscript,
  type TranslationModel,
  type TranslationModelError,
  type TranslationModelSession,
} from './translation_model.js';

/** Default silence duration that closes unsegmented model output, in milliseconds. */
export const DEFAULT_OUTPUT_SEGMENT_TIMEOUT = 500;

/** A transcript of the translation spoken by the model. */
export interface TranslationTranscribedEvent {
  /** Stable event discriminator. */
  type: 'translation_transcribed';
  /** Transcript text in the target language. */
  transcript: string;
  /** Whether this text completes the current translated transcript. */
  isFinal: boolean;
  /** Provider-stamped language, falling back to the model's target language. */
  language: string | null;
  /** Wall-clock creation time in milliseconds. */
  createdAt: number;
}

/** An error surfaced by a `TranslationSession`. */
export interface TranslationErrorEvent {
  /** Stable event discriminator. */
  type: 'error';
  /** Provider error reported by the model session. */
  error: TranslationModelError;
  /** Translation model that reported the error. */
  source: TranslationModel;
  /** Wall-clock creation time in milliseconds. */
  createdAt: number;
}

/** Event callbacks emitted by `TranslationSession`. */
export type TranslationSessionCallbacks = {
  /** The model reported a source-speaker state transition. */
  user_state_changed: (event: UserStateChangedEvent) => void;
  /** The model transcribed source speech. */
  user_input_transcribed: (event: UserInputTranscribedEvent) => void;
  /** The model transcribed its translated speech. */
  translation_transcribed: (event: TranslationTranscribedEvent) => void;
  /** The translation model reported an error. */
  error: (event: TranslationErrorEvent) => void;
  /** Session teardown completed for the reported reason. */
  close: (event: CloseEvent) => void;
};

/** Node EventEmitter argument tuples for translation session events. */
export type TranslationSessionEventMap = {
  [K in keyof TranslationSessionCallbacks]: Parameters<TranslationSessionCallbacks[K]>;
};

/** Options used to construct a `TranslationSession`. */
export interface TranslationSessionOptions<UserData> {
  /** Translation model run by the session. */
  model: TranslationModel;
  /** Arbitrary caller-owned state carried by the session. */
  userData?: UserData;
  /** Silence that ends output from a model without native segmentation, in milliseconds. */
  outputSegmentTimeout?: number;
}

/** Options accepted by `TranslationSession.start`. */
export interface TranslationSessionStartOptions {
  /** Room to hear and publish into. Omit it to drive `input` and `output` directly. */
  room?: Room;
  /** Configuration for room-backed input, output, and transcripts. */
  roomOptions?: TranslationRoomOptions;
}

/**
 * Runs a `TranslationModel` against caller-owned devices or a LiveKit room.
 *
 * A translator holds no conversation, takes no instructions, invokes no tools, and never decides
 * whether to reply. The model reports input turns itself, so this session does not run VAD.
 */
export class TranslationSession<
  UserData = unknown,
> extends EventEmitter<TranslationSessionEventMap> {
  /** Configurable source-audio input. */
  readonly input: AgentInput;
  /** Configurable translated-audio and transcript outputs. */
  readonly output: AgentOutput;
  /** Translation model run by this session. */
  readonly model: TranslationModel;

  private _userData?: UserData;
  private outputSegmentTimeout: number;
  private _roomIO: TranslationRoomIO | null = null;
  private modelSession: TranslationModelSession | null = null;
  private _userState: UserState = 'listening';
  private started = false;
  private closingTask: Promise<void> | null = null;
  private jobContextCallbackRegistered = false;
  private lifecycleLock = new Mutex();
  private outputLock = new Mutex();
  private inputTask: Task<void> | null = null;
  private outputTask: Task<void> | null = null;
  private transcriptTail: Promise<void> = Promise.resolve();
  private segmentTimer?: ReturnType<typeof setTimeout>;
  private segmentTasks = new Set<Promise<void>>();
  private resampler: AudioResampler | null = null;
  private resamplerKey?: string;
  private resamplerSink: AudioOutput | null = null;
  private outputSink: AudioOutput | null = null;
  private logger = log();

  constructor(options: TranslationSessionOptions<UserData>) {
    super();
    // Node reserves `error`; translation errors remain optional public events like rtc emitters.
    this.on('error', () => {});
    this.model = options.model;
    this._userData = options.userData;
    this.outputSegmentTimeout = options.outputSegmentTimeout ?? DEFAULT_OUTPUT_SEGMENT_TIMEOUT;
    this.input = new AgentInput(() => this.onAudioInputChanged());
    this.output = new AgentOutput(
      () => {},
      () => {},
    );
  }

  /** Current user state, driven by model-reported input turn boundaries. */
  get userState(): UserState {
    return this._userState;
  }

  /** Room wiring for the active run, or `null` for standalone sessions. */
  get roomIO(): TranslationRoomIO | null {
    return this._roomIO;
  }

  /** Caller-owned session state. Throws when none has been assigned. */
  get userData(): UserData {
    if (this._userData === undefined) {
      throw new Error('TranslationSession userData is not set');
    }
    return this._userData;
  }

  set userData(value: UserData) {
    this._userData = value;
  }

  /**
   * Point the model at another target language.
   *
   * Before start, this changes future model sessions. During a run, the live provider session is
   * updated first, so a provider refusal leaves the model's advertised language unchanged.
   */
  setTargetLanguage(language: string): void {
    if (this.modelSession && !this.model.capabilities.retargetable) {
      throw new Error(
        `${this.model.label} translates into a language fixed for the session's life; ` +
          'start a new session to translate into another',
      );
    }
    this.modelSession?.updateOptions({ targetLanguage: language });
    this.model.updateOptions({ targetLanguage: language });
  }

  /** Start translating. Calling this on an active run is a no-op. */
  async start(options: TranslationSessionStartOptions = {}): Promise<void> {
    const unlock = await this.lifecycleLock.lock();
    try {
      if (this.started) return;
      try {
        const jobCtx = getJobContext(false);
        if (options.room && !this._roomIO) {
          const roomOptions = { ...(options.roomOptions ?? {}) };
          if (this.input.audio && roomOptions.audioInput !== false) {
            this.logger.warn(
              'room audio input is enabled but input.audio is already set, ignoring',
            );
            roomOptions.audioInput = false;
          }
          if (this.output.audio && roomOptions.audioOutput !== false) {
            this.logger.warn(
              'room audio output is enabled but output.audio is already set, ignoring',
            );
            roomOptions.audioOutput = false;
          }
          this._roomIO = new TranslationRoomIO(this, options.room, roomOptions);
          await this._roomIO.start();
          if (jobCtx) await jobCtx.connect();
        }

        if (jobCtx && !this.jobContextCallbackRegistered) {
          jobCtx.addShutdownCallback(() => this.closeImpl(CloseReason.JOB_SHUTDOWN));
          this.jobContextCallbackRegistered = true;
        }

        const modelSession = this.model.session();
        this.modelSession = modelSession;
        modelSession.on('input_speech_started', this.onInputSpeechStarted);
        modelSession.on('input_speech_stopped', this.onInputSpeechStopped);
        modelSession.on('input_transcript', this.onInputTranscript);
        modelSession.on('output_transcript', this.onOutputTranscript);
        modelSession.on('error', this.onModelError);

        this.closingTask = null;
        this.transcriptTail = Promise.resolve();
        this.started = true;
        if (this.input.audio) this.startInputTask();
        this.outputTask = Task.from(
          (controller) => this.forwardOutputAudio(modelSession, controller.signal),
          undefined,
          'translation_forward_output_audio',
        );
      } catch (error) {
        await this.rollbackFailedStart();
        throw error;
      }
    } finally {
      unlock();
    }
  }

  /** Stop translating and release the active model run and room wiring. */
  async close(): Promise<void> {
    await this.closeImpl(CloseReason.USER_INITIATED);
  }

  /** Begin closing without waiting for teardown to finish. */
  shutdown(): void {
    this.closeSoon(CloseReason.USER_INITIATED);
  }

  /** @internal Close the session for framework-owned reasons. */
  _closeSoon(reason: CloseReason): void {
    this.closeSoon(reason);
  }

  private closeSoon(reason: CloseReason): void {
    if (this.closingTask) return;
    this.closingTask = this.closeImpl(reason).catch((error) => {
      this.logger.error({ error }, 'failed to close translation session');
    });
  }

  private async closeImpl(reason: CloseReason): Promise<void> {
    const unlock = await this.lifecycleLock.lock();
    try {
      if (!this.started) return;
      this.started = false;
      const roomIO = this._roomIO;
      roomIO?._abort();
      this.cancelSegmentTimer();
      // Abort forwarding first: it may hold outputLock while a segment task waits for it.
      this.inputTask?.cancel();
      this.outputTask?.cancel();
      await Promise.allSettled([
        this.inputTask?.cancelAndWait() ?? Promise.resolve(),
        this.outputTask?.cancelAndWait() ?? Promise.resolve(),
      ]);
      this.inputTask = this.outputTask = null;
      await Promise.allSettled(this.segmentTasks);
      this.segmentTasks.clear();
      await this.transcriptTail.catch(() => {});

      const modelSession = this.modelSession;
      this.modelSession = null;
      await modelSession?.close();

      if (roomIO) {
        if (this.input.audio === roomIO.audioInput) this.input.audio = null;
        if (this.output.audio === roomIO.audioOutput) this.output.audio = null;
        if (this.output.transcription === roomIO.transcriptionOutput) {
          this.output.transcription = null;
        }
      }

      this.emit('close', createCloseEvent(reason));
      await roomIO?.close();
      this._roomIO = null;
      this.discardResampler();
      this.outputSink = null;
      this._userState = 'listening';
    } finally {
      unlock();
    }
  }

  private async rollbackFailedStart(): Promise<void> {
    this.started = false;
    this.cancelSegmentTimer();
    this.inputTask?.cancel();
    this.outputTask?.cancel();
    await Promise.allSettled([
      this.inputTask?.cancelAndWait() ?? Promise.resolve(),
      this.outputTask?.cancelAndWait() ?? Promise.resolve(),
    ]);
    this.inputTask = this.outputTask = null;
    await Promise.allSettled(this.segmentTasks);
    this.segmentTasks.clear();

    const modelSession = this.modelSession;
    this.modelSession = null;
    try {
      await modelSession?.close();
    } catch (error) {
      this.logger.error({ error }, 'failed to close translation model after startup error');
    }

    const roomIO = this._roomIO;
    if (roomIO) {
      roomIO._abort();
      if (this.input.audio === roomIO.audioInput) this.input.audio = null;
      if (this.output.audio === roomIO.audioOutput) this.output.audio = null;
      if (this.output.transcription === roomIO.transcriptionOutput) {
        this.output.transcription = null;
      }
      try {
        await roomIO.close();
      } catch (error) {
        this.logger.error({ error }, 'failed to close translation room I/O after startup error');
      }
      this._roomIO = null;
    }

    this.discardResampler();
    this.outputSink = null;
    this.transcriptTail = Promise.resolve();
    this._userState = 'listening';
  }

  private startInputTask(): void {
    this.inputTask = Task.from(
      (controller) => this.forwardInputAudio(controller.signal),
      undefined,
      'translation_forward_input_audio',
    );
  }

  private async forwardInputAudio(signal: AbortSignal): Promise<void> {
    const audioInput = this.input.audio;
    if (!audioInput) return;
    const reader = audioInput.stream.getReader();
    const aborted = Symbol('aborted');
    const abortPromise = new Promise<typeof aborted>((resolve) => {
      signal.addEventListener('abort', () => resolve(aborted), { once: true });
    });
    try {
      while (!signal.aborted) {
        const read = reader.read();
        const result = await Promise.race([read, abortPromise]);
        if (result === aborted) {
          void read.catch(() => {});
          break;
        }
        if (result.done || signal.aborted) break;
        this.modelSession?.pushAudio(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async forwardOutputAudio(
    modelSession: TranslationModelSession,
    signal: AbortSignal,
  ): Promise<void> {
    const marksSegments = this.model.capabilities.outputSegmentation;
    const reader = modelSession.audioStream.getReader();
    const aborted = Symbol('aborted');
    const abortPromise = new Promise<typeof aborted>((resolve) => {
      signal.addEventListener('abort', () => resolve(aborted), { once: true });
    });
    try {
      while (!signal.aborted) {
        const read = reader.read();
        const result = await Promise.race([read, abortPromise]);
        if (result === aborted) {
          void read.catch(() => {});
          break;
        }
        if (result.done || signal.aborted) break;
        if (result.value instanceof OutputSpeechStopped) {
          await this.closeOutputSegment();
          continue;
        }
        if (!this.output.audio || !this.output.audioEnabled) continue;

        const unlock = await this.outputLock.lock();
        try {
          const output = this.output.audio;
          if (output) {
            const capture = this.captureOutputFrame(result.value.frame, output);
            const captured = await Promise.race([capture.then(() => true), abortPromise]);
            if (captured === aborted) {
              void capture.catch((error) => {
                this.logger.error({ error }, 'audio output capture failed after session close');
              });
              break;
            }
          }
        } finally {
          unlock();
        }
        if (!marksSegments) this.armSegmentTimer();
      }
    } finally {
      reader.releaseLock();
      this.cancelSegmentTimer();
      const unlock = await this.outputLock.lock();
      try {
        if (signal.aborted) this.discardResampler();
        else await this.drainResampler();
      } finally {
        unlock();
      }
    }
  }

  private onInputSpeechStarted = (_event: InputSpeechStarted): void => {
    this.updateUserState('speaking');
  };

  private onInputSpeechStopped = (_event: InputSpeechStopped): void => {
    this.updateUserState('listening');
  };

  private onInputTranscript = (event: InputTranscript): void => {
    this.emit(
      'user_input_transcribed',
      createUserInputTranscribedEvent({
        transcript: event.text,
        isFinal: event.isFinal,
        language: (event.language as LanguageCode | undefined) ?? null,
        speakerId: event.speakerId ?? null,
      }),
    );
  };

  private onOutputTranscript = (event: OutputTranscript): void => {
    const output = this.output.transcription;
    if (output && this.output.transcriptionEnabled) {
      this.transcriptTail = this.transcriptTail
        .then(async () => {
          await output.captureText(event.text);
          if (event.isFinal) output.flush();
        })
        .catch((error) => {
          this.logger.error({ error }, 'failed to forward translated transcript');
        });
    }
    this.emit('translation_transcribed', {
      type: 'translation_transcribed',
      transcript: event.text,
      isFinal: event.isFinal,
      language: event.language ?? this.model.targetLanguage,
      createdAt: Date.now(),
    });
  };

  private onModelError = (error: TranslationModelError): void => {
    this.emit('error', { type: 'error', error, source: this.model, createdAt: Date.now() });
    if (!error.recoverable) {
      this.logger.error(
        { label: error.label, error: error.error.message },
        'translation model error, closing the session',
      );
      this.closeSoon(CloseReason.ERROR);
    }
  };

  private async captureOutputFrame(frame: AudioFrame, output: AudioOutput): Promise<void> {
    if (this.outputSink && this.outputSink !== output) {
      this.logger.debug('audio output replaced, closing the segment it was given');
      await this.closeSegmentLocked();
    }
    this.outputSink = output;

    const targetRate = output.sampleRate;
    const key = `${frame.sampleRate}:${frame.channels}:${targetRate ?? 'native'}`;
    if (this.resampler && (this.resamplerKey !== key || this.resamplerSink !== output)) {
      if (this.resamplerSink === output) {
        await this.drainResampler();
      } else {
        const oldSink = this.resamplerSink;
        await this.drainResampler();
        oldSink?.flush();
        this.outputSink = output;
      }
    }

    if (!targetRate || frame.sampleRate === targetRate) {
      await output.captureFrame(frame);
      return;
    }
    if (!this.resampler) {
      this.resampler = new AudioResampler(frame.sampleRate, targetRate, frame.channels);
      this.resamplerKey = key;
      this.resamplerSink = output;
    }
    for (const resampled of this.resampler.push(frame)) {
      await output.captureFrame(resampled);
    }
  }

  private async drainResampler(): Promise<void> {
    const resampler = this.resampler;
    const sink = this.resamplerSink;
    this.discardResampler();
    if (!resampler || !sink) return;
    for (const frame of resampler.flush()) await sink.captureFrame(frame);
  }

  private discardResampler(): void {
    this.resampler = null;
    this.resamplerKey = undefined;
    this.resamplerSink = null;
  }

  private async closeOutputSegment(): Promise<void> {
    this.cancelSegmentTimer();
    const unlock = await this.outputLock.lock();
    try {
      await this.closeSegmentLocked();
    } finally {
      unlock();
    }
  }

  private async closeSegmentLocked(): Promise<void> {
    const sink = this.outputSink ?? this.resamplerSink ?? this.output.audio;
    await this.drainResampler();
    sink?.flush();
    if (this.outputSink === sink) this.outputSink = null;
  }

  private armSegmentTimer(): void {
    this.cancelSegmentTimer();
    this.segmentTimer = setTimeout(() => {
      this.segmentTimer = undefined;
      const task = this.closeOutputSegment();
      this.segmentTasks.add(task);
      void task.finally(() => this.segmentTasks.delete(task));
    }, this.outputSegmentTimeout);
  }

  private cancelSegmentTimer(): void {
    if (this.segmentTimer) clearTimeout(this.segmentTimer);
    this.segmentTimer = undefined;
  }

  private updateUserState(state: UserState): void {
    if (this._userState === state) return;
    const oldState = this._userState;
    this._userState = state;
    this.emit('user_state_changed', createUserStateChangedEvent(oldState, state));
  }

  private onAudioInputChanged(): void {
    if (!this.started) return;
    this.inputTask?.cancel();
    this.inputTask = null;
    if (this.input.audio) this.startInputTask();
  }
}
