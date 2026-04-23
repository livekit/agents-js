// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import { ExpFilter } from '../../utils.js';
import { type EndpointingOptions } from './endpointing.js';

// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 7-7 lines
// 0.25s → 250ms
const AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD_MS = 250;

/**
 * Base endpointing that exposes a fixed min/max delay pair with no adaptation.
 *
 * All timestamps (`startedAt` / `endedAt`) and delays (`minDelay` / `maxDelay`) are expressed in
 * milliseconds.
 */
// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-46 lines
export class BaseEndpointing {
  protected _minDelay: number;
  protected _maxDelay: number;
  protected _overlapping = false;

  constructor({ minDelay, maxDelay }: { minDelay: number; maxDelay: number }) {
    this._minDelay = minDelay;
    this._maxDelay = maxDelay;
  }

  updateOptions({ minDelay, maxDelay }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this._minDelay = minDelay;
    }
    if (maxDelay !== undefined) {
      this._maxDelay = maxDelay;
    }
  }

  get minDelay(): number {
    return this._minDelay;
  }

  get maxDelay(): number {
    return this._maxDelay;
  }

  get overlapping(): boolean {
    return this._overlapping;
  }

  onStartOfSpeech(_startedAt: number, overlapping = false): void {
    this._overlapping = overlapping;
  }

  onEndOfSpeech(_endedAt: number, _shouldIgnore = false): void {
    this._overlapping = false;
  }

  onStartOfAgentSpeech(_startedAt: number): void {
    // no-op in the base class
  }

  onEndOfAgentSpeech(_endedAt: number): void {
    // no-op in the base class
  }
}

/**
 * Dynamic endpointing that adjusts the min/max delay based on observed speech activity.
 *
 * The min delay covers pauses between user utterances and between an utterance and an immediate
 * user interruption. The max delay covers pauses between a user utterance and the agent's reply.
 */
// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 49-302 lines
export class DynamicEndpointing extends BaseEndpointing {
  private _utterancePause: ExpFilter;
  private _turnPause: ExpFilter;
  private _utteranceStartedAt?: number;
  private _utteranceEndedAt?: number;
  private _agentSpeechStartedAt?: number;
  private _agentSpeechEndedAt?: number;
  private _speaking = false;
  private _logger = log();

  constructor({
    minDelay,
    maxDelay,
    alpha = 0.9,
  }: {
    minDelay: number;
    maxDelay: number;
    alpha?: number;
  }) {
    super({ minDelay, maxDelay });

    this._utterancePause = new ExpFilter(alpha, maxDelay, minDelay, minDelay);
    this._turnPause = new ExpFilter(alpha, maxDelay, minDelay, maxDelay);
  }

  override get minDelay(): number {
    return this._utterancePause.value ?? this._minDelay;
  }

  override get maxDelay(): number {
    const turnVal = this._turnPause.value ?? this._maxDelay;
    return Math.max(turnVal, this.minDelay);
  }

  get betweenUtteranceDelay(): number {
    if (this._utteranceEndedAt === undefined || this._utteranceStartedAt === undefined) {
      return 0;
    }
    return Math.max(0, this._utteranceStartedAt - this._utteranceEndedAt);
  }

  get betweenTurnDelay(): number {
    if (this._agentSpeechStartedAt === undefined || this._utteranceEndedAt === undefined) {
      return 0;
    }
    return Math.max(0, this._agentSpeechStartedAt - this._utteranceEndedAt);
  }

  /**
   * Two pauses describing an immediate interruption:
   * `[utterance] [turn][interruption] [immediate interruption]`
   *                    ^                ^
   *                    turn delay       interruption delay
   */
  get immediateInterruptionDelay(): [number, number] {
    if (this._utteranceStartedAt === undefined || this._agentSpeechStartedAt === undefined) {
      return [0, 0];
    }
    return [this.betweenTurnDelay, Math.abs(this.betweenUtteranceDelay - this.betweenTurnDelay)];
  }

  override onStartOfAgentSpeech(startedAt: number): void {
    this._agentSpeechStartedAt = startedAt;
    this._agentSpeechEndedAt = undefined;
    this._overlapping = false;
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    // NOTE: intentionally keep _agentSpeechStartedAt so that betweenTurnDelay can be computed in
    // the normal end-of-speech path
    // NOTE: also guard against duplicate calls from pipeline reply and pipeline reply done
    if (
      this._agentSpeechStartedAt !== undefined &&
      (this._agentSpeechEndedAt === undefined ||
        this._agentSpeechEndedAt < this._agentSpeechStartedAt)
    ) {
      this._agentSpeechEndedAt = endedAt;
    }
    this._overlapping = false;
  }

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    if (this._overlapping) {
      // duplicate calls from _interrupt_by_audio_activity and on_start_of_speech
      return;
    }

    // VAD interrupt by audio activity is triggered before end of speech is detected
    // adjust the utterance ended time to be just before the agent speech started
    if (
      this._utteranceStartedAt !== undefined &&
      this._utteranceEndedAt !== undefined &&
      this._agentSpeechStartedAt !== undefined &&
      this._utteranceEndedAt < this._utteranceStartedAt &&
      overlapping
    ) {
      this._utteranceEndedAt = this._agentSpeechStartedAt - 1e-3;
      this._logger.trace(
        { utteranceEndedAt: this._utteranceEndedAt },
        'utterance ended at adjusted',
      );
    }

