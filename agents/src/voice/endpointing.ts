// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250; // 0.25s -> 250ms

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected minDelayValue: number;
  protected maxDelayValue: number;
  protected overlappingState = false;

  constructor(minDelay: number, maxDelay: number) {
    this.minDelayValue = minDelay;
    this.maxDelayValue = maxDelay;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 16-22 lines
  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number }): void {
    if (minDelay !== undefined) {
      this.minDelayValue = minDelay;
    }
    if (maxDelay !== undefined) {
      this.maxDelayValue = maxDelay;
    }
  }

  get minDelay(): number {
    return this.minDelayValue;
  }

  get maxDelay(): number {
    return this.maxDelayValue;
  }

  get overlapping(): boolean {
    return this.overlappingState;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 36-40 lines
  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this.overlappingState = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this.overlappingState = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-304 lines
export class DynamicEndpointing extends BaseEndpointing {
  private logger = log();
  private utterancePause: ExpFilter;
  private turnPause: ExpFilter;
  private utteranceStartedAt: number | undefined;
  private utteranceEndedAt: number | undefined;
  private agentSpeechStartedAt: number | undefined;
  private agentSpeechEndedAt: number | undefined;
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

  get minDelay(): number {
    return this.utterancePause.value ?? this.minDelayValue;
  }

  get maxDelay(): number {
    const turnValue = this.turnPause.value ?? this.maxDelayValue;
    return Math.max(turnValue, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this.utteranceEndedAt === undefined || this.utteranceStartedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.utteranceStartedAt - this.utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this.agentSpeechStartedAt === undefined || this.utteranceEndedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.agentSpeechStartedAt - this.utteranceEndedAt);
  }

  get immediateInterruptionDelay(): [number, number] {
    if (this.utteranceStartedAt === undefined || this.agentSpeechStartedAt === undefined) {
      return [0, 0];
    }

    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 139-143 lines
  onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt = startedAt;
    this.agentSpeechEndedAt = undefined;
    this.overlappingState = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 144-153 lines
  onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }
    this.overlappingState = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 155-177 lines
  onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.overlappingState) {
      return;
    }

    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 160-173 lines
    if (
      this.utteranceStartedAt !== undefined &&
      this.utteranceEndedAt !== undefined &&
      this.agentSpeechStartedAt !== undefined &&
      this.utteranceEndedAt < this.utteranceStartedAt &&
      overlapping
    ) {
      this.utteranceEndedAt = this.agentSpeechStartedAt - 1e-3;
      this.logger.trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.overlappingState = overlapping;
    this.speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-286 lines
  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 180-203 lines
    if (shouldIgnore && this.overlappingState) {
      if (
        this.utteranceStartedAt !== undefined &&
        this.agentSpeechStartedAt !== undefined &&
        Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        this.logger.trace(
          {
            delay: Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true within grace period',
        );
      } else {
        this.overlappingState = false;
        this.speaking = false;
        this.utteranceStartedAt = undefined;
        this.utteranceEndedAt = undefined;
        return;
      }
    }

    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 205-247 lines
    if (
      this.overlappingState ||
      (this.agentSpeechStartedAt !== undefined && this.agentSpeechEndedAt === undefined)
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
        this.utterancePause.apply(1, pause);
      } else {
        const delayedPause = this.betweenTurnDelay;
        if (delayedPause > 0) {
          this.turnPause.apply(1, delayedPause);
        }
      }
    } else {
      // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 248-280 lines
      const turnPause = this.betweenTurnDelay;
      if (turnPause > 0) {
        this.turnPause.apply(1, turnPause);
      } else {
        const utterancePause = this.betweenUtteranceDelay;
        if (
          utterancePause > 0 &&
          this.agentSpeechEndedAt === undefined &&
          this.agentSpeechStartedAt === undefined
        ) {
          this.utterancePause.apply(1, utterancePause);
        }
      }
    }

    this.utteranceEndedAt = endedAt;
    this.agentSpeechStartedAt = undefined;
    this.agentSpeechEndedAt = undefined;
    this.speaking = false;
    this.overlappingState = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 288-302 lines
  override updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number }): void {
    if (minDelay !== undefined) {
      this.minDelayValue = minDelay;
      this.utterancePause.reset({ initial: this.minDelayValue, min: this.minDelayValue });
      this.turnPause.reset({ min: this.minDelayValue });
    }

    if (maxDelay !== undefined) {
      this.maxDelayValue = maxDelay;
      this.turnPause.reset({ initial: this.maxDelayValue, max: this.maxDelayValue });
      this.utterancePause.reset({ max: this.maxDelayValue });
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  if (options.mode === 'dynamic') {
    return new DynamicEndpointing(options.minDelay, options.maxDelay);
  }

  return new BaseEndpointing(options.minDelay, options.maxDelay);
}
