// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ExpFilter } from '../../utils.js';

/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
export interface EndpointingOptions {
  /**
   * Endpointing mode. `"fixed"` uses a fixed delay, `"dynamic"` adjusts delay based on
   * end-of-utterance prediction.
   * @defaultValue "fixed"
   */
  mode: 'fixed' | 'dynamic';
  /**
   * Minimum time in milliseconds since the last detected speech before the agent declares the user's
   * turn complete. In VAD mode this effectively behaves like `max(VAD silence, minDelay)`;
   * in STT mode it is applied after the STT end-of-speech signal, so it can be additive with
   * the STT provider's endpointing delay.
   * @defaultValue 500
   */
  minDelay: number;
  /**
   * Maximum time in milliseconds the agent will wait before terminating the turn.
   * @defaultValue 3000
   */
  maxDelay: number;
  /**
   * Exponential moving average coefficient for dynamic endpointing. The higher the value,
   * the more weight is given to history.
   * @defaultValue 0.9
   */
  alpha: number;
}

export const defaultEndpointingOptions = {
  mode: 'fixed',
  minDelay: 500,
  maxDelay: 3000,
  alpha: 0.9,
} as const satisfies EndpointingOptions;

const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

export class BaseEndpointing {
  protected _minDelay: number;
  protected _maxDelay: number;
  protected _overlapping = false;

  constructor(minDelay: number, maxDelay: number) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
  }

  get minDelay(): number {
    return this._minDelay;
  }

  get maxDelay(): number {
    return this._maxDelay;
  }

  get overlapping(): boolean {
    return this._overlapping;
  }

  updateOptions(options: { minDelay?: number; maxDelay?: number }): void {
    if (options.minDelay !== undefined) this._minDelay = options.minDelay;
    if (options.maxDelay !== undefined) this._maxDelay = options.maxDelay;
  }

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this._overlapping = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _options?: { shouldIgnore?: boolean }): void {
    this._overlapping = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

export class DynamicEndpointing extends BaseEndpointing {
  #utterancePause: ExpFilter;
  #turnPause: ExpFilter;
  #utteranceStartedAt?: number;
  #utteranceEndedAt?: number;
  #agentSpeechStartedAt?: number;
  #agentSpeechEndedAt?: number;

  constructor(minDelay: number, maxDelay: number, alpha: number = defaultEndpointingOptions.alpha) {
    super(minDelay, maxDelay);
    this.#utterancePause = new ExpFilter(alpha, maxDelay, minDelay, minDelay);
    this.#turnPause = new ExpFilter(alpha, maxDelay, minDelay, maxDelay);
  }

  override get minDelay(): number {
    return this.#utterancePause.value ?? this._minDelay;
  }

  override get maxDelay(): number {
    return Math.max(this.#turnPause.value ?? this._maxDelay, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this.#utteranceEndedAt === undefined || this.#utteranceStartedAt === undefined) return 0;
    return Math.max(0, this.#utteranceStartedAt - this.#utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this.#agentSpeechStartedAt === undefined || this.#utteranceEndedAt === undefined) return 0;
    return Math.max(0, this.#agentSpeechStartedAt - this.#utteranceEndedAt);
  }

  get immediateInterruptionDelay(): [number, number] {
    if (this.#utteranceStartedAt === undefined || this.#agentSpeechStartedAt === undefined) {
      return [0, 0];
    }
    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  override onStartOfAgentSpeech(startedAt: number): void {
    this.#agentSpeechStartedAt = startedAt;
    this.#agentSpeechEndedAt = undefined;
    this._overlapping = false;
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.#agentSpeechStartedAt !== undefined &&
      (this.#agentSpeechEndedAt === undefined ||
        this.#agentSpeechEndedAt < this.#agentSpeechStartedAt)
    ) {
      this.#agentSpeechEndedAt = endedAt;
    }
    this._overlapping = false;
  }

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this._overlapping) return;

    if (
      this.#utteranceStartedAt !== undefined &&
      this.#utteranceEndedAt !== undefined &&
      this.#agentSpeechStartedAt !== undefined &&
      this.#utteranceEndedAt < this.#utteranceStartedAt &&
      overlapping
    ) {
      this.#utteranceEndedAt = this.#agentSpeechStartedAt - 1;
    }

    this.#utteranceStartedAt = startedAt;
    this._overlapping = overlapping;
  }

  override onEndOfSpeech(endedAt: number, options: { shouldIgnore?: boolean } = {}): void {
    if (options.shouldIgnore && this._overlapping) {
      const withinGracePeriod =
        this.#utteranceStartedAt !== undefined &&
        this.#agentSpeechStartedAt !== undefined &&
        Math.abs(this.#utteranceStartedAt - this.#agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD;

      if (!withinGracePeriod) {
        this._overlapping = false;
        this.#utteranceStartedAt = undefined;
        this.#utteranceEndedAt = undefined;
        return;
      }
    }

    if (
      this._overlapping ||
      (this.#agentSpeechStartedAt !== undefined && this.#agentSpeechEndedAt === undefined)
    ) {
      const [turnDelay, interruptionDelay] = this.immediateInterruptionDelay;
      const betweenUtteranceDelay = this.betweenUtteranceDelay;
      if (
        interruptionDelay > 0 &&
        interruptionDelay <= this.minDelay &&
        turnDelay > 0 &&
        turnDelay <= this.maxDelay &&
        betweenUtteranceDelay > 0
      ) {
        this.#utterancePause.apply(1, betweenUtteranceDelay);
      } else if (this.betweenTurnDelay > 0) {
        this.#turnPause.apply(1, this.betweenTurnDelay);
      }
    } else if (this.betweenTurnDelay > 0) {
      this.#turnPause.apply(1, this.betweenTurnDelay);
    } else if (
      this.betweenUtteranceDelay > 0 &&
      this.#agentSpeechEndedAt === undefined &&
      this.#agentSpeechStartedAt === undefined
    ) {
      this.#utterancePause.apply(1, this.betweenUtteranceDelay);
    }

    this.#utteranceEndedAt = endedAt;
    this.#agentSpeechStartedAt = undefined;
    this.#agentSpeechEndedAt = undefined;
    this._overlapping = false;
  }

  override updateOptions(options: { minDelay?: number; maxDelay?: number; alpha?: number }): void {
    if (options.minDelay !== undefined) {
      this._minDelay = options.minDelay;
      this.#utterancePause.reset(undefined, this._minDelay, this._minDelay);
      this.#turnPause.reset(undefined, undefined, this._minDelay);
    }
    if (options.maxDelay !== undefined) {
      this._maxDelay = options.maxDelay;
      this.#turnPause.reset(undefined, this._maxDelay, undefined, this._maxDelay);
      this.#utterancePause.reset(undefined, undefined, undefined, this._maxDelay);
    }
    if (options.alpha !== undefined) {
      this.#utterancePause.reset(options.alpha);
      this.#turnPause.reset(options.alpha);
    }
  }
}

export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  if (options.mode === 'dynamic') {
    return new DynamicEndpointing(options.minDelay, options.maxDelay, options.alpha);
  }
  return new BaseEndpointing(options.minDelay, options.maxDelay);
}
