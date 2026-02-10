// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
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
  mode: 'adaptive' | 'vad' | false | undefined;
  /**
   * When `true`, buffered audio is dropped while the agent is speaking and cannot be interrupted.
   * @defaultValue true
   */
  discardAudioIfUninterruptible: boolean;
  /**
   * Minimum speech length in milliseconds to register as an interruption.
   * @defaultValue 500
   */
  minDuration: number;
  /**
   * Minimum number of words to consider an interruption, only used if STT is enabled.
   * @defaultValue 0
   */
  minWords: number;
  /**
   * If set, emit an `agentFalseInterruption` event after this amount of time if the user is
   * silent and no user transcript is detected after the interruption. Set to `undefined` to
   * disable. The value is in milliseconds.
   * @defaultValue 2000
   */
  falseInterruptionTimeout: number;
  /**
   * Whether to resume the false interruption after the `falseInterruptionTimeout`.
   * @defaultValue true
   */
  resumeFalseInterruption: boolean;
}

export const defaultInterruptionConfig = {
  mode: undefined,
  discardAudioIfUninterruptible: true,
  minDuration: 500,
  minWords: 0,
  falseInterruptionTimeout: 2000,
  resumeFalseInterruption: true,
} as const satisfies InterruptionConfig;
