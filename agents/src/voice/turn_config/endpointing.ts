// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import { NOT_GIVEN, type NotGivenOr } from '../../types.js';
import { ExpFilter, isGiven } from '../../utils.js';

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

// Ref: python livekit-agents/livekit/agents/voice/turn.py - 47-66 lines
/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
export interface EndpointingOptions {
  /**
   * Endpointing mode. `"fixed"` uses a fixed delay, `"dynamic"` adjusts delay based on speech
   * activity.
   * @defaultValue "fixed"
   */
  mode: 'fixed' | 'dynamic';
  /**
   * Minimum time in milliseconds since the last detected speech before the agent declares the user's
   * turn complete. In VAD mode this effectively behaves like `max(VAD silence, minDelay)`;
   * in STT mode it is applied after the STT provider's endpointing delay.
   * @defaultValue 500
   */
  minDelay: number;
  /**
   * Maximum time in milliseconds the agent will wait before terminating the turn.
   * @defaultValue 3000
   */
  maxDelay: number;
  /**
   * Exponential moving average coefficient for dynamic endpointing.
   * @defaultValue 0.9
   */
  alpha: number;
}

// Ref: python livekit-agents/livekit/agents/voice/turn.py - 69-74 lines
export const defaultEndpointingOptions = {
  mode: 'fixed',
  minDelay: 500,
  maxDelay: 3000,
  alpha: 0.9,
} as const satisfies EndpointingOptions;

type BaseEndpointingUpdateOptions = {
  minDelay?: NotGivenOr<number>;
  maxDelay?: NotGivenOr<number>;
};

