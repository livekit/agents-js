// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250; // 0.25s -> 250ms

const logger = log();

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-46 lines
export class BaseEndpointing {
  protected minDelayValue: number;
  protected maxDelayValue: number;
  protected overlapping = false;

  constructor(minDelay: number, maxDelay: number) {
    this.minDelayValue = minDelay;
    this.maxDelayValue = maxDelay;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 16-22 lines
  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
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

  get isOverlapping(): boolean {
    return this.overlapping;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 36-37 lines
  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this.overlapping = overlapping;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 39-40 lines
  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this.overlapping = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-304 lines
export class DynamicEndpointing extends BaseEndpointing {
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

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 139-142 lines
  override onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt = startedAt;
    this.agentSpeechEndedAt = undefined;
    this.overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 144-153 lines
  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }

    this.overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 155-177 lines
  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.overlapping) {
      return;
    }

    if (
      this.utteranceStartedAt !== undefined &&
      this.utteranceEndedAt !== undefined &&
      this.agentSpeechStartedAt !== undefined &&
      this.utteranceEndedAt < this.utteranceStartedAt &&
      overlapping
    ) {
      this.utteranceEndedAt = this.agentSpeechStartedAt - 1; // 1e-3s -> 1ms
      logger.trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.overlapping = overlapping;
    this.speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-286 lines
  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this.overlapping) {
      if (
        this.utteranceStartedAt !== undefined &&
        this.agentSpeechStartedAt !== undefined &&
        Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        logger.trace(
          {
            overlapDelay: Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true: user speech started within grace period of agent speech',
        );
      } else {
        this.overlapping = false;
        this.speaking = false;
        this.utteranceStartedAt = undefined;
        this.utteranceEndedAt = undefined;
        return;
      }
    }

    if (
      this.overlapping ||
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
        const previousValue = this.minDelay;
        this.utterancePause.apply(1, pause);
        logger.debug(
          {
            reason: 'immediate interruption',
            pause,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${previousValue} -> ${this.minDelay}`,
        );
      } else if (this.betweenTurnDelay > 0) {
        const previousValue = this.maxDelay;
        this.turnPause.apply(1, this.betweenTurnDelay);
        logger.debug(
          {
            reason: 'new turn (interruption)',
            pause: this.betweenTurnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
            betweenUtteranceDelay: this.betweenUtteranceDelay,
            betweenTurnDelay: this.betweenTurnDelay,
          },
          `max endpointing delay updated: ${previousValue} -> ${this.maxDelay}`,
        );
      }
    } else if (this.betweenTurnDelay > 0) {
      const previousValue = this.maxDelay;
      this.turnPause.apply(1, this.betweenTurnDelay);
      logger.debug(
        {
          reason: 'new turn',
          pause: this.betweenTurnDelay,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        `max endpointing delay updated due to pause: ${previousValue} -> ${this.maxDelay}`,
      );
    } else if (
      this.betweenUtteranceDelay > 0 &&
      this.agentSpeechEndedAt === undefined &&
      this.agentSpeechStartedAt === undefined
    ) {
      const previousValue = this.minDelay;
      this.utterancePause.apply(1, this.betweenUtteranceDelay);
      logger.debug(
        {
          reason: 'pause between utterances',
          pause: this.betweenUtteranceDelay,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        `min endpointing delay updated: ${previousValue} -> ${this.minDelay}`,
      );
    }

    this.utteranceEndedAt = endedAt;
    this.agentSpeechStartedAt = undefined;
    this.agentSpeechEndedAt = undefined;
    this.speaking = false;
    this.overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 288-302 lines
  override updateOptions({
    minDelay,
    maxDelay,
  }: { minDelay?: number; maxDelay?: number } = {}): void {
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
  switch (options.mode ?? 'fixed') {
    case 'dynamic':
      return new DynamicEndpointing(options.minDelay, options.maxDelay);
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
