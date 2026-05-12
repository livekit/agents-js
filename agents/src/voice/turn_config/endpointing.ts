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
   * Exponential moving average coefficient for dynamic endpointing. Higher values give more
   * weight to history.
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

  constructor({ minDelay, maxDelay }: { minDelay: number; maxDelay: number }) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
  }

  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number }) {
    if (minDelay !== undefined) {
      this._minDelay = minDelay;
    }
    if (maxDelay !== undefined) {
      this._maxDelay = maxDelay;
    }
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

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this._overlapping = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
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
  #speaking = false;

  constructor({
    minDelay,
    maxDelay,
    alpha = 0.9,
  }: {
    minDelay: number;
    maxDelay: number;
    alpha?: number;
  }) {
    super({ minDelay, maxDelay });
    this.#utterancePause = new ExpFilter({
      alpha,
      initial: minDelay,
      minVal: minDelay,
      maxVal: maxDelay,
    });
    this.#turnPause = new ExpFilter({
      alpha,
      initial: maxDelay,
      minVal: minDelay,
      maxVal: maxDelay,
    });
  }

  override get minDelay(): number {
    return this.#utterancePause.value ?? this._minDelay;
  }

  override get maxDelay(): number {
    return Math.max(this.#turnPause.value ?? this._maxDelay, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this.#utteranceStartedAt === undefined || this.#utteranceEndedAt === undefined) {
      return 0;
    }
    return Math.max(0, this.#utteranceStartedAt - this.#utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this.#agentSpeechStartedAt === undefined || this.#utteranceEndedAt === undefined) {
      return 0;
    }
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
    if (this._overlapping) {
      return;
    }

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
    this.#speaking = true;
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this._overlapping) {
      if (
        this.#utteranceStartedAt === undefined ||
        this.#agentSpeechStartedAt === undefined ||
        Math.abs(this.#utteranceStartedAt - this.#agentSpeechStartedAt) >=
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        this._overlapping = false;
        this.#speaking = false;
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
      const pause = this.betweenUtteranceDelay;
      if (
        interruptionDelay > 0 &&
        interruptionDelay <= this.minDelay &&
        turnDelay > 0 &&
        turnDelay <= this.maxDelay &&
        pause > 0
      ) {
        this.#utterancePause.apply(1, pause);
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
    this.#speaking = false;
    this._overlapping = false;
  }

  override updateOptions({
    minDelay,
    maxDelay,
    alpha,
  }: {
    minDelay?: number;
    maxDelay?: number;
    alpha?: number;
  }) {
    if (minDelay !== undefined) {
      this._minDelay = minDelay;
      this.#utterancePause.reset({ initial: minDelay, minVal: minDelay });
      this.#turnPause.reset({ minVal: minDelay });
    }
    if (maxDelay !== undefined) {
      this._maxDelay = maxDelay;
      this.#turnPause.reset({ initial: maxDelay, maxVal: maxDelay });
      this.#utterancePause.reset({ maxVal: maxDelay });
    }
    if (alpha !== undefined) {
      this.#utterancePause.reset({ alpha });
      this.#turnPause.reset({ alpha });
    }
  }
}

export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  if (options.mode === 'dynamic') {
    return new DynamicEndpointing({
      minDelay: options.minDelay,
      maxDelay: options.maxDelay,
      alpha: options.alpha,
    });
  }
  return new BaseEndpointing({ minDelay: options.minDelay, maxDelay: options.maxDelay });
}
