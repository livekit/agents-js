// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

class ExpFilter {
  _alpha: number;
  _value: number | undefined;
  _minValue: number | undefined;
  _maxValue: number | undefined;

  constructor(
    alpha: number,
    options: {
      initial?: number;
      minValue?: number;
      maxValue?: number;
    } = {},
  ) {
    if (!(alpha > 0 && alpha <= 1)) {
      throw new Error('alpha must be in (0, 1].');
    }

    this._alpha = alpha;
    this._value = options.initial;
    this._minValue = options.minValue;
    this._maxValue = options.maxValue;
  }

  reset(
    options: {
      alpha?: number;
      initial?: number;
      minValue?: number;
      maxValue?: number;
    } = {},
  ): void {
    if (options.alpha !== undefined) {
      if (!(options.alpha > 0 && options.alpha <= 1)) {
        throw new Error('alpha must be in (0, 1].');
      }
      this._alpha = options.alpha;
    }

    if (options.initial !== undefined) {
      this._value = options.initial;
    }
    if (options.minValue !== undefined) {
      this._minValue = options.minValue;
    }
    if (options.maxValue !== undefined) {
      this._maxValue = options.maxValue;
    }
  }

  apply(exp: number, sample?: number): number {
    const nextSample = sample ?? this._value;

    if (nextSample === undefined && this._value === undefined) {
      throw new Error('sample or initial value must be given.');
    }

    if (nextSample !== undefined && this._value === undefined) {
      this._value = nextSample;
    } else if (nextSample !== undefined && this._value !== undefined) {
      const a = this._alpha ** exp;
      this._value = a * this._value + (1 - a) * nextSample;
    }

    if (this._value === undefined) {
      throw new Error('sample or initial value must be given.');
    }

    if (this._maxValue !== undefined && this._value > this._maxValue) {
      this._value = this._maxValue;
    }
    if (this._minValue !== undefined && this._value < this._minValue) {
      this._value = this._minValue;
    }

    return this._value;
  }

  get value(): number | undefined {
    return this._value;
  }
}

/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
// Ref: python livekit-agents/livekit/agents/voice/turn.py - 47-69 lines
export interface EndpointingOptions {
  /**
   * Endpointing mode. `"fixed"` uses the configured delays as-is, `"dynamic"` adapts the
   * effective delay within the configured range based on observed session pause statistics.
   * @defaultValue "fixed"
   */
  mode: 'fixed' | 'dynamic';
  /**
   * Minimum time in milliseconds since the last detected speech before the agent declares the user's
   * turn complete. In dynamic mode this is the lower bound for the learned delay.
   * @defaultValue 500
   */
  minDelay: number;
  /**
   * Maximum time in milliseconds the agent will wait before terminating the turn. In dynamic mode
   * this is the upper bound for the learned delay.
   * @defaultValue 3000
   */
  maxDelay: number;
}

