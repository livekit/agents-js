// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { EventMap } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';

/** Describes which optional behaviors a translation provider supports. */
export class TranslationCapabilities {
  /** Whether the model transcribes speech in the language in which it was spoken. */
  inputTranscription: boolean;
  /** Whether the model transcribes the translation it speaks. */
  outputTranscription: boolean;
  /** Whether the model reports where input turns start and stop. */
  turnReporting: boolean;
  /** Whether the audio stream marks the end of each spoken translation. */
  outputSegmentation: boolean;
  /** Whether a running model session can change its target language. */
  retargetable: boolean;

  constructor(options: Partial<TranslationCapabilities> = {}) {
    this.inputTranscription = options.inputTranscription ?? false;
    this.outputTranscription = options.outputTranscription ?? false;
    this.turnReporting = options.turnReporting ?? false;
    this.outputSegmentation = options.outputSegmentation ?? false;
    this.retargetable = options.retargetable ?? false;
  }
}

/** One frame of translated speech produced by a model. */
export interface TranslatedAudioFrame {
  /** Audio spoken by the model. */
  frame: AudioFrame;
  /** Language spoken in this frame, when the provider stamps its audio. */
  language?: string;
}

/** A transcript of what the model heard in the original language. */
export interface InputTranscript {
  /** Transcript text in the source language. */
  text: string;
  /** Whether this text completes the current input transcript. */
  isFinal: boolean;
  /** Detected or configured source language. */
  language?: string;
  /** Provider-reported speaker identifier. */
  speakerId?: string;
}

/** A transcript of what the model said in the target language. */
export interface OutputTranscript {
  /** Transcript text in the target language. */
  text: string;
  /** Whether this text completes the current output transcript. */
  isFinal: boolean;
  /** Target language stamped by the provider. */
  language?: string;
}

/** Indicates that the input speaker began a turn. */
export class InputSpeechStarted {}

/** Indicates that the input speaker ended a turn. */
export class InputSpeechStopped {}

/**
 * Marks the end of one translated-audio segment.
 *
 * This marker travels in `TranslationModelSession.audioStream`, behind the audio it
 * closes, so it cannot overtake frames already queued by the provider.
 */
export class OutputSpeechStopped {}

/** An error reported by a translation model session. */
export interface TranslationModelError {
  /** Stable event discriminator. */
  type: 'translation_model_error';
  /** Wall-clock timestamp in milliseconds. */
  timestamp: number;
  /** Provider implementation label. */
  label: string;
  /** Underlying provider failure. */
  error: Error;
  /** Whether the provider session can continue after this failure. */
  recoverable: boolean;
}

/** Event names emitted by `TranslationModelSession`. */
export type TranslationEventTypes =
  | 'input_speech_started'
  | 'input_speech_stopped'
  | 'input_transcript'
  | 'output_transcript'
  | 'error';

/** Event callbacks emitted by `TranslationModelSession`. */
export type TranslationModelSessionCallbacks = {
  /** The source speaker began a turn. */
  input_speech_started: (event: InputSpeechStarted) => void;
  /** The source speaker ended a turn. */
  input_speech_stopped: (event: InputSpeechStopped) => void;
  /** The model transcribed source speech. */
  input_transcript: (event: InputTranscript) => void;
  /** The model transcribed translated speech. */
  output_transcript: (event: OutputTranscript) => void;
  /** The provider reported a recoverable or terminal failure. */
  error: (event: TranslationModelError) => void;
};

/** Node EventEmitter argument tuples for standard and provider-specific translation events. */
export type TranslationModelSessionEventMap<Events extends EventMap = Record<never, never>> = {
  [
    K in keyof (Omit<Events, keyof TranslationModelSessionCallbacks> &
      TranslationModelSessionCallbacks)
  ]: (Omit<Events, keyof TranslationModelSessionCallbacks> &
    TranslationModelSessionCallbacks)[K] extends (...args: infer Args) => unknown
    ? Args
    : never;
};

/**
 * A model that hears speech in one language and speaks it in another.
 *
 * Unlike an LLM-backed agent, a translator has no instructions, conversation context, tools, or
 * decision to reply. Run it with `TranslationSession`.
 */
export abstract class TranslationModel {
  /** Optional behaviors supported by this provider. */
  readonly capabilities: TranslationCapabilities;
  /** Expected source language, or `undefined` when the provider detects it. */
  readonly sourceLanguage?: string;
  /** Mutable target language used for future model sessions. */
  protected _targetLanguage: string;

  /** Create a translation model with its provider capabilities and language direction. */
  constructor(options: {
    capabilities: TranslationCapabilities;
    targetLanguage: string;
    sourceLanguage?: string;
  }) {
    this.capabilities = options.capabilities;
    this._targetLanguage = options.targetLanguage;
    this.sourceLanguage = options.sourceLanguage;
  }

  /** Provider model identifier, or `unknown` when unavailable. */
  get model(): string {
    return 'unknown';
  }

  /** Provider name, or `unknown` when unavailable. */
  get provider(): string {
    return 'unknown';
  }

  /** Diagnostic label for this provider implementation. */
  get label(): string {
    return this.constructor.name;
  }

  /** Language in which the model speaks its translation. */
  get targetLanguage(): string {
    return this._targetLanguage;
  }

  /** Change the target language used by sessions opened in the future. */
  updateOptions(options: { targetLanguage: string }): void {
    this._targetLanguage = options.targetLanguage;
  }

  /** Open one audio-in, translated-audio-out model session. */
  abstract session(): TranslationModelSession;

  /** Release resources owned by the model itself. */
  abstract close(): Promise<void>;
}

/**
 * One run of a `TranslationModel`: source audio in and translated audio out.
 *
 * Providers emit transcripts and input-turn events, and enqueue translated frames plus ordered
 * `OutputSpeechStopped` markers on `audioStream`. `Events` adds provider-specific callbacks to
 * the standard translation events.
 */
export abstract class TranslationModelSession<
  Events extends EventMap = Record<never, never>,
> extends EventEmitter<TranslationModelSessionEventMap<Events>> {
  constructor(
    /** Model that owns this run. */
    readonly translationModel: TranslationModel,
  ) {
    super();
  }

  /** Capabilities advertised by the owning model. */
  get capabilities(): TranslationCapabilities {
    return this.translationModel.capabilities;
  }

  /** Translated audio and ordered segment-boundary markers. */
  abstract get audioStream(): ReadableStream<TranslatedAudioFrame | OutputSpeechStopped>;

  /** Hand the model one source-speech audio frame. */
  abstract pushAudio(frame: AudioFrame): void;

  /** Drop translated audio the model has produced but not spoken, when supported. */
  clearAudio(): void {}

  /**
   * Change the target language of this running session.
   *
   * Providers advertising `retargetable` override this method. The default rejects the change.
   */
  updateOptions(_options: { targetLanguage: string }): void {
    throw new Error(
      `${this.translationModel.label} translates into a language fixed for the session's life; ` +
        'start a new session to translate into another',
    );
  }

  /** Stop this run and release its resources. */
  abstract close(): Promise<void>;
}
