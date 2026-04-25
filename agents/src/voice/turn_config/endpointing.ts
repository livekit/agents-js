// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import { ExpFilter } from '../../utils.js';

/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
export interface EndpointingOptions {
  /**
   * Endpointing mode. `"fixed"` uses a fixed delay, `"dynamic"` adjusts delay based on
   * pauses between user and agent speech.
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

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250; // 0.25s → 250ms

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected configuredMinDelay: number;
  protected configuredMaxDelay: number;
  protected overlappingValue = false;

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
    return this.overlappingValue;
  }

  onStartOfSpeech(startedAt: number, overlapping = false): void {
    void startedAt;
    this.overlappingValue = overlapping;
  }

  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    void endedAt;
    void shouldIgnore;
    this.overlappingValue = false;
  }

  onStartOfAgentSpeech(startedAt: number): void {
    void startedAt;
  }

  onEndOfAgentSpeech(endedAt: number): void {
    void endedAt;
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-303 lines
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
      minVal: minDelay,
      maxVal: maxDelay,
    });
    this.turnPause = new ExpFilter(alpha, {
      initial: maxDelay,
      minVal: minDelay,
      maxVal: maxDelay,
    });
  }

  get minDelay(): number {
    return this.utterancePause.value ?? this.configuredMinDelay;
  }

  get maxDelay(): number {
    const turnVal = this.turnPause.value ?? this.configuredMaxDelay;
    return Math.max(turnVal, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this.utteranceEndedAt === undefined) {
      return 0;
    }
    if (this.utteranceStartedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.utteranceStartedAt - this.utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this.agentSpeechStartedAt === undefined) {
      return 0;
    }
    if (this.utteranceEndedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.agentSpeechStartedAt - this.utteranceEndedAt);
  }

  get immediateInterruptionDelay(): [number, number] {
    if (this.utteranceStartedAt === undefined) {
      return [0, 0];
    }
    if (this.agentSpeechStartedAt === undefined) {
      return [0, 0];
    }

    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 139-153 lines
  onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt = startedAt;
    this.agentSpeechEndedAt = undefined;
    this.overlappingValue = false;
  }

  onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }
    this.overlappingValue = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 155-178 lines
  onStartOfSpeech(startedAt: number, overlapping = false): void {
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
      this.utteranceEndedAt = this.agentSpeechStartedAt - 1; // 1e-3s → 1ms
      log().trace({ utteranceEndedAt: this.utteranceEndedAt }, 'utterance ended at adjusted');
    }

    this.utteranceStartedAt = startedAt;
    this.overlappingValue = overlapping;
    this.speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-286 lines
  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this.overlappingValue) {
      if (
        this.utteranceStartedAt !== undefined &&
        this.agentSpeechStartedAt !== undefined &&
        Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        log().trace(
          {
            delta: Math.abs(this.utteranceStartedAt - this.agentSpeechStartedAt),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true: user speech started within grace period of agent speech',
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
      const pause = this.betweenUtteranceDelay;
      if (
        0 < interruptionDelay &&
        interruptionDelay <= this.minDelay &&
        0 < turnDelay &&
        turnDelay <= this.maxDelay &&
        pause > 0
      ) {
        const prevVal = this.minDelay;
        this.utterancePause.apply(1, pause);
        log().debug(
          {
            reason: 'immediate interruption',
            pause,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${prevVal} -> ${this.minDelay}`,
        );
      } else if (this.betweenTurnDelay > 0) {
        const prevVal = this.maxDelay;
        const turnPause = this.betweenTurnDelay;
        this.turnPause.apply(1, turnPause);
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
    } else if (this.betweenTurnDelay > 0) {
      const prevVal = this.maxDelay;
      const pause = this.betweenTurnDelay;
      this.turnPause.apply(1, pause);
      log().debug(
        {
          reason: 'new turn',
          pause,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        `max endpointing delay updated due to pause: ${prevVal} -> ${this.maxDelay}`,
      );
    } else if (
      this.betweenUtteranceDelay > 0 &&
      this.agentSpeechEndedAt === undefined &&
      this.agentSpeechStartedAt === undefined
    ) {
      const prevVal = this.minDelay;
      const pause = this.betweenUtteranceDelay;
      this.utterancePause.apply(1, pause);
      log().debug(
        {
          reason: 'pause between utterances',
          pause,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        `min endpointing delay updated: ${prevVal} -> ${this.minDelay}`,
      );
    }

    this.utteranceEndedAt = endedAt;
    this.agentSpeechStartedAt = undefined;
    this.agentSpeechEndedAt = undefined;
    this.speaking = false;
    this.overlappingValue = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 288-302 lines
  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this.configuredMinDelay = minDelay;
      this.utterancePause.reset({
        initial: this.configuredMinDelay,
        minVal: this.configuredMinDelay,
      });
      this.turnPause.reset({ minVal: this.configuredMinDelay });
    }

    if (maxDelay !== undefined) {
      this.configuredMaxDelay = maxDelay;
      this.turnPause.reset({ initial: this.configuredMaxDelay, maxVal: this.configuredMaxDelay });
      this.utterancePause.reset({ maxVal: this.configuredMaxDelay });
    }
  }
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  switch (options.mode ?? 'fixed') {
    case 'dynamic':
      return new DynamicEndpointing(options.minDelay, options.maxDelay);
    case 'fixed':
    default:
      return new BaseEndpointing(options.minDelay, options.maxDelay);
  }
}
