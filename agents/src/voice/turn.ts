import type { TurnDetectionMode } from './agent_session.js';

/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
export interface EndpointingConfig {
  /**
   * Minimum time in seconds since the last detected speech before the agent declares the user's
   * turn complete. In VAD mode this effectively behaves like `max(VAD silence, minDelay)`;
   * in STT mode it is applied after the STT end-of-speech signal, so it can be additive with
   * the STT provider's endpointing delay.
   * @defaultValue 0.5
   */
  minDelay?: number;
  /**
   * Maximum time in seconds the agent will wait before terminating the turn.
   * @defaultValue 3.0
   */
  maxDelay?: number;
}

export const defaultEndpointingConfig = {
  minDelay: 0.5,
  maxDelay: 3.0,
} as const satisfies EndpointingConfig;

/**
 * Configuration for interruption handling.
 */
export interface InterruptionConfig {
  /**
   * Interruption handling strategy.
   * @defaultValue undefined
   */
  mode?: 'adaptive' | 'vad' | false;
  /**
   * When `true`, buffered audio is dropped while the agent is speaking and cannot be interrupted.
   * @defaultValue true
   */
  discardAudioIfUninterruptible?: boolean;
  /**
   * Minimum speech length in seconds to register as an interruption.
   * @defaultValue 0.5
   */
  minDuration?: number;
  /**
   * Minimum number of words to consider an interruption, only used if STT is enabled.
   * @defaultValue 0
   */
  minWords?: number;
  /**
   * If set, emit an `agentFalseInterruption` event after this amount of time if the user is
   * silent and no user transcript is detected after the interruption. Set to `undefined` to
   * disable.
   * @defaultValue 2.0
   */
  falseInterruptionTimeout?: number;
  /**
   * Whether to resume the false interruption after the `falseInterruptionTimeout`.
   * @defaultValue true
   */
  resumeFalseInterruption?: boolean;
}

export const defaultInterruptionConfig = {
  mode: undefined,
  discardAudioIfUninterruptible: true,
  minDuration: 0.5,
  minWords: 0,
  falseInterruptionTimeout: 2,
  resumeFalseInterruption: true,
} as const satisfies InterruptionConfig;

/**
 * Configuration for the turn handling system. Used to configure the turn taking behavior of the
 * session.
 */
export interface TurnHandlingConfig {
  /**
   * Strategy for deciding when the user has finished speaking.
   *
   * - `"stt"` – rely on speech-to-text end-of-utterance cues
   * - `"vad"` – rely on Voice Activity Detection start/stop cues
   * - `"realtime_llm"` – use server-side detection from a realtime LLM
   * - `"manual"` – caller controls turn boundaries explicitly
   *
   * If not set, the session chooses the best available mode in priority order
   * `realtime_llm → vad → stt → manual`; it automatically falls back if the necessary model
   * is missing.
   */
  turnDetection?: TurnDetectionMode;
  /**
   * Configuration for endpointing.
   */
  endpointing?: EndpointingConfig;
  /**
   * Configuration for interruption handling.
   */
  interruption?: InterruptionConfig;
  /**
   * If set, set the user state as "away" after this amount of time after user and agent are
   * silent. Set to `undefined` to disable.
   * @defaultValue 15.0
   */
  userAwayTimeout?: number;
  /**
   * Whether to speculatively begin LLM and TTS requests before an end-of-turn is detected.
   * When `true`, the agent sends inference calls as soon as a user transcript is received rather
   * than waiting for a definitive turn boundary. This can reduce response latency by overlapping
   * model inference with user audio, but may incur extra compute if the user interrupts or
   * revises mid-utterance.
   * @defaultValue false
   */
  preemptiveGeneration?: boolean;
}
