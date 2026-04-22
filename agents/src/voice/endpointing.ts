// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
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

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this.isOverlapping = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this.isOverlapping = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {}

  onEndOfAgentSpeech(_endedAt: number): void {}
}

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-304 lines
export class DynamicEndpointing extends BaseEndpointing {
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

  override get minDelay(): number {
    return this.utterancePause.value ?? this.configuredMinDelay;
  }

  override get maxDelay(): number {
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

      if (!withinGracePeriod) {
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
      const betweenUtteranceDelay = this.betweenUtteranceDelay;

      if (
        interruptionDelay > 0 &&
        interruptionDelay <= this.minDelay &&
        turnDelay > 0 &&
        turnDelay <= this.maxDelay &&
        betweenUtteranceDelay > 0
      ) {
        this.utterancePause.apply(1, betweenUtteranceDelay);
      } else if (this.betweenTurnDelay > 0) {
        this.turnPause.apply(1, this.betweenTurnDelay);
      }
    } else if (this.betweenTurnDelay > 0) {
      this.turnPause.apply(1, this.betweenTurnDelay);
    } else if (
      this.betweenUtteranceDelay > 0 &&
      this.agentSpeechEndedAt === undefined &&
      this.agentSpeechStartedAt === undefined
    ) {
      this.utterancePause.apply(1, this.betweenUtteranceDelay);
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
      this.utterancePause.reset({ initial: this.configuredMinDelay, min: this.configuredMinDelay });
      this.turnPause.reset({ min: this.configuredMinDelay });
    }

    if (maxDelay !== undefined) {
      this.configuredMaxDelay = maxDelay;
      this.turnPause.reset({ initial: this.configuredMaxDelay, max: this.configuredMaxDelay });
      this.utterancePause.reset({ max: this.configuredMaxDelay });
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
