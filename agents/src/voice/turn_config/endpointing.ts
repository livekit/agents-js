// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
export interface EndpointingOptions {
  /**
   * Endpointing mode. `"fixed"` uses a fixed delay, `"dynamic"` adjusts delay based on
   * recent speech activity.
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
   * Exponential moving average coefficient for dynamic endpointing. The higher the value, the
   * more weight is given to historical speech timing.
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

class ExpFilter {
  #value: number | undefined;

  constructor(
    private alpha: number,
    initial?: number,
    private minVal?: number,
    private maxVal?: number,
  ) {
    this.#value = initial;
  }

  get value(): number | undefined {
    return this.#value;
  }

  apply(exp: number, sample: number): number {
    let next = sample;
    if (this.#value !== undefined) {
      const a = this.alpha ** exp;
      next = a * this.#value + (1 - a) * sample;
    }
    if (this.minVal !== undefined) {
      next = Math.max(this.minVal, next);
    }
    if (this.maxVal !== undefined) {
      next = Math.min(this.maxVal, next);
    }
    this.#value = next;
    return next;
  }

  reset(options: { alpha?: number; initial?: number; minVal?: number; maxVal?: number } = {}) {
    if (options.alpha !== undefined) {
      this.alpha = options.alpha;
    }
    if (options.minVal !== undefined) {
      this.minVal = options.minVal;
    }
    if (options.maxVal !== undefined) {
      this.maxVal = options.maxVal;
    }
    if (options.initial !== undefined) {
      this.#value = options.initial;
    }
  }
}

export class BaseEndpointing {
  protected _overlapping = false;

  constructor(
    protected _minDelay: number,
    protected _maxDelay: number,
  ) {}

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
    if (options.minDelay !== undefined) {
      this._minDelay = options.minDelay;
    }
    if (options.maxDelay !== undefined) {
      this._maxDelay = options.maxDelay;
    }
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
  #utteranceStartedAt: number | undefined;
  #utteranceEndedAt: number | undefined;
  #agentSpeechStartedAt: number | undefined;
  #agentSpeechEndedAt: number | undefined;

  constructor(minDelay: number, maxDelay: number, alpha = 0.9) {
    super(minDelay, maxDelay);
    this.#utterancePause = new ExpFilter(alpha, minDelay, minDelay, maxDelay);
    this.#turnPause = new ExpFilter(alpha, maxDelay, minDelay, maxDelay);
  }

  override get minDelay(): number {
    return this.#utterancePause.value ?? this._minDelay;
  }

  override get maxDelay(): number {
    return Math.max(this.#turnPause.value ?? this._maxDelay, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this.#utteranceEndedAt === undefined || this.#utteranceStartedAt === undefined) {
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
      const utterancePause = this.betweenUtteranceDelay;
      if (
        interruptionDelay > 0 &&
        interruptionDelay <= this.minDelay &&
        turnDelay > 0 &&
        turnDelay <= this.maxDelay &&
        utterancePause > 0
      ) {
        this.#utterancePause.apply(1, utterancePause);
      } else {
        const turnPause = this.betweenTurnDelay;
        if (turnPause > 0) {
          this.#turnPause.apply(1, turnPause);
        }
      }
    } else {
      const turnPause = this.betweenTurnDelay;
      if (turnPause > 0) {
        this.#turnPause.apply(1, turnPause);
      } else if (
        this.betweenUtteranceDelay > 0 &&
        this.#agentSpeechEndedAt === undefined &&
        this.#agentSpeechStartedAt === undefined
      ) {
        this.#utterancePause.apply(1, this.betweenUtteranceDelay);
      }
    }

    this.#utteranceEndedAt = endedAt;
    this.#agentSpeechStartedAt = undefined;
    this.#agentSpeechEndedAt = undefined;
    this._overlapping = false;
  }

  override updateOptions(options: { minDelay?: number; maxDelay?: number; alpha?: number }): void {
    if (options.minDelay !== undefined) {
      this._minDelay = options.minDelay;
      this.#utterancePause.reset({ initial: this._minDelay, minVal: this._minDelay });
      this.#turnPause.reset({ minVal: this._minDelay });
    }
    if (options.maxDelay !== undefined) {
      this._maxDelay = options.maxDelay;
      this.#turnPause.reset({ initial: this._maxDelay, maxVal: this._maxDelay });
      this.#utterancePause.reset({ maxVal: this._maxDelay });
    }
    if (options.alpha !== undefined) {
      this.#utterancePause.reset({ alpha: options.alpha });
      this.#turnPause.reset({ alpha: options.alpha });
    }
  }
}

export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  if (options.mode === 'dynamic') {
    return new DynamicEndpointing(options.minDelay, options.maxDelay, options.alpha);
  }
  return new BaseEndpointing(options.minDelay, options.maxDelay);
}