export const defaultEndpointingOptions = {
  mode: 'fixed',
  minDelay: 500,
  maxDelay: 3000,
} as const satisfies EndpointingOptions;

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected _minDelay: number;
  protected _maxDelay: number;
  protected _overlapping = false;

  constructor({ minDelay, maxDelay }: Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
  }

  updateOptions({
    minDelay,
    maxDelay,
  }: Partial<Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>> = {}): void {
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

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-303 lines
export class DynamicEndpointing extends BaseEndpointing {
  private _utterancePause: ExpFilter;
  private _turnPause: ExpFilter;

  private _utteranceStartedAt: number | undefined;
  private _utteranceEndedAt: number | undefined;
  private _agentSpeechStartedAt: number | undefined;
  private _agentSpeechEndedAt: number | undefined;
  private _speaking = false;

  constructor(
    { minDelay, maxDelay }: Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>,
    alpha = 0.9,
  ) {
    super({ minDelay, maxDelay });

    this._utterancePause = new ExpFilter(alpha, {
      initial: minDelay,
      minValue: minDelay,
      maxValue: maxDelay,
    });
    this._turnPause = new ExpFilter(alpha, {
      initial: maxDelay,
      minValue: minDelay,
      maxValue: maxDelay,
    });
  }

  override get minDelay(): number {
    return this._utterancePause.value ?? this._minDelay;
  }

  override get maxDelay(): number {
    const turnValue = this._turnPause.value ?? this._maxDelay;
    return Math.max(turnValue, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this._utteranceEndedAt === undefined || this._utteranceStartedAt === undefined) {
      return 0;
    }

    return Math.max(0, this._utteranceStartedAt - this._utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this._agentSpeechStartedAt === undefined || this._utteranceEndedAt === undefined) {
      return 0;
    }

    return Math.max(0, this._agentSpeechStartedAt - this._utteranceEndedAt);
  }

  get immediateInterruptionDelay(): [number, number] {
    if (this._utteranceStartedAt === undefined || this._agentSpeechStartedAt === undefined) {
      return [0, 0];
    }

    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  override onStartOfAgentSpeech(startedAt: number): void {
    this._agentSpeechStartedAt = startedAt;
    this._agentSpeechEndedAt = undefined;
    this._overlapping = false;
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this._agentSpeechStartedAt !== undefined &&
      (this._agentSpeechEndedAt === undefined ||
        this._agentSpeechEndedAt < this._agentSpeechStartedAt)
    ) {
      this._agentSpeechEndedAt = endedAt;
    }
    this._overlapping = false;
  }

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this._overlapping) {
      return;
    }

    if (
      this._utteranceStartedAt !== undefined &&
      this._utteranceEndedAt !== undefined &&
      this._agentSpeechStartedAt !== undefined &&
      this._utteranceEndedAt < this._utteranceStartedAt &&
      overlapping
    ) {
      this._utteranceEndedAt = this._agentSpeechStartedAt - 1;
    }

    this._utteranceStartedAt = startedAt;
    this._overlapping = overlapping;
    this._speaking = true;
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this._overlapping) {
      if (
        this._utteranceStartedAt !== undefined &&
        this._agentSpeechStartedAt !== undefined &&
        Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        // Allow close-start overlap to count as real speech. Leading TTS silence can otherwise
        // make it look like a backchannel when the user simply started talking first.
      } else {
        this._overlapping = false;
        this._speaking = false;
        this._utteranceStartedAt = undefined;
        this._utteranceEndedAt = undefined;
        return;
      }
    }

    if (
      this._overlapping ||
      (this._agentSpeechStartedAt !== undefined && this._agentSpeechEndedAt === undefined)
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
        this._utterancePause.apply(1, utterancePause);
      } else {
        const turnPause = this.betweenTurnDelay;
        if (turnPause > 0) {
          this._turnPause.apply(1, turnPause);
        }
      }
    } else {
      const turnPause = this.betweenTurnDelay;
      if (turnPause > 0) {
        this._turnPause.apply(1, turnPause);
      } else {
        const utterancePause = this.betweenUtteranceDelay;
        if (
          utterancePause > 0 &&
          this._agentSpeechEndedAt === undefined &&
          this._agentSpeechStartedAt === undefined
        ) {
          this._utterancePause.apply(1, utterancePause);
        }
      }
    }

    this._utteranceEndedAt = endedAt;
    this._agentSpeechStartedAt = undefined;
    this._agentSpeechEndedAt = undefined;
    this._speaking = false;
    this._overlapping = false;
  }

  override updateOptions({
    minDelay,
    maxDelay,
  }: Partial<Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>> = {}): void {
    if (minDelay !== undefined) {
      this._minDelay = minDelay;
      this._utterancePause.reset({ initial: this._minDelay, minValue: this._minDelay });
      this._turnPause.reset({ minValue: this._minDelay });
    }

    if (maxDelay !== undefined) {
      this._maxDelay = maxDelay;
      this._turnPause.reset({ initial: this._maxDelay, maxValue: this._maxDelay });
      this._utterancePause.reset({ maxValue: this._maxDelay });
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  if (options.mode === 'dynamic') {
    return new DynamicEndpointing({
      minDelay: options.minDelay,
      maxDelay: options.maxDelay,
    });
  }

  return new BaseEndpointing({
    minDelay: options.minDelay,
    maxDelay: options.maxDelay,
  });
}