type DynamicEndpointingUpdateOptions = BaseEndpointingUpdateOptions & {
  alpha?: NotGivenOr<number>;
};

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected _minDelay: number;
  protected _maxDelay: number;
  protected _overlapping = false;

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 11-14 lines
  constructor(minDelay: number, maxDelay: number) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 16-22 lines
  updateOptions({
    minDelay = NOT_GIVEN,
    maxDelay = NOT_GIVEN,
  }: BaseEndpointingUpdateOptions = {}): void {
    if (isGiven(minDelay)) {
      this._minDelay = minDelay;
    }
    if (isGiven(maxDelay)) {
      this._maxDelay = maxDelay;
    }
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 24-30 lines
  get minDelay(): number {
    return this._minDelay;
  }

  get maxDelay(): number {
    return this._maxDelay;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 32-34 lines
  get overlapping(): boolean {
    return this._overlapping;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 36-40 lines
  onStartOfSpeech(startedAt: number, overlapping = false): void {
    void startedAt;
    this._overlapping = overlapping;
  }

  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    void endedAt;
    void shouldIgnore;
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 42-46 lines
  onStartOfAgentSpeech(startedAt: number): void {
    void startedAt;
  }

  onEndOfAgentSpeech(endedAt: number): void {
    void endedAt;
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-90 lines
export class DynamicEndpointing extends BaseEndpointing {
  private _utterancePause: ExpFilter;
  private _turnPause: ExpFilter;
  private _utteranceStartedAt: number | undefined;
  private _utteranceEndedAt: number | undefined;
  private _agentSpeechStartedAt: number | undefined;
  private _agentSpeechEndedAt: number | undefined;
  private _speaking = false;

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 50-90 lines
  constructor(minDelay: number, maxDelay: number, alpha = 0.9) {
    super(minDelay, maxDelay);

    this._utterancePause = new ExpFilter(alpha, maxDelay, minDelay, minDelay);
    this._turnPause = new ExpFilter(alpha, maxDelay, minDelay, maxDelay);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 91-102 lines
  override get minDelay(): number {
    return this._utterancePause.value ?? this._minDelay;
  }

  override get maxDelay(): number {
    const turnVal = this._turnPause.value ?? this._maxDelay;
    return Math.max(turnVal, this.minDelay);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 104-120 lines
  get betweenUtteranceDelay(): number {
    if (this._utteranceEndedAt === undefined) {
      return 0.0;
    }
    if (this._utteranceStartedAt === undefined) {
      return 0.0;
    }

    return Math.max(0, this._utteranceStartedAt - this._utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this._agentSpeechStartedAt === undefined) {
      return 0.0;
    }
    if (this._utteranceEndedAt === undefined) {
      return 0.0;
    }

    return Math.max(0, this._agentSpeechStartedAt - this._utteranceEndedAt);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 122-137 lines
  get immediateInterruptionDelay(): [number, number] {
    if (this._utteranceStartedAt === undefined) {
      return [0.0, 0.0];
    }
    if (this._agentSpeechStartedAt === undefined) {
      return [0.0, 0.0];
    }

    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 139-153 lines
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

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 155-178 lines
  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 156-158 lines
    if (this._overlapping) {
      return;
    }

    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 160-173 lines
    if (
      this._utteranceStartedAt !== undefined &&
      this._utteranceEndedAt !== undefined &&
      this._agentSpeechStartedAt !== undefined &&
      this._utteranceEndedAt < this._utteranceStartedAt &&
      overlapping
    ) {
      this._utteranceEndedAt = this._agentSpeechStartedAt - 1;
      log().trace({ utteranceEndedAt: this._utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this._utteranceStartedAt = startedAt;
    this._overlapping = overlapping;
    this._speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-287 lines
  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 180-203 lines
    if (shouldIgnore && this._overlapping) {
      if (
        this._utteranceStartedAt !== undefined &&
        this._agentSpeechStartedAt !== undefined &&
        Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        log().trace(
          {
            delay: Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true: user speech started within grace period of agent speech',
        );
      } else {
        this._overlapping = false;
        this._speaking = false;
        this._utteranceStartedAt = undefined;
        this._utteranceEndedAt = undefined;
        return;
      }
    }

    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 205-247 lines
    if (
      this._overlapping ||
      (this._agentSpeechStartedAt !== undefined && this._agentSpeechEndedAt === undefined)
    ) {
      const [turnDelay, interruptionDelay] = this.immediateInterruptionDelay;
      const pause = this.betweenUtteranceDelay;
      // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 208-229 lines
      if (
        0 < interruptionDelay &&
        interruptionDelay <= this.minDelay &&
        0 < turnDelay &&
        turnDelay <= this.maxDelay &&
        pause > 0
      ) {
        const prevVal = this.minDelay;
        this._utterancePause.apply(1.0, pause);
        log().debug(
          {
            reason: 'immediate interruption',
            pause,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${prevVal} -> ${this.minDelay}`,
        );
      } else {
        // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 230-246 lines
        const turnPause = this.betweenTurnDelay;
        if (turnPause > 0) {
          const prevVal = this.maxDelay;
          this._turnPause.apply(1.0, turnPause);
          log().debug(
            {
              reason: 'new turn (interruption)',
              pause: turnPause,
              maxDelay: this.maxDelay,
              minDelay: this.minDelay,
              betweenUtteranceDelay: this.betweenUtteranceDelay,
              betweenTurnDelay: this.betweenTurnDelay,
            },
            `max endpointing delay updated: ${prevVal} -> ${this.maxDelay}`,
          );
        }
      }
    } else {
      // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 248-280 lines
      const turnPause = this.betweenTurnDelay;
      const utterancePause = this.betweenUtteranceDelay;
      if (turnPause > 0) {
        const prevVal = this.maxDelay;
        this._turnPause.apply(1.0, turnPause);
        log().debug(
          {
            reason: 'new turn',
            pause: turnPause,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `max endpointing delay updated due to pause: ${prevVal} -> ${this.maxDelay}`,
        );
      } else if (
        utterancePause > 0 &&
        this._agentSpeechEndedAt === undefined &&
        this._agentSpeechStartedAt === undefined
      ) {
        const prevVal = this.minDelay;
        this._utterancePause.apply(1.0, utterancePause);
        log().debug(
          {
            reason: 'pause between utterances',
            pause: utterancePause,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${prevVal} -> ${this.minDelay}`,
        );
      }
    }

    this._utteranceEndedAt = endedAt;
    this._agentSpeechStartedAt = undefined;
    this._agentSpeechEndedAt = undefined;
    this._speaking = false;
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 288-307 lines
  override updateOptions({
    minDelay = NOT_GIVEN,
    maxDelay = NOT_GIVEN,
    alpha = NOT_GIVEN,
  }: DynamicEndpointingUpdateOptions = {}): void {
    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 295-299 lines
    if (isGiven(minDelay)) {
      this._minDelay = minDelay;
      this._utterancePause.reset(NOT_GIVEN, this._minDelay, this._minDelay);
      this._turnPause.reset(NOT_GIVEN, NOT_GIVEN, this._minDelay);
    }

    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 300-303 lines
    if (isGiven(maxDelay)) {
      this._maxDelay = maxDelay;
      this._turnPause.reset(NOT_GIVEN, this._maxDelay, NOT_GIVEN, this._maxDelay);
      this._utterancePause.reset(NOT_GIVEN, NOT_GIVEN, NOT_GIVEN, this._maxDelay);
    }

    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-307 lines
    if (isGiven(alpha)) {
      this._utterancePause.reset(alpha);
      this._turnPause.reset(alpha);
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 310-322 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  switch (options.mode) {
    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 312-317 lines
    case 'dynamic':
      return new DynamicEndpointing(options.minDelay, options.maxDelay, options.alpha);
    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 318-322 lines
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
