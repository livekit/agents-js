// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { ExpFilter } from '../utils.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';

const logger = log();

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
const _AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD = 250; // 0.25s -> 250ms

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-47 lines
export class BaseEndpointing {
  protected _min_delay: number;
  protected _max_delay: number;
  protected _overlapping: boolean;

  constructor(minDelay: number, maxDelay: number) {
    this._min_delay = minDelay;
    this._max_delay = maxDelay;
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 16-22 lines
  updateOptions(options: { minDelay?: number; maxDelay?: number } = {}): void {
    if (Object.hasOwn(options, 'minDelay')) {
      this._min_delay = options.minDelay!;
    }
    if (Object.hasOwn(options, 'maxDelay')) {
      this._max_delay = options.maxDelay!;
    }
  }

  get minDelay(): number {
    return this._min_delay;
  }

  get maxDelay(): number {
    return this._max_delay;
  }

  get overlapping(): boolean {
    return this._overlapping;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 36-40 lines
  onStartOfSpeech(startedAt: number, overlapping: boolean = false): void {
    void startedAt;
    this._overlapping = overlapping;
  }

  onEndOfSpeech(endedAt: number, shouldIgnore: boolean = false): void {
    void endedAt;
    void shouldIgnore;
    this._overlapping = false;
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
  private _utterance_pause: ExpFilter;
  private _turn_pause: ExpFilter;

  private _utterance_started_at: number | undefined;
  private _utterance_ended_at: number | undefined;
  private _agent_speech_started_at: number | undefined;
  private _agent_speech_ended_at: number | undefined;
  private _speaking: boolean;

  constructor(minDelay: number, maxDelay: number, alpha: number = 0.9) {
    super(minDelay, maxDelay);

    this._utterance_pause = new ExpFilter(alpha, undefined, {
      initial: minDelay,
      minVal: minDelay,
      maxVal: maxDelay,
    });
    this._turn_pause = new ExpFilter(alpha, undefined, {
      initial: maxDelay,
      minVal: minDelay,
      maxVal: maxDelay,
    });

    this._utterance_started_at = undefined;
    this._utterance_ended_at = undefined;
    this._agent_speech_started_at = undefined;
    this._agent_speech_ended_at = undefined;
    this._speaking = false;
  }

  get minDelay(): number {
    return this._utterance_pause.value ?? this._min_delay;
  }

  get maxDelay(): number {
    const turnVal = this._turn_pause.value ?? this._max_delay;
    return Math.max(turnVal, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this._utterance_ended_at === undefined || this._utterance_started_at === undefined) {
      return 0;
    }

    return Math.max(0, this._utterance_started_at - this._utterance_ended_at);
  }

  get betweenTurnDelay(): number {
    if (this._agent_speech_started_at === undefined || this._utterance_ended_at === undefined) {
      return 0;
    }

    return Math.max(0, this._agent_speech_started_at - this._utterance_ended_at);
  }

  get immediateInterruptionDelay(): [number, number] {
    if (this._utterance_started_at === undefined || this._agent_speech_started_at === undefined) {
      return [0, 0];
    }

    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 139-142 lines
  override onStartOfAgentSpeech(startedAt: number): void {
    this._agent_speech_started_at = startedAt;
    this._agent_speech_ended_at = undefined;
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 144-153 lines
  override onEndOfAgentSpeech(endedAt: number): void {
    if (
      this._agent_speech_started_at !== undefined &&
      (this._agent_speech_ended_at === undefined ||
        this._agent_speech_ended_at < this._agent_speech_started_at)
    ) {
      this._agent_speech_ended_at = endedAt;
    }
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 155-177 lines
  override onStartOfSpeech(startedAt: number, overlapping: boolean = false): void {
    if (this._overlapping) {
      return;
    }

    if (
      this._utterance_started_at !== undefined &&
      this._utterance_ended_at !== undefined &&
      this._agent_speech_started_at !== undefined &&
      this._utterance_ended_at < this._utterance_started_at &&
      overlapping
    ) {
      this._utterance_ended_at = this._agent_speech_started_at - 1;
      logger.trace({ utteranceEndedAt: this._utterance_ended_at }, 'utterance ended at adjusted');
    }

    this._utterance_started_at = startedAt;
    this._overlapping = overlapping;
    this._speaking = true;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 179-286 lines
  override onEndOfSpeech(endedAt: number, shouldIgnore: boolean = false): void {
    if (shouldIgnore && this._overlapping) {
      if (
        this._utterance_started_at !== undefined &&
        this._agent_speech_started_at !== undefined &&
        Math.abs(this._utterance_started_at - this._agent_speech_started_at) <
          _AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD
      ) {
        logger.trace(
          {
            startedAtDelta: Math.abs(this._utterance_started_at - this._agent_speech_started_at),
            gracePeriod: _AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD,
          },
          'ignoring shouldIgnore=true within grace period',
        );
      } else {
        this._overlapping = false;
        this._speaking = false;
        this._utterance_started_at = undefined;
        this._utterance_ended_at = undefined;
        return;
      }
    }

    if (
      this._overlapping ||
      (this._agent_speech_started_at !== undefined && this._agent_speech_ended_at === undefined)
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
        const prevVal = this.minDelay;
        this._utterance_pause.apply(1.0, betweenUtteranceDelay);
        logger.debug(
          {
            prevVal,
            reason: 'immediate interruption',
            pause: betweenUtteranceDelay,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          'min endpointing delay updated',
        );
      } else if (this.betweenTurnDelay > 0) {
        const prevVal = this.maxDelay;
        this._turn_pause.apply(1.0, this.betweenTurnDelay);
        logger.debug(
          {
            prevVal,
            reason: 'new turn (interruption)',
            pause: this.betweenTurnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
            betweenUtteranceDelay: this.betweenUtteranceDelay,
            betweenTurnDelay: this.betweenTurnDelay,
          },
          'max endpointing delay updated',
        );
      }
    } else if (this.betweenTurnDelay > 0) {
      const prevVal = this.maxDelay;
      this._turn_pause.apply(1.0, this.betweenTurnDelay);
      logger.debug(
        {
          prevVal,
          reason: 'new turn',
          pause: this.betweenTurnDelay,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        'max endpointing delay updated due to pause',
      );
    } else if (
      this.betweenUtteranceDelay > 0 &&
      this._agent_speech_ended_at === undefined &&
      this._agent_speech_started_at === undefined
    ) {
      const prevVal = this.minDelay;
      this._utterance_pause.apply(1.0, this.betweenUtteranceDelay);
      logger.debug(
        {
          prevVal,
          reason: 'pause between utterances',
          pause: this.betweenUtteranceDelay,
          maxDelay: this.maxDelay,
          minDelay: this.minDelay,
        },
        'min endpointing delay updated',
      );
    }

    this._utterance_ended_at = endedAt;
    this._agent_speech_started_at = undefined;
    this._agent_speech_ended_at = undefined;
    this._speaking = false;
    this._overlapping = false;
  }

  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 288-302 lines
  override updateOptions(options: { minDelay?: number; maxDelay?: number } = {}): void {
    if (Object.hasOwn(options, 'minDelay')) {
      this._min_delay = options.minDelay!;
      this._utterance_pause.reset({ initial: this._min_delay, minVal: this._min_delay });
      this._turn_pause.reset({ minVal: this._min_delay });
    }

    if (Object.hasOwn(options, 'maxDelay')) {
      this._max_delay = options.maxDelay!;
      this._turn_pause.reset({ initial: this._max_delay, maxVal: this._max_delay });
      this._utterance_pause.reset({ maxVal: this._max_delay });
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
