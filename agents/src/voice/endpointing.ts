// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250; // 0.25s -> 250ms

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-46 lines
export class BaseEndpointing {
  protected minDelayValue: number;
  protected maxDelayValue: number;
  protected overlappingValue = false;

  constructor(minDelay: number, maxDelay: number) {
    this.minDelayValue = minDelay;
    this.maxDelayValue = maxDelay;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 16-22 lines
  updateOptions(options: Partial<Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>> = {}): void {
    this.minDelayValue = options.minDelay ?? this.minDelayValue;
    this.maxDelayValue = options.maxDelay ?? this.maxDelayValue;
  }

  get minDelay(): number {
    return this.minDelayValue;
  }

  get maxDelay(): number {
    return this.maxDelayValue;
  }

  get overlapping(): boolean {
    return this.overlappingValue;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 36-40 lines
  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this.overlappingValue = overlapping;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 39-40 lines
  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this.overlappingValue = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-302 lines
export class DynamicEndpointing extends BaseEndpointing {
  private logger = log();
  private utterancePause: ExpFilter;
  private turnPause: ExpFilter;
  private utteranceStartedAt?: number;
  private utteranceEndedAt?: number;
  private agentSpeechStartedAt?: number;
  private agentSpeechEndedAt?: number;
  private speaking = false;

  constructor(minDelay: number, maxDelay: number, alpha = 0.9) {
    super(minDelay, maxDelay);
    this.utterancePause = new ExpFilter(alpha, {
      initial: minDelay,
      min: minDelay,
      max: maxDelay,
    });
    this.turnPause = new ExpFilter(alpha, {
      initial: maxDelay,
      min: minDelay,
      max: maxDelay,
    });
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 91-102 lines
  override get minDelay(): number {
    return this.utterancePause.value ?? this.minDelayValue;
  }

  override get maxDelay(): number {
    return Math.max(this.turnPause.value ?? this.maxDelayValue, this.minDelay);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 105-120 lines
  get betweenUtteranceDelay(): number {
    if (this.utteranceEndedAt === undefined || this.utteranceStartedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.utteranceStartedAt - this.utteranceEndedAt);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 114-120 lines
  get betweenTurnDelay(): number {
    if (this.agentSpeechStartedAt === undefined || this.utteranceEndedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.agentSpeechStartedAt - this.utteranceEndedAt);
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 123-137 lines
  get immediateInterruptionDelay(): [number, number] {
    if (this.utteranceStartedAt === undefined || this.agentSpeechStartedAt === undefined) {
      return [0, 0];
    }

    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 139-153 lines
  override onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt = startedAt;
    this.agentSpeechEndedAt = undefined;
    this.overlappingValue = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 144-153 lines
  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }
    this.overlappingValue = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 155-177 lines
  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.overlappingValue) {
      return;
    }

    if (
      this.utteranceStartedAt !== undefined &&
      this.utteranceEndedAt !== undefined &&
      this.agentSpeechStartedAt !== undefined &&
      this.utteranceEndedAt < this.utteranceStartedAt &&
      overlapping
    ) {
      this.utteranceEndedAt = this.agentSpeechStartedAt - 1; // 0.001s -> 1ms
      this.logger.trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.overlappingValue = overlapping;
    this.speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-287 lines
  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this.overlappingValue) {
      if (
        this.utteranceStartedAt !== undefined &&
        this.agentSpeechStartedAt !== undefined &&
        Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        this.logger.trace(
          {
            overlapMs: Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt),
            gracePeriodMs: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true within agent speech grace period',
        );
      } else {
        this.overlappingValue = false;
        this.speaking = false;
        this.utteranceStartedAt = undefined;
        this.utteranceEndedAt = undefined;
        return;
      }
    }

    if (
      this.overlappingValue ||
      (this.agentSpeechStartedAt !== undefined && this.agentSpeechEndedAt === undefined)
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
        const previousMinDelay = this.minDelay;
        this.utterancePause.apply(1, utterancePause);
        this.logger.debug(
          {
            reason: 'immediate interruption',
            pause: utterancePause,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${previousMinDelay} -> ${this.minDelay}`,
        );
      } else {
        const turnPause = this.betweenTurnDelay;
        if (turnPause > 0) {
          const previousMaxDelay = this.maxDelay;
          this.turnPause.apply(1, turnPause);
          this.logger.debug(
            {
              reason: 'new turn (interruption)',
              pause: turnPause,
              maxDelay: this.maxDelay,
              minDelay: this.minDelay,
              betweenUtteranceDelay: this.betweenUtteranceDelay,
              betweenTurnDelay: this.betweenTurnDelay,
            },
            `max endpointing delay updated: ${previousMaxDelay} -> ${this.maxDelay}`,
          );
        }
      }
    } else {
      const turnPause = this.betweenTurnDelay;
      if (turnPause > 0) {
        const previousMaxDelay = this.maxDelay;
        this.turnPause.apply(1, turnPause);
        this.logger.debug(
          {
            reason: 'new turn',
            pause: turnPause,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `max endpointing delay updated due to pause: ${previousMaxDelay} -> ${this.maxDelay}`,
        );
      } else {
        const utterancePause = this.betweenUtteranceDelay;
        if (
          utterancePause > 0 &&
          this.agentSpeechEndedAt === undefined &&
          this.agentSpeechStartedAt === undefined
        ) {
          const previousMinDelay = this.minDelay;
          this.utterancePause.apply(1, utterancePause);
          this.logger.debug(
            {
              reason: 'pause between utterances',
              pause: utterancePause,
              maxDelay: this.maxDelay,
              minDelay: this.minDelay,
            },
            `min endpointing delay updated: ${previousMinDelay} -> ${this.minDelay}`,
          );
        }
      }
    }

    this.utteranceEndedAt = endedAt;
    this.agentSpeechStartedAt = undefined;
    this.agentSpeechEndedAt = undefined;
    this.speaking = false;
    this.overlappingValue = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 288-302 lines
  override updateOptions(
    options: Partial<Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>> = {},
  ): void {
    if (options.minDelay !== undefined) {
      this.minDelayValue = options.minDelay;
      this.utterancePause.reset({ initial: this.minDelayValue, min: this.minDelayValue });
      this.turnPause.reset({ min: this.minDelayValue });
    }

    if (options.maxDelay !== undefined) {
      this.maxDelayValue = options.maxDelay;
      this.turnPause.reset({ initial: this.maxDelayValue, max: this.maxDelayValue });
      this.utterancePause.reset({ max: this.maxDelayValue });
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  switch (options.mode) {
    case 'dynamic':
      return new DynamicEndpointing(options.minDelay, options.maxDelay);
    case 'fixed':
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
