// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const logger = log();
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250;

// Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 10-47
export class BaseEndpointing {
  protected minDelayBase: number;
  protected maxDelayBase: number;
  protected overlappingState = false;

  constructor(minDelay: number, maxDelay: number) {
    this.minDelayBase = minDelay;
    this.maxDelayBase = maxDelay;
  }

  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
    this.minDelayBase = minDelay ?? this.minDelayBase;
    this.maxDelayBase = maxDelay ?? this.maxDelayBase;
  }

  get minDelay(): number {
    return this.minDelayBase;
  }

  get maxDelay(): number {
    return this.maxDelayBase;
  }

  get overlapping(): boolean {
    return this.overlappingState;
  }

  onStartOfSpeech(startedAt: number, overlapping = false): void {
    void startedAt;
    this.overlappingState = overlapping;
  }

  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    void endedAt;
    void shouldIgnore;
    this.overlappingState = false;
  }

  onStartOfAgentSpeech(startedAt: number): void {
    void startedAt;
    return;
  }

  onEndOfAgentSpeech(endedAt: number): void {
    void endedAt;
    return;
  }
}

// Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 49-304
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
    return this.utterancePause.value ?? this.minDelayBase;
  }

  get maxDelay(): number {
    return Math.max(this.turnPause.value ?? this.maxDelayBase, this.minDelay);
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

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 139-153
  onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt = startedAt;
    this.agentSpeechEndedAt = undefined;
    this.overlappingState = false;
  }

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 144-153
  onEndOfAgentSpeech(endedAt: number): void {
    if (
      this.agentSpeechStartedAt !== undefined &&
      (this.agentSpeechEndedAt === undefined || this.agentSpeechEndedAt < this.agentSpeechStartedAt)
    ) {
      this.agentSpeechEndedAt = endedAt;
    }

    this.overlappingState = false;
  }

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 155-177
  onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this.overlappingState) {
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
    this.overlappingState = overlapping;
    this.speaking = true;
  }

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 179-286
  onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this.overlappingState) {
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
          'ignoring shouldIgnore=true because user speech started within the grace period',
        );
      } else {
        this.overlappingState = false;
        this.speaking = false;
        this.utteranceStartedAt = undefined;
        this.utteranceEndedAt = undefined;
        return;
      }
    }

    if (this.overlappingState || this.#isAgentStillSpeaking()) {
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
            previousMinDelay,
            minDelay: this.minDelay,
            pause: betweenUtteranceDelay,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
          },
          'min endpointing delay updated for immediate interruption',
        );
      } else {
        const betweenTurnDelay = this.betweenTurnDelay;
        if (betweenTurnDelay > 0) {
          const previousMaxDelay = this.maxDelay;
          this.turnPause.apply(1, betweenTurnDelay);
          logger.debug(
            {
              previousMaxDelay,
              maxDelay: this.maxDelay,
              minDelay: this.minDelay,
              pause: betweenTurnDelay,
              betweenUtteranceDelay: this.betweenUtteranceDelay,
            },
            'max endpointing delay updated for a new turn interruption',
          );
        }
      }
    } else {
      const betweenTurnDelay = this.betweenTurnDelay;
      if (betweenTurnDelay > 0) {
        const previousMaxDelay = this.maxDelay;
        this.turnPause.apply(1, betweenTurnDelay);
        logger.debug(
          {
            previousMaxDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
            pause: betweenTurnDelay,
          },
          'max endpointing delay updated for a new turn',
        );
      } else {
        const betweenUtteranceDelay = this.betweenUtteranceDelay;
        if (
          betweenUtteranceDelay > 0 &&
          this.agentSpeechEndedAt === undefined &&
          this.agentSpeechStartedAt === undefined
        ) {
          const previousMinDelay = this.minDelay;
          this.utterancePause.apply(1, betweenUtteranceDelay);
          logger.debug(
            {
              previousMinDelay,
              minDelay: this.minDelay,
              maxDelay: this.maxDelay,
              pause: betweenUtteranceDelay,
            },
            'min endpointing delay updated for a pause between utterances',
          );
        }
      }
    }

    this.utteranceEndedAt = endedAt;
    this.agentSpeechStartedAt = undefined;
    this.agentSpeechEndedAt = undefined;
    this.speaking = false;
    this.overlappingState = false;
  }

  // Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 288-303
  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this.minDelayBase = minDelay;
      this.utterancePause.reset({ initial: minDelay, min: minDelay });
      this.turnPause.reset({ min: minDelay });
    }

    if (maxDelay !== undefined) {
      this.maxDelayBase = maxDelay;
      this.turnPause.reset({ initial: maxDelay, max: maxDelay });
      this.utterancePause.reset({ max: maxDelay });
    }
  }

  #isAgentStillSpeaking(): boolean {
    return this.agentSpeechStartedAt !== undefined && this.agentSpeechEndedAt === undefined;
  }
}

// Ref: source livekit-agents/livekit/agents/voice/endpointing.py - 305-316
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  if (options.mode === 'dynamic') {
    return new DynamicEndpointing(options.minDelay, options.maxDelay);
  }

  return new BaseEndpointing(options.minDelay, options.maxDelay);
}
