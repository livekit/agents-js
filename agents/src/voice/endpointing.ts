// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const logger = log();

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

export interface BaseEndpointingOptions {
  minDelay: number;
  maxDelay: number;
}

export interface DynamicEndpointingOptions extends BaseEndpointingOptions {
  alpha?: number;
}

export interface EndpointingUpdateOptions {
  minDelay?: number;
  maxDelay?: number;
}

export interface EndpointingSpeechEndOptions {
  shouldIgnore?: boolean;
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected minDelayValue: number;
  protected maxDelayValue: number;
  protected overlap = false;

  constructor({ minDelay, maxDelay }: BaseEndpointingOptions) {
    this.minDelayValue = minDelay;
    this.maxDelayValue = maxDelay;
  }

  updateOptions({ minDelay, maxDelay }: EndpointingUpdateOptions = {}): void {
    this.minDelayValue = minDelay ?? this.minDelayValue;
    this.maxDelayValue = maxDelay ?? this.maxDelayValue;
  }

  get minDelay(): number {
    return this.minDelayValue;
  }

  get maxDelay(): number {
    return this.maxDelayValue;
  }

  get overlapping(): boolean {
    return this.overlap;
  }

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this.overlap = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _options: EndpointingSpeechEndOptions = {}): void {
    this.overlap = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-302 lines
export class DynamicEndpointing extends BaseEndpointing {
  private readonly utterancePause: ExpFilter;
  private readonly turnPause: ExpFilter;
  private utteranceStartedAt?: number;
  private utteranceEndedAt?: number;
  private agentSpeechStartedAt?: number;
  private agentSpeechEndedAt?: number;
  private speaking = false;

  constructor({ minDelay, maxDelay, alpha = 0.9 }: DynamicEndpointingOptions) {
    super({ minDelay, maxDelay });
    this.utterancePause = new ExpFilter(alpha, {
      initial: minDelay,
      minValue: minDelay,
      maxValue: maxDelay,
    });
    this.turnPause = new ExpFilter(alpha, {
      initial: maxDelay,
      minValue: minDelay,
      maxValue: maxDelay,
    });
  }

  override get minDelay(): number {
    return this.utterancePause.value ?? this.minDelayValue;
  }

  override get maxDelay(): number {
    return Math.max(this.turnPause.value ?? this.maxDelayValue, this.minDelay);
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

  override onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt = startedAt;
    this.agentSpeechEndedAt = undefined;
    this.overlap = false;
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }
    this.overlap = false;
  }

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.overlap) {
      return;
    }

    if (
      this.utteranceStartedAt !== undefined &&
      this.utteranceEndedAt !== undefined &&
      this.agentSpeechStartedAt !== undefined &&
      this.utteranceEndedAt < this.utteranceStartedAt &&
      overlapping
    ) {
      this.utteranceEndedAt = this.agentSpeechStartedAt - 1;
      logger.trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.overlap = overlapping;
    this.speaking = true;
  }

  override onEndOfSpeech(
    endedAt: number,
    { shouldIgnore = false }: EndpointingSpeechEndOptions = {},
  ): void {
    if (shouldIgnore && this.overlap) {
      const withinGracePeriod =
        this.utteranceStartedAt !== undefined &&
        this.agentSpeechStartedAt !== undefined &&
        Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD;

      if (withinGracePeriod) {
        logger.trace(
          {
            delay: Math.abs((this.utteranceStartedAt ?? 0) - (this.agentSpeechStartedAt ?? 0)),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true because user speech started within the grace period',
        );
      } else {
        this.overlap = false;
        this.speaking = false;
        this.utteranceStartedAt = undefined;
        this.utteranceEndedAt = undefined;
        return;
      }
    }

    if (
      this.overlap ||
      (this.agentSpeechStartedAt !== undefined && this.agentSpeechEndedAt === undefined)
    ) {
      const [turnDelay, interruptionDelay] = this.immediateInterruptionDelay;
      const betweenUtteranceDelay = this.betweenUtteranceDelay;

      if (
        interruptionDelay > 0 &&
        interruptionDelay <= this.minDelay &&
        turnDelay > 0 &&
        turnDelay <= this.maxDelay &&
        betweenUtteranceDelay > 0
      ) {
        const previousMinDelay = this.minDelay;
        this.utterancePause.apply(1, betweenUtteranceDelay);
        logger.debug(
          {
            reason: 'immediate interruption',
            pause: betweenUtteranceDelay,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${previousMinDelay} -> ${this.minDelay}`,
        );
      } else if (this.betweenTurnDelay > 0) {
        const previousMaxDelay = this.maxDelay;
        this.turnPause.apply(1, this.betweenTurnDelay);
        logger.debug(
          {
            reason: 'new turn (interruption)',
            pause: this.betweenTurnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
            betweenUtteranceDelay,
            betweenTurnDelay: this.betweenTurnDelay,
          },
          `max endpointing delay updated: ${previousMaxDelay} -> ${this.maxDelay}`,
        );
      }
    } else if (this.betweenTurnDelay > 0) {
      const previousMaxDelay = this.maxDelay;
      this.turnPause.apply(1, this.betweenTurnDelay);
      logger.debug(
        {
          reason: 'new turn',
          pause: this.betweenTurnDelay,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        `max endpointing delay updated due to pause: ${previousMaxDelay} -> ${this.maxDelay}`,
      );
    } else if (
      this.betweenUtteranceDelay > 0 &&
      this.agentSpeechEndedAt === undefined &&
      this.agentSpeechStartedAt === undefined
    ) {
      const previousMinDelay = this.minDelay;
      this.utterancePause.apply(1, this.betweenUtteranceDelay);
      logger.debug(
        {
          reason: 'pause between utterances',
          pause: this.betweenUtteranceDelay,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        `min endpointing delay updated: ${previousMinDelay} -> ${this.minDelay}`,
      );
    }

    this.utteranceEndedAt = endedAt;
    this.agentSpeechStartedAt = undefined;
    this.agentSpeechEndedAt = undefined;
    this.speaking = false;
    this.overlap = false;
  }

  override updateOptions({ minDelay, maxDelay }: EndpointingUpdateOptions = {}): void {
    if (minDelay !== undefined) {
      this.minDelayValue = minDelay;
      this.utterancePause.reset({ initial: minDelay, minValue: minDelay });
      this.turnPause.reset({ minValue: minDelay });
    }
    if (maxDelay !== undefined) {
      this.maxDelayValue = maxDelay;
      this.turnPause.reset({ initial: maxDelay, maxValue: maxDelay });
      this.utterancePause.reset({ maxValue: maxDelay });
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  switch (options.mode ?? 'fixed') {
    case 'dynamic':
      return new DynamicEndpointing({
        minDelay: options.minDelay,
        maxDelay: options.maxDelay,
      });
    case 'fixed':
    default:
      return new BaseEndpointing({
        minDelay: options.minDelay,
        maxDelay: options.maxDelay,
      });
  }
}
