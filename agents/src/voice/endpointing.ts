// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-8 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-48 lines
export class BaseEndpointing {
  protected configuredMinDelay: number;
  protected configuredMaxDelay: number;
  protected isOverlapping = false;

  constructor(minDelay: number, maxDelay: number) {
    this.configuredMinDelay = minDelay;
    this.configuredMaxDelay = maxDelay;
  }

  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this.configuredMinDelay = minDelay;
    }
    if (maxDelay !== undefined) {
      this.configuredMaxDelay = maxDelay;
    }
  }

  get minDelay(): number {
    return this.configuredMinDelay;
  }

  get maxDelay(): number {
    return this.configuredMaxDelay;
  }

  get overlapping(): boolean {
    return this.isOverlapping;
  }

  onStartOfSpeech(startedAt: number, overlapping = false): void {
    void startedAt;
    this.isOverlapping = overlapping;
  }

  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    void endedAt;
    void shouldIgnore;
    this.isOverlapping = false;
  }

  onStartOfAgentSpeech(startedAt: number): void {
    void startedAt;
  }

  onEndOfAgentSpeech(endedAt: number): void {
    void endedAt;
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-304 lines
export class DynamicEndpointing extends BaseEndpointing {
  private readonly logger = log();
  private readonly utterancePause: ExpFilter;
  private readonly turnPause: ExpFilter;
  private utteranceStartedAt: number | undefined;
  private utteranceEndedAt: number | undefined;
  private agentSpeechStartedAt: number | undefined;
  private agentSpeechEndedAt: number | undefined;
  private speaking = false;

  constructor(minDelay: number, maxDelay: number, alpha = 0.9) {
    super(minDelay, maxDelay);
    this.utterancePause = new ExpFilter(alpha, maxDelay, minDelay, minDelay);
    this.turnPause = new ExpFilter(alpha, maxDelay, minDelay, maxDelay);
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
    this.isOverlapping = false;
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }
    this.isOverlapping = false;
  }

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.isOverlapping) {
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
      this.logger.trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.isOverlapping = overlapping;
    this.speaking = true;
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this.isOverlapping) {
      const withinGracePeriod =
        this.utteranceStartedAt !== undefined &&
        this.agentSpeechStartedAt !== undefined &&
        Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD;

      if (withinGracePeriod) {
        this.logger.trace(
          {
            distance: Math.abs(this.utteranceStartedAt! - this.agentSpeechStartedAt!),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true within grace period',
        );
      } else {
        this.isOverlapping = false;
        this.speaking = false;
        this.utteranceStartedAt = undefined;
        this.utteranceEndedAt = undefined;
        return;
      }
    }

    const isInterruption =
      this.isOverlapping ||
      (this.agentSpeechStartedAt !== undefined && this.agentSpeechEndedAt === undefined);

    if (isInterruption) {
      const [turnDelay, interruptionDelay] = this.immediateInterruptionDelay;
      const betweenUtteranceDelay = this.betweenUtteranceDelay;

      if (
        interruptionDelay > 0 &&
        interruptionDelay <= this.minDelay &&
        turnDelay > 0 &&
        turnDelay <= this.maxDelay &&
        betweenUtteranceDelay > 0
      ) {
        const previousValue = this.minDelay;
        this.utterancePause.apply(1.0, betweenUtteranceDelay);
        this.logger.debug(
          {
            reason: 'immediate interruption',
            pause: betweenUtteranceDelay,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${previousValue} -> ${this.minDelay}`,
        );
      } else if (this.betweenTurnDelay > 0) {
        const pause = this.betweenTurnDelay;
        const previousValue = this.maxDelay;
        this.turnPause.apply(1.0, pause);
        this.logger.debug(
          {
            reason: 'new turn (interruption)',
            pause,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
            betweenUtteranceDelay,
            betweenTurnDelay: pause,
          },
          `max endpointing delay updated: ${previousValue} -> ${this.maxDelay}`,
        );
      }
    } else if (this.betweenTurnDelay > 0) {
      const pause = this.betweenTurnDelay;
      const previousValue = this.maxDelay;
      this.turnPause.apply(1.0, pause);
      this.logger.debug(
        {
          reason: 'new turn',
          pause,
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
      const pause = this.betweenUtteranceDelay;
      const previousValue = this.minDelay;
      this.utterancePause.apply(1.0, pause);
      this.logger.debug(
        {
          reason: 'pause between utterances',
          pause,
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
    this.isOverlapping = false;
  }

  override updateOptions({
    minDelay,
    maxDelay,
  }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this.configuredMinDelay = minDelay;
      this.utterancePause.reset({ initialValue: minDelay, minValue: minDelay });
      this.turnPause.reset({ minValue: minDelay });
    }

    if (maxDelay !== undefined) {
      this.configuredMaxDelay = maxDelay;
      this.turnPause.reset({ initialValue: maxDelay, maxValue: maxDelay });
      this.utterancePause.reset({ maxValue: maxDelay });
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
