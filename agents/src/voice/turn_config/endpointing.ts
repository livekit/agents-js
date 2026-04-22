// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import { ExpFilter } from '../../utils.js';

const logger = log();

// Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 7-7
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250; // 0.25s -> 250ms

/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
export interface EndpointingOptions {
  /**
   * Endpointing mode. `"fixed"` uses a fixed delay, `"dynamic"` adjusts delay based on
   * end-of-utterance prediction.
   * @defaultValue "fixed"
   */
  mode: 'fixed' | 'dynamic';
  /**
   * Minimum time in milliseconds since the last detected speech before the agent declares the user's
   * turn complete. In VAD mode this effectively behaves like `max(VAD silence, minDelay)`;
   * in STT mode it is applied after the STT end-of-speech signal, so it can be additive with
   * the STT provider's endpointing delay.
   * @defaultValue 500
   */
  minDelay: number;
  /**
   * Maximum time in milliseconds the agent will wait before terminating the turn.
   * @defaultValue 3000
   */
  maxDelay: number;
}

export const defaultEndpointingOptions = {
  mode: 'fixed',
  minDelay: 500,
  maxDelay: 3000,
} as const satisfies EndpointingOptions;

// Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 10-46
export class BaseEndpointing {
  protected configuredMinDelay: number;
  protected configuredMaxDelay: number;
  protected isOverlapping = false;

  constructor(minDelay: number, maxDelay: number) {
    this.configuredMinDelay = minDelay;
    this.configuredMaxDelay = maxDelay;
  }

  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
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
    return this.isOverlapping;
  }

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this.isOverlapping = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this.isOverlapping = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

// Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 49-302
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

  onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt = startedAt;
    this.agentSpeechEndedAt = undefined;
    this.isOverlapping = false;
  }

  onEndOfAgentSpeech(endedAt: number): void {
    // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 144-153
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }
    this.isOverlapping = false;
  }

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 155-177
  onStartOfSpeech(startedAt: number, overlapping = false): void {
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
      logger.trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.isOverlapping = overlapping;
    this.speaking = true;
  }

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 179-286
  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this.isOverlapping) {
      if (
        this.utteranceStartedAt !== undefined &&
        this.agentSpeechStartedAt !== undefined &&
        Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        logger.trace(
          {
            delay: Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt),
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

    if (
      this.isOverlapping ||
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
        const previousValue = this.minDelay;
        this.utterancePause.apply(1, utterancePause);
        logger.debug(
          {
            reason: 'immediate interruption',
            pause: utterancePause,
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
    this.isOverlapping = false;
  }

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 288-302
  override updateOptions({
    minDelay,
    maxDelay,
  }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this.configuredMinDelay = minDelay;
      this.utterancePause.reset({ initial: minDelay, min: minDelay });
      this.turnPause.reset({ min: minDelay });
    }

    if (maxDelay !== undefined) {
      this.configuredMaxDelay = maxDelay;
      this.turnPause.reset({ initial: maxDelay, max: maxDelay });
      this.utterancePause.reset({ max: maxDelay });
    }
  }
}

// Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 305-316
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  switch (options.mode) {
    case 'dynamic':
      return new DynamicEndpointing(options.minDelay, options.maxDelay);
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
