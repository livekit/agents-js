// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected configuredMinDelay: number;
  protected configuredMaxDelay: number;
  protected overlapActive = false;

  constructor({ minDelay, maxDelay }: Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>) {
    this.configuredMinDelay = minDelay;
    this.configuredMaxDelay = maxDelay;
  }

  updateOptions({
    minDelay,
    maxDelay,
  }: Partial<Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>> = {}): void {
    this.configuredMinDelay = minDelay ?? this.configuredMinDelay;
    this.configuredMaxDelay = maxDelay ?? this.configuredMaxDelay;
  }

  get minDelay(): number {
    return this.configuredMinDelay;
  }

  get maxDelay(): number {
    return this.configuredMaxDelay;
  }

  get overlapping(): boolean {
    return this.overlapActive;
  }

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this.overlapActive = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this.overlapActive = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-304 lines
export class DynamicEndpointing extends BaseEndpointing {
  private readonly logger = log();
  private utterancePause: ExpFilter;
  private turnPause: ExpFilter;
  private utteranceStartedAt?: number;
  private utteranceEndedAt?: number;
  private agentSpeechStartedAt?: number;
  private agentSpeechEndedAt?: number;
  private speaking = false;

  constructor({
    minDelay,
    maxDelay,
    alpha = 0.9,
  }: Pick<EndpointingOptions, 'minDelay' | 'maxDelay'> & { alpha?: number }) {
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

  get minDelay(): number {
    return this.utterancePause.value ?? this.configuredMinDelay;
  }

  get maxDelay(): number {
    return Math.max(this.turnPause.value ?? this.configuredMaxDelay, this.minDelay);
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
    this.overlapActive = false;
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }
    this.overlapActive = false;
  }

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.overlapActive) {
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
      this.utteranceEndedAt = this.agentSpeechStartedAt - 1;
      this.logger.trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.overlapActive = overlapping;
    this.speaking = true;
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 180-203 lines
    if (shouldIgnore && this.overlapActive) {
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
        this.overlapActive = false;
        this.speaking = false;
        this.utteranceStartedAt = undefined;
        this.utteranceEndedAt = undefined;
        return;
      }
    }

    // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 205-280 lines
    if (
      this.overlapActive ||
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
        const previousMinDelay = this.minDelay;
        this.utterancePause.apply(1, pause);
        this.logger.debug(
          {
            reason: 'immediate interruption',
            pause,
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
        this.logger.debug(
          {
            reason: 'new turn (interruption)',
            pause: this.betweenTurnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
            betweenUtteranceDelay: this.betweenUtteranceDelay,
            betweenTurnDelay: this.betweenTurnDelay,
          },
          `max endpointing delay updated: ${previousMaxDelay} -> ${this.maxDelay}`,
        );
      }
    } else if (this.betweenTurnDelay > 0) {
      const previousMaxDelay = this.maxDelay;
      this.turnPause.apply(1, this.betweenTurnDelay);
      this.logger.debug(
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
      this.logger.debug(
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
    this.overlapActive = false;
  }

  override updateOptions({
    minDelay,
    maxDelay,
  }: Partial<Pick<EndpointingOptions, 'minDelay' | 'maxDelay'>> = {}): void {
    if (minDelay !== undefined) {
      this.configuredMinDelay = minDelay;
      this.utterancePause.reset({ initial: minDelay, minValue: minDelay });
      this.turnPause.reset({ minValue: minDelay });
    }

    if (maxDelay !== undefined) {
      this.configuredMaxDelay = maxDelay;
      this.turnPause.reset({ initial: maxDelay, maxValue: maxDelay });
      this.utterancePause.reset({ maxValue: maxDelay });
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
