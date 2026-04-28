// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  _minDelay: number;
  _maxDelay: number;
  _overlapping = false;

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 11-14 lines
  constructor(minDelay: number, maxDelay: number) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
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

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 24-34 lines
  get minDelay(): number {
    return this._minDelay;
  }

  get maxDelay(): number {
    return this._maxDelay;
  }

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

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-307 lines
export class DynamicEndpointing extends BaseEndpointing {
  _utterancePause: ExpFilter;
  _turnPause: ExpFilter;
  _utteranceStartedAt: number | undefined;
  _utteranceEndedAt: number | undefined;
  _agentSpeechStartedAt: number | undefined;
  _agentSpeechEndedAt: number | undefined;
  _speaking = false;

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 50-90 lines
  constructor(minDelay: number, maxDelay: number, alpha = 0.9) {
    super(minDelay, maxDelay);

    this._utterancePause = new ExpFilter(alpha, maxDelay, minDelay, minDelay);
    this._turnPause = new ExpFilter(alpha, maxDelay, minDelay, maxDelay);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 91-137 lines
  override get minDelay(): number {
    return this._utterancePause.value ?? this._minDelay;
  }

  override get maxDelay(): number {
    const turnVal = this._turnPause.value ?? this._maxDelay;
    return Math.max(turnVal, this.minDelay);
  }

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
      log().trace({ utteranceEndedAt: this._utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this._utteranceStartedAt = startedAt;
    this._overlapping = overlapping;
    this._speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-287 lines
  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this._overlapping) {
      if (
        this._utteranceStartedAt !== undefined &&
        this._agentSpeechStartedAt !== undefined &&
        Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        log().trace(
          {
            speechOffset: Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt),
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

    if (
      this._overlapping ||
      (this._agentSpeechStartedAt !== undefined && this._agentSpeechEndedAt === undefined)
    ) {
      const [turnDelay, interruptionDelay] = this.immediateInterruptionDelay;
      const utterancePause = this.betweenUtteranceDelay;
      if (
        0 < interruptionDelay &&
        interruptionDelay <= this.minDelay &&
        0 < turnDelay &&
        turnDelay <= this.maxDelay &&
        utterancePause > 0
      ) {
        const prevVal = this.minDelay;
        this._utterancePause.apply(1.0, utterancePause);
        log().debug(
          {
            reason: 'immediate interruption',
            pause: utterancePause,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${prevVal} -> ${this.minDelay}`,
        );
      } else {
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
      const turnPause = this.betweenTurnDelay;
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
      } else {
        const utterancePause = this.betweenUtteranceDelay;
        if (
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
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