    this._utteranceStartedAt = startedAt;
    this._overlapping = overlapping;
    this._speaking = true;
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    if (shouldIgnore && this._overlapping) {
      // If user speech started within the grace period of agent speech, don't ignore —
      // TTS leading silence can cause the agent speech timestamp to precede actual audible
      // audio, making this look like a backchannel when it's really the user speaking before
      // hearing the agent.
      if (
        this._utteranceStartedAt !== undefined &&
        this._agentSpeechStartedAt !== undefined &&
        Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt) <
          AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD_MS
      ) {
        this._logger.trace(
          {
            diff: Math.abs(this._utteranceStartedAt - this._agentSpeechStartedAt),
            gracePeriod: AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD_MS,
          },
          'ignoring shouldIgnore=true: user speech started within grace period of agent speech',
        );
      } else {
        // skip update because it might be a backchannel
        this._overlapping = false;
        this._speaking = false;
        this._utteranceStartedAt = undefined;
        this._utteranceEndedAt = undefined;
        return;
      }
    }

    if (
      this._overlapping ||
      (this._agentSpeechStartedAt !== undefined && this._agentSpeechEndedAt === undefined)
    ) {
      // interruption path (agent is still speaking)
      const [turnDelay, interruptionDelay] = this.immediateInterruptionDelay;
      const pauseBetweenUtterances = this.betweenUtteranceDelay;
      if (
        interruptionDelay > 0 &&
        interruptionDelay <= this.minDelay &&
        turnDelay > 0 &&
        turnDelay <= this.maxDelay &&
        pauseBetweenUtterances > 0
      ) {
        // immediate interruption → update min delay (case 2)
        const prevVal = this.minDelay;
        this._utterancePause.apply(1.0, pauseBetweenUtterances);
        this._logger.debug(
          {
            reason: 'immediate interruption',
            pause: pauseBetweenUtterances,
            interruptionDelay,
            turnDelay,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `min endpointing delay updated: ${prevVal} -> ${this.minDelay}`,
        );
      } else {
        const pauseBetweenTurns = this.betweenTurnDelay;
        if (pauseBetweenTurns > 0) {
          // delayed interruption → update max delay (case 3)
          const prevVal = this.maxDelay;
          this._turnPause.apply(1.0, pauseBetweenTurns);
          this._logger.debug(
            {
              reason: 'new turn (interruption)',
              pause: pauseBetweenTurns,
              maxDelay: this.maxDelay,
              minDelay: this.minDelay,
              betweenUtteranceDelay: this.betweenUtteranceDelay,
              betweenTurnDelay: this.betweenTurnDelay,
            },
            `max endpointing delay updated: ${prevVal} -> ${this.maxDelay}`,
          );
        }
      }
    } else {
      // normal end of speech
      const pauseBetweenTurns = this.betweenTurnDelay;
      if (pauseBetweenTurns > 0) {
        const prevVal = this.maxDelay;
        this._turnPause.apply(1.0, pauseBetweenTurns);
        this._logger.debug(
          {
            reason: 'new turn',
            pause: pauseBetweenTurns,
            maxDelay: this.maxDelay,
            minDelay: this.minDelay,
          },
          `max endpointing delay updated due to pause: ${prevVal} -> ${this.maxDelay}`,
        );
      } else {
        const pauseBetweenUtterances = this.betweenUtteranceDelay;
        if (
          pauseBetweenUtterances > 0 &&
          this._agentSpeechEndedAt === undefined &&
          this._agentSpeechStartedAt === undefined
        ) {
          const prevVal = this.minDelay;
          this._utterancePause.apply(1.0, pauseBetweenUtterances);
          this._logger.debug(
            {
              reason: 'pause between utterances',
              pause: pauseBetweenUtterances,
              maxDelay: this.maxDelay,
              minDelay: this.minDelay,
            },
            `min endpointing delay updated: ${prevVal} -> ${this.minDelay}`,
          );
        }
      }
    }

    this._utteranceEndedAt = endedAt;
    this._agentSpeechStartedAt = undefined;
    this._agentSpeechEndedAt = undefined;
    this._speaking = false;
    this._overlapping = false;
  }

  override updateOptions({
    minDelay,
    maxDelay,
  }: { minDelay?: number; maxDelay?: number } = {}): void {
    if (minDelay !== undefined) {
      this._minDelay = minDelay;
      this._utterancePause.reset({ initial: this._minDelay, min: this._minDelay });
      this._turnPause.reset({ min: this._minDelay });
    }

    if (maxDelay !== undefined) {
      this._maxDelay = maxDelay;
      this._turnPause.reset({ initial: this._maxDelay, max: this._maxDelay });
      this._utterancePause.reset({ max: this._maxDelay });
    }
  }
}

/**
 * Create an endpointing instance based on the `mode` field of the provided options.
 *
 * - `"dynamic"` → {@link DynamicEndpointing}
 * - anything else → {@link BaseEndpointing}
 */
// Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
export function createEndpointing(options: EndpointingOptions): BaseEndpointing {
  const { mode = 'fixed', minDelay, maxDelay } = options;
  if (mode === 'dynamic') {
    return new DynamicEndpointing({ minDelay, maxDelay });
  }
  return new BaseEndpointing({ minDelay, maxDelay });
}
