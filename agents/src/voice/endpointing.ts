// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const logger = log();

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250; // 0.25s -> 250ms

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-46 lines
export class BaseEndpointing {
  protected _minDelay: number;
  protected _maxDelay: number;
  protected _overlapping: boolean;

  constructor(minDelay: number, maxDelay: number) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
    this._overlapping = false;
  }

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

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this._overlapping = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this._overlapping = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {
    void _startedAt;
  }

  onEndOfAgentSpeech(_endedAt: number): void {
    void _endedAt;
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-302 lines
export class DynamicEndpointing extends BaseEndpointing {
  private _utterancePause: ExpFilter;
  private _turnPause: ExpFilter;
  private _utteranceStartedAt: number | undefined;
  private _utteranceEndedAt: number | undefined;
  private _agentSpeechStartedAt: number | undefined;
  private _agentSpeechEndedAt: number | undefined;
  private _speaking: boolean;

  constructor(minDelay: number, maxDelay: number, alpha = 0.9) {
    super(minDelay, maxDelay);

    this._utterancePause = new ExpFilter(alpha, {
      initial: minDelay,
      min: minDelay,
      max: maxDelay,
    });
    this._turnPause = new ExpFilter(alpha, {
      initial: maxDelay,
      min: minDelay,
      max: maxDelay,
    });

    this._utteranceStartedAt = undefined;
    this._utteranceEndedAt = undefined;
    this._agentSpeechStartedAt = undefined;
    this._agentSpeechEndedAt = undefined;
    this._speaking = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 91-102 lines
  override get minDelay(): number {
    return this._utterancePause.value ?? super.minDelay;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 91-102 lines
  override get maxDelay(): number {
    const turnValue = this._turnPause.value ?? super.maxDelay;
    return Math.max(turnValue, this.minDelay);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 104-111 lines
  get betweenUtteranceDelay(): number {
    if (this._utteranceEndedAt === undefined || this._utteranceStartedAt === undefined) {
      return 0;
    }

    return Math.max(0, this._utteranceStartedAt - this._utteranceEndedAt);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 113-120 lines
  get betweenTurnDelay(): number {
    if (this._agentSpeechStartedAt === undefined || this._utteranceEndedAt === undefined) {
      return 0;
    }

    return Math.max(0, this._agentSpeechStartedAt - this._utteranceEndedAt);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 122-137 lines
  get immediateInterruptionDelay(): [number, number] {
    if (this._utteranceStartedAt === undefined || this._agentSpeechStartedAt === undefined) {
      return [0, 0];
    }

    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 139-142 lines
  override onStartOfAgentSpeech(startedAt: number): void {
    this._agentSpeechStartedAt = startedAt;
    this._agentSpeechEndedAt = undefined;
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 144-153 lines
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

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 155-177 lines
  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.overlapping) {
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

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-286 lines
  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this.overlapping) {
      if (
        this._utteranceStartedAt !== undefined &&
        this._agentSpeechStartedAt !== undefined &&
        Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        logger.trace(
          {
            overlapSinceAgentStart: Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true within grace period',
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
      this.overlapping ||
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
        const previousValue = this.minDelay;
        this._utterancePause.apply(1, utterancePause);
        logger.debug(
          {
            reason: 'immediate interruption',
            previousValue,
            minDelay: this.minDelay,
            maxDelay: this.maxDelay,
            pause: utterancePause,
            interruptionDelay,
            turnDelay,
          },
          'min endpointing delay updated',
        );
      } else {
        const turnPause = this.betweenTurnDelay;
        if (turnPause > 0) {
          const previousValue = this.maxDelay;
          this._turnPause.apply(1, turnPause);
          logger.debug(
            {
              reason: 'new turn (interruption)',
              previousValue,
              minDelay: this.minDelay,
              maxDelay: this.maxDelay,
              pause: turnPause,
              betweenUtteranceDelay: this.betweenUtteranceDelay,
              betweenTurnDelay: this.betweenTurnDelay,
            },
            'max endpointing delay updated',
          );
        }
      }
    } else {
      const turnPause = this.betweenTurnDelay;
      if (turnPause > 0) {
        const previousValue = this.maxDelay;
        this._turnPause.apply(1, turnPause);
        logger.debug(
          {
            reason: 'new turn',
            previousValue,
            minDelay: this.minDelay,
            maxDelay: this.maxDelay,
            pause: turnPause,
          },
          'max endpointing delay updated due to pause',
        );
      } else {
        const utterancePause = this.betweenUtteranceDelay;
        if (
          utterancePause > 0 &&
          this._agentSpeechEndedAt === undefined &&
          this._agentSpeechStartedAt === undefined
        ) {
          const previousValue = this.minDelay;
          this._utterancePause.apply(1, utterancePause);
          logger.debug(
            {
              reason: 'pause between utterances',
              previousValue,
              minDelay: this.minDelay,
              maxDelay: this.maxDelay,
              pause: utterancePause,
            },
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

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 288-302 lines
  override updateOptions({
    minDelay,
    maxDelay,
  }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this._minDelay = minDelay;
      this._utterancePause.reset({ initial: this._minDelay, min: this._minDelay });
      this._turnPause.reset({ min: this._minDelay });
    }

    if (maxDelay !== undefined) {
      this._maxDelay = maxDelay;
      this._turnPause.reset({ initial: this._maxDelay, max: this._maxDelay });
      this._utterancePause.reset({ max: this._maxDelay });
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  switch (options.mode) {
    case 'dynamic':
      return new DynamicEndpointing(options.minDelay, options.maxDelay);
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
