// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
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
