// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const logger = log();

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected _minDelay: number;
  protected _maxDelay: number;
  protected _overlapping: boolean;

  constructor(minDelay: number, maxDelay: number) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 16-22 lines
  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
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

  onStartOfSpeech(startedAt: number, overlapping: boolean = false): void {
    void startedAt;
    this._overlapping = overlapping;
  }

  onEndOfSpeech(endedAt: number, shouldIgnore: boolean = false): void {
    void endedAt;
    void shouldIgnore;
    this._overlapping = false;
  }

  onStartOfAgentSpeech(startedAt: number): void {
    void startedAt;
  }

  onEndOfAgentSpeech(endedAt: number): void {
    void endedAt;
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-89 lines
export class DynamicEndpointing extends BaseEndpointing {
  private _utterancePause: ExpFilter;
  private _turnPause: ExpFilter;
  private _utteranceStartedAt?: number;
  private _utteranceEndedAt?: number;
  private _agentSpeechStartedAt?: number;
  private _agentSpeechEndedAt?: number;
  private _speaking: boolean;

  constructor(minDelay: number, maxDelay: number, alpha: number = 0.9) {
    super(minDelay, maxDelay);

    this._utterancePause = new ExpFilter(alpha, maxDelay, minDelay, minDelay);
    this._turnPause = new ExpFilter(alpha, maxDelay, minDelay, maxDelay);

    this._utteranceStartedAt = undefined;
    this._utteranceEndedAt = undefined;
    this._agentSpeechStartedAt = undefined;
    this._agentSpeechEndedAt = undefined;
    this._speaking = false;
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
      return 0;
    }
    if (this._utteranceStartedAt === undefined) {
      return 0;
    }

    return Math.max(0, this._utteranceStartedAt - this._utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this._agentSpeechStartedAt === undefined) {
      return 0;
    }
    if (this._utteranceEndedAt === undefined) {
      return 0;
    }

    return Math.max(0, this._agentSpeechStartedAt - this._utteranceEndedAt);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 122-137 lines
  get immediateInterruptionDelay(): [number, number] {
    if (this._utteranceStartedAt === undefined) {
      return [0, 0];
    }
    if (this._agentSpeechStartedAt === undefined) {
      return [0, 0];
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
  override onStartOfSpeech(startedAt: number, overlapping: boolean = false): void {
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
      logger.trace({ utteranceEndedAt: this._utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this._utteranceStartedAt = startedAt;
    this._overlapping = overlapping;
    this._speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-287 lines
  override onEndOfSpeech(endedAt: number, shouldIgnore: boolean = false): void {
    if (shouldIgnore && this._overlapping) {
      if (
        this._utteranceStartedAt !== undefined &&
        this._agentSpeechStartedAt !== undefined &&
        Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        logger.trace(
          {
            delay: Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true within agent speech leading silence grace period',
        );
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
      let pause = this.betweenUtteranceDelay;
      if (
        0 < interruptionDelay &&
        interruptionDelay <= this.minDelay &&
        0 < turnDelay &&
        turnDelay <= this.maxDelay &&
        pause > 0
      ) {
        const prevVal = this.minDelay;
        this._utterancePause.apply(1, pause);
        logger.debug(
          {
            previous: prevVal,
            minDelay: this.minDelay,
            maxDelay: this.maxDelay,
            pause,
            interruptionDelay,
            turnDelay,
            reason: 'immediate interruption',
          },
          'min endpointing delay updated',
        );
      } else {
        pause = this.betweenTurnDelay;
        if (pause > 0) {
          const prevVal = this.maxDelay;
          this._turnPause.apply(1, pause);
          logger.debug(
            {
              previous: prevVal,
              minDelay: this.minDelay,
              maxDelay: this.maxDelay,
              pause,
              betweenUtteranceDelay: this.betweenUtteranceDelay,
              betweenTurnDelay: this.betweenTurnDelay,
              reason: 'new turn (interruption)',
            },
            'max endpointing delay updated',
          );
        }
      }
    } else {
      let pause = this.betweenTurnDelay;
      if (pause > 0) {
        const prevVal = this.maxDelay;
        this._turnPause.apply(1, pause);
        logger.debug(
          { previous: prevVal, minDelay: this.minDelay, maxDelay: this.maxDelay, pause },
          'max endpointing delay updated due to pause',
        );
      } else {
        pause = this.betweenUtteranceDelay;
        if (
          pause > 0 &&
          this._agentSpeechEndedAt === undefined &&
          this._agentSpeechStartedAt === undefined
        ) {
          const prevVal = this.minDelay;
          this._utterancePause.apply(1, pause);
          logger.debug(
            { previous: prevVal, minDelay: this.minDelay, maxDelay: this.maxDelay, pause },
            'min endpointing delay updated',
          );
        }
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
    minDelay,
    maxDelay,
    alpha,
  }: {
    minDelay?: number;
    maxDelay?: number;
    alpha?: number;
  } = {}): void {
    if (minDelay !== undefined) {
      this._minDelay = minDelay;
      this._utterancePause.reset(undefined, this._minDelay, this._minDelay);
      this._turnPause.reset(undefined, undefined, this._minDelay);
    }

    if (maxDelay !== undefined) {
      this._maxDelay = maxDelay;
      this._turnPause.reset(undefined, this._maxDelay, undefined, this._maxDelay);
      this._utterancePause.reset(undefined, undefined, undefined, this._maxDelay);
    }

    if (alpha !== undefined) {
      this._utterancePause.reset(alpha);
      this._turnPause.reset(alpha);
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 310-322 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  switch (options.mode) {
    case 'dynamic':
      return new DynamicEndpointing(options.minDelay, options.maxDelay, options.alpha);
    case 'fixed':
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
